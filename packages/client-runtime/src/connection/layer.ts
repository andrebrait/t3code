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
import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { PreparedConnection } from "./model.ts";
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
 * Publishes each enabled main host's connection for its members to borrow and lists its members.
 * Members outlive host reconnects; a host that changes route or credential re-prepares them.
 */
export const watchClusterMembers = Effect.fn("connection.watchClusterMembers")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const hosts = yield* ClusterHosts.ClusterHosts;
  // The parts of a host connection its members borrow (see the resolver's cluster broker).
  const borrowed = new Map<EnvironmentId, string>();
  const dropMembers = (hostEnvironmentId: EnvironmentId) =>
    registry.reconcileCluster({ hostEnvironmentId, hostLabel: "", members: [] });
  const publishHost = Effect.fnUntraced(function* (
    hostEnvironmentId: EnvironmentId,
    host: Option.Option<PreparedConnection>,
  ) {
    yield* hosts.set(hostEnvironmentId, host);
    if (Option.isNone(host)) return;
    const authorization = host.value.httpAuthorization;
    const next = `${host.value.httpBaseUrl} ${
      authorization === null
        ? ""
        : authorization._tag === "Bearer"
          ? authorization.token
          : authorization.accessToken
    }`;
    const previous = borrowed.get(hostEnvironmentId);
    borrowed.set(hostEnvironmentId, next);
    if (previous === undefined || previous === next) return;
    for (const { target } of (yield* SubscriptionRef.get(registry.entries)).values()) {
      if (
        target._tag === "ClusterConnectionTarget" &&
        target.hostEnvironmentId === hostEnvironmentId
      ) {
        yield* registry.reprepare(target.environmentId);
      }
    }
  });
  const followHost = (hostEnvironmentId: EnvironmentId) =>
    registry
      .followStream(
        hostEnvironmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.prepared).pipe(
                Stream.changesWith(
                  (previous, next) => Option.getOrNull(previous) === Option.getOrNull(next),
                ),
                Stream.tap((prepared) =>
                  publishHost(hostEnvironmentId, ClusterHosts.clusterHostConnection(prepared)),
                ),
                // A disconnected host keeps its subscription; it resumes with the next session.
                Stream.filter(Option.isSome),
                Stream.map((prepared) =>
                  Option.map(
                    ClusterHosts.clusterHostConnection(prepared),
                    (host) => host.target.label,
                  ),
                ),
                Stream.changesWith(
                  (previous, next) => Option.getOrNull(previous) === Option.getOrNull(next),
                ),
                Stream.switchMap(
                  Option.match({
                    onNone: () =>
                      Stream.fromEffect(dropMembers(hostEnvironmentId)).pipe(Stream.drain),
                    onSome: (hostLabel) =>
                      subscribe(
                        WS_METHODS.clusterMembers,
                        {},
                        {
                          onExpectedFailure: (cause) =>
                            Effect.logWarning("Could not list a main host's cluster members.", {
                              hostEnvironmentId,
                              cause,
                            }),
                          retryExpectedFailureAfter: "1 second",
                        },
                      ).pipe(
                        Stream.tap((members) =>
                          registry.reconcileCluster({ hostEnvironmentId, hostLabel, members }),
                        ),
                      ),
                  }),
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
  const isHost = (entry: ConnectionCatalogEntry | undefined) =>
    entry !== undefined && entry.enabled && entry.target._tag !== "ClusterConnectionTarget";
  yield* SubscriptionRef.changes(registry.entries).pipe(
    Stream.runForEach((entries) =>
      Effect.gen(function* () {
        for (const [environmentId, entry] of entries) {
          if (!isHost(entry) || followed.has(environmentId)) continue;
          followed.set(environmentId, yield* followHost(environmentId).pipe(Effect.forkScoped));
        }
        for (const [environmentId, fiber] of followed) {
          if (isHost(entries.get(environmentId))) continue;
          followed.delete(environmentId);
          borrowed.delete(environmentId);
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
