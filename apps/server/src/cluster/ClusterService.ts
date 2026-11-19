import {
  AuthSessionId,
  AuthStandardClientScopes,
  type AuthClientMetadata,
  type ClusterAddMemberInput,
  ClusterError,
  type ClusterInvite,
  type ClusterInviteInput,
  type ClusterJoinRequest,
  type ClusterJoinResult,
  type ClusterLeaveResult,
  type ClusterMember,
  ClusterMemberStatus,
  type ClusterRemoveMemberResult,
  type ClusterRenameMemberInput,
  type ClusterStatus,
  ClusterTransport,
  EnvironmentHttpApi,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  formatClusterJoinString,
  formatClusterSshTarget,
  ORCHESTRATION_PROTOCOL_VERSION,
  parseClusterJoinString,
  parseClusterSshTarget,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { CLUSTER_MEMBER_PAIRING_SUBJECT } from "../persistence/AuthPairingLinks.ts";
import type * as ManagedLimits from "../policy/managedLimits.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerTls from "../tls/ServerTls.ts";
import * as ClusterRole from "./ClusterRole.ts";
import * as ClusterUpstream from "./ClusterUpstream.ts";
import * as PinnedTransport from "./pinnedTransport.ts";

const INVITE_TTL = Duration.minutes(10);
const CLUSTER_OFF = "Cluster is off on this machine. Turn it on in Settings → Labs.";

const storageError = (cause: unknown) =>
  new ClusterError({
    reason: "storage",
    message: "The cluster state could not be read or saved here. The server log has details.",
    cause,
  });

const fromPairingError = (
  cause:
    | EnvironmentAuth.ServerAuthInternalError
    | ManagedLimits.ManagedPolicyRefusedError
    | ClusterError,
) =>
  cause._tag === "ClusterError"
    ? cause
    : cause._tag === "ManagedPolicyRefusedError"
      ? new ClusterError({ reason: "disabled", message: cause.message })
      : storageError(cause);

/** Client IPs this machine owns; a session without one was issued here (CLI, desktop). */
const isLoopbackClient = (ipAddress: string | undefined) =>
  ipAddress === undefined || isLocalLoopbackHost(ipAddress.replace(/^::ffff:/, ""));

interface MembershipRow {
  readonly host_environment_id: string;
  readonly host_label: string;
  readonly joined_at: string;
  readonly host_session_id: string;
}

const REQUEST_TIMEOUT = Duration.seconds(10);
const CERTIFICATE_CHANGED =
  "Certificate changed: it presented a certificate other than the pinned one. Invite it again.";

const MemberRow = Schema.Struct({
  environment_id: EnvironmentId,
  label: Schema.String,
  transport: ClusterTransport,
  url: Schema.NullOr(Schema.String),
  ssh_target: Schema.NullOr(Schema.String),
  cert_sha256: Schema.NullOr(Schema.String),
  secret_name: Schema.String,
  status: ClusterMemberStatus,
  joined_at: Schema.DateTimeUtcFromString,
  last_reached_at: Schema.NullOr(Schema.DateTimeUtcFromString),
  last_error: Schema.NullOr(Schema.String),
});
type MemberRow = typeof MemberRow.Type;
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(MemberRow));

const toMember = (row: MemberRow): ClusterMember => ({
  environmentId: row.environment_id,
  label: row.label,
  transport: row.transport,
  address: row.url ?? row.ssh_target ?? "",
  status: row.status,
  joinedAt: row.joined_at,
  lastReachedAt: row.last_reached_at,
  lastError: row.last_error,
});

const MemberApi = HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.cluster)
  .annotateMerge(EnvironmentHttpApi.annotations);

const isCompatible = (descriptor: ExecutionEnvironmentDescriptor) =>
  descriptor.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION &&
  descriptor.capabilities.cluster === true;

const isClusterError = Schema.is(ClusterError);

/** Why `origin` failed a join, keeping the member's own refusal. */
const reachError = (origin: string) => (error: unknown) =>
  isClusterError(error)
    ? error
    : PinnedTransport.isPinMismatch(error)
      ? new ClusterError({
          reason: "certificate_changed",
          message: `${origin}: ${CERTIFICATE_CHANGED}`,
          cause: error,
        })
      : new ClusterError({
          reason: "unreachable",
          message: `${origin} did not answer as a T3 Code environment.`,
          cause: error,
        });

interface MemberConnection {
  readonly upstream: ClusterUpstream.Upstream;
  readonly token: string;
  readonly member: ClusterMember;
}

/** Join, leave, members and refusals for both sides of a cluster. */
export class ClusterService extends Context.Service<
  ClusterService,
  {
    readonly status: Effect.Effect<ClusterStatus, ClusterError>;
    /** Mints a one-time `cluster-member` code; with `url`, the join string a main host adds. */
    readonly invite: (input: ClusterInviteInput) => Effect.Effect<ClusterInvite, ClusterError>;
    /** Member side of a join: spends the invite, records the host, keeps only loopback sessions. */
    readonly acceptJoin: (
      input: ClusterJoinRequest,
      client: AuthClientMetadata,
    ) => Effect.Effect<ClusterJoinResult, ClusterError>;
    /** Member side: ends the membership and revokes the host's session. Needs no network. */
    readonly leave: Effect.Effect<ClusterLeaveResult, ClusterError>;
    readonly members: Stream.Stream<ReadonlyArray<ClusterMember>>;
    readonly addMember: (
      input: ClusterAddMemberInput,
    ) => Effect.Effect<ClusterMember, ClusterError>;
    /** Forgets the member here and asks it to leave; it may be offline. */
    readonly removeMember: (
      memberId: EnvironmentId,
    ) => Effect.Effect<ClusterRemoveMemberResult, ClusterError>;
    readonly renameMember: (
      input: ClusterRenameMemberInput,
    ) => Effect.Effect<ClusterMember, ClusterError>;
    /** Where to reach a member and the `cluster-host` token to send it. */
    readonly connect: (memberId: EnvironmentId) => Effect.Effect<MemberConnection, ClusterError>;
    /** Completes once the member is removed or revoked. */
    readonly awaitGone: (memberId: EnvironmentId) => Effect.Effect<void>;
  }
>()("t3/cluster/ClusterService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const tls = yield* ServerTls.ServerTls;
  const role = yield* ClusterRole.ClusterRole;
  // One join or leave at a time, so two hosts racing for this member cannot both win.
  const memberLock = yield* Semaphore.make(1);
  const upstream = yield* ClusterUpstream.ClusterUpstream;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  // Each join rotates the member's token; racing adds could store one it already revoked.
  const hostLock = yield* Semaphore.make(1);
  // Mirrors cluster_members so proxied requests read no database.
  const rowsRef = yield* SubscriptionRef.make<ReadonlyArray<MemberRow>>([]);
  const tokens = new Map<string, string>();

  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.clusterEnabled),
    Effect.orElseSucceed(() => false),
  );

  const readMembership = sql<MembershipRow>`
    SELECT host_environment_id, host_label, joined_at, host_session_id
    FROM cluster_membership WHERE singleton = 1
  `.pipe(
    Effect.map((rows) => rows[0] ?? null),
    Effect.mapError(storageError),
  );

  const status: ClusterService["Service"]["status"] = Effect.gen(function* () {
    const state = yield* role.current;
    const membership = state.role === "member" ? yield* readMembership : null;
    return {
      enabled: yield* enabled,
      role: state.role,
      fingerprint: tls.fingerprint,
      host:
        membership === null
          ? null
          : {
              environmentId: EnvironmentId.make(membership.host_environment_id),
              label: membership.host_label,
              joinedAt: DateTime.makeUnsafe(membership.joined_at),
            },
    } satisfies ClusterStatus;
  }).pipe(Effect.withSpan("ClusterService.status"));

  const invite: ClusterService["Service"]["invite"] = Effect.fn("ClusterService.invite")(
    function* (input) {
      if ((yield* role.current).role === "main") {
        return yield* new ClusterError({
          reason: "is_main_host",
          message: "This environment is the main host of a cluster, so it cannot join another.",
        });
      }
      const url = input.url === undefined ? undefined : URL.parse(input.url);
      // Plain http only to this machine, as ClusterUpstream allows.
      if (
        url === null ||
        (url !== undefined &&
          url.protocol !== "https:" &&
          !(url.protocol === "http:" && isLocalLoopbackHost(url.hostname)))
      ) {
        return yield* new ClusterError({
          reason: "invalid_target",
          message: `${input.url} is not an https address the main host can reach.`,
        });
      }
      const issued = yield* auth
        .createPairingLink({
          subject: CLUSTER_MEMBER_PAIRING_SUBJECT,
          scopes: AuthStandardClientScopes,
          ttl: INVITE_TTL,
          label: "Cluster invite",
        })
        .pipe(Effect.mapError(fromPairingError));
      const fingerprint = tls.fingerprint;
      return {
        code: issued.credential,
        fingerprint,
        joinString:
          url === undefined
            ? null
            : formatClusterJoinString({ url: url.href, code: issued.credential, fingerprint }),
        expiresAt: issued.expiresAt,
      } satisfies ClusterInvite;
    },
  );

  /**
   * Revokes every session but the host's and this machine's, every unspent code and peer link.
   * Idempotent; runs after the join commits, so revocations publish committed state, and on start.
   */
  const keepOnlyHostAndLoopback = Effect.fn("ClusterService.keepOnlyHostAndLoopback")(
    function* (hostSessionId: AuthSessionId) {
      // Loopback MCP sessions stay; peer-link ones are refused at /mcp once clustered.
      const sessions = yield* auth.listSessions();
      const revoked = sessions.filter(
        (session) =>
          session.sessionId !== hostSessionId &&
          (session.subject === EnvironmentAuth.CLUSTER_HOST_SUBJECT ||
            session.subject === EnvironmentAuth.CLOUD_CONNECT_SUBJECT ||
            !isLoopbackClient(session.client.ipAddress)),
      );
      yield* Effect.forEach(revoked, (session) => auth.revokeSession(session.sessionId), {
        discard: true,
      });
      const links = yield* auth.listPairingLinks({
        excludeSubjects: [],
        includePurposeBound: true,
      });
      yield* Effect.forEach(links, (link) => auth.revokePairingLink(link.id), { discard: true });
      yield* peerLinks.unlinkAll;
    },
    Effect.catch((cause) =>
      Effect.logWarning("Could not revoke clients after joining a cluster.", { cause }),
    ),
  );

  const acceptJoin: ClusterService["Service"]["acceptJoin"] = Effect.fn(
    "ClusterService.acceptJoin",
  )(
    function* (input, client) {
      const self = yield* environment.getDescriptor;
      // One transaction: a refusal or failure rolls back the spent invite and the host session.
      const session = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // The code is checked first, so an unauthenticated caller learns nothing about the role.
            const session = yield* auth
              .consumeClusterInvite(input.code, { hostLabel: input.host.label, client })
              .pipe(
                Effect.mapError((cause) =>
                  EnvironmentAuth.isServerAuthInternalError(cause)
                    ? storageError(cause)
                    : new ClusterError({
                        reason: "pairing_rejected",
                        message:
                          "That cluster invite is unknown, expired, or already used. Create a new one on the member.",
                      }),
                ),
              );
            if (input.host.environmentId === self.environmentId) {
              return yield* new ClusterError({
                reason: "self",
                message: "An environment cannot join its own cluster.",
              });
            }
            const state = yield* role.current;
            if (state.role === "main") {
              return yield* new ClusterError({
                reason: "is_main_host",
                message:
                  "This environment is the main host of a cluster, so it cannot join another.",
              });
            }
            if (state.role === "member" && state.hostEnvironmentId !== input.host.environmentId) {
              return yield* new ClusterError({
                reason: "is_member",
                message: `This environment is already a member of the cluster hosted by ${state.hostLabel}. Leave it there first.`,
              });
            }
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* sql`
            INSERT INTO cluster_membership (singleton, host_environment_id, host_label, joined_at, host_session_id)
            VALUES (1, ${input.host.environmentId}, ${input.host.label}, ${now}, ${session.sessionId})
            ON CONFLICT (singleton) DO UPDATE SET
              host_label = excluded.host_label,
              host_session_id = excluded.host_session_id
          `.pipe(Effect.mapError(storageError));
            return session;
          }),
        )
        .pipe(
          Effect.mapError((cause) => (cause._tag === "ClusterError" ? cause : storageError(cause))),
        );
      yield* keepOnlyHostAndLoopback(session.sessionId);
      return { environmentId: self.environmentId, label: self.label, token: session.token };
    },
    (effect) => memberLock.withPermits(1)(effect),
  );

  const leave: ClusterService["Service"]["leave"] = Effect.gen(function* () {
    const membership = yield* readMembership;
    if (membership === null) return { left: false };
    yield* auth
      .revokeSession(AuthSessionId.make(membership.host_session_id))
      .pipe(Effect.mapError(storageError));
    yield* sql`DELETE FROM cluster_membership WHERE singleton = 1`.pipe(
      Effect.mapError(storageError),
    );
    return { left: true };
  }).pipe(memberLock.withPermits(1), Effect.withSpan("ClusterService.leave"));

  const requireEnabled = enabled.pipe(
    Effect.flatMap((on) =>
      on
        ? Effect.void
        : Effect.fail(new ClusterError({ reason: "disabled", message: CLUSTER_OFF })),
    ),
  );
  // Subscribed before the read, so a toggle in between is not lost.
  const enabledChanges = Stream.unwrap(
    Effect.gen(function* () {
      const changes = yield* serverSettings.subscribeChanges;
      return Stream.concat(
        Stream.fromEffect(enabled),
        changes.pipe(Stream.map((settings) => settings.clusterEnabled)),
      );
    }),
  ).pipe(Stream.changes);

  let lastRows = "";
  // Serialized, so an older read is never published after a newer one.
  const reloadLock = yield* Semaphore.make(1);
  const reload = sql`SELECT * FROM cluster_members ORDER BY label, environment_id`.pipe(
    Effect.flatMap((raw) => {
      const serialized = JSON.stringify(raw);
      // Unchanged rows publish nothing, so `members` sends clients only real changes.
      if (serialized === lastRows) return Effect.void;
      return decodeRows(raw).pipe(
        Effect.flatMap((rows) => SubscriptionRef.set(rowsRef, rows)),
        Effect.andThen(Effect.sync(() => (lastRows = serialized))),
      );
    }),
    Effect.mapError(storageError),
    reloadLock.withPermits(1),
    Effect.withSpan("ClusterService.reload"),
  );
  yield* reload.pipe(
    Effect.catch((cause) => Effect.logWarning("Cluster members could not be read", { cause })),
  );

  const findRow = Effect.fn("ClusterService.findRow")(function* (memberId: EnvironmentId) {
    const row = (yield* SubscriptionRef.get(rowsRef)).find(
      (candidate) => candidate.environment_id === memberId,
    );
    if (row === undefined) {
      return yield* new ClusterError({
        reason: "unknown_member",
        message: `${memberId} is not a member of this cluster.`,
      });
    }
    return row;
  });

  // The row no longer names it, so a failure only leaves an unused secret behind.
  const forgetSecret = (secretName: string) =>
    secrets.remove(secretName).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("A removed cluster member's credential could not be deleted", {
          cause,
        }),
      ),
    );

  const tokenOf = Effect.fn("ClusterService.tokenOf")(function* (secretName: string) {
    const cached = tokens.get(secretName);
    if (cached !== undefined) return cached;
    const stored = yield* secrets.get(secretName).pipe(Effect.mapError(storageError));
    if (Option.isNone(stored)) {
      return yield* new ClusterError({
        reason: "unknown_member",
        message: "This member lost its credential here. Invite it again.",
      });
    }
    const token = new TextDecoder().decode(stored.value);
    tokens.set(secretName, token);
    return token;
  });

  const clientFor = (connection: ClusterUpstream.Upstream) =>
    HttpApiClient.make(MemberApi, { baseUrl: connection.origin }).pipe(
      Effect.provideService(HttpClient.HttpClient, connection.httpClient),
    );

  const connectRow = Effect.fn("ClusterService.connectRow")(function* (row: MemberRow) {
    const token = yield* tokenOf(row.secret_name);
    const connection = yield* upstream.connect(
      row.transport === "https"
        ? { transport: "https", url: row.url ?? "", certSha256: row.cert_sha256 }
        : { transport: "ssh", sshTarget: row.ssh_target ?? "" },
    );
    return { upstream: connection, token, member: toMember(row) };
  });

  const connect: ClusterService["Service"]["connect"] = Effect.fn("ClusterService.connect")(
    function* (memberId) {
      yield* requireEnabled;
      return yield* connectRow(yield* findRow(memberId));
    },
  );

  const addMember: ClusterService["Service"]["addMember"] = Effect.fn("ClusterService.addMember")(
    function* (input) {
      yield* requireEnabled;
      yield* role.refuseIfMember("Adding a cluster member");
      const self = yield* environment.getDescriptor;
      const join = parseClusterJoinString(input.target);
      const sshTarget = join === undefined ? parseClusterSshTarget(input.target) : undefined;
      const resolved =
        join !== undefined
          ? {
              target: { transport: "https", url: join.url, certSha256: join.fingerprint } as const,
              code: Effect.succeed(join.code),
            }
          : sshTarget !== undefined
            ? {
                target: { transport: "ssh", sshTarget: formatClusterSshTarget(sshTarget) } as const,
                code: upstream
                  .inviteOverSsh(formatClusterSshTarget(sshTarget))
                  .pipe(Effect.map((invited) => invited.code)),
              }
            : undefined;
      if (resolved === undefined) {
        return yield* new ClusterError({
          reason: "invalid_target",
          message:
            "Paste the join string from the member's Settings → Cluster or `t3 cluster invite`, or an ssh target such as me@box.",
        });
      }
      const code = yield* resolved.code;
      const connection = yield* upstream.connect(resolved.target);
      const client = yield* clientFor(connection);
      const descriptor = yield* client.metadata
        .descriptor()
        .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(reachError(connection.origin)));
      if (descriptor.environmentId === self.environmentId) {
        return yield* new ClusterError({
          reason: "self",
          message: "That address is this environment.",
        });
      }
      if (!isCompatible(descriptor)) {
        return yield* new ClusterError({
          reason: "incompatible",
          message: `${descriptor.label} runs a T3 Code version without clusters or speaks another protocol. Update both environments.`,
        });
      }
      const joined = yield* client.cluster
        .join({ payload: { code, host: { environmentId: self.environmentId, label: self.label } } })
        .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(reachError(connection.origin)));
      if (joined.environmentId !== descriptor.environmentId) {
        return yield* new ClusterError({
          reason: "unreachable",
          message: `${connection.origin} answered as another environment while joining.`,
        });
      }
      const wasStandalone = (yield* role.current).role === "standalone";
      const previous = (yield* SubscriptionRef.get(rowsRef)).find(
        (row) => row.environment_id === joined.environmentId,
      );
      const secretName = `cluster-member-${Hex.encode(yield* random.randomBytes(16))}`;
      const target = resolved.target;
      yield* Effect.gen(function* () {
        yield* secrets.set(secretName, new TextEncoder().encode(joined.token));
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO cluster_members (environment_id, label, transport, url, ssh_target, cert_sha256, secret_name, status, joined_at, last_reached_at, last_error)
          VALUES (
            ${joined.environmentId}, ${input.label ?? joined.label}, ${target.transport},
            ${target.transport === "https" ? target.url : null},
            ${target.transport === "ssh" ? target.sshTarget : null},
            ${target.transport === "https" && target.url.startsWith("https:") ? target.certSha256 : null},
            ${secretName}, 'offline', ${now}, ${now}, NULL
          )
          ON CONFLICT (environment_id) DO UPDATE SET
            transport = excluded.transport, url = excluded.url, ssh_target = excluded.ssh_target,
            cert_sha256 = excluded.cert_sha256, secret_name = excluded.secret_name,
            status = 'offline', last_reached_at = excluded.last_reached_at, last_error = NULL
        `;
      }).pipe(
        Effect.mapError(storageError),
        Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)),
      );
      if (previous !== undefined) {
        tokens.delete(previous.secret_name);
        yield* forgetSecret(previous.secret_name);
      }
      // A main host reaches other environments through its members, not its own peer links.
      if (wasStandalone) yield* peerLinks.unlinkAll.pipe(Effect.mapError(storageError));
      yield* reload;
      return toMember(yield* findRow(joined.environmentId));
    },
    (effect) => hostLock.withPermits(1)(effect),
  );

  const removeMember: ClusterService["Service"]["removeMember"] = Effect.fn(
    "ClusterService.removeMember",
  )(
    function* (memberId) {
      const row = (yield* SubscriptionRef.get(rowsRef)).find(
        (candidate) => candidate.environment_id === memberId,
      );
      if (row === undefined) return { removed: false, memberNotified: false };
      const memberNotified = yield* connectRow(row).pipe(
        Effect.flatMap(({ upstream: connection, token }) =>
          clientFor(connection).pipe(
            Effect.flatMap((client) =>
              client.cluster.leave({ headers: { authorization: `Bearer ${token}` } }),
            ),
          ),
        ),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      yield* Effect.gen(function* () {
        yield* sql`DELETE FROM cluster_members WHERE environment_id = ${memberId}`.pipe(
          Effect.mapError(storageError),
        );
        tokens.delete(row.secret_name);
        yield* forgetSecret(row.secret_name);
        if (row.ssh_target !== null) yield* upstream.closeSsh(row.ssh_target);
      }).pipe(Effect.ensuring(reload.pipe(Effect.ignore)));
      return { removed: true, memberNotified };
    },
    (effect) => hostLock.withPermits(1)(effect),
  );

  const renameMember: ClusterService["Service"]["renameMember"] = Effect.fn(
    "ClusterService.renameMember",
  )(function* (input) {
    yield* findRow(input.memberId);
    yield* sql`UPDATE cluster_members SET label = ${input.label} WHERE environment_id = ${input.memberId}`.pipe(
      Effect.mapError(storageError),
    );
    yield* reload;
    return toMember(yield* findRow(input.memberId));
  });

  // Clients would otherwise list members the proxy answers 403 for.
  const members = Stream.zipLatestWith(
    SubscriptionRef.changes(rowsRef),
    enabledChanges,
    (rows, on) => (on ? rows.map(toMember) : []),
  );

  const awaitGone: ClusterService["Service"]["awaitGone"] = (memberId) =>
    SubscriptionRef.changes(rowsRef).pipe(
      Stream.filter(
        (rows) => !rows.some((row) => row.environment_id === memberId && row.status !== "revoked"),
      ),
      Stream.take(1),
      Stream.runDrain,
    );

  // A member that stopped between a join's commit and its revocations finishes them here.
  const membership = yield* readMembership.pipe(Effect.orElseSucceed(() => null));
  if (membership !== null) {
    yield* keepOnlyHostAndLoopback(AuthSessionId.make(membership.host_session_id));
  }

  return ClusterService.of({
    status,
    invite,
    acceptJoin,
    leave,
    members,
    addMember,
    removeMember,
    renameMember,
    connect,
    awaitGone,
  });
});

export const layer = Layer.effect(ClusterService, make);
