import { ClusterError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

export type ClusterRoleState =
  | { readonly role: "standalone" }
  | { readonly role: "main" }
  | { readonly role: "member"; readonly hostEnvironmentId: string; readonly hostLabel: string };

/** Which side of a cluster this environment is on, for the services that refuse by it. */
export class ClusterRole extends Context.Service<
  ClusterRole,
  {
    readonly current: Effect.Effect<ClusterRoleState, ClusterError>;
    readonly refuseIfMember: (action: string) => Effect.Effect<void, ClusterError>;
    readonly refuseIfClustered: (action: string) => Effect.Effect<void, ClusterError>;
  }
>()("t3/cluster/ClusterRole") {}

const refusal = (state: Exclude<ClusterRoleState, { role: "standalone" }>, action: string) =>
  state.role === "member"
    ? new ClusterError({
        reason: "is_member",
        message: `${action} is not available here: this environment is a member of the cluster hosted by ${state.hostLabel}.`,
      })
    : new ClusterError({
        reason: "is_main_host",
        message: `${action} is not available here: this environment is the main host of a cluster.`,
      });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const current = Effect.gen(function* () {
    const [membership] = yield* sql<{ host_environment_id: string; host_label: string }>`
      SELECT host_environment_id, host_label FROM cluster_membership WHERE singleton = 1
    `;
    if (membership !== undefined) {
      return {
        role: "member",
        hostEnvironmentId: membership.host_environment_id,
        hostLabel: membership.host_label,
      } as const;
    }
    const [member] = yield* sql<{ found: number }>`SELECT 1 AS found FROM cluster_members LIMIT 1`;
    return member === undefined ? ({ role: "standalone" } as const) : ({ role: "main" } as const);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ClusterError({
          reason: "storage",
          message:
            "This environment's cluster state could not be read. The server log has details.",
          cause,
        }),
    ),
    Effect.withSpan("ClusterRole.current"),
  );

  const refuseIfMember = Effect.fn("ClusterRole.refuseIfMember")(function* (action: string) {
    const state = yield* current;
    if (state.role === "member") return yield* refusal(state, action);
  });

  const refuseIfClustered = Effect.fn("ClusterRole.refuseIfClustered")(function* (action: string) {
    const state = yield* current;
    if (state.role !== "standalone") return yield* refusal(state, action);
  });

  return ClusterRole.of({ current, refuseIfMember, refuseIfClustered });
});

export const layer = Layer.effect(ClusterRole, make);
