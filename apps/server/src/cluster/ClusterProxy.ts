import {
  AuthWebSocketTicketResult,
  CLUSTER_ROUTE_PREFIX,
  CLUSTER_SCOPES_HEADER,
  type ClusterError,
  type ClusterMemberStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { pumpFrames } from "../device/DeviceHubProxy.ts";
import { forwardedRequestHeaders, forwardedResponseHeaders } from "../proxyHeaders.ts";
import { requestUrl } from "../requestUrl.ts";
import * as ClusterService from "./ClusterService.ts";
import * as PinnedTransport from "./pinnedTransport.ts";

const MEMBER_PATH = /^\/cluster\/([^/]+)(\/.*)?$/;
// The proxy answers socket tickets itself: the client then opens the socket with a main-host ticket.
const TICKET_PATH = /^\/api\/auth\/websocket-ticket(?:\/(rpc|media))?$/;
// Join, leave, the control link and MCP belong to the main host, and agent sign-in approval to the
// member itself; a capped client must not reach them.
const MAIN_HOST_ONLY_PATH = /^\/(?:api\/cluster|mcp|oauth\/mcp)(?:\/|$)/;
// Signed file links carry their own credential and load in <img> and native image views, which
// send no sign-in; the member checks the signature, and the request reaches it with no scopes.
const SIGNED_PATH = /^\/api\/assets\//;

const encodeTicket = Schema.encodeEffect(AuthWebSocketTicketResult);
const notFound = () => HttpServerResponse.text("Not Found", { status: 404 });

const memberFailure = (
  memberId: EnvironmentId,
  status: Exclude<ClusterMemberStatus, "online">,
  message?: string,
) =>
  HttpServerResponse.jsonUnsafe(
    {
      code:
        status === "offline"
          ? "cluster_member_unreachable"
          : status === "incompatible"
            ? "cluster_member_incompatible"
            : "cluster_member_revoked",
      memberId,
      ...(message === undefined ? {} : { message }),
    },
    { status: 502 },
  );

const unreachable = (memberId: EnvironmentId, cause: unknown) =>
  memberFailure(
    memberId,
    "offline",
    PinnedTransport.isPinMismatch(cause) ? ClusterService.CERTIFICATE_CHANGED : undefined,
  );

const connectFailure = (memberId: EnvironmentId, error: ClusterError) =>
  error.reason === "disabled"
    ? HttpServerResponse.jsonUnsafe({ code: "cluster_disabled" }, { status: 403 })
    : error.reason === "unknown_member"
      ? notFound()
      : memberFailure(memberId, "offline");

// Unauthenticated: answer only while the control link is up, so a stranger cannot keep starting ssh.
const memberDown = Effect.fn("ClusterProxy.memberDown")(function* (memberId: EnvironmentId) {
  const cluster = yield* ClusterService.ClusterService;
  const members = Option.getOrElse(yield* Stream.runHead(cluster.members), () => []);
  const status = members.find((member) => member.environmentId === memberId)?.status;
  return status !== undefined && status !== "online" ? memberFailure(memberId, status) : undefined;
});

const forwardPublicDescriptor = Effect.fn("ClusterProxy.forwardPublicDescriptor")(function* (
  memberId: EnvironmentId,
  request: HttpServerRequest.HttpServerRequest,
) {
  const cluster = yield* ClusterService.ClusterService;
  const down = yield* memberDown(memberId);
  if (down !== undefined) return down;
  const connected = yield* Effect.result(cluster.connect(memberId));
  if (Result.isFailure(connected)) return connectFailure(memberId, connected.failure);
  const { upstream } = connected.success;
  const response = yield* upstream.httpClient
    .execute(
      HttpClientRequest.get(`${upstream.origin}/.well-known/t3/environment`).pipe(
        HttpClientRequest.setHeaders({ accept: request.headers.accept ?? "application/json" }),
      ),
    )
    .pipe(
      Effect.flatMap((response) => Effect.map(response.json, (body) => [response, body] as const)),
      Effect.result,
    );
  if (Result.isFailure(response)) return unreachable(memberId, response.failure);
  const [upstreamResponse, body] = response.success;
  return HttpServerResponse.jsonUnsafe(body, { status: upstreamResponse.status });
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  const match = Option.isSome(url) ? MEMBER_PATH.exec(url.value.pathname) : null;
  if (Option.isNone(url) || match === null) return notFound();
  // The member's router ignores everything from the first `;`, so neither decides on nor forwards it.
  const path = (match[2] ?? "/").split(";", 1)[0] || "/";
  // Every decision below uses the path as the member's router matches it, however it was spelled.
  const decoded = Option.liftThrowable(() => ({
    memberId: decodeURIComponent(match[1]!),
    route: decodeURIComponent(path)
      .replaceAll(/\/+/g, "/")
      .replace(/(.)\/$/, "$1")
      .toLowerCase(),
  }))();
  if (Option.isNone(decoded)) return notFound();
  const { route } = decoded.value;
  if (MAIN_HOST_ONLY_PATH.test(route)) return notFound();
  const memberId = EnvironmentId.make(decoded.value.memberId);
  const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";

  // The descriptor is public on every environment; clients read it before they hold credentials.
  if (!upgrade && request.method === "GET" && route === "/.well-known/t3/environment") {
    return yield* forwardPublicDescriptor(memberId, request);
  }
  const signed =
    !upgrade && (request.method === "GET" || request.method === "HEAD") && SIGNED_PATH.test(route);
  if (signed) {
    const down = yield* memberDown(memberId);
    if (down !== undefined) return down;
  }
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = signed
    ? undefined
    : yield* (
        upgrade
          ? serverAuth.authenticateWebSocketUpgrade(request, route === "/ws" ? "rpc" : "media")
          : serverAuth.authenticateHttpRequest(request)
      ).pipe(
        Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
          failEnvironmentAuthInvalid(
            EnvironmentAuth.serverAuthCredentialReason(error),
            EnvironmentAuth.serverAuthDpopFailureReason(error),
          ),
        ),
        Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
          failEnvironmentInternal("internal_error", error),
        ),
      );

  const ticketUse =
    session !== undefined && request.method === "POST" ? TICKET_PATH.exec(route) : null;
  if (session !== undefined && ticketUse !== null) {
    const use = ticketUse[1] === "rpc" || ticketUse[1] === "media" ? ticketUse[1] : undefined;
    const ticket = yield* serverAuth
      .issueWebSocketTicket(session, use === undefined ? undefined : { use })
      .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
    return HttpServerResponse.jsonUnsafe(yield* encodeTicket(ticket).pipe(Effect.orDie));
  }

  const cluster = yield* ClusterService.ClusterService;
  const connected = yield* Effect.result(cluster.connect(memberId));
  if (Result.isFailure(connected)) return connectFailure(memberId, connected.failure);
  const { upstream, token, member } = connected.success;

  const credentials = {
    authorization: `Bearer ${token}`,
    [CLUSTER_SCOPES_HEADER]: session === undefined ? "" : encodeOAuthScope(session.scopes),
  };
  const search = new URLSearchParams(url.value.search);
  search.delete("wsTicket");
  search.delete("dpop");
  const upstreamUrl = `${upstream.origin}${path}${search.size > 0 ? `?${search}` : ""}`;

  const sessions = yield* SessionStore.SessionStore;
  // A revoked client session or a removed member ends what is in flight.
  const ended =
    session === undefined
      ? cluster.awaitGone(memberId)
      : Effect.raceFirst(
          sessions.awaitInvalidation(session.sessionId).pipe(Effect.ignore),
          cluster.awaitGone(memberId),
        );

  if (upgrade) {
    // The control link vouches for the member: it answers, speaks this protocol, accepts this host.
    if (member.status !== "online") return memberFailure(memberId, member.status);
    const protocols =
      request.headers["sec-websocket-protocol"]
        ?.split(",")
        .map((protocol) => protocol.trim())
        .filter((protocol) => protocol.length > 0) ?? [];
    const transport = NodeHttpServerRequest.toIncomingMessage(request).socket;
    const pipe = Effect.gen(function* () {
      const remote = yield* Socket.makeWebSocket(upstreamUrl.replace(/^http/, "ws"), {
        openTimeout: "10 seconds",
        ...(protocols.length > 0 ? { protocols } : {}),
        headers: credentials,
      }).pipe(Effect.provideService(Socket.WebSocketConstructor, upstream.webSocket));
      const client = yield* request.upgrade;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const writeToClient = yield* client.writer;
          const writeToMember = yield* remote.writer;
          return yield* Effect.raceFirst(
            pumpFrames(remote, writeToClient),
            pumpFrames(client, writeToMember),
          );
        }),
      ).pipe(
        Effect.onInterrupt(() => Effect.sync(() => transport.destroy())),
        Effect.ignoreCause,
      );
      return HttpServerResponse.empty();
    });
    return yield* Effect.raceFirst(pipe, ended.pipe(Effect.as(HttpServerResponse.empty())));
  }

  // Some routes answer a refused credential with 200, so the link's verdict is checked first.
  if (member.status === "revoked") return memberFailure(memberId, "revoked");
  const method = request.method;
  if (!HttpMethod.isHttpMethod(method)) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const response = yield* HttpClient.withScope(upstream.httpClient)
    .execute(
      HttpClientRequest.make(method)(upstreamUrl).pipe(
        // Last, so a client-sent scope cap is always replaced.
        HttpClientRequest.setHeaders({
          ...forwardedRequestHeaders(request.headers),
          ...credentials,
        }),
        method === "GET" || method === "HEAD"
          ? (self) => self
          : HttpClientRequest.bodyStream(request.stream, {
              contentType: request.headers["content-type"],
            }),
      ),
    )
    .pipe(Effect.result);
  // Status is the control link's to record; the proxy only answers this request.
  if (Result.isFailure(response)) return unreachable(memberId, response.failure);
  if (response.success.status === 401) return memberFailure(memberId, "revoked");
  const responseHeaders = forwardedResponseHeaders(response.success.headers);
  return HttpServerResponse.stream(response.success.stream.pipe(Stream.interruptWhen(ended)), {
    status: response.success.status,
    headers: responseHeaders,
    ...(responseHeaders["content-type"] ? { contentType: responseHeaders["content-type"] } : {}),
  });
});

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<
      EnvironmentAuth.EnvironmentAuth | SessionStore.SessionStore | ClusterService.ClusterService
    >();
    yield* router.add("*", `${CLUSTER_ROUTE_PREFIX}/*`, Effect.provideContext(handler, services));
  }),
);
