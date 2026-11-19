import {
  AuthSessionId,
  AuthStandardClientScopes,
  type AuthClientMetadata,
  ClusterError,
  type ClusterInvite,
  type ClusterInviteInput,
  type ClusterJoinRequest,
  type ClusterJoinResult,
  type ClusterLeaveResult,
  type ClusterStatus,
  EnvironmentId,
  formatClusterJoinString,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { CLUSTER_MEMBER_PAIRING_SUBJECT } from "../persistence/AuthPairingLinks.ts";
import type * as ManagedLimits from "../policy/managedLimits.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerTls from "../tls/ServerTls.ts";
import * as ClusterRole from "./ClusterRole.ts";

const INVITE_TTL = Duration.minutes(10);

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
      if (url === null || (url !== undefined && url.protocol !== "https:")) {
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

  // A member that stopped between a join's commit and its revocations finishes them here.
  const membership = yield* readMembership.pipe(Effect.orElseSucceed(() => null));
  if (membership !== null) {
    yield* keepOnlyHostAndLoopback(AuthSessionId.make(membership.host_session_id));
  }

  return ClusterService.of({ status, invite, acceptJoin, leave });
});

export const layer = Layer.effect(ClusterService, make);
