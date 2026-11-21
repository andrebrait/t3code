import {
  type ClusterError,
  type ClusterStatus,
  type EnvironmentId,
  OrchestratorMcpFailure,
  OrchestratorMcpEnvironmentLinksResult,
  type OrchestratorMcpClusterEnvironment,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  type PeerLinkError,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Tool from "effect/ai/Tool";

import * as ClusterService from "../cluster/ClusterService.ts";
import { runtimeModeRank } from "../mcp/delegatedTaskModes.ts";
import { assertNotLinked } from "../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { readCaller, unavailable } from "../mcp/threadAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

// Match local waits: return before MCP client timeouts and T3 Connect's ~100 s idle drop.
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 45_000;

type Scope = McpInvocationContext.McpInvocationScope;

/**
 * Runs T3 MCP tools in another environment for an agent here, over a peer link or the
 * cluster. The tool's declaration checks the agent here first; the other environment holds
 * the call to the link's access (or full trust in a cluster), narrowed to the agent's modes.
 */
export class PeerForwarding extends Context.Service<
  PeerForwarding,
  {
    /**
     * Runs `tool` in the environment `environmentId` with `params`. A
     * `t3_thread_wait` goes in pieces short enough to survive any route.
     */
    readonly call: <T extends Tool.Any>(
      scope: Scope,
      tool: T,
      environmentId: EnvironmentId,
      params: Tool.Parameters<T>,
    ) => Effect.Effect<Tool.Success<T>, OrchestratorMcpFailure>;
    /** `t3_thread_read` there. */
    readonly readThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    /** `t3_thread_interrupt` there. */
    readonly interruptThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadInterruptInput,
    ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
    /** `t3_thread_wait` there, bounded like a local wait. */
    readonly waitForThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadWaitInput,
    ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
    /** The environments this one reaches, as an agent sees them. */
    readonly links: (
      scope: Scope,
    ) => Effect.Effect<OrchestratorMcpEnvironmentLinksResult, OrchestratorMcpFailure>;
    /** The name of an environment calls can reach from here; none when no route leads there. */
    readonly routeLabel: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<string>, OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerForwarding") {}

/** What an agent hears when it names another machine while the beta is off here. */
export const linkedEnvironmentsOff = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "Linked environments is off on this machine, so no tool can act on another machine. Leave out environmentId to work here; the user can turn it on in Settings → Labs.",
});

const isRuntimeMode = Schema.is(RuntimeMode);

const linkStorageFailure = (error: PeerLinkError) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

/** A removed member is final: a task there fails rather than retries. An unreachable host is not. */
const fromClusterError = (error: ClusterError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "unknown_member" ? "capability_denied" : "orchestration_error",
    message:
      error.reason === "unknown_member"
        ? `${error.message} t3_environment_links lists this cluster's environments.`
        : error.message,
  });

const membershipUnreadable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "This environment's cluster membership could not be read. The server log has details.",
});

const callerItself = new OrchestratorMcpFailure({
  code: "invalid_request",
  message:
    "That environmentId is the calling environment's own. Leave out environmentId to act there.",
});

/** The main host sends calls on without environmentId, so one naming another environment would bounce. */
const clusterLoop = new OrchestratorMcpFailure({
  code: "invalid_request",
  message:
    "This call came from the cluster's main host and names another environment. The main host routes calls between members; send it there without environmentId.",
});

/** The linked environment a call names, or nothing when it names this one. */
export const remoteTarget = (scope: Scope, environmentId: EnvironmentId | undefined) =>
  environmentId === scope.environmentId ? undefined : environmentId;

// Older peers reject beforePosition during parameter validation.
const BEFORE_POSITION_REFUSAL =
  /^Invalid parameters for tool 't3_thread_read': Unknown arguments? (?:"[^"]+", )*"beforePosition"(?:, "[^"]+")*\. Accepted arguments: /;
export const refusesBeforePosition = (failure: {
  readonly code: string;
  readonly message: string;
}) => failure.code === "invalid_request" && BEFORE_POSITION_REFUSAL.test(failure.message);

/** A newest-page read, retried as the peer always served it when the peer refuses the cursor. */
export const readNewestOrRetry = Effect.fn("PeerForwarding.readNewestOrRetry")(function* <A>(
  read: (args: unknown) => Effect.Effect<A, OrchestratorMcpFailure>,
  newest: unknown,
  params: unknown,
) {
  return yield* read(newest).pipe(Effect.catchIf(refusesBeforePosition, () => read(params)));
});

const make = Effect.gen(function* () {
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;
  const crypto = yield* Digest.Digest;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Optional, so environments built without clusters (tests, in-process hosts) route only over links.
  const cluster = Option.getOrUndefined(yield* Effect.serviceOption(ClusterService.ClusterService));

  /** This environment's place in a cluster, or undefined when it is in none. */
  const clusterState: Effect.Effect<ClusterStatus | undefined, OrchestratorMcpFailure> =
    cluster === undefined
      ? Effect.undefined
      : cluster.status.pipe(
          Effect.map((status) => (status.role === "standalone" ? undefined : status)),
          Effect.mapError(fromClusterError),
        );

  /**
   * The caller's own limits and thread, which travel with every forwarded call: the peer sees only the
   * link's credential, so a caller that may not control threads here is refused here. Work a
   * link started never uses this environment's links, since the peer would see this
   * environment's session instead of that link, and its fence could not hold.
   */
  const forwardingCaller = (scope: Scope) =>
    readCaller().pipe(
      Effect.tap((caller) => assertNotLinked(caller, "use this environment's links")),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  /**
   * Every caller here reaches the peer as the one link session, so a retry
   * key is scoped to its caller before it leaves: two agents here reusing a
   * key never collide there, and one agent retrying gets its first result.
   */
  const scopedRequestId = (namespace: string, clientRequestId: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(`${namespace}\n${clientRequestId}`)).pipe(
      Effect.map((digest) => `fwd:${Hex.encode(digest)}`),
      Effect.orDie,
    );

  /**
   * The linked environment refuses a mode above the link's access too, but as
   * "broader than parent mode", which misleads when the parent here is broader.
   * A read-only link refuses the launch there with its own capability error,
   * and an expired one is left to say it expired.
   */
  const assertWithinLinkAccess = Effect.fn("PeerForwarding.assertWithinLinkAccess")(function* (
    environmentId: EnvironmentId,
    requested: unknown,
  ) {
    if (!isRuntimeMode(requested)) return;
    const link = yield* links.get(environmentId).pipe(Effect.mapError(linkStorageFailure));
    if (Option.isNone(link)) return;
    if (DateTime.isLessThanOrEqualTo(link.value.expiresAt, yield* DateTime.now)) return;
    const { label, access } = link.value;
    if (access === "read-only" || runtimeModeRank(requested) <= runtimeModeRank(access)) return;
    return yield* new OrchestratorMcpFailure({
      code: "runtime_mode_escalation_denied",
      message: `Linked environment "${label}" was linked with ${access} access, so work there cannot run in ${requested}. Omit runtimeMode to run it at a mode up to ${access}, or link it again with broader access.`,
    });
  });

  // While the beta is off, agents start nothing over links. Tasks already running there keep
  // following through readThread, waitForThread and interruptThread, so they still finish.
  const requireEnabled = links.enabled.pipe(
    Effect.flatMap((enabled) => (enabled ? Effect.void : Effect.fail(linkedEnvironmentsOff))),
  );

  const memberRoute = (connection: ClusterService.MemberConnection): PeerMcpClient.McpRoute => {
    const name = `Cluster member "${connection.member.label}"`;
    return {
      key: `cluster ${connection.member.environmentId} ${connection.upstream.origin}`,
      origin: connection.upstream.origin,
      token: connection.token,
      httpClient: connection.upstream.httpClient,
      messages: {
        name,
        revoked: `${name} no longer accepts this main host. Remove it in Settings → Cluster and add it again.`,
        off: `${name} refused this call from the main host, for example under a managed policy there. Run the work on another machine.`,
        unreachable: `${name} is not answering. Work there resumes once it is back.`,
      },
      // The member's control link records its status; one call says nothing more.
      recordOutcome: () => Effect.void,
    };
  };

  /**
   * How a call for `environmentId` leaves a clustered environment: straight to a member's /mcp
   * from the main host, or over this member's control link to the main host. Undefined outside a
   * cluster, where it goes over a peer link. Cluster traffic is full trust: no link fence, only
   * the caller's modes.
   */
  const clusterRoute = Effect.fn("PeerForwarding.clusterRoute")(function* (
    scope: Scope,
    environmentId: EnvironmentId,
  ) {
    const state = yield* clusterState;
    if (state === undefined || cluster === undefined) return undefined;
    if (state.role === "main") {
      if (scope.client?.clusterMember === environmentId) return yield* callerItself;
      const connection = yield* cluster
        .connect(environmentId)
        .pipe(Effect.mapError(fromClusterError));
      return { kind: "member", route: memberRoute(connection) } as const;
    }
    if (scope.client?.cluster === true) return yield* clusterLoop;
    const host = state.host;
    if (host === null) return yield* membershipUnreadable;
    return {
      kind: "host",
      label: host.label,
      // The main host runs a call for itself; one for another member it sends on.
      passTarget: environmentId !== host.environmentId,
      send: cluster.hostCall,
    } as const;
  });

  /** Tool and contract schemas are plain data: they encode and decode without services. */
  const forward = Effect.fn("PeerForwarding.forward")(function* <A>(
    scope: Scope,
    toolName: string,
    parameters: Schema.Top,
    success: Schema.Top,
    environmentId: EnvironmentId,
    params: unknown,
    /** Starting work over a link needs the beta on; following it does not. */
    gated: boolean,
  ) {
    const viaCluster = yield* clusterRoute(scope, environmentId);
    if (viaCluster === undefined && gated) yield* requireEnabled;
    const { caller, limits } = yield* forwardingCaller(scope);
    const encoded = (yield* Schema.encodeUnknownEffect(parameters as Schema.Encoder<unknown>)(
      params,
    ).pipe(Effect.mapError(unavailable))) as Record<string, unknown>;
    const { environmentId: _target, ...args } = encoded;
    if (viaCluster === undefined) yield* assertWithinLinkAccess(environmentId, args.runtimeMode);
    // A pending upload lives here, so it cannot go with the call.
    if (Array.isArray(args.attachments) && args.attachments.length > 0) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "A launch in a linked environment cannot carry attachments yet.",
      });
    }
    if (typeof args.clientRequestId === "string") {
      args.clientRequestId = yield* scopedRequestId(scope.requestNamespace, args.clientRequestId);
    }
    // So a message sent there names the thread that sent it, even to a client that cannot reach
    // here; a main host passes on the thread a member named.
    const sender =
      caller !== undefined
        ? { environmentId: scope.environmentId, threadId: caller.id, title: caller.title }
        : viaCluster === undefined
          ? undefined
          : scope.client?.senderThread;
    if (viaCluster?.kind === "host") {
      const answer = yield* viaCluster
        .send({
          tool: toolName,
          arguments: viaCluster.passTarget ? { ...args, environmentId } : args,
          limits,
          ...(sender === undefined ? {} : { sender }),
        })
        .pipe(Effect.mapError(fromClusterError));
      return yield* PeerMcpClient.decodeToolResult(
        answer,
        success as Schema.Decoder<A>,
        `The cluster's main host "${viaCluster.label}"`,
      ).pipe(Effect.flatMap(Effect.fromResult));
    }
    return yield* peers.call({
      environmentId,
      ...(viaCluster === undefined ? {} : { route: viaCluster.route }),
      tool: toolName,
      arguments: args,
      limits,
      ...(sender === undefined ? {} : { sender }),
      success: success as Schema.Decoder<A>,
    });
  });

  const readThread: PeerForwarding["Service"]["readThread"] = (scope, environmentId, input) =>
    forward<OrchestratorMcpThreadReadResult>(
      scope,
      "t3_thread_read",
      OrchestratorMcpThreadReadInput,
      OrchestratorMcpThreadReadResult,
      environmentId,
      input,
      false,
    );

  const interruptThread: PeerForwarding["Service"]["interruptThread"] = (
    scope,
    environmentId,
    input,
  ) =>
    forward<OrchestratorMcpThreadInterruptResult>(
      scope,
      "t3_thread_interrupt",
      OrchestratorMcpThreadInterruptInput,
      OrchestratorMcpThreadInterruptResult,
      environmentId,
      input,
      false,
    );

  const waitThere = (
    scope: Scope,
    environmentId: EnvironmentId,
    input: OrchestratorMcpThreadWaitInput,
    gated: boolean,
  ) =>
    forward<OrchestratorMcpThreadWaitResult>(
      scope,
      "t3_thread_wait",
      OrchestratorMcpThreadWaitInput,
      OrchestratorMcpThreadWaitResult,
      environmentId,
      {
        ...input,
        timeoutMs: Math.min(
          MAX_WAIT_TIMEOUT_MS,
          Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
        ),
      },
      gated,
    );

  const waitForThread: PeerForwarding["Service"]["waitForThread"] = (scope, environmentId, input) =>
    waitThere(scope, environmentId, input, false);

  // A peer pages a client's cursorless read forward; an agent's gets the newest page, as it does here.
  const newestPageForAgent = (scope: Scope, toolName: string, params: unknown) => {
    if (toolName !== "t3_thread_read" || scope.thread === undefined) return undefined;
    const input = params as OrchestratorMcpThreadReadInput;
    return input.afterPosition === undefined && input.beforePosition === undefined
      ? { ...input, beforePosition: Number.MAX_SAFE_INTEGER }
      : undefined;
  };

  const call: PeerForwarding["Service"]["call"] = (scope, tool, environmentId, params) => {
    const forwardTool = (
      args: unknown,
    ): Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure> =>
      forward(
        scope,
        tool.name,
        tool.parametersSchema,
        tool.successSchema,
        environmentId,
        args,
        true,
      );
    if (tool.name === "t3_thread_wait") {
      return waitThere(
        scope,
        environmentId,
        params as OrchestratorMcpThreadWaitInput,
        true,
      ) as Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure>;
    }
    const newest = newestPageForAgent(scope, tool.name, params);
    return newest === undefined
      ? forwardTool(params)
      : readNewestOrRetry(forwardTool, newest, params);
  };

  const routeLabel: PeerForwarding["Service"]["routeLabel"] = Effect.fn(
    "PeerForwarding.routeLabel",
  )(function* (environmentId) {
    const state = yield* clusterState;
    if (state !== undefined && cluster !== undefined) {
      if (state.role === "member") {
        // Every environment is reached through the main host; only its name is known here.
        const host = state.host;
        return Option.some(
          host !== null && host.environmentId === environmentId ? host.label : environmentId,
        );
      }
      const members = Option.getOrElse(yield* Stream.runHead(cluster.members), () => []);
      return Option.map(
        Option.fromNullishOr(members.find((member) => member.environmentId === environmentId)),
        (member) => member.label,
      );
    }
    const link = yield* links.get(environmentId).pipe(Effect.mapError(linkStorageFailure));
    return Option.map(link, (found) => found.label);
  });

  /**
   * The next step for an agent whose machine is not linked: without it, an
   * empty list reads as a dead end and agents go looking elsewhere.
   */
  const NOT_LISTED =
    "Not listed: not linked yet. Call t3_environment_link with a hint from the user's words.";

  const NOT_IN_CLUSTER =
    "Not listed: this environment is in a cluster, which takes no links. The user adds machines on the main host, in Settings → Cluster.";

  /** The rest of the cluster as agents here see it; a member asks its main host for the members. */
  const clusterEnvironments = Effect.fn("PeerForwarding.clusterEnvironments")(function* (
    scope: Scope,
    state: ClusterStatus,
    limits: PeerMcpClient.PeerCallLimits,
    service: ClusterService.ClusterService["Service"],
  ) {
    if (state.role === "main") {
      const members = Option.getOrElse(yield* Stream.runHead(service.members), () => []);
      return members.map((member): OrchestratorMcpClusterEnvironment => ({
        environmentId: member.environmentId,
        label: member.label,
        role: "member",
        status: member.status,
        lastError: member.lastError,
      }));
    }
    if (scope.client?.cluster === true) return yield* clusterLoop;
    const host = state.host;
    if (host === null) return [];
    const reached = yield* service
      .hostCall({ tool: "t3_environment_links", arguments: {}, limits })
      .pipe(
        Effect.mapError(fromClusterError),
        Effect.flatMap((answer) =>
          PeerMcpClient.decodeToolResult(
            answer,
            OrchestratorMcpEnvironmentLinksResult,
            `The cluster's main host "${host.label}"`,
          ),
        ),
        Effect.flatMap(Effect.fromResult),
        Effect.match({
          onFailure: (failure) => ({
            status: "offline" as const,
            lastError: failure.message as string | null,
            others: [] as ReadonlyArray<OrchestratorMcpClusterEnvironment>,
          }),
          onSuccess: (result) => ({
            status: "online" as const,
            lastError: null as string | null,
            others: result.cluster ?? [],
          }),
        }),
      );
    return [
      {
        environmentId: host.environmentId,
        label: host.label,
        role: "main-host" as const,
        status: reached.status,
        lastError: reached.lastError,
      },
      ...reached.others.filter((other) => other.environmentId !== scope.environmentId),
    ];
  });

  const listLinks: PeerForwarding["Service"]["links"] = Effect.fn("PeerForwarding.listLinks")(
    function* (scope) {
      const { limits } = yield* forwardingCaller(scope);
      const state = yield* clusterState;
      if (state !== undefined && cluster !== undefined) {
        return {
          environmentId: scope.environmentId,
          links: [],
          cluster: yield* clusterEnvironments(scope, state, limits, cluster),
          notListed: NOT_IN_CLUSTER,
        };
      }
      yield* requireEnabled;
      const listed = yield* links.list.pipe(Effect.mapError(linkStorageFailure));
      return {
        environmentId: scope.environmentId,
        links: listed.map((link) => ({
          environmentId: link.environmentId,
          label: link.label,
          status: link.status,
          access: link.access,
          expiresAt: DateTime.formatIso(link.expiresAt),
          lastError: link.lastError,
        })),
        notListed: NOT_LISTED,
      };
    },
  );

  return PeerForwarding.of({
    call,
    readThread,
    interruptThread,
    waitForThread,
    links: listLinks,
    routeLabel,
  });
});

export const layer = Layer.effect(PeerForwarding, make);
