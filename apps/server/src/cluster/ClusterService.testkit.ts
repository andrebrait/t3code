import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off - NodeHttpServer.layer takes Node's server factory.
import * as NodeHttp from "node:http";
import * as NodeTls from "node:tls";
import {
  CLUSTER_SCOPES_HEADER,
  ClusterError,
  type ClusterHostReplyInput,
  type ClusterHostRequest,
  type ClusterMember,
  type ClusterMemberStatus,
  EnvironmentHttpApi,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
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
import { CLUSTER_MEMBER_PAIRING_SUBJECT } from "../persistence/AuthPairingLinks.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { pumpFrames } from "../device/DeviceHubProxy.ts";
import * as ServerTls from "../tls/ServerTls.ts";
import * as ClusterService from "./ClusterService.ts";
import * as ClusterSshKey from "./ClusterSshKey.ts";
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

const unusedSshKey = ClusterSshKey.ClusterSshKey.of({
  identityFile: Effect.die("this test reaches members over http"),
  authorize: () => Effect.die("this test reaches members over http"),
  revoke: () => Effect.die("this test reaches members over http"),
  list: Effect.succeed([]),
});

/** One environment with its own database, as a member or a main host. */
const layerClusterEnvironment = (
  descriptor: ExecutionEnvironmentDescriptor,
  ssh: SshTunnel.SshEnvironmentManager["Service"],
  sshKey: ClusterSshKey.ClusterSshKey["Service"],
) =>
  ClusterService.layer.pipe(
    Layer.provideMerge(ClusterUpstream.layer),
    Layer.provideMerge(Layer.succeed(ClusterSshKey.ClusterSshKey, sshKey)),
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
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cluster-" })),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.fresh,
  );

export const makeEnvironment = (
  descriptor: ExecutionEnvironmentDescriptor,
  ssh: SshTunnel.SshEnvironmentManager["Service"] = unusedSsh,
  sshKey: ClusterSshKey.ClusterSshKey["Service"] = unusedSshKey,
) =>
  layerClusterEnvironment(descriptor, ssh, sshKey).pipe(
    Layer.build,
    Effect.map((context) => ({
      context,
      cluster: Context.get(context, ClusterService.ClusterService),
      auth: Context.get(context, EnvironmentAuth.EnvironmentAuth),
      settings: Context.get(context, ServerSettings.ServerSettingsService),
      sql: Context.get(context, SqlClient.SqlClient),
      secretsDir: Context.get(context, ServerConfig.ServerConfig).secretsDir,
    })),
  );

export type ClusterEnvironment = Effect.Success<ReturnType<typeof makeEnvironment>>;

class MemberTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.cluster) {}

const encodeEchoHello = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      authorization: Schema.NullOr(Schema.String),
      scopes: Schema.NullOr(Schema.String),
    }),
  ),
);

/** Reports the credential and scope cap the member received, then echoes. */
const layerEcho = HttpRouter.add(
  "GET",
  "/echo",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    const writer = yield* socket.writer;
    // Writes wait for the reader that `pumpFrames` opens, so this one runs beside it.
    yield* writer
      .write(
        encodeEchoHello({
          authorization: request.headers.authorization ?? null,
          scopes: request.headers[CLUSTER_SCOPES_HEADER] ?? null,
        }),
      )
      .pipe(Effect.forkScoped);
    return yield* pumpFrames(socket, writer);
  }).pipe(Effect.scoped, Effect.ignoreCause, Effect.as(HttpServerResponse.empty())),
);

/** Stands in for the member's MCP endpoint, which answers any caller it accepts. */
const layerMcp = HttpRouter.add("*", "/mcp/*", HttpServerResponse.text("mcp"));

const memberRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(MemberTestApi).pipe(
    Layer.provide(ClusterHttp.layer),
    Layer.provide(AuthHttp.layer),
    Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
  ),
  ClusterHttp.layerEvents,
  layerEcho,
  layerMcp,
);

/** `routes` on a real socket in the current scope; returns its `http://` origin. */
export const serveRoutes = <A, E, R>(routes: Layer.Layer<A, E, R>) =>
  Effect.gen(function* () {
    // Bound to the address tests dial: on the IPv6 wildcard, another process's later bind of
    // 127.0.0.1 on the same port takes this server's IPv4 traffic.
    const server = yield* Layer.build(
      Layer.fresh(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    );
    yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.fresh,
      Layer.build,
      Effect.provideContext(server),
    );
    const address = Context.get(server, HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
    return `http://127.0.0.1:${address.port}`;
  });

/**
 * A member on a real socket; `serveAgain` serves the same environment at a new address.
 * `hostRequestGate` runs in its `GET /api/cluster/host-request/:requestId` handler once the call
 * is taken, and `hostReplyGate` in its `POST /api/cluster/host-reply` handler before the answer
 * lands, so a test can hold either request open.
 */
export const serveMember = (
  descriptor: ExecutionEnvironmentDescriptor,
  options: {
    readonly hostRequestGate?: (request: ClusterHostRequest) => Effect.Effect<void>;
    readonly hostReplyGate?: (input: ClusterHostReplyInput) => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const environment = yield* makeEnvironment(descriptor);
    const { hostRequestGate, hostReplyGate } = options;
    const context = Context.add(
      environment.context,
      ClusterService.ClusterService,
      ClusterService.ClusterService.of({
        ...environment.cluster,
        hostRequest: (session, requestId) =>
          environment.cluster
            .hostRequest(session, requestId)
            .pipe(Effect.tap((request) => hostRequestGate?.(request) ?? Effect.void)),
        hostReply: (session, input) =>
          (hostReplyGate?.(input) ?? Effect.void).pipe(
            Effect.andThen(environment.cluster.hostReply(session, input)),
          ),
      }),
    );
    const serveAgain = serveRoutes(memberRoutes).pipe(Effect.provideContext(context));
    return { ...environment, url: yield* serveAgain, serveAgain };
  });

/** The member as `main` lists it, once its status is `status`. */
export const awaitStatus = (
  main: ClusterEnvironment,
  memberId: EnvironmentId,
  status: ClusterMemberStatus,
) =>
  main.cluster.members.pipe(
    Stream.flatMap((members) => Stream.fromIterable(members)),
    Stream.filter((member) => member.environmentId === memberId && member.status === status),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

/** An environment agent calls are routed to, as a main host stores its member. */
export interface RoutedEnvironment {
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly url: string;
  /** The member's `cluster-host` token the main host sends. */
  readonly token: string;
}

const upstreamAt = (url: string) =>
  HttpClient.HttpClient.pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.map((httpClient): ClusterUpstream.Upstream => ({
      origin: new URL(url).origin,
      httpClient,
      webSocket: () => {
        throw new Error("Agent routing opens no WebSockets.");
      },
    })),
  );

const asMember = ({ descriptor, url }: RoutedEnvironment): ClusterMember => ({
  environmentId: descriptor.environmentId,
  label: descriptor.label,
  transport: "https",
  address: url,
  status: "online",
  joinedAt: DateTime.makeUnsafe(0),
  lastReachedAt: null,
  lastError: null,
});

/** A main host whose members are `members`. */
export const layerRoutingMain = (members: Ref.Ref<ReadonlyArray<RoutedEnvironment>>) =>
  Layer.mock(ClusterService.ClusterService)({
    status: Effect.succeed({ enabled: true, role: "main", fingerprint: FINGERPRINT, host: null }),
    members: Stream.fromEffect(Ref.get(members)).pipe(Stream.map((list) => list.map(asMember))),
    connect: (memberId) =>
      Ref.get(members).pipe(
        Effect.flatMap((list) => {
          const member = list.find((candidate) => candidate.descriptor.environmentId === memberId);
          return member === undefined
            ? Effect.fail(
                new ClusterError({
                  reason: "unknown_member",
                  message: `${memberId} is not a member of this cluster.`,
                }),
              )
            : upstreamAt(member.url).pipe(
                Effect.map((upstream) => ({
                  upstream,
                  token: member.token,
                  member: asMember(member),
                })),
              );
        }),
      ),
  });

/** A member of `host` whose control link is `hostCall`. */
export const layerRoutingMember = (input: {
  readonly host: ExecutionEnvironmentDescriptor;
  readonly hostCall: ClusterService.ClusterService["Service"]["hostCall"];
}) =>
  Layer.mock(ClusterService.ClusterService)({
    status: Effect.succeed({
      enabled: true,
      role: "member",
      fingerprint: FINGERPRINT,
      host: {
        environmentId: input.host.environmentId,
        label: input.host.label,
        joinedAt: DateTime.makeUnsafe(0),
      },
    }),
    hostCall: input.hostCall,
  });

/** A `cluster-host` session on the environment `auth` serves, as a main host holds after adding it. */
export const clusterHostToken = (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  hostLabel: string,
) =>
  auth.createPairingLink({ subject: CLUSTER_MEMBER_PAIRING_SUBJECT }).pipe(
    Effect.flatMap((invite) =>
      auth.consumeClusterInvite(invite.credential, {
        hostLabel,
        client: { deviceType: "unknown" },
      }),
    ),
    Effect.map((session) => session.token),
  );
