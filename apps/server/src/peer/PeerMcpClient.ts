import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLinkError,
  type ProviderInteractionMode,
  type OrchestrationV2LinkedSender,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** The only MCP protocol version a T3 Code `/mcp` registers. */
const PROTOCOL_VERSION = "2025-06-18";

/** A title can be any length; the header carrying it stays well under HTTP header limits. */
const SENDER_TITLE_MAX_LENGTH = 200;

const unreachable = (route: { readonly messages: { readonly unreachable: string } }) =>
  Effect.fail(
    new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: route.messages.unreachable,
    }),
  );

/** The limits a call carries to the peer: the calling agent's modes here. */
export interface PeerCallLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** Where a call goes and what the agent hears when it fails there. */
export interface McpRoute {
  /** Calls with one key share one MCP session, so keys must be unique across every route kind. */
  readonly key: string;
  /** `/mcp` is appended. */
  readonly origin: string;
  readonly token: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly messages: {
    /** Names the other side in a sentence, e.g. "The linked environment". */
    readonly name: string;
    readonly revoked: string;
    readonly off: string;
    readonly unreachable: string;
  };
  /** Whether it answered: `null` when it did, else why not. */
  readonly recordOutcome: (error: string | null) => Effect.Effect<void>;
  /** A peer link, whose expiry the peer may push back while it is used. */
  readonly link?: PeerLinks.ResolvedPeerLink["link"];
}

/**
 * Calls a linked environment's T3 MCP tools as this environment's outside
 * agent. Each call carries the calling agent's limits in `T3-Mode-Limit`, so
 * the peer enforces the narrower of those and the link's own access.
 */
export class PeerMcpClient extends Context.Service<
  PeerMcpClient,
  {
    /** Calls `tool` on the peer and decodes its structured result with `success`. */
    readonly call: <S extends Schema.Decoder<unknown>>(input: {
      readonly environmentId: EnvironmentId;
      /** Where to send it; without one, over the peer link to `environmentId`. */
      readonly route?: McpRoute;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
      readonly limits: PeerCallLimits;
      /** The thread here the call is made for, sent as `T3-Sender-Thread`. */
      readonly sender?: OrchestrationV2LinkedSender;
      readonly success: S;
    }) => Effect.Effect<S["Type"], OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerMcpClient") {}

const ToolCallResponse = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      ),
      structuredContent: Schema.optional(Schema.Unknown),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const decodeToolCallResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCallResponse));
const decodeFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ code: OrchestratorMcpFailure.fields.code, message: Schema.String }),
  ),
);

/** A peer link problem, as the agent that asked hears it. */
const fromLinkError = (error: PeerLinkError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "unknown_link"
        ? "invalid_request"
        : error.reason === "expired" || error.reason === "incompatible"
          ? "capability_denied"
          : "orchestration_error",
    message: error.message,
  });

/** A peer link's words; `off` is not final, so a task there resumes once the beta is on again. */
const peerMessages: McpRoute["messages"] = {
  name: "The linked environment",
  revoked:
    "The linked environment no longer accepts this link. It may have been revoked there; link it again.",
  off: "The linked environment has Linked environments turned off. Turn it on in its Settings → Labs.",
  unreachable: "The linked environment stopped answering.",
};

/** The body of an MCP response: JSON, or a single server-sent event carrying JSON. */
const responseJson = (contentType: string | undefined, text: string) =>
  contentType?.includes("text/event-stream") === true
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("")
    : text;

/**
 * A tool's answer, from `/mcp` or a cluster's control link. A refusal is `Result.fail` with the
 * other side's own code, so the agent sees why; an answer this version cannot read fails.
 */
export const decodeToolResult = <S extends Schema.Decoder<unknown>>(
  answer: { readonly isError: boolean; readonly text: string },
  success: S,
  name: string,
) => {
  if (answer.isError) {
    const refused = decodeFailure(answer.text);
    return Effect.succeed(
      Result.fail(
        refused._tag === "Some"
          ? new OrchestratorMcpFailure({ code: refused.value.code, message: refused.value.message })
          : new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: answer.text || `${name} refused the call.`,
            }),
      ),
    );
  }
  return Schema.decodeEffect(Schema.fromJsonString(success))(answer.text).pipe(
    Effect.map((decoded): Result.Result<S["Type"], OrchestratorMcpFailure> =>
      Result.succeed(decoded),
    ),
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `${name}'s answer did not match this version. Update both environments.`,
        }),
    ),
  );
};

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;
  // One MCP session per route key, reused across calls. The other side keeps
  // sessions in memory, so a restart there answers 404 and we start a new one.
  const sessions = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  const post = (route: McpRoute, body: unknown, headers: Record<string, string>) =>
    route.httpClient.execute(
      HttpClientRequest.post(`${route.origin}/mcp`).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${route.token}`,
          ...headers,
        }),
        HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
      ),
    );

  // A peer that renews a used link says when it now ends; one that does not sends nothing.
  const recordLinkExpiry = ({ link }: McpRoute, headers: Readonly<Record<string, string>>) =>
    link === undefined
      ? Effect.void
      : Option.match(
          Option.filter(
            Option.flatMap(
              Option.fromNullishOr(headers[McpInvocationContext.LINK_EXPIRES_AT_HEADER]),
              DateTime.make,
            ),
            (expiresAt) => !DateTime.Equivalence(expiresAt, link.expiresAt),
          ),
          {
            onNone: () => Effect.void,
            onSome: (expiresAt) => links.recordExpiry(link.environmentId, expiresAt),
          },
        );

  const openSession = Effect.fn("PeerMcpClient.openSession")(
    function* (route: McpRoute, limitHeader: Record<string, string>) {
      const initialized = yield* post(
        route,
        {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "t3code-peer", version: "1" },
          },
        },
        limitHeader,
      );
      const sessionId = initialized.headers["mcp-session-id"];
      if (initialized.status === 403) {
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: route.messages.off,
        });
      }
      if (initialized.status !== 200 || sessionId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: initialized.status === 401 ? "capability_denied" : "orchestration_error",
          message:
            initialized.status === 401
              ? route.messages.revoked
              : `${route.messages.name} refused to start an MCP session (HTTP ${initialized.status}).`,
        });
      }
      yield* recordLinkExpiry(route, initialized.headers);
      yield* post(
        route,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { ...limitHeader, "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
      );
      return sessionId;
    },
    // Only the handshake is bounded: a forwarded tool call may wait for minutes.
    (effect, route) => Effect.timeout(effect, PeerLinks.probeTimeout(route.origin)),
  );

  const callRoute = Effect.fn("PeerMcpClient.callRoute")(
    function* <S extends Schema.Decoder<unknown>>(
      route: McpRoute,
      input: Parameters<PeerMcpClient["Service"]["call"]>[0] & { readonly success: S },
    ) {
      const limitHeader = {
        [McpInvocationContext.MODE_LIMIT_HEADER]: `${input.limits.runtimeMode}/${input.limits.interactionMode}`,
      };
      const senderHeader =
        input.sender === undefined
          ? {}
          : {
              [McpInvocationContext.SENDER_THREAD_HEADER]: [
                input.sender.environmentId,
                input.sender.threadId,
                // Whole code points, so a cut never leaves half an emoji for encodeURIComponent.
                Array.from(input.sender.title).slice(0, SENDER_TITLE_MAX_LENGTH).join(""),
              ]
                // encodeURIComponent throws on an unpaired surrogate, which a title can hold.
                .map((part) => encodeURIComponent(part.toWellFormed()))
                .join("/"),
            };
      const callOnce = (sessionId: string) =>
        post(
          route,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: input.tool, arguments: input.arguments },
          },
          {
            ...limitHeader,
            ...senderHeader,
            "mcp-session-id": sessionId,
            "mcp-protocol-version": PROTOCOL_VERSION,
          },
        );
      const existing = (yield* Ref.get(sessions)).get(route.key);
      const sessionId = existing ?? (yield* openSession(route, limitHeader));
      // The initialized session outlives a tool request, including a long wait or cancellation.
      if (existing === undefined) {
        yield* Ref.update(sessions, (current) => new Map(current).set(route.key, sessionId));
      }
      let response = yield* callOnce(sessionId);
      if (response.status === 404) {
        const renewed = yield* openSession(route, limitHeader);
        yield* Ref.update(sessions, (current) => new Map(current).set(route.key, renewed));
        response = yield* callOnce(renewed);
      }
      if (response.status === 401) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: route.messages.revoked,
        });
      }
      if (response.status === 403) {
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: route.messages.off,
        });
      }
      if (response.status !== 200) {
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `${route.messages.name} answered HTTP ${response.status}.`,
        });
      }
      yield* recordLinkExpiry(route, response.headers);
      const body = yield* decodeToolCallResponse(
        responseJson(response.headers["content-type"], yield* response.text),
      ).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: `${route.messages.name} answered in an unexpected shape.`,
            }),
        ),
      );
      if (body.error !== undefined) {
        return Result.fail(
          new OrchestratorMcpFailure({ code: "invalid_request", message: body.error.message }),
        );
      }
      if (body.result === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${route.messages.name} returned no result.`,
        });
      }
      return yield* decodeToolResult(
        {
          isError: body.result.isError === true,
          text: body.result.content.map((part) => part.text ?? "").join(""),
        },
        input.success,
        route.messages.name,
      );
    },
    (effect, route) =>
      effect.pipe(
        Effect.tapError((error) => route.recordOutcome(error.message)),
        // A refusal is still an answer: the route works, so only this call fails.
        Effect.tap(() => route.recordOutcome(null)),
        // Recorded above with the transport's own message; the agent hears it plainly.
        Effect.catchTags({
          HttpClientError: () => unreachable(route),
          TimeoutError: () => unreachable(route),
        }),
        Effect.flatMap(Effect.fromResult),
      ),
  );

  const call: PeerMcpClient["Service"]["call"] = Effect.fn("PeerMcpClient.call")(function* (input) {
    if (input.route !== undefined) return yield* callRoute(input.route, input);
    const environmentId = input.environmentId;
    const resolved = yield* links.resolve(environmentId).pipe(
      Effect.mapError(fromLinkError),
      Effect.tapError((error) => links.recordOutcome(environmentId, { error: error.message })),
    );
    return yield* callRoute(
      {
        key: `${environmentId} ${resolved.url}`,
        origin: resolved.url,
        token: resolved.token,
        httpClient,
        messages: peerMessages,
        recordOutcome: (error) => links.recordOutcome(environmentId, { error }),
        link: resolved.link,
      },
      input,
    );
  });

  return PeerMcpClient.of({ call });
});

export const layer = Layer.effect(PeerMcpClient, make);
