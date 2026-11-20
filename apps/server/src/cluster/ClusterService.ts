import {
  AuthSessionId,
  AuthStandardClientScopes,
  type AuthClientMetadata,
  type ClusterAddMemberInput,
  ClusterError,
  type ClusterHostReplyInput,
  type ClusterHostRequest,
  type ClusterHostResult,
  type ClusterInvite,
  type ClusterInviteInput,
  type ClusterJoinRequest,
  type ClusterJoinResult,
  type ClusterLeaveResult,
  ClusterLinkEvent,
  type ClusterMember,
  ClusterMemberStatus,
  type ClusterRemoveMemberResult,
  type ClusterRenameMemberInput,
  type ClusterSshKeyFile,
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
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Sse from "effect/encoding/Sse";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
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
import * as ClusterSshKey from "./ClusterSshKey.ts";
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

const isMainHost = () =>
  new ClusterError({
    reason: "is_main_host",
    message: "This environment is the main host of a cluster, so it cannot join another.",
  });

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
export const CERTIFICATE_CHANGED =
  "Certificate changed: it presented a certificate other than the pinned one. Add it again with a new join code.";

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

export interface MemberConnection {
  readonly upstream: ClusterUpstream.Upstream;
  readonly token: string;
  readonly member: ClusterMember;
}

const REVOKED = "It no longer accepts this host. Add it again with a new join code.";
const INCOMPATIBLE = "It speaks another T3 Code protocol. Update both environments.";
const NOT_ANSWERING = "It did not answer.";
const LINK_DROPPED = "Its control link dropped. Reconnecting.";
// Quick after a blip; a member that stays away is tried every 30 s at most.
const LINK_BACKOFF = Schedule.min([
  Schedule.exponential("1 second", 2),
  Schedule.spaced("30 seconds"),
]);
// Two missed 15 s heartbeats, with slack for a slow edge.
const LINK_SILENCE = Duration.seconds(40);
const ROWS_RELOAD_INTERVAL = Duration.seconds(30);
// A link that drops sooner than this after `ready` is flapping, so it reconnects with backoff.
const LINK_MIN_LIFE = Duration.seconds(5);
// Forwarded waits run at most 50 s; a call unanswered this long lost its answer.
export const HOST_CALL_TIMEOUT = Duration.minutes(5);
// Answers are idempotent (a repeat finds nothing and gets 404), so a lost POST is retried.
const REPLY_RETRY = { times: 3, schedule: Schedule.exponential("250 millis") };

/** Why a member's control link is not up. */
interface LinkDown {
  readonly status: Exclude<ClusterMemberStatus, "online">;
  readonly message: string;
}

/** A member agent's call before the member numbers it. */
export type ClusterHostCall = Omit<ClusterHostRequest, "requestId">;

/** Runs one member agent's call on the main host. */
export type ClusterHostServe = (
  member: ClusterMember,
  request: ClusterHostRequest,
) => Effect.Effect<ClusterHostResult>;

/** What a member's agents hear while its control link is down. */
export const clusterHostUnreachable = (hostLabel: string) =>
  new ClusterError({
    reason: "unreachable",
    message: `Cluster host unreachable: "${hostLabel}" is not connected, so other environments in the cluster cannot be reached. Work here continues.`,
  });

const CLUSTER_HOST_MAX_IN_FLIGHT = 32;

/** Not final: the member's agent tries again once one of its calls finishes. */
const hostBusy: ClusterHostResult = {
  isError: true,
  text: JSON.stringify({
    code: "orchestration_error",
    message: `Cluster host busy: it is already running ${CLUSTER_HOST_MAX_IN_FLIGHT} calls from this environment. Try again when one finishes.`,
  }),
};

/** What a member's agent hears when the main host failed to take or run its call. */
const hostFailed: ClusterHostResult = {
  isError: true,
  text: JSON.stringify({
    code: "orchestration_error",
    message: "Cluster host could not run this call. Try again.",
  }),
};

/** `serve` for a main host that runs no member agent calls. */
export const refuseHostRequests: ClusterHostServe = () =>
  Effect.succeed({
    isError: true,
    text: JSON.stringify({
      code: "capability_denied",
      message: "This main host does not run its members' agent calls.",
    }),
  });

const unknownRequest = () =>
  new ClusterError({ reason: "unknown_request", message: "No call here is waiting with that id." });

/** Main side: a member's event stream as events; ends when it drops or is silent for 40 s. */
export const readLinkEvents = <E>(bytes: Stream.Stream<Uint8Array, E>) =>
  bytes.pipe(
    // Per read and before decoding, so heartbeat comments count as life.
    Stream.timeout(LINK_SILENCE),
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(ClusterLinkEvent)),
    Stream.map((event) => event.data),
  );

/** A call its link announced: its body until the main host fetches it, and its answer. */
interface PendingCall {
  request: ClusterHostRequest | undefined;
  readonly reply: Deferred.Deferred<ClusterHostResult, ClusterError>;
}

/** The main host's event stream on a member, and the calls announced on it. */
interface HostLink {
  readonly sessionId: string;
  readonly events: Queue.Queue<ClusterLinkEvent, Cause.Done>;
  readonly pending: Map<string, PendingCall>;
}

/** Join, leave, members and refusals for both sides of a cluster. */
export class ClusterService extends Context.Service<
  ClusterService,
  {
    readonly status: Effect.Effect<ClusterStatus, ClusterError>;
    /** Mints a one-time `cluster-member` code; with `url`, the join code a main host adds. */
    readonly invite: (input: ClusterInviteInput) => Effect.Effect<ClusterInvite, ClusterError>;
    /** Member side of a join: spends the invite, records the host, keeps only loopback sessions. */
    readonly acceptJoin: (
      input: ClusterJoinRequest,
      client: AuthClientMetadata,
    ) => Effect.Effect<ClusterJoinResult, ClusterError>;
    /** Member side: ends the membership and revokes the host's session. Needs no network. */
    readonly leave: Effect.Effect<ClusterLeaveResult, ClusterError>;
    readonly members: Stream.Stream<ReadonlyArray<ClusterMember>>;
    /** Every member stored here, even while the cluster is off, so the CLI can remove them. */
    readonly storedMembers: Effect.Effect<ReadonlyArray<ClusterMember>>;
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
    /** Private key files in this machine's `~/.ssh`, for a one-time ssh login. */
    readonly sshKeys: Effect.Effect<ReadonlyArray<ClusterSshKeyFile>>;
    /** Where to reach a member and the `cluster-host` token to send it. */
    readonly connect: (memberId: EnvironmentId) => Effect.Effect<MemberConnection, ClusterError>;
    /** Completes once the member is removed or revoked. */
    readonly awaitGone: (memberId: EnvironmentId) => Effect.Effect<void>;
    /** Main side: one control link per member while the scope lasts; `serve` runs their agents' calls. */
    readonly start: (serve: ClusterHostServe) => Effect.Effect<void, never, Scope.Scope>;
    /** Member side: the main host's event stream, `ready` then a doorbell per call; others are refused. */
    readonly hostEvents: (session: {
      readonly sessionId: string;
    }) => Effect.Effect<Stream.Stream<ClusterLinkEvent>, ClusterError>;
    /**
     * Member side: one announced call, from `GET /api/cluster/host-request/:requestId`; taken on
     * the first fetch. `forbidden` for any session but the host's; `unknown_request` otherwise.
     */
    readonly hostRequest: (
      session: { readonly sessionId: string },
      requestId: string,
    ) => Effect.Effect<ClusterHostRequest, ClusterError>;
    /** Member side: the main host's answer to one call, from `POST /api/cluster/host-reply`. */
    readonly hostReply: (
      session: { readonly sessionId: string },
      input: ClusterHostReplyInput,
    ) => Effect.Effect<void, ClusterError>;
    /** Member side: runs a call on the main host over the link; fails at once while it is down. */
    readonly hostCall: (call: ClusterHostCall) => Effect.Effect<ClusterHostResult, ClusterError>;
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
  const sshKey = yield* ClusterSshKey.ClusterSshKey;
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
        return yield* isMainHost();
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
          label: "Cluster join code",
        })
        .pipe(Effect.mapError(fromPairingError));
      const fingerprint = tls.fingerprint;
      return {
        code: issued.credential,
        fingerprint,
        joinString:
          url === undefined
            ? null
            : formatClusterJoinString({
                url: url.href,
                code: issued.credential,
                fingerprint,
              }),
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
                          "That cluster join code is unknown, expired, or already used. Create a new one on the member.",
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
              return yield* isMainHost();
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

  const dropRow = Effect.fn("ClusterService.dropRow")(
    function* (row: MemberRow) {
      yield* sql`DELETE FROM cluster_members WHERE environment_id = ${row.environment_id}`.pipe(
        Effect.mapError(storageError),
      );
      tokens.delete(row.secret_name);
      yield* forgetSecret(row.secret_name);
      if (row.ssh_target !== null) yield* upstream.closeSsh(row.ssh_target);
    },
    Effect.ensuring(reload.pipe(Effect.ignore)),
  );

  const tokenOf = Effect.fn("ClusterService.tokenOf")(function* (secretName: string) {
    const cached = tokens.get(secretName);
    if (cached !== undefined) return cached;
    const stored = yield* secrets.get(secretName).pipe(Effect.mapError(storageError));
    if (Option.isNone(stored)) {
      return yield* new ClusterError({
        reason: "unknown_member",
        message: "This member lost its credential here. Add it again with a new join code.",
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

  const connectRow = Effect.fn("ClusterService.connectRow")(function* (
    row: MemberRow,
    options?: { readonly refresh?: boolean },
  ) {
    const token = yield* tokenOf(row.secret_name);
    const connection = yield* upstream.connect(
      row.transport === "https"
        ? { transport: "https", url: row.url ?? "", certSha256: row.cert_sha256 }
        : { transport: "ssh", sshTarget: row.ssh_target ?? "" },
      options,
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
      let keyInstalled = false;
      let rowWritten = false;
      // Set once the member's join answer arrives; a lost answer leaves no token to undo it with.
      let undoJoin: Effect.Effect<void> = Effect.void;
      let previous: MemberRow | undefined;
      const resolved =
        join !== undefined
          ? {
              target: { transport: "https", url: join.url, certSha256: join.fingerprint } as const,
              code: Effect.succeed(join.code),
            }
          : sshTarget !== undefined
            ? {
                target: { transport: "ssh", sshTarget: formatClusterSshTarget(sshTarget) } as const,
                // Even with the user's own ssh setup, so reconnects never depend on their agent.
                code: sshKey
                  .authorize(
                    formatClusterSshTarget(sshTarget),
                    input.login ?? { _tag: "config" },
                    input.trustHostKey,
                  )
                  .pipe(
                    Effect.tap(() => Effect.sync(() => (keyInstalled = true))),
                    Effect.andThen(upstream.inviteOverSsh(formatClusterSshTarget(sshTarget))),
                    Effect.map((invited) => invited.code),
                  ),
              }
            : undefined;
      if (resolved === undefined) {
        return yield* new ClusterError({
          reason: "invalid_target",
          message:
            "Paste the join code from the member's Settings → Cluster or `t3 cluster join`, or an ssh target such as me@box.",
        });
      }
      const newSshTarget = resolved.target.transport === "ssh" ? resolved.target.sshTarget : null;
      return yield* Effect.gen(function* () {
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
          .join({
            payload: { code, host: { environmentId: self.environmentId, label: self.label } },
          })
          .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(reachError(connection.origin)));
        undoJoin = client.cluster
          .leave({ headers: { authorization: `Bearer ${joined.token}` } })
          .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.ignore);
        previous = (yield* SubscriptionRef.get(rowsRef)).find(
          (row) => row.environment_id === joined.environmentId,
        );
        if (joined.environmentId !== descriptor.environmentId) {
          return yield* new ClusterError({
            reason: "unreachable",
            message: `${connection.origin} answered as another environment while joining.`,
          });
        }
        const wasStandalone = (yield* role.current).role === "standalone";
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
              label = COALESCE(${input.label ?? null}, cluster_members.label),
              transport = excluded.transport, url = excluded.url, ssh_target = excluded.ssh_target,
              cert_sha256 = excluded.cert_sha256, secret_name = excluded.secret_name,
              status = 'offline', last_reached_at = excluded.last_reached_at, last_error = NULL
          `;
        }).pipe(
          Effect.mapError(storageError),
          Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)),
        );
        rowWritten = true;
        if (previous !== undefined) {
          tokens.delete(previous.secret_name);
          yield* forgetSecret(previous.secret_name);
        }
        // The member moved, so its old address no longer needs to accept this host.
        if (previous?.ssh_target != null && previous.ssh_target !== newSshTarget) {
          yield* sshKey.revoke(previous.ssh_target);
          yield* upstream.closeSsh(previous.ssh_target);
        }
        // A main host reaches other environments through its members, not its own peer links.
        if (wasStandalone) yield* peerLinks.unlinkAll.pipe(Effect.mapError(storageError));
        yield* reload;
        return toMember(yield* findRow(joined.environmentId));
      }).pipe(
        // A failed add leaves no row to remove its key by, unless a member's row uses it.
        Effect.onError(() =>
          Effect.gen(function* () {
            if (rowWritten) return yield* reload.pipe(Effect.ignore);
            yield* undoJoin;
            // Joining again revoked the stored token, so the stored member is gone either way.
            const stale = previous;
            if (stale !== undefined) {
              // A row that survives still names its key, so the key stays with it.
              yield* dropRow(stale).pipe(
                Effect.andThen(
                  stale.ssh_target !== null && stale.ssh_target !== newSshTarget
                    ? sshKey.revoke(stale.ssh_target)
                    : Effect.void,
                ),
                Effect.ignore,
              );
            }
            if (!keyInstalled || newSshTarget === null) return;
            const rows = yield* SubscriptionRef.get(rowsRef);
            if (rows.some((row) => row.ssh_target === newSshTarget)) return;
            yield* sshKey.revoke(newSshTarget);
          }),
        ),
      );
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
      if (row === undefined) return { removed: false, memberNotified: false, keyRevoked: null };
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
      const keyRevoked = row.ssh_target === null ? null : yield* sshKey.revoke(row.ssh_target);
      yield* dropRow(row);
      return { removed: true, memberNotified, keyRevoked };
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

  const storedMembers = Effect.map(SubscriptionRef.get(rowsRef), (rows) => rows.map(toMember));

  const awaitGone: ClusterService["Service"]["awaitGone"] = (memberId) =>
    SubscriptionRef.changes(rowsRef).pipe(
      Stream.filter(
        (rows) => !rows.some((row) => row.environment_id === memberId && row.status !== "revoked"),
      ),
      Stream.take(1),
      Stream.runDrain,
    );

  const recordStatus = Effect.fn("ClusterService.recordStatus")(
    function* (memberId: EnvironmentId, status: ClusterMemberStatus, error: string | null) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE cluster_members
        SET status = ${status},
            last_error = ${error},
            last_reached_at = CASE WHEN ${status} = 'online' THEN ${now} ELSE last_reached_at END
        WHERE environment_id = ${memberId}
      `.pipe(Effect.mapError(storageError));
      yield* reload;
    },
    Effect.catch((cause) =>
      Effect.logWarning("A cluster member's status could not be saved", { cause }),
    ),
  );

  const unreachableBy = (cause: unknown): LinkDown => ({
    status: "offline",
    message: PinnedTransport.isPinMismatch(cause) ? CERTIFICATE_CHANGED : NOT_ANSWERING,
  });

  /** The link's connect check: it answers as this member and speaks this protocol. */
  const preflight = Effect.fn("ClusterService.preflight")(function* (
    memberId: EnvironmentId,
    connection: ClusterUpstream.Upstream,
  ) {
    const client = yield* clientFor(connection);
    const descriptor = yield* client.metadata
      .descriptor()
      .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(unreachableBy));
    if (descriptor.environmentId !== memberId) {
      return yield* Effect.fail<LinkDown>({
        status: "offline",
        message: `Its address now answers as ${descriptor.label}. Add it again with a new join code.`,
      });
    }
    if (!isCompatible(descriptor)) {
      return yield* Effect.fail<LinkDown>({ status: "incompatible", message: INCOMPATIBLE });
    }
    return client;
  });

  /** One link: succeeds when a link that came up drops, fails when it never came up. */
  const linkOnce = Effect.fn("ClusterService.linkOnce")(function* (
    memberId: EnvironmentId,
    serve: ClusterHostServe,
  ) {
    const {
      upstream: connection,
      token,
      member,
    } = yield* requireEnabled.pipe(
      Effect.andThen(findRow(memberId)),
      // Each link attempt re-checks an ssh member's server; proxied requests reuse its address.
      Effect.flatMap((row) => connectRow(row, { refresh: true })),
      Effect.mapError((error): LinkDown => ({ status: "offline", message: error.message })),
    );
    const api = yield* preflight(memberId, connection);
    const headers = { authorization: `Bearer ${token}` };
    const response = yield* connection.httpClient
      .execute(
        HttpClientRequest.get(`${connection.origin}/api/cluster/events`).pipe(
          HttpClientRequest.setHeaders({ ...headers, accept: "text/event-stream" }),
        ),
      )
      .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(unreachableBy));
    if (response.status === 401) {
      return yield* Effect.fail<LinkDown>({ status: "revoked", message: REVOKED });
    }
    if (response.status !== 200) {
      return yield* Effect.fail<LinkDown>({ status: "offline", message: NOT_ANSWERING });
    }
    // Each body is its own request, so no call's size holds up another or the heartbeats.
    const answer = (requestId: string, result: ClusterHostResult) =>
      api.cluster
        .hostReply({ headers, payload: { requestId, result } })
        .pipe(Effect.retry({ ...REPLY_RETRY, while: HttpClientError.isHttpClientError }));
    const run = (requestId: string) =>
      api.cluster.hostRequest({ headers, params: { requestId } }).pipe(
        Effect.flatMap((request) => serve(member, request)),
        // The member's agent waits on this call, so a failure here is still answered.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("A cluster member's call could not be run", { cause }).pipe(
              Effect.as(hostFailed),
            ),
        ),
        Effect.flatMap((result) => answer(requestId, result)),
      );
    const inFlight = yield* Semaphore.make(CLUSTER_HOST_MAX_IN_FLIGHT);
    let upAt: number | undefined;
    yield* readLinkEvents(response.stream).pipe(
      Stream.runForEach((event) =>
        event._tag === "ready"
          ? Clock.currentTimeMillis.pipe(
              Effect.tap((now) => Effect.sync(() => (upAt = now))),
              Effect.andThen(recordStatus(memberId, "online", null)),
            )
          : run(event.requestId).pipe(
              inFlight.withPermitsIfAvailable(1),
              Effect.flatMap(
                Option.match({
                  onNone: () => answer(event.requestId, hostBusy),
                  onSome: () => Effect.void,
                }),
              ),
              Effect.ignoreCause({ log: true }),
              // Ends with the link: the member already told that call's agent it failed.
              Effect.forkScoped,
            ),
      ),
      Effect.ignore,
    );
    if (upAt === undefined) {
      return yield* Effect.fail<LinkDown>({ status: "offline", message: NOT_ANSWERING });
    }
    if ((yield* Clock.currentTimeMillis) - upAt < Duration.toMillis(LINK_MIN_LIFE)) {
      return yield* Effect.fail<LinkDown>({ status: "offline", message: LINK_DROPPED });
    }
  }, Effect.scoped);

  const runLink = (memberId: EnvironmentId, serve: ClusterHostServe) =>
    linkOnce(memberId, serve).pipe(
      Effect.tapError((down) => recordStatus(memberId, down.status, down.message)),
      Effect.retry(LINK_BACKOFF),
      Effect.andThen(recordStatus(memberId, "offline", LINK_DROPPED)),
      Effect.forever,
      // Stopped with the server or the cluster turned off: no link, so not online.
      Effect.onInterrupt(() => recordStatus(memberId, "offline", null)),
    );

  const start: ClusterService["Service"]["start"] = Effect.fn("ClusterService.start")(
    function* (serve) {
      // A member that stopped between a join's commit and its revocations finishes them here.
      // Not when the layer is built: `t3 cluster` commands build it, and would revoke fresh invites.
      const membership = yield* readMembership.pipe(Effect.orElseSucceed(() => null));
      if (membership !== null) {
        yield* keepOnlyHostAndLoopback(AuthSessionId.make(membership.host_session_id));
      }
      // A status from before this start is stale: only a live link says online.
      yield* sql`UPDATE cluster_members SET status = 'offline' WHERE status = 'online'`.pipe(
        Effect.mapError(storageError),
        Effect.andThen(reload),
        Effect.catch((cause) => Effect.logWarning("Cluster members could not be read", { cause })),
      );
      const links = yield* FiberMap.make<EnvironmentId>();
      // A member's link restarts only when its token, address or pin changes.
      const running = new Map<EnvironmentId, string>();
      // Untraced: it runs on every status change.
      const reconcile = Effect.fnUntraced(function* (rows: ReadonlyArray<MemberRow>, on: boolean) {
        const wanted = new Map(
          (on ? rows : []).map(
            (row) =>
              [
                row.environment_id,
                `${row.secret_name} ${row.url ?? row.ssh_target} ${row.cert_sha256}`,
              ] as const,
          ),
        );
        for (const memberId of running.keys()) {
          if (wanted.has(memberId)) continue;
          running.delete(memberId);
          yield* FiberMap.remove(links, memberId);
        }
        for (const [memberId, key] of wanted) {
          if (running.get(memberId) === key) continue;
          running.set(memberId, key);
          yield* FiberMap.run(links, memberId, runLink(memberId, serve));
        }
      });
      yield* Stream.zipLatestWith(
        SubscriptionRef.changes(rowsRef),
        enabledChanges,
        (rows, on) => [rows, on] as const,
      ).pipe(
        Stream.runForEach(([rows, on]) => reconcile(rows, on)),
        Effect.forkScoped,
      );
      // `t3 cluster add` beside a running server writes rows only this rereads; only while on.
      // A member refuses adds, so it never has rows to reread.
      const rereadRows = role.current.pipe(
        Effect.flatMap((state) => (state.role === "member" ? Effect.void : reload)),
        Effect.ignore,
      );
      yield* enabledChanges.pipe(
        Stream.switchMap((on) =>
          on
            ? Stream.fromEffect(rereadRows.pipe(Effect.delay(ROWS_RELOAD_INTERVAL), Effect.forever))
            : Stream.empty,
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
    },
  );

  // Member side: the main host's event stream while it is open.
  let hostLink: HostLink | undefined;

  const hostUnreachableHere = readMembership.pipe(
    Effect.map((membership) => clusterHostUnreachable(membership?.host_label ?? "The main host")),
    Effect.orElseSucceed(() => clusterHostUnreachable("The main host")),
  );

  /** Fails every call still pending on `closing`; none is fetched or announced again. */
  const closeHostLink = Effect.fn("ClusterService.closeHostLink")(function* (closing: HostLink) {
    if (hostLink === closing) hostLink = undefined;
    // Ended first, so no call is announced on it while the pending ones fail.
    yield* Queue.end(closing.events);
    const unreachable = yield* hostUnreachableHere;
    for (const call of closing.pending.values()) yield* Deferred.fail(call.reply, unreachable);
    closing.pending.clear();
  });

  /** Only the session recorded at join may hold the link or take and answer its calls. */
  const requireHostSession = (session: { readonly sessionId: string }, message: string) =>
    readMembership.pipe(
      Effect.flatMap((membership) =>
        membership?.host_session_id === session.sessionId
          ? Effect.void
          : Effect.fail(new ClusterError({ reason: "forbidden", message })),
      ),
    );

  const hostEvents: ClusterService["Service"]["hostEvents"] = Effect.fn(
    "ClusterService.hostEvents",
  )(function* (session) {
    yield* requireHostSession(
      session,
      "Only this environment's cluster host can open its control link.",
    );
    return Stream.unwrap(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const link: HostLink = {
            sessionId: session.sessionId,
            events: yield* Queue.unbounded<ClusterLinkEvent, Cause.Done>(),
            pending: new Map(),
          };
          const replaced = hostLink;
          hostLink = link;
          if (replaced !== undefined) yield* closeHostLink(replaced);
          return link;
        }),
        closeHostLink,
      ).pipe(
        Effect.map((link) =>
          Stream.concat(Stream.make({ _tag: "ready" } as const), Stream.fromQueue(link.events)),
        ),
      ),
    );
  });

  /** The pending call `requestId` names on the open link, for the host's session only. */
  // Untraced: only hostRequest and hostReply call it, and their spans already cover it.
  const pendingCall = Effect.fnUntraced(function* (
    session: { readonly sessionId: string },
    requestId: string,
  ) {
    yield* requireHostSession(
      session,
      "Only this environment's cluster host can take or answer its calls.",
    );
    const link = hostLink;
    const call = link?.sessionId === session.sessionId ? link.pending.get(requestId) : undefined;
    if (link === undefined || call === undefined) return yield* unknownRequest();
    return { link, call };
  });

  const hostRequest: ClusterService["Service"]["hostRequest"] = Effect.fn(
    "ClusterService.hostRequest",
  )(function* (session, requestId) {
    const { call } = yield* pendingCall(session, requestId);
    const request = call.request;
    // Taken on the first fetch, so a retried GET never runs a call twice.
    if (request === undefined) return yield* unknownRequest();
    call.request = undefined;
    return request;
  });

  const hostReply: ClusterService["Service"]["hostReply"] = Effect.fn("ClusterService.hostReply")(
    function* (session, input) {
      const { link, call } = yield* pendingCall(session, input.requestId);
      // Taken out before it is answered, so a repeated POST finds nothing and lands nowhere.
      link.pending.delete(input.requestId);
      yield* Deferred.succeed(call.reply, input.result);
    },
  );

  const hostCall: ClusterService["Service"]["hostCall"] = Effect.fn("ClusterService.hostCall")(
    function* (call) {
      const link = hostLink;
      if (link === undefined) return yield* yield* hostUnreachableHere;
      const requestId = Hex.encode(yield* random.randomBytes(16));
      const reply = yield* Deferred.make<ClusterHostResult, ClusterError>();
      link.pending.set(requestId, { request: { requestId, ...call }, reply });
      // False once that link has dropped: a call is never announced on a later one.
      const announced = yield* Queue.offer(link.events, { _tag: "request", requestId });
      if (!announced) {
        link.pending.delete(requestId);
        return yield* yield* hostUnreachableHere;
      }
      return yield* Deferred.await(reply).pipe(
        Effect.timeoutOrElse({
          duration: HOST_CALL_TIMEOUT,
          orElse: () => Effect.flatMap(hostUnreachableHere, Effect.fail),
        }),
        Effect.ensuring(Effect.sync(() => link.pending.delete(requestId))),
      );
    },
  );

  return ClusterService.of({
    status,
    invite,
    acceptJoin,
    leave,
    members,
    storedMembers,
    addMember,
    removeMember,
    renameMember,
    sshKeys: sshKey.list,
    connect,
    awaitGone,
    start,
    hostEvents,
    hostRequest,
    hostReply,
    hostCall,
  });
});

export const layer = Layer.effect(ClusterService, make);
