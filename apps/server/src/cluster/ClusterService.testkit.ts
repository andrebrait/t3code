import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeTls from "node:tls";
import {
  type ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerTls from "../tls/ServerTls.ts";
import * as ClusterService from "./ClusterService.ts";

export const FINGERPRINT = "ab".repeat(32);

export const clusterDescriptor = (environmentId: string, label: string) => ({
  ...descriptorOf(environmentId, label, { cluster: true }),
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
});

/** One environment with its own database, as a member or a main host. */
const layerClusterEnvironment = (descriptor: ExecutionEnvironmentDescriptor) =>
  ClusterService.layer.pipe(
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(ServerSettings.layerTest({ clusterEnabled: true })),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(
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
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.fresh,
  );

export const makeEnvironment = (descriptor: ExecutionEnvironmentDescriptor) =>
  layerClusterEnvironment(descriptor).pipe(
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
