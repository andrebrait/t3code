import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { PreparedConnection } from "./model.ts";

/** Each main host's current connection, which its members' connections borrow. */
export class ClusterHosts extends Context.Service<
  ClusterHosts,
  {
    readonly get: (
      hostEnvironmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PreparedConnection>>;
    readonly set: (
      hostEnvironmentId: EnvironmentId,
      host: Option.Option<PreparedConnection>,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/connection/clusterHosts") {}

/** @public */
export const layer = Layer.effect(
  ClusterHosts,
  Effect.gen(function* () {
    const hosts = yield* Ref.make<ReadonlyMap<EnvironmentId, PreparedConnection>>(new Map());
    return ClusterHosts.of({
      get: Effect.fn("ClusterHosts.get")(function* (hostEnvironmentId: EnvironmentId) {
        return Option.fromUndefinedOr((yield* Ref.get(hosts)).get(hostEnvironmentId));
      }),
      set: Effect.fn("ClusterHosts.set")(function* (
        hostEnvironmentId: EnvironmentId,
        host: Option.Option<PreparedConnection>,
      ) {
        yield* Ref.update(hosts, (current) => {
          const next = new Map(current);
          if (Option.isSome(host)) next.set(hostEnvironmentId, host.value);
          else next.delete(hostEnvironmentId);
          return next;
        });
      }),
    });
  }),
);

/** A connection whose server lists cluster members. Older hosts lack the capability and the RPC. */
export const clusterHostConnection = (prepared: Option.Option<PreparedConnection>) =>
  Option.filter(
    prepared,
    (connection) =>
      connection.target._tag !== "ClusterConnectionTarget" &&
      connection.descriptor?.capabilities.cluster === true,
  );
