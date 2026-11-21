import {
  type ClusterHostRequest,
  type ClusterMember,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { Tool, Toolkit } from "effect/ai";
import { HttpRouter } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import * as ClusterHostRequests from "./ClusterHostRequests.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

const studio = EnvironmentId.make("environment-studio");
const laptop: ClusterMember = {
  environmentId: EnvironmentId.make("environment-laptop"),
  label: "Laptop",
  transport: "https",
  address: "https://laptop.local:3773",
  status: "online",
  joinedAt: DateTime.makeUnsafe(0),
  lastReachedAt: null,
  lastError: null,
};

const ProbeToolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Reports the caller it sees.",
    success: Schema.Struct({ caller: Schema.Unknown }),
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
  Tool.make("hang", {
    description: "Never answers.",
    success: Schema.Struct({}),
  }),
);

/** The main host's real `/mcp` server, whose auth middleware only runs inside HTTP requests. */
const makeServe = Effect.gen(function* () {
  const context = yield* McpHttpServer.layerMcpTransport(
    McpHttpServer.toolkitRegistration(
      ProbeToolkit,
      McpToolAccess.toLayer(ProbeToolkit, {
        probe: McpToolAccess.reads(() =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.map((scope) => ({
              caller: {
                environmentId: scope.environmentId,
                requestNamespace: scope.requestNamespace,
                thread: scope.thread ?? null,
                client: scope.client,
                clustered: scope.clustered,
              },
            })),
          ),
        ),
        hang: McpToolAccess.reads(() => Effect.never),
      }),
    ),
  ).pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Layer.mock(McpSessionRegistry.McpSessionRegistry)({})),
    Layer.provide(HttpRouter.layer),
    Layer.build,
  );
  return yield* ClusterHostRequests.make(studio).pipe(
    Effect.provideContext(context),
    Effect.provide(ServerSettings.layerTest()),
  );
});

const call = (tool: string): ClusterHostRequest => ({
  requestId: "link-request",
  tool,
  arguments: {},
  limits: { runtimeMode: "auto", interactionMode: "plan" },
  sender: {
    environmentId: laptop.environmentId,
    threadId: ThreadId.make("thread:laptop"),
    title: "Fix it",
  },
});

it.effect("a member's call runs on the main host's tools as that member's client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serve = yield* makeServe;
      const answer = yield* serve(laptop, call("probe"));
      expect(answer.isError, answer.text).toBe(false);
      expect(JSON.parse(answer.text).caller).toEqual({
        environmentId: studio,
        requestNamespace: `cluster-member:${laptop.environmentId}`,
        thread: null,
        client: {
          sessionId: `cluster-member:${laptop.environmentId}`,
          label: "Cluster member · Laptop",
          access: "full-access",
          cluster: true,
          clusterMember: laptop.environmentId,
          narrowedTo: { runtimeMode: "auto", interactionMode: "plan" },
          senderThread: {
            environmentId: laptop.environmentId,
            threadId: "thread:laptop",
            title: "Fix it",
          },
        },
        clustered: true,
      });
    }),
  ),
);

it.effect("a member's call that never answers frees its place after five minutes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serve = yield* makeServe;
      const fiber = yield* serve(laptop, call("hang")).pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 minutes");
      const answer = yield* Fiber.join(fiber);
      expect(answer.isError).toBe(true);
      expect(JSON.parse(answer.text)).toMatchObject({ code: "orchestration_error" });
    }),
  ),
);
