import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeTls from "node:tls";
import {
  EnvironmentHttpApi,
  type ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerTls from "../tls/ServerTls.ts";
import * as ClusterService from "./ClusterService.ts";
import * as ClusterUpstream from "./ClusterUpstream.ts";
import * as ClusterHttp from "./http.ts";

export const FINGERPRINT = "ab".repeat(32);

export const clusterDescriptor = (environmentId: string, label: string) => ({
  ...descriptorOf(environmentId, label, { cluster: true }),
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
});

const unusedSsh = SshTunnel.SshEnvironmentManager.of({
  ensureEnvironment: () => Effect.die("this test reaches members over http"),
  disconnectEnvironment: () => Effect.void,
  closeAllTunnels: Effect.void,
});

/** One environment with its own database, as a member or a main host. */
const layerClusterEnvironment = (
  descriptor: ExecutionEnvironmentDescriptor,
  ssh: SshTunnel.SshEnvironmentManager["Service"],
) =>
  ClusterService.layer.pipe(
    Layer.provideMerge(ClusterUpstream.layer),
    Layer.provide(Layer.succeed(SshTunnel.SshEnvironmentManager, ssh)),
    Layer.provide(SshAuth.SshPasswordPrompt.disabledLayer),
    Layer.provide(NetService.layer),
    Layer.provideMerge(PeerLinks.layer),
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(ServerSettings.layerTest({ clusterEnabled: true })),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.succeed(ServerTls.ServerTls, {
        fingerprint: FINGERPRINT,
        secureContext: NodeTls.createSecureContext(),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(descriptor.environmentId),
        getDescriptor: Effect.succeed(descriptor),
      }),
    ),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cluster-" })),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.fresh,
  );

export const makeEnvironment = (
  descriptor: ExecutionEnvironmentDescriptor,
  ssh: SshTunnel.SshEnvironmentManager["Service"] = unusedSsh,
) =>
  layerClusterEnvironment(descriptor, ssh).pipe(
    Layer.build,
    Effect.map((context) => ({
      context,
      cluster: Context.get(context, ClusterService.ClusterService),
      auth: Context.get(context, EnvironmentAuth.EnvironmentAuth),
      settings: Context.get(context, ServerSettings.ServerSettingsService),
      sql: Context.get(context, SqlClient.SqlClient),
    })),
  );

export type ClusterEnvironment = Effect.Success<ReturnType<typeof makeEnvironment>>;

class MemberTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.cluster) {}

const memberRoutes = HttpApiBuilder.layer(MemberTestApi).pipe(
  Layer.provide(ClusterHttp.layer),
  Layer.provide(AuthHttp.layer),
  Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
);

/** A member on a real socket; `serveAgain` serves the same environment at a new address. */
export const serveMember = (descriptor: ExecutionEnvironmentDescriptor) =>
  Effect.gen(function* () {
    const environment = yield* makeEnvironment(descriptor);
    const serveAgain = Effect.gen(function* () {
      const server = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
      yield* HttpRouter.serve(memberRoutes, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provide(Layer.succeedContext(environment.context)),
        Layer.fresh,
        Layer.build,
        Effect.provideContext(server),
      );
      const address = Context.get(server, HttpServer.HttpServer).address;
      if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
      return `http://127.0.0.1:${address.port}`;
    });
    return { ...environment, url: yield* serveAgain, serveAgain };
  });
