import type { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- calls the tools McpHttpServer registered and registers none.
import { McpSchema, McpServer } from "effect/ai";

import * as ClusterService from "../cluster/ClusterService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const PROTOCOL_VERSION = "2025-06-18";

// A member's call asks this main host nothing back while it runs.
const memberClient = McpSchema.McpServerClient.of({
  clientId: 0,
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: {},
  clientInfo: { name: "t3code-cluster-member", version: "1" },
  initializePayload: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "t3code-cluster-member", version: "1" },
  },
  getClient: Effect.die("A cluster member's call asks the main host nothing back."),
});

/**
 * Runs a member agent's call with this main host's own `/mcp` tools, as that member's
 * client: full trust, narrowed to the agent's modes. A tool that names another member
 * goes there through `PeerForwarding`; one that names none runs here.
 */
export const make = Effect.fn("ClusterHostRequests.make")(function* (environmentId: EnvironmentId) {
  const server = yield* McpServer.McpServer;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const ceiling = serverSettings.managedPolicy?.limits?.maxRuntimeMode;
  const serve: ClusterService.ClusterHostServe = (member, request) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((issuedAt) =>
        server.callTool({ name: request.tool, arguments: request.arguments }).pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            McpInvocationContext.withRuntimeModeCeiling(
              {
                environmentId,
                requestNamespace: `cluster-member:${member.environmentId}`,
                thread: undefined,
                client: {
                  sessionId: `cluster-member:${member.environmentId}`,
                  label: `Cluster member · ${member.label}`,
                  access: "full-access",
                  cluster: true,
                  clusterMember: member.environmentId,
                  narrowedTo: request.limits,
                  ...(request.sender === undefined ? {} : { senderThread: request.sender }),
                },
                capabilities: new Set<McpInvocationContext.McpCapability>([
                  "orchestration",
                  "worktree",
                  "pull-requests",
                ]),
                issuedAt,
                linkedEnvironments: false,
                clustered: true,
              },
              ceiling,
            ),
          ),
          Effect.provideService(McpSchema.McpServerClient, memberClient),
        ),
      ),
      Effect.map((result) => ({
        isError: result.isError === true,
        text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      })),
      Effect.catch((error) =>
        Effect.succeed({
          isError: true,
          text: JSON.stringify({
            code: "invalid_request",
            message: `The main host could not run ${request.tool}: ${error.message}`,
          }),
        }),
      ),
      // The member stops waiting then too; a hung call must not keep one of its places.
      Effect.timeoutOrElse({
        duration: ClusterService.HOST_CALL_TIMEOUT,
        orElse: () =>
          Effect.succeed({
            isError: true,
            text: JSON.stringify({
              code: "orchestration_error",
              message: `The main host gave up on ${request.tool} after 5 minutes. Try again.`,
            }),
          }),
      }),
      Effect.withSpan("ClusterHostRequests.serve"),
    );
  return serve;
});
