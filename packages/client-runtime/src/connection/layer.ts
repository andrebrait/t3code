import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";

import * as ClusterHosts from "./clusterHosts.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as ConnectionDriver from "./driver.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionOnboarding from "./onboarding.ts";
import { connectionRoutes, hasRelayRoute } from "./routes.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as PlatformConnectionSource from "../platform/source.ts";
import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";
import { subscribe } from "../rpc/client.ts";

export const watchDiscoveredCompatibility = Effect.fn("connection.watchDiscoveredCompatibility")(
  function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
    const seenChecks = new Map<string, RelayEnvironmentStatusResponse>();
    yield* Stream.merge(
      SubscriptionRef.changes(discovery.state),
      SubscriptionRef.changes(registry.entries),
    ).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(discovery.state);
          if (!current.refreshing) {
            for (const environmentId of seenChecks.keys()) {
              if (!current.environments.has(environmentId)) seenChecks.delete(environmentId);
            }
          }
          const registered = yield* SubscriptionRef.get(registry.entries);
          for (const entry of current.environments.values()) {
            const status = Option.getOrNull(entry.status);
            const descriptor = status?.descriptor;
            if (status === null || descriptor === undefined) continue;
            const environmentId = entry.environment.environmentId;
            // Discovery describes the server behind the relay route. A direct
            // connection (the desktop's own server, a saved URL, SSH) can reach
            // a different server with the same environment id, such as a
            // preview app that shares the home directory.
            const saved = registered.get(environmentId);
            if (
              saved === undefined ||
              connectionRoutes(saved).length !== 1 ||
              !hasRelayRoute(saved)
            )
              continue;
            const previous = seenChecks.get(environmentId);
            const fresh =
              previous?.checkedAt !== status.checkedAt ||
              (previous.descriptor?.orchestrationProtocolVersion ?? 1) !==
                (descriptor.orchestrationProtocolVersion ?? 1) ||
              previous.descriptor?.serverVersion !== descriptor.serverVersion;
            const error = orchestrationProtocolCompatibilityError(descriptor);
            // A replayed health result must not clear a newer socket rejection.
            if (error !== null || fresh) yield* registry.setCompatibility(environmentId, error);
            seenChecks.set(environmentId, status);
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not apply discovered environment compatibility.", { error }),
          ),
        ),
      ),
    );
  },
);

/**
 * Publishes each main host's connection for its members to borrow and lists its members while it
 * is connected. A changed or lost host connection drops the members, so none keeps a stale route
 * or credential; the next subscription replays the list and they prepare again.
 */
export const watchClusterMembers = Effect.fn("connection.watchClusterMembers")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const hosts = yield* ClusterHosts.ClusterHosts;
  const dropMembers = (hostEnvironmentId: EnvironmentId) =>
    registry.reconcileCluster({ hostEnvironmentId, hostLabel: "", members: [] });
  const followHost = (hostEnvironmentId: EnvironmentId) =>
    registry
      .followStream(
        hostEnvironmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.prepared).pipe(
                Stream.map(ClusterHosts.clusterHostConnection),
                Stream.switchMap((host) =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      // followStream restarts on any entry change; only a new connection drops.
                      const previous = yield* hosts.get(hostEnvironmentId);
                      if (Option.getOrNull(previous) !== Option.getOrNull(host)) {
                        yield* hosts.set(hostEnvironmentId, host);
                        yield* dropMembers(hostEnvironmentId);
                      }
                      if (Option.isNone(host)) return Stream.empty;
                      return subscribe(WS_METHODS.clusterMembers, {}).pipe(
                        Stream.tap((members) =>
                          registry.reconcileCluster({
                            hostEnvironmentId,
                            hostLabel: host.value.target.label,
                            members,
                          }),
                        ),
                      );
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
      .pipe(
        Stream.runDrain,
        Effect.catchCause((cause) =>
          Effect.logWarning("Stopped following a main host's cluster members.", {
            hostEnvironmentId,
            cause,
          }),
        ),
      );
  const followed = new Map<EnvironmentId, Fiber.Fiber<void>>();
  yield* SubscriptionRef.changes(registry.entries).pipe(
    Stream.runForEach((entries) =>
      Effect.gen(function* () {
        for (const [environmentId, entry] of entries) {
          if (entry.target._tag === "ClusterConnectionTarget" || followed.has(environmentId)) {
            continue;
          }
          followed.set(environmentId, yield* followHost(environmentId).pipe(Effect.forkScoped));
        }
        for (const [environmentId, fiber] of followed) {
          const entry = entries.get(environmentId);
          if (entry !== undefined && entry.target._tag !== "ClusterConnectionTarget") continue;
          followed.delete(environmentId);
          yield* Fiber.interrupt(fiber);
          yield* hosts.set(environmentId, Option.none());
          yield* dropMembers(environmentId);
        }
      }),
    ),
  );
});

export function layerWithOptions(options: RpcSession.RpcSessionOptions) {
  const layerDriver = ConnectionDriver.layer.pipe(
    Layer.provide(Layer.mergeAll(ConnectionResolver.layer, RpcSession.layer(options))),
  );
  const layerRegistry = EnvironmentRegistry.layer.pipe(Layer.provide(layerDriver));
  const layerOnboarding = ConnectionOnboarding.layer.pipe(Layer.provide(layerRegistry));
  const layerConnectionServices = Layer.mergeAll(
    layerRegistry,
    RelayEnvironmentDiscovery.layer,
    layerOnboarding,
    ConnectionResolver.layer,
  );
  const layerConnectionStartup = Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const platformSource = yield* PlatformConnectionSource.PlatformConnectionSource;
      yield* watchDiscoveredCompatibility().pipe(Effect.forkScoped);
      yield* watchClusterMembers().pipe(Effect.forkScoped);
      yield* registry.start;
      yield* platformSource.registrations.pipe(
        Stream.runForEach(registry.reconcilePlatform),
        Effect.forkScoped,
      );
    }).pipe(Effect.withSpan("clientRuntime.connection.application.start")),
  );
  return layerConnectionStartup.pipe(
    Layer.provideMerge(layerConnectionServices),
    Layer.provideMerge(RemoteEnvironmentAuthorization.layer),
    Layer.provideMerge(ClusterHosts.layer),
  );
}

export const layer = layerWithOptions({});
