# Cluster 4: Agent Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents on any environment in a cluster can act on any other through the main host. On the main host, a tool call that names a member goes to that member's `/mcp`. On a member, a tool call that names another environment goes to the main host's `/mcp`, which sends it on. Remote `delegate_task` works the same way, including after a restart. Cluster calls are full trust: no link fence applies to them.

**Architecture:** There is one seam: `PeerForwarding`. Before a forwarded call leaves, `PeerForwarding.clusterRoute` asks `ClusterService` where this environment sits. On a standalone environment the call goes over a peer link, as it does today. On a main host the call goes to the member, using `ClusterService.connect(memberId)` and its `cluster-host` token. On a member the call goes to the main host, using the new `ClusterService.connectHost` and the `cluster-member` token from the join. In that case the call keeps its `environmentId`, so the main host can send it on. `PeerMcpClient.call` gains an optional `route` (origin, token, HTTP client, messages), so cluster calls reuse its session handling, `T3-Mode-Limit`, `T3-Sender-Thread` and 404 renewal. `RemoteDelegation` and the MCP toolkits need no changes: they already go through `PeerForwarding`. The `cluster-member` credential is a new `EnvironmentAuth` subject that works only on `/mcp`. `addMember` mints it and `removeMember` revokes it.

**Tech Stack:** Effect 4 services (`Context.Service`, `Effect.fn`), `effect/sql` SQLite, `effect/http` client, `effect/ai` MCP toolkits, `@effect/vitest` (`it.effect`, `TestClock`), the evals in `evals/mcp-tool-use`.

**Spec:** `docs/superpowers/specs/2026-11-19-environment-cluster-design.md` ("Agents"). This plan builds on `docs/superpowers/plans/2026-11-19-cluster-2-server-core.md` and uses the names that plan produces for Plan 4.

## Global Constraints

Copied word for word from the spec. Every task follows them.

- "On the main host, MCP tools with an `environmentId` target forward to the member's `/mcp` using the `cluster-host` credential."
- "Each member receives a `cluster-member` MCP credential for the main host at join time. A member agent targeting another member calls the main host's `/mcp`, which forwards. All cross-member traffic hairpins through the main host."
- "The existing forwarded-wait limits (≤ 50 s) apply."
- "**Members fully trust the main host.**"
- "**Cluster is separate from peer links.** Any clustered environment (main host or member) takes no part in peer links in either direction."
- "**Dial-in only.** The main host always initiates." Cross-member agent traffic is the one case where a member dials the main host, and it happens only because the spec's Agents section requires it.
- "main host down | clients lose all members; member agents get "cluster host unreachable" on cross-member tools; local work continues"
- "New auth subjects: `cluster-host` (member side) and `cluster-member` (MCP on the main host)."
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

- `EnvironmentAuth.CLUSTER_HOST_SUBJECT` (`"cluster-host"`) and the private `CLUSTER_HOST_SESSION_TTL`.
- `EnvironmentAuth.MCP_CLIENT_SUBJECT` and `EnvironmentAuth.consumeClusterInvite`.
- `AuthPairingLinks.CLUSTER_MEMBER_PAIRING_SUBJECT`.
- `CLUSTER_SCOPES_HEADER`. Plan 4 never sends it, because `/mcp` caps by `T3-Mode-Limit`.
- `ClusterService.connect(memberId): Effect<MemberConnection, ClusterError>` with `MemberConnection = { upstream: ClusterUpstream.Upstream; token: string; member: ClusterMember }` and `Upstream = { origin; httpClient; webSocket }`.
- `ClusterService.status`, `members`, `probe`, `addMember`, `removeMember` and `acceptJoin`.
- `ClusterUpstream.connect`, which allows loopback `http:` and otherwise needs `https:` with a pin.
- `ClusterJoinRequest.hostMcp?: { url; token }`, stored in `cluster_membership.host_mcp_url` and in the secret named by `cluster_membership.host_mcp_secret_name`.
- Testkit: `ClusterService.testkit.ts` (`clusterDescriptor`, `FINGERPRINT`, `makeEnvironment`, `serveMember`, `layerClusterEnvironment`).
- The `clustered` effect that Plan 2 Task 4 adds inside `McpHttpServer.makeMcpAuthMiddleware`.

**Produced here:**

- `EnvironmentAuth.CLUSTER_MEMBER_SUBJECT` (`"cluster-member"`).
- `EnvironmentAuth.issueClusterMemberSession({ label, client }): Effect<{ sessionId; token }, ServerAuthInternalError>`.
- `McpClientSession.cluster` and `McpClientCaller.cluster`.
- `McpInvocationScope.clustered`.
- `PeerMcpClient.McpRoute` and the optional `PeerMcpClient.call({ route })`.
- `ClusterService.connectHost: Effect<HostConnection, ClusterError>` and `ClusterService.memberOfSession(sessionId): Effect<Option<EnvironmentId>>`.
- `ClusterJoinRequest.hostMcp.certSha256?` and `ClusterError.reason` `"no_host_mcp"`.
- `PeerForwarding.routeLabel(environmentId)`.
- `OrchestratorMcpClusterEnvironment` and `OrchestratorMcpEnvironmentLinksResult.cluster?`.
- Migration `100_ClusterMcp`, which adds `cluster_members.mcp_session_id` and `cluster_membership.host_mcp_cert_sha256`.
- Testkit helpers: `MAIN_LAN_URL`, `RoutedEnvironment`, `layerRoutingMain`, `layerRoutingMember` and `clusterHostToken`.

## Review Focus

These are the failure modes most likely to cause trouble without a test. Each one has a test in the task that owns it:

1. **A member's call loops back through the main host.** A call that the main host sends on never carries `environmentId`, so it cannot bounce by construction. A buggy or hostile caller could still name an environment on a call that arrived over the cluster. The main host refuses a member that names itself. A member refuses any call from its main host that names another environment. Test: Task 4, "a member reaches another member through the main host, which never loops".
2. **A member is removed while a delegated task runs there.** `connect` then fails with `unknown_member`, which maps to `capability_denied`. `RemoteDelegation.isFinal` treats that as final, so the task fails and says why instead of retrying forever. Tests: Task 4, "an agent on a cluster's main host works on a member's threads without links, unfenced" (the final step), and Task 5, "a task delegated to a removed cluster member fails and says why".
3. **The main host restarts during a forwarded wait.** The member's wait fails with a transport error. That maps to `orchestration_error`, which is not final, so the follower retries. On the next call the restarted main host answers 404 for the old MCP session, and the client opens a new one. Tests: Task 2, "calls a cluster route with its own client and token, renews it after a restart, and names it when it is down", and Task 4, "a member whose main host is down hears that the cluster host is unreachable".
4. **Idempotency keys across the hairpin.** Each hop hashes `clientRequestId` with its caller's namespace. A retry from one agent reaches the target member with the same key. The same key from another agent, or from another member, does not. Test: Task 4, "a member reaches another member through the main host, which never loops".
5. **A member that joined without a cluster MCP credential.** This covers a member that joined before Plan 4 and a main host with no plain network address. `host_mcp_url` is then `NULL`. Agents must hear a clear way out, not a storage error or a hang. Test: Task 3, "a member added without a route to its main host's tools says how to get one".

## File Map

Create:

- `apps/server/src/persistence/Migrations/100_ClusterMcp.ts`

Modify:

- `packages/contracts/src/{cluster,orchestratorMcp}.ts`
- `apps/server/src/auth/{EnvironmentAuth,EnvironmentAuth.test,McpOAuth}.ts`
- `apps/server/src/mcp/{McpInvocationContext,McpHttpServer,McpToolAccess}.ts`
- `apps/server/src/mcp/toolkits/orchestrator/tools.ts`
- `apps/server/src/peer/{PeerMcpClient,PeerMcpClient.test,PeerForwarding,PeerForwarding.test,RemoteDelegation,RemoteDelegation.test}.ts`
- `apps/server/src/cluster/{ClusterService,ClusterService.test,ClusterService.testkit}.ts`
- `apps/server/src/persistence/{Migrations,reconcileV2PreviewMigration.test}.ts`
- `apps/server/src/server.ts`
- `evals/mcp-tool-use/cases/orchestration.ndjson`
- `docs/internals/environment-auth.md`

---

## Task 1: `cluster-member` MCP credential and cluster callers

**Files:**

- Modify: `apps/server/src/auth/EnvironmentAuth.ts`:
  - constants after Plan 2's `CLUSTER_HOST_SESSION_TTL` (Plan 2 replaces `:85`)
  - `McpClientSession` (`:88-94`)
  - the interface beside `issueMcpClientSession` (`:614-626`)
  - `rejectMcpClientAudience` (`:681-688`)
  - `authenticateMcpClient` (`:1531-1554`, as Plan 2 Task 3 leaves it)
  - after `issueMcpClientSession` (`:1556-1575`)
  - the returned service (`:1610-1638`)
- Modify: `apps/server/src/mcp/McpInvocationContext.ts`:
  - `McpClientCaller` (`:36-54`)
  - `McpInvocationScope` (`:136-150`)
- Modify: `apps/server/src/auth/McpOAuth.ts:625-631` (client caller)
- Modify: `apps/server/src/mcp/McpHttpServer.ts`:
  - `withSenderThread` (`:236-260`)
  - the admitted scope (`:313`)
- Test: `apps/server/src/auth/EnvironmentAuth.test.ts`. Extend the Plan 2 test "accepts a cluster invite only as a cluster invite…" and add one test beside it.

**Interfaces:**

- Consumes: `CLUSTER_HOST_SUBJECT`, `CLUSTER_HOST_SESSION_TTL`, `mcpClientScopes` and `sessions.issue` (`EnvironmentAuth.ts`). Also the Plan 2 `clustered` effect in `makeMcpAuthMiddleware`.
- Produces:
  - `CLUSTER_MEMBER_SUBJECT`.
  - `issueClusterMemberSession`.
  - `McpClientSession.cluster?: boolean`. It is `true` for `cluster-host` (member side) and `cluster-member` (main side).
  - `McpClientCaller.cluster?: boolean`.
  - `McpInvocationScope.clustered?: boolean`.
  - `T3-Sender-Thread` is read from cluster callers as well as linked ones.

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/auth/EnvironmentAuth.test.ts`, in Plan 2's test "accepts a cluster invite only as a cluster invite…", change the last assertion to:

```ts
        expect(yield* serverAuth.authenticateMcpClient(makeBearerRequest(host.token))).toMatchObject(
          { access: "full-access", peerLink: false, cluster: true },
        );
```

Directly after that test, add:

```ts
    it.effect("a cluster-member session works only on /mcp, as full access over the cluster", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const member = yield* serverAuth.issueClusterMemberSession({
          label: "Cluster member · Box",
          client: requestMetadata,
        });
        expect(yield* serverAuth.authenticateMcpClient(makeBearerRequest(member.token))).toEqual({
          sessionId: member.sessionId,
          label: "Cluster member · Box",
          access: "full-access",
          peerLink: false,
          cluster: true,
        });
        const outsideMcp = yield* serverAuth
          .authenticateHttpRequest(makeBearerRequest(member.token))
          .pipe(Effect.flip);
        expect(outsideMcp._tag).toBe("ServerAuthInvalidCredentialError");
        expect(
          (yield* serverAuth.listSessions()).find((listed) => listed.sessionId === member.sessionId)
            ?.subject,
        ).toBe(EnvironmentAuth.CLUSTER_MEMBER_SUBJECT);

        yield* serverAuth.revokeSession(member.sessionId);
        const revoked = yield* serverAuth
          .authenticateMcpClient(makeBearerRequest(member.token))
          .pipe(Effect.flip);
        expect(revoked._tag).toBe("ServerAuthInvalidCredentialError");
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/server/src/auth/EnvironmentAuth.test.ts`

Expected: FAIL. The new test fails with `serverAuth.issueClusterMemberSession is not a function`. The extended test fails because the received object has no `cluster`.

- [ ] **Step 3: Implement**

`apps/server/src/auth/EnvironmentAuth.ts`. Add this below `CLUSTER_HOST_SESSION_TTL`:

```ts
/** A cluster member's agents on its main host's `/mcp`, and nowhere else. */
export const CLUSTER_MEMBER_SUBJECT = "cluster-member";
```

In `McpClientSession`, add:

```ts
  /** A cluster link: the main host on a member, or a member's agents on the main host. */
  readonly cluster?: boolean;
```

In the `EnvironmentAuth` interface, below `issueMcpClientSession`, add:

```ts
    /** The `cluster-member` token a main host hands a member at join; it works only on `/mcp`. */
    readonly issueClusterMemberSession: (input: {
      readonly label: string;
      readonly client: AuthClientMetadata;
    }) => Effect.Effect<
      { readonly sessionId: AuthSessionId; readonly token: string },
      ServerAuthInternalError
    >;
```

Replace `rejectMcpClientAudience`:

```ts
const rejectMcpClientAudience = <S extends { readonly subject: string }>(session: S) =>
  session.subject === MCP_CLIENT_SUBJECT || session.subject === CLUSTER_MEMBER_SUBJECT
    ? Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "MCP client sessions are only accepted by the MCP endpoint.",
        }),
      ).pipe(Effect.tap(() => Effect.logWarning("Rejected an MCP client session outside /mcp.")))
    : Effect.succeed(session);
```

In `authenticateMcpClient`, replace the `cluster-host` branch that Plan 2 added:

```ts
          : session.method === "bearer-access-token" &&
              (session.subject === CLUSTER_HOST_SUBJECT ||
                session.subject === CLUSTER_MEMBER_SUBJECT)
            ? Effect.succeed({
                sessionId: session.sessionId,
                label:
                  session.client.label ??
                  (session.subject === CLUSTER_HOST_SUBJECT ? "Cluster host" : "Cluster member"),
                access: "full-access",
                peerLink: false,
                cluster: true,
              } satisfies McpClientSession)
```

Add this after `issueMcpClientSession`:

```ts
  const issueClusterMemberSession: EnvironmentAuth["Service"]["issueClusterMemberSession"] = (
    input,
  ) =>
    sessions
      .issue({
        subject: CLUSTER_MEMBER_SUBJECT,
        method: "bearer-access-token",
        scopes: mcpClientScopes("full-access"),
        ttl: CLUSTER_HOST_SESSION_TTL,
        client: { ...input.client, label: input.label, deviceType: "bot" },
      })
      .pipe(
        Effect.map((issued) => ({ sessionId: issued.sessionId, token: issued.token })),
        Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })),
        Effect.withSpan("EnvironmentAuth.issueClusterMemberSession"),
      );
```

Add `issueClusterMemberSession,` to the returned `EnvironmentAuth.of({ … })` after `issueMcpClientSession,`.

`apps/server/src/mcp/McpInvocationContext.ts`. In `McpClientCaller`, after `linked`, add:

```ts
  /**
   * Came over a cluster link: the main host on a member, or a member's agent on the main
   * host. Cluster traffic is full trust, so nothing it starts is fenced (`linkOrigin.ts`).
   */
  readonly cluster?: boolean | undefined;
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/auth/EnvironmentAuth.test.ts apps/server/src/auth/McpOAuth.test.ts apps/server/src/mcp/McpHttpServer.test.ts`

Expected: PASS.

Run: `vp run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth/EnvironmentAuth.ts apps/server/src/auth/EnvironmentAuth.test.ts apps/server/src/auth/McpOAuth.ts apps/server/src/mcp/McpInvocationContext.ts apps/server/src/mcp/McpHttpServer.ts
git commit -m "feat(server): cluster-member MCP credential and cluster callers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: `PeerMcpClient` calls a given route

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

`PeerMcpClient.call` accepts `route?: McpRoute`. Without a route it resolves the peer link to `environmentId`, as it does today. Every peer-link message stays exactly as it is now.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/peer/PeerMcpClient.test.ts`:

```ts
it.effect(
  "calls a cluster route with its own client and token, renews it after a restart, and names it when it is down",
  () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly target: string; readonly session: string | undefined }> = [];
      const outcomes: Array<string | null> = [];
      const arrived = yield* Queue.unbounded<void>();
      const down = yield* Ref.make(false);
      // The main host restarts after the first call: it forgets the session and answers 404 once.
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
        key: "cluster environment-studio https://studio.example",
        origin: "https://studio.example",
        token: "cluster-member-token",
        httpClient: routeHttp,
        messages: {
          name: 'The cluster\'s main host "Studio"',
          revoked: "Studio no longer accepts this member.",
          off: "Studio has clusters turned off.",
          unreachable: 'Cluster host unreachable: "Studio" is not answering.',
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
        new Set(["https://studio.example/mcp Bearer cluster-member-token"]),
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

Run: `vp test run apps/server/src/peer/PeerMcpClient.test.ts -t "calls a cluster route"`

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
      const text = body.result.content.map((part) => part.text ?? "").join("");
      if (body.result.isError === true) {
        // A refusal keeps the other side's own code, so the agent sees why it was refused.
        const refused = decodeFailure(text);
        return Result.fail(
          refused._tag === "Some"
            ? new OrchestratorMcpFailure({
                code: refused.value.code,
                message: refused.value.message,
              })
            : new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: text || `${route.messages.name} refused the call.`,
              }),
        );
      }
      const success = Schema.fromJsonString(input.success);
      return yield* Schema.decodeEffect(success)(text).pipe(
        Effect.map(Result.succeed),
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: `${route.messages.name}'s answer did not match this version. Update both environments.`,
            }),
        ),
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

## Task 3: `ClusterService` mints, stores and reads the agent route

**Files:**

- Create: `apps/server/src/persistence/Migrations/100_ClusterMcp.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`. Add the import after Plan 2's `Migration0099` import and the entry after `[99, "Cluster", Migration0099]`.
- Modify: `apps/server/src/persistence/reconcileV2PreviewMigration.test.ts:80` and `:201`
- Modify: `packages/contracts/src/cluster.ts`. Change `ClusterJoinRequest.hostMcp` and `ClusterError.reason` (Plan 2 Task 1).
- Modify: `apps/server/src/cluster/ClusterService.ts`:
  - `MemberRow`
  - the interface
  - `make` (`acceptJoin`, `addMember`, `removeMember`, new `connectHost` and `memberOfSession`)
  - the returned service
- Modify: `apps/server/src/cluster/ClusterService.testkit.ts` (`layerClusterEnvironment` and the routing helpers)
- Test: `apps/server/src/cluster/ClusterService.test.ts`

**Interfaces:**

- Consumes:
  - `EnvironmentAuth.issueClusterMemberSession` and `revokeSession`.
  - `DirectEndpoints.resolveAvailable` (`apps/server/src/environment/DirectEndpoints.ts:139-152`).
  - `ServerTls.fingerprint` and `ClusterUpstream.connect`.
- Produces:
  - `ClusterService["Service"]["connectHost"]: Effect<HostConnection, ClusterError>`, with `HostConnection = { upstream: ClusterUpstream.Upstream; token: string; host: { environmentId: EnvironmentId; label: string } }`.
  - `ClusterService["Service"]["memberOfSession"]: (sessionId: string) => Effect<Option<EnvironmentId>>`.
  - The `ClusterJoinRequest.hostMcp.certSha256` key and the `ClusterError` reason `"no_host_mcp"`.
  - Testkit: `MAIN_LAN_URL`, `RoutedEnvironment`, `layerRoutingMain(members, callers?)`, `layerRoutingMember(host)` and `clusterHostToken(auth, hostLabel)`.

How the URL is chosen: the main host takes the first plain `http:` address from `DirectEndpoints.resolveAvailable()` (LAN or tailnet IP). It sends the member `https://<that host:port>/mcp`, pinned to its own certificate. Plan 1 serves TLS on the same port. Tailscale Serve's `https:` URL is skipped, because its certificate is not this server's. A main host with no such address sends no `hostMcp`. Its members' agents then hear `no_host_mcp`.

- [ ] **Step 1: Extend the testkit and write the failing tests**

`apps/server/src/cluster/ClusterService.testkit.ts`. Add these imports:

```ts
import { ClusterError, type ClusterMember, type EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import { CLUSTER_MEMBER_PAIRING_SUBJECT } from "../persistence/AuthPairingLinks.ts";
```

Add this above `layerClusterEnvironment`:

```ts
/** The plain address main hosts in these tests advertise; members call its /mcp over https there. */
export const MAIN_LAN_URL = "http://192.168.1.10:3773/";
```

In `layerClusterEnvironment`, directly after `Layer.provideMerge(ClusterUpstream.layer),`, add:

```ts
    Layer.provide(
      Layer.mock(DirectEndpoints.DirectEndpoints)({
        resolveAvailable: () => Effect.succeed([{ kind: "lan", httpBaseUrl: MAIN_LAN_URL }]),
      }),
    ),
```

Append to the testkit:

```ts
/** An environment agent calls are routed to, as a cluster stores it. */
export interface RoutedEnvironment {
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly url: string;
  /** What is sent there: a member's `cluster-host` token, or a member's `cluster-member` token for its host. */
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

/** A main host whose members are `members`; `callers` maps a `cluster-member` session to its member. */
export const layerRoutingMain = (
  members: Ref.Ref<ReadonlyArray<RoutedEnvironment>>,
  callers?: Ref.Ref<ReadonlyMap<string, EnvironmentId>>,
) =>
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
    // A failed call asks for a probe; these members stay where the test put them.
    probe: (memberId) =>
      Effect.fail(new ClusterError({ reason: "unreachable", message: `${memberId} was not probed.` })),
    memberOfSession: (sessionId) =>
      callers === undefined
        ? Effect.succeed(Option.none())
        : Ref.get(callers).pipe(Effect.map((map) => Option.fromNullishOr(map.get(sessionId)))),
  });

/** A member of `host`, reaching its `/mcp` with `host.token`. */
export const layerRoutingMember = (host: RoutedEnvironment) =>
  Layer.mock(ClusterService.ClusterService)({
    status: Effect.succeed({
      enabled: true,
      role: "member",
      fingerprint: FINGERPRINT,
      host: {
        environmentId: host.descriptor.environmentId,
        label: host.descriptor.label,
        joinedAt: DateTime.makeUnsafe(0),
      },
    }),
    connectHost: upstreamAt(host.url).pipe(
      Effect.map((upstream) => ({
        upstream,
        token: host.token,
        host: { environmentId: host.descriptor.environmentId, label: host.descriptor.label },
      })),
    ),
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

Append to `apps/server/src/cluster/ClusterService.test.ts`. `Option` and `serveMember` are already imported by Plan 2 Task 7. Add `FINGERPRINT` to the testkit import if it is missing.

```ts
it.effect(
  "a member gets the main host's /mcp and a cluster-member token; re-adding and removal revoke it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const member = yield* serveMember(box);
        const main = yield* makeEnvironment(studioDescriptor);
        const add = member.cluster
          .invite({ url: member.url })
          .pipe(
            Effect.flatMap((invite) => main.cluster.addMember({ target: invite.joinString ?? "" })),
          );
        yield* add;
        expect(
          yield* member.sql`SELECT host_mcp_url, host_mcp_cert_sha256 FROM cluster_membership`,
        ).toEqual([
          { host_mcp_url: "https://192.168.1.10:3773/mcp", host_mcp_cert_sha256: FINGERPRINT },
        ]);
        const first = yield* member.cluster.connectHost;
        expect(first.upstream.origin).toBe("https://192.168.1.10:3773");
        expect(first.host).toEqual({ environmentId: studio.environmentId, label: "Studio" });
        const session = yield* main.auth.authenticateMcpClient(bearer(first.token));
        expect(session).toMatchObject({ access: "full-access", peerLink: false, cluster: true });
        expect(yield* main.cluster.memberOfSession(session.sessionId)).toEqual(
          Option.some(box.environmentId),
        );

        yield* add;
        expect(
          yield* main.auth.authenticateMcpClient(bearer(first.token)).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
        const second = yield* member.cluster.connectHost;
        expect(second.token).not.toBe(first.token);

        expect(yield* main.cluster.removeMember(box.environmentId)).toMatchObject({
          removed: true,
          memberNotified: true,
        });
        expect(
          yield* main.auth.authenticateMcpClient(bearer(second.token)).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
        expect(yield* member.cluster.connectHost.pipe(Effect.flip)).toMatchObject({
          reason: "unknown_member",
        });
      }),
    ),
);

it.effect("a member added without a route to its main host's tools says how to get one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* makeEnvironment(box);
      const invite = yield* member.cluster.invite({});
      // A main host from before agent routing, or one with no plain network address, sends no hostMcp.
      yield* member.cluster.acceptJoin({ code: invite.code, host: studio }, bot);
      expect(yield* member.cluster.connectHost.pipe(Effect.flip)).toMatchObject({
        reason: "no_host_mcp",
        message:
          "Studio gave this member no address for its tools, so agents here cannot reach other environments in the cluster. Remove this member on Studio and add it again.",
      });
    }),
  ),
);
```

`apps/server/src/persistence/reconcileV2PreviewMigration.test.ts`. In both expected lists (`:80` and `:201`), the rows after `[98, "ActiveShellIndexIndexes"],` must read:

```ts
        [99, "Cluster"],
        [100, "ClusterMcp"],
```

Plan 2 did not add `[99, "Cluster"]` here. Add it too if it is missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/server/src/cluster/ClusterService.test.ts apps/server/src/persistence/reconcileV2PreviewMigration.test.ts`

Expected: FAIL.

- The first new test fails with `no such column: host_mcp_cert_sha256`.
- The second fails with `member.cluster.connectHost` undefined.
- The reconcile lists miss `[100, "ClusterMcp"]`.

- [ ] **Step 3: Implement**

`apps/server/src/persistence/Migrations/100_ClusterMcp.ts`:

```ts
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The main host's `cluster-member` session for each member, revoked on removal or re-add.
  yield* sql`ALTER TABLE cluster_members ADD COLUMN mcp_session_id TEXT`;
  // A member pins its main host's certificate when its agents call that host's /mcp.
  yield* sql`ALTER TABLE cluster_membership ADD COLUMN host_mcp_cert_sha256 TEXT`;
});
```

`apps/server/src/persistence/Migrations.ts`:

```ts
import Migration0100 from "./Migrations/100_ClusterMcp.ts";
```

```ts
  [100, "ClusterMcp", Migration0100],
```

`packages/contracts/src/cluster.ts`. Replace `ClusterJoinRequest.hostMcp`:

```ts
  /** The main host's `/mcp` and a `cluster-member` token for this member's agents. */
  hostMcp: Schema.optionalKey(
    Schema.Struct({
      url: TrimmedNonEmptyString,
      token: TrimmedNonEmptyString,
      /** The main host's certificate, pinned when the member calls `url`. */
      certSha256: Schema.optionalKey(Schema.String),
    }),
  ),
```

Add `"no_host_mcp",` after `"ssh",` in `ClusterError.reason`.

`apps/server/src/cluster/ClusterService.ts`. Add the imports `* as DirectEndpoints from "../environment/DirectEndpoints.ts"` and `* as Option from "effect/Option"` if the latter is missing.

In `MemberRow`, after `last_error`:

```ts
  mcp_session_id: Schema.NullOr(Schema.String),
```

Below `MemberConnection`:

```ts
export interface HostConnection {
  readonly upstream: ClusterUpstream.Upstream;
  readonly token: string;
  readonly host: { readonly environmentId: EnvironmentId; readonly label: string };
}
```

In the `ClusterService` interface, after `connect`:

```ts
    /** Member side: the main host's `/mcp` and this member's `cluster-member` token for it. */
    readonly connectHost: Effect.Effect<HostConnection, ClusterError>;
    /** Main side: the member a `cluster-member` session was issued to. */
    readonly memberOfSession: (sessionId: string) => Effect.Effect<Option.Option<EnvironmentId>>;
```

In `acceptJoin`, replace the membership `INSERT` with:

```ts
        yield* sql`
          INSERT INTO cluster_membership (singleton, host_environment_id, host_label, joined_at, host_session_id, host_mcp_url, host_mcp_secret_name, host_mcp_cert_sha256)
          VALUES (1, ${input.host.environmentId}, ${input.host.label}, ${joinedAt}, ${session.sessionId}, ${input.hostMcp?.url ?? null}, ${mcpSecretName}, ${input.hostMcp?.certSha256 ?? null})
          ON CONFLICT (singleton) DO UPDATE SET
            host_label = excluded.host_label,
            host_session_id = excluded.host_session_id,
            host_mcp_url = excluded.host_mcp_url,
            host_mcp_secret_name = excluded.host_mcp_secret_name,
            host_mcp_cert_sha256 = excluded.host_mcp_cert_sha256
        `;
```

In `make`, after `const random = …`:

```ts
  const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
  /** The first plain address members can reach this host at, as https on the same port, where TLS is pinned. */
  const hostMcpUrl = directEndpoints.resolveAvailable().pipe(
    Effect.map((endpoints) => {
      const plain = endpoints
        .map((endpoint) => new URL(endpoint.httpBaseUrl))
        .find((url) => url.protocol === "http:");
      return plain === undefined ? undefined : `https://${plain.host}/mcp`;
    }),
  );
```

In `addMember`, replace everything from `const joined = yield* client.cluster` through the end of the storage `Effect.gen(…).pipe(…)` with:

```ts
      const mcpUrl = yield* hostMcpUrl;
      const memberMcp =
        mcpUrl === undefined
          ? undefined
          : yield* auth
              .issueClusterMemberSession({
                label: `Cluster member · ${input.label ?? descriptor.label}`,
                client: {},
              })
              .pipe(Effect.mapError(storageError));
      const revokeMemberMcp =
        memberMcp === undefined
          ? Effect.void
          : auth.revokeSession(memberMcp.sessionId).pipe(Effect.ignore);
      const joined = yield* client.cluster
        .join({
          payload: {
            code,
            host: { environmentId: self.environmentId, label: self.label },
            ...(mcpUrl === undefined || memberMcp === undefined
              ? {}
              : { hostMcp: { url: mcpUrl, token: memberMcp.token, certSha256: tls.fingerprint } }),
          },
        })
        .pipe(
          Effect.mapError(reachError(connection.origin)),
          Effect.tapError(() => revokeMemberMcp),
        );
      if (joined.environmentId !== descriptor.environmentId) {
        yield* revokeMemberMcp;
        return yield* new ClusterError({
          reason: "unreachable",
          message: `${connection.origin} answered as another environment while joining.`,
        });
      }
      const wasStandalone = (yield* role.current).role === "standalone";
      const previous = (yield* SubscriptionRef.get(rowsRef)).find(
        (row) => row.environment_id === joined.environmentId,
      );
      const secretName = `cluster-member-${Hex.encode(yield* random.randomBytes(16))}`;
      const target = resolved.target;
      yield* Effect.gen(function* () {
        yield* secrets.set(secretName, new TextEncoder().encode(joined.token));
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO cluster_members (environment_id, label, transport, url, ssh_target, cert_sha256, secret_name, status, joined_at, last_reached_at, last_error, mcp_session_id)
          VALUES (
            ${joined.environmentId}, ${input.label ?? joined.label}, ${target.transport},
            ${target.transport === "https" ? target.url : null},
            ${target.transport === "ssh" ? target.sshTarget : null},
            ${target.transport === "https" && target.url.startsWith("https:") ? target.certSha256 : null},
            ${secretName}, 'online', ${now}, ${now}, NULL, ${memberMcp?.sessionId ?? null}
          )
          ON CONFLICT (environment_id) DO UPDATE SET
            transport = excluded.transport, url = excluded.url, ssh_target = excluded.ssh_target,
            cert_sha256 = excluded.cert_sha256, secret_name = excluded.secret_name,
            status = 'online', last_reached_at = excluded.last_reached_at, last_error = NULL,
            mcp_session_id = excluded.mcp_session_id
        `;
        if (previous !== undefined) {
          tokens.delete(previous.secret_name);
          yield* secrets.remove(previous.secret_name);
          if (previous.mcp_session_id !== null) {
            yield* auth.revokeSession(AuthSessionId.make(previous.mcp_session_id));
          }
        }
      }).pipe(
        Effect.mapError(storageError),
        Effect.onError(() =>
          secrets.remove(secretName).pipe(Effect.ignore, Effect.andThen(revokeMemberMcp)),
        ),
      );
```

In `removeMember`, after `yield* secrets.remove(row.secret_name).pipe(Effect.mapError(storageError));`:

```ts
      if (row.mcp_session_id !== null) {
        yield* auth
          .revokeSession(AuthSessionId.make(row.mcp_session_id))
          .pipe(Effect.mapError(storageError));
      }
```

After `connect`:

```ts
  const connectHost: ClusterService["Service"]["connectHost"] = Effect.gen(function* () {
    yield* requireEnabled;
    const [row] = yield* sql<{
      readonly host_environment_id: string;
      readonly host_label: string;
      readonly host_mcp_url: string | null;
      readonly host_mcp_secret_name: string | null;
      readonly host_mcp_cert_sha256: string | null;
    }>`
      SELECT host_environment_id, host_label, host_mcp_url, host_mcp_secret_name, host_mcp_cert_sha256
      FROM cluster_membership WHERE singleton = 1
    `.pipe(Effect.mapError(storageError));
    if (row === undefined) {
      return yield* new ClusterError({
        reason: "unknown_member",
        message: "This environment is not a member of a cluster.",
      });
    }
    const noRoute = new ClusterError({
      reason: "no_host_mcp",
      message: `${row.host_label} gave this member no address for its tools, so agents here cannot reach other environments in the cluster. Remove this member on ${row.host_label} and add it again.`,
    });
    if (row.host_mcp_url === null || row.host_mcp_secret_name === null) return yield* noRoute;
    const stored = yield* secrets
      .get(row.host_mcp_secret_name)
      .pipe(Effect.mapError(storageError));
    if (Option.isNone(stored)) return yield* noRoute;
    const connection = yield* upstream.connect({
      transport: "https",
      url: row.host_mcp_url,
      certSha256: row.host_mcp_cert_sha256,
    });
    return {
      upstream: connection,
      token: new TextDecoder().decode(stored.value),
      host: { environmentId: EnvironmentId.make(row.host_environment_id), label: row.host_label },
    };
  }).pipe(Effect.withSpan("ClusterService.connectHost"));

  const memberOfSession: ClusterService["Service"]["memberOfSession"] = (sessionId) =>
    SubscriptionRef.get(rowsRef).pipe(
      Effect.map((rows) =>
        Option.fromNullishOr(rows.find((row) => row.mcp_session_id === sessionId)?.environment_id),
      ),
    );
```

Add `connectHost,` and `memberOfSession,` to the returned `ClusterService.of({ … })`. `DirectEndpoints` already reaches `layerMakeRoutes` from `layerRuntimeDependencies` (`apps/server/src/server.ts:821`), so `server.ts` needs no change here.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/cluster/ClusterService.test.ts apps/server/src/persistence/reconcileV2PreviewMigration.test.ts apps/server/src/persistence/Migrations.test.ts packages/contracts/src/cluster.test.ts`

Expected: PASS.

Run: `vp run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/persistence/Migrations/100_ClusterMcp.ts apps/server/src/persistence/Migrations.ts apps/server/src/persistence/reconcileV2PreviewMigration.test.ts packages/contracts/src/cluster.ts apps/server/src/cluster/ClusterService.ts apps/server/src/cluster/ClusterService.testkit.ts apps/server/src/cluster/ClusterService.test.ts
git commit -m "feat(server): cluster members get a route to the main host's MCP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: `PeerForwarding` routes cluster targets (one seam)

**Files:**

- Modify: `apps/server/src/peer/PeerForwarding.ts` (whole file, given below)
- Modify: `apps/server/src/mcp/McpToolAccess.ts:451`
- Modify: `apps/server/src/server.ts:888-894`. This is the links provide, plus the `ClusterService` provide that Plan 2 Tasks 6 and 7 placed directly above it.
- Test: `apps/server/src/peer/PeerForwarding.test.ts`:
  - `serveBox` (`:213-260`)
  - `makeLaptop` (`:275-372`)
  - new tests after "refuses a launch there above the link's access, naming the link"

**Interfaces:**

- Consumes:
  - `ClusterService.status`, `connect`, `connectHost`, `memberOfSession`, `members` and `probe`.
  - `PeerMcpClient.McpRoute`.
  - `McpClientCaller.cluster` and `McpInvocationScope.clustered`.
  - Testkit `layerRoutingMain`, `layerRoutingMember` and `clusterHostToken`.
- Produces: `PeerForwarding["Service"]["routeLabel"]: (environmentId) => Effect<Option<string>, OrchestratorMcpFailure>`. Routing rules:
  - **Standalone:** peer links, as today. The Linked environments beta is checked here and in `McpToolAccess`.
  - **Main host:** the target must be a member. `unknown_member` maps to `capability_denied`, with a pointer to `t3_environment_links`. A `cluster-member` caller that names its own member is refused.
  - **Member:** every other environment goes through the main host, and the call keeps `environmentId` unless the target is the main host itself. A call that arrived from the main host (`client.cluster`) and names another environment is refused.
  - Cluster calls skip the link-access check and the beta. `clusterEnabled` still gates them inside `ClusterService.connect` and `connectHost`.
  - A thread caller sends its own thread as `T3-Sender-Thread`. A cluster client caller passes on the sender it was given.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/peer/PeerForwarding.test.ts`. Add these imports:

```ts
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Schema from "effect/Schema";
import type * as ClusterService from "../cluster/ClusterService.ts";
import {
  clusterHostToken,
  layerRoutingMain,
  layerRoutingMember,
  type RoutedEnvironment,
} from "../cluster/ClusterService.testkit.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
```

Below `const box = …`:

```ts
const studio = descriptorOf("environment-studio", "Studio");
```

Change `serveBox` so it can serve the main host as well:

```ts
const serveBox = (
  seen: Ref.Ref<Seen>,
  linkSession: Ref.Ref<string>,
  descriptor = box,
  forwarding: Layer.Layer<PeerForwarding.PeerForwarding, unknown> = Layer.mock(
    PeerForwarding.PeerForwarding,
  )({}),
) =>
  servePeer(
    descriptor,
```

In its layer list:

- Replace `Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),` with `Layer.provide(forwarding),`.
- Replace `Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),` with:

```ts
      // A send there is never a follow-up to a task, here or on a main host passing it on.
      Layer.provide(
        Layer.mock(RemoteDelegation.RemoteDelegation)({
          followUp: (_scope, _environmentId, _request, sent) => Effect.succeed(sent),
        }),
      ),
```

Below `serveBox`, add:

```ts
/** The main host's own forwarding, whose cluster is `cluster`. */
const layerMainForwarding = (cluster: Layer.Layer<ClusterService.ClusterService>) =>
  PeerForwarding.layer.pipe(
    Layer.provide(cluster),
    Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
    Layer.provide(layerLinkingEnvironment(studio)),
  );

/** Another environment on a socket of its own. */
const serveApart = <A, E, R>(serve: Effect.Effect<A, E, R>) =>
  Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
    Effect.flatMap((server) => serve.pipe(Effect.provideContext(server))),
  );
```

Change `makeLaptop`:

- `const makeLaptop = Effect.gen(function* () {` becomes `const makeLaptopWith = (cluster: Layer.Layer<ClusterService.ClusterService> = Layer.empty) => Effect.gen(function* () {`.
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
  return {
    links: Context.get(linking, PeerLinks.PeerLinks),
    peers: Context.get(linking, PeerMcpClient.PeerMcpClient),
    settings: Context.get(linking, ServerSettings.ServerSettingsService),
    forwarding: Context.get(here, PeerForwarding.PeerForwarding),
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
      const callers = yield* Ref.make<ReadonlyMap<string, EnvironmentId>>(new Map());
      const main = yield* serveApart(
        serveBox(
          yield* Ref.make<Seen>(nothingSeen),
          yield* Ref.make(""),
          studio,
          layerMainForwarding(layerRoutingMain(members, callers)),
        ),
      );
      const memberMcp = yield* main.auth.issueClusterMemberSession({
        label: "Cluster member · Laptop",
        client: {},
      });
      yield* Ref.set(callers, new Map([[memberMcp.sessionId, laptop.environmentId]]));
      const a = yield* makeLaptopWith(
        layerRoutingMember({ descriptor: studio, url: main.url, token: memberMcp.token }),
      );

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
      // The main host passes on which thread here sent it.
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

      // The main host refuses a member naming itself...
      const httpClient = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const looped = yield* a.peers
        .call({
          environmentId: studio.environmentId,
          route: {
            key: "direct",
            origin: main.url,
            token: memberMcp.token,
            httpClient,
            messages: { name: "Studio", revoked: "revoked", off: "off", unreachable: "unreachable" },
            recordOutcome: () => Effect.void,
          },
          tool: "t3_thread_read",
          arguments: { environmentId: laptop.environmentId, threadId: "thread:laptop-full" },
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          success: Schema.Unknown,
        })
        .pipe(Effect.flip);
      expect(looped).toMatchObject({
        code: "invalid_request",
        message: "That environmentId is the calling environment's own. Leave out environmentId to act there.",
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
      // A main host that served once and is gone: nothing listens there now.
      const gone = yield* Effect.scoped(
        serveApart(servePeer(studio, Layer.empty)).pipe(Effect.map((peer) => peer.url)),
      );
      const a = yield* makeLaptopWith(
        layerRoutingMember({ descriptor: studio, url: gone, token: "unused" }),
      );
      const read = yield* a.call("thread:laptop-full", "t3_thread_read", {
        environmentId: box.environmentId,
        threadId: boxThread,
      });
      // Not final: a follower keeps trying until the main host is back.
      expect(failureOf(read)).toMatchObject({
        code: "orchestration_error",
        message:
          'Cluster host unreachable: "Studio" is not answering, so other environments in the cluster cannot be reached. Work here continues.',
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/server/src/peer/PeerForwarding.test.ts`

Expected: FAIL.

- The first new test gets `linked_environments_off` / `capability_denied`, "Linked environments is off on this machine…", from `McpToolAccess`.
- The second gets "This environment cannot reach linked environments." or an unknown-link refusal, because nothing routes through `ClusterService`.
- Typecheck reports that `routeLabel` is missing.

- [ ] **Step 3: Implement**

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

/** A removed member, or one without a route to its host, is final: a task there fails rather than retries. */
const fromClusterError = (error: ClusterError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "unknown_member" || error.reason === "no_host_mcp"
        ? "capability_denied"
        : "orchestration_error",
    message:
      error.reason === "unknown_member"
        ? `${error.message} t3_environment_links lists this cluster's environments.`
        : error.message,
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

  const memberRoute = (
    service: ClusterService.ClusterService["Service"],
    connection: ClusterService.MemberConnection,
  ): PeerMcpClient.McpRoute => {
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
      // The probe records why: offline, revoked or incompatible.
      recordOutcome: (error) =>
        error === null
          ? Effect.void
          : service
              .probe(connection.member.environmentId)
              .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid),
    };
  };

  const hostRoute = (connection: ClusterService.HostConnection): PeerMcpClient.McpRoute => {
    const name = `The cluster's main host "${connection.host.label}"`;
    return {
      key: `cluster ${connection.host.environmentId} ${connection.upstream.origin}`,
      origin: connection.upstream.origin,
      token: connection.token,
      httpClient: connection.upstream.httpClient,
      messages: {
        name,
        revoked: `${name} no longer accepts this member. Leave the cluster here, then ask for a new invite.`,
        off: `${name} has clusters turned off. Turn them on in its Settings → Labs.`,
        unreachable: `Cluster host unreachable: "${connection.host.label}" is not answering, so other environments in the cluster cannot be reached. Work here continues.`,
      },
      recordOutcome: () => Effect.void,
    };
  };

  /**
   * How a call for `environmentId` leaves a clustered environment: straight to a member from
   * the main host, or through the main host from a member. Undefined outside a cluster, where
   * it goes over a peer link. Cluster traffic is full trust: no link fence, only the caller's modes.
   */
  const clusterRoute = Effect.fn("PeerForwarding.clusterRoute")(function* (
    scope: Scope,
    environmentId: EnvironmentId,
  ) {
    const state = yield* clusterState;
    if (state === undefined || cluster === undefined) return undefined;
    if (state.role === "main") {
      if (scope.client?.cluster === true) {
        const caller = yield* cluster.memberOfSession(scope.client.sessionId);
        if (Option.isSome(caller) && caller.value === environmentId) return yield* callerItself;
      }
      const connection = yield* cluster
        .connect(environmentId)
        .pipe(Effect.mapError(fromClusterError));
      return { route: memberRoute(cluster, connection), passTarget: false };
    }
    if (scope.client?.cluster === true) return yield* clusterLoop;
    const connection = yield* cluster.connectHost.pipe(Effect.mapError(fromClusterError));
    return {
      route: hostRoute(connection),
      // The main host runs a call for itself; one for another member it sends on.
      passTarget: environmentId !== connection.host.environmentId,
    };
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
    return yield* peers.call({
      environmentId,
      ...(viaCluster === undefined ? {} : { route: viaCluster.route }),
      tool: toolName,
      arguments: viaCluster?.passTarget === true ? { ...args, environmentId } : args,
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

`apps/server/src/mcp/McpToolAccess.ts:451`. Change it to:

```ts
        if (scope.linkedEnvironments === false && scope.clustered !== true)
          return yield* PeerForwarding.linkedEnvironmentsOff;
```

`apps/server/src/server.ts`. `PeerForwarding` reads `ClusterService` through `serviceOption`, so it must be built where `ClusterService` is already in its context. `Layer.provide(ClusterService.layer…)`, which Plan 2 placed above the links provide, only feeds the routes and never feeds `PeerForwarding.layer`. Make these changes:

1. Cut the whole `ClusterService.layer.pipe(…)` expression out of Plan 2's `Layer.provide(…)`, byte for byte with its `ServerTls` and `ClusterUpstream` provides.
2. Delete the now-empty `Layer.provide(` wrapper and the comment `// Clusters: joins, members and the proxy…` above it.
3. Paste the cut expression as `Layer.provideMerge(<expression>)` between `PeerForwarding.layer.pipe(` and `Layer.provideMerge(PeerMcpClient.layer)`.

Then change the comment above the provide to:

```ts
  // Links to other environments and the cluster, shared by Settings (WebSocket) and agents (/mcp).
```

The block now has three `provideMerge`s, in this order: `ClusterService`, `PeerMcpClient`, `PeerLinks`. `ClusterService` takes `PeerLinks` from the `provideMerge` below it. Everything in `layerMakeRoutes` still sees `ClusterService` through the merge.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/peer/PeerForwarding.test.ts apps/server/src/peer/PeerMcpClient.test.ts apps/server/src/mcp/McpToolAccess.test.ts apps/server/src/mcp/McpToolAccess.race.test.ts`

Expected: PASS.

Run: `vp run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/peer/PeerForwarding.ts apps/server/src/peer/PeerForwarding.test.ts apps/server/src/mcp/McpToolAccess.ts apps/server/src/server.ts
git commit -m "feat(server): agents act on cluster environments through the main host

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: Remote delegation to cluster members

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

- Consumes: `PeerForwarding.routeLabel` and testkit `layerRoutingMain`, `clusterHostToken` and `RoutedEnvironment`.
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

## Task 6: Agents list the cluster

**Files:**

- Modify: `packages/contracts/src/orchestratorMcp.ts`:
  - `OrchestratorMcpEnvironmentTarget` (`:339-344`)
  - after `OrchestratorMcpEnvironmentLink` (`:668-678`)
  - `OrchestratorMcpEnvironmentLinksResult` (`:680-685`)
- Modify: `apps/server/src/mcp/McpInvocationContext.ts:195-200` (`hiddenWhileLinksOff`, plus a new predicate)
- Modify: `apps/server/src/mcp/toolkits/orchestrator/tools.ts:323-335` (`EnvironmentLinksTool`)
- Modify: `apps/server/src/peer/PeerForwarding.ts` (`listLinks`)
- Modify: `evals/mcp-tool-use/cases/orchestration.ndjson` (append one case)
- Test: `apps/server/src/peer/PeerForwarding.test.ts`. Extend the two cluster tests from Task 4.

**Interfaces:**

- Consumes: `ClusterMemberStatus` (`packages/contracts/src/cluster.ts`), `ClusterService.members` and `connectHost`.
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
              'Cluster host unreachable: "Studio" is not answering, so other environments in the cluster cannot be reached. Work here continues.',
          },
        ],
      });
```

Append to `evals/mcp-tool-use/cases/orchestration.ndjson` (one line):

```json
{"id": "cluster-member-delegates-by-id", "area": "orchestration", "kind": "guard", "pattern": "cluster machine reached through t3_environment_links", "experience": "In a cluster the user's other machines are listed under `cluster`, with no links; an agent that reads only `links` asks to link a machine it can already reach.", "rule": "A machine listed under `cluster` is reached by passing its environmentId, as delegate_task target.environmentId; it is never linked.", "privacy": "commit-safe", "setup": {"role": "top", "linkedEnvironments": true, "mocks": {"t3_environment_links": {"environmentId": "environment-laptop", "links": [], "cluster": [{"environmentId": "environment-studio", "label": "Studio", "role": "main-host", "status": "online", "lastError": null}, {"environmentId": "environment-gpu", "label": "GPU box", "role": "member", "status": "online", "lastError": null}], "notListed": "Not listed: this environment is in a cluster, which takes no links. The user adds machines on the main host, in Settings → Cluster."}}}, "prompt": "Delegate this to my GPU box: run `nvidia-smi` there and tell me the result. Do not edit any files here.", "expect": {"calls": [{"tool": "delegate_task", "args": {"target.environmentId": "environment-gpu"}}], "notCalls": ["t3_environment_link"]}, "source": {"spec": "docs/superpowers/specs/2026-11-19-environment-cluster-design.md#agents"}}
```

- [ ] **Step 2: Run the tests and the eval baseline to verify they fail**

Run: `vp test run apps/server/src/peer/PeerForwarding.test.ts -t "cluster"`

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
    const reached = yield* service.connectHost.pipe(
      Effect.mapError(fromClusterError),
      Effect.flatMap((connection) =>
        peers.call({
          environmentId: host.environmentId,
          route: hostRoute(connection),
          tool: "t3_environment_links",
          arguments: {},
          limits,
          success: OrchestratorMcpEnvironmentLinksResult,
        }),
      ),
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

## Task 7: Internal docs

**Files:**

- Modify: `docs/internals/environment-auth.md`. Add a subsection after Plan 2's "### A cluster member trusts only its main host".

This task adds no test: it changes only docs.

- [ ] **Step 1: Document the agent hairpin and its trust**

Append:

```md
### Agents cross the cluster through the main host

A member's agents reach other environments only through the main host's `/mcp`,
using the `cluster-member` token the main host minted when it added the member
([PeerForwarding](../../apps/server/src/peer/PeerForwarding.ts)). The main host
sends the call on with its `cluster-host` token and the calling agent's
`T3-Mode-Limit`, so the target caps it to that agent's modes. Cluster calls are
full trust: they carry no `linkOrigin`, so the link fence never applies, while a
peer link below full access stays fenced. The main host sends calls on without
`environmentId`, so a member refuses a call from it that names another
environment rather than bouncing it back. The member calls
`https://<main host's first LAN or tailnet address>/mcp`, pinned to its
certificate. A main host with no such address hands out no route, and its
members' agents are told to re-add the member.
```

- [ ] **Step 2: Commit**

```bash
git add docs/internals/environment-auth.md
git commit -m "docs: cluster agent routing and its trust

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run: `vp test run apps/server/src/auth/EnvironmentAuth.test.ts apps/server/src/cluster apps/server/src/peer apps/server/src/mcp/McpToolAccess.test.ts apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/persistence/reconcileV2PreviewMigration.test.ts apps/server/src/persistence/Migrations.test.ts`

  Expected: PASS.

- [ ] Run: `vp run check:changed`

  Expected: clean. It covers format, lint, knip (`PeerLinks` is no longer imported by `RemoteDelegation`), typecheck and the tests beside the changes.

- [ ] Integrated pass, run once by the primary agent after Plan 3's client route lands:
  1. Start three dev servers in separate worktree `.t3` homes. One is the main host and two are members, joined over HTTPS.
  2. Using the free `Replay (dev)` provider on member A, run `delegate_task` with `target.environmentId` set to member B.
  3. Confirm that B's thread runs and that A's task completes.
  4. Stop the main host and confirm that A's agent hears "Cluster host unreachable".

---

## Self-Review Against the Spec

| Spec item ("Agents", plus related rows) | Where |
| --- | --- |
| Main host: `environmentId` tools forward to the member's `/mcp` with `cluster-host` | Task 4 (`clusterRoute` main branch, `ClusterService.connect`) |
| Each member gets a `cluster-member` MCP credential at join | Task 1 (subject, `/mcp`-only), Task 3 (`addMember` mints it, `acceptJoin` stores it) |
| Member agent targeting another member calls the main host's `/mcp`, which forwards; all traffic hairpins | Task 4 (`clusterRoute` member branch, `passTarget`), three-environment test |
| Forwarded-wait limits ≤ 50 s | Task 4: `waitThere` caps every hop at 45 s; tests assert `[45_000]` direct and hairpinned |
| Revoke on remove/leave | Task 3: `removeMember` and re-add revoke the session. Leave from the member deletes its copy (Plan 2 `leave`); the main host's session ends when the admin removes the then-`revoked` member |
| "main host down … member agents get "cluster host unreachable" … local work continues" | Tasks 2 and 4 (`hostRoute.messages.unreachable`, `orchestration_error`, not final) |
| Cluster separate from peer links; no fence for full trust | Task 4: cluster routes skip the beta and link access, and an `auto` link is still fenced on the same box. Task 6 hides link and unlink tools while clustered |
| `clusterEnabled` gates both sides | `ClusterService.connect` / `connectHost` (`requireEnabled`) |
| `delegate_task` to a member, including startup re-follow | Task 5 (restart test, removal test) |
| Agents can discover members | Task 6 (`cluster` in `t3_environment_links`, eval case) |
| Status `online | offline | incompatible | revoked` | Task 6 uses `ClusterMemberStatus`; a failed call to a member triggers `probe` (Task 4) |

### Resolved ambiguities

An implementer should not reopen these choices:

1. **One seam.** `PeerForwarding.forward` resolves the route. Peer links and the cluster share the rest of `PeerMcpClient`: sessions, 404 renewal, mode and sender headers. `RemoteDelegation` and the toolkits do not change their routing.
2. **The main host's address for members** is the first plain `DirectEndpoints` address, served as `https:` on the same port and pinned to the main host's own certificate. This adds `ClusterJoinRequest.hostMcp.certSha256`. There is no UI field for it. A main host that binds only to loopback, or that sits behind NAT with only T3 Connect, gives its members no route. Their agents get `no_host_mcp` with the fix.
3. **Error finality.** These map to `capability_denied`, which is final for `RemoteDelegation`:
   - An unknown or removed member.
   - A missing route to the host.
   - A revoked credential.

   A host or member that does not answer, or has clusters off, maps to `orchestration_error`, which is retried.
4. **Loops.** The main host refuses a member that names itself. A member refuses any call from its main host that names another environment. An unknown id on the main host is `unknown_member`.
5. **Labels.** On a member, the label of another member is its `environmentId`. Only the main host's name is known locally, and `t3_environment_links` shows the real names.
6. **Listing.** `t3_environment_links` gains an optional `cluster` array instead of a new tool. A member asks its main host for the list. When the main host is down, the member lists the main host as `offline` with the unreachable message and does not fail.
7. **The `cluster-member` token** lasts as long as `cluster-host` (10 years). It is revoked by `removeMember` and by re-adding the member.
