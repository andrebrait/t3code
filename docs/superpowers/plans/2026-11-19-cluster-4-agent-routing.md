# Cluster 4: Agent Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents on any environment in a cluster can act on any other through the main host. On the main host, a tool call that names a member goes to that member's `/mcp`. On a member, a tool call that names another environment rides the member's control link to the main host, which runs it and answers. Remote `delegate_task` works the same way, including after a restart. Cluster calls are full trust: no link fence applies to them.

**Architecture:** There is one seam: `PeerForwarding`. Before a forwarded call leaves, `PeerForwarding.clusterRoute` asks `ClusterService` where this environment sits. On a standalone environment the call goes over a peer link, as it does today. On a main host the call goes to the member's `/mcp`, using `ClusterService.connect(memberId)` and its `cluster-host` token; `PeerMcpClient.call` gains an optional `route` for that, so cluster calls reuse its session handling, `T3-Mode-Limit`, `T3-Sender-Thread` and 404 renewal. On a member the call keeps its `environmentId` (unless it names the main host) and goes to `ClusterService.hostCall`, which Plan 2 puts on the member's `cluster.hostChannel`. The main host's link fiber hands it to `ClusterHostRequests.make`'s `serve`, which runs it with the main host's own `/mcp` tools as that member's client (`cluster: true`, `clusterMember`, the agent's modes and sender). A tool that names another member forwards there through the same `PeerForwarding`; one that names none runs on the main host. Its result goes back with `cluster.hostReply`, and the member reads it with the same `PeerMcpClient.decodeToolResult` that reads `/mcp` answers. `RemoteDelegation` and the MCP toolkits need no routing changes: they already go through `PeerForwarding`. No member-to-main credential or address exists.

**Tech Stack:** Effect 4 services (`Context.Service`, `Effect.fn`), `effect/http` client, `effect/ai` MCP server and toolkits, `@effect/vitest` (`it.effect`, `TestClock`), the evals in `evals/mcp-tool-use`.

**Spec:** `docs/superpowers/specs/2026-11-19-environment-cluster-design.md` ("Control link", "Agents"). This plan builds on `docs/superpowers/plans/2026-11-19-cluster-2-server-core.md` and uses the names that plan produces for Plan 4.

## Global Constraints

Copied word for word from the spec. Every task follows them.

- "On the main host, MCP tools with an `environmentId` target forward to the member's `/mcp` using the `cluster-host` credential."
- "A member agent targeting another environment puts the call on `cluster.hostChannel`; the main host runs it (forwarding to the target member) and replies. All cross-member traffic hairpins through the main host. No separate member-to-main credential exists."
- "Requests queued while the link is down fail with "cluster host unreachable" and are never delivered twice."
- "Members never need an address for the main host. Calls from a member to the main host ride the link in reverse: the member exposes a `cluster.hostChannel` subscription carrying requests, and the main host answers each with `cluster.hostReply(requestId, result)`."
- "The existing forwarded-wait limits (≤ 50 s) apply."
- "**Members fully trust the main host.**"
- "**Cluster is separate from peer links.** Any clustered environment (main host or member) takes no part in peer links in either direction."
- "**Dial-in only.** The main host always initiates."
- "main host down | clients lose all members; member agents get "cluster host unreachable" on cross-member tools; local work continues"
- "New auth subject: `cluster-host` (member side)."
- "Labs setting `clusterEnabled`, default false, gating both sides."
- Repo rules (AGENTS.md):
  - Reusable functions use `Effect.fn("Service.op")`.
  - Transports only decode, call one service method and map errors.
  - Tests go at the lowest layer that fails on `main` and extend existing files.
  - Use `it.effect` with `TestClock`. Use real sockets only through the existing `servePeer` and `NodeHttpServer.layerTest` fixtures.
  - No sleeps, polling, per-test timeouts or retries.
  - Keep comments to a minimum.
  - Run `vp test run <files>` and `vp run typecheck`. Never run `vp check` or repo-wide test runs.
  - A change to an MCP tool description or schema runs the evals named in `evals/README.md`.

## Interfaces With Other Plans

**Consumed from Plan 2.** These names are used exactly as given:

- `EnvironmentAuth.CLUSTER_HOST_SUBJECT` (`"cluster-host"`), `EnvironmentAuth.consumeClusterInvite`, and `McpClientSession.cluster` (`true` for a `cluster-host` session on `/mcp`).
- `AuthPairingLinks.CLUSTER_MEMBER_PAIRING_SUBJECT` (the pairing-code kind for invites).
- `CLUSTER_SCOPES_HEADER`. Plan 4 never sends it, because `/mcp` caps by `T3-Mode-Limit`.
- `ClusterService.connect(memberId): Effect<MemberConnection, ClusterError>` with `MemberConnection = { upstream: ClusterUpstream.Upstream; token: string; member: ClusterMember }` and `Upstream = { origin; httpClient; webSocket }`.
- `ClusterService.status`, `members`, `addMember`, `removeMember`.
- The control link (Plan 2 Task 8): `ClusterService.hostCall(call: ClusterHostCall): Effect<ClusterHostResult, ClusterError>`, `ClusterService.start(serve: ClusterHostServe)`, types `ClusterHostCall` and `ClusterHostServe`, `clusterHostUnreachable(hostLabel)`, `refuseHostRequests` (which `server.ts` passes to `start` until this plan), and contracts `ClusterHostRequest`, `ClusterHostResult`.
- `server.ts` builds `ClusterService` inside the `PeerForwarding` provide, so `PeerForwarding` reads it with `Effect.serviceOption`.
- Testkit: `ClusterService.testkit.ts` (`clusterDescriptor`, `FINGERPRINT`, `makeEnvironment`, `serveMember`, `layerClusterEnvironment`, `awaitStatus`).
- The `clustered` effect that Plan 2 Task 4 adds inside `McpHttpServer.makeMcpAuthMiddleware`.

**Produced here:**

- `McpClientCaller.cluster` and `McpClientCaller.clusterMember`; `McpInvocationScope.clustered`.
- `PeerMcpClient.McpRoute`, the optional `PeerMcpClient.call({ route })`, and `PeerMcpClient.decodeToolResult`.
- `ClusterHostRequests.make(environmentId): Effect<ClusterHostServe, never, McpServer | ServerSettingsService>` (`apps/server/src/mcp/ClusterHostRequests.ts`).
- `PeerForwarding.routeLabel(environmentId)`.
- `OrchestratorMcpClusterEnvironment` and `OrchestratorMcpEnvironmentLinksResult.cluster?`.
- `McpInvocationContext.hiddenWithoutOtherEnvironments`.
- Testkit helpers: `RoutedEnvironment`, `layerRoutingMain`, `layerRoutingMember` and `clusterHostToken`.

## Review Focus

These are the failure modes most likely to cause trouble without a test. Each one has a test in the task that owns it:

1. **A member's call loops back through the main host.** A call that the main host sends on to a member never carries `environmentId`, so it cannot bounce by construction. A buggy or hostile caller could still name an environment on a call that arrived over the cluster. The main host refuses a member's call that names that member itself. A member refuses any call from its main host that names another environment. Test: Task 2, "a member reaches another member through the main host, which never loops".
2. **A member is removed while a delegated task runs there.** `connect` then fails with `unknown_member`, which maps to `capability_denied`. `RemoteDelegation.isFinal` treats that as final, so the task fails and says why instead of retrying forever. Tests: Task 2, "an agent on a cluster's main host works on a member's threads without links, unfenced" (the final step), and Task 3, "a task delegated to a removed cluster member fails and says why".
3. **The main host restarts, or the link drops, during a forwarded wait.** The member's `hostCall` fails at once with "cluster host unreachable" (Plan 2 Task 8 pins the link side). That maps to `orchestration_error`, which is not final, so a follower retries until the link is back. Test: Task 2, "a member whose main host is down hears that the cluster host is unreachable".
4. **Idempotency keys across the hairpin.** Each hop hashes `clientRequestId` with its caller's namespace: the member with its agent's, the main host with `cluster-member:<memberId>`. A retry from one agent reaches the target member with the same key. The same key from another agent, or from another member, does not. Test: Task 2, "a member reaches another member through the main host, which never loops".
5. **A call that ran although its member heard "unreachable".** The link can drop after the main host forwarded a send but before the reply. The member's agent retries with the same `clientRequestId`, and the target runs it once. Plan 2 Task 8 pins that the link never resends; this plan's idempotency test (item 4) pins that the retry lands on the same key.
6. **A member's call that names the main host.** It must run on the main host itself, as that member's full-trust client narrowed to the agent's modes, and not go anywhere else. Test: Task 4, "a member reaches another member through the main host, which never loops" (the member's `t3_environment_links` runs on the main host, which lists the cluster for it).

## File Map

Create:

- `apps/server/src/mcp/ClusterHostRequests.ts`

Modify:

- `packages/contracts/src/orchestratorMcp.ts`
- `apps/server/src/auth/McpOAuth.ts`
- `apps/server/src/mcp/{McpInvocationContext,McpHttpServer,McpToolAccess}.ts`
- `apps/server/src/mcp/toolkits/orchestrator/tools.ts`
- `apps/server/src/peer/{PeerMcpClient,PeerMcpClient.test,PeerForwarding,PeerForwarding.test,RemoteDelegation,RemoteDelegation.test}.ts`
- `apps/server/src/cluster/ClusterService.testkit.ts`
- `apps/server/src/server.ts`
- `evals/mcp-tool-use/cases/orchestration.ndjson`
- `docs/internals/environment-auth.md`

---

## Task 1: `PeerMcpClient` calls a given route

**Files:**

- Modify: `apps/server/src/peer/PeerMcpClient.ts`:
  - interface (`:28-53`)
  - failure constants (`:86-96`)
  - `make` (`:108-300`)
- Test: `apps/server/src/peer/PeerMcpClient.test.ts`. Add one test after "bounds the session handshake, not a tool call that waits longer" (`:345-385`).

**Interfaces:**

- Consumes: `PeerLinks.resolve`, `PeerLinks.recordOutcome`, `PeerLinks.probeTimeout` and `PeerLinks.ResolvedPeerLink`.
- Produces:

```ts
export interface McpRoute {
  readonly key: string;
  readonly origin: string;
  readonly token: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly messages: {
    readonly name: string;
    readonly revoked: string;
    readonly off: string;
    readonly unreachable: string;
  };
  readonly recordOutcome: (error: string | null) => Effect.Effect<void>;
}
```

`PeerMcpClient.call` accepts `route?: McpRoute`. Without a route it resolves the peer link to `environmentId`, as it does today. Every peer-link message stays exactly as it is now. The main host uses a route to reach a member's `/mcp`.

```ts
export const decodeToolResult: <S extends Schema.Decoder<unknown>>(
  answer: { readonly isError: boolean; readonly text: string },
  success: S,
  name: string,
) => Effect.Effect<Result.Result<S["Type"], OrchestratorMcpFailure>, OrchestratorMcpFailure>;
```

It reads a tool's answer the same way for `/mcp` and for Plan 2's `ClusterHostResult`, which a member gets back over its control link: a refusal is `Result.fail` with the other side's own code, and an answer this version cannot read fails.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/peer/PeerMcpClient.test.ts`:

```ts
it.effect(
  "calls a cluster member's route with its own client and token, renews it after the member restarts, and names it when it is down",
  () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly target: string; readonly session: string | undefined }> = [];
      const outcomes: Array<string | null> = [];
      const arrived = yield* Queue.unbounded<void>();
      const down = yield* Ref.make(false);
      // The member restarts after the first call: it forgets the session and answers 404 once.
      const statuses = [200, 202, 200, 404, 200, 202, 200];
      const routeHttp = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Queue.offer(arrived, undefined);
          if (yield* Ref.get(down)) return yield* Effect.never;
          const index = seen.length;
          seen.push({
            target: `${request.url} ${request.headers.authorization}`,
            session: request.headers["mcp-session-id"],
          });
          return HttpClientResponse.fromWeb(
            request,
            new Response(index === 2 || index === 6 ? probeResult : "", {
              status: statuses[index] ?? 500,
              headers:
                index === 0
                  ? { "mcp-session-id": "before-restart" }
                  : index === 4
                    ? { "mcp-session-id": "after-restart" }
                    : {},
            }),
          );
        }),
      );
      const route: PeerMcpClient.McpRoute = {
        key: "cluster environment-box https://box.example",
        origin: "https://box.example",
        token: "cluster-host-token",
        httpClient: routeHttp,
        messages: {
          name: 'Cluster member "Box"',
          revoked: "Box no longer accepts this main host.",
          off: "Box has clusters turned off.",
          unreachable: 'Cluster member "Box" is not answering.',
        },
        recordOutcome: (error) => Effect.sync(() => outcomes.push(error)),
      };
      const context = yield* Layer.build(
        PeerMcpClient.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              // A routed call never touches peer links or the default client.
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("the default client was used")),
              ),
              Layer.mock(PeerLinks.PeerLinks)({}),
            ),
          ),
        ),
      );
      const client = Context.get(context, PeerMcpClient.PeerMcpClient);
      const probe = (via: PeerMcpClient.McpRoute) =>
        client.call({
          environmentId: EnvironmentId.make("environment-box"),
          route: via,
          tool: "probe",
          arguments: {},
          limits: { runtimeMode: "approval-required", interactionMode: "plan" },
          success: Result,
        });

      expect(yield* probe(route)).toEqual({ modes: "approval-required/plan" });
      expect(yield* probe(route)).toEqual({ modes: "approval-required/plan" });
      expect(seen.map(({ session }) => session)).toEqual([
        undefined,
        "before-restart",
        "before-restart",
        "before-restart",
        undefined,
        "after-restart",
        "after-restart",
      ]);
      expect(new Set(seen.map(({ target }) => target))).toEqual(
        new Set(["https://box.example/mcp Bearer cluster-host-token"]),
      );
      expect(outcomes).toEqual([null, null]);

      // Down: a new session's handshake never answers, so the agent hears the route's own words.
      yield* Ref.set(down, true);
      yield* Queue.takeAll(arrived);
      const stalled = yield* probe({ ...route, key: "after-outage" }).pipe(
        Effect.flip,
        Effect.forkScoped,
      );
      yield* Queue.take(arrived);
      yield* TestClock.adjust(Duration.seconds(10));
      expect(yield* Fiber.join(stalled)).toMatchObject({
        code: "orchestration_error",
        message: route.messages.unreachable,
      });
      expect(outcomes).toHaveLength(3);
      expect(outcomes[2]).not.toBeNull();
    }),
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run apps/server/src/peer/PeerMcpClient.test.ts -t "calls a cluster member's route"`

Expected: FAIL. The call ignores `route`, so the empty `PeerLinks` mock dies on `resolve`. Typecheck also reports that `route` is not in the call input.

- [ ] **Step 3: Implement**

`apps/server/src/peer/PeerMcpClient.ts`. Above `PeerMcpClient`, add:

```ts
/** Where a call goes and what the agent hears when it fails there. */
export interface McpRoute {
  /** Calls with one key share one MCP session. */
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
}
```

In the `call` input, after `environmentId`, add:

```ts
      /** Where to send it; without one, over the peer link to `environmentId`. */
      readonly route?: McpRoute;
```

Replace `linkedEnvironmentsOffThere` and `stoppedAnswering` with:

```ts
/** A peer link's words; `off` is not final, so a task there resumes once the beta is on again. */
const peerMessages: McpRoute["messages"] = {
  name: "The linked environment",
  revoked:
    "The linked environment no longer accepts this link. It may have been revoked there; link it again.",
  off: "The linked environment has Linked environments turned off. Turn it on in its Settings → Labs.",
  unreachable: "The linked environment stopped answering.",
};
```

Below `responseJson`, add:

```ts
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
    Effect.map((decoded): Result.Result<S["Type"], OrchestratorMcpFailure> => Result.succeed(decoded)),
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `${name}'s answer did not match this version. Update both environments.`,
        }),
    ),
  );
};
```

Replace `make` with:

```ts
type CallInput<S extends Schema.Decoder<unknown>> = Parameters<
  PeerMcpClient["Service"]["call"]
>[0] & { readonly success: S };

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

  const callRoute = <S extends Schema.Decoder<unknown>>(route: McpRoute, input: CallInput<S>) =>
    Effect.gen(function* () {
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
    }).pipe(
      Effect.tapError((error) => route.recordOutcome(error.message)),
      // A refusal is still an answer: the route works, so only this call fails.
      Effect.tap(() => route.recordOutcome(null)),
      // Recorded above with the transport's own message; the agent hears it plainly.
      Effect.catchTags({
        HttpClientError: () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: route.messages.unreachable,
            }),
          ),
        TimeoutError: () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: route.messages.unreachable,
            }),
          ),
      }),
      Effect.flatMap(Effect.fromResult),
    );

  const peerRoute = (
    environmentId: EnvironmentId,
    resolved: PeerLinks.ResolvedPeerLink,
  ): McpRoute => ({
    key: `${environmentId} ${resolved.url}`,
    origin: resolved.url,
    token: resolved.token,
    httpClient,
    messages: peerMessages,
    recordOutcome: (error) => links.recordOutcome(environmentId, { error }),
  });

  const call: PeerMcpClient["Service"]["call"] = Effect.fn("PeerMcpClient.call")(
    function* (input) {
      if (input.route !== undefined) return yield* callRoute(input.route, input);
      const resolved = yield* links.resolve(input.environmentId).pipe(
        Effect.mapError(fromLinkError),
        Effect.tapError((error) => links.recordOutcome(input.environmentId, { error: error.message })),
      );
      return yield* callRoute(peerRoute(input.environmentId, resolved), input);
    },
  );

  return PeerMcpClient.of({ call });
});
```

The old peer message `"The linked environment's answer did not match this version. Update both environments."` comes out identical when `name` is `"The linked environment"`. So do every other peer string.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/peer/PeerMcpClient.test.ts apps/server/src/peer/PeerLinks.test.ts apps/server/src/peer/PeerForwarding.test.ts`

Expected: PASS. The peer tests and their messages are unchanged.

Run: `vp run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/peer/PeerMcpClient.ts apps/server/src/peer/PeerMcpClient.test.ts
git commit -m "refactor(server): peer MCP client calls a given route

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: `PeerForwarding` routes cluster targets (one seam)

**Files:**

- Create: `apps/server/src/mcp/ClusterHostRequests.ts`
- Modify: `apps/server/src/peer/PeerForwarding.ts` (whole file, given below)
- Modify: `apps/server/src/mcp/McpInvocationContext.ts`:
  - `McpClientCaller` (`:36-54`)
  - `McpInvocationScope` (`:136-150`)
- Modify: `apps/server/src/auth/McpOAuth.ts:625-631` (client caller)
- Modify: `apps/server/src/mcp/McpHttpServer.ts`:
  - `withSenderThread` (`:236-260`)
  - the admitted scope (`:313`)
- Modify: `apps/server/src/mcp/McpToolAccess.ts:451`
- Modify: `apps/server/src/cluster/ClusterService.testkit.ts` (routing helpers)
- Modify: `apps/server/src/server.ts` (the `McpHttpServer.layer` entry of `layerMakeRoutes` and Plan 2's `cluster.start` call)
- Test: `apps/server/src/peer/PeerForwarding.test.ts`:
  - `makeLaptop` (`:275-372`)
  - new tests after "refuses a launch there above the link's access, naming the link"

**Interfaces:**

- Consumes:
  - `ClusterService.status`, `connect`, `members` and `hostCall`; types `MemberConnection`, `ClusterHostServe`, `ClusterHostCall`; `clusterHostUnreachable` (Plan 2).
  - `McpClientSession.cluster` (Plan 2 Task 3) and the `clustered` effect in `makeMcpAuthMiddleware` (Plan 2 Task 4).
  - `PeerMcpClient.McpRoute` and `decodeToolResult` (Task 1).
  - `McpServer.McpServer.callTool`, `McpInvocationContext.withRuntimeModeCeiling`.
- Produces:
  - `McpClientCaller.cluster?: boolean` (a cluster caller: the main host on a member, or a member's agent on the main host) and `McpClientCaller.clusterMember?: EnvironmentId` (on the main host, the member the call came from); `McpInvocationScope.clustered?: boolean`. `/mcp` reads `T3-Sender-Thread` from cluster callers as well as linked ones.
  - `ClusterHostRequests.make(environmentId)`: the main host's `ClusterHostServe`. It runs `request.tool` with `request.arguments` through the main host's own `McpServer`, as a client scope with `cluster: true`, `clusterMember: member.environmentId`, `narrowedTo: request.limits`, `senderThread: request.sender`, `requestNamespace: cluster-member:<memberId>`, `clustered: true`, under the managed runtime ceiling. A failure to run the tool answers `isError` with an `invalid_request` failure.
  - `PeerForwarding["Service"]["routeLabel"]: (environmentId) => Effect<Option<string>, OrchestratorMcpFailure>`.
  - Routing rules:
    - **Standalone:** peer links, as today. The Linked environments beta is checked here and in `McpToolAccess`.
    - **Main host:** the target must be a member, reached at its `/mcp` with its `cluster-host` token. `unknown_member` maps to `capability_denied`, with a pointer to `t3_environment_links`. A call from a member that names that member is refused.
    - **Member:** every other environment goes through `ClusterService.hostCall`, and the call keeps `environmentId` unless the target is the main host itself. A call that arrived from the main host (`client.cluster`) and names another environment is refused. While the link is down the agent hears "cluster host unreachable", which is not final.
    - Cluster calls skip the link-access check and the beta. `clusterEnabled` still gates the main side inside `ClusterService.connect`.
    - A thread caller sends its own thread as the sender. A cluster client caller passes on the sender it was given.
  - Testkit: `RoutedEnvironment`, `layerRoutingMain(members)`, `layerRoutingMember({ host, hostCall })`, `clusterHostToken(auth, hostLabel)`.

- [ ] **Step 1: Write the testkit helpers and the failing tests**

`apps/server/src/cluster/ClusterService.testkit.ts`. Add to the `@t3tools/contracts` import `ClusterError` and `type ClusterMember` (`EnvironmentId`, `ClusterMemberStatus`, `Option` and `Stream` are already imported by Plan 2 Task 8), and add:

```ts
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import { CLUSTER_MEMBER_PAIRING_SUBJECT } from "../persistence/AuthPairingLinks.ts";
```

Append:

```ts
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
    Effect.map(
      (httpClient): ClusterUpstream.Upstream => ({
        origin: new URL(url).origin,
        httpClient,
        webSocket: () => {
          throw new Error("Agent routing opens no WebSockets.");
        },
      }),
    ),
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
                Effect.map((upstream) => ({ upstream, token: member.token, member: asMember(member) })),
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
      auth.consumeClusterInvite(invite.credential, { hostLabel, client: {} }),
    ),
    Effect.map((session) => session.token),
  );
```

`apps/server/src/peer/PeerForwarding.test.ts`. Add these imports:

```ts
import { type ClusterMember } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as ClusterService from "../cluster/ClusterService.ts";
import {
  clusterHostToken,
  layerRoutingMain,
  layerRoutingMember,
  type RoutedEnvironment,
} from "../cluster/ClusterService.testkit.ts";
import * as ClusterHostRequests from "../mcp/ClusterHostRequests.ts";
```

Below `const box = …`:

```ts
const studio = descriptorOf("environment-studio", "Studio");

/** The laptop as its main host lists it. */
const laptopMember: ClusterMember = {
  environmentId: laptop.environmentId,
  label: "Laptop",
  transport: "https",
  address: "https://laptop.local:3773",
  status: "online",
  joinedAt: DateTime.makeUnsafe(0),
  lastReachedAt: null,
  lastError: null,
};
```

Change `makeLaptop`:

- `const makeLaptop = Effect.gen(function* () {` becomes:

```ts
const makeLaptopWith = (
  cluster: Layer.Layer<ClusterService.ClusterService> = Layer.empty,
  descriptor = laptop,
) =>
  Effect.gen(function* () {
```

- `layerLinkingEnvironment(laptop)` becomes `layerLinkingEnvironment(descriptor)`, and `environmentId: laptop.environmentId,` in `scopeOf` becomes `environmentId: descriptor.environmentId,`.
- `Layer.provide(PeerForwarding.layer),` becomes `Layer.provideMerge(PeerForwarding.layer.pipe(Layer.provide(cluster))),`.
- Replace `const call = (…) => server.callTool(…)…;` and the `return` with:

```ts
  const callAs = (
    scope: McpInvocationContext.McpInvocationScope,
    name: string,
    args: Record<string, unknown>,
  ) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  const call = (
    caller: string,
    name: string,
    args: Record<string, unknown>,
    capabilities?: ReadonlySet<McpInvocationContext.McpCapability>,
  ) => callAs(scopeOf(caller, capabilities), name, args);
  const settings = Context.get(linking, ServerSettings.ServerSettingsService);
  return {
    links: Context.get(linking, PeerLinks.PeerLinks),
    settings,
    forwarding: Context.get(here, PeerForwarding.PeerForwarding),
    /** What this environment runs for a member's agent, as a main host's control link does. */
    serveHost: yield* ClusterHostRequests.make(descriptor.environmentId).pipe(
      Effect.provideService(McpServer.McpServer, server),
      Effect.provideService(ServerSettings.ServerSettingsService, settings),
    ),
    scopeOf,
    call,
    callAs,
  };
  });

const makeLaptop = makeLaptopWith();
```

Append these tests:

```ts
it.effect("an agent on a cluster's main host works on a member's threads without links, unfenced", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(seen, yield* Ref.make(""));
      const members = yield* Ref.make<ReadonlyArray<RoutedEnvironment>>([
        { descriptor: box, url: b.url, token: yield* clusterHostToken(b.auth, "Laptop") },
      ]);
      const a = yield* makeLaptopWith(layerRoutingMain(members));
      // A cluster needs neither a link nor the Linked environments beta.
      yield* a.settings.updateSettings({ linkedEnvironmentsEnabled: false });
      const asClustered = (caller: string) => ({
        ...a.scopeOf(caller),
        linkedEnvironments: false,
        clustered: true,
      });

      // The box user's own thread: a link below full access could not touch it, the cluster can.
      const sent = yield* a.callAs(asClustered("thread:laptop-full"), "t3_thread_send", {
        environmentId: box.environmentId,
        threadId: usersThread,
        message: "Carry on there.",
        clientRequestId: "send-1",
      });
      expect(sent.isError, JSON.stringify(sent.content)).toBe(false);
      expect((yield* Ref.get(seen)).sends[0]).toMatchObject({
        threadId: usersThread,
        linkedSender: { environmentId: laptop.environmentId, threadId: "thread:laptop-full" },
      });
      const [member] = yield* Ref.get(members);
      expect(yield* Ref.get(b.bearers)).toContain(`Bearer ${member!.token}`);

      const waited = yield* a.callAs(asClustered("thread:laptop-full"), "t3_thread_wait", {
        environmentId: box.environmentId,
        threadId: boxThread,
        timeoutMs: 600_000,
      });
      expect(waited.isError).toBe(false);
      expect((yield* Ref.get(seen)).waits.map(({ timeoutMs }) => timeoutMs)).toEqual([45_000]);

      // The caller's own modes still travel with the call.
      const planned = yield* a.callAs(asClustered("thread:laptop-plan"), "t3_thread_send", {
        environmentId: box.environmentId,
        threadId: boxThread,
        message: "Change course.",
      });
      expect(failureOf(planned)).toMatchObject({ code: "interaction_mode_escalation_denied" });

      // The same box over an `auto` peer link is fenced away from the user's own thread.
      const linked = yield* makeLaptop;
      yield* linkTo(linked.links, b, "auto");
      const fenced = yield* linked.call("thread:laptop-full", "t3_thread_send", {
        environmentId: box.environmentId,
        threadId: usersThread,
        message: "Carry on there.",
      });
      expect(failureOf(fenced)).toMatchObject({ code: "capability_denied" });

      // Removed from the cluster: final, so a task there fails instead of retrying.
      expect(yield* a.forwarding.routeLabel(box.environmentId)).toEqual(Option.some("Box"));
      yield* Ref.set(members, []);
      const removed = yield* a.callAs(asClustered("thread:laptop-full"), "t3_thread_read", {
        environmentId: box.environmentId,
        threadId: boxThread,
      });
      expect(failureOf(removed)).toMatchObject({
        code: "capability_denied",
        message:
          "environment-box is not a member of this cluster. t3_environment_links lists this cluster's environments.",
      });
      expect(yield* a.forwarding.routeLabel(box.environmentId)).toEqual(Option.none());
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a member reaches another member through the main host, which never loops", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(seen, yield* Ref.make(""));
      const members = yield* Ref.make<ReadonlyArray<RoutedEnvironment>>([
        { descriptor: box, url: b.url, token: yield* clusterHostToken(b.auth, "Studio") },
      ]);
      const main = yield* makeLaptopWith(layerRoutingMain(members), studio);
      // The control link without its socket: Plan 2 Task 8 carries the same call and answer.
      const hostCall = (call: ClusterService.ClusterHostCall) =>
        main.serveHost(laptopMember, { requestId: "link-request", ...call });
      const a = yield* makeLaptopWith(layerRoutingMember({ host: studio, hostCall }));

      const send = (caller: string, clientRequestId: string) =>
        a.call(caller, "t3_thread_send", {
          environmentId: box.environmentId,
          threadId: boxThread,
          message: "Once.",
          clientRequestId,
        });
      const first = yield* send("thread:laptop-full", "same-key");
      expect(first.isError, JSON.stringify(first.content)).toBe(false);
      yield* send("thread:laptop-full", "same-key");
      yield* send("thread:laptop-other", "same-key");
      const sends = (yield* Ref.get(seen)).sends;
      const [firstId, retried, other] = sends.map((input) => input.commandId);
      // Each hop scopes the key to its caller: a retry still matches at the box, another agent's does not.
      expect(retried).toBe(firstId);
      expect(other).not.toBe(firstId);
      expect(firstId).not.toContain("same-key");
      // The main host passes on which thread on the member sent it.
      expect(sends[0]?.linkedSender).toEqual({
        environmentId: laptop.environmentId,
        threadId: "thread:laptop-full",
        title: "thread:laptop-full",
      });

      yield* a.call("thread:laptop-full", "t3_thread_wait", {
        environmentId: box.environmentId,
        threadId: boxThread,
        timeoutMs: 600_000,
      });
      expect((yield* Ref.get(seen)).waits.map(({ timeoutMs }) => timeoutMs)).toEqual([45_000]);
      // The box only ever sees the main host's own credential.
      const [boxRoute] = yield* Ref.get(members);
      expect(new Set(yield* Ref.get(b.bearers))).toEqual(new Set([`Bearer ${boxRoute!.token}`]));

      const nowhere = yield* a.call("thread:laptop-full", "t3_thread_read", {
        environmentId: EnvironmentId.make("environment-nowhere"),
        threadId: boxThread,
      });
      expect(failureOf(nowhere)).toMatchObject({
        code: "capability_denied",
        message:
          "environment-nowhere is not a member of this cluster. t3_environment_links lists this cluster's environments.",
      });

      // The main host refuses a member's call that names that member...
      const looped = yield* main.serveHost(laptopMember, {
        requestId: "looped",
        tool: "t3_thread_read",
        arguments: { environmentId: laptop.environmentId, threadId: "thread:laptop-full" },
        limits: { runtimeMode: "full-access", interactionMode: "default" },
      });
      expect(looped.isError).toBe(true);
      expect(JSON.parse(looped.text)).toMatchObject({
        code: "invalid_request",
        message:
          "That environmentId is the calling environment's own. Leave out environmentId to act there.",
      });
      // ...and a member never sends on a call its main host already forwarded.
      const bounced = yield* a.callAs(
        {
          ...a.scopeOf("thread:unused"),
          thread: undefined,
          client: {
            sessionId: "cluster-host-session",
            label: "Cluster host · Studio",
            access: "full-access",
            cluster: true,
          },
        },
        "t3_thread_read",
        { environmentId: box.environmentId, threadId: boxThread },
      );
      expect(failureOf(bounced)).toMatchObject({ code: "invalid_request" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a member whose main host is down hears that the cluster host is unreachable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* makeLaptopWith(
        layerRoutingMember({
          host: studio,
          hostCall: () => Effect.fail(ClusterService.clusterHostUnreachable("Studio")),
        }),
      );
      const read = yield* a.call("thread:laptop-full", "t3_thread_read", {
        environmentId: box.environmentId,
        threadId: boxThread,
      });
      // Not final: a follower keeps trying until the link is back.
      expect(failureOf(read)).toMatchObject({
        code: "orchestration_error",
        message:
          'Cluster host unreachable: "Studio" is not connected, so other environments in the cluster cannot be reached. Work here continues.',
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/server/src/peer/PeerForwarding.test.ts -t "main host"`

Expected: FAIL.

- The first new test gets `linked_environments_off` / `capability_denied`, "Linked environments is off on this machine…", from `McpToolAccess`.
- The second gets "This environment cannot reach linked environments." or an unknown-link refusal, because nothing routes through `ClusterService`.
- The third gets an unknown-link refusal instead of "Cluster host unreachable".
- Typecheck reports that `routeLabel`, `ClusterHostRequests` and `McpClientCaller.cluster` are missing.

- [ ] **Step 3: Implement**

`apps/server/src/mcp/McpInvocationContext.ts`. In `McpClientCaller`, after `linked`, add:

```ts
  /**
   * Came over a cluster: the main host on a member, or a member's agent on the main host.
   * Cluster traffic is full trust, so nothing it starts is fenced (`linkOrigin.ts`).
   */
  readonly cluster?: boolean | undefined;
  /** On the main host: the member whose agent sent this call over its control link. */
  readonly clusterMember?: EnvironmentId | undefined;
```

In `McpInvocationScope`, after `linkedEnvironments`, add:

```ts
  /** True while this environment is in a cluster; `/mcp` reads it per request. */
  readonly clustered?: boolean;
```

`apps/server/src/auth/McpOAuth.ts`. Replace the `client:` object in `layerMcpClientAuthenticator`:

```ts
                  client: {
                    sessionId: client.sessionId,
                    label: client.label,
                    access: client.access,
                    linked: client.peerLink,
                    ...(client.cluster === true ? { cluster: true } : {}),
                    // Another T3 Code environment renders t3-thread links itself.
                    ...(client.peerLink || client.cluster === true ? {} : { hostedAppUrl }),
                  },
```

`apps/server/src/mcp/McpHttpServer.ts`. Change the doc comment and guard in `withSenderThread`:

```ts
/** Records the thread another T3 Code environment calls for; a malformed header only loses the name. */
const withSenderThread = (
  invocation: McpInvocationContext.McpInvocationScope,
  request: HttpServerRequest.HttpServerRequest,
): McpInvocationContext.McpInvocationScope => {
  const header = request.headers[McpInvocationContext.SENDER_THREAD_HEADER];
  if (
    header === undefined ||
    (invocation.client?.linked !== true && invocation.client?.cluster !== true)
  )
    return invocation;
```

In `authenticateRequest`, replace `return { ...limited, linkedEnvironments, origin };` with:

```ts
    return { ...limited, linkedEnvironments, clustered: yield* clustered, origin };
```

`apps/server/src/mcp/McpToolAccess.ts:451`. Change it to:

```ts
        if (scope.linkedEnvironments === false && scope.clustered !== true)
          return yield* PeerForwarding.linkedEnvironmentsOff;
```

`apps/server/src/mcp/ClusterHostRequests.ts`:

```ts
import type { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { McpSchema, McpServer } from "effect/ai";

import type * as ClusterService from "../cluster/ClusterService.ts";
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
      Effect.withSpan("ClusterHostRequests.serve"),
    );
  return serve;
});
```

`apps/server/src/peer/PeerForwarding.ts`:

```ts
import {
  type ClusterError,
  type ClusterStatus,
  type EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpEnvironmentLinksResult,
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
 * Runs T3 MCP tools in another environment for an agent here: over a peer
 * link, or through the cluster this environment is in. The tool's own
 * declaration checks the agent here first; the other environment then holds
 * the call to the link's access, or to full trust in a cluster, narrowed to
 * the agent's modes, which every forwarded call carries.
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
      ? Effect.succeed(undefined)
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
        off: `${name} has clusters turned off. Turn them on in its Settings → Labs.`,
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

  const call: PeerForwarding["Service"]["call"] = (scope, tool, environmentId, params) =>
    (tool.name === "t3_thread_wait"
      ? waitThere(scope, environmentId, params as OrchestratorMcpThreadWaitInput, true)
      : forward(
          scope,
          tool.name,
          tool.parametersSchema,
          tool.successSchema,
          environmentId,
          params,
          true,
        )) as Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure>;

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

  const listLinks: PeerForwarding["Service"]["links"] = Effect.fn("PeerForwarding.listLinks")(
    function* (scope) {
      yield* forwardingCaller(scope);
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
```

`apps/server/src/server.ts`. The main host's `serve` needs the `McpServer` that `McpHttpServer.layer` builds, so the link starts beside it. In `layerMakeRoutes`, replace the entry

```ts
  McpHttpServer.layer.pipe(
    Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
    Layer.provide(McpOAuth.layerMcpClientAuthenticator),
  ),
```

with

```ts
  // One control link to each member; their agents' calls run here with the same /mcp tools.
  Layer.effectDiscard(
    Effect.gen(function* () {
      const cluster = yield* ClusterService.ClusterService;
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const serve = yield* ClusterHostRequests.make(yield* environment.getEnvironmentId);
      yield* cluster.start(serve);
    }),
  ).pipe(
    Layer.provideMerge(
      McpHttpServer.layer.pipe(
        Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
        Layer.provide(McpOAuth.layerMcpClientAuthenticator),
      ),
    ),
  ),
```

and delete Plan 2 Task 8's `Layer.effectDiscard(… cluster.start(ClusterService.refuseHostRequests) …)` entry and its comment. Import `* as ClusterHostRequests from "./mcp/ClusterHostRequests.ts"` (and `* as ServerEnvironment from "./environment/ServerEnvironment.ts"` if `server.ts` does not import it yet). `ClusterService` reaches this layer through the `PeerForwarding` provide Plan 2 Task 6 set up.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/peer/PeerForwarding.test.ts apps/server/src/peer/PeerMcpClient.test.ts apps/server/src/mcp/McpToolAccess.test.ts apps/server/src/mcp/McpToolAccess.race.test.ts apps/server/src/auth/McpOAuth.test.ts apps/server/src/mcp/McpHttpServer.test.ts`

Expected: PASS.

Run: `vp run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mcp/ClusterHostRequests.ts apps/server/src/peer/PeerForwarding.ts apps/server/src/peer/PeerForwarding.test.ts apps/server/src/mcp/McpInvocationContext.ts apps/server/src/auth/McpOAuth.ts apps/server/src/mcp/McpHttpServer.ts apps/server/src/mcp/McpToolAccess.ts apps/server/src/cluster/ClusterService.testkit.ts apps/server/src/server.ts
git commit -m "feat(server): agents act on cluster environments through the main host

A member's calls ride its control link; the main host runs them with its
own /mcp tools and forwards to the target member.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Remote delegation to cluster members

**Files:**

- Modify: `apps/server/src/peer/RemoteDelegation.ts`:
  - imports (`:50-51`)
  - `make` (`:158`)
  - `delegate` (`:367-378`)
  - `finalReason` (`:674-693`)
- Test: `apps/server/src/peer/RemoteDelegation.test.ts`:
  - `makeLaptop` (`:640-700`)
  - new tests after "fails the task when its thread there is gone, or the link here is" (`:1633-1669`)

**Interfaces:**

- Consumes: `PeerForwarding.routeLabel` and testkit `layerRoutingMain`, `clusterHostToken` and `RoutedEnvironment` (Task 2).
- Produces: `RemoteDelegation` without a `PeerLinks` dependency. A task's `remoteChild.label` is the member's label. A task whose environment has no route fails as final.

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/peer/RemoteDelegation.test.ts`, add these imports:

```ts
import type * as ClusterService from "../cluster/ClusterService.ts";
import {
  clusterHostToken,
  layerRoutingMain,
  type RoutedEnvironment,
} from "../cluster/ClusterService.testkit.ts";
```

Give `makeLaptop` a fifth parameter after `beforeFollow`:

```ts
  /** The cluster this laptop is the main host of, if any. */
  cluster: Layer.Layer<ClusterService.ClusterService> = Layer.empty,
```

Change `Layer.provideMerge(PeerForwarding.layer),` to:

```ts
          Layer.provideMerge(PeerForwarding.layer.pipe(Layer.provide(cluster))),
```

Add these tests:

```ts
it.effect("a task delegated to a cluster member is followed again after the laptop restarts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const members = yield* Ref.make<ReadonlyArray<RoutedEnvironment>>([
        { descriptor: box, url: b.url, token: yield* clusterHostToken(b.auth, "Laptop") },
      ]);
      const cluster = layerRoutingMain(members);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const delegated = yield* Effect.scoped(
        Effect.gen(function* () {
          const before = yield* makeLaptop(database, offers, undefined, Effect.void, cluster);
          // No link, and the Linked environments beta off: the cluster needs neither.
          yield* before.settings.updateSettings({ linkedEnvironmentsEnabled: false });
          yield* seedParent(before);
          return yield* delegateToBox(before);
        }),
      );
      expect(delegated.remoteChild).toMatchObject({ environmentId: box.environmentId, label: "Box" });
      // Full trust: the box records no link origin, so nothing fences the thread there.
      expect(yield* Ref.get(thread.linkOrigin)).toBeNull();
      yield* Ref.set(thread.reply, "Finished while you were away.");
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);

      const after = yield* makeLaptop(database, offers, undefined, Effect.void, cluster);
      yield* after.settings.updateSettings({ linkedEnvironmentsEnabled: false });
      yield* after.remote.start();
      expect(yield* taskResult(after, delegated.taskId)).toMatchObject({
        status: "completed",
        result: "Finished while you were away.",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a task delegated to a removed cluster member fails and says why", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* makeBoxThread;
      const b = yield* serveBox(thread);
      const members = yield* Ref.make<ReadonlyArray<RoutedEnvironment>>([
        { descriptor: box, url: b.url, token: yield* clusterHostToken(b.auth, "Laptop") },
      ]);
      const offers = yield* SubscriptionRef.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
      const a = yield* makeLaptop(database, offers, undefined, Effect.void, layerRoutingMain(members));
      yield* seedParent(a);
      const delegated = yield* delegateToBox(a);

      yield* Ref.set(members, []);
      yield* Ref.set(thread.status, "completed");
      yield* Deferred.succeed(thread.finished, undefined);
      const failed = yield* taskResult(a, delegated.taskId);
      expect(failed?.status).toBe("failed");
      expect(failed?.result).toBe(
        "environment-box is not a member of this cluster. t3_environment_links lists this cluster's environments.",
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/server/src/peer/RemoteDelegation.test.ts -t "cluster member"`

Expected: FAIL. `delegated.remoteChild.label` is `"environment-box"` (from the `links.get` fallback), not `"Box"`.

- [ ] **Step 3: Implement**

`apps/server/src/peer/RemoteDelegation.ts`:

- Delete `import * as PeerLinks from "./PeerLinks.ts";` and `const links = yield* PeerLinks.PeerLinks;`.
- In `delegate`, replace the `const link = yield* links.get(target.environmentId)…` statement and the `label:` line with:

```ts
      const label = yield* forwarding.routeLabel(target.environmentId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
```

```ts
        label: label ?? target.environmentId,
```

- In `finalReason`, replace the last two lines of the generator with:

```ts
      // No link here, or no longer in this cluster: nothing can reach it again.
      const routed = yield* forwarding.routeLabel(environmentId);
      return Option.isSome(routed) ? undefined : error.message;
```

- Update the doc comment above `RemoteDelegation` to say "to a linked environment or a cluster member".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/peer/RemoteDelegation.test.ts`

Expected: PASS, including "fails the task when its thread there is gone, or the link here is". `routeLabel` falls back to `links.get`, so that test still sees a forgotten link as final.

Run: `vp run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/peer/RemoteDelegation.ts apps/server/src/peer/RemoteDelegation.test.ts
git commit -m "feat(server): delegate_task reaches cluster members

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Agents list the cluster

**Files:**

- Modify: `packages/contracts/src/orchestratorMcp.ts`:
  - `OrchestratorMcpEnvironmentTarget` (`:339-344`)
  - after `OrchestratorMcpEnvironmentLink` (`:668-678`)
  - `OrchestratorMcpEnvironmentLinksResult` (`:680-685`)
- Modify: `apps/server/src/mcp/McpInvocationContext.ts:195-200` (`hiddenWhileLinksOff`, plus a new predicate)
- Modify: `apps/server/src/mcp/toolkits/orchestrator/tools.ts:323-335` (`EnvironmentLinksTool`)
- Modify: `apps/server/src/peer/PeerForwarding.ts` (`listLinks`)
- Modify: `evals/mcp-tool-use/cases/orchestration.ndjson` (append one case)
- Test: `apps/server/src/peer/PeerForwarding.test.ts`. Extend the three cluster tests from Task 2.

**Interfaces:**

- Consumes: `ClusterMemberStatus` (`packages/contracts/src/cluster.ts`), `ClusterService.members` and `hostCall` (Plan 2), `PeerMcpClient.decodeToolResult` (Task 1).
- Produces:
  - `OrchestratorMcpClusterEnvironment = { environmentId; label; role: "main-host" | "member"; status: ClusterMemberStatus; lastError: string | null }`.
  - `OrchestratorMcpEnvironmentLinksResult.cluster?: ReadonlyArray<OrchestratorMcpClusterEnvironment>`, which lists every environment in the cluster except the caller's own.
  - `McpInvocationContext.hiddenWithoutOtherEnvironments`. Link and unlink tools are hidden while clustered.

- [ ] **Step 1: Write the failing tests**

In "an agent on a cluster's main host works on a member's threads without links, unfenced", directly before `// Removed from the cluster…`, add:

```ts
      const listed = yield* a.callAs(asClustered("thread:laptop-full"), "t3_environment_links", {});
      expect(listed.structuredContent).toEqual({
        environmentId: laptop.environmentId,
        links: [],
        cluster: [
          { environmentId: box.environmentId, label: "Box", role: "member", status: "online", lastError: null },
        ],
        notListed:
          "Not listed: this environment is in a cluster, which takes no links. The user adds machines on the main host, in Settings → Cluster.",
      });
```

In "a member reaches another member through the main host, which never loops", directly after `const a = yield* makeLaptopWith(…);`, add:

```ts
      // The main host lists the calling member too; the member leaves itself out.
      yield* Ref.update(members, (list) => [
        ...list,
        { descriptor: laptop, url: "http://127.0.0.1:1", token: "unused" },
      ]);
      const listed = yield* a.call("thread:laptop-full", "t3_environment_links", {});
      expect(listed.structuredContent).toEqual({
        environmentId: laptop.environmentId,
        links: [],
        cluster: [
          { environmentId: studio.environmentId, label: "Studio", role: "main-host", status: "online", lastError: null },
          { environmentId: box.environmentId, label: "Box", role: "member", status: "online", lastError: null },
        ],
        notListed:
          "Not listed: this environment is in a cluster, which takes no links. The user adds machines on the main host, in Settings → Cluster.",
      });
```

The test later reads `const [boxRoute] = yield* Ref.get(members);`, which is still the box.

In "a member whose main host is down hears that the cluster host is unreachable", append:

```ts
      const listed = yield* a.call("thread:laptop-full", "t3_environment_links", {});
      expect(listed.structuredContent).toMatchObject({
        cluster: [
          {
            environmentId: studio.environmentId,
            role: "main-host",
            status: "offline",
            lastError:
              'Cluster host unreachable: "Studio" is not connected, so other environments in the cluster cannot be reached. Work here continues.',
          },
        ],
      });
```

Append to `evals/mcp-tool-use/cases/orchestration.ndjson` (one line):

```json
{"id": "cluster-member-delegates-by-id", "area": "orchestration", "kind": "guard", "pattern": "cluster machine reached through t3_environment_links", "experience": "In a cluster the user's other machines are listed under `cluster`, with no links; an agent that reads only `links` asks to link a machine it can already reach.", "rule": "A machine listed under `cluster` is reached by passing its environmentId, as delegate_task target.environmentId; it is never linked.", "privacy": "commit-safe", "setup": {"role": "top", "linkedEnvironments": true, "mocks": {"t3_environment_links": {"environmentId": "environment-laptop", "links": [], "cluster": [{"environmentId": "environment-studio", "label": "Studio", "role": "main-host", "status": "online", "lastError": null}, {"environmentId": "environment-gpu", "label": "GPU box", "role": "member", "status": "online", "lastError": null}], "notListed": "Not listed: this environment is in a cluster, which takes no links. The user adds machines on the main host, in Settings → Cluster."}}}, "prompt": "Delegate this to my GPU box: run `nvidia-smi` there and tell me the result. Do not edit any files here.", "expect": {"calls": [{"tool": "delegate_task", "args": {"target.environmentId": "environment-gpu"}}], "notCalls": ["t3_environment_link"]}, "source": {"spec": "docs/superpowers/specs/2026-11-19-environment-cluster-design.md#agents"}}
```

- [ ] **Step 2: Run the tests and the eval baseline to verify they fail**

Run: `vp test run apps/server/src/peer/PeerForwarding.test.ts -t "main host"`

Expected: FAIL. The listing is the peer one, `{ environmentId, links: [], notListed: "Not listed: not linked yet…" }` with no `cluster`. On the main host with the beta off it is `linked_environments_off`.

Run, from `evals/`:

```sh
pnpm mcp-tool-use --case cluster-member-delegates-by-id --dry-run
pnpm mcp-tool-use --case cluster-member-delegates-by-id,vps-delegate-links-on-calls-link,linked-thread-chip-reads-there --samples 3 --out runs/cluster-links-before
```

Expected: the dry run prints one request body. The paid run records the baseline on the old text. The cluster case may pass or fail there, because it is a guard. Record its pass rate.

- [ ] **Step 3: Implement**

`packages/contracts/src/orchestratorMcp.ts`. Add `import { ClusterMemberStatus } from "./cluster.ts";` and change the target description:

```ts
export const OrchestratorMcpEnvironmentTarget = Schema.optional(
  EnvironmentId.annotate({
    description:
      "Linked or cluster environment to act in. Omit for this one. Ids are then that environment's.",
  }),
);
```

After `OrchestratorMcpEnvironmentLink`:

```ts
export const OrchestratorMcpClusterEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  role: Schema.Literals(["main-host", "member"]),
  /** Whether the main host reached it lately. */
  status: ClusterMemberStatus,
  lastError: Schema.NullOr(Schema.String),
});
export type OrchestratorMcpClusterEnvironment = typeof OrchestratorMcpClusterEnvironment.Type;
```

In `OrchestratorMcpEnvironmentLinksResult`, after `links`:

```ts
  /** The rest of this environment's cluster, when it is in one; it then has no links. */
  cluster: Schema.optionalKey(Schema.Array(OrchestratorMcpClusterEnvironment)),
```

`apps/server/src/mcp/McpInvocationContext.ts`. Replace `hiddenWhileLinksOff`:

```ts
/** `McpSchema.EnabledWhen` for tools that make or forget links: hidden while the beta is off or in a cluster. */
export const hiddenWhileLinksOff = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.linkedEnvironments !== false && scope?.clustered !== true;
};

/** `McpSchema.EnabledWhen` for listing other environments: shown with links on, or in a cluster. */
export const hiddenWithoutOtherEnvironments = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.linkedEnvironments !== false || scope?.clustered === true;
};
```

`apps/server/src/mcp/toolkits/orchestrator/tools.ts`. In `EnvironmentLinksTool`:

```ts
  description:
    "List the user's other machines and whether each answers now: linked environments, or `cluster` when this one is in a cluster. Pass one's `environmentId` to a tool to act there; `delegate_task` takes `target.environmentId`. An expired link: link it again with `t3_environment_link`.",
```

Change its last annotation to `.annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutOtherEnvironments);`.

`apps/server/src/peer/PeerForwarding.ts`. Add `OrchestratorMcpEnvironmentLinksResult` (value import, replacing the `type` import) and `type OrchestratorMcpClusterEnvironment` to the contracts import. Then replace `listLinks` and add the helpers above it:

```ts
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
      return members.map(
        (member): OrchestratorMcpClusterEnvironment => ({
          environmentId: member.environmentId,
          label: member.label,
          role: "member",
          status: member.status,
          lastError: member.lastError,
        }),
      );
    }
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
```

- [ ] **Step 4: Run the tests and the evals to verify they pass**

Run: `vp test run apps/server/src/peer/PeerForwarding.test.ts apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/mcp/OrchestratorMcpService.test.ts apps/server/src/mcp/advertisedJsonSchema.test.ts`

Expected: PASS. The `McpHttpServer.test.ts:1658` fixture still reads `hiddenWhileLinksOff` as hidden only when the beta is off, because its scope sets no `clustered`.

Run, from `evals/`:

```sh
pnpm mcp-tool-use --case cluster-member-delegates-by-id,vps-delegate-links-on-calls-link,linked-thread-chip-reads-there,vps-delegate-links-off-names-setting --samples 3 --out runs/cluster-links-after --baseline runs/cluster-links-before/results.jsonl --stop-on-regression
pnpm mcp-tool-use --model claude-opus-5-5 --cases mcp-tool-use/cases/orchestration.ndjson --samples 3 --out runs/cluster-links-orchestration
```

Expected: `cluster-member-delegates-by-id` passes at least 2 of 3 samples. The three link cases pass at least as often as in the baseline. No orchestration case regresses against the latest stored baseline on the same model. Put the pass rates and the cost in the PR body.

Run: `vp run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/orchestratorMcp.ts apps/server/src/mcp/McpInvocationContext.ts apps/server/src/mcp/toolkits/orchestrator/tools.ts apps/server/src/peer/PeerForwarding.ts apps/server/src/peer/PeerForwarding.test.ts evals/mcp-tool-use/cases/orchestration.ndjson
git commit -m "feat(server): agents list the environments in their cluster

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: Internal docs

**Files:**

- Modify: `docs/internals/environment-auth.md`. Add a subsection after Plan 2's "### A cluster member trusts only its main host".

This task adds no test: it changes only docs.

- [ ] **Step 1: Document the agent hairpin and its trust**

Append:

```md
### Agents cross the cluster through the main host

On the main host, a tool call that names a member goes to that member's `/mcp`
with the main host's `cluster-host` token and the calling agent's
`T3-Mode-Limit` ([PeerForwarding](../../apps/server/src/peer/PeerForwarding.ts)).
A member's agents have no credential or address for the main host: their calls
ride the member's control link back, and the main host runs each one with its
own `/mcp` tools as that member's client
([ClusterHostRequests](../../apps/server/src/mcp/ClusterHostRequests.ts)),
forwarding it on when it names another member. Cluster calls are full trust:
they carry no `linkOrigin`, so the link fence never applies, while a peer link
below full access stays fenced. The main host sends calls on without
`environmentId`, so a member refuses a call from it that names another
environment rather than bouncing it back. Each hop scopes `clientRequestId` to
its caller, so an agent's retry after "cluster host unreachable" lands once.
```

- [ ] **Step 2: Commit**

```bash
git add docs/internals/environment-auth.md
git commit -m "docs: cluster agent routing and its trust

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run: `vp test run apps/server/src/cluster apps/server/src/peer apps/server/src/mcp/McpToolAccess.test.ts apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/auth/McpOAuth.test.ts`

  Expected: PASS.

- [ ] Run: `vp run check:changed`

  Expected: clean. It covers format, lint, knip (`PeerLinks` is no longer imported by `RemoteDelegation`), typecheck and the tests beside the changes.

- [ ] Integrated pass, run once by the primary agent after Plan 3's client route lands:
  1. Start three dev servers in separate worktree `.t3` homes. One is the main host and two are members, joined over HTTPS.
  2. Using the free `Replay (dev)` provider on member A, run `delegate_task` with `target.environmentId` set to member B.
  3. Confirm that B's thread runs and that A's task completes.
  4. From member A, have an agent call `t3_environment_links`, which runs on the main host through the link; confirm it lists the main host and B. This exercises the main host's `McpServer.callTool` path in the real server.
  5. Stop the main host and confirm that A's agent hears "Cluster host unreachable"; start it again and confirm A's task follower resumes without anyone touching A.

---

## Self-Review Against the Spec

| Spec item ("Control link", "Agents", plus related rows) | Where |
| --- | --- |
| Main host: `environmentId` tools forward to the member's `/mcp` with `cluster-host` | Task 2 (`clusterRoute` main branch, `ClusterService.connect`), Task 1 (`McpRoute`) |
| A member agent targeting another environment puts the call on `cluster.hostChannel`; the main host runs it, forwarding to the target member, and replies | Task 2 (`clusterRoute` member branch → `ClusterService.hostCall`; `ClusterHostRequests.make` as `serve`; `server.ts` passes it to `start`) on Plan 2 Task 8's channel |
| All cross-member traffic hairpins through the main host | Task 2, three-environment test |
| No separate member-to-main credential exists; members never need the main host's address | Nothing here mints, stores or dials one; the member side only calls `hostCall` |
| Requests queued while the link is down fail "cluster host unreachable", never delivered twice | Plan 2 Task 8 (link); Task 2 maps it to `orchestration_error` (not final) and tests it; Review Focus 5 for retries |
| Forwarded-wait limits ≤ 50 s | Task 2: `waitThere` caps every hop at 45 s; tests assert `[45_000]` direct and hairpinned |
| "main host down … member agents get "cluster host unreachable" … local work continues" | Task 2 (`fromClusterError` keeps `unreachable` retryable), Task 4 (listing degrades, does not fail) |
| Cluster separate from peer links; no fence for full trust | Task 2: cluster routes skip the beta and link access, and an `auto` link is still fenced on the same box. Task 4 hides link and unlink tools while clustered |
| `clusterEnabled` gates both sides | Main side: `ClusterService.connect` and the links (Plan 2). Member side: membership is the gate (Plan 2 resolved ambiguity 1) |
| `delegate_task` to a member, including startup re-follow | Task 3 (restart test, removal test) |
| Agents can discover members | Task 4 (`cluster` in `t3_environment_links`, eval case) |
| Status `online | offline | incompatible | revoked` | Task 4 lists `ClusterMemberStatus` from the link; a failed call changes no status |

### Resolved ambiguities

An implementer should not reopen these choices:

1. **One seam.** `PeerForwarding.forward` resolves the route. Main→member shares the rest of `PeerMcpClient` with peer links: sessions, 404 renewal, mode and sender headers. Member→main shares `decodeToolResult`. `RemoteDelegation` and the toolkits do not change their routing.
2. **The main host runs a member's call with its own `McpServer`**, not a loopback `/mcp` request: no credential is minted for it, and the call keeps the member's identity (`clusterMember`) for the loop guard and its own idempotency namespace.
3. **Error finality.** These map to `capability_denied`, which is final for `RemoteDelegation`:
   - An unknown or removed member.
   - A revoked credential (`/mcp` 401 on a member).

   A host whose link is down, or a member that does not answer or has clusters off, maps to `orchestration_error`, which is retried.
4. **Loops.** The main host refuses a member's call that names that member. A member refuses any call from its main host that names another environment. An unknown id on the main host is `unknown_member`.
5. **Labels.** On a member, the label of another member is its `environmentId`. Only the main host's name is known locally, and `t3_environment_links` shows the real names.
6. **Listing.** `t3_environment_links` gains an optional `cluster` array instead of a new tool. A member asks its main host for the list over the link. When the link is down, the member lists the main host as `offline` with the unreachable message and does not fail.
7. **A member→member call's status effects stay with the link.** A failed call to a member records nothing; the member's control link owns its status.
