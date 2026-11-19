# Cluster 3: Clients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web, desktop and mobile clients connected only to a main host see and drive every cluster member as an ordinary environment ("via <main host>"), and can invite, add, rename, remove and leave from Settings → Environments → Cluster behind the Labs flag.

**Architecture:** All connection logic lives in `packages/client-runtime`. A new `ClusterConnectionTarget` route borrows the main host's *current* prepared connection (cookie, bearer or DPoP), published by a small `ClusterHosts` service, and points it at `<main>/cluster/<memberId>`. A watcher in the connection layer follows every connected host that advertises `capabilities.cluster`, subscribes to `cluster.members`, and calls a new `EnvironmentRegistry.reconcileCluster` that installs members as ephemeral (never persisted) entries and drops them when they leave the list. The existing supervisor, driver and retry policy handle members unchanged; proxy `502`s arrive as undeclared statuses and retry as transient failures. Path-prefixed base URLs require the few origin-only URL builders to keep the base path. Web and mobile add a Cluster section on the Environments screen, a Labs switch, and a "Managed by cluster" notice on peer-link screens.

**Tech Stack:** Effect 4 (`Context.Service`, `Effect.fn`, `Stream`, `SubscriptionRef`), `effect/reactivity` atoms via `createEnvironmentRpc*` helpers, React 19 + base-ui `components/ui` (web), React Native + `gt-react-native` (mobile), `gt-i18n` `msg()` in shared code, `@effect/vitest` / `vite-plus/test`.

**Spec:** `docs/superpowers/specs/2026-11-19-environment-cluster-design.md`

## Global Constraints

Verbatim from the spec; every task honours them.

- "**Main host proxies.** Clients reach members through the main host, never directly."
- "Credential brokerage is out of scope: clients authenticate only to the main host and never receive member credentials."
- "New connection route `Cluster { hostEnvironmentId, memberId }` whose base URL is `<main-url>/cluster/<memberId>`, in `packages/client-runtime`."
- "The main host publishes members and statuses through a `cluster.members` subscription. Clients add members to the registry ephemerally (not saved in the catalog) and drop them when they leave the list."
- "The existing connection runtime handles drivers, reconnects, and capability checks for member environments. Web, desktop, and mobile share this."
- "member unreachable | proxy `502 {code:"cluster_member_unreachable", memberId}`; client treats as disconnect and retries; member shown offline".
- "Member status: `online | offline | incompatible | revoked`."
- "Settings → Cluster on web, desktop, and mobile, behind the Labs flag." Standalone: "Invite to cluster, Add member". Main host: "member list (label, transport, status dot, last seen, last error), rename, remove". Member: "main host name, Leave cluster". "Mobile adds members by join string only; SSH needs desktop or a headless main host."
- "Members appear as ordinary environments labeled "via <main host>". Offline members stay listed, dimmed, with the reason."
- "Peer link screens on clustered environments show "Managed by cluster <name>" instead of controls."
- "New strings ship in every web and mobile locale."
- "`docs/user`: Cluster section (what it is, invite, SSH add, leave)."
- "Client runtime: `cluster.members` adds and removes registry entries; `Cluster` route resolves its URL."
- Repo rules (AGENTS.md): shared client logic in `packages/client-runtime`; `components/ui` exports own their look (pick `variant`/`size`, layout classes only on parents, see `docs/internals/web-ui.md`); client mutations use `createEnvironmentRpcCommand` and its `permissionAtom`; React effects only for external sync; i18n via `vp run i18n:generate` then hand translations, gated by `vp run i18n:check`; logic tests beside the code, no browser tests for logic; `vp test run <files>`; `vp run typecheck`; no `vp check` or repo-wide test runs; minimal comments; tests at the lowest layer that fails on `main`, extending existing files; no sleeps, polling or timeouts in tests; subagents never launch dev servers.

## Interfaces With Other Plans

**Consumed from Plan 2 (`docs/superpowers/plans/2026-11-19-cluster-2-server-core.md`, Tasks 1 and 9), exact names:**

- `@t3tools/contracts`: `ClusterMember` (`environmentId`, `label`, `transport`, `address`, `status`, `joinedAt`, `lastReachedAt`, `lastError`), `ClusterMemberStatus`, `ClusterStatus` (`enabled`, `role`, `fingerprint`, `host`), `ClusterInvite` (`code`, `fingerprint`, `joinString`, `expiresAt`), `ClusterRemoveMemberResult` (`removed`, `memberNotified`), `clusterMemberBaseUrl(hostBaseUrl, memberId)`, `parseClusterJoinString`, `parseClusterSshTarget`.
- `WS_METHODS.clusterStatus`, `WS_METHODS.clusterMembers` (stream of `ReadonlyArray<ClusterMember>`, current list first), and guarded `WS_METHODS.clusterInvite`, `clusterAddMember`, `clusterRemoveMember`, `clusterRenameMember`, `clusterLeave` (all `access:write`, in `CLIENT_GUARDED_RPC_SCOPES`).
- `ExecutionEnvironmentCapabilities.cluster`, `ServerSettings.clusterEnabled`.
- Proxy: `POST …/api/auth/websocket-ticket[/rpc|/media]` under `/cluster/<id>` answered with a main-host ticket for the caller's session, so a member connect is the ordinary ticket-then-socket flow against the prefixed base URL. Failures `502 {code: "cluster_member_unreachable" | "cluster_member_incompatible" | "cluster_member_revoked", memberId}`, `403 {code: "cluster_disabled"}`, `404` for an unknown member. The client does not parse these bodies: `502`/`403` are `RemoteEnvironmentAuthUndeclaredStatusError`, which `mapRemoteEnvironmentError` already maps to a transient `remote-unavailable` failure, so the supervisor retries with its backoff. The member's reason comes from `ClusterMember.status`/`lastError`.

**Consumed from Plan 1:** nothing at code level. The member's HTTPS listener on its own port is what the join string's `https://` origin reaches.

**Produced (for later work):** `ClusterConnectionTarget`, `ClusterHosts`, `EnvironmentRegistry.reconcileCluster`, `@t3tools/client-runtime/state/cluster` (`createClusterEnvironmentAtoms`, `offersCluster`, `clusterAddTarget`, `clusterName`, `clusterMemberStatusText`, `defaultClusterInviteUrl`), `PreparedHttpAuthorization` Dpop `issuedFor`.

## Review Focus

Untested failure modes most likely to bite, each with the test that pins it:

1. **Main host reconnects and `cluster.members` replays the full list.** The subscription resubscribes on every new session and emits the whole list again; a non-idempotent reconcile would restart every member's supervisor (dropping live sockets) or duplicate entries. Test: Task 5, "lists a main host's members without saving them, and a replayed list changes nothing".
2. **A member was already saved in the user's catalog before it joined.** Its saved route now fails (the member revoked non-loopback sessions) or still works (SSH forward, loopback). The saved entry must not be replaced, deleted, or re-persisted with a cluster route, and removing it lets the cluster entry appear. Test: Task 5, "a member saved on this device keeps its saved entry until the user removes it".
3. **Member removed while its thread view is open.** The view's durable stream must stop instead of retrying against a forgotten environment, and later commands fail as "not registered". Test: Task 5, "a member that leaves the list ends streams that follow it".
4. **Capability absent on an older main host.** Subscribing to `cluster.members` on a server without the RPC would fail or defect every session; the watcher and every UI gate must read `capabilities.cluster`. Tests: Task 4, "only a host that advertises the capability serves members"; Task 7, "offers the cluster only where the capability and the Labs flag are both on".
5. **Join string pasted with whitespace or line breaks** (terminal wrap, chat paste). Plan 2's parser trims only the ends. Test: Task 7, "accepts a join string pasted with spaces and line breaks".

## File Map

Create:

- `packages/client-runtime/src/connection/clusterHosts.ts`, `clusterHosts.test.ts`
- `packages/client-runtime/src/state/cluster.ts`, `cluster.test.ts`
- `apps/web/src/state/cluster.ts`
- `apps/web/src/components/settings/ClusterSettings.tsx`
- `apps/mobile/src/state/cluster.ts`
- `apps/mobile/src/features/connection/ClusterSection.tsx`

Modify: `packages/client-runtime/src/environment/{endpoint,endpoint.test}.ts`, `packages/client-runtime/src/rpc/{http,client}.ts`, `packages/client-runtime/src/state/{assets,assets.test}.ts`, `packages/shared/src/{preview,preview.test}.ts`, `packages/client-runtime/src/connection/{model,routes,routes.test,presentation,resolver,resolver.test,registry,registry.test,driver,layer}.ts`, `packages/client-runtime/src/platform/storageDocument.ts`, `packages/client-runtime/src/authorization/{service,layer.test}.ts`, `packages/client-runtime/src/state/environmentHttpAuth.ts`, `packages/client-runtime/package.json`, `apps/web/src/components/settings/{LabsSettingsPanel,settingsSearch,settingsSearch.test,useAvailableSettingsSearchItems,ConnectionsSettings,EnvironmentRow,LinkedEnvironmentsSettings}.tsx|ts`, `apps/mobile/src/features/settings/{ThreadSettingsSections,EnvironmentRoutesSection}.tsx`, `apps/mobile/src/features/connection/{ConnectionsRouteScreen,LinkedEnvironmentsSection}.tsx`, `apps/{web,mobile}/src/i18n/translations/*.json`, `docs/user/remote-access.md`, `docs/internals/connection-runtime.md`.

---

## Task 1: Environment URLs keep their base path

A member's base URL is `https://main/cluster/<id>`. Four helpers rebuild URLs from the origin alone and would send member requests to the main host's own `/api`, `/.well-known` and `/ws`.

**Files:**

- Modify: `packages/client-runtime/src/environment/endpoint.ts:3-9`
- Modify: `packages/client-runtime/src/rpc/http.ts:108-114` (`remoteApiBaseUrl`)
- Modify: `packages/client-runtime/src/state/assets.ts:60-66` (`resolveAssetUrl`)
- Modify: `packages/shared/src/preview.ts:29-31` (`previewPdfAssetUrl` rewrite)
- Test: `packages/client-runtime/src/environment/endpoint.test.ts`, `packages/client-runtime/src/state/assets.test.ts`, `packages/shared/src/preview.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `environmentEndpointUrl(httpBaseUrl, pathname)`, `makeEnvironmentHttpApiGroupClient`/`makeEnvironmentHttpApiUrlBuilder`, `resolveAssetUrl`, `previewPdfAssetUrl` all honour a base path. Bases with path `/` behave exactly as before.

- [ ] **Step 1: Write the failing tests**

`packages/client-runtime/src/environment/endpoint.test.ts` — change the import to `import { deriveWsBaseUrl, environmentEndpointUrl, normalizeHttpBaseUrl } from "./endpoint.ts";`, add `import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";`, and add inside the `describe`:

```ts
  it("keeps a cluster member's path prefix on every endpoint", () => {
    const member = "https://studio.example.test/cluster/environment-box";
    expect(environmentEndpointUrl(member, "/.well-known/t3/environment")).toBe(
      "https://studio.example.test/cluster/environment-box/.well-known/t3/environment",
    );
    expect(environmentEndpointUrl("https://studio.example.test/", "/api/auth/session")).toBe(
      "https://studio.example.test/api/auth/session",
    );
    expect(
      makeEnvironmentHttpApiUrlBuilder(member).auth.webSocketTicketFor({ params: { use: "rpc" } }),
    ).toBe("https://studio.example.test/cluster/environment-box/api/auth/websocket-ticket/rpc");
  });
```

`packages/client-runtime/src/state/assets.test.ts` — add `resolveAssetUrl` to the existing `./assets.ts` import and append at the end of the file:

```ts
it("keeps a cluster member's path prefix on root-relative asset URLs", () => {
  expect(
    resolveAssetUrl("https://studio.example.test/cluster/environment-box", "/api/assets/t/a.png"),
  ).toBe("https://studio.example.test/cluster/environment-box/api/assets/t/a.png");
  expect(resolveAssetUrl("https://studio.example.test/", "/api/assets/t/a.png")).toBe(
    "https://studio.example.test/api/assets/t/a.png",
  );
});
```

`packages/shared/src/preview.test.ts` — inside `describe("previewPdfAssetUrl")`:

```ts
  it("loads a cluster member's PDF bytes under its path on the main host", () => {
    expect(
      previewPdfAssetUrl(
        "http://127.0.0.1:14537/api/assets/token/guide.pdf#page=2",
        "https://studio.example.test/cluster/environment-box",
      ),
    ).toBe("https://studio.example.test/cluster/environment-box/api/assets/token/guide.pdf#page=2");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/client-runtime/src/environment/endpoint.test.ts packages/client-runtime/src/state/assets.test.ts packages/shared/src/preview.test.ts`
Expected: FAIL — three new tests; e.g. `expected 'https://studio.example.test/.well-known/t3/environment' to be 'https://studio.example.test/cluster/environment-box/.well-known/t3/environment'`.

- [ ] **Step 3: Implement**

`packages/client-runtime/src/environment/endpoint.ts`:

```ts
export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  // A cluster member's base carries its main host's `/cluster/<id>` prefix.
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
```

`packages/client-runtime/src/rpc/http.ts`:

```ts
const remoteApiBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
```

`packages/client-runtime/src/state/assets.ts`:

```ts
export function resolveAssetUrl(httpBaseUrl: string, relativeUrl: string): string | null {
  try {
    const base = new URL(httpBaseUrl);
    return relativeUrl.startsWith("/") && !relativeUrl.startsWith("//")
      ? new URL(`${base.pathname.replace(/\/+$/, "")}${relativeUrl}`, base).toString()
      : new URL(relativeUrl, base).toString();
  } catch {
    return null;
  }
}
```

`packages/shared/src/preview.ts`, the final `return` inside `try`:

```ts
    return new URL(
      `${baseUrl.pathname.replace(/\/+$/, "")}${url.pathname}${url.search}${url.hash}`,
      baseUrl,
    ).href;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run packages/client-runtime/src/environment/endpoint.test.ts packages/client-runtime/src/state/assets.test.ts packages/shared/src/preview.test.ts packages/client-runtime/src/authorization/remote.test.ts packages/client-runtime/src/authorization/layer.test.ts`
Expected: PASS (existing root-path cases unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/client-runtime/src/environment/endpoint.ts packages/client-runtime/src/environment/endpoint.test.ts packages/client-runtime/src/rpc/http.ts packages/client-runtime/src/state/assets.ts packages/client-runtime/src/state/assets.test.ts packages/shared/src/preview.ts packages/shared/src/preview.test.ts
git commit -m "fix(client-runtime): environment URLs keep their base path

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: `ClusterConnectionTarget` route

**Files:**

- Modify: `packages/client-runtime/src/connection/model.ts:1` (import), after `:43` (class), `:44-50` (union), `:147-157` (Dpop `issuedFor`)
- Modify: `packages/client-runtime/src/connection/routes.ts:19-26` (kind), `:31-41` (`connectionRouteId`), `:92-108` (`connectionRouteKind`), `:133-141` (rank), `:197-230` (labels)
- Modify: `packages/client-runtime/src/connection/presentation.ts:186-203` (`connectionCatalogDisplayUrl`)
- Modify: `packages/client-runtime/src/platform/storageDocument.ts:61-70` (`connectionIdOf`)
- Modify: `packages/client-runtime/src/rpc/client.ts:61-74` (`EnvironmentSubscriptionRpcTag`)
- Modify: `apps/mobile/src/features/settings/EnvironmentRoutesSection.tsx:43-51` (`ROUTE_ICONS`)
- Modify: `apps/web/src/components/settings/EnvironmentRow.tsx:26-31` (`environmentTransportLabel`)
- Test: `packages/client-runtime/src/connection/routes.test.ts`

**Interfaces:**

- Consumes: `ClusterMemberStatus`, `WS_METHODS.clusterMembers` (Plan 2).
- Produces:

```ts
export class ClusterConnectionTarget extends Schema.TaggedClass<ClusterConnectionTarget>()(
  "ClusterConnectionTarget",
  { environmentId: EnvironmentId; label: string; hostEnvironmentId: EnvironmentId; hostLabel: string;
    status: ClusterMemberStatus; statusDetail: string | null },
) {}
```

`environmentId` is the spec's `memberId`. `ConnectionTarget` gains it; `PersistedConnectionTarget` does not. `ConnectionRouteKind` gains `"cluster"`; route id `cluster:<hostEnvironmentId>`; label `via <hostLabel>`; `routeHttpBaseUrl` is `null` (no own address, so the driver's route check is `unchecked` and the resolver decides). `PreparedHttpAuthorization` Dpop gains `issuedFor?: EnvironmentId`.

- [ ] **Step 1: Write the failing test**

`packages/client-runtime/src/connection/routes.test.ts` — change `import { BearerConnectionTarget, RelayConnectionTarget } from "./model.ts";` to also import `ClusterConnectionTarget`, add `routeHttpBaseUrl` to the `./routes.ts` import, and append:

```ts
it("names a cluster member's route after its main host and gives it no address", () => {
  const route = {
    target: new ClusterConnectionTarget({
      environmentId: EnvironmentId.make("environment-box"),
      label: "Box",
      hostEnvironmentId: EnvironmentId.make("environment-studio"),
      hostLabel: "Studio",
      status: "online",
      statusDetail: null,
    }),
    profile: Option.none(),
  };
  expect(connectionRouteId(route.target)).toBe("cluster:environment-studio");
  expect(connectionRouteKind(route)).toBe("cluster");
  expect(connectionRouteLabel(route)).toBe("via Studio");
  expect(routeHttpBaseUrl(route)).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run packages/client-runtime/src/connection/routes.test.ts -t "cluster member"`
Expected: FAIL — `ClusterConnectionTarget is not a constructor`.

- [ ] **Step 3: Implement**

`model.ts` line 1: `import { ClusterMemberStatus, EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";`. After `SshConnectionTarget`:

```ts
/** A cluster member reached through its main host's `/cluster/<memberId>` proxy. Never saved. */
export class ClusterConnectionTarget extends Schema.TaggedClass<ClusterConnectionTarget>()(
  "ClusterConnectionTarget",
  {
    ...ConnectionTargetBase,
    hostEnvironmentId: EnvironmentId,
    hostLabel: Schema.String,
    status: ClusterMemberStatus,
    /** The main host's last error for the member. */
    statusDetail: Schema.NullOr(Schema.String),
  },
) {}
```

Add `ClusterConnectionTarget,` as the last member of `ConnectionTarget`'s union (not of `PersistedConnectionTarget`). In `PreparedHttpAuthorization`'s Dpop arm:

```ts
  | {
      readonly _tag: "Dpop";
      readonly accessToken: string;
      readonly expiresAtEpochMs: number;
      /** The environment the token was minted for, when it reaches another (a cluster member). */
      readonly issuedFor?: EnvironmentId;
    };
```

`routes.ts`: add `| "cluster"` to `ConnectionRouteKind`; in `connectionRouteId` add `case "ClusterConnectionTarget": return \`cluster:${target.hostEnvironmentId}\`;`; in `connectionRouteKind` add `case "ClusterConnectionTarget": return "cluster";`; in `ROUTE_KIND_RANK` add `cluster: 6,`; in `connectionRouteLabel`:

```ts
    case "cluster":
      return route.target._tag === "ClusterConnectionTarget"
        ? `via ${route.target.hostLabel}`
        : "Cluster";
```

and in `connectionRouteLabelText`, before `default`:

```ts
    case "cluster":
      return route.target._tag === "ClusterConnectionTarget"
        ? resolve(msg("via {host}", { host: route.target.hostLabel }))
        : connectionRouteLabel(route);
```

`presentation.ts` `connectionCatalogDisplayUrl`: add `case "ClusterConnectionTarget":` to the `RelayConnectionTarget` arm (returns `null`).

`storageDocument.ts` `connectionIdOf`: add `case "ClusterConnectionTarget":` to the arm returning `null`.

`rpc/client.ts` `EnvironmentSubscriptionRpcTag`: add `| typeof WS_METHODS.clusterMembers`.

`EnvironmentRoutesSection.tsx` `ROUTE_ICONS`: add `cluster: "link",`.

`EnvironmentRow.tsx` `environmentTransportLabel`, after the `PrimaryConnectionTarget` line:

```ts
  if (entry.target._tag === "ClusterConnectionTarget")
    return resolve(msg("via {host}", { host: entry.target.hostLabel }));
```

`vp run typecheck` reports the resolver's switch as non-exhaustive until Task 4 adds its arm; Task 4 Step 4 runs typecheck. Land Tasks 2–4 in one push.

- [ ] **Step 4: Run the test to verify it passes**

Run: `vp test run packages/client-runtime/src/connection/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client-runtime/src/connection/model.ts packages/client-runtime/src/connection/routes.ts packages/client-runtime/src/connection/routes.test.ts packages/client-runtime/src/connection/presentation.ts packages/client-runtime/src/platform/storageDocument.ts packages/client-runtime/src/rpc/client.ts apps/mobile/src/features/settings/EnvironmentRoutesSection.tsx apps/web/src/components/settings/EnvironmentRow.tsx
git commit -m "feat(client-runtime): cluster member connection route

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: DPoP authorization of a member with the main host's token

A T3 Connect client holds a DPoP token for the main host. Reaching a member uses that token at the member's prefixed address, checks the descriptor there against the member, and renews by the host's id.

**Files:**

- Modify: `packages/client-runtime/src/authorization/service.ts:77-85` (input type), `:549-557` (descriptor check)
- Modify: `packages/client-runtime/src/connection/driver.ts:254-256` (renewal id)
- Modify: `packages/client-runtime/src/state/environmentHttpAuth.ts:202-204` (HTTP token id)
- Test: `packages/client-runtime/src/authorization/layer.test.ts` (after the test at `:548`)

**Interfaces:**

- Consumes: `PreparedHttpAuthorization` Dpop `issuedFor` (Task 2); prefixed URLs (Task 1).
- Produces: `authorizeDpop({ expectedEnvironmentId: hostId, clusterMemberId: memberId, directEndpoint })` — token and renewal keyed by `expectedEnvironmentId`, descriptor checked against `clusterMemberId`.

- [ ] **Step 1: Write the failing test**

`packages/client-runtime/src/authorization/layer.test.ts`, after "uses the T3 Connect token on a learned direct address without the relay":

```ts
  it.effect("reaches a cluster member with the main host's token under its path", () =>
    Effect.gen(function* () {
      const memberId = EnvironmentId.make("environment-box");
      const member = "https://environment.example.test/cluster/environment-box";
      const harness = yield* makeHarness({
        initialToken: persistedToken({ accessToken: "cached-access-token" }),
        responses: [
          Response.json({ ...DESCRIPTOR, environmentId: memberId }),
          websocketTicket("member-ticket"),
        ],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
          clusterMemberId: memberId,
          directEndpoint: { httpBaseUrl: member, wsBaseUrl: `${member.replace(/^http/, "ws")}/ws` },
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toMatch(
        /^wss:\/\/environment\.example\.test\/cluster\/environment-box\/ws\?/,
      );
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
      expect(harness.fetch.calls.map(([url]) => String(url))).toEqual([
        `${member}/.well-known/t3/environment`,
        `${member}/api/auth/websocket-ticket/rpc`,
      ]);
    }),
  );
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run packages/client-runtime/src/authorization/layer.test.ts -t "cluster member"`
Expected: FAIL — `ConnectionBlockedError: Connected environment environment-box does not match environment-1.`

- [ ] **Step 3: Implement**

`service.ts` `authorizeDpop` input type, after `directEndpoint`:

```ts
      /** The member behind `expectedEnvironmentId`'s cluster proxy that `directEndpoint` reaches. */
      readonly clusterMemberId?: EnvironmentId;
```

and in the implementation's `verifyDirectEndpoint` call:

```ts
            expectedEnvironmentId: input.clusterMemberId ?? input.expectedEnvironmentId,
```

`driver.ts`:

```ts
              expectedEnvironmentId:
                prepared.httpAuthorization.issuedFor ?? prepared.environmentId,
```

`environmentHttpAuth.ts`:

```ts
            expectedEnvironmentId: authorization.issuedFor ?? input.prepared.environmentId,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run packages/client-runtime/src/authorization/layer.test.ts packages/client-runtime/src/state/environmentHttpAuth.test.ts packages/client-runtime/src/connection/driver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client-runtime/src/authorization/service.ts packages/client-runtime/src/authorization/layer.test.ts packages/client-runtime/src/connection/driver.ts packages/client-runtime/src/state/environmentHttpAuth.ts
git commit -m "feat(client-runtime): DPoP reaches cluster members with the main host's token

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Resolve a member through its main host's connection

**Files:**

- Create: `packages/client-runtime/src/connection/clusterHosts.ts`, `packages/client-runtime/src/connection/clusterHosts.test.ts`
- Modify: `packages/client-runtime/src/connection/resolver.ts` (imports `:1-55`, new broker before `make` at `:276`, `make` `:278-283`, switch `:294-304`, final prepared object)
- Test: `packages/client-runtime/src/connection/resolver.test.ts` (`makeDependencies` `:55-168`, new tests after `:220`)

**Interfaces:**

- Consumes: `clusterMemberBaseUrl` (Plan 2); `authorizeBearer`, `authorizeDpop` with `clusterMemberId` (Task 3); `appendClientConnectionParams`, `readClientOwnerParams` (`authorization/remote.ts`).
- Produces:

```ts
export class ClusterHosts extends Context.Service<ClusterHosts, {
  readonly get: (hostEnvironmentId: EnvironmentId) => Effect.Effect<Option.Option<PreparedConnection>>;
  readonly set: (hostEnvironmentId: EnvironmentId, host: Option.Option<PreparedConnection>) => Effect.Effect<void>;
}>()("@t3tools/client-runtime/connection/clusterHosts/ClusterHosts") {}
export const layer: Layer.Layer<ClusterHosts>;
export const clusterHostConnection: (prepared: Option.Option<PreparedConnection>) => Option.Option<PreparedConnection>;
```

The resolver reads `ClusterHosts` with `Effect.serviceOption`, so layers that never build cluster routes (existing tests) need no change. A member prepare: `httpBaseUrl = clusterMemberBaseUrl(host.httpBaseUrl, memberId)`, `wsBaseUrl = <that, ws scheme>/ws`; cookie host → no ticket, client params appended; bearer host → `authorizeBearer` with the host token; DPoP host → `authorizeDpop` keyed by the host with `issuedFor`. No host connection → transient `remote-unavailable`, so the supervisor waits.

- [ ] **Step 1: Write the failing tests**

`resolver.test.ts`: add imports `import * as ClusterHosts from "./clusterHosts.ts";`, `ClusterConnectionTarget` and `type PreparedConnection` from `./model.ts`. In `makeDependencies`'s options add `readonly clusterHosts?: ReadonlyArray<PreparedConnection>;` and to `layerDependencies`:

```ts
    Layer.succeed(
      ClusterHosts.ClusterHosts,
      ClusterHosts.ClusterHosts.of({
        get: (hostEnvironmentId) =>
          Effect.succeed(
            Option.fromUndefinedOr(
              (options?.clusterHosts ?? []).find(
                (host) => host.environmentId === hostEnvironmentId,
              ),
            ),
          ),
        set: () => Effect.void,
      }),
    ),
```

Then, inside `describe("ConnectionResolver")`:

```ts
  const HOST_ID = EnvironmentId.make("environment-studio");
  const memberEntry = catalogEntry(
    new ClusterConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Box",
      hostEnvironmentId: HOST_ID,
      hostLabel: "Studio",
      status: "online",
      statusDetail: null,
    }),
  );
  const host = (httpAuthorization: PreparedConnection["httpAuthorization"]): PreparedConnection => ({
    environmentId: HOST_ID,
    label: "Studio",
    httpBaseUrl: "https://studio.example.test/",
    socketUrl: "wss://studio.example.test/ws?wsTicket=host",
    httpAuthorization,
    target: new PrimaryConnectionTarget({
      environmentId: HOST_ID,
      label: "Studio",
      httpBaseUrl: "https://studio.example.test/",
      wsBaseUrl: "wss://studio.example.test/",
    }),
  });

  it.effect("reaches a member with the main host's bearer under its cluster path", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const layerBroker = yield* makeDependencies({
        clusterHosts: [host({ _tag: "Bearer", token: "host-token" })],
        authorizeBearer: (input) =>
          Ref.update(calls, (current) => [...current, input]).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Box",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: `${input.wsBaseUrl}?wsTicket=main-host-ticket`,
              httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));

      const prepared = yield* broker.prepare(memberEntry);

      expect(yield* Ref.get(calls)).toEqual([
        {
          expectedEnvironmentId: ENVIRONMENT_ID,
          httpBaseUrl: "https://studio.example.test/cluster/environment-1",
          wsBaseUrl: "wss://studio.example.test/cluster/environment-1/ws",
          bearerToken: "host-token",
          connectionMethod: "direct",
        },
      ]);
      expect(prepared).toMatchObject({
        environmentId: ENVIRONMENT_ID,
        label: "Box",
        httpBaseUrl: "https://studio.example.test/cluster/environment-1",
        target: memberEntry.target,
      });
    }),
  );

  it.effect("reaches a member over the main host's cookie session without a ticket", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies({ clusterHosts: [host(null)] });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));

      const prepared = yield* broker.prepare(memberEntry);

      expect(prepared.httpAuthorization).toBeNull();
      expect(prepared.socketUrl).toMatch(
        /^wss:\/\/studio\.example\.test\/cluster\/environment-1\/ws\?clientSurface=web&/,
      );
      expect(prepared.descriptor?.environmentId).toBe(ENVIRONMENT_ID);
    }),
  );

  it.effect("keys a member's DPoP token to the main host", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const layerBroker = yield* makeDependencies({
        clusterHosts: [
          host({ _tag: "Dpop", accessToken: "host-access", expiresAtEpochMs: Number.MAX_SAFE_INTEGER }),
        ],
        authorizeDpop: (input) =>
          Ref.update(calls, (current) => [...current, input]).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Studio",
              httpBaseUrl: input.directEndpoint!.httpBaseUrl,
              socketUrl: `${input.directEndpoint!.wsBaseUrl}?wsTicket=dpop`,
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: "host-access",
                expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
              },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));

      const prepared = yield* broker.prepare(memberEntry);

      expect(yield* Ref.get(calls)).toEqual([
        {
          expectedEnvironmentId: HOST_ID,
          clusterMemberId: ENVIRONMENT_ID,
          directEndpoint: {
            httpBaseUrl: "https://studio.example.test/cluster/environment-1",
            wsBaseUrl: "wss://studio.example.test/cluster/environment-1/ws",
          },
        },
      ]);
      expect(prepared.environmentId).toBe(ENVIRONMENT_ID);
      expect(prepared.httpAuthorization).toMatchObject({ _tag: "Dpop", issuedFor: HOST_ID });
    }),
  );

  it.effect("waits for the main host before reaching a member", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));

      const error = yield* Effect.flip(broker.prepare(memberEntry));

      expect(error).toMatchObject({ _tag: "ConnectionTransientError", reason: "remote-unavailable" });
    }),
  );
```

`packages/client-runtime/src/connection/clusterHosts.test.ts`:

```ts
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { clusterHostConnection } from "./clusterHosts.ts";
import { ClusterConnectionTarget, PrimaryConnectionTarget, type PreparedConnection } from "./model.ts";

const HOST_ID = EnvironmentId.make("environment-studio");
const prepared = (
  capabilities: Record<string, boolean>,
  target: PreparedConnection["target"] = new PrimaryConnectionTarget({
    environmentId: HOST_ID,
    label: "Studio",
    httpBaseUrl: "https://studio.example.test/",
    wsBaseUrl: "wss://studio.example.test/",
  }),
): PreparedConnection => ({
  environmentId: target.environmentId,
  label: "Studio",
  httpBaseUrl: "https://studio.example.test/",
  socketUrl: "wss://studio.example.test/ws",
  httpAuthorization: null,
  target,
  descriptor: {
    environmentId: target.environmentId,
    label: "Studio",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true, ...capabilities },
  },
});

describe("clusterHostConnection", () => {
  it("only a host that advertises the capability serves members", () => {
    expect(Option.isSome(clusterHostConnection(Option.some(prepared({ cluster: true }))))).toBe(true);
    expect(Option.isNone(clusterHostConnection(Option.some(prepared({}))))).toBe(true);
    expect(Option.isNone(clusterHostConnection(Option.some(prepared({ cluster: false }))))).toBe(true);
    expect(Option.isNone(clusterHostConnection(Option.none()))).toBe(true);
    const member = new ClusterConnectionTarget({
      environmentId: EnvironmentId.make("environment-box"),
      label: "Box",
      hostEnvironmentId: HOST_ID,
      hostLabel: "Studio",
      status: "online",
      statusDetail: null,
    });
    expect(Option.isNone(clusterHostConnection(Option.some(prepared({ cluster: true }, member))))).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/client-runtime/src/connection/resolver.test.ts packages/client-runtime/src/connection/clusterHosts.test.ts -t "member"`
Expected: FAIL — `Failed to resolve import "./clusterHosts.ts"`.

- [ ] **Step 3: Implement**

`packages/client-runtime/src/connection/clusterHosts.ts`:

```ts
import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { PreparedConnection } from "./model.ts";

/** Each main host's current connection, which its members' connections borrow. */
export class ClusterHosts extends Context.Service<
  ClusterHosts,
  {
    readonly get: (
      hostEnvironmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PreparedConnection>>;
    readonly set: (
      hostEnvironmentId: EnvironmentId,
      host: Option.Option<PreparedConnection>,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/connection/clusterHosts/ClusterHosts") {}

export const layer = Layer.effect(
  ClusterHosts,
  Effect.sync(() => {
    const hosts = new Map<EnvironmentId, PreparedConnection>();
    return ClusterHosts.of({
      get: (hostEnvironmentId) =>
        Effect.sync(() => Option.fromUndefinedOr(hosts.get(hostEnvironmentId))),
      set: (hostEnvironmentId, host) =>
        Effect.sync(() => {
          if (Option.isSome(host)) hosts.set(hostEnvironmentId, host.value);
          else hosts.delete(hostEnvironmentId);
        }),
    });
  }),
);

/** A connection whose server lists cluster members. Older hosts lack the capability and the RPC. */
export const clusterHostConnection = (prepared: Option.Option<PreparedConnection>) =>
  Option.filter(
    prepared,
    (connection) =>
      connection.target._tag !== "ClusterConnectionTarget" &&
      connection.descriptor?.capabilities.cluster === true,
  );
```

`resolver.ts` imports: add `clusterMemberBaseUrl` to a new `import { clusterMemberBaseUrl } from "@t3tools/contracts";`, add `ClusterConnectionTarget` to the `type` import from `./model.ts`, add `ConnectionTransientError` to the value import from `./model.ts`, and `import * as ClusterHosts from "./clusterHosts.ts";`. Before `export const make`:

```ts
const makeClusterBroker = Effect.fn("clientRuntime.connection.broker.makeCluster")(function* () {
  const hosts = yield* Effect.serviceOption(ClusterHosts.ClusterHosts);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.cluster")(function* (
    target: ClusterConnectionTarget,
  ) {
    const host = Option.isNone(hosts)
      ? Option.none<PreparedConnection>()
      : yield* hosts.value.get(target.hostEnvironmentId);
    if (Option.isNone(host)) {
      return yield* new ConnectionTransientError({
        reason: "remote-unavailable",
        ...translatableDetail(msg("Waiting for {host} to connect.", { host: target.hostLabel })),
        hop: "server",
      });
    }
    const httpBaseUrl = clusterMemberBaseUrl(host.value.httpBaseUrl, target.environmentId);
    const wsBaseUrl = `${httpBaseUrl.replace(/^http/, "ws")}/ws`;
    const hostAuthorization = host.value.httpAuthorization;
    if (hostAuthorization === null) {
      const socketUrl = new URL(wsBaseUrl);
      appendClientConnectionParams(
        socketUrl,
        presentation.metadata,
        "direct",
        yield* readClientOwnerParams,
      );
      return {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl,
        socketUrl: socketUrl.toString(),
        httpAuthorization: null,
        target,
      } satisfies PreparedConnection;
    }
    const authorized =
      hostAuthorization._tag === "Bearer"
        ? yield* remote.authorizeBearer({
            expectedEnvironmentId: target.environmentId,
            httpBaseUrl,
            wsBaseUrl,
            bearerToken: hostAuthorization.token,
            connectionMethod: "direct",
          })
        : yield* remote.authorizeDpop({
            expectedEnvironmentId: target.hostEnvironmentId,
            clusterMemberId: target.environmentId,
            directEndpoint: { httpBaseUrl, wsBaseUrl },
          });
    return {
      ...authorized,
      environmentId: target.environmentId,
      label: target.label,
      httpAuthorization:
        authorized.httpAuthorization._tag === "Dpop"
          ? { ...authorized.httpAuthorization, issuedFor: target.hostEnvironmentId }
          : authorized.httpAuthorization,
      target,
    } satisfies PreparedConnection & { readonly descriptor?: ExecutionEnvironmentDescriptor };
  });
});
```

In `make`, after `const ssh = yield* makeSshBroker();` add `const cluster = yield* makeClusterBroker();`, and in the switch add:

```ts
        case "ClusterConnectionTarget":
          return cluster(target);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run packages/client-runtime/src/connection/resolver.test.ts packages/client-runtime/src/connection/clusterHosts.test.ts packages/client-runtime/src/connection/routes.test.ts`
Expected: PASS.

Run: `vp run typecheck`
Expected: no errors (every `ConnectionTarget` switch now has a cluster arm).

- [ ] **Step 5: Commit**

```bash
git add packages/client-runtime/src/connection/clusterHosts.ts packages/client-runtime/src/connection/clusterHosts.test.ts packages/client-runtime/src/connection/resolver.ts packages/client-runtime/src/connection/resolver.test.ts
git commit -m "feat(client-runtime): members connect through their main host's session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: `EnvironmentRegistry.reconcileCluster`

**Files:**

- Modify: `packages/client-runtime/src/connection/registry.ts` — imports `:3` and `:31-38`; interface after `:120-122`; state after `:277`; `assertKnownAddress` `:546-551`; `register` `:577-585`; `userEntry` `:623-630`; new functions after `reconcilePlatform` (`:849-858`); `removeLocked` `:860-866`; `setEnabled` `:1080-1082`; returned service `:1187-1207`
- Test: `packages/client-runtime/src/connection/registry.test.ts` (new `describe` after the `EnvironmentRegistry` block ending before `:2031`)

**Interfaces:**

- Consumes: `ClusterConnectionTarget` (Task 2); `ClusterMember` (Plan 2).
- Produces: `reconcileCluster(input: { hostEnvironmentId: EnvironmentId; hostLabel: string; members: ReadonlyArray<ClusterMember> }): Effect<void>`. Rules: a member id already held by a saved or platform entry is left alone; a member owned by another host is left alone; installs use `retainEquivalentRuntime` so an unchanged list touches nothing; a status or label change reinstalls (a member coming back online connects at once); members missing from the list are dropped with their cache and owned data. `remove`, `removeRoute`, `reorderRoutes` refuse a cluster member with `PlatformEnvironmentRemovalError`; `setEnabled` keeps it in memory; `register` for a member's id replaces the cluster entry with the saved one.

- [ ] **Step 1: Write the failing tests**

`registry.test.ts` — add `type ClusterMember` to the contracts import, `import * as DateTime from "effect/DateTime";`, and `ClusterConnectionTarget` to the `./model.ts` import. Before `describe("EnvironmentRegistry routes"`:

```ts
const clusterMember = (environmentId: EnvironmentId, label = "Box"): ClusterMember => ({
  environmentId,
  label,
  transport: "https",
  address: "https://box.example.test:3773",
  status: "online",
  joinedAt: DateTime.makeUnsafe(0),
  lastReachedAt: null,
  lastError: null,
});
const MEMBER_ID = EnvironmentId.make("environment-box");

describe("EnvironmentRegistry cluster members", () => {
  it.effect("lists a main host's members without saving them, and a replayed list changes nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const reconcile = (members: ReadonlyArray<ClusterMember>) =>
          registry.reconcileCluster({
            hostEnvironmentId: TARGET.environmentId,
            hostLabel: "Studio",
            members,
          });

        yield* reconcile([clusterMember(MEMBER_ID)]);
        yield* awaitConnectionState(registry, MEMBER_ID, (state) => state.phase === "connected");
        const target = (yield* SubscriptionRef.get(registry.entries)).get(MEMBER_ID)?.target;
        expect(target).toBeInstanceOf(ClusterConnectionTarget);
        expect(target).toMatchObject({ hostEnvironmentId: TARGET.environmentId, hostLabel: "Studio" });
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), MEMBER_ID)).toBe(false);
        const sessionsBefore = (yield* Ref.get(harness.sessions)).length;

        // The subscription replays the whole list on every reconnect of the main host.
        yield* reconcile([clusterMember(MEMBER_ID)]);
        yield* reconcile([clusterMember(MEMBER_ID)]);

        expect((yield* SubscriptionRef.get(registry.entries)).size).toBe(2);
        expect((yield* Ref.get(harness.sessions)).length).toBe(sessionsBefore);
        expect((yield* registry.state(MEMBER_ID)).phase).toBe("connected");

        yield* reconcile([]);
        expect((yield* SubscriptionRef.get(registry.entries)).has(MEMBER_ID)).toBe(false);
        expect(yield* Ref.get(harness.cacheClears)).toContain(MEMBER_ID);
        expect(yield* Ref.get(harness.ownedDataClears)).toContain(MEMBER_ID);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a member saved on this device keeps its saved entry until the user removes it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [TARGET, BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const reconcile = (members: ReadonlyArray<ClusterMember>) =>
          registry.reconcileCluster({
            hostEnvironmentId: TARGET.environmentId,
            hostLabel: "Studio",
            members,
          });

        yield* reconcile([clusterMember(BEARER_TARGET.environmentId)]);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(BEARER_TARGET.environmentId)?.target,
        ).toBe(BEARER_TARGET);
        yield* reconcile([]);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), BEARER_TARGET.environmentId)).toBe(
          true,
        );

        yield* registry.remove(BEARER_TARGET.environmentId);
        yield* reconcile([clusterMember(BEARER_TARGET.environmentId)]);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(BEARER_TARGET.environmentId)?.target,
        ).toBeInstanceOf(ClusterConnectionTarget);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), BEARER_TARGET.environmentId)).toBe(
          false,
        );
        expect(
          Exit.isFailure(yield* Effect.exit(registry.remove(BEARER_TARGET.environmentId))),
        ).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("a member that leaves the list ends streams that follow it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.reconcileCluster({
          hostEnvironmentId: TARGET.environmentId,
          hostLabel: "Studio",
          members: [clusterMember(MEMBER_ID)],
        });
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        // Stands in for an open thread view's durable subscription.
        yield* registry
          .followStream(
            MEMBER_ID,
            Stream.fromEffect(
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              ),
            ),
          )
          .pipe(Stream.runDrain, Effect.forkScoped);
        yield* Deferred.await(started);

        yield* registry.reconcileCluster({
          hostEnvironmentId: TARGET.environmentId,
          hostLabel: "Studio",
          members: [],
        });

        yield* Deferred.await(interrupted);
        const after = yield* Effect.flip(registry.run(MEMBER_ID, Effect.void));
        expect(after._tag).toBe("EnvironmentNotRegisteredError");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/client-runtime/src/connection/registry.test.ts -t "cluster members"`
Expected: FAIL — `registry.reconcileCluster is not a function`.

- [ ] **Step 3: Implement**

`registry.ts` imports: `import { type ClusterMember, EnvironmentId } from "@t3tools/contracts";` and `import { ClusterConnectionTarget, ConnectionBlockedError } from "./model.ts";`.

Interface, after `reconcilePlatform`:

```ts
    /**
     * Shows a main host's members as environments that are never saved. A saved or platform
     * entry for the same environment wins; members missing from `members` are dropped.
     */
    readonly reconcileCluster: (input: {
      readonly hostEnvironmentId: EnvironmentId;
      readonly hostLabel: string;
      readonly members: ReadonlyArray<ClusterMember>;
    }) => Effect.Effect<void>;
```

State, after `platformEnvironmentIds`:

```ts
  // Member environment -> the main host that lists it.
  const clusterMembers = yield* Ref.make<ReadonlyMap<EnvironmentId, EnvironmentId>>(new Map());
  const forgetClusterMember = (environmentId: EnvironmentId) =>
    Ref.update(clusterMembers, (current) => {
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });
```

`assertKnownAddress`: change its first check to

```ts
    if (
      (yield* Ref.get(platformEnvironmentIds)).has(environmentId) ||
      (yield* Ref.get(clusterMembers)).has(environmentId)
    )
      return;
```

`register`, replace `const previous = (yield* SubscriptionRef.get(entries)).get(environmentId);` with:

```ts
        // Pairing a member directly saves it; the saved entry replaces the cluster one.
        const clustered = (yield* Ref.get(clusterMembers)).has(environmentId);
        if (clustered) yield* forgetClusterMember(environmentId);
        const previous = clustered
          ? undefined
          : (yield* SubscriptionRef.get(entries)).get(environmentId);
```

`userEntry` and `removeLocked`: change each `if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId))` to

```ts
    if (
      (yield* Ref.get(platformEnvironmentIds)).has(environmentId) ||
      (yield* Ref.get(clusterMembers)).has(environmentId)
    ) {
```

`setEnabled`: change the persistence guard to

```ts
        if (
          !(yield* Ref.get(platformEnvironmentIds)).has(environmentId) &&
          !(yield* Ref.get(clusterMembers)).has(environmentId)
        ) {
          yield* registrations.setEnabled(environmentId, enabled);
        }
```

After `reconcilePlatform`:

```ts
  const removeClusterMemberLocked = Effect.fn("EnvironmentRegistry.removeClusterMember")(
    function* (environmentId: EnvironmentId) {
      yield* forgetClusterMember(environmentId);
      yield* closeServiceScope(environmentId);
      yield* SubscriptionRef.update(entries, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      });
      yield* Effect.all(
        [
          cache.clear(environmentId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not clear cached data of a former cluster member.", {
                environmentId,
                error,
              }),
            ),
          ),
          ownedDataCleanup.clear(environmentId),
        ],
        { concurrency: "unbounded", discard: true },
      );
    },
  );

  const reconcileCluster = Effect.fn("EnvironmentRegistry.reconcileCluster")(function* (input: {
    readonly hostEnvironmentId: EnvironmentId;
    readonly hostLabel: string;
    readonly members: ReadonlyArray<ClusterMember>;
  }) {
    const listed = new Set(input.members.map((member) => member.environmentId));
    const owned = [...(yield* Ref.get(clusterMembers))].flatMap(([memberId, hostId]) =>
      hostId === input.hostEnvironmentId && !listed.has(memberId) ? [memberId] : [],
    );
    for (const memberId of owned) {
      yield* withLeaseLock(memberId, removeClusterMemberLocked(memberId));
    }
    for (const member of input.members) {
      const environmentId = member.environmentId;
      yield* withLeaseLock(
        environmentId,
        Effect.gen(function* () {
          const owner = (yield* Ref.get(clusterMembers)).get(environmentId);
          const previous = (yield* SubscriptionRef.get(entries)).get(environmentId);
          if (owner === undefined ? previous !== undefined : owner !== input.hostEnvironmentId) {
            return;
          }
          yield* Ref.update(clusterMembers, (current) =>
            new Map(current).set(environmentId, input.hostEnvironmentId),
          );
          yield* installEntryLocked(
            {
              target: new ClusterConnectionTarget({
                environmentId,
                label: member.label,
                hostEnvironmentId: input.hostEnvironmentId,
                hostLabel: input.hostLabel,
                status: member.status,
                statusDetail: member.lastError,
              }),
              profile: Option.none(),
              enabled: previous?.enabled ?? true,
            },
            { retainEquivalentRuntime: true },
          );
        }),
      );
    }
  });
```

Add `reconcileCluster,` after `reconcilePlatform,` in the returned `EnvironmentRegistry.of({...})`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run packages/client-runtime/src/connection/registry.test.ts`
Expected: PASS (new block and every existing registry test).

- [ ] **Step 5: Commit**

```bash
git add packages/client-runtime/src/connection/registry.ts packages/client-runtime/src/connection/registry.test.ts
git commit -m "feat(client-runtime): registry lists cluster members without saving them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Follow every main host's member list

**Files:**

- Modify: `packages/client-runtime/src/connection/layer.ts` — imports `:1-17`, new `watchClusterMembers` after `watchDiscoveredCompatibility` (`:72`), startup `:85-101`

**Interfaces:**

- Consumes: `ClusterHosts`, `clusterHostConnection` (Task 4); `reconcileCluster`, `followStream`, `entries` (Task 5); `subscribe` (`rpc/client.ts`); `EnvironmentSupervisor.prepared`.
- Produces: `watchClusterMembers(): Effect<void, never, EnvironmentRegistry | ClusterHosts | Scope>` forked at connection startup; `Connection.layerWithOptions` now also provides `ClusterHosts`.

Per non-member entry the watcher follows the supervisor's `prepared`: every value is published to `ClusterHosts` (so renewed tokens reach members), and while the host advertises `capabilities.cluster` it holds one `cluster.members` subscription keyed on the host's label, reconciling each list. The subscription survives reconnects (the RPC layer resubscribes on each session and the server replays the list). When the entry leaves the registry the watcher drops its members. Members stay listed while the host is disconnected; their own connects then fail with "Waiting for <host> to connect." and retry.

No new test: the watcher is wiring over `clusterHostConnection` (tested in Task 4) and `reconcileCluster` (tested in Task 5).

- [ ] **Step 1: Implement the watcher**

`layer.ts` imports: add `import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";`, `import * as Fiber from "effect/Fiber";`, `import * as ClusterHosts from "./clusterHosts.ts";`, `import * as EnvironmentSupervisor from "./supervisor.ts";`, `import { subscribe } from "../rpc/client.ts";`. After `watchDiscoveredCompatibility`:

```ts
export const watchClusterMembers = Effect.fn("connection.watchClusterMembers")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const hosts = yield* ClusterHosts.ClusterHosts;
  const followHost = (hostEnvironmentId: EnvironmentId) =>
    registry
      .followStream(
        hostEnvironmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              Stream.concat(
                Stream.fromEffect(SubscriptionRef.get(supervisor.prepared)),
                SubscriptionRef.changes(supervisor.prepared),
              ).pipe(
                Stream.map(ClusterHosts.clusterHostConnection),
                Stream.tap((host) => hosts.set(hostEnvironmentId, host)),
                Stream.map(Option.map((host) => host.target.label)),
                Stream.changesWith(
                  (previous, next) => Option.getOrNull(previous) === Option.getOrNull(next),
                ),
                Stream.switchMap(
                  Option.match({
                    onNone: () => Stream.empty,
                    onSome: (hostLabel) =>
                      subscribe(WS_METHODS.clusterMembers, {}).pipe(
                        Stream.tap((members) =>
                          registry.reconcileCluster({ hostEnvironmentId, hostLabel, members }),
                        ),
                      ),
                  }),
                ),
              ),
            ),
          ),
        ),
      )
      .pipe(
        Stream.runDrain,
        Effect.catchCause((cause) =>
          Effect.logWarning("Stopped following a main host's cluster members.", {
            hostEnvironmentId,
            cause,
          }),
        ),
      );
  const followed = new Map<EnvironmentId, Fiber.Fiber<void>>();
  yield* Stream.concat(
    Stream.fromEffect(SubscriptionRef.get(registry.entries)),
    SubscriptionRef.changes(registry.entries),
  ).pipe(
    Stream.runForEach((entries) =>
      Effect.gen(function* () {
        for (const [environmentId, entry] of entries) {
          if (entry.target._tag === "ClusterConnectionTarget" || followed.has(environmentId)) {
            continue;
          }
          followed.set(environmentId, yield* followHost(environmentId).pipe(Effect.forkScoped));
        }
        for (const [environmentId, fiber] of followed) {
          const entry = entries.get(environmentId);
          if (entry !== undefined && entry.target._tag !== "ClusterConnectionTarget") continue;
          followed.delete(environmentId);
          yield* Fiber.interrupt(fiber);
          yield* hosts.set(environmentId, Option.none());
          yield* registry.reconcileCluster({
            hostEnvironmentId: environmentId,
            hostLabel: "",
            members: [],
          });
        }
      }),
    ),
  );
});
```

In `layerConnectionStartup`, before `yield* registry.start;`:

```ts
      yield* watchClusterMembers().pipe(Effect.forkScoped);
```

and the returned layer:

```ts
  return layerConnectionStartup.pipe(
    Layer.provideMerge(layerConnectionServices),
    Layer.provideMerge(RemoteEnvironmentAuthorization.layer),
    Layer.provideMerge(ClusterHosts.layer),
  );
```

`ClusterHosts.layer` is outermost so the resolver inside the driver and the watcher share one instance.

- [ ] **Step 2: Run the tests and typecheck**

Run: `vp test run packages/client-runtime/src/connection/registry.test.ts packages/client-runtime/src/connection/supervisor.test.ts`
Expected: PASS.

Run: `vp run typecheck`
Expected: no errors (`apps/web/src/connection/runtime.ts` and `apps/mobile/src/connection/runtime.ts` use `Connection.layerWithOptions` and need no change).

- [ ] **Step 3: Commit**

```bash
git add packages/client-runtime/src/connection/layer.ts
git commit -m "feat(client-runtime): follow each main host's cluster members

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Shared cluster atoms and display logic

**Files:**

- Create: `packages/client-runtime/src/state/cluster.ts`, `packages/client-runtime/src/state/cluster.test.ts`
- Modify: `packages/client-runtime/package.json:270` (add the `./state/cluster` export beside `./state/peerLinks`)

**Interfaces:**

- Consumes: `createEnvironmentRpcQueryAtomFamily`, `createEnvironmentRpcSubscriptionAtomFamily`, `createEnvironmentRpcCommand` (`state/runtime.ts`); Plan 2 contracts and RPCs.
- Produces (`@t3tools/client-runtime/state/cluster`):
  - `createClusterEnvironmentAtoms(runtime)` → `{ status, members, invite, addMember, removeMember, renameMember, leave }` (commands carry `permissionAtom`; add/remove/leave refresh `status`)
  - `offersCluster(config): boolean` — capability and Labs flag
  - `clusterAddTarget(raw: string, options: { readonly ssh: boolean }): string | null`
  - `clusterName(status: Pick<ClusterStatus, "role" | "host">, ownLabel: string): string | null`
  - `clusterMemberStatusText(member, hostLabel, resolve?): string`
  - `defaultClusterInviteUrl(httpBaseUrl: string | null): string`

- [ ] **Step 1: Write the failing tests**

`packages/client-runtime/src/state/cluster.test.ts`:

```ts
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { clusterAddTarget, clusterName, offersCluster } from "./cluster.ts";

const SHA = "ab".repeat(32);
const JOIN = `https://box.local:3773#K7M2Q9RZ3NWD.${SHA}`;

describe("clusterAddTarget", () => {
  it("accepts a join string pasted with spaces and line breaks", () => {
    const wrapped = ` ${JOIN.slice(0, 30)}\n${JOIN.slice(30, 70)}\r\n  ${JOIN.slice(70)}\t`;
    expect(clusterAddTarget(wrapped, { ssh: false })).toBe(JOIN);
  });

  it("takes ssh targets only where the main host can dial them", () => {
    expect(clusterAddTarget(" me@box ", { ssh: true })).toBe("me@box");
    expect(clusterAddTarget("ssh://me@box:2222", { ssh: true })).toBe("ssh://me@box:2222");
    expect(clusterAddTarget("me@box", { ssh: false })).toBeNull();
    expect(clusterAddTarget(`https://box.local:3773#K7M2Q9RZ3NWD`, { ssh: true })).toBeNull();
    expect(clusterAddTarget("", { ssh: true })).toBeNull();
  });
});

describe("cluster presentation", () => {
  it("names the cluster after its main host", () => {
    const joinedAt = DateTime.makeUnsafe(0);
    const host = { environmentId: EnvironmentId.make("environment-studio"), label: "Studio", joinedAt };
    expect(clusterName({ role: "standalone", host: null }, "Box")).toBeNull();
    expect(clusterName({ role: "main", host: null }, "Studio")).toBe("Studio");
    expect(clusterName({ role: "member", host }, "Box")).toBe("Studio");
  });

  it("offers the cluster only where the capability and the Labs flag are both on", () => {
    const config = (cluster: boolean | undefined, clusterEnabled: boolean) => ({
      environment: { capabilities: cluster === undefined ? {} : { cluster } },
      settings: { clusterEnabled },
    });
    expect(offersCluster(config(true, true))).toBe(true);
    expect(offersCluster(config(true, false))).toBe(false);
    expect(offersCluster(config(undefined, true))).toBe(false);
    expect(offersCluster(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/client-runtime/src/state/cluster.test.ts`
Expected: FAIL — `Failed to resolve import "./cluster.ts"`.

- [ ] **Step 3: Implement**

`packages/client-runtime/src/state/cluster.ts`:

```ts
import {
  type ClusterMember,
  type ClusterStatus,
  type ServerConfig,
  parseClusterJoinString,
  parseClusterSshTarget,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createClusterEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:cluster:status",
    tag: WS_METHODS.clusterStatus,
  });
  return {
    status,
    members: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:cluster:members",
      tag: WS_METHODS.clusterMembers,
    }),
    invite: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cluster:invite",
      tag: WS_METHODS.clusterInvite,
    }),
    addMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cluster:add-member",
      tag: WS_METHODS.clusterAddMember,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(status({ environmentId, input: {} }))),
    }),
    removeMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cluster:remove-member",
      tag: WS_METHODS.clusterRemoveMember,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(status({ environmentId, input: {} }))),
    }),
    renameMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cluster:rename-member",
      tag: WS_METHODS.clusterRenameMember,
    }),
    leave: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cluster:leave",
      tag: WS_METHODS.clusterLeave,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(status({ environmentId, input: {} }))),
    }),
  };
}

/** Whether an environment shows its Cluster settings: it supports clusters and its beta is on. */
export const offersCluster = (
  config:
    | {
        readonly environment: { readonly capabilities: { readonly cluster?: boolean } };
        readonly settings: Pick<ServerConfig["settings"], "clusterEnabled">;
      }
    | null
    | undefined,
): boolean => config?.environment.capabilities.cluster === true && config.settings.clusterEnabled;

/** Pasted join strings often wrap or carry stray spaces; none of their characters is a space. */
export function clusterAddTarget(raw: string, options: { readonly ssh: boolean }): string | null {
  const target = raw.replace(/\s+/g, "");
  if (parseClusterJoinString(target) !== undefined) return target;
  return options.ssh && !target.includes("#") && parseClusterSshTarget(target) !== undefined
    ? target
    : null;
}

export function clusterName(
  status: Pick<ClusterStatus, "role" | "host">,
  ownLabel: string,
): string | null {
  switch (status.role) {
    case "standalone":
      return null;
    case "main":
      return ownLabel;
    case "member":
      return status.host?.label ?? ownLabel;
  }
}

export function clusterMemberStatusText(
  member: Pick<ClusterMember, "status" | "lastError">,
  hostLabel: string,
  resolve: MFunctionType = mFallback,
): string {
  switch (member.status) {
    case "online":
      return resolve(msg("Online", { $context: "cluster member status" }));
    case "offline":
      return member.lastError ?? resolve(msg("Not answering {host}.", { host: hostLabel }));
    case "incompatible":
      return resolve(
        msg("Runs a T3 Code version {host} cannot drive. Update both to the same version.", {
          host: hostLabel,
        }),
      );
    case "revoked":
      return resolve(
        msg("No longer accepts {host}. Remove it here, then invite it again.", {
          host: hostLabel,
        }),
      );
  }
}

/** Members answer HTTPS on the port they already serve, which is what the main host dials. */
export function defaultClusterInviteUrl(httpBaseUrl: string | null): string {
  const url = httpBaseUrl === null ? null : URL.parse(httpBaseUrl);
  return url === null ? "" : `https://${url.host}`;
}
```

`packages/client-runtime/package.json`, after the `"./state/peerLinks"` entry:

```json
    "./state/cluster": {
      "types": "./src/state/cluster.ts",
      "default": "./src/state/cluster.ts"
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run packages/client-runtime/src/state/cluster.test.ts packages/client-runtime/src/state/commandPermissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client-runtime/src/state/cluster.ts packages/client-runtime/src/state/cluster.test.ts packages/client-runtime/package.json
git commit -m "feat(client-runtime): shared cluster atoms and presentation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Web — Labs switch, search entries, and the Cluster section

Desktop renders the web settings unchanged. SSH adds need nothing from the desktop main process: the server dials SSH itself with keys or an agent (Plan 2, Task 5; desktop password prompts are not bridged, Plan 2 known limit 7), and the dialog says so.

**Files:**

- Create: `apps/web/src/state/cluster.ts`, `apps/web/src/components/settings/ClusterSettings.tsx`
- Modify: `apps/web/src/components/settings/LabsSettingsPanel.tsx:26` (mount) and after `:185` (row)
- Modify: `apps/web/src/components/settings/settingsSearch.ts:73` and `:87` (flags), after `:547` (beta item), after `:1410` (section item), `:1619` (filter)
- Modify: `apps/web/src/components/settings/useAvailableSettingsSearchItems.ts:10`, `:49`, `:74`
- Modify: `apps/web/src/components/settings/ConnectionsSettings.tsx:50` (import), `:271` (hook), `:286-288` (saved list), after `:1838` (mount)
- Test: `apps/web/src/components/settings/settingsSearch.test.ts:151` and a new case after `:178`

**Interfaces:**

- Consumes: `createClusterEnvironmentAtoms`, `offersCluster`, `clusterAddTarget`, `clusterMemberStatusText`, `defaultClusterInviteUrl` (Task 7); `connectionAtomRuntime`, `useEnvironments`, `useEnvironmentsWithScope`, `useEnvironmentHttpBaseUrl`, `useEnvironmentQuery`, `useAtomCommand`.
- Produces: `clusterEnvironment`, `useClusterHosts()` (web); `ClusterSettings` section with search id `cluster`; Labs row `cluster-beta`.

- [ ] **Step 1: Write the failing test**

`settingsSearch.test.ts`: add `"cluster",` after `"linked-environments",` in the gated-ids list (line 151), and after the "finds linked environments on a remote host" test:

```ts
  it("finds the cluster section only where a connected host offers it", () => {
    const availability = {
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    const results = (hasClusterHost: boolean) =>
      searchSettings(
        "cluster join string",
        filterAvailableSettingsSearchItems({ ...availability, hasClusterHost }),
      );
    expect(results(false).map((item) => item.id)).not.toContain("cluster");
    expect(results(true)).toContainEqual(
      expect.objectContaining({ id: "cluster", to: "/settings/connections", targetId: "cluster" }),
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run apps/web/src/components/settings/settingsSearch.test.ts -t "cluster"`
Expected: FAIL — `expected [] to contain equal …"cluster"…`.

- [ ] **Step 3: Implement**

`apps/web/src/state/cluster.ts`:

```ts
import {
  createClusterEnvironmentAtoms,
  offersCluster,
} from "@t3tools/client-runtime/state/cluster";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { useEnvironmentsWithScope } from "./session";

export const clusterEnvironment = createClusterEnvironmentAtoms(connectionAtomRuntime);

/** Connected environments that show a Cluster section. Members show under their main host. */
export function useClusterHosts() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.entry.target._tag !== "ClusterConnectionTarget" &&
      offersCluster(environment.serverConfig),
  );
  const readable = useEnvironmentsWithScope(supported, AuthOrchestrationReadScope);
  return supported.filter((environment) => readable.has(environment.environmentId));
}
```

`settingsSearch.ts`: add `readonly clusterOnly?: boolean;` after `peerLinksOnly` in `SettingsSearchItem`; `readonly hasClusterHost?: boolean;` after `hasPeerLinkHost` in `SettingsSearchAvailability`; after the `linked-environments-beta` item:

```ts
  {
    id: "cluster-beta",
    title: msg("Cluster"),
    to: "/settings/labs",
    scope: "environment",
    searchTerms: [msg("beta cluster main host members group machines proxy invite join")],
  },
```

after the `linked-environments` item:

```ts
  {
    id: "cluster",
    clusterOnly: true,
    title: msg("Cluster"),
    to: "/settings/connections",
    targetId: "cluster",
    searchTerms: [msg("cluster main host member invite join string fingerprint ssh leave remove")],
  },
```

and in `filterAvailableSettingsSearchItems` after the `peerLinksOnly` clause:

```ts
      (!item.clusterOnly || availability.hasClusterHost === true) &&
```

`useAvailableSettingsSearchItems.ts`: `import { useClusterHosts } from "~/state/cluster";`, `const hasClusterHost = useClusterHosts().length > 0;` beside `hasPeerLinkHost`, and pass `hasClusterHost,` beside `hasPeerLinkHost,`.

`LabsSettingsPanel.tsx`: render `<ClusterRow />` after `<LinkedEnvironmentsRow />`, and add after `LinkedEnvironmentsRow`:

```tsx
function ClusterRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("cluster-beta")}
      settingKeys={["clusterEnabled"]}
      description={
        <T>
          Drive your other machines through this one. Turn it on here and on each machine you add,
          then set it up in{" "}
          <Link to="/settings/connections" className="underline underline-offset-2">
            Environments
          </Link>
          . While off, this machine adds no members and forwards nothing to them.
        </T>
      }
      control={
        <ScopedSwitch
          settingKeys={["clusterEnabled"]}
          checked={settings.clusterEnabled}
          onCheckedChange={(checked) => updateSettings({ clusterEnabled: Boolean(checked) })}
          aria-label={gt("Cluster")}
        />
      }
    />
  );
}
```

`ConnectionsSettings.tsx`: `import { ClusterSettings } from "./ClusterSettings";` and `import { useClusterHosts } from "~/state/cluster";`; after `const peerLinkHosts = usePeerLinkHosts();` add `const clusterHosts = useClusterHosts();`; change `savedEnvironments` to

```ts
  const savedEnvironments = environments.filter(
    (environment) =>
      environment.entry.target._tag !== "PrimaryConnectionTarget" &&
      environment.entry.target._tag !== "ClusterConnectionTarget",
  );
```

and after the `peerLinkHosts.map(...)` block:

```tsx
      {clusterHosts.map((environment, index) => (
        <ClusterSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
          showLabel={clusterHosts.length > 1}
          isSearchTarget={index === 0}
        />
      ))}
```

`apps/web/src/components/settings/ClusterSettings.tsx`:

```tsx
import { useAtomValue } from "@effect/atom-react";
import {
  clusterAddTarget,
  clusterMemberStatusText,
  defaultClusterInviteUrl,
} from "@t3tools/client-runtime/state/cluster";
import type { ClusterInvite, ClusterMember, EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { PlusIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { useId, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { clusterEnvironment } from "~/state/cluster";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function ClusterSettings({
  environmentId,
  label,
  showLabel,
  isSearchTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly showLabel: boolean;
  readonly isSearchTarget: boolean;
}) {
  const gt = useGT();
  const search = useSearchableSetting()("cluster");
  const status = useEnvironmentQuery(
    clusterEnvironment.status({ environmentId, input: {} }),
    useMessages(),
  );
  const canAdd = useAtomValue(clusterEnvironment.addMember.permissionAtom(environmentId));
  const role = status.data?.role ?? null;
  return (
    <SettingsSection
      {...(isSearchTarget ? { id: search.id } : {})}
      title={showLabel ? `${search.title} · ${label}` : search.title}
      headerAction={
        canAdd && (role === "standalone" || role === "main") ? (
          <AddMemberAction environmentId={environmentId} />
        ) : null
      }
    >
      {status.error ? (
        <SettingsRow title={gt("Could not load the cluster")} description={status.error} />
      ) : status.data === null ? (
        <SettingsRow title={gt("Loading the cluster…")} role="status" />
      ) : status.data.role === "member" ? (
        <MemberOfRow environmentId={environmentId} hostLabel={status.data.host?.label ?? ""} />
      ) : (
        <>
          <InviteRow environmentId={environmentId} fingerprint={status.data.fingerprint} />
          {status.data.role === "main" ? (
            <ClusterMemberList environmentId={environmentId} hostLabel={label} />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

function ClusterMemberList({
  environmentId,
  hostLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
}) {
  const gt = useGT();
  const members = useEnvironmentQuery(
    clusterEnvironment.members({ environmentId, input: {} }),
    useMessages(),
  );
  if (members.error) {
    return <SettingsRow title={gt("Could not load cluster members")} description={members.error} />;
  }
  if (members.data === null) {
    return <SettingsRow title={gt("Loading cluster members…")} role="status" />;
  }
  if (members.data.length === 0) {
    return (
      <SettingsRow
        title={gt("No members yet")}
        description={gt(
          "Invite a machine from its own Settings → Environments → Cluster, then add its join string here.",
        )}
      />
    );
  }
  return members.data.map((member) => (
    <ClusterMemberRow
      key={member.environmentId}
      environmentId={environmentId}
      hostLabel={hostLabel}
      member={member}
    />
  ));
}

function ClusterMemberRow({
  environmentId,
  hostLabel,
  member,
}: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
  readonly member: ClusterMember;
}) {
  const gt = useGT();
  const m = useMessages();
  const nowMs = Date.parse(useNowMinute());
  const canWrite = useAtomValue(clusterEnvironment.removeMember.permissionAtom(environmentId));
  const removeMember = useAtomCommand(clusterEnvironment.removeMember, {
    label: "remove cluster member",
  });
  const [busy, setBusy] = useState(false);
  const statusText = clusterMemberStatusText(member, hostLabel, m);
  const lastSeen =
    member.lastReachedAt === null
      ? gt("Never reached")
      : gt("Last seen {time}", {
          time: formatRelativeTimeLabel(DateTime.formatIso(member.lastReachedAt), nowMs, m),
        });
  const remove = async () => {
    const confirmed = await (requestConfirmDialog(
      gt("Remove {label} from the cluster? It becomes a standalone environment again.", {
        label: member.label,
      }),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await removeMember({
      environmentId,
      input: { memberId: member.environmentId },
    });
    setBusy(false);
    if (result._tag === "Success" && !result.value.memberNotified) {
      toastManager.add({
        type: "warning",
        title: gt("Removed {label} here", { label: member.label }),
        description: gt("It did not answer. Run t3 cluster leave on it to finish."),
      });
    }
  };
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className={member.status === "online" ? "min-w-0 flex-1 space-y-1" : "min-w-0 flex-1 space-y-1 opacity-60"}>
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusText}
              dotClassName={
                member.status === "online"
                  ? "bg-success"
                  : member.status === "offline"
                    ? "bg-muted-foreground/30"
                    : "bg-destructive"
              }
              pingClassName={null}
            />
            <h3 className="text-sm font-medium text-foreground">{member.label}</h3>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {member.transport === "ssh" ? "SSH" : "HTTPS"} · {member.address} · {lastSeen}
          </p>
          {member.status === "online" ? null : (
            <p className="text-xs text-muted-foreground">{statusText}</p>
          )}
        </div>
        {canWrite ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <RenameMemberAction environmentId={environmentId} member={member} />
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? gt("Removing…") : gt("Remove")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RenameMemberAction({
  environmentId,
  member,
}: {
  readonly environmentId: EnvironmentId;
  readonly member: ClusterMember;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(member.label);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const rename = useAtomCommand(clusterEnvironment.renameMember, {
    label: "rename cluster member",
  });
  const submit = async () => {
    if (busy || label.trim().length === 0) return;
    setBusy(true);
    const result = await rename({
      environmentId,
      input: { memberId: member.environmentId, label: label.trim() },
    });
    setBusy(false);
    if (result._tag === "Success") setOpen(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) setLabel(member.label);
      }}
    >
      <DialogTrigger render={<Button size="xs" variant="outline" />}>{gt("Rename")}</DialogTrigger>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <T>Rename member</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              disabled={busy}
              aria-label={gt("Member name")}
              nativeInput
            />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || label.trim().length === 0}>
            {busy ? gt("Saving…") : gt("Save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function AddMemberAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const addMember = useAtomCommand(clusterEnvironment.addMember, { label: "add cluster member" });
  const target = clusterAddTarget(raw, { ssh: true });
  const submit = async () => {
    if (busy || target === null) return;
    setBusy(true);
    const result = await addMember({
      environmentId,
      input: { target, ...(label.trim() ? { label: label.trim() } : {}) },
    });
    setBusy(false);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: gt("Added {label}", { label: result.value.label }) });
      setOpen(false);
      setRaw("");
      setLabel("");
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" />
            {gt("Add member")}
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Add a member</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Paste the join string from the machine's Invite to cluster, or enter user@host to add
              it over SSH. SSH needs a key or a running ssh-agent on this machine.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-foreground">
                <T>Join string or SSH target</T>
              </span>
              <Input
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
                placeholder="https://box.local:3773#… or me@box"
                disabled={busy}
                autoFocus
                nativeInput
                spellCheck={false}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-foreground">
                <T>Name (optional)</T>
              </span>
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                disabled={busy}
                nativeInput
              />
            </label>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || target === null}>
            {busy ? gt("Adding…") : gt("Add member")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function InviteRow({
  environmentId,
  fingerprint,
}: {
  readonly environmentId: EnvironmentId;
  readonly fingerprint: string;
}) {
  const gt = useGT();
  const canInvite = useAtomValue(clusterEnvironment.invite.permissionAtom(environmentId));
  return (
    <SettingsRow
      title={gt("Invite to cluster")}
      description={
        <T>
          Lets another machine add this one as a member. Certificate SHA-256:{" "}
          <code className="break-all">
            <Var>{fingerprint}</Var>
          </code>
        </T>
      }
      control={canInvite ? <InviteAction environmentId={environmentId} /> : null}
    />
  );
}

function InviteAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ClusterInvite | null>(null);
  const formId = useId();
  const invite = useAtomCommand(clusterEnvironment.invite, { label: "create cluster invite" });
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>();
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const result = await invite({
      environmentId,
      input: url.trim() ? { url: url.trim() } : {},
    });
    setBusy(false);
    if (result._tag === "Success") setCreated(result.value);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) {
          setUrl(defaultClusterInviteUrl(httpBaseUrl));
          setCreated(null);
        }
      }}
    >
      <DialogTrigger render={<Button size="xs" variant="outline" />}>
        {gt("Invite to cluster")}
      </DialogTrigger>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Invite to cluster</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Joining signs out this machine's other clients and ends its linked environments.
              Afterwards it is reached through the main host.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {created === null ? (
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Address the main host reaches this machine at</T>
                </span>
                <Input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://box.local:3773"
                  disabled={busy}
                  nativeInput
                  spellCheck={false}
                />
              </label>
            </form>
          ) : (
            <div className="space-y-2 text-sm">
              {created.joinString === null ? (
                <p>
                  <T>
                    Code <Var>{created.code}</Var>. Add an address to get a join string.
                  </T>
                </p>
              ) : (
                <code className="block break-all rounded-md bg-muted p-2 text-xs">
                  {created.joinString}
                </code>
              )}
              <p className="text-xs text-muted-foreground">
                <T>
                  Paste it in the main host's Add member. Certificate SHA-256:{" "}
                  <Var>{created.fingerprint}</Var>
                </T>
              </p>
            </div>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            <T>Close</T>
          </DialogClose>
          {created === null ? (
            <Button form={formId} type="submit" disabled={busy}>
              {busy ? gt("Creating…") : gt("Create invite")}
            </Button>
          ) : created.joinString !== null ? (
            <Button type="button" onClick={() => copyToClipboard(created.joinString!, undefined)}>
              {isCopied ? gt("Copied") : gt("Copy join string")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function MemberOfRow({
  environmentId,
  hostLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
}) {
  const gt = useGT();
  const canLeave = useAtomValue(clusterEnvironment.leave.permissionAtom(environmentId));
  const leave = useAtomCommand(clusterEnvironment.leave, { label: "leave cluster" });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const confirmed = await (requestConfirmDialog(
      gt("Leave the cluster of {host}? Pair clients with this machine again afterwards.", {
        host: hostLabel,
      }),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    await leave({ environmentId, input: {} });
    setBusy(false);
  };
  return (
    <SettingsRow
      title={gt("Member of {host}", { host: hostLabel })}
      description={gt(
        "{host} manages this environment and is the only machine besides this one that can reach it.",
        { host: hostLabel },
      )}
      control={
        canLeave ? (
          <Button size="xs" variant="destructive-outline" disabled={busy} onClick={() => void submit()}>
            {busy ? gt("Leaving…") : gt("Leave cluster")}
          </Button>
        ) : null
      }
    />
  );
}
```

The dimmed row uses `opacity-60` on a plain layout `div`, not on a `components/ui` export; every `Button` picks an existing `variant`/`size` (`outline`/`xs` as in `AuthorizedClientsSettings.tsx`).

- [ ] **Step 4: Run the tests and typecheck**

Run: `vp test run apps/web/src/components/settings/settingsSearch.test.ts`
Expected: PASS.

Run: `vp run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/state/cluster.ts apps/web/src/components/settings/ClusterSettings.tsx apps/web/src/components/settings/LabsSettingsPanel.tsx apps/web/src/components/settings/settingsSearch.ts apps/web/src/components/settings/settingsSearch.test.ts apps/web/src/components/settings/useAvailableSettingsSearchItems.ts apps/web/src/components/settings/ConnectionsSettings.tsx
git commit -m "feat(web): cluster settings for main hosts and members

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Peer-link screens say "Managed by cluster"

**Files:**

- Modify: `apps/web/src/components/settings/LinkedEnvironmentsSettings.tsx:1-50` (imports), `:57-115` (`LinkedEnvironmentsSettings`)
- Modify: `apps/mobile/src/features/connection/LinkedEnvironmentsSection.tsx:1-16` (imports), `:18-30` and `:60` (render)

**Interfaces:**

- Consumes: `clusterName` (Task 7); `clusterEnvironment.status` (web Task 8, mobile Task 10 Step 3 — create `apps/mobile/src/state/cluster.ts` first if executing out of order).
- Produces: no new exports. The status query runs only where `capabilities.cluster` is true, so older hosts are untouched; the Labs flag is not required because a clustered environment keeps refusing links with the beta off.

No new test: the decision is `clusterName`, tested in Task 7; the rest is rendering.

- [ ] **Step 1: Web**

`LinkedEnvironmentsSettings.tsx` imports: add `import { clusterName } from "@t3tools/client-runtime/state/cluster";`, `import { clusterEnvironment } from "~/state/cluster";`, `import { useEnvironment } from "~/state/environments";`. At the top of `LinkedEnvironmentsSettings`, before `links`:

```tsx
  const environment = useEnvironment(environmentId);
  const clusterStatus = useEnvironmentQuery(
    environment?.serverConfig?.environment.capabilities.cluster === true
      ? clusterEnvironment.status({ environmentId, input: {} })
      : null,
  );
  const managedBy =
    clusterStatus.data === null ? null : clusterName(clusterStatus.data, environment?.label ?? "");
```

Pass `managedBy === null ? peerLinkEnvironment.list({ environmentId, input: {} }) : null` to the existing links `useEnvironmentQuery`, change `headerAction` to `canLink && managedBy === null ? <LinkEnvironmentAction environmentId={environmentId} /> : null`, and make the first branch of the body:

```tsx
      {managedBy !== null ? (
        <SettingsRow
          title={gt("Managed by cluster {name}", { name: managedBy })}
          description={gt(
            "Clustered environments do not link to other environments. Agents here reach the other members through the main host.",
          )}
        />
      ) : links.error ? (
```

- [ ] **Step 2: Mobile**

`LinkedEnvironmentsSection.tsx` imports: `import { clusterName } from "@t3tools/client-runtime/state/cluster";`, `import { clusterEnvironment } from "../../state/cluster";`. After `const config = …`:

```tsx
  const clusterStatus = useEnvironmentQuery(
    config?.environment.capabilities.cluster === true
      ? clusterEnvironment.status({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const managedBy =
    clusterStatus.data === null ? null : clusterName(clusterStatus.data, props.environmentLabel);
```

Change `const supported = canRead && offersLinkedEnvironments(config);` to `const supported = canRead && managedBy === null && offersLinkedEnvironments(config);`, and before the existing `if (!supported || …) return null;`:

```tsx
  if (managedBy !== null) {
    return (
      <View className="mt-5 gap-3">
        <SettingsSection
          title={gt("Linked from {environment}", { environment: props.environmentLabel })}
        >
          <View className="gap-0.5 p-4">
            <Text className="text-base font-t3-bold text-foreground">
              {gt("Managed by cluster {name}", { name: managedBy })}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {gt(
                "Clustered environments do not link to other environments. Agents here reach the other members through the main host.",
              )}
            </Text>
          </View>
        </SettingsSection>
      </View>
    );
  }
```

`ConnectionsRouteScreen.tsx` mounts this section for every connected environment, so clustered ones now show the notice.

`LinkedEnvironmentsSection.test.tsx` mocks `../../state/entities` without `cluster`; add `vi.mock("../../state/cluster", () => ({ clusterEnvironment: { status: () => null } }));` beside its other mocks so the existing test keeps its module graph light.

- [ ] **Step 3: Run the tests and typecheck**

Run: `vp test run apps/mobile/src/features/connection/LinkedEnvironmentsSection.test.tsx apps/web/src/components/settings/LinkedEnvironmentsSettings.browser.test.tsx`
Expected: PASS.

Run: `vp run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/settings/LinkedEnvironmentsSettings.tsx apps/mobile/src/features/connection/LinkedEnvironmentsSection.tsx apps/mobile/src/features/connection/LinkedEnvironmentsSection.test.tsx
git commit -m "feat(clients): peer link screens name the managing cluster

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Mobile — Labs switch and Cluster section

**Files:**

- Create: `apps/mobile/src/state/cluster.ts`, `apps/mobile/src/features/connection/ClusterSection.tsx`
- Modify: `apps/mobile/src/features/settings/ThreadSettingsSections.tsx:49-57` (section), `:260` (setting type), `:271` (capability type), `:312-317` (patch)
- Modify: `apps/mobile/src/features/connection/ConnectionsRouteScreen.tsx:10-15` (imports), `:57-75` (list filter and mount)

**Interfaces:**

- Consumes: Task 7 exports; mobile `connectionAtomRuntime`, `useEnvironments`, `useEnvironmentsWithScope`, `useEnvironmentQuery`, `useAtomCommand`, `SettingsSection`, `AppTextInput`, `Button`, `expo-clipboard`.
- Produces: mobile `clusterEnvironment`, `useClusterHosts()`, `ClusterSection` (list with status and reason, add by join string, invite, remove, leave). Rename stays on web and desktop.

No new test: logic lives in Task 7; the section is rendering and callback wiring.

- [ ] **Step 1: State**

`apps/mobile/src/state/cluster.ts`:

```ts
import {
  createClusterEnvironmentAtoms,
  offersCluster,
} from "@t3tools/client-runtime/state/cluster";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { useEnvironmentsWithScope } from "./session";

export const clusterEnvironment = createClusterEnvironmentAtoms(connectionAtomRuntime);

/** Connected environments that show a Cluster section. Members show under their main host. */
export function useClusterHosts() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.entry.target._tag !== "ClusterConnectionTarget" &&
      offersCluster(environment.serverConfig),
  );
  const readable = useEnvironmentsWithScope(supported, AuthOrchestrationReadScope);
  return supported.filter((environment) => readable.has(environment.environmentId));
}
```

- [ ] **Step 2: Labs switch**

`ThreadSettingsSections.tsx`, after the Linked environments `MachineBetaSection`:

```tsx
        <MachineBetaSection
          title={gt("Cluster")}
          icon="link"
          capability="cluster"
          setting="clusterEnabled"
          description={gt(
            "Drive a machine's members through it. Turn it on for the main host and each member. While off, a machine adds no members and forwards nothing to them.",
          )}
        />
```

Change `type MachineBetaSetting = "linkedEnvironmentsEnabled" | "fastWorktreeCheckout";` to add `| "clusterEnabled"`, the `capability` prop type to `"peerLinks" | "fastWorktreeCheckout" | "cluster"`, and the patch to:

```tsx
                    patch:
                      setting === "linkedEnvironmentsEnabled"
                        ? { linkedEnvironmentsEnabled: value }
                        : setting === "clusterEnabled"
                          ? { clusterEnabled: value }
                          : { fastWorktreeCheckout: value },
```

- [ ] **Step 3: Section**

`apps/mobile/src/features/connection/ClusterSection.tsx`:

```tsx
import { useAtomValue } from "@effect/atom-react";
import {
  clusterAddTarget,
  clusterMemberStatusText,
} from "@t3tools/client-runtime/state/cluster";
import type { ClusterMember, EnvironmentId } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { clusterEnvironment } from "../../state/cluster";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

export function ClusterSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const gt = useGT();
  const status = useEnvironmentQuery(
    clusterEnvironment.status({ environmentId: props.environmentId, input: {} }),
  );
  const role = status.data?.role ?? null;
  const members = useEnvironmentQuery(
    role === "main"
      ? clusterEnvironment.members({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const canWrite = useAtomValue(clusterEnvironment.addMember.permissionAtom(props.environmentId));
  const addMember = useAtomCommand(clusterEnvironment.addMember, { label: "add cluster member" });
  const leave = useAtomCommand(clusterEnvironment.leave, { label: "leave cluster" });
  const invite = useAtomCommand(clusterEnvironment.invite, { label: "create cluster invite" });
  const [joinInput, setJoinInput] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [joinString, setJoinString] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (status.data === null || role === null) return null;
  const target = clusterAddTarget(joinInput, { ssh: false });
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  return (
    <View className="mt-5 gap-3">
      <SettingsSection title={gt("Cluster · {environment}", { environment: props.environmentLabel })}>
        {role === "member" ? (
          <View className="gap-2 p-4">
            <Text className="text-base font-t3-bold text-foreground">
              {gt("Member of {host}", { host: status.data.host?.label ?? "" })}
            </Text>
            {canWrite ? (
              <Button
                label={gt("Leave cluster")}
                tone="danger"
                size="compact"
                loading={busy}
                onPress={() =>
                  Alert.alert(gt("Leave cluster?"), gt("Pair clients with this machine again afterwards."), [
                    { text: gt("Cancel"), style: "cancel" },
                    {
                      text: gt("Leave cluster"),
                      style: "destructive",
                      onPress: () =>
                        void run(() => leave({ environmentId: props.environmentId, input: {} })),
                    },
                  ])
                }
              />
            ) : null}
          </View>
        ) : (
          <>
            {(members.data ?? []).map((member) => (
              <ClusterMemberItem
                key={member.environmentId}
                environmentId={props.environmentId}
                hostLabel={props.environmentLabel}
                member={member}
                canWrite={canWrite}
              />
            ))}
            {canWrite ? (
              <View className="gap-2 p-4">
                <AppTextInput
                  value={joinInput}
                  onChangeText={setJoinInput}
                  placeholder={gt("Paste a join string")}
                  accessibilityLabel={gt("Join string")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                  className="rounded-[14px] px-4 py-3.5"
                />
                <Button
                  label={gt("Add member")}
                  size="compact"
                  disabled={target === null}
                  loading={busy}
                  onPress={() =>
                    void run(async () => {
                      if (target === null) return;
                      const result = await addMember({
                        environmentId: props.environmentId,
                        input: { target },
                      });
                      if (result._tag === "Success") setJoinInput("");
                    })
                  }
                />
                <AppTextInput
                  value={inviteUrl}
                  onChangeText={setInviteUrl}
                  placeholder="https://box.local:3773"
                  accessibilityLabel={gt("Address the main host reaches this machine at")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="rounded-[14px] px-4 py-3.5"
                />
                <Button
                  label={gt("Invite to cluster")}
                  size="compact"
                  tone="secondary"
                  loading={busy}
                  onPress={() =>
                    void run(async () => {
                      const result = await invite({
                        environmentId: props.environmentId,
                        input: inviteUrl.trim() ? { url: inviteUrl.trim() } : {},
                      });
                      if (result._tag === "Success") setJoinString(result.value.joinString);
                    })
                  }
                />
                {joinString === null ? null : (
                  <Button
                    label={gt("Copy join string")}
                    size="compact"
                    tone="text"
                    onPress={() => void Clipboard.setStringAsync(joinString).catch(() => undefined)}
                  />
                )}
                <Text className="text-xs text-foreground-muted">
                  {gt("Certificate SHA-256: {fingerprint}", {
                    fingerprint: status.data.fingerprint,
                  })}
                </Text>
              </View>
            ) : null}
          </>
        )}
      </SettingsSection>
    </View>
  );
}

function ClusterMemberItem(props: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
  readonly member: ClusterMember;
  readonly canWrite: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const removeMember = useAtomCommand(clusterEnvironment.removeMember, {
    label: "remove cluster member",
  });
  const online = props.member.status === "online";
  return (
    <View className={online ? "gap-0.5 p-4" : "gap-0.5 p-4 opacity-60"}>
      <Text className="text-base font-t3-bold text-foreground">{props.member.label}</Text>
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {props.member.address}
      </Text>
      <Text
        className={online ? "text-xs text-foreground-muted" : "text-xs text-danger-foreground"}
        numberOfLines={2}
      >
        {clusterMemberStatusText(props.member, props.hostLabel, m)}
      </Text>
      {props.canWrite ? (
        <Button
          label={gt("Remove")}
          tone="text"
          size="compact"
          onPress={() =>
            Alert.alert(
              gt("Remove {label}?", { label: props.member.label }),
              gt("It becomes a standalone environment again."),
              [
                { text: gt("Cancel"), style: "cancel" },
                {
                  text: gt("Remove"),
                  style: "destructive",
                  onPress: () =>
                    void removeMember({
                      environmentId: props.environmentId,
                      input: { memberId: props.member.environmentId },
                    }),
                },
              ],
            )
          }
        />
      ) : null}
    </View>
  );
}
```

- [ ] **Step 4: Mount and hide members from the saved list**

`ConnectionsRouteScreen.tsx`: import `{ ClusterSection } from "./ClusterSection"`, `{ useClusterHosts } from "../../state/cluster"`, `{ useEnvironments } from "../../state/environments"`. In the component:

```tsx
  const clusterHosts = useClusterHosts();
  const { environments } = useEnvironments();
  const clusterMemberIds = new Set(
    environments
      .filter((environment) => environment.entry.target._tag === "ClusterConnectionTarget")
      .map((environment) => environment.environmentId),
  );
```

Pass `environments={connectedEnvironments.filter((environment) => !clusterMemberIds.has(environment.environmentId))}` to `LocalEnvironmentList`, and after the `LinkedEnvironmentsSection` map:

```tsx
        {clusterHosts.map((environment) => (
          <ClusterSection
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environmentLabel={environment.label}
          />
        ))}
```

- [ ] **Step 5: Typecheck and commit**

Run: `vp run typecheck`
Expected: no errors.

```bash
git add apps/mobile/src/state/cluster.ts apps/mobile/src/features/connection/ClusterSection.tsx apps/mobile/src/features/settings/ThreadSettingsSections.tsx apps/mobile/src/features/connection/ConnectionsRouteScreen.tsx
git commit -m "feat(mobile): cluster section and Labs switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Translations

**Files:**

- Modify: `apps/web/src/i18n/translations/{de,es,fr,ja,ko,pt-BR,ru,sv,zh}.json` and `en.json` (generated)
- Modify: `apps/mobile/src/i18n/translations/{de,es,fr,ja,ko,pt-BR,ru,sv,zh}.json` and `en.json` (generated)

**Interfaces:**

- Consumes: every `gt()`, `<T>` and `msg()` string added in Tasks 2, 4, 7, 8, 9, 10 (shared `msg()` strings appear in both apps' catalogs).
- Produces: complete catalogs.

- [ ] **Step 1: Generate**

Run: `cd apps/web && vp run i18n:generate && cd ../mobile && vp run i18n:generate`
Expected: new keys in every locale file with English values; `en.json` is not edited by hand.

- [ ] **Step 2: Translate**

List the new keys with `git diff -U0 apps/web/src/i18n/translations/de.json apps/mobile/src/i18n/translations/de.json`. For each of the nine non-English locales in both apps, replace every new English value with its translation. Keep `{host}`, `{label}`, `{name}`, `{time}`, `{fingerprint}`, `{environment}` and ICU syntax exactly; keep "T3 Code", "SSH", "HTTPS", "SHA-256", `ssh-agent`, `user@host` and `t3 cluster leave` in English (docs/internals/i18n.md, "What stays English"). Use the locale's existing term for "environment", "main host" ("Settings → Environments" wording already in each file) and "Labs".

- [ ] **Step 3: Check**

Run: `vp run i18n:check`
Expected: exits 0 with no missing or untranslated key reported for the new strings.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/i18n/translations apps/mobile/src/i18n/translations
git commit -m "feat(i18n): translate cluster settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: Docs

**Files:**

- Modify: `docs/user/remote-access.md` — new `## Cluster` section after `## Link another environment` (ends at `:401`)
- Modify: `docs/internals/connection-runtime.md` — new `## Cluster members` section after `## HTTP authorization` (ends at `:63`)

- [ ] **Step 1: User guide**

Insert before `## Manage or revoke access`:

```md
## Cluster

A cluster puts several machines behind one **main host**. Connect any app to
the main host and every member shows up as an ordinary environment, marked
**via** the main host: threads, diffs, terminals and previews work there
without pairing anything with the member.

Cluster is a beta. Turn it on in **Settings → Labs** on the main host and on
each machine you add.

To add a machine over HTTPS:

1. On that machine, open **Settings → Environments → Cluster** and choose
   **Invite to cluster**, or run `t3 cluster invite --url https://<address>`.
   Enter the address the main host can reach it at. It shows a join string and
   its certificate fingerprint.
2. On the main host, choose **Add member** in the same place and paste the
   join string, or run `t3 cluster add <join string>`. The main host pins that
   certificate; if it changes later, invite the machine again.

To add a machine over SSH instead, enter `user@host` in **Add member** on the
web or desktop app, or run `t3 cluster add ssh://user@host`. The main host
starts T3 Code there itself, so it needs an SSH key or a running ssh-agent; it
cannot answer password prompts. The mobile app adds members by join string
only.

- Joining signs out the member's other clients and ends its linked
  environments. From then on it accepts only its main host and apps on its own
  machine. No machine in a cluster takes part in linked environments.
- A member that stops answering stays listed, dimmed, with the reason. One on
  a different T3 Code version shows as incompatible until both match.
- While the main host is offline, its apps cannot reach the members; work
  already running on a member continues.

To take a machine out, choose **Remove** next to it on the main host, or
**Leave cluster** on the member itself (`t3 cluster leave`). It becomes a
standalone environment again, and you pair apps with it as usual.
```

- [ ] **Step 2: Internals**

Insert after the HTTP authorization section:

```md
## Cluster members

A member of a cluster has no credential of its own on the client. Its
connection borrows the main host's current one
([`clusterHosts.ts`](../../packages/client-runtime/src/connection/clusterHosts.ts)),
so the registry adds members from the host's `cluster.members` subscription,
never saves them, and drops them when they leave the list. A saved or
platform entry for the same environment wins, because the user chose that
route.

A member's base URL is `<main>/cluster/<memberId>`. Endpoint URLs join onto
the base path (`environmentEndpointUrl`); `new URL("/path", base)` would send
the request to the main host itself. A DPoP token that reaches a member was
minted for the main host, so renewals use `httpAuthorization.issuedFor`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/user/remote-access.md docs/internals/connection-runtime.md
git commit -m "docs: cluster guide and member connection notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Integrated pass (primary agent only)

Subagents skip this task. It needs Plans 1 and 2 merged into this branch. Follow `.agents/skills/test-t3-app/SKILL.md`. Never touch `~/.t3`, never set `VITE_HTTP_URL`/`VITE_WS_URL`, and stop only the background tasks you started.

- [ ] **Step 1: Second checkout for the member**

```bash
git worktree add ../t3code-cluster-member HEAD
```

Wait for its setup markers (`.t3/setup-done`); with no marker, run `vp i` there.

- [ ] **Step 2: Turn the beta on in both homes**

Before either server starts, in each worktree:

```bash
mkdir -p .t3/userdata
node -e 'const f=".t3/userdata/settings.json";const fs=require("fs");const s=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};s.clusterEnabled=true;fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")'
```

- [ ] **Step 3: Start both dev servers**

Run `vp run dev` in this worktree (main host) and in `../t3code-cluster-member` (member), each with the harness's background option. Read each server port from its `[dev-runner]` line; call the member's `MEMBER_PORT`.

- [ ] **Step 4: Invite the member over HTTPS**

From `../t3code-cluster-member`:

```bash
node apps/server/src/bin.ts cluster invite --base-dir .t3 --url "https://127.0.0.1:$MEMBER_PORT" --json
```

Expected: JSON with `joinString` `https://127.0.0.1:<port>#<code>.<64 hex>`.

- [ ] **Step 5: Add it from the main host's web client**

Open the main host's pairing URL in the Browser panel. In **Settings → Labs** the Cluster switch is on. In **Settings → Environments → Cluster**, choose **Add member**, paste the join string with a line break inserted in the middle, and submit. Expected: the member row shows a green dot, HTTPS, its address and "Last seen …"; the member does not appear in the saved Environments list; it appears as an environment labeled "via <main host>".

- [ ] **Step 6: Drive a member thread**

Start a new thread in one of the member's projects from the main host's web client, pick `Replay (dev)` with the `showcase` model, and send "go". Expected: the turn streams (thinking, plan, tools, approval); open its diff and terminal. Capture screenshots.

- [ ] **Step 7: Offline and back**

Stop the member's dev server task. Expected within one probe round (30 s): the member row dims with "Not answering …" or the proxy's reason, and the member environment shows reconnecting. Start it again; it returns online and the thread view resumes.

- [ ] **Step 8: Leave and confirm standalone**

From `../t3code-cluster-member`: `node apps/server/src/bin.ts cluster leave --base-dir .t3`, then `node apps/server/src/bin.ts cluster list --base-dir .t3 --json`. Expected: role `standalone`. On the main host the row turns `revoked` with "No longer accepts …"; choose **Remove**; the member disappears from the sidebar and from the Cluster list. **Settings → Environments → Linked environments** on the main host no longer shows "Managed by cluster" once it has no members.

- [ ] **Step 9: Mobile glance (optional, when a device host is available)**

With `test-t3-mobile`, connect the app to the main host and open **Settings → Environments**: the Cluster section lists the member with its status; **Settings → Labs** shows the Cluster switch.

- [ ] **Step 10: Clean up**

Stop both background dev server tasks with the harness's stop, then `git worktree remove ../t3code-cluster-member`. Run `vp run check:changed`.

---

## Self-Review Against the Spec

| Spec requirement | Where |
| --- | --- |
| Route `Cluster { hostEnvironmentId, memberId }`, base URL `<main-url>/cluster/<memberId>` | Task 2 (`ClusterConnectionTarget`, `environmentId` = memberId), Task 4 (`clusterMemberBaseUrl`), Task 1 (URLs keep the prefix) |
| Members from `cluster.members`, ephemeral, dropped when they leave | Tasks 5, 6 |
| Existing runtime handles drivers, reconnects, capability checks; web, desktop, mobile share it | Tasks 4–6 live in `packages/client-runtime`; the supervisor, driver and `orchestrationProtocolCompatibilityError` run unchanged on member descriptors |
| Clients authenticate only to the main host | Task 4 borrows the host's cookie, bearer or DPoP token; no member credential exists on the client |
| `502` treated as disconnect and retried | Plan 2 statuses map to `RemoteEnvironmentAuthUndeclaredStatusError` → transient (existing `errors.ts`); no client change needed |
| Member status `online/offline/incompatible/revoked` surfaced, offline dimmed with reason | `ClusterConnectionTarget.status/statusDetail` (Task 5), `clusterMemberStatusText` (Task 7), web and mobile member rows (Tasks 8, 10) |
| "via <main host>" | `connectionRouteLabel(Text)` (Task 2), `environmentTransportLabel` (Task 2) |
| Settings → Cluster behind Labs flag, standalone / main / member views | Tasks 7, 8, 10; Labs switches in Tasks 8, 10 |
| Mobile adds by join string only | `clusterAddTarget(…, { ssh: false })` (Task 10) |
| Peer link screens show "Managed by cluster <name>" | Task 9 |
| Strings in every web and mobile locale | Task 11 |
| `docs/user` Cluster section | Task 12 |
| Client-runtime tests: members add/remove registry entries; route resolves URL | Task 5 tests; Task 4 tests |
| One integrated pass over HTTPS with Replay, then leave | Task 13 |

Deliberate choices: Settings → Cluster is a section of Settings → Environments (beside Linked environments), not a new sidebar page. Members are hidden from the saved-environments list there and shown in their host's Cluster section. A saved entry for a member's environment wins over the cluster entry. Mobile gets Remove (the way out of Add) but not Rename. Webhook addresses and MCP URLs for members are out of scope (Plan 4 owns agent routing).
