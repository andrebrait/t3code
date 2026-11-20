import {
  AuthAccessWriteScope,
  CLUSTER_SCOPES_HEADER,
  type ClusterError,
  ClusterLinkEvent,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiError from "effect/http-api/HttpApiError";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { annotateEnvironmentRequest } from "../auth/http.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as ClusterService from "./ClusterService.ts";

/** `unknown_request` is 404; a refusal of any session but the link's is 403. */
const linkHttpError = (error: ClusterError) =>
  error.reason === "unknown_request"
    ? new HttpApiError.NotFound()
    : new EnvironmentHttpForbiddenError({ message: error.message });

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "cluster",
  Effect.fnUntraced(function* (handlers) {
    const cluster = yield* ClusterService.ClusterService;
    return handlers
      .handle(
        "join",
        Effect.fn("environment.cluster.join")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* cluster.acceptJoin(args.payload, deriveAuthClientMetadata({ request }));
        }),
      )
      .handle(
        "leave",
        Effect.fn("environment.cluster.leave")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          const request = yield* HttpServerRequest.HttpServerRequest;
          // A client the main host proxies authenticates as the cluster host, so refuse it here too.
          if (
            request.headers[CLUSTER_SCOPES_HEADER] !== undefined ||
            (principal.subject !== EnvironmentAuth.CLUSTER_HOST_SUBJECT &&
              !principal.scopes.has(AuthAccessWriteScope))
          ) {
            return yield* new EnvironmentHttpForbiddenError({
              message:
                "Only this environment's cluster host, or a session that manages its access, can remove it from the cluster.",
            });
          }
          return yield* cluster.leave;
        }),
      )
      .handle(
        "hostRequest",
        Effect.fn("environment.cluster.hostRequest")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          return yield* cluster
            .hostRequest({ sessionId: principal.sessionId }, args.params.requestId)
            .pipe(Effect.mapError(linkHttpError));
        }),
      )
      .handle(
        "hostReply",
        Effect.fn("environment.cluster.hostReply")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          return yield* cluster
            .hostReply({ sessionId: principal.sessionId }, args.payload)
            .pipe(Effect.mapError(linkHttpError));
        }),
      );
  }),
);

// Idle edges (T3 Connect drops idle requests after about 100 s) stay open; the main host counts silence.
const LINK_HEARTBEAT = Duration.seconds(15);
const encodeLinkEvent = Schema.encodeSync(Schema.fromJsonString(ClusterLinkEvent));

/** A member's control link: the main host holds this open; it carries doorbells, never payloads. */
export const layerEvents = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const cluster = yield* ClusterService.ClusterService;
    yield* router.add(
      "GET",
      "/api/cluster/events",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authenticated = yield* auth.authenticateHttpRequest(request).pipe(Effect.result);
        // 401 means revoked to the main host; a failed check (a busy database) is only offline.
        if (Result.isFailure(authenticated)) {
          return HttpServerResponse.empty({
            status: EnvironmentAuth.isServerAuthCredentialError(authenticated.failure) ? 401 : 503,
          });
        }
        const session = authenticated.success;
        const events = yield* cluster.hostEvents(session).pipe(Effect.option);
        if (Option.isNone(events)) return HttpServerResponse.empty({ status: 403 });
        const body = events.value.pipe(
          Stream.map((event) =>
            Sse.encoder.write({
              _tag: "Event",
              event: event._tag,
              id: undefined,
              data: encodeLinkEvent(event),
            }),
          ),
          Stream.merge(Stream.tick(LINK_HEARTBEAT).pipe(Stream.map(() => ": heartbeat\n\n")), {
            haltStrategy: "left",
          }),
          // Leave or a new join revokes the session; the main host's reconnect then hears 401.
          Stream.interruptWhen(sessions.awaitInvalidation(session.sessionId)),
          Stream.encodeText,
        );
        return HttpServerResponse.stream(body, {
          contentType: "text/event-stream",
          // no-transform keeps compression from buffering it; x-accel-buffering does the same for proxies.
          headers: { "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
        });
      }),
    );
  }),
);
