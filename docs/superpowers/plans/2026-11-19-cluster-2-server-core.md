# Cluster 2: Server Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A T3 server can invite itself into a cluster, add members over pinned HTTPS or SSH, hold one control link to each member (which gives their status and carries member agents' calls back), forward `/cluster/<memberId>/*` to them with the client's scopes as a cap, and leave or remove members again. Clustered environments take no part in peer links.

**Architecture:** One `ClusterService` (`apps/server/src/cluster/`) owns join, leave, list, the control links and refusals; RPC handlers, the `/api/cluster/*` HTTP group, the proxy route and the CLI are thin transports over it. A small `ClusterRole` service reads the two new tables so `EnvironmentAuth`, `PeerLinks`, `McpOAuth` and `/mcp` can refuse by role without depending on `ClusterService`. Upstream connections go through `ClusterUpstream`: one undici `Agent` per pinned fingerprint (a connector that hands undici the socket only after the SHA-256 matches), or the existing `packages/ssh` loopback forward. The member side trusts a `cluster-host` session and caps it per request from `x-t3-cluster-scopes`; the proxy always overwrites that header with the authenticated client's scopes. The main host keeps one supervised fiber per member that opens the member's `/ws` as its `cluster-host` session and subscribes to `cluster.hostChannel`; the member's `ready` event marks it `online`, a dropped socket marks it `offline` and reconnects with backoff, and a failed preflight marks it `incompatible` or `revoked`. Calls from member agents arrive on that subscription, run through a `serve` function the server passes to `ClusterService.start`, and go back with `cluster.hostReply`.

**Tech Stack:** Effect 4 services (`Context.Service`, `Effect.fn`), `effect/sql` SQLite, `effect/http` + `HttpApi`, `effect/socket`, `effect/rpc` (`RpcClient.makeProtocolSocket`, `RpcServer`), `FiberMap`, npm `undici` (`Agent`, `WebSocket`), `@effect/platform-node/NodeHttpClient.makeUndici`, `@t3tools/ssh/tunnel`, `@effect/vitest`.

**Spec:** `docs/superpowers/specs/2026-11-19-environment-cluster-design.md`

## Global Constraints

Verbatim from the spec; every task honours them.

- "**Main host proxies.** Clients reach members through the main host, never directly."
- "**Members fully trust the main host.** The main host authenticates clients and enforces their scopes; it also caps each upstream socket to the originating client's scopes."
- "**Dial-in only.** The main host always initiates. Two transports: pinned HTTPS with a pairing code, or SSH."
- "**Cluster is separate from peer links.** Any clustered environment (main host or member) takes no part in peer links in either direction."
- "**Exclusivity is enforced by the member's server.** A member accepts only its cluster link and loopback sessions."
- "**No nesting.** A member cannot add members; a main host cannot join another cluster."
- "The main host serves `/cluster/<memberEnvironmentId>/*`. It authenticates the client normally, then forwards HTTP requests and pipes WebSocket upgrades to the member's same path without the prefix."
- "Each client socket gets its own upstream socket, opened on demand. No multiplexer."
- "Upstream requests carry the main host's `cluster-host` credential plus a header with the originating client's scopes. The member caps that session to those scopes, once per socket."
- Join string: "`<url>#<code>.<sha256>`".
- Member status: "`online | offline | incompatible | revoked`".
- "member unreachable | proxy `502 {code:"cluster_member_unreachable", memberId}`"; "fingerprint mismatch | hard fail "certificate changed", no fallback; admin re-invites"; "member revoked main host | upstream `401`; member marked `revoked`; row kept until admin removes it"; "protocol version mismatch | checked per upstream connect; member shown `incompatible`"; "SSH failure | existing `packages/ssh` errors surfaced as is".
- "SSH is only how the main host's server reaches the member. It uses the main host machine's SSH keys or agent; a password or passphrase prompt fails with a clear error. No client is involved, desktop included."
- "The main host keeps one long-lived WebSocket RPC session to each member (its `cluster-host` session, over pinned HTTPS or the SSH forward), reconnecting with backoff."
- "Member status comes from the link: connected is `online`, a protocol mismatch on connect is `incompatible`, `401` is `revoked`, otherwise `offline`. No polling loop."
- "Members never need an address for the main host. Calls from a member to the main host ride the link in reverse: the member exposes a `cluster.hostChannel` subscription carrying requests, and the main host answers each with `cluster.hostReply(requestId, result)`."
- "Requests queued while the link is down fail with "cluster host unreachable" and are never delivered twice."
- Tables `cluster_members` (`environment_id` PK, `label`, `transport`, `url` / `ssh_target`, `cert_sha256`, `secret_name`, `joined_at`, `last_reached_at`, `last_error`) and `cluster_membership` ("one row with the main host's `environment_id`, label, and `joined_at`. Its presence means "is a member". Rows in `cluster_members` mean "is a main host".").
- "new RPCs added to `CLIENT_GUARDED_RPC_SCOPES` (`access:write` for add/remove/invite/leave)."
- "Labs setting `clusterEnabled`, default false, gating both sides."
- "Each refusal returns a clear error naming the cluster": peer link create or accept on any clustered environment; ordinary pairing codes on a member; add member on a member; join on a main host.
- Repo rules (AGENTS.md): `Effect.fn("Service.op")` for reusable functions; transports decode, call one service method, map errors; tests at the lowest layer that fails on `main`, extending existing files; `it.effect` + `TestClock`, `it.live` only for socket fixtures; no sleeps, polling, timeouts or retries in tests; minimal comments; `vp test run <files>`; `vp run typecheck`; never `vp check` or repo-wide test runs.

## Interfaces With Other Plans

**Consumed from Plan 1 (`docs/superpowers/plans/2026-11-19-cluster-1-https.md`):** a service module `apps/server/src/tls/ServerTls.ts` exporting

```ts
export class ServerTls extends Context.Service<
  ServerTls,
  { readonly secureContext: NodeTls.SecureContext; readonly fingerprint: string } // fingerprint: lowercase hex SHA-256 of the DER certificate, no colons
>()("t3/tls/ServerTls") {}
export const layer: Layer.Layer<ServerTls, never, ServerSecretStore.ServerSecretStore /* | whatever plan 1 needs */>;
```

and the listener serving TLS and plain HTTP on one port. If Plan 1 lands a different path or name, change only the imports in Tasks 6, 7 and 11. Tests here never need a real `ServerTls`; they use `Layer.mock(ServerTls.ServerTls)({ fingerprint: FINGERPRINT })`. This plan normalizes any fingerprint it compares with `normalizeCertificateFingerprint` (strips `:`, lowercases), so Plan 1 may also return Node's `AB:CD:…` form.

**Produced for Plan 3 (client runtime, web, mobile):**

Member `status`, `lastReachedAt` and `lastError` come from the control link (Task 8): `online` while it is up, `offline` from the moment it drops (and right after `addMember`, until the link is up), `incompatible` or `revoked` when its preflight says so.

- `@t3tools/contracts`: `ClusterMember`, `ClusterMemberStatus`, `ClusterTransport`, `ClusterRole`, `ClusterStatus`, `ClusterInviteInput`, `ClusterInvite`, `ClusterAddMemberInput`, `ClusterMemberRef`, `ClusterRenameMemberInput`, `ClusterRemoveMemberResult`, `ClusterLeaveResult`, `ClusterError`, `CLUSTER_ROUTE_PREFIX`, `clusterMemberBaseUrl(hostBaseUrl, memberId)`, `parseClusterJoinString`, `formatClusterJoinString`, `parseClusterSshTarget`, `normalizeCertificateFingerprint`.
- `WS_METHODS.clusterStatus` (`cluster.status`, `orchestration:read`), `WS_METHODS.clusterMembers` (`cluster.members`, stream of `ReadonlyArray<ClusterMember>`, `orchestration:read`), and guarded (`access:write`) `WS_METHODS.clusterInvite`, `clusterAddMember`, `clusterRemoveMember`, `clusterRenameMember`, `clusterLeave`, all in `CLIENT_GUARDED_RPC_SCOPES` except the two reads.
- `ExecutionEnvironmentCapabilities.cluster` (`true` on this server), `ServerSettings.clusterEnabled` (Labs, default `false`), `PeerLinkError.reason` `"clustered"`.
- Proxy behaviour at `<main>/cluster/<memberId>`: answers `POST …/api/auth/websocket-ticket[/rpc|/media]` itself with a **main-host** ticket for the caller's session, so the existing connection runtime needs no special ticket path; other failures are `502 {code: "cluster_member_unreachable" | "cluster_member_incompatible" | "cluster_member_revoked", memberId}`, `403 {code: "cluster_disabled"}`, `404` for an unknown member.

**Produced for Plan 4 (agent MCP routing):**

- `EnvironmentAuth.CLUSTER_HOST_SUBJECT` (`"cluster-host"`), accepted on RPC, HTTP and `/mcp`; `authenticateMcpClient` maps it to `{ access: "full-access", peerLink: false, cluster: true }` (`McpClientSession.cluster?: boolean`), so `/mcp` can tell the main host apart from other clients.
- `CLUSTER_SCOPES_HEADER` (`"x-t3-cluster-scopes"`) and its rule: honoured only for `cluster-host` sessions, only narrows.
- `ClusterService.connect(memberId): Effect<MemberConnection, ClusterError>` with `MemberConnection = { upstream: ClusterUpstream.Upstream; token: string; member: ClusterMember }` and `Upstream = { origin; httpClient; webSocket }` — the way Plan 4 reaches a member's `/mcp` with the `cluster-host` credential.
- The control link (Task 8):
  - `@t3tools/contracts`: `ClusterHostRequest = { requestId; tool; arguments; limits: { runtimeMode; interactionMode }; sender? }`, `ClusterHostResult = { isError: boolean; text: string }` (an MCP tool result's joined text, as `/mcp` answers), `ClusterHostChannelEvent` (`{ _tag: "ready" } | { _tag: "request"; request }`), `ClusterHostReplyInput`, `WS_METHODS.clusterHostChannel` / `clusterHostReply`, `ClusterLinkRpcs`.
  - `ClusterService.start(serve: ClusterHostServe): Effect<void, never, Scope>` with `ClusterHostServe = (member: ClusterMember, request: ClusterHostRequest) => Effect<ClusterHostResult>`. `server.ts` passes `ClusterService.refuseHostRequests` here; Plan 4 replaces it with the function that runs the call through `/mcp`'s tools.
  - `ClusterService.hostCall(call: ClusterHostCall): Effect<ClusterHostResult, ClusterError>` (member side, `ClusterHostCall = Omit<ClusterHostRequest, "requestId">`). It fails at once with `clusterHostUnreachable(hostLabel)` (reason `"unreachable"`) while no link is up, and with the same error when the link drops before the answer.
  - `ClusterService.clusterHostUnreachable(hostLabel): ClusterError`.
- `server.ts` builds `ClusterService` inside the `PeerForwarding` provide (`Layer.provideMerge`), so `PeerForwarding` can read it with `Effect.serviceOption`.

## Review Focus

Untested failure modes most likely to bite, each with the test that pins it:

1. **A member's address changes** (DHCP, roaming laptop, new T3 Connect host). The admin re-invites on the member and re-adds it on the main host; the member rotates its `cluster-host` session, the main host updates `url`/`cert_sha256` in place and the proxy uses the new address with no restart. Test: Task 7, "re-adding a member at a new address moves the proxy there and retires the old token".
2. **Concurrent join of the same member twice** (two Add clicks, CLI plus UI). Each join rotates the member's host session; without serialization the main host can store the token the member already revoked. Test: Task 7, "two adds of one member racing leave the stored token the live one"; member-side variant in Task 6, "two hosts racing to join one member: one wins".
3. **Member removed while client sockets are piped through the proxy.** Sockets must close, not keep forwarding with a forgotten member's credential. Test: Task 9, "forwards a socket to the member with the client's scopes and closes it when the member is removed".
4. **Leave while the main host is offline.** Leave is local only: it revokes the host session and clears the row, and the member pairs clients again. Test: Task 6, "a member leaves without its main host and is standalone again".
5. **Scope header forged.** A non-cluster-host caller's header must not change its scopes, and a client must not widen its upstream cap by sending its own header to the main host. Tests: Task 3, "ignores the cluster scope header on any other session"; Task 9, "forwards HTTP to the member under the client's scopes, never the client's header".
6. **The link drops while a `hostChannel` request is in flight.** The member's agent must hear "cluster host unreachable" at once, not hang, and the main host must stop the work it started for that request instead of answering into a dead socket. Test: Task 8, "the control link carries a member's calls, fails them when it drops, and never sends one twice" (the in-flight call fails; the main host's `serve` is interrupted).
7. **The member restarts and replays.** Its pending calls die with the process; its agents and followers call again, and the link must not hand the main host an old request a second time. Retries with the same `clientRequestId` land once at the target (Plan 4). Test: Task 8, same test: after the link comes back, the first request the main host sees is the new one.
8. **The main host restarts.** Every member's link drops at once; statuses must not stay `online` from before the restart, and links must come back without anyone touching the member. Tests: Task 8, same test (`start` again resets statuses to `offline` and reconnects), and "a member that leaves shows revoked over its link, and only its host opens the channel" (a drop followed by a failed preflight).

## File Map

Create:

- `packages/contracts/src/cluster.ts`, `packages/contracts/src/cluster.test.ts`
- `apps/server/src/persistence/Migrations/099_Cluster.ts`
- `apps/server/src/cluster/ClusterRole.ts`, `ClusterRole.test.ts`
- `apps/server/src/cluster/pinnedTransport.ts`, `pinnedTransport.test.ts`
- `apps/server/src/cluster/ClusterUpstream.ts`
- `apps/server/src/cluster/ClusterService.ts`, `ClusterService.test.ts`, `ClusterService.testkit.ts`
- `apps/server/src/cluster/http.ts`
- `apps/server/src/cluster/ClusterProxy.ts`, `ClusterProxy.test.ts`
- `apps/server/src/cli/cluster.ts`

Modify: `packages/contracts/src/{index,environment,settings,peerLink,rpc,clientRpcPermissions,environmentHttp}.ts`; `apps/server/src/persistence/{Migrations,AuthPairingLinks,reconcileV2PreviewMigration.test}.ts`; `apps/server/src/auth/{EnvironmentAuth,EnvironmentAuth.test,http,McpOAuth,McpOAuth.test,RpcAuthorization,RpcAuthorization.test}.ts`; `apps/server/src/cloud/{http,CloudLink}.ts`; `apps/server/src/peer/{PeerLinks,PeerLinks.test,PeerLinks.testkit}.ts`; `apps/server/src/mcp/McpHttpServer.ts`; `apps/server/src/environment/ServerEnvironment.ts`; `apps/server/src/device/DeviceHubProxy.ts`; `apps/server/src/{ws,ws.test,server,binCli}.ts`; `packages/ssh/src/{tunnel,tunnel.test}.ts`; `docs/internals/{remote,environment-auth}.md`.

---

## Task 1: Contracts — cluster schemas, join strings, capability, Labs flag

**Files:**

- Create: `packages/contracts/src/cluster.ts`, `packages/contracts/src/cluster.test.ts`
- Modify: `packages/contracts/src/index.ts:47` (export), `packages/contracts/src/environment.ts:186-187` (capability), `packages/contracts/src/settings.ts:1484` and `:1919` (Labs flag), `packages/contracts/src/peerLink.ts:61-71` (reason)

**Interfaces:**

- Consumes: `EnvironmentId`, `TrimmedNonEmptyString` (`baseSchemas.ts`); `PAIRING_CODE_ALPHABET`, `PAIRING_CODE_LENGTH` (`auth.ts`).
- Produces: everything listed for Plan 3 above except the RPCs, plus `ClusterJoinRequest`, `ClusterJoinResult`, `CLUSTER_SCOPES_HEADER`, `formatClusterSshTarget`.

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/cluster.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "./baseSchemas.ts";
import {
  clusterMemberBaseUrl,
  formatClusterJoinString,
  formatClusterSshTarget,
  normalizeCertificateFingerprint,
  parseClusterJoinString,
  parseClusterSshTarget,
} from "./cluster.ts";

const SHA = "ab".repeat(32);

describe("cluster join strings", () => {
  it("round-trips the member's origin, code and certificate fingerprint", () => {
    const joinString = formatClusterJoinString({
      url: "https://box.local:3773/some/path",
      code: "K7M2Q9RZ3NWD",
      fingerprint: SHA.toUpperCase().match(/../g)!.join(":"),
    });
    expect(joinString).toBe(`https://box.local:3773#K7M2Q9RZ3NWD.${SHA}`);
    expect(parseClusterJoinString(` ${joinString} `)).toEqual({
      url: "https://box.local:3773",
      code: "K7M2Q9RZ3NWD",
      fingerprint: SHA,
    });
    expect(parseClusterJoinString(`https://box.local:3773#k7m2q9rz3nwd.${SHA}`)?.code).toBe(
      "K7M2Q9RZ3NWD",
    );
  });

  it.each([
    "https://box.local:3773",
    `https://box.local:3773#K7M2Q9RZ3NWD`,
    `https://box.local:3773#K7M2Q9RZ3NW1.${SHA}`,
    `https://box.local:3773#K7M2Q9RZ3NWD.${SHA}.extra`,
    `https://box.local:3773#K7M2Q9RZ3NWD.${SHA.slice(2)}`,
    `ftp://box.local#K7M2Q9RZ3NWD.${SHA}`,
    `me@box`,
  ])("rejects %s", (value) => {
    expect(parseClusterJoinString(value)).toBeUndefined();
  });

  it("normalizes Node's colon-separated fingerprints", () => {
    expect(normalizeCertificateFingerprint("AB:CD:EF")).toBe("abcdef");
  });
});

describe("cluster ssh targets", () => {
  it.each([
    ["me@box", { username: "me", hostname: "box", port: null }],
    ["ssh://me@box.example.com:2222", { username: "me", hostname: "box.example.com", port: 2222 }],
    ["box", { username: null, hostname: "box", port: null }],
  ] as const)("parses %s", (value, expected) => {
    expect(parseClusterSshTarget(value)).toEqual(expected);
    expect(parseClusterSshTarget(formatClusterSshTarget(expected))).toEqual(expected);
  });

  it.each(["", "me@", "me@box:0", "me@box:70000", "https://box", "a b"])("rejects %j", (value) => {
    expect(parseClusterSshTarget(value)).toBeUndefined();
  });
});

it("builds a member's base URL under the main host's origin", () => {
  expect(clusterMemberBaseUrl("https://studio.ts.net/", EnvironmentId.make("env/1"))).toBe(
    "https://studio.ts.net/cluster/env%2F1",
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run packages/contracts/src/cluster.test.ts`
Expected: FAIL — `Failed to resolve import "./cluster.ts"`.

- [ ] **Step 3: Write the contracts**

`packages/contracts/src/cluster.ts`:

```ts
import * as Schema from "effect/Schema";

import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "./auth.ts";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CLUSTER_ROUTE_PREFIX = "/cluster";
/** The forwarding client's scopes; a member caps its `cluster-host` session to them. */
export const CLUSTER_SCOPES_HEADER = "x-t3-cluster-scopes";

export const ClusterMemberStatus = Schema.Literals(["online", "offline", "incompatible", "revoked"]);
export type ClusterMemberStatus = typeof ClusterMemberStatus.Type;

export const ClusterTransport = Schema.Literals(["https", "ssh"]);
export type ClusterTransport = typeof ClusterTransport.Type;

export const ClusterMember = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  transport: ClusterTransport,
  /** The member's https origin, or its ssh target such as `me@box:2222`. */
  address: Schema.String,
  status: ClusterMemberStatus,
  joinedAt: Schema.DateTimeUtc,
  lastReachedAt: Schema.NullOr(Schema.DateTimeUtc),
  lastError: Schema.NullOr(Schema.String),
});
export type ClusterMember = typeof ClusterMember.Type;

export const ClusterRole = Schema.Literals(["standalone", "main", "member"]);
export type ClusterRole = typeof ClusterRole.Type;

export const ClusterStatus = Schema.Struct({
  enabled: Schema.Boolean,
  role: ClusterRole,
  /** This server's certificate SHA-256, shown beside invites. */
  fingerprint: Schema.String,
  host: Schema.NullOr(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      joinedAt: Schema.DateTimeUtc,
    }),
  ),
});
export type ClusterStatus = typeof ClusterStatus.Type;

export const ClusterInviteInput = Schema.Struct({
  /** Where the main host reaches this environment. Without it no join string is built. */
  url: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ClusterInviteInput = typeof ClusterInviteInput.Type;

export const ClusterInvite = Schema.Struct({
  code: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
  joinString: Schema.NullOr(TrimmedNonEmptyString),
  expiresAt: Schema.DateTimeUtc,
});
export type ClusterInvite = typeof ClusterInvite.Type;

export const ClusterAddMemberInput = Schema.Struct({
  /** A join string from the member, or an ssh target (`user@host`, `ssh://user@host:port`). */
  target: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ClusterAddMemberInput = typeof ClusterAddMemberInput.Type;

export const ClusterMemberRef = Schema.Struct({ memberId: EnvironmentId });
export type ClusterMemberRef = typeof ClusterMemberRef.Type;

export const ClusterRenameMemberInput = Schema.Struct({
  memberId: EnvironmentId,
  label: TrimmedNonEmptyString,
});
export type ClusterRenameMemberInput = typeof ClusterRenameMemberInput.Type;

export const ClusterRemoveMemberResult = Schema.Struct({
  removed: Schema.Boolean,
  /** False when the member could not be told; `t3 cluster leave` there finishes it. */
  memberNotified: Schema.Boolean,
});
export type ClusterRemoveMemberResult = typeof ClusterRemoveMemberResult.Type;

export const ClusterLeaveResult = Schema.Struct({ left: Schema.Boolean });
export type ClusterLeaveResult = typeof ClusterLeaveResult.Type;

/** What a main host sends to a member's `POST /api/cluster/join`. */
export const ClusterJoinRequest = Schema.Struct({
  code: TrimmedNonEmptyString,
  host: Schema.Struct({ environmentId: EnvironmentId, label: TrimmedNonEmptyString }),
});
export type ClusterJoinRequest = typeof ClusterJoinRequest.Type;

export const ClusterJoinResult = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  /** The member's `cluster-host` session token. */
  token: TrimmedNonEmptyString,
});
export type ClusterJoinResult = typeof ClusterJoinResult.Type;

export class ClusterError extends Schema.TaggedError<ClusterError>()(
  "ClusterError",
  {
    reason: Schema.Literals([
      "disabled",
      "is_member",
      "is_main_host",
      "self",
      "unknown_member",
      "invalid_target",
      "certificate_changed",
      "unreachable",
      "incompatible",
      "pairing_rejected",
      "ssh",
      "storage",
      "forbidden",
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
  { httpApiStatus: 409 },
) {}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const JOIN_CODE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

export const normalizeCertificateFingerprint = (value: string) =>
  value.replaceAll(":", "").toLowerCase();

export const formatClusterJoinString = (input: {
  readonly url: string;
  readonly code: string;
  readonly fingerprint: string;
}) =>
  `${new URL(input.url).origin}#${input.code}.${normalizeCertificateFingerprint(input.fingerprint)}`;

export const parseClusterJoinString = (value: string) => {
  const trimmed = value.trim();
  const hash = trimmed.lastIndexOf("#");
  if (hash < 0) return undefined;
  const url = URL.parse(trimmed.slice(0, hash));
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return undefined;
  const parts = trimmed.slice(hash + 1).split(".");
  if (parts.length !== 2) return undefined;
  const code = parts[0]!.toUpperCase();
  const fingerprint = parts[1]!.toLowerCase();
  if (!JOIN_CODE.test(code) || !SHA256_HEX.test(fingerprint)) return undefined;
  return { url: url.origin, code, fingerprint };
};

export interface ClusterSshTarget {
  readonly username: string | null;
  readonly hostname: string;
  readonly port: number | null;
}

export const parseClusterSshTarget = (value: string): ClusterSshTarget | undefined => {
  const match = /^(?:([^@\s/:]+)@)?([^@\s/:]+)(?::(\d{1,5}))?$/.exec(
    value.trim().replace(/^ssh:\/\//, ""),
  );
  if (match === null) return undefined;
  const port = match[3] === undefined ? null : Number(match[3]);
  if (port !== null && (port < 1 || port > 65_535)) return undefined;
  return { username: match[1] ?? null, hostname: match[2]!, port };
};

export const formatClusterSshTarget = (target: ClusterSshTarget) =>
  `${target.username === null ? "" : `${target.username}@`}${target.hostname}${
    target.port === null ? "" : `:${target.port}`
  }`;

export const clusterMemberBaseUrl = (hostBaseUrl: string, memberId: EnvironmentId) =>
  `${new URL(hostBaseUrl).origin}${CLUSTER_ROUTE_PREFIX}/${encodeURIComponent(memberId)}`;
```

`packages/contracts/src/index.ts`, after line 47 (`export * from "./peerLink.ts";`):

```ts
export * from "./cluster.ts";
```

`packages/contracts/src/environment.ts`, after the `linkFence` capability (line 186):

```ts
  /** Joins or hosts an environment cluster (`cluster.*` RPCs, `/api/cluster/*`, `/cluster/*`). */
  cluster: Schema.optionalKey(Schema.Boolean),
```

`packages/contracts/src/settings.ts` line 1484, after `linkedEnvironmentsEnabled`:

```ts
  /** Beta: group environments under one main host. Off refuses adding members and the cluster proxy. */
  clusterEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
```

and line 1919 (the patch struct):

```ts
  clusterEnabled: Schema.optionalKey(Schema.Boolean),
```

`packages/contracts/src/peerLink.ts`, in `PeerLinkError.reason` after `"disabled"`:

```ts
    "clustered",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `vp test run packages/contracts/src/cluster.test.ts`
Expected: PASS (14 tests).

Run: `vp run typecheck`
Expected: no errors (new fields are optional; `PeerLinkError` gains a literal).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/cluster.ts packages/contracts/src/cluster.test.ts packages/contracts/src/index.ts packages/contracts/src/environment.ts packages/contracts/src/settings.ts packages/contracts/src/peerLink.ts
git commit -m "feat(contracts): cluster members, join strings and Labs flag

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Persistence — cluster tables and `ClusterRole`

**Files:**

- Create: `apps/server/src/persistence/Migrations/099_Cluster.ts`, `apps/server/src/cluster/ClusterRole.ts`, `apps/server/src/cluster/ClusterRole.test.ts`
- Modify: `apps/server/src/persistence/Migrations.ts:108` (import) and `:209` (entry)
- Modify: `apps/server/src/persistence/reconcileV2PreviewMigration.test.ts:80` and `:201` (the expected migration lists)

**Interfaces:**

- Consumes: `SqlClient.SqlClient`; `ClusterError` (Task 1).
- Produces: tables `cluster_members`, `cluster_membership`; `ClusterRole.ClusterRole` with `current: Effect<ClusterRoleState, ClusterError>`, `refuseIfMember(action: string): Effect<void, ClusterError>`, `refuseIfClustered(action: string): Effect<void, ClusterError>`; `ClusterRole.layer: Layer<ClusterRole, never, SqlClient>`; type `ClusterRoleState = { role: "standalone" } | { role: "main" } | { role: "member"; hostEnvironmentId: string; hostLabel: string }`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/cluster/ClusterRole.test.ts`:

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ClusterRole from "./ClusterRole.ts";

const layerTest = ClusterRole.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeServices.layer),
);

it.effect("reads its role from the cluster tables and refuses by role, naming the cluster", () =>
  Effect.gen(function* () {
    const role = yield* ClusterRole.ClusterRole;
    const sql = yield* SqlClient.SqlClient;
    expect(yield* role.current).toEqual({ role: "standalone" });
    yield* role.refuseIfClustered("Linking environments");

    yield* sql`
      INSERT INTO cluster_members (environment_id, label, transport, url, cert_sha256, secret_name, status, joined_at)
      VALUES ('environment-box', 'Box', 'https', 'https://box:3773', ${"a".repeat(64)}, 'cluster-member-1', 'online', '2026-11-19T00:00:00.000Z')
    `;
    expect(yield* role.current).toEqual({ role: "main" });
    yield* role.refuseIfMember("Pairing a client");
    expect(yield* role.refuseIfClustered("Linking environments").pipe(Effect.flip)).toMatchObject({
      reason: "is_main_host",
      message:
        "Linking environments is not available here: this environment is the main host of a cluster.",
    });

    yield* sql`DELETE FROM cluster_members`;
    yield* sql`
      INSERT INTO cluster_membership (singleton, host_environment_id, host_label, joined_at, host_session_id)
      VALUES (1, 'environment-studio', 'Studio', '2026-11-19T00:00:00.000Z', 'session-1')
    `;
    expect(yield* role.current).toEqual({
      role: "member",
      hostEnvironmentId: "environment-studio",
      hostLabel: "Studio",
    });
    expect(yield* role.refuseIfMember("Pairing a client").pipe(Effect.flip)).toMatchObject({
      reason: "is_member",
      message:
        "Pairing a client is not available here: this environment is a member of the cluster hosted by Studio.",
    });
  }).pipe(Effect.provide(layerTest)),
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run apps/server/src/cluster/ClusterRole.test.ts`
Expected: FAIL — `Failed to resolve import "./ClusterRole.ts"`.

- [ ] **Step 3: Write the migration and service**

`apps/server/src/persistence/Migrations/099_Cluster.ts`:

```ts
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Rows here make this environment a main host. Each member's `cluster-host` token
  // lives in the secret store under `secret_name`, unique per join.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cluster_members (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      transport TEXT NOT NULL CHECK (transport IN ('https', 'ssh')),
      url TEXT,
      ssh_target TEXT,
      cert_sha256 TEXT,
      secret_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'incompatible', 'revoked')),
      joined_at TEXT NOT NULL,
      last_reached_at TEXT,
      last_error TEXT,
      CHECK ((transport = 'https') = (url IS NOT NULL AND ssh_target IS NULL))
    )
  `;
  // Its one row makes this environment a member.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cluster_membership (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      host_environment_id TEXT NOT NULL,
      host_label TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      host_session_id TEXT NOT NULL
    )
  `;
});
```

`apps/server/src/persistence/Migrations.ts`, after line 108 and line 209 respectively:

```ts
import Migration0099 from "./Migrations/099_Cluster.ts";
```

```ts
  [99, "Cluster", Migration0099],
```

`apps/server/src/persistence/reconcileV2PreviewMigration.test.ts` — in both expected lists, after `[98, "ActiveShellIndexIndexes"],` (lines 80 and 201):

```ts
        [99, "Cluster"],
```

`apps/server/src/cluster/ClusterRole.ts`:

```ts
import { ClusterError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

export type ClusterRoleState =
  | { readonly role: "standalone" }
  | { readonly role: "main" }
  | { readonly role: "member"; readonly hostEnvironmentId: string; readonly hostLabel: string };

/** Which side of a cluster this environment is on, for the services that refuse by it. */
export class ClusterRole extends Context.Service<
  ClusterRole,
  {
    readonly current: Effect.Effect<ClusterRoleState, ClusterError>;
    readonly refuseIfMember: (action: string) => Effect.Effect<void, ClusterError>;
    readonly refuseIfClustered: (action: string) => Effect.Effect<void, ClusterError>;
  }
>()("t3/cluster/ClusterRole") {}

const refusal = (state: Exclude<ClusterRoleState, { role: "standalone" }>, action: string) =>
  state.role === "member"
    ? new ClusterError({
        reason: "is_member",
        message: `${action} is not available here: this environment is a member of the cluster hosted by ${state.hostLabel}.`,
      })
    : new ClusterError({
        reason: "is_main_host",
        message: `${action} is not available here: this environment is the main host of a cluster.`,
      });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const current = Effect.gen(function* () {
    const [membership] = yield* sql<{ host_environment_id: string; host_label: string }>`
      SELECT host_environment_id, host_label FROM cluster_membership WHERE singleton = 1
    `;
    if (membership !== undefined) {
      return {
        role: "member",
        hostEnvironmentId: membership.host_environment_id,
        hostLabel: membership.host_label,
      } as const;
    }
    const [member] = yield* sql<{ found: number }>`SELECT 1 AS found FROM cluster_members LIMIT 1`;
    return member === undefined ? ({ role: "standalone" } as const) : ({ role: "main" } as const);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ClusterError({
          reason: "storage",
          message: "This environment's cluster state could not be read. The server log has details.",
          cause,
        }),
    ),
    Effect.withSpan("ClusterRole.current"),
  );

  const refuseIfMember = Effect.fn("ClusterRole.refuseIfMember")(function* (action: string) {
    const state = yield* current;
    if (state.role === "member") return yield* refusal(state, action);
  });

  const refuseIfClustered = Effect.fn("ClusterRole.refuseIfClustered")(function* (action: string) {
    const state = yield* current;
    if (state.role !== "standalone") return yield* refusal(state, action);
  });

  return ClusterRole.of({ current, refuseIfMember, refuseIfClustered });
});

export const layer = Layer.effect(ClusterRole, make);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/cluster/ClusterRole.test.ts apps/server/src/persistence/Migrations.test.ts apps/server/src/persistence/reconcileV2PreviewMigration.test.ts`
Expected: PASS (including `registers every migration file`, and the reconcile lists ending at `[99, "Cluster"]`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/persistence/Migrations/099_Cluster.ts apps/server/src/persistence/Migrations.ts apps/server/src/persistence/reconcileV2PreviewMigration.test.ts apps/server/src/cluster/ClusterRole.ts apps/server/src/cluster/ClusterRole.test.ts
git commit -m "feat(server): cluster tables and role

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

> If `main` gains migration 99 before this branch merges, renumber to the next free id (here and in the reconcile lists); the name stays `Cluster`.

---

## Task 3: Auth — cluster invites, `cluster-host` sessions, scope cap, member pairing refusal

**Files:**

- Modify: `apps/server/src/persistence/AuthPairingLinks.ts:23-24` (subject constant)
- Modify: `apps/server/src/auth/EnvironmentAuth.ts` — imports (`:1-60`), constants (`:59-86`), `McpClientSession` (`:88-94`), interface (`:517-640`), `authenticateRequest` (`:843-890`), `createPairingLink` (`:1150-1161`), `listPairingLinks` (`:1163-1185`), WebSocket ticket branch (`:1477-1529`), `authenticateMcpClient` (`:1531-1554`), returned service (`:1610-1638`), `layer` (`:1701-1705`)
- Modify: `apps/server/src/auth/http.ts:500-503` (map `ClusterError`)
- Modify: `apps/server/src/cloud/http.ts:62-83`, `apps/server/src/cloud/CloudLink.ts:430-476` (error unions)
- Test: `apps/server/src/auth/EnvironmentAuth.test.ts` (inside the `EnvironmentAuth.layer` block, after the test at `:516`)

**Interfaces:**

- Consumes: `ClusterRole.ClusterRole` (Task 2), `ClusterError`, `CLUSTER_SCOPES_HEADER` (Task 1), `parseOAuthScope` (`@t3tools/shared/oauthScope`).
- Produces: `AuthPairingLinks.CLUSTER_MEMBER_PAIRING_SUBJECT = "mcp-approval:cluster-member"`; `EnvironmentAuth.CLUSTER_HOST_SUBJECT = "cluster-host"`; exported `EnvironmentAuth.MCP_CLIENT_SUBJECT`; `McpClientSession.cluster?: boolean` (`true` for a `cluster-host` session on `/mcp`); `EnvironmentAuth["Service"]["consumeClusterInvite"]: (code: string, input: { hostLabel: string; client: AuthClientMetadata }) => Effect<{ sessionId: AuthSessionId; token: string }, ServerAuthInvalidCredentialError | ServerAuthInternalError>`; `listPairingLinks({ includePurposeBound?: boolean })`; `createPairingLink`, `issuePairingCredential`, `issueConnectCredential` may fail with `ClusterError`.

- [ ] **Step 1: Write the failing tests**

Add to the imports of `apps/server/src/auth/EnvironmentAuth.test.ts`:

```ts
import { CLUSTER_SCOPES_HEADER } from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import { CLUSTER_MEMBER_PAIRING_SUBJECT } from "../persistence/AuthPairingLinks.ts";
```

Add below `makeBearerRequest`:

```ts
const withHeaders = (
  request: ReturnType<typeof makeBearerRequest>,
  headers: Record<string, string>,
): ReturnType<typeof makeBearerRequest> =>
  ({ ...request, headers: { ...request.headers, ...headers } }) as unknown as ReturnType<
    typeof makeBearerRequest
  >;
```

Add after the test "spends peer-link pairing codes only for the chosen link access":

```ts
    it.effect("spends a cluster invite only as a cluster join, for a cluster-host session", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const invite = yield* serverAuth.createPairingLink({
          subject: CLUSTER_MEMBER_PAIRING_SUBJECT,
          scopes: AuthStandardClientScopes,
          label: "Cluster invite",
        });
        const ordinary = yield* serverAuth
          .exchangeBootstrapCredentialForAccessToken(invite.credential, undefined, requestMetadata)
          .pipe(Effect.flip);
        expect(ordinary._tag).toBe("ServerAuthInvalidCredentialError");
        expect(yield* serverAuth.listPairingLinks()).toEqual([]);

        const host = yield* serverAuth.consumeClusterInvite(invite.credential, {
          hostLabel: "Studio",
          client: requestMetadata,
        });
        const reused = yield* serverAuth
          .consumeClusterInvite(invite.credential, { hostLabel: "Studio", client: requestMetadata })
          .pipe(Effect.flip);
        expect(reused._tag).toBe("ServerAuthInvalidCredentialError");

        const pairing = yield* serverAuth.issuePairingCredential();
        const notAnInvite = yield* serverAuth
          .consumeClusterInvite(pairing.credential, { hostLabel: "Studio", client: requestMetadata })
          .pipe(Effect.flip);
        expect(notAnInvite._tag).toBe("ServerAuthInvalidCredentialError");

        const session = yield* serverAuth.authenticateHttpRequest(makeBearerRequest(host.token));
        expect(session.subject).toBe(EnvironmentAuth.CLUSTER_HOST_SUBJECT);
        expect(session.scopes).toEqual([...AuthStandardClientScopes]);
        expect(
          (yield* serverAuth.listSessions()).find((listed) => listed.sessionId === host.sessionId)
            ?.client.label,
        ).toBe("Cluster host · Studio");
        expect(yield* serverAuth.authenticateMcpClient(makeBearerRequest(host.token))).toMatchObject(
          { access: "full-access", peerLink: false, cluster: true },
        );
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect("caps a cluster-host request to the forwarded scopes, failing closed", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const invite = yield* serverAuth.createPairingLink({
          subject: CLUSTER_MEMBER_PAIRING_SUBJECT,
        });
        const host = yield* serverAuth.consumeClusterInvite(invite.credential, {
          hostLabel: "Studio",
          client: requestMetadata,
        });
        const capped = yield* serverAuth.authenticateHttpRequest(
          withHeaders(makeBearerRequest(host.token), {
            [CLUSTER_SCOPES_HEADER]: "terminal:read orchestration:read",
          }),
        );
        expect(capped.scopes).toEqual(["orchestration:read", "terminal:read"]);
        const garbled = yield* serverAuth.authenticateHttpRequest(
          withHeaders(makeBearerRequest(host.token), { [CLUSTER_SCOPES_HEADER]: "" }),
        );
        expect(garbled.scopes).toEqual([]);
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect("ignores the cluster scope header on any other session", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const pairing = yield* serverAuth.issuePairingCredential({ scopes: ["orchestration:read"] });
        const client = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          pairing.credential,
          undefined,
          requestMetadata,
        );
        const forged = yield* serverAuth.authenticateHttpRequest(
          withHeaders(makeBearerRequest(client.access_token), {
            [CLUSTER_SCOPES_HEADER]: AuthStandardClientScopes.join(" "),
          }),
        );
        expect(forged.scopes).toEqual(["orchestration:read"]);
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect("refuses client pairing on a cluster member but mints invites and startup links", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO cluster_membership (singleton, host_environment_id, host_label, joined_at, host_session_id)
          VALUES (1, 'environment-studio', 'Studio', '2026-11-19T00:00:00.000Z', 'session-1')
        `;
        expect(yield* serverAuth.issuePairingCredential().pipe(Effect.flip)).toMatchObject({
          _tag: "ClusterError",
          reason: "is_member",
          message:
            "Pairing a client is not available here: this environment is a member of the cluster hosted by Studio.",
        });
        yield* serverAuth.createPairingLink({ subject: CLUSTER_MEMBER_PAIRING_SUBJECT });
        yield* serverAuth.issueStartupPairingCredential();

        yield* sql`DELETE FROM cluster_membership`;
        yield* serverAuth.issuePairingCredential();
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/server/src/auth/EnvironmentAuth.test.ts -t "cluster"`
Expected: FAIL — `serverAuth.consumeClusterInvite is not a function`, `CLUSTER_MEMBER_PAIRING_SUBJECT` undefined (the invite is minted as an ordinary code), and the member test gets a pairing credential instead of `ClusterError`.

- [ ] **Step 3: Implement**

`apps/server/src/persistence/AuthPairingLinks.ts`, after line 24:

```ts
/** A one-time code that lets a main host add this environment to its cluster. */
export const CLUSTER_MEMBER_PAIRING_SUBJECT = `${MCP_APPROVAL_SUBJECT_PREFIX}cluster-member`;
```

`apps/server/src/auth/EnvironmentAuth.ts`:

Imports — add `type AuthClientMetadata` is already imported; add:

```ts
import { CLUSTER_SCOPES_HEADER, ClusterError } from "@t3tools/contracts";
import { parseOAuthScope } from "@t3tools/shared/oauthScope";
import * as ClusterRole from "../cluster/ClusterRole.ts";
```

and extend the `AuthPairingLinks` import with `CLUSTER_MEMBER_PAIRING_SUBJECT`.

Constants — replace line 85 and add below it:

```ts
export const MCP_CLIENT_SUBJECT = "mcp-client";
/** A member's session for its cluster's main host. */
export const CLUSTER_HOST_SUBJECT = "cluster-host";
// Lasts until either side leaves; nothing renews it.
const CLUSTER_HOST_SESSION_TTL = Duration.days(3650);
```

`McpClientSession` — add after `peerLink`:

```ts
  /** The cluster's main host on this member: full trust, and never a peer link. */
  readonly cluster?: boolean;
```

Interface — change the `createPairingLink`, `issueConnectCredential` and `issuePairingCredential` error types to add `| ClusterError`; change `listPairingLinks` input to:

```ts
    readonly listPairingLinks: (input?: {
      readonly excludeSubjects?: ReadonlyArray<string>;
      /** Also lists cluster invites and app sign-in codes, which Connections never shows. */
      readonly includePurposeBound?: boolean;
    }) => Effect.Effect<ReadonlyArray<AuthPairingLink>, ServerAuthInternalError>;
```

and add after `consumeMcpApprovalCode`:

```ts
    /** Spends a cluster invite for a `cluster-host` session. Any other code is refused. */
    readonly consumeClusterInvite: (
      code: string,
      input: { readonly hostLabel: string; readonly client: AuthClientMetadata },
    ) => Effect.Effect<
      { readonly sessionId: AuthSessionId; readonly token: string },
      ServerAuthInvalidCredentialError | ServerAuthInternalError
    >;
```

Module scope, below `rejectMcpClientAudience`:

```ts
/** The member side of the proxy's per-socket cap; any other session ignores the header. */
const capClusterHostScopes = (
  request: HttpServerRequest.HttpServerRequest,
  session: AuthenticatedSession,
): AuthenticatedSession => {
  const header = request.headers[CLUSTER_SCOPES_HEADER];
  if (session.subject !== CLUSTER_HOST_SUBJECT || header === undefined) return session;
  const allowed = new Set(parseOAuthScope(header) ?? []);
  return { ...session, scopes: session.scopes.filter((scope) => allowed.has(scope)) };
};
```

In `make`, after `const devAuth = …`:

```ts
  const clusterRole = yield* ClusterRole.ClusterRole;
```

`authenticateRequest` — append to the `authenticateToken(credential.token).pipe(…)` chain, after the `Effect.flatMap((session) => …)`:

```ts
      Effect.map((session) => capClusterHostScopes(request, session)),
```

WebSocket ticket branch in `authenticateWebSocketUpgrade` — wrap the returned object:

```ts
          return capClusterHostScopes(request, {
            sessionId: session.sessionId,
            subject: session.subject,
            method: session.method,
            scopes: session.scopes,
            ...(session.proofKeyThumbprint
              ? { proofKeyThumbprint: session.proofKeyThumbprint }
              : {}),
            ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
          });
```

`createPairingLink` — after the managed-policy refusal:

```ts
    // A member pairs only its cluster host; the startup link stays for this machine's browser.
    if (input?.purpose !== "startup" && input?.subject !== CLUSTER_MEMBER_PAIRING_SUBJECT) {
      yield* clusterRole.refuseIfMember("Pairing a client");
    }
```

`listPairingLinks` — change the filter to:

```ts
          .filter(
            (pairingLink) =>
              !excludedSubjects.includes(pairingLink.subject) &&
              (input?.includePurposeBound === true ||
                !pairingLink.subject.startsWith(MCP_APPROVAL_SUBJECT_PREFIX)),
          )
```

`authenticateMcpClient` — replace the `Effect.flatMap` with:

```ts
      Effect.flatMap((session) =>
        session.method === "bearer-access-token" && session.subject === MCP_CLIENT_SUBJECT
          ? Effect.succeed({
              sessionId: session.sessionId,
              label: session.client.label ?? "MCP client",
              access: session.scopes.includes(AuthOrchestrationOperateScope)
                ? (session.runtimeModeCeiling ?? "approval-required")
                : "read-only",
              peerLink: session.peerLink === true,
            } satisfies McpClientSession)
          : session.method === "bearer-access-token" && session.subject === CLUSTER_HOST_SUBJECT
            ? Effect.succeed({
                sessionId: session.sessionId,
                label: session.client.label ?? "Cluster host",
                access: "full-access",
                peerLink: false,
                cluster: true,
              } satisfies McpClientSession)
            : Effect.fail(
                new ServerAuthInvalidCredentialError({
                  diagnostic: "Only MCP client sessions are accepted here.",
                }),
              ),
      ),
```

Before `yield* revokePairedClientsThePolicyDisallows(…)`:

```ts
  const consumeClusterInvite: EnvironmentAuth["Service"]["consumeClusterInvite"] = Effect.fn(
    "EnvironmentAuth.consumeClusterInvite",
  )(function* (code, input) {
    const grant = yield* bootstrapCredentials
      .consume(code.trim(), { allowedSubject: CLUSTER_MEMBER_PAIRING_SUBJECT })
      .pipe(Effect.mapError(toBootstrapExchangeError));
    if (grant.subject !== CLUSTER_MEMBER_PAIRING_SUBJECT) {
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: "Only a cluster invite can add this environment to a cluster.",
      });
    }
    const issued = yield* sessions
      .issue({
        subject: CLUSTER_HOST_SUBJECT,
        method: "bearer-access-token",
        scopes: AuthStandardClientScopes,
        ttl: CLUSTER_HOST_SESSION_TTL,
        client: { ...input.client, label: `Cluster host · ${input.hostLabel}`, deviceType: "bot" },
      })
      .pipe(Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })));
    return { sessionId: issued.sessionId, token: issued.token };
  });
```

Add `consumeClusterInvite,` to the `EnvironmentAuth.of({ … })` object, and change `layer`:

```ts
export const layer = Layer.effect(EnvironmentAuth, make).pipe(
  Layer.provideMerge(PairingGrantStore.layer),
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(EnvironmentAuthPolicy.layer),
  Layer.provideMerge(ClusterRole.layer),
);
```

`apps/server/src/auth/http.ts` — in the `pairingCredential` handler's `Effect.catchTags`, add:

```ts
            ClusterError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
```

`apps/server/src/cloud/http.ts` — add to `connectErrorCases` and to `ConnectFailure`:

```ts
  ClusterError: (error: ClusterError) =>
    Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
```

```ts
  | ClusterError
```

(import `ClusterError` from `@t3tools/contracts`). In `apps/server/src/cloud/CloudLink.ts` lines 430–476, add `| ClusterError` beside each `ManagedLimits.ManagedPolicyRefusedError` in the signatures that reach `issueConnectCredential`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/auth/EnvironmentAuth.test.ts apps/server/src/auth/http.test.ts apps/server/src/auth/McpOAuth.test.ts`
Expected: PASS.

Run: `vp run typecheck`
Expected: no errors. Any other `createPairingLink` caller the checker names (e.g. `apps/server/src/cli/pair.ts:489`) only propagates the error; widen its signature the same way.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/persistence/AuthPairingLinks.ts apps/server/src/auth/EnvironmentAuth.ts apps/server/src/auth/EnvironmentAuth.test.ts apps/server/src/auth/http.ts apps/server/src/cloud/http.ts apps/server/src/cloud/CloudLink.ts
git commit -m "feat(server): cluster invites and cluster-host sessions

A member refuses client pairing, and a cluster-host session is capped per
request to the forwarding client's scopes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Clustered environments refuse peer links in both directions

**Files:**

- Modify: `apps/server/src/peer/PeerLinks.ts:93-117` (interface), `:225-233` (make), `:484-487` (`link`), `:623-634` (add `unlinkAll`), `:715-723`
- Modify: `apps/server/src/peer/PeerLinks.testkit.ts:78-84` (expose `sql`), `:183-196` (`ClusterRole.layer`)
- Modify: `apps/server/src/auth/McpOAuth.ts:262-270` (make), `:349-356` (register)
- Modify: `apps/server/src/mcp/McpHttpServer.ts:262-268` (response), `:271-279`, `:310-311`
- Test: `apps/server/src/peer/PeerLinks.test.ts` (after the test at `:212-249`), `apps/server/src/auth/McpOAuth.test.ts:46-131` (helper) and a new test after `:218`

**Interfaces:**

- Consumes: `ClusterRole.ClusterRole` (Task 2; reaches `PeerLinks` and `McpOAuth` through `EnvironmentAuth.layer`'s `provideMerge`).
- Produces: `PeerLinks["Service"]["unlinkAll"]: Effect<number, PeerLinkError>`; `PeerLinkError` with `reason: "clustered"`; `/mcp` answers linked clients `403 linked_environments_off` while clustered.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/peer/PeerLinks.testkit.ts` — in `servePeer`, change `Layer.provide(Sqlite.layerMemory)` to `Layer.provideMerge(Sqlite.layerMemory)` and add to the returned object:

```ts
      /** Its database, as for making it a cluster's main host. */
      sql: Context.get(authContext, SqlClient.SqlClient),
```

(change `import type * as SqlClient` to a value import). In `layerLinkingEnvironment`, insert directly above `Layer.provideMerge(database),`:

```ts
    Layer.provideMerge(ClusterRole.layer),
```

with `import * as ClusterRole from "../cluster/ClusterRole.ts";`.

`apps/server/src/peer/PeerLinks.test.ts`, after "each machine's Linked environments beta gates links…":

```ts
const makeMainHost = (sql: SqlClient.SqlClient) =>
  sql`
    INSERT INTO cluster_members (environment_id, label, transport, url, cert_sha256, secret_name, status, joined_at)
    VALUES ('environment-member', 'Member', 'https', 'https://member:3773', ${"a".repeat(64)}, 'cluster-member-1', 'online', '2026-11-19T00:00:00.000Z')
  `;

it.effect("a clustered environment neither links out nor answers its existing links", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      yield* a.links.link({
        url: b.url,
        pairingCode: (yield* b.auth.issuePairingCredential()).credential,
        access: "auto",
      });

      yield* makeMainHost(a.sql);
      const refused = yield* a.links
        .link({
          url: b.url,
          pairingCode: (yield* b.auth.issuePairingCredential()).credential,
          access: "auto",
        })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        reason: "clustered",
        message:
          "Linking environments is not available here: this environment is the main host of a cluster.",
      });
      yield* a.sql`DELETE FROM cluster_members`;

      yield* makeMainHost(b.sql);
      expect((yield* probe(a).pipe(Effect.flip)).code).toBe("orchestration_error");
      yield* b.sql`DELETE FROM cluster_members`;
      expect(yield* probe(a)).toEqual({ caller: "T3 Code · Laptop", modes: "auto/default" });

      expect(yield* a.links.unlinkAll).toBe(1);
      expect(yield* a.links.get(box.environmentId)).toEqual(Option.none());
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
```

`apps/server/src/auth/McpOAuth.test.ts` — change `layerEnvironmentAuth`'s `Layer.provide(Sqlite.layerMemory)` to `Layer.provideMerge(Sqlite.layerMemory)`; change `makeLayerRoutes`'s `capture` to `(auth, sql) => void` and its `Layer.effectDiscard` to:

```ts
    Layer.effectDiscard(
      Effect.all([EnvironmentAuth.EnvironmentAuth, SqlClient.SqlClient]).pipe(
        Effect.tap(([auth, sql]) => Effect.sync(() => capture(auth, sql))),
      ),
    ),
```

and `withRoutes` to keep `routerSql` the same way and call `use(handler, routerAuth!, routerSql!)` with `use: (handler: Handler, auth: EnvironmentAuth.EnvironmentAuth["Service"], sql: SqlClient.SqlClient) => Effect.Effect<A, E>`. Then add:

```ts
it.effect("refuses to register a peer link on a clustered environment", () =>
  withRoutes((handler, _auth, sql) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO cluster_membership (singleton, host_environment_id, host_label, joined_at, host_session_id)
        VALUES (1, 'environment-studio', 'Studio', '2026-11-19T00:00:00.000Z', 'session-1')
      `;
      const response = yield* handler(
        at("/oauth/mcp/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeJson({
            client_name: "Laptop",
            software_id: MCP_PEER_LINK_SOFTWARE_ID,
            redirect_uris: [REDIRECT],
          }),
        }),
      );
      expect(response.status).toBe(400);
      expect(yield* json<unknown>(response)).toMatchObject({
        error: "invalid_client_metadata",
        error_description:
          "Linking to this environment is not available here: this environment is a member of the cluster hosted by Studio.",
      });
      expect((yield* register(handler)).status).toBe(201);
    }),
  ),
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/server/src/peer/PeerLinks.test.ts apps/server/src/auth/McpOAuth.test.ts -t "clustered"`
Expected: FAIL — the second `link` succeeds; `probe` succeeds while B is a main host; registration answers 201; `a.links.unlinkAll` is undefined.

- [ ] **Step 3: Implement**

`apps/server/src/peer/PeerLinks.ts` — interface, after `unlink`:

```ts
    /** Forgets every link here, as joining or hosting a cluster does. */
    readonly unlinkAll: Effect.Effect<number, PeerLinkError>;
```

`make`, after `const isOwnLoopback = yield* LoopbackHost;`:

```ts
  const clusterRole = yield* ClusterRole.ClusterRole;
```

`link`, after the `enabled` check:

```ts
    yield* clusterRole
      .refuseIfClustered("Linking environments")
      .pipe(
        Effect.mapError((error) => new PeerLinkError({ reason: "clustered", message: error.message })),
      );
```

After `unlink`:

```ts
  const unlinkAll: PeerLinks["Service"]["unlinkAll"] = Effect.gen(function* () {
    const deleted = yield* sql<{ secret_name: string }>`
      DELETE FROM peer_environment_links RETURNING secret_name
    `.pipe(Effect.catch(failStorage));
    for (const row of deleted) {
      yield* secrets.remove(row.secret_name).pipe(Effect.catch(failStorage));
    }
    return deleted.length;
  }).pipe(Effect.withSpan("PeerLinks.unlinkAll"));
```

and add `unlinkAll,` to `PeerLinks.of`. Import `* as ClusterRole from "../cluster/ClusterRole.ts"`.

`apps/server/src/auth/McpOAuth.ts` — in `make` add `const clusterRole = yield* ClusterRole.ClusterRole;`, and after `const peerLink = metadata.software_id === MCP_PEER_LINK_SOFTWARE_ID;`:

```ts
      if (peerLink) {
        yield* clusterRole.refuseIfClustered("Linking to this environment").pipe(
          Effect.mapError(
            (error) =>
              new AuthMcpRegistrationError({
                error: "invalid_client_metadata",
                error_description: error.message,
              }),
          ),
        );
      }
```

`apps/server/src/mcp/McpHttpServer.ts` — below `linkedEnvironmentsOff`:

```ts
// Clustered environments take no part in peer links; older peers read this like the beta being off.
const clusteredLinksOff = HttpServerResponse.jsonUnsafe(
  {
    error: "linked_environments_off",
    message: "This environment is part of a cluster, so it takes no part in linked environments.",
  },
  { status: 403, headers: { "cache-control": "no-store" } },
);
```

In `makeMcpAuthMiddleware`, after `const clients = …`:

```ts
  // Optional: in-process MCP hosts without a database have no cluster.
  const clusterRole = yield* Effect.serviceOption(ClusterRole.ClusterRole);
  const clustered = Option.match(clusterRole, {
    onNone: () => Effect.succeed(false),
    onSome: (role) =>
      role.current.pipe(
        Effect.map((state) => state.role !== "standalone"),
        Effect.orElseSucceed(() => false),
      ),
  });
```

and after `if (limited.client?.linked === true && !linkedEnvironments) return linkedEnvironmentsOff;`:

```ts
    if (limited.client?.linked === true && (yield* clustered)) return clusteredLinksOff;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/peer/PeerLinks.test.ts apps/server/src/auth/McpOAuth.test.ts apps/server/src/mcp/McpHttpServer.test.ts`
Expected: PASS.

Run: `vp run typecheck`
Expected: no errors. If a test layer composes `PeerLinks.layer` without `EnvironmentAuth.layer` (`rg -n "PeerLinks.layer" apps/server/src`), add `Layer.provideMerge(ClusterRole.layer)` above its database layer as in the testkit.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/peer/PeerLinks.ts apps/server/src/peer/PeerLinks.test.ts apps/server/src/peer/PeerLinks.testkit.ts apps/server/src/auth/McpOAuth.ts apps/server/src/auth/McpOAuth.test.ts apps/server/src/mcp/McpHttpServer.ts
git commit -m "feat(server): clustered environments refuse peer links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: Pinned upstream transport and SSH invites

**Files:**

- Create: `apps/server/src/cluster/pinnedTransport.ts`, `apps/server/src/cluster/pinnedTransport.test.ts`, `apps/server/src/cluster/ClusterUpstream.ts`
- Modify: `packages/ssh/src/tunnel.ts:1010-1021` (script), `:1137-1142` (builder), `:178-185` (shape), `:1232-1290` (`issueRemotePairingToken`), `:2012-2053` (`ensureEnvironment`)
- Test: `packages/ssh/src/tunnel.test.ts` (after the test at `:534-563`)

**Interfaces:**

- Consumes: `ClusterError`, `normalizeCertificateFingerprint`, `parseClusterSshTarget` (Task 1); `SshTunnel.SshEnvironmentManager`; `NodeHttpClient.makeUndici`, `NodeHttpClient.Dispatcher`.
- Produces:
  - `pinnedTransport.ts`: `makeAgent(pin: string | null): Effect<PinnedAgent, never, Scope>` with `PinnedAgent = { httpClient: HttpClient.HttpClient; webSocket: Socket.WebSocketConstructor["Service"] }`; `isPinMismatch(error: unknown): boolean`.
  - `ClusterUpstream.ts`: `ClusterUpstream.ClusterUpstream` with `connect(target: UpstreamTarget): Effect<Upstream, ClusterError>` and `inviteOverSsh(sshTarget: string): Effect<{ origin: string; code: string }, ClusterError>`; `Upstream = { origin: string; httpClient: HttpClient.HttpClient; webSocket: Socket.WebSocketConstructor["Service"] }`; `UpstreamTarget = { transport: "https"; url: string; certSha256: string | null } | { transport: "ssh"; sshTarget: string }`; `layer: Layer<ClusterUpstream, never, SshEnvironmentManager | ChildProcessSpawner | Digest | FileSystem | Path | HttpClient | NetService | SshPasswordPrompt>`.
  - `packages/ssh`: `SshPairingPurpose = "client" | "cluster-member"`; `ensureEnvironment(target, { issuePairingToken?, pairingPurpose? })`; exported `buildRemotePairingScript(stateKey, runner?, purpose?)`.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/cluster/pinnedTransport.test.ts`:

```ts
// @effect-diagnostics nodeBuiltinImport:off - A real TLS listener with the peer fixtures' certificate.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";

import { normalizeCertificateFingerprint } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClientRequest } from "effect/http";

import * as PinnedTransport from "./pinnedTransport.ts";

const cert = NodeFS.readFileSync(new URL("../peer/fixtures/localhost-cert.pem", import.meta.url));
const key = NodeFS.readFileSync(new URL("../peer/fixtures/localhost-key.pem", import.meta.url));
const pin = normalizeCertificateFingerprint(new NodeCrypto.X509Certificate(cert).fingerprint256);

const serveTls = Effect.acquireRelease(
  Effect.callback<{ readonly origin: string; readonly seen: Array<string>; readonly server: NodeHttps.Server }>(
    (resume) => {
      const seen: Array<string> = [];
      const server = NodeHttps.createServer({ key, cert }, (request, response) => {
        seen.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
        response.end("ok");
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as NodeNet.AddressInfo;
        resume(Effect.succeed({ origin: `https://127.0.0.1:${port}`, seen, server }));
      });
    },
  ),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
);

it.live("sends a request only once the server presents the pinned certificate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tls = yield* serveTls;
      const pinned = yield* PinnedTransport.makeAgent(pin);
      const response = yield* pinned.httpClient.execute(
        HttpClientRequest.get(`${tls.origin}/hello`).pipe(HttpClientRequest.bearerToken("secret")),
      );
      expect(yield* response.text).toBe("ok");

      const wrong = yield* PinnedTransport.makeAgent("0".repeat(64));
      const refused = yield* wrong.httpClient
        .execute(
          HttpClientRequest.get(`${tls.origin}/leak`).pipe(HttpClientRequest.bearerToken("secret")),
        )
        .pipe(Effect.flip);
      expect(PinnedTransport.isPinMismatch(refused)).toBe(true);
      expect(tls.seen).toEqual(["GET /hello Bearer secret"]);
    }),
  ),
);
```

`packages/ssh/src/tunnel.test.ts`, inside the same `describe` as "accepts pretty-printed pairing JSON…":

```ts
  it("mints cluster invites with the runner that mints client pairing codes", () => {
    assert.match(
      SshTunnel.buildRemotePairingScript("state", ARCHIVE),
      /"\$RUNNER_FILE" auth pairing create --base-dir "\$PAIRING_BASE_DIR" --json\n$/,
    );
    assert.match(
      SshTunnel.buildRemotePairingScript("state", ARCHIVE, "cluster-member"),
      /"\$RUNNER_FILE" cluster invite --base-dir "\$PAIRING_BASE_DIR" --json\n$/,
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/server/src/cluster/pinnedTransport.test.ts packages/ssh/src/tunnel.test.ts -t "pinned|cluster invites"`
Expected: FAIL — `Failed to resolve import "./pinnedTransport.ts"`; `SshTunnel.buildRemotePairingScript is not a function`.

- [ ] **Step 3: Implement**

`packages/ssh/src/tunnel.ts` — the pairing script's last line becomes:

```ts
"$RUNNER_FILE" @@T3_PAIRING_COMMAND@@ --base-dir "$PAIRING_BASE_DIR" --json
`;

export type SshPairingPurpose = "client" | "cluster-member";
const PAIRING_COMMANDS = {
  client: "auth pairing create",
  "cluster-member": "cluster invite",
} as const satisfies Record<SshPairingPurpose, string>;
```

The builder becomes exported with a purpose:

```ts
export function buildRemotePairingScript(
  stateKey: string,
  input?: RemoteT3RunnerOptions,
  purpose: SshPairingPurpose = "client",
): string {
  return applyScriptPlaceholders(REMOTE_PAIRING_SCRIPT, {
    T3_STATE_KEY: stateKey,
    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
    T3_PAIRING_COMMAND: PAIRING_COMMANDS[purpose],
  });
}
```

`issueRemotePairingToken` gains a fourth parameter `purpose: SshPairingPurpose = "client"` passed to `buildRemotePairingScript(stateKey, runner, purpose)`. In `SshEnvironmentManagerShape.ensureEnvironment` and the implementation, the options become `{ readonly issuePairingToken?: boolean; readonly pairingPurpose?: SshPairingPurpose }`, and the call becomes:

```ts
                issueRemotePairingToken(
                  entry.target,
                  authOptions,
                  runner,
                  requestOptions.pairingPurpose ?? "client",
                ),
```

`apps/server/src/cluster/pinnedTransport.ts`:

```ts
// @effect-diagnostics nodeBuiltinImport:off - The connector owns the TLS socket so it can check the pin first.
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import { normalizeCertificateFingerprint } from "@t3tools/contracts";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Socket from "effect/socket/Socket";
import type * as Undici from "undici";

// undici is external to the CLI bundle; Node single-executables load it from disk only with require.
const requireUndici = NodeModule.createRequire(import.meta.url);
const PIN_MISMATCH = "CLUSTER_CERTIFICATE_MISMATCH";

export interface PinnedAgent {
  readonly httpClient: HttpClient.HttpClient;
  readonly webSocket: Socket.WebSocketConstructor["Service"];
}

const pinnedConnector =
  (pin: string): Undici.buildConnector.connector =>
  (options, callback) => {
    let settled = false;
    const host = options.hostname.replace(/^\[(.*)\]$/, "$1");
    const socket = NodeTls.connect({
      host,
      port: Number(options.port) || 443,
      ...(NodeNet.isIP(host) === 0 ? { servername: options.servername ?? host } : {}),
      // Members are self-signed by design; the fingerprint check below is the trust decision.
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });
    socket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      const presented = normalizeCertificateFingerprint(
        socket.getPeerCertificate().fingerprint256 ?? "",
      );
      if (presented === pin) return callback(null, socket);
      socket.destroy();
      callback(
        Object.assign(new Error(`The certificate presented (${presented}) is not the pinned one.`), {
          code: PIN_MISMATCH,
        }),
        null,
      );
    });
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      callback(error, null);
    });
  };

/** One connection pool to members; with a pin, nothing is sent until the certificate matches. */
export const makeAgent = Effect.fn("pinnedTransport.makeAgent")(function* (pin: string | null) {
  const undici = requireUndici("undici") as typeof Undici;
  const dispatcher = yield* Effect.acquireRelease(
    Effect.sync(() =>
      pin === null
        ? new undici.Agent()
        : new undici.Agent({ connect: pinnedConnector(normalizeCertificateFingerprint(pin)) }),
    ),
    (agent) => Effect.promise(() => agent.destroy()),
  );
  const httpClient = yield* NodeHttpClient.makeUndici.pipe(
    Effect.provideService(NodeHttpClient.Dispatcher, dispatcher),
  );
  const webSocket: Socket.WebSocketConstructor["Service"] = (url, options) => {
    const init =
      options === undefined || typeof options === "string" || Array.isArray(options)
        ? { protocols: options, dispatcher }
        : { protocols: options.protocols, headers: options.headers, dispatcher };
    const socket = new undici.WebSocket(url, init) as unknown as globalThis.WebSocket;
    // An unhandled error on a socket still connecting would exit the server.
    socket.addEventListener("error", () => undefined);
    return socket;
  };
  return { httpClient, webSocket } satisfies PinnedAgent;
});

export const isPinMismatch = (error: unknown) => {
  let current = error;
  for (let depth = 0; depth < 6 && Predicate.isObject(current); depth++) {
    if (Predicate.hasProperty(current, "code") && current.code === PIN_MISMATCH) return true;
    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }
  return false;
};
```

`apps/server/src/cluster/ClusterUpstream.ts`:

```ts
import { ClusterError, parseClusterSshTarget } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import type * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import type * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import type * as HttpClient from "effect/http/HttpClient";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as PinnedTransport from "./pinnedTransport.ts";

export type UpstreamTarget =
  | { readonly transport: "https"; readonly url: string; readonly certSha256: string | null }
  | { readonly transport: "ssh"; readonly sshTarget: string };

export interface Upstream extends PinnedTransport.PinnedAgent {
  /** `http(s)://host:port`, with no trailing slash. */
  readonly origin: string;
}

/** How the main host reaches a member: a pinned TLS pool, or the ssh loopback forward. */
export class ClusterUpstream extends Context.Service<
  ClusterUpstream,
  {
    readonly connect: (target: UpstreamTarget) => Effect.Effect<Upstream, ClusterError>;
    /** Starts or reuses T3 on the member over ssh and mints a cluster invite there. */
    readonly inviteOverSsh: (
      sshTarget: string,
    ) => Effect.Effect<{ readonly origin: string; readonly code: string }, ClusterError>;
  }
>()("t3/cluster/ClusterUpstream") {}

const sshError = (target: string, cause: unknown) =>
  new ClusterError({
    reason: "ssh",
    message: SshAuth.isSshAuthFailure(cause)
      ? `SSH to ${target} needs a key or a running ssh-agent; this server cannot answer password prompts.`
      : cause instanceof Error
        ? cause.message
        : `SSH to ${target} failed.`,
    cause,
  });

const make = Effect.gen(function* () {
  const ssh = yield* SshTunnel.SshEnvironmentManager;
  const sshContext = yield* Effect.context<
    | ChildProcessSpawner.ChildProcessSpawner
    | Digest.Digest
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | NetService.NetService
    | SshAuth.SshPasswordPrompt
  >();
  const scope = yield* Effect.scope;
  // Keyed by pin, so a member re-invited with a new certificate gets a new pool.
  const agents = new Map<string, PinnedTransport.PinnedAgent>();
  const agentFor = (pin: string | null) => {
    const cached = agents.get(pin ?? "");
    if (cached !== undefined) return Effect.succeed(cached);
    return PinnedTransport.makeAgent(pin).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.tap((agent) => Effect.sync(() => agents.set(pin ?? "", agent))),
    );
  };

  const sshBaseUrl = Effect.fn("ClusterUpstream.sshBaseUrl")(function* (
    sshTarget: string,
    pairingPurpose?: "cluster-member",
  ) {
    const parsed = parseClusterSshTarget(sshTarget);
    if (parsed === undefined) {
      return yield* new ClusterError({
        reason: "invalid_target",
        message: `${sshTarget} is not an ssh target such as me@box.`,
      });
    }
    return yield* ssh
      .ensureEnvironment(
        { alias: parsed.hostname, ...parsed },
        pairingPurpose === undefined ? undefined : { issuePairingToken: true, pairingPurpose },
      )
      .pipe(
        Effect.provideContext(sshContext),
        Effect.mapError((cause) => sshError(sshTarget, cause)),
      );
  });

  const connect: ClusterUpstream["Service"]["connect"] = Effect.fn("ClusterUpstream.connect")(
    function* (target) {
      if (target.transport === "ssh") {
        const bootstrap = yield* sshBaseUrl(target.sshTarget);
        const origin = new URL(bootstrap.httpBaseUrl).origin;
        return { origin, ...(yield* agentFor(null)) };
      }
      const url = new URL(target.url);
      // Plain http only to this machine, where the network cannot read the token.
      if (url.protocol === "http:" && isLocalLoopbackHost(url.hostname)) {
        return { origin: url.origin, ...(yield* agentFor(null)) };
      }
      if (url.protocol !== "https:" || target.certSha256 === null) {
        return yield* new ClusterError({
          reason: "invalid_target",
          message: `${url.origin} is not an https address with a pinned certificate. Invite the member again.`,
        });
      }
      return { origin: url.origin, ...(yield* agentFor(target.certSha256)) };
    },
  );

  const inviteOverSsh: ClusterUpstream["Service"]["inviteOverSsh"] = Effect.fn(
    "ClusterUpstream.inviteOverSsh",
  )(function* (sshTarget) {
    const bootstrap = yield* sshBaseUrl(sshTarget, "cluster-member");
    if (bootstrap.pairingToken === null) {
      return yield* new ClusterError({
        reason: "ssh",
        message: `${sshTarget} started T3 Code but did not mint a cluster invite.`,
      });
    }
    return { origin: new URL(bootstrap.httpBaseUrl).origin, code: bootstrap.pairingToken };
  });

  return ClusterUpstream.of({ connect, inviteOverSsh });
});

export const layer = Layer.effect(ClusterUpstream, make);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/cluster/pinnedTransport.test.ts packages/ssh/src/tunnel.test.ts`
Expected: PASS.

Run: `vp run typecheck`
Expected: no errors (desktop's `DesktopSshEnvironment.ts:192` passes options through unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/cluster/pinnedTransport.ts apps/server/src/cluster/pinnedTransport.test.ts apps/server/src/cluster/ClusterUpstream.ts packages/ssh/src/tunnel.ts packages/ssh/src/tunnel.test.ts
git commit -m "feat(server): pinned upstream transport for cluster members

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: `ClusterService` member side and `/api/cluster/*`

**Files:**

- Create: `apps/server/src/cluster/ClusterService.ts`, `apps/server/src/cluster/ClusterService.testkit.ts`, `apps/server/src/cluster/ClusterService.test.ts`, `apps/server/src/cluster/http.ts`
- Modify: `packages/contracts/src/environmentHttp.ts:1-96` (import), before `:1066` (group), `:1066-1075` (`.add`)
- Modify: `apps/server/src/server.ts:837-852` (`Layer.provide(ClusterHttp.layer)`), `:888-894` (build `ClusterService.layer` inside the `PeerForwarding` provide)

**Interfaces:**

- Consumes: `EnvironmentAuth` (`consumeClusterInvite`, `createPairingLink`, `listSessions`, `revokeSession`, `listPairingLinks({ includePurposeBound })`, `revokePairingLink`, `CLUSTER_HOST_SUBJECT`, `CLOUD_CONNECT_SUBJECT`, `MCP_CLIENT_SUBJECT`) from Task 3; `PeerLinks.unlinkAll` (Task 4); `ClusterRole` (Task 2); `ServerTls.fingerprint` (Plan 1); `ServerEnvironment.getDescriptor`; `ServerSettings.clusterEnabled`.
- Produces: `ClusterService.ClusterService` with `status: Effect<ClusterStatus, ClusterError>`, `invite(input: ClusterInviteInput): Effect<ClusterInvite, ClusterError>`, `acceptJoin(input: ClusterJoinRequest, client: AuthClientMetadata): Effect<ClusterJoinResult, ClusterError>`, `leave: Effect<ClusterLeaveResult, ClusterError>`; `ClusterService.layer`; HTTP `POST /api/cluster/join` (unauthenticated, spends the invite) and `POST /api/cluster/leave` (`cluster-host` sessions only) as `EnvironmentHttpApi.groups.cluster`; testkit `clusterDescriptor`, `FINGERPRINT`, `makeEnvironment`, `ClusterEnvironment`.

- [ ] **Step 1: Write the testkit and failing tests**

`apps/server/src/cluster/ClusterService.testkit.ts`:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerTls from "../tls/ServerTls.ts";
import * as ClusterService from "./ClusterService.ts";

export const FINGERPRINT = "ab".repeat(32);

export const clusterDescriptor = (environmentId: string, label: string) => ({
  ...descriptorOf(environmentId, label, { cluster: true }),
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
});

/** One environment with its own database, as a member or a main host. */
export const layerClusterEnvironment = (descriptor: ExecutionEnvironmentDescriptor) =>
  ClusterService.layer.pipe(
    Layer.provideMerge(PeerLinks.layer),
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(ServerSettings.layerTest({ clusterEnabled: true })),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(Layer.mock(ServerTls.ServerTls)({ fingerprint: FINGERPRINT })),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(descriptor.environmentId),
        getDescriptor: Effect.succeed(descriptor),
      }),
    ),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cluster-" })),
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.fresh,
  );

export const makeEnvironment = (descriptor: ExecutionEnvironmentDescriptor) =>
  layerClusterEnvironment(descriptor).pipe(
    Layer.build,
    Effect.map((context) => ({
      context,
      cluster: Context.get(context, ClusterService.ClusterService),
      auth: Context.get(context, EnvironmentAuth.EnvironmentAuth),
      settings: Context.get(context, ServerSettings.ServerSettingsService),
      sql: Context.get(context, SqlClient.SqlClient),
    })),
  );

export type ClusterEnvironment = Effect.Success<ReturnType<typeof makeEnvironment>>;
```

`apps/server/src/cluster/ClusterService.test.ts`:

```ts
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { clusterDescriptor, FINGERPRINT, makeEnvironment } from "./ClusterService.testkit.ts";

const box = clusterDescriptor("environment-box", "Box");
const studioDescriptor = clusterDescriptor("environment-studio", "Studio");
const studio = { environmentId: studioDescriptor.environmentId, label: "Studio" };
const other = { environmentId: EnvironmentId.make("environment-other"), label: "Other" };
const bot = { deviceType: "bot" as const, ipAddress: "192.168.1.10" };
const bearer = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

it.effect("a member keeps only its cluster host and loopback sessions after joining", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* makeEnvironment(box);
      const pair = (ipAddress: string) =>
        member.auth
          .issuePairingCredential()
          .pipe(
            Effect.flatMap((pairing) =>
              member.auth.exchangeBootstrapCredentialForAccessToken(pairing.credential, undefined, {
                deviceType: "mobile",
                ipAddress,
              }),
            ),
          );
      yield* pair("192.168.1.40");
      yield* pair("127.0.0.1");
      const unspent = yield* member.auth.issuePairingCredential();

      const invite = yield* member.cluster.invite({ url: "https://box.local:3773" });
      expect(invite).toMatchObject({
        fingerprint: FINGERPRINT,
        joinString: `https://box.local:3773#${invite.code}.${FINGERPRINT}`,
      });
      const joined = yield* member.cluster.acceptJoin({ code: invite.code, host: studio }, bot);
      expect(joined).toMatchObject({ environmentId: box.environmentId, label: "Box" });

      expect(
        (yield* member.auth.listSessions())
          .map((session) => [session.subject, session.client.ipAddress ?? null])
          .toSorted(),
      ).toEqual([
        [EnvironmentAuth.CLUSTER_HOST_SUBJECT, "192.168.1.10"],
        ["one-time-token", "127.0.0.1"],
      ]);
      expect(yield* member.auth.listPairingLinks({ includePurposeBound: true })).toEqual([]);
      expect(
        yield* member.auth
          .exchangeBootstrapCredentialForAccessToken(unspent.credential, undefined, bot)
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
      expect(yield* member.auth.issuePairingCredential().pipe(Effect.flip)).toMatchObject({
        reason: "is_member",
      });
      expect(yield* member.cluster.status).toMatchObject({
        role: "member",
        fingerprint: FINGERPRINT,
        host: { environmentId: studio.environmentId, label: "Studio" },
      });
    }),
  ),
);

it.effect("a member refuses another cluster and itself; a main host refuses to join", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* makeEnvironment(box);
      const first = yield* member.cluster.invite({});
      yield* member.cluster.acceptJoin({ code: first.code, host: studio }, bot);
      const second = yield* member.cluster.invite({});
      expect(
        yield* member.cluster.acceptJoin({ code: second.code, host: other }, bot).pipe(Effect.flip),
      ).toMatchObject({
        reason: "is_member",
        message:
          "This environment is already a member of the cluster hosted by Studio. Leave it there first.",
      });
      expect(
        yield* member.cluster
          .acceptJoin({ code: second.code, host: { environmentId: box.environmentId, label: "Box" } }, bot)
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "self" });

      const main = yield* makeEnvironment(studioDescriptor);
      yield* main.sql`
        INSERT INTO cluster_members (environment_id, label, transport, url, cert_sha256, secret_name, status, joined_at)
        VALUES ('environment-x', 'X', 'https', 'https://x:3773', ${FINGERPRINT}, 'cluster-member-1', 'online', '2026-11-19T00:00:00.000Z')
      `;
      expect(yield* main.cluster.invite({}).pipe(Effect.flip)).toMatchObject({
        reason: "is_main_host",
      });
      expect(
        yield* main.cluster
          .acceptJoin({ code: "K7M2Q9RZ3NWD", host: other }, bot)
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "is_main_host" });
    }),
  ),
);

it.effect("two hosts racing to join one member: one wins", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* makeEnvironment(box);
      const first = yield* member.cluster.invite({});
      const second = yield* member.cluster.invite({});
      const results = yield* Effect.all(
        [
          member.cluster.acceptJoin({ code: first.code, host: studio }, bot),
          member.cluster.acceptJoin({ code: second.code, host: other }, bot),
        ],
        { concurrency: 2, mode: "result" },
      );
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      expect(results.filter(Result.isFailure).map((result) => result.failure.reason)).toEqual([
        "is_member",
      ]);
      expect(
        (yield* member.auth.listSessions()).filter(
          (session) => session.subject === EnvironmentAuth.CLUSTER_HOST_SUBJECT,
        ),
      ).toHaveLength(1);
    }),
  ),
);

it.effect("a member leaves without its main host and is standalone again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* makeEnvironment(box);
      const invite = yield* member.cluster.invite({});
      const joined = yield* member.cluster.acceptJoin({ code: invite.code, host: studio }, bot);

      expect(yield* member.cluster.leave).toEqual({ left: true });
      expect(
        yield* member.auth.authenticateHttpRequest(bearer(joined.token)).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
      expect(yield* member.cluster.status).toMatchObject({ role: "standalone", host: null });
      yield* member.auth.issuePairingCredential();
      expect(yield* member.cluster.leave).toEqual({ left: false });
    }),
  ),
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/server/src/cluster/ClusterService.test.ts`
Expected: FAIL — `Failed to resolve import "./ClusterService.ts"`.

- [ ] **Step 3: Implement the service, the HTTP group and the wiring**

`apps/server/src/cluster/ClusterService.ts`:

```ts
import {
  AuthSessionId,
  AuthStandardClientScopes,
  type AuthClientMetadata,
  ClusterError,
  type ClusterInvite,
  type ClusterInviteInput,
  type ClusterJoinRequest,
  type ClusterJoinResult,
  type ClusterLeaveResult,
  type ClusterStatus,
  EnvironmentId,
  formatClusterJoinString,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { CLUSTER_MEMBER_PAIRING_SUBJECT } from "../persistence/AuthPairingLinks.ts";
import type * as ManagedLimits from "../policy/managedLimits.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerTls from "../tls/ServerTls.ts";
import * as ClusterRole from "./ClusterRole.ts";

const INVITE_TTL = Duration.minutes(10);
export const CLUSTER_OFF = "Cluster is off on this machine. Turn it on in Settings → Labs.";

const storageError = (cause: unknown) =>
  new ClusterError({
    reason: "storage",
    message: "The cluster state could not be read or saved here. The server log has details.",
    cause,
  });

const fromPairingError = (
  cause:
    | EnvironmentAuth.ServerAuthInternalError
    | ManagedLimits.ManagedPolicyRefusedError
    | ClusterError,
) =>
  cause._tag === "ClusterError"
    ? cause
    : cause._tag === "ManagedPolicyRefusedError"
      ? new ClusterError({ reason: "disabled", message: cause.message })
      : storageError(cause);

/** Client IPs this machine owns; a session without one was issued here (CLI, desktop). */
const isLoopbackClient = (ipAddress: string | undefined) =>
  ipAddress === undefined || isLocalLoopbackHost(ipAddress.replace(/^::ffff:/, ""));

interface MembershipRow {
  readonly host_environment_id: string;
  readonly host_label: string;
  readonly joined_at: string;
  readonly host_session_id: string;
}

/** Join, leave, members and refusals for both sides of a cluster. */
export class ClusterService extends Context.Service<
  ClusterService,
  {
    readonly status: Effect.Effect<ClusterStatus, ClusterError>;
    /** Mints a one-time `cluster-member` code; with `url`, the join string a main host adds. */
    readonly invite: (input: ClusterInviteInput) => Effect.Effect<ClusterInvite, ClusterError>;
    /** Member side of a join: spends the invite, records the host, keeps only loopback sessions. */
    readonly acceptJoin: (
      input: ClusterJoinRequest,
      client: AuthClientMetadata,
    ) => Effect.Effect<ClusterJoinResult, ClusterError>;
    /** Member side: ends the membership and revokes the host's session. Needs no network. */
    readonly leave: Effect.Effect<ClusterLeaveResult, ClusterError>;
  }
>()("t3/cluster/ClusterService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const tls = yield* ServerTls.ServerTls;
  const role = yield* ClusterRole.ClusterRole;
  // One join or leave at a time, so two hosts racing for this member cannot both win.
  const memberLock = yield* Semaphore.make(1);

  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.clusterEnabled),
    Effect.orElseSucceed(() => false),
  );

  const readMembership = sql<MembershipRow>`
    SELECT host_environment_id, host_label, joined_at, host_session_id
    FROM cluster_membership WHERE singleton = 1
  `.pipe(
    Effect.map((rows) => rows[0] ?? null),
    Effect.mapError(storageError),
  );

  const status: ClusterService["Service"]["status"] = Effect.gen(function* () {
    const state = yield* role.current;
    const membership = state.role === "member" ? yield* readMembership : null;
    return {
      enabled: yield* enabled,
      role: state.role,
      fingerprint: tls.fingerprint,
      host:
        membership === null
          ? null
          : {
              environmentId: EnvironmentId.make(membership.host_environment_id),
              label: membership.host_label,
              joinedAt: DateTime.makeUnsafe(membership.joined_at),
            },
    } satisfies ClusterStatus;
  }).pipe(Effect.withSpan("ClusterService.status"));

  const invite: ClusterService["Service"]["invite"] = Effect.fn("ClusterService.invite")(
    function* (input) {
      if ((yield* role.current).role === "main") {
        return yield* new ClusterError({
          reason: "is_main_host",
          message: "This environment is the main host of a cluster, so it cannot join another.",
        });
      }
      const url = input.url === undefined ? undefined : URL.parse(input.url);
      if (url === null || (url !== undefined && url.protocol !== "https:")) {
        return yield* new ClusterError({
          reason: "invalid_target",
          message: `${input.url} is not an https address the main host can reach.`,
        });
      }
      const issued = yield* auth
        .createPairingLink({
          subject: CLUSTER_MEMBER_PAIRING_SUBJECT,
          scopes: AuthStandardClientScopes,
          ttl: INVITE_TTL,
          label: "Cluster invite",
        })
        .pipe(Effect.mapError(fromPairingError));
      const fingerprint = tls.fingerprint;
      return {
        code: issued.credential,
        fingerprint,
        joinString:
          url === undefined
            ? null
            : formatClusterJoinString({ url: url.href, code: issued.credential, fingerprint }),
        expiresAt: issued.expiresAt,
      } satisfies ClusterInvite;
    },
  );

  /** Revokes every session but the host's and this machine's, every unspent code and peer link. */
  const keepOnlyHostAndLoopback = Effect.fn("ClusterService.keepOnlyHostAndLoopback")(
    function* (hostSessionId: AuthSessionId) {
      const sessions = yield* auth.listSessions().pipe(Effect.mapError(storageError));
      const revoked = sessions.filter(
        (session) =>
          session.sessionId !== hostSessionId &&
          (session.subject === EnvironmentAuth.CLUSTER_HOST_SUBJECT ||
            session.subject === EnvironmentAuth.CLOUD_CONNECT_SUBJECT ||
            session.subject === EnvironmentAuth.MCP_CLIENT_SUBJECT ||
            !isLoopbackClient(session.client.ipAddress)),
      );
      yield* Effect.forEach(revoked, (session) => auth.revokeSession(session.sessionId), {
        discard: true,
      }).pipe(Effect.mapError(storageError));
      const links = yield* auth
        .listPairingLinks({ excludeSubjects: [], includePurposeBound: true })
        .pipe(Effect.mapError(storageError));
      yield* Effect.forEach(links, (link) => auth.revokePairingLink(link.id), {
        discard: true,
      }).pipe(Effect.mapError(storageError));
      yield* peerLinks.unlinkAll.pipe(Effect.mapError(storageError));
    },
  );

  const acceptJoin: ClusterService["Service"]["acceptJoin"] = Effect.fn(
    "ClusterService.acceptJoin",
  )(
    function* (input, client) {
      const self = yield* environment.getDescriptor;
      if (input.host.environmentId === self.environmentId) {
        return yield* new ClusterError({
          reason: "self",
          message: "An environment cannot join its own cluster.",
        });
      }
      const state = yield* role.current;
      if (state.role === "main") {
        return yield* new ClusterError({
          reason: "is_main_host",
          message: "This environment is the main host of a cluster, so it cannot join another.",
        });
      }
      if (state.role === "member" && state.hostEnvironmentId !== input.host.environmentId) {
        return yield* new ClusterError({
          reason: "is_member",
          message: `This environment is already a member of the cluster hosted by ${state.hostLabel}. Leave it there first.`,
        });
      }
      const previous = yield* readMembership;
      const session = yield* auth
        .consumeClusterInvite(input.code, { hostLabel: input.host.label, client })
        .pipe(
          Effect.mapError((cause) =>
            EnvironmentAuth.isServerAuthInternalError(cause)
              ? storageError(cause)
              : new ClusterError({
                  reason: "pairing_rejected",
                  message:
                    "That cluster invite is unknown, expired, or already used. Create a new one on the member.",
                }),
          ),
        );
      yield* Effect.gen(function* () {
        const joinedAt = previous?.joined_at ?? DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO cluster_membership (singleton, host_environment_id, host_label, joined_at, host_session_id)
          VALUES (1, ${input.host.environmentId}, ${input.host.label}, ${joinedAt}, ${session.sessionId})
          ON CONFLICT (singleton) DO UPDATE SET
            host_label = excluded.host_label,
            host_session_id = excluded.host_session_id
        `;
      }).pipe(
        Effect.mapError(storageError),
        Effect.onError(() => auth.revokeSession(session.sessionId).pipe(Effect.ignore)),
      );
      yield* keepOnlyHostAndLoopback(session.sessionId);
      return { environmentId: self.environmentId, label: self.label, token: session.token };
    },
    (effect) => memberLock.withPermits(1)(effect),
  );

  const leave: ClusterService["Service"]["leave"] = Effect.gen(function* () {
    const membership = yield* readMembership;
    if (membership === null) return { left: false };
    yield* auth
      .revokeSession(AuthSessionId.make(membership.host_session_id))
      .pipe(Effect.mapError(storageError));
    yield* sql`DELETE FROM cluster_membership WHERE singleton = 1`.pipe(
      Effect.mapError(storageError),
    );
    return { left: true };
  }).pipe(memberLock.withPermits(1), Effect.withSpan("ClusterService.leave"));

  return ClusterService.of({ status, invite, acceptJoin, leave });
});

export const layer = Layer.effect(ClusterService, make);
```

`packages/contracts/src/environmentHttp.ts` — import `ClusterError, ClusterJoinRequest, ClusterJoinResult, ClusterLeaveResult` from `./cluster.ts`; above `export class EnvironmentHttpApi`:

```ts
class EnvironmentClusterHttpApi extends HttpApiGroup.make("cluster")
  .add(
    HttpApiEndpoint.post("join", "/api/cluster/join", {
      payload: ClusterJoinRequest,
      success: ClusterJoinResult,
      error: ClusterError,
    }),
  )
  .add(
    HttpApiEndpoint.post("leave", "/api/cluster/leave", {
      headers: OptionalBearerHeaders,
      success: ClusterLeaveResult,
      error: [ClusterError, EnvironmentHttpForbiddenError],
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}
```

and `.add(EnvironmentClusterHttpApi)` after `.add(EnvironmentWebhooksHttpApi)`.

`apps/server/src/cluster/http.ts`:

```ts
import {
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { annotateEnvironmentRequest } from "../auth/http.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as ClusterService from "./ClusterService.ts";

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
          if (principal.subject !== EnvironmentAuth.CLUSTER_HOST_SUBJECT) {
            return yield* new EnvironmentHttpForbiddenError({
              message: "Only this environment's cluster host can remove it from the cluster.",
            });
          }
          return yield* cluster.leave;
        }),
      );
  }),
);
```

`apps/server/src/server.ts` — add imports `* as ClusterHttp from "./cluster/http.ts"`, `* as ClusterService from "./cluster/ClusterService.ts"`, `* as ServerTls from "./tls/ServerTls.ts"`; in `HttpApiBuilder.layer(EnvironmentHttpApi).pipe(…)` add `Layer.provide(ClusterHttp.layer),`. Then replace the links provide in `layerMakeRoutes` (`:887-894`) with:

```ts
  // Links to other environments and the cluster, shared by Settings (WebSocket), HTTP, the
  // proxy and agents (/mcp). PeerForwarding reads ClusterService, so it is built in here.
  Layer.provide(
    PeerForwarding.layer.pipe(
      Layer.provideMerge(ClusterService.layer.pipe(Layer.provide(ServerTls.layer))),
      Layer.provideMerge(PeerMcpClient.layer),
      Layer.provideMerge(PeerLinks.layer),
    ),
  ),
```

`ClusterService` takes `PeerLinks` from the `provideMerge` below it, and everything in `layerMakeRoutes` still sees `ClusterService` through the merge.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/cluster/ClusterService.test.ts`
Expected: PASS (4 tests).

Run: `vp run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/cluster/ClusterService.ts apps/server/src/cluster/ClusterService.testkit.ts apps/server/src/cluster/ClusterService.test.ts apps/server/src/cluster/http.ts packages/contracts/src/environmentHttp.ts apps/server/src/server.ts
git commit -m "feat(server): environments accept and leave a cluster

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: `ClusterService` main side — add, rename, remove, members

**Files:**

- Modify: `apps/server/src/cluster/ClusterService.ts` (interface, `make`, imports)
- Modify: `apps/server/src/cluster/ClusterService.testkit.ts` (ssh, `ClusterUpstream`, `serveMember`, `serveRoutes`)
- Modify: `apps/server/src/server.ts` (the provide added in Task 6)
- Test: `apps/server/src/cluster/ClusterService.test.ts`

**Interfaces:**

- Consumes: `ClusterUpstream.connect`, `ClusterUpstream.inviteOverSsh`, `PinnedTransport.isPinMismatch` (Task 5); `parseClusterJoinString`, `parseClusterSshTarget`, `formatClusterSshTarget` (Task 1); `EnvironmentHttpApi.groups.{metadata,auth,cluster}`.
- Produces (added to `ClusterService["Service"]`):
  - `members: Stream<ReadonlyArray<ClusterMember>>` (current list, then every change)
  - `addMember(input: ClusterAddMemberInput): Effect<ClusterMember, ClusterError>`
  - `removeMember(memberId: EnvironmentId): Effect<ClusterRemoveMemberResult, ClusterError>`
  - `renameMember(input: ClusterRenameMemberInput): Effect<ClusterMember, ClusterError>`
  - `connect(memberId: EnvironmentId): Effect<MemberConnection, ClusterError>` with `MemberConnection = { upstream: ClusterUpstream.Upstream; token: string; member: ClusterMember }`
  - `awaitGone(memberId: EnvironmentId): Effect<void>`
  - A new or re-added member is stored `offline`: only its control link (Task 8) marks it `online`.
  - testkit: `serveMember(descriptor)` → `ClusterEnvironment & { url: string; serveAgain: Effect<string, never, Scope> }`, `serveRoutes(routes, context)`, `makeEnvironment(descriptor, ssh?)`.

- [ ] **Step 1: Extend the testkit and write the failing tests**

`apps/server/src/cluster/ClusterService.testkit.ts` — add imports:

```ts
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as AuthHttp from "../auth/http.ts";
import * as ServerHttp from "../http.ts";
import * as ClusterHttp from "./http.ts";
import * as ClusterUpstream from "./ClusterUpstream.ts";
```

Replace `layerClusterEnvironment` and `makeEnvironment` with:

```ts
const unusedSsh = SshTunnel.SshEnvironmentManager.of({
  ensureEnvironment: () => Effect.die("this test reaches members over http"),
  disconnectEnvironment: () => Effect.void,
  closeAllTunnels: Effect.void,
});

/** One environment with its own database, as a member or a main host. */
export const layerClusterEnvironment = (
  descriptor: ExecutionEnvironmentDescriptor,
  ssh: SshTunnel.SshEnvironmentManager["Service"] = unusedSsh,
) =>
  ClusterService.layer.pipe(
    Layer.provideMerge(ClusterUpstream.layer),
    Layer.provide(Layer.succeed(SshTunnel.SshEnvironmentManager, ssh)),
    Layer.provide(SshAuth.SshPasswordPrompt.disabledLayer),
    Layer.provide(NetService.layer),
    Layer.provideMerge(PeerLinks.layer),
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(ServerSettings.layerTest({ clusterEnabled: true })),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(Layer.mock(ServerTls.ServerTls)({ fingerprint: FINGERPRINT })),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(descriptor.environmentId),
        getDescriptor: Effect.succeed(descriptor),
      }),
    ),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cluster-" })),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.fresh,
  );

export const makeEnvironment = (
  descriptor: ExecutionEnvironmentDescriptor,
  ssh?: SshTunnel.SshEnvironmentManager["Service"],
) =>
  layerClusterEnvironment(descriptor, ssh).pipe(
    Layer.build,
    Effect.map((context) => ({
      context,
      cluster: Context.get(context, ClusterService.ClusterService),
      auth: Context.get(context, EnvironmentAuth.EnvironmentAuth),
      settings: Context.get(context, ServerSettings.ServerSettingsService),
      sql: Context.get(context, SqlClient.SqlClient),
    })),
  );

export type ClusterEnvironment = Effect.Success<ReturnType<typeof makeEnvironment>>;

/** `routes` on a fresh loopback socket, closed with the enclosing scope. */
export const serveRoutes = <E>(
  routes: Layer.Layer<never, E, never>,
) =>
  Effect.gen(function* () {
    const server = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
    yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.fresh,
      Layer.build,
      Effect.provideContext(server),
    );
    const address = Context.get(server, HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
    return `http://127.0.0.1:${address.port}`;
  });

class MemberTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.cluster) {}

const memberRoutes = (context: ClusterEnvironment["context"]) =>
  HttpApiBuilder.layer(MemberTestApi).pipe(
    Layer.provide(ClusterHttp.layer),
    Layer.provide(AuthHttp.layer),
    Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(Layer.succeedContext(context)),
  );

/** A member on a real socket; `serveAgain` serves the same environment at a new address. */
export const serveMember = (descriptor: ExecutionEnvironmentDescriptor) =>
  Effect.gen(function* () {
    const environment = yield* makeEnvironment(descriptor);
    const serveAgain = serveRoutes(memberRoutes(environment.context));
    return { ...environment, url: yield* serveAgain, serveAgain };
  });
```

Append to `apps/server/src/cluster/ClusterService.test.ts` (add imports `* as Option from "effect/Option"`, `* as Stream from "effect/Stream"`, `* as SshTunnel from "@t3tools/ssh/tunnel"`, `{ SshCommandError } from "@t3tools/ssh/errors"`, and `serveMember` from the testkit):

```ts
const memberCount = (main: { cluster: { members: Stream.Stream<ReadonlyArray<unknown>> } }) =>
  main.cluster.members.pipe(Stream.runHead, Effect.map(Option.map((members) => members.length)));

it.effect("adds a member with its join string, and neither side nests", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box);
      const main = yield* makeEnvironment(studioDescriptor);
      const joinString = (yield* member.cluster.invite({ url: member.url })).joinString ?? "";
      const added = yield* main.cluster.addMember({ target: joinString });
      // Online once its control link is up (Task 8).
      expect(added).toMatchObject({
        environmentId: box.environmentId,
        label: "Box",
        transport: "https",
        address: member.url,
        status: "offline",
      });
      expect(yield* member.cluster.status).toMatchObject({
        role: "member",
        host: { environmentId: studio.environmentId, label: "Studio" },
      });
      expect(yield* main.cluster.status).toMatchObject({ role: "main", host: null });

      expect(yield* member.cluster.addMember({ target: joinString }).pipe(Effect.flip)).toMatchObject(
        { reason: "is_member" },
      );
      expect(yield* main.cluster.invite({}).pipe(Effect.flip)).toMatchObject({
        reason: "is_main_host",
      });

      const renamed = yield* main.cluster.renameMember({
        memberId: box.environmentId,
        label: "Build box",
      });
      expect(renamed.label).toBe("Build box");
      expect(yield* main.cluster.members.pipe(Stream.runHead)).toEqual(Option.some([renamed]));

      yield* main.settings.updateSettings({ clusterEnabled: false });
      expect(yield* main.cluster.members.pipe(Stream.runHead)).toEqual(Option.some([]));
      expect(yield* main.cluster.addMember({ target: joinString }).pipe(Effect.flip)).toMatchObject({
        reason: "disabled",
      });
    }),
  ),
);

it.effect("removal tells a reachable member, and forgets one that already left", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box);
      const main = yield* makeEnvironment(studioDescriptor);
      const add = member.cluster
        .invite({ url: member.url })
        .pipe(Effect.flatMap((invite) => main.cluster.addMember({ target: invite.joinString ?? "" })));
      yield* add;
      yield* member.cluster.leave;
      expect(yield* main.cluster.removeMember(box.environmentId)).toEqual({
        removed: true,
        memberNotified: false,
      });
      expect(yield* main.cluster.status).toMatchObject({ role: "standalone" });

      yield* add;
      expect(yield* main.cluster.removeMember(box.environmentId)).toEqual({
        removed: true,
        memberNotified: true,
      });
      expect(yield* member.cluster.status).toMatchObject({ role: "standalone", host: null });
      expect(yield* memberCount(main)).toEqual(Option.some(0));
    }),
  ),
);

it.effect("re-adding a member at a new address moves the proxy there and retires the old token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box);
      const main = yield* makeEnvironment(studioDescriptor);
      const addAt = (url: string) =>
        member.cluster
          .invite({ url })
          .pipe(Effect.flatMap((invite) => main.cluster.addMember({ target: invite.joinString ?? "" })));
      yield* addAt(member.url);
      const before = yield* main.cluster.connect(box.environmentId);

      const moved = yield* member.serveAgain;
      expect(yield* addAt(moved)).toMatchObject({ address: moved });
      const after = yield* main.cluster.connect(box.environmentId);
      expect(after.upstream.origin).toBe(moved);
      expect(after.token).not.toBe(before.token);
      expect(
        yield* member.auth.authenticateHttpRequest(bearer(before.token)).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
      expect(yield* memberCount(main)).toEqual(Option.some(1));
    }),
  ),
);

it.effect("two adds of one member racing leave the stored token the live one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box);
      const main = yield* makeEnvironment(studioDescriptor);
      const first = (yield* member.cluster.invite({ url: member.url })).joinString ?? "";
      const second = (yield* member.cluster.invite({ url: member.url })).joinString ?? "";
      yield* Effect.all(
        [main.cluster.addMember({ target: first }), main.cluster.addMember({ target: second })],
        { concurrency: 2 },
      );
      const { token } = yield* main.cluster.connect(box.environmentId);
      expect((yield* member.auth.authenticateHttpRequest(bearer(token))).subject).toBe(
        EnvironmentAuth.CLUSTER_HOST_SUBJECT,
      );
      expect(
        (yield* member.auth.listSessions()).filter(
          (session) => session.subject === EnvironmentAuth.CLUSTER_HOST_SUBJECT,
        ),
      ).toHaveLength(1);
    }),
  ),
);

it.effect("adds a member over ssh, and a password prompt fails with a clear error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box);
      const ssh = SshTunnel.SshEnvironmentManager.of({
        ensureEnvironment: (target, options) =>
          target.username === "nokey"
            ? Effect.fail(
                new SshCommandError({
                  message: "Permission denied (publickey,password).",
                  command: ["ssh"],
                  exitCode: 255,
                  stderr: "",
                }),
              )
            : member.cluster.invite({}).pipe(
                Effect.orDie,
                Effect.map((invite) => ({
                  target,
                  httpBaseUrl: member.url,
                  wsBaseUrl: member.url.replace(/^http/, "ws"),
                  pairingToken: options?.pairingPurpose === "cluster-member" ? invite.code : null,
                })),
              ),
        disconnectEnvironment: () => Effect.void,
        closeAllTunnels: Effect.void,
      });
      const main = yield* makeEnvironment(studioDescriptor, ssh);
      expect(yield* main.cluster.addMember({ target: "ssh://me@box:2222" })).toMatchObject({
        transport: "ssh",
        address: "me@box:2222",
      });
      expect(
        yield* main.cluster.addMember({ target: "nokey@other" }).pipe(Effect.flip),
      ).toMatchObject({
        reason: "ssh",
        message:
          "SSH to nokey@other needs a key or a running ssh-agent; this server cannot answer password prompts.",
      });
    }),
  ),
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/server/src/cluster/ClusterService.test.ts`
Expected: FAIL — `main.cluster.addMember is not a function` (and `ClusterUpstream` missing from the service's requirements once the testkit provides it).

> The racing test can pass by luck before `hostLock` exists; it fails whenever the earlier join's write lands last. Run it a few times with `-t "racing"` after Step 3 to see it stay green.

- [ ] **Step 3: Implement the main side**

`apps/server/src/cluster/ClusterService.ts` — add imports:

```ts
import {
  type ClusterAddMemberInput,
  ClusterMember,
  ClusterMemberStatus,
  type ClusterRemoveMemberResult,
  type ClusterRenameMemberInput,
  ClusterTransport,
  EnvironmentHttpApi,
  type ExecutionEnvironmentDescriptor,
  formatClusterSshTarget,
  ORCHESTRATION_PROTOCOL_VERSION,
  parseClusterJoinString,
  parseClusterSshTarget,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ClusterUpstream from "./ClusterUpstream.ts";
import * as PinnedTransport from "./pinnedTransport.ts";
```

Module scope, after `MembershipRow`:

```ts
const REQUEST_TIMEOUT = Duration.seconds(10);
const CERTIFICATE_CHANGED =
  "Certificate changed: it presented a certificate other than the pinned one. Invite it again.";

const MemberRow = Schema.Struct({
  environment_id: EnvironmentId,
  label: Schema.String,
  transport: ClusterTransport,
  url: Schema.NullOr(Schema.String),
  ssh_target: Schema.NullOr(Schema.String),
  cert_sha256: Schema.NullOr(Schema.String),
  secret_name: Schema.String,
  status: ClusterMemberStatus,
  joined_at: Schema.DateTimeUtcFromString,
  last_reached_at: Schema.NullOr(Schema.DateTimeUtcFromString),
  last_error: Schema.NullOr(Schema.String),
});
type MemberRow = typeof MemberRow.Type;
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(MemberRow));

const toMember = (row: MemberRow): ClusterMember => ({
  environmentId: row.environment_id,
  label: row.label,
  transport: row.transport,
  address: row.url ?? row.ssh_target ?? "",
  status: row.status,
  joinedAt: row.joined_at,
  lastReachedAt: row.last_reached_at,
  lastError: row.last_error,
});

const MemberApi = HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.cluster)
  .annotateMerge(EnvironmentHttpApi.annotations);

const isCompatible = (descriptor: ExecutionEnvironmentDescriptor) =>
  descriptor.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION &&
  descriptor.capabilities.cluster === true;

/** Why `origin` failed a join, keeping the member's own refusal. */
const reachError = (origin: string) => (error: unknown) =>
  error instanceof ClusterError
    ? error
    : PinnedTransport.isPinMismatch(error)
      ? new ClusterError({ reason: "certificate_changed", message: `${origin}: ${CERTIFICATE_CHANGED}`, cause: error })
      : new ClusterError({
          reason: "unreachable",
          message: `${origin} did not answer as a T3 Code environment.`,
          cause: error,
        });

export interface MemberConnection {
  readonly upstream: ClusterUpstream.Upstream;
  readonly token: string;
  readonly member: ClusterMember;
}
```

Add to the `ClusterService` interface:

```ts
    readonly members: Stream.Stream<ReadonlyArray<ClusterMember>>;
    readonly addMember: (input: ClusterAddMemberInput) => Effect.Effect<ClusterMember, ClusterError>;
    /** Forgets the member here and asks it to leave; it may be offline. */
    readonly removeMember: (
      memberId: EnvironmentId,
    ) => Effect.Effect<ClusterRemoveMemberResult, ClusterError>;
    readonly renameMember: (
      input: ClusterRenameMemberInput,
    ) => Effect.Effect<ClusterMember, ClusterError>;
    /** Where to reach a member and the `cluster-host` token to send it. */
    readonly connect: (memberId: EnvironmentId) => Effect.Effect<MemberConnection, ClusterError>;
    /** Completes once the member is removed or revoked. */
    readonly awaitGone: (memberId: EnvironmentId) => Effect.Effect<void>;
```

In `make`, after `const memberLock = …`:

```ts
  const upstream = yield* ClusterUpstream.ClusterUpstream;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  // Each join rotates the member's token; racing adds could store one it already revoked.
  const hostLock = yield* Semaphore.make(1);
  // Mirrors cluster_members so proxied requests read no database; `start` rereads it for the CLI's writes.
  const rowsRef = yield* SubscriptionRef.make<ReadonlyArray<MemberRow>>([]);
  const tokens = new Map<string, string>();

  const requireEnabled = enabled.pipe(
    Effect.flatMap((on) =>
      on ? Effect.void : Effect.fail(new ClusterError({ reason: "disabled", message: CLUSTER_OFF })),
    ),
  );
  const enabledChanges = Stream.concat(
    Stream.fromEffect(enabled),
    serverSettings.streamChanges.pipe(Stream.map((settings) => settings.clusterEnabled)),
  ).pipe(Stream.changes);

  let lastRows = "";
  const reload = sql`SELECT * FROM cluster_members ORDER BY label, environment_id`.pipe(
    Effect.flatMap((raw) => {
      const serialized = JSON.stringify(raw);
      // Unchanged rows publish nothing, so `cluster.members` sends clients only real changes.
      if (serialized === lastRows) return Effect.void;
      return decodeRows(raw).pipe(
        Effect.flatMap((rows) => SubscriptionRef.set(rowsRef, rows)),
        Effect.andThen(Effect.sync(() => (lastRows = serialized))),
      );
    }),
    Effect.mapError(storageError),
    Effect.withSpan("ClusterService.reload"),
  );
  yield* reload.pipe(
    Effect.catch((cause) => Effect.logWarning("Cluster members could not be read", { cause })),
  );

  const findRow = Effect.fn("ClusterService.findRow")(function* (memberId: EnvironmentId) {
    const row = (yield* SubscriptionRef.get(rowsRef)).find(
      (candidate) => candidate.environment_id === memberId,
    );
    if (row === undefined) {
      return yield* new ClusterError({
        reason: "unknown_member",
        message: `${memberId} is not a member of this cluster.`,
      });
    }
    return row;
  });

  const tokenOf = Effect.fn("ClusterService.tokenOf")(function* (secretName: string) {
    const cached = tokens.get(secretName);
    if (cached !== undefined) return cached;
    const stored = yield* secrets.get(secretName).pipe(Effect.mapError(storageError));
    if (Option.isNone(stored)) {
      return yield* new ClusterError({
        reason: "unknown_member",
        message: "This member lost its credential here. Invite it again.",
      });
    }
    const token = new TextDecoder().decode(stored.value);
    tokens.set(secretName, token);
    return token;
  });

  const clientFor = (connection: ClusterUpstream.Upstream) =>
    HttpApiClient.make(MemberApi, { baseUrl: connection.origin }).pipe(
      Effect.provideService(HttpClient.HttpClient, connection.httpClient),
    );

  const connect: ClusterService["Service"]["connect"] = Effect.fn("ClusterService.connect")(
    function* (memberId) {
      yield* requireEnabled;
      const row = yield* findRow(memberId);
      const token = yield* tokenOf(row.secret_name);
      const connection = yield* upstream.connect(
        row.transport === "https"
          ? { transport: "https", url: row.url ?? "", certSha256: row.cert_sha256 }
          : { transport: "ssh", sshTarget: row.ssh_target ?? "" },
      );
      return { upstream: connection, token, member: toMember(row) };
    },
  );

  const addMember: ClusterService["Service"]["addMember"] = Effect.fn("ClusterService.addMember")(
    function* (input) {
      yield* requireEnabled;
      yield* role.refuseIfMember("Adding a cluster member");
      const self = yield* environment.getDescriptor;
      const join = parseClusterJoinString(input.target);
      const sshTarget = join === undefined ? parseClusterSshTarget(input.target) : undefined;
      const resolved =
        join !== undefined
          ? {
              target: { transport: "https", url: join.url, certSha256: join.fingerprint } as const,
              code: Effect.succeed(join.code),
            }
          : sshTarget !== undefined
            ? {
                target: { transport: "ssh", sshTarget: formatClusterSshTarget(sshTarget) } as const,
                code: upstream
                  .inviteOverSsh(formatClusterSshTarget(sshTarget))
                  .pipe(Effect.map((invited) => invited.code)),
              }
            : undefined;
      if (resolved === undefined) {
        return yield* new ClusterError({
          reason: "invalid_target",
          message:
            "Paste the join string from the member's Settings → Cluster or `t3 cluster invite`, or an ssh target such as me@box.",
        });
      }
      const code = yield* resolved.code;
      const connection = yield* upstream.connect(resolved.target);
      const client = yield* clientFor(connection);
      const descriptor = yield* client.metadata
        .descriptor()
        .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(reachError(connection.origin)));
      if (descriptor.environmentId === self.environmentId) {
        return yield* new ClusterError({ reason: "self", message: "That address is this environment." });
      }
      if (!isCompatible(descriptor)) {
        return yield* new ClusterError({
          reason: "incompatible",
          message: `${descriptor.label} runs a T3 Code version without clusters or speaks another protocol. Update both environments.`,
        });
      }
      const joined = yield* client.cluster
        .join({
          payload: { code, host: { environmentId: self.environmentId, label: self.label } },
        })
        .pipe(Effect.mapError(reachError(connection.origin)));
      if (joined.environmentId !== descriptor.environmentId) {
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
          INSERT INTO cluster_members (environment_id, label, transport, url, ssh_target, cert_sha256, secret_name, status, joined_at, last_reached_at, last_error)
          VALUES (
            ${joined.environmentId}, ${input.label ?? joined.label}, ${target.transport},
            ${target.transport === "https" ? target.url : null},
            ${target.transport === "ssh" ? target.sshTarget : null},
            ${target.transport === "https" && target.url.startsWith("https:") ? target.certSha256 : null},
            ${secretName}, 'offline', ${now}, ${now}, NULL
          )
          ON CONFLICT (environment_id) DO UPDATE SET
            transport = excluded.transport, url = excluded.url, ssh_target = excluded.ssh_target,
            cert_sha256 = excluded.cert_sha256, secret_name = excluded.secret_name,
            status = 'offline', last_reached_at = excluded.last_reached_at, last_error = NULL
        `;
        if (previous !== undefined) {
          tokens.delete(previous.secret_name);
          yield* secrets.remove(previous.secret_name);
        }
      }).pipe(
        Effect.mapError(storageError),
        Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)),
      );
      if (wasStandalone) yield* peerLinks.unlinkAll.pipe(Effect.mapError(storageError));
      yield* reload;
      return toMember(yield* findRow(joined.environmentId));
    },
    (effect) => hostLock.withPermits(1)(effect),
  );

  const removeMember: ClusterService["Service"]["removeMember"] = Effect.fn(
    "ClusterService.removeMember",
  )(
    function* (memberId) {
      const row = (yield* SubscriptionRef.get(rowsRef)).find(
        (candidate) => candidate.environment_id === memberId,
      );
      if (row === undefined) return { removed: false, memberNotified: false };
      const memberNotified = yield* connect(memberId).pipe(
        Effect.flatMap(({ upstream: connection, token }) =>
          clientFor(connection).pipe(
            Effect.flatMap((client) =>
              client.cluster.leave({ headers: { authorization: `Bearer ${token}` } }),
            ),
          ),
        ),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      yield* sql`DELETE FROM cluster_members WHERE environment_id = ${memberId}`.pipe(
        Effect.mapError(storageError),
      );
      tokens.delete(row.secret_name);
      yield* secrets.remove(row.secret_name).pipe(Effect.mapError(storageError));
      yield* reload;
      return { removed: true, memberNotified };
    },
    (effect) => hostLock.withPermits(1)(effect),
  );

  const renameMember: ClusterService["Service"]["renameMember"] = Effect.fn(
    "ClusterService.renameMember",
  )(function* (input) {
    yield* findRow(input.memberId);
    yield* sql`UPDATE cluster_members SET label = ${input.label} WHERE environment_id = ${input.memberId}`.pipe(
      Effect.mapError(storageError),
    );
    yield* reload;
    return toMember(yield* findRow(input.memberId));
  });

  // Clients would otherwise list members the proxy answers 403 for.
  const members = Stream.zipLatestWith(
    SubscriptionRef.changes(rowsRef),
    enabledChanges,
    (rows, on) => (on ? rows.map(toMember) : []),
  );

  const awaitGone: ClusterService["Service"]["awaitGone"] = (memberId) =>
    SubscriptionRef.changes(rowsRef).pipe(
      Stream.filter(
        (rows) =>
          !rows.some((row) => row.environment_id === memberId && row.status !== "revoked"),
      ),
      Stream.take(1),
      Stream.runDrain,
    );
```

and return:

```ts
  return ClusterService.of({
    status,
    invite,
    acceptJoin,
    leave,
    members,
    addMember,
    removeMember,
    renameMember,
    connect,
    awaitGone,
  });
```

`apps/server/src/server.ts` — import `* as ClusterUpstream from "./cluster/ClusterUpstream.ts"`, `* as SshAuth from "@t3tools/ssh/auth"`, `* as SshTunnel from "@t3tools/ssh/tunnel"`, and change the `ClusterService` line Task 6 put inside the `PeerForwarding` provide to:

```ts
      Layer.provideMerge(
        ClusterService.layer.pipe(
          Layer.provide(ServerTls.layer),
          Layer.provide(
            ClusterUpstream.layer.pipe(
              Layer.provide(SshTunnel.SshEnvironmentManager.layer()),
              // The server's own ssh keys or agent; no client answers its prompts, desktop included.
              Layer.provide(SshAuth.SshPasswordPrompt.disabledLayer),
              Layer.provide(NetService.layer),
            ),
          ),
        ),
      ),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/cluster/ClusterService.test.ts`
Expected: PASS (9 tests). Then `vp test run apps/server/src/cluster/ClusterService.test.ts -t "racing"` three times: PASS each time.

Run: `vp run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/cluster/ClusterService.ts apps/server/src/cluster/ClusterService.testkit.ts apps/server/src/cluster/ClusterService.test.ts apps/server/src/server.ts
git commit -m "feat(server): main host adds, renames and removes cluster members

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Control link — status and the host channel

**Files:**

- Modify: `packages/contracts/src/cluster.ts` (host channel schemas)
- Modify: `packages/contracts/src/rpc.ts:20-28` (imports), `:546-549` (`WS_METHODS`), after `:902-905` (Rpc definitions, `ClusterLinkRpcs`), `:2294-2297` (group)
- Modify: `apps/server/src/auth/RpcAuthorization.ts:95` (scopes)
- Modify: `apps/server/src/cluster/ClusterService.ts` (imports, module scope, interface, `make`)
- Modify: `apps/server/src/cluster/ClusterService.testkit.ts` (members serve the link's `/ws`; `awaitStatus`)
- Modify: `apps/server/src/ws.ts:10` (import), `:1556` (service), `:2693-2701` (handlers), `:3606` and `:3705` (provide)
- Modify: `apps/server/src/ws.test.ts:845` (mock)
- Modify: `apps/server/src/server.ts:864-868` (start the links)
- Test: `apps/server/src/cluster/ClusterService.test.ts`

**Interfaces:**

- Consumes: `ClusterService.connect`, `reload`, `rowsRef`, `enabledChanges`, `clientFor`, `isCompatible`, `CERTIFICATE_CHANGED`, `REQUEST_TIMEOUT` (Task 7); `readMembership`, `random` (Tasks 6, 7); `EnvironmentAuth.authenticateWebSocketUpgrade`, `SessionStore.awaitInvalidation`; `RpcClient.makeProtocolSocket`, `RpcServer.makeProtocolWithHttpEffectWebsocket`, `FiberMap`.
- Produces:
  - Contracts: `ClusterHostRequest`, `ClusterHostChannelEvent`, `ClusterHostResult`, `ClusterHostReplyInput`; `WS_METHODS.clusterHostChannel` (`cluster.hostChannel`, stream) and `WS_METHODS.clusterHostReply` (`cluster.hostReply`), both `orchestration:operate` on the server and refused by `ClusterService` to any session but the member's current `cluster-host` one; `ClusterLinkRpcs` (the group of those two).
  - `ClusterService["Service"]`: `start(serve: ClusterHostServe): Effect<void, never, Scope>`, `hostChannel(session)`, `hostReply(session, input)`, `hostCall(call: ClusterHostCall): Effect<ClusterHostResult, ClusterError>`.
  - `ClusterService.ts` exports: types `ClusterHostServe`, `ClusterHostCall`; `clusterHostUnreachable(hostLabel)`; `refuseHostRequests`.
  - Testkit: members serve `/ws` with the link's two RPCs; `awaitStatus(main, memberId, status)`.
  - Link behaviour: `start` resets every `online` row to `offline`, then runs one fiber per member while `clusterEnabled` is on. Each attempt runs the preflight (descriptor and `/api/auth/session` with the member's token: wrong environment or no answer is `offline`, another protocol is `incompatible`, unauthenticated is `revoked`), opens `<member>/ws?orchestrationProtocol=<v>` with the token, and subscribes to `cluster.hostChannel`. The member's `ready` event records `online`. A socket that drops records `offline` and reconnects at once; an attempt that never came up records why and retries after 1 s, doubling to at most 30 s. A member's link restarts only when its token, address or pin changes.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/cluster/ClusterService.testkit.ts` — add imports:

```ts
import {
  ClusterLinkRpcs,
  type ClusterMemberStatus,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as SessionStore from "../auth/SessionStore.ts";
```

Add above `memberRoutes`:

```ts
/** A member's `/ws` as its main host's control link uses it, ending with the session as `ws.ts` does. */
const layerLinkSocket = HttpRouter.add(
  "GET",
  "/ws",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const cluster = yield* ClusterService.ClusterService;
    const session = yield* auth.authenticateWebSocketUpgrade(request, "rpc");
    const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* RpcServer.make(ClusterLinkRpcs).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(
        ClusterLinkRpcs.toLayer({
          [WS_METHODS.clusterHostChannel]: () => cluster.hostChannel(session),
          [WS_METHODS.clusterHostReply]: (input) => cluster.hostReply(session, input),
        }),
      ),
      Effect.forkScoped,
    );
    return yield* Effect.raceFirst(
      httpEffect,
      sessions.awaitInvalidation(session.sessionId).pipe(Effect.as(HttpServerResponse.empty())),
    );
  }).pipe(
    Effect.provide(RpcSerialization.layerJson),
    Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 401 }))),
  ),
);
```

Replace `memberRoutes` with:

```ts
const memberRoutes = (context: ClusterEnvironment["context"]) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(MemberTestApi).pipe(
      Layer.provide(ClusterHttp.layer),
      Layer.provide(AuthHttp.layer),
      Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
    layerLinkSocket,
  ).pipe(Layer.provide(Layer.succeedContext(context)));
```

Append:

```ts
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
```

Append to `apps/server/src/cluster/ClusterService.test.ts` (add imports `type ClusterHostRequest` from `@t3tools/contracts`, `* as Deferred from "effect/Deferred"`, `* as Exit from "effect/Exit"`, `* as Fiber from "effect/Fiber"`, `* as Queue from "effect/Queue"`, `* as Scope from "effect/Scope"`, `* as ClusterService from "./ClusterService.ts"`, and `awaitStatus` from the testkit):

```ts
const readCall = {
  tool: "t3_thread_read",
  arguments: { environmentId: "environment-other", threadId: "thread-1" },
  limits: { runtimeMode: "full-access", interactionMode: "default" },
} satisfies ClusterService.ClusterHostCall;

const UNREACHABLE =
  'Cluster host unreachable: "Studio" is not connected, so other environments in the cluster cannot be reached. Work here continues.';

it.effect(
  "the control link carries a member's calls, fails them when it drops, and never sends one twice",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const member = yield* serveMember(box);
        const main = yield* makeEnvironment(studioDescriptor);
        const invite = yield* member.cluster.invite({ url: member.url });
        yield* main.cluster.addMember({ target: invite.joinString ?? "" });
        // No link yet: an agent's call fails at once instead of waiting for one.
        expect(yield* member.cluster.hostCall(readCall).pipe(Effect.flip)).toMatchObject({
          reason: "unreachable",
          message: UNREACHABLE,
        });

        const served = yield* Queue.unbounded<ClusterHostRequest>();
        const interrupted = yield* Deferred.make<string>();
        const serve: ClusterService.ClusterHostServe = (from, request) =>
          Queue.offer(served, request).pipe(
            Effect.andThen(
              request.tool === "slow"
                ? Effect.never.pipe(
                    Effect.onInterrupt(() => Deferred.succeed(interrupted, request.requestId)),
                  )
                : Effect.succeed({
                    isError: false,
                    text: JSON.stringify({ from: from.environmentId }),
                  }),
            ),
          );
        const firstRun = yield* Scope.make();
        yield* main.cluster.start(serve).pipe(Effect.provideService(Scope.Scope, firstRun));
        expect(yield* awaitStatus(main, box.environmentId, "online")).toMatchObject({
          lastError: null,
        });

        expect(yield* member.cluster.hostCall(readCall)).toEqual({
          isError: false,
          text: JSON.stringify({ from: box.environmentId }),
        });
        expect(yield* Queue.take(served)).toMatchObject(readCall);

        // The main host stops with a call in flight: the member hears so, the work there stops.
        const slow = yield* member.cluster
          .hostCall({ ...readCall, tool: "slow" })
          .pipe(Effect.flip, Effect.forkScoped);
        const inFlight = yield* Queue.take(served);
        yield* Scope.close(firstRun, Exit.void);
        expect(yield* Deferred.await(interrupted)).toBe(inFlight.requestId);
        expect(yield* Fiber.join(slow)).toMatchObject({ reason: "unreachable", message: UNREACHABLE });

        // It starts again: nothing is online until its link is, and the old call never comes back.
        yield* main.cluster.start(serve);
        yield* awaitStatus(main, box.environmentId, "online");
        yield* member.cluster.hostCall(readCall);
        const next = yield* Queue.take(served);
        expect(next.tool).toBe("t3_thread_read");
        expect(next.requestId).not.toBe(inFlight.requestId);
      }),
    ),
);

it.effect("a member that leaves shows revoked over its link, and only its host opens the channel", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box);
      const main = yield* makeEnvironment(studioDescriptor);
      const invite = yield* member.cluster.invite({ url: member.url });
      yield* main.cluster.addMember({ target: invite.joinString ?? "" });
      yield* main.cluster.start(ClusterService.refuseHostRequests);
      yield* awaitStatus(main, box.environmentId, "online");
      expect(yield* member.cluster.hostCall(readCall)).toMatchObject({ isError: true });
      expect(
        yield* member.cluster
          .hostChannel({ sessionId: "session-someone-else" })
          .pipe(Stream.runDrain, Effect.flip),
      ).toMatchObject({ reason: "forbidden" });

      yield* member.cluster.leave;
      expect(yield* awaitStatus(main, box.environmentId, "revoked")).toMatchObject({
        lastError: "It no longer accepts this host. Invite it again.",
      });
      yield* main.cluster.removeMember(box.environmentId);
      expect(yield* memberCount(main)).toEqual(Option.some(0));
    }),
  ),
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/server/src/cluster/ClusterService.test.ts -t "link"`
Expected: FAIL — `member.cluster.hostCall is not a function`; typecheck reports `ClusterLinkRpcs` and `WS_METHODS.clusterHostChannel` missing from `@t3tools/contracts`.

- [ ] **Step 3: Implement**

`packages/contracts/src/cluster.ts` — add imports `{ ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts"` and `{ OrchestrationV2LinkedSender } from "./orchestrationV2.ts"`, then append:

```ts
/** One call a member's agent makes through its main host, over the control link. */
export const ClusterHostRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  /** A T3 MCP tool; `arguments.environmentId` names the target unless it is the main host. */
  tool: TrimmedNonEmptyString,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  /** The calling agent's modes, which cap the call as `T3-Mode-Limit` does on `/mcp`. */
  limits: Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
  /** The member's thread the call is made for, as `T3-Sender-Thread` carries it. */
  sender: Schema.optionalKey(OrchestrationV2LinkedSender),
});
export type ClusterHostRequest = typeof ClusterHostRequest.Type;

/** `cluster.hostChannel`: `ready` once the member listens, then each call to run. */
export const ClusterHostChannelEvent = Schema.Union([
  Schema.TaggedStruct("ready", {}),
  Schema.TaggedStruct("request", { request: ClusterHostRequest }),
]);
export type ClusterHostChannelEvent = typeof ClusterHostChannelEvent.Type;

/** A tool's answer as `/mcp` gives it: its joined text, and whether it is a refusal. */
export const ClusterHostResult = Schema.Struct({ isError: Schema.Boolean, text: Schema.String });
export type ClusterHostResult = typeof ClusterHostResult.Type;

export const ClusterHostReplyInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  result: ClusterHostResult,
});
export type ClusterHostReplyInput = typeof ClusterHostReplyInput.Type;
```

`packages/contracts/src/rpc.ts` — import `ClusterError`, `ClusterHostChannelEvent`, `ClusterHostReplyInput` from `./cluster.ts`. In `WS_METHODS` after `peerLinksAnswerRequest`:

```ts
  clusterHostChannel: "cluster.hostChannel",
  clusterHostReply: "cluster.hostReply",
```

After `WsPeerLinksAnswerRequestRpc`:

```ts
const ClusterRpcError = Schema.Union([ClusterError, EnvironmentAuthorizationError]);

const WsClusterHostChannelRpc = Rpc.make(WS_METHODS.clusterHostChannel, {
  payload: Schema.Struct({}),
  success: ClusterHostChannelEvent,
  stream: true,
  error: ClusterRpcError,
});

const WsClusterHostReplyRpc = Rpc.make(WS_METHODS.clusterHostReply, {
  payload: ClusterHostReplyInput,
  error: ClusterRpcError,
});

/** What a main host calls on a member's `/ws`: its control link. */
export const ClusterLinkRpcs = RpcGroup.make(WsClusterHostChannelRpc, WsClusterHostReplyRpc);
```

and in `WsRpcGroup` after `WsPeerLinksAnswerRequestRpc,`:

```ts
  WsClusterHostChannelRpc,
  WsClusterHostReplyRpc,
```

`apps/server/src/auth/RpcAuthorization.ts`, after `[WS_METHODS.peerLinksList]`:

```ts
  // The main host's control link; ClusterService refuses every session but the member's host.
  [WS_METHODS.clusterHostChannel]: AuthOrchestrationOperateScope,
  [WS_METHODS.clusterHostReply]: AuthOrchestrationOperateScope,
```

`apps/server/src/cluster/ClusterService.ts` — add to the `@t3tools/contracts` import `type ClusterHostChannelEvent`, `type ClusterHostReplyInput`, `type ClusterHostRequest`, `type ClusterHostResult`, `ClusterLinkRpcs`, `ORCHESTRATION_PROTOCOL_QUERY_PARAM`, `WS_METHODS`, and add:

```ts
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
```

Module scope, after `MemberConnection`:

```ts
const REVOKED = "It no longer accepts this host. Invite it again.";
const INCOMPATIBLE = "It speaks another T3 Code protocol. Update both environments.";
const NOT_ANSWERING = "It did not answer.";
const LINK_DROPPED = "Its control link dropped. Reconnecting.";
// Quick after a blip; a member that stays away is tried every 30 s at most.
const LINK_BACKOFF = Schedule.min([
  Schedule.exponential("1 second", 2),
  Schedule.spaced("30 seconds"),
]);
const ROWS_RELOAD_INTERVAL = Duration.seconds(30);

/** Why a member's control link is not up. */
interface LinkDown {
  readonly status: Exclude<ClusterMemberStatus, "online">;
  readonly message: string;
}

/** A member agent's call before the member numbers it. */
export type ClusterHostCall = Omit<ClusterHostRequest, "requestId">;

/** Runs one member agent's call on the main host. */
export type ClusterHostServe = (
  member: ClusterMember,
  request: ClusterHostRequest,
) => Effect.Effect<ClusterHostResult>;

/** What a member's agents hear while its control link is down. */
export const clusterHostUnreachable = (hostLabel: string) =>
  new ClusterError({
    reason: "unreachable",
    message: `Cluster host unreachable: "${hostLabel}" is not connected, so other environments in the cluster cannot be reached. Work here continues.`,
  });

/** `serve` for a main host that runs no member agent calls. */
export const refuseHostRequests: ClusterHostServe = () =>
  Effect.succeed({
    isError: true,
    text: JSON.stringify({
      code: "capability_denied",
      message: "This main host does not run its members' agent calls.",
    }),
  });

/** The main host's subscription on a member, and the calls waiting for its answers. */
interface HostChannel {
  readonly sessionId: string;
  readonly events: Queue.Queue<ClusterHostChannelEvent, Cause.Done>;
  readonly pending: Map<string, Deferred.Deferred<ClusterHostResult, ClusterError>>;
}
```

Add to the `ClusterService` interface:

```ts
    /** Main side: one control link per member while the scope lasts; `serve` runs their agents' calls. */
    readonly start: (serve: ClusterHostServe) => Effect.Effect<void, never, Scope.Scope>;
    /** Member side: the main host's link subscribes here; any other session is refused. */
    readonly hostChannel: (session: {
      readonly sessionId: string;
    }) => Stream.Stream<ClusterHostChannelEvent, ClusterError>;
    /** Member side: the main host's answer to one call; a late one is dropped. */
    readonly hostReply: (
      session: { readonly sessionId: string },
      input: ClusterHostReplyInput,
    ) => Effect.Effect<void>;
    /** Member side: runs a call on the main host over the link; fails at once while it is down. */
    readonly hostCall: (call: ClusterHostCall) => Effect.Effect<ClusterHostResult, ClusterError>;
```

In `make`, after `awaitGone`:

```ts
  const recordStatus = (memberId: EnvironmentId, status: ClusterMemberStatus, error: string | null) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE cluster_members
        SET status = ${status},
            last_error = ${error},
            last_reached_at = CASE WHEN ${status} = 'online' THEN ${now} ELSE last_reached_at END
        WHERE environment_id = ${memberId}
      `.pipe(Effect.mapError(storageError));
      yield* reload;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("A cluster member's status could not be saved", { cause }),
      ),
      Effect.withSpan("ClusterService.recordStatus"),
    );

  /** The link's connect check: it answers as this member, speaks this protocol, accepts this host. */
  const preflight = Effect.fn("ClusterService.preflight")(function* (
    memberId: EnvironmentId,
    connection: ClusterUpstream.Upstream,
    token: string,
  ) {
    const client = yield* clientFor(connection);
    const [descriptor, session] = yield* Effect.all(
      [
        client.metadata.descriptor(),
        client.auth.session({ headers: { authorization: `Bearer ${token}` } }),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(
        (cause): LinkDown => ({
          status: "offline",
          message: PinnedTransport.isPinMismatch(cause) ? CERTIFICATE_CHANGED : NOT_ANSWERING,
        }),
      ),
    );
    if (descriptor.environmentId !== memberId) {
      return yield* Effect.fail<LinkDown>({
        status: "offline",
        message: `Its address now answers as ${descriptor.label}. Invite it again.`,
      });
    }
    if (!isCompatible(descriptor)) {
      return yield* Effect.fail<LinkDown>({ status: "incompatible", message: INCOMPATIBLE });
    }
    if (!session.authenticated) {
      return yield* Effect.fail<LinkDown>({ status: "revoked", message: REVOKED });
    }
  });

  /** One link: succeeds when a link that came up drops, fails when it never came up. */
  const linkOnce = (memberId: EnvironmentId, serve: ClusterHostServe) =>
    Effect.gen(function* () {
      const { upstream: connection, token, member } = yield* connect(memberId).pipe(
        Effect.mapError((error): LinkDown => ({ status: "offline", message: error.message })),
      );
      yield* preflight(memberId, connection, token);
      const socket = yield* Socket.makeWebSocket(
        `${connection.origin.replace(/^http/, "ws")}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`,
        { openTimeout: REQUEST_TIMEOUT, headers: { authorization: `Bearer ${token}` } },
      ).pipe(Effect.provideService(Socket.WebSocketConstructor, connection.webSocket));
      const client = yield* RpcClient.make(ClusterLinkRpcs).pipe(
        // No retry inside: this fiber reconnects, so status and backoff stay in one place.
        Effect.provideServiceEffect(
          RpcClient.Protocol,
          RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }),
        ),
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerJson),
      );
      let up = false;
      yield* client[WS_METHODS.clusterHostChannel]({}).pipe(
        Stream.runForEach((event) =>
          event._tag === "ready"
            ? Effect.sync(() => {
                up = true;
              }).pipe(Effect.andThen(recordStatus(memberId, "online", null)))
            : serve(member, event.request).pipe(
                Effect.flatMap((result) =>
                  client[WS_METHODS.clusterHostReply]({
                    requestId: event.request.requestId,
                    result,
                  }),
                ),
                Effect.ignoreCause({ log: true }),
                // Ends with the link: the member already told that call's agent it failed.
                Effect.forkScoped,
              ),
        ),
        Effect.ignore,
      );
      if (!up) return yield* Effect.fail<LinkDown>({ status: "offline", message: NOT_ANSWERING });
    }).pipe(Effect.scoped);

  const runLink = (memberId: EnvironmentId, serve: ClusterHostServe) =>
    linkOnce(memberId, serve).pipe(
      Effect.tapError((down) => recordStatus(memberId, down.status, down.message)),
      Effect.retry(LINK_BACKOFF),
      Effect.andThen(recordStatus(memberId, "offline", LINK_DROPPED)),
      Effect.forever,
    );

  const start: ClusterService["Service"]["start"] = Effect.fn("ClusterService.start")(
    function* (serve) {
      // A status from before this start is stale: only a live link says online.
      yield* sql`UPDATE cluster_members SET status = 'offline' WHERE status = 'online'`.pipe(
        Effect.mapError(storageError),
        Effect.andThen(reload),
        Effect.catch((cause) => Effect.logWarning("Cluster members could not be read", { cause })),
      );
      const links = yield* FiberMap.make<EnvironmentId>();
      // A member's link restarts only when its token, address or pin changes.
      const running = new Map<EnvironmentId, string>();
      // Untraced: it runs on every status change.
      const reconcile = Effect.fnUntraced(function* (
        rows: ReadonlyArray<MemberRow>,
        on: boolean,
      ) {
        const wanted = new Map(
          (on ? rows : []).map(
            (row) =>
              [
                row.environment_id,
                `${row.secret_name} ${row.url ?? row.ssh_target} ${row.cert_sha256}`,
              ] as const,
          ),
        );
        for (const memberId of [...running.keys()]) {
          if (wanted.has(memberId)) continue;
          running.delete(memberId);
          yield* FiberMap.remove(links, memberId);
        }
        for (const [memberId, key] of wanted) {
          if (running.get(memberId) === key) continue;
          running.set(memberId, key);
          yield* FiberMap.run(links, memberId, runLink(memberId, serve));
        }
      });
      yield* Stream.zipLatestWith(
        SubscriptionRef.changes(rowsRef),
        enabledChanges,
        (rows, on) => [rows, on] as const,
      ).pipe(
        Stream.runForEach(([rows, on]) => reconcile(rows, on)),
        Effect.forkScoped,
      );
      // `t3 cluster add` beside a running server writes rows only this rereads.
      yield* reload.pipe(
        Effect.ignore,
        Effect.delay(ROWS_RELOAD_INTERVAL),
        Effect.forever,
        Effect.forkScoped,
      );
    },
  );

  // Member side: the main host's subscription while its link is up.
  let hostChannel: HostChannel | undefined;

  const hostUnreachableHere = readMembership.pipe(
    Effect.map((membership) => clusterHostUnreachable(membership?.host_label ?? "The main host")),
    Effect.orElseSucceed(() => clusterHostUnreachable("The main host")),
  );

  /** Fails every call still waiting on `closing`; none is sent again on a later link. */
  const closeHostChannel = (closing: HostChannel) =>
    Effect.gen(function* () {
      if (hostChannel === closing) hostChannel = undefined;
      const unreachable = yield* hostUnreachableHere;
      for (const reply of closing.pending.values()) yield* Deferred.fail(reply, unreachable);
      closing.pending.clear();
      yield* Queue.end(closing.events);
    });

  const openHostChannel: ClusterService["Service"]["hostChannel"] = (session) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const membership = yield* readMembership;
        if (membership?.host_session_id !== session.sessionId) {
          return yield* new ClusterError({
            reason: "forbidden",
            message: "Only this environment's cluster host can open its host channel.",
          });
        }
        const opened = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const channel: HostChannel = {
              sessionId: session.sessionId,
              events: yield* Queue.unbounded<ClusterHostChannelEvent, Cause.Done>(),
              pending: new Map(),
            };
            const replaced = hostChannel;
            hostChannel = channel;
            if (replaced !== undefined) yield* closeHostChannel(replaced);
            return channel;
          }),
          closeHostChannel,
        );
        return Stream.concat(
          Stream.make({ _tag: "ready" } as const),
          Stream.fromQueue(opened.events),
        );
      }),
    );

  const hostReply: ClusterService["Service"]["hostReply"] = (session, input) =>
    Effect.suspend(() => {
      const channel = hostChannel;
      // A reply for a dropped link, or from any other session, finds nothing to answer.
      const reply =
        channel?.sessionId === session.sessionId ? channel.pending.get(input.requestId) : undefined;
      if (channel === undefined || reply === undefined) return Effect.void;
      channel.pending.delete(input.requestId);
      return Deferred.succeed(reply, input.result).pipe(Effect.asVoid);
    }).pipe(Effect.withSpan("ClusterService.hostReply"));

  const hostCall: ClusterService["Service"]["hostCall"] = Effect.fn("ClusterService.hostCall")(
    function* (call) {
      const channel = hostChannel;
      if (channel === undefined) return yield* yield* hostUnreachableHere;
      const requestId = Hex.encode(yield* random.randomBytes(16));
      const reply = yield* Deferred.make<ClusterHostResult, ClusterError>();
      channel.pending.set(requestId, reply);
      // False once that link has dropped: a call is never queued for a later one.
      const queued = yield* Queue.offer(channel.events, {
        _tag: "request",
        request: { requestId, ...call },
      });
      if (!queued) {
        channel.pending.delete(requestId);
        return yield* yield* hostUnreachableHere;
      }
      return yield* Deferred.await(reply).pipe(
        Effect.ensuring(Effect.sync(() => channel.pending.delete(requestId))),
      );
    },
  );
```

and add `start,`, `hostChannel: openHostChannel,`, `hostReply,` and `hostCall,` to the returned `ClusterService.of({ … })`.

`apps/server/src/ws.ts` — import `* as ClusterService from "./cluster/ClusterService.ts"`; in `layerWsRpc` after line 1556 `const cluster = yield* ClusterService.ClusterService;`; after the `peerLinksAnswerRequest` handler:

```ts
        // The main host's control link; ClusterService refuses every other session.
        [WS_METHODS.clusterHostChannel]: (_input) => cluster.hostChannel(currentSession),
        [WS_METHODS.clusterHostReply]: (input) => cluster.hostReply(currentSession, input),
```

In `layer`, after line 3606 `const cluster = yield* ClusterService.ClusterService;`, and after line 3705:

```ts
              Layer.provide(Layer.succeed(ClusterService.ClusterService, cluster)),
```

`apps/server/src/ws.test.ts` line 845: add `Layer.mock(ClusterService.ClusterService)({}),` (with the import).

`apps/server/src/server.ts`, in `layerMakeRoutes` after the `RemoteDelegation` `Layer.effectDiscard`:

```ts
  // One control link to each member while the server runs; members' agent calls ride it back.
  Layer.effectDiscard(
    ClusterService.ClusterService.pipe(
      Effect.flatMap((cluster) => cluster.start(ClusterService.refuseHostRequests)),
    ),
  ),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/cluster/ClusterService.test.ts apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/ws.test.ts`
Expected: PASS (11 tests in `ClusterService.test.ts`; "declares exactly one scope for every RPC in the server group" stays green).

Run: `vp run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/cluster.ts packages/contracts/src/rpc.ts apps/server/src/auth/RpcAuthorization.ts apps/server/src/cluster/ClusterService.ts apps/server/src/cluster/ClusterService.testkit.ts apps/server/src/cluster/ClusterService.test.ts apps/server/src/ws.ts apps/server/src/ws.test.ts apps/server/src/server.ts
git commit -m "feat(server): main host keeps a control link to each cluster member

Member status comes from the link, and member agents' calls ride it back
through cluster.hostChannel and cluster.hostReply.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Proxy route `/cluster/:memberId/*`

**Files:**

- Create: `apps/server/src/cluster/ClusterProxy.ts`, `apps/server/src/cluster/ClusterProxy.test.ts`
- Modify: `apps/server/src/device/DeviceHubProxy.ts:131-138` (export `pumpFrames`)
- Modify: `apps/server/src/cluster/ClusterService.testkit.ts` (`/echo` socket on members)
- Modify: `apps/server/src/server.ts:853-858` (route)

**Interfaces:**

- Consumes: `ClusterService.connect`, `awaitGone` (Task 7), the member status the control link keeps (Task 8), `start`, `refuseHostRequests` and testkit `awaitStatus` (Task 8); `EnvironmentAuth.authenticateHttpRequest`, `authenticateWebSocketUpgrade`, `issueWebSocketTicket`; `SessionStore.awaitInvalidation`; `failEnvironmentAuthInvalid`, `failEnvironmentInternal` (`auth/http.ts`); `pumpFrames` (`DeviceHubProxy.ts`); `encodeOAuthScope`.
- Produces: `ClusterProxy.layer` (`HttpRouter.add("*", "/cluster/*", …)`); the response contract listed for Plan 3. A client socket is piped only while the member's link is `online`; otherwise the upgrade gets `502` with the link's status. The proxy reads status and never writes it.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/device/DeviceHubProxy.ts` line 131: change `const pumpFrames =` to `export const pumpFrames =`.

`apps/server/src/cluster/ClusterService.testkit.ts` — add `CLUSTER_SCOPES_HEADER` to the `@t3tools/contracts` import and `{ pumpFrames } from "../device/DeviceHubProxy.ts"`, then:

```ts
/** Reports the credential and scope cap the member received, then echoes. */
const layerEcho = HttpRouter.add(
  "GET",
  "/echo",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    const write = yield* socket.writer;
    yield* write(
      JSON.stringify({
        authorization: request.headers.authorization ?? null,
        scopes: request.headers[CLUSTER_SCOPES_HEADER] ?? null,
      }),
    );
    yield* pumpFrames(socket, write);
  }).pipe(Effect.scoped, Effect.ignoreCause, Effect.as(HttpServerResponse.empty())),
);
```

and replace `memberRoutes` with:

```ts
const memberRoutes = (context: ClusterEnvironment["context"]) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(MemberTestApi).pipe(
      Layer.provide(ClusterHttp.layer),
      Layer.provide(AuthHttp.layer),
      Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
    layerLinkSocket,
    layerEcho,
  ).pipe(Layer.provide(Layer.succeedContext(context)));
```

`apps/server/src/cluster/ClusterProxy.test.ts`:

```ts
import {
  type AuthEnvironmentScope,
  AuthStandardClientScopes,
  authScopeResponse,
  CLUSTER_SCOPES_HEADER,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ClusterProxy from "./ClusterProxy.ts";
import * as ClusterService from "./ClusterService.ts";
import {
  awaitStatus,
  type ClusterEnvironment,
  clusterDescriptor,
  makeEnvironment,
  serveMember,
  serveRoutes,
} from "./ClusterService.testkit.ts";

const box = clusterDescriptor("environment-box", "Box");
const studio = clusterDescriptor("environment-studio", "Studio");

const serveMain = Effect.gen(function* () {
  const main = yield* makeEnvironment(studio);
  const url = yield* serveRoutes(
    ClusterProxy.layer.pipe(Layer.provide(Layer.succeedContext(main.context))),
  );
  return { ...main, url };
});

const clientToken = (main: ClusterEnvironment, scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  main.auth.issuePairingCredential({ scopes: [...scopes] }).pipe(
    Effect.flatMap((pairing) =>
      main.auth.exchangeBootstrapCredentialForAccessToken(pairing.credential, undefined, {
        deviceType: "desktop",
      }),
    ),
    Effect.map((exchanged) => exchanged.access_token),
  );

/** A member with its control link up, so the proxy pipes sockets to it. */
const joinCluster = Effect.gen(function* () {
  const member = yield* serveMember(box);
  const main = yield* serveMain;
  const invite = yield* member.cluster.invite({ url: member.url });
  yield* main.cluster.addMember({ target: invite.joinString ?? "" });
  yield* main.cluster.start(ClusterService.refuseHostRequests);
  yield* awaitStatus(main, box.environmentId, "online");
  return { member, main, base: `${main.url}/cluster/${box.environmentId}` };
});

const get = (url: string, token?: string, headers: Record<string, string> = {}) =>
  HttpClient.execute(
    HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders(headers),
      token === undefined ? (request) => request : HttpClientRequest.bearerToken(token),
    ),
  );

it.effect("forwards HTTP to the member under the client's scopes, never the client's header", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { main, base } = yield* joinCluster;
      const reader = yield* clientToken(main, ["orchestration:read"]);
      const session = yield* get(`${base}/api/auth/session`, reader, {
        [CLUSTER_SCOPES_HEADER]: encodeOAuthScope(AuthStandardClientScopes),
      }).pipe(Effect.flatMap((response) => response.json));
      expect(session).toMatchObject({
        authenticated: true,
        ...authScopeResponse(["orchestration:read"]),
      });
      // Clients read the descriptor before they hold credentials.
      expect(
        yield* get(`${base}/.well-known/t3/environment`).pipe(Effect.flatMap((response) => response.json)),
      ).toMatchObject({ environmentId: box.environmentId });
      expect((yield* get(`${base}/api/auth/session`)).status).toBe(401);
      expect(
        yield* get(`${base}/.well-known/t3/environment`, reader).pipe(
          Effect.flatMap((response) => response.json),
        ),
      ).toMatchObject({ environmentId: box.environmentId });
      expect((yield* get(`${main.url}/cluster/environment-nope/api/auth/session`, reader)).status).toBe(404);
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect(
  "forwards a socket to the member with the client's scopes and closes it when the member is removed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { main, base } = yield* joinCluster;
        const operator = yield* clientToken(main, ["orchestration:read", "orchestration:operate"]);
        const ticket = yield* HttpClient.execute(
          HttpClientRequest.post(`${base}/api/auth/websocket-ticket/media`).pipe(
            HttpClientRequest.bearerToken(operator),
          ),
        ).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => (body as { readonly ticket: string }).ticket),
        );
        const socket = yield* Socket.makeWebSocket(
          `${base.replace(/^http/, "ws")}/echo?wsTicket=${ticket}`,
        ).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
        const received = yield* Queue.unbounded<string>();
        const running = yield* socket
          .runRaw((data) =>
            Queue.offer(received, typeof data === "string" ? data : new TextDecoder().decode(data)),
          )
          .pipe(Effect.forkScoped);
        const write = yield* socket.writer;

        const hello = JSON.parse(yield* Queue.take(received)) as {
          readonly authorization: string;
          readonly scopes: string;
        };
        expect(hello.authorization).toMatch(/^Bearer /);
        expect(hello.authorization).not.toContain(ticket);
        expect(hello.scopes).toBe("orchestration:read orchestration:operate");
        yield* write("ping");
        expect(yield* Queue.take(received)).toBe("ping");

        yield* main.cluster.removeMember(box.environmentId);
        yield* Fiber.await(running);
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect("answers 502 for a member that stopped answering", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const memberScope = yield* Scope.make();
      const member = yield* serveMember(box).pipe(Effect.provideService(Scope.Scope, memberScope));
      const main = yield* serveMain;
      const invite = yield* member.cluster.invite({ url: member.url });
      yield* main.cluster.addMember({ target: invite.joinString ?? "" });
      const reader = yield* clientToken(main, ["orchestration:read"]);
      yield* Scope.close(memberScope, Exit.void);

      const response = yield* get(`${main.url}/cluster/${box.environmentId}/api/auth/session`, reader);
      expect(response.status).toBe(502);
      expect(yield* response.json).toEqual({
        code: "cluster_member_unreachable",
        memberId: box.environmentId,
      });
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect("answers 502 revoked after the member leaves, and 403 while the Labs flag is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { member, main, base } = yield* joinCluster;
      const reader = yield* clientToken(main, ["orchestration:read"]);
      yield* member.cluster.leave;
      const revoked = yield* get(`${base}/api/auth/session`, reader);
      expect(revoked.status).toBe(502);
      expect(yield* revoked.json).toEqual({
        code: "cluster_member_revoked",
        memberId: box.environmentId,
      });

      yield* main.settings.updateSettings({ clusterEnabled: false });
      const off = yield* get(`${base}/api/auth/session`, reader);
      expect(off.status).toBe(403);
      expect(yield* off.json).toEqual({ code: "cluster_disabled" });
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run apps/server/src/cluster/ClusterProxy.test.ts`
Expected: FAIL — `Failed to resolve import "./ClusterProxy.ts"`.

- [ ] **Step 3: Implement the proxy**

`apps/server/src/cluster/ClusterProxy.ts`:

```ts
import {
  AuthWebSocketTicketResult,
  CLUSTER_ROUTE_PREFIX,
  CLUSTER_SCOPES_HEADER,
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
import { requestUrl } from "../requestUrl.ts";
import * as ClusterService from "./ClusterService.ts";

const MEMBER_PATH = /^\/cluster\/([^/]+)(\/.*)?$/;
// The proxy answers socket tickets itself: the client then opens the socket with a main-host ticket.
const TICKET_PATH = /^\/api\/auth\/websocket-ticket(?:\/(rpc|media))?$/;

// Client credentials never reach a member; the proxy sends its own and the scope cap.
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  CLUSTER_SCOPES_HEADER,
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "connection",
  "set-cookie",
]);

const encodeTicket = Schema.encodeEffect(AuthWebSocketTicketResult);

const memberFailure = (memberId: EnvironmentId, status: Exclude<ClusterMemberStatus, "online">) =>
  HttpServerResponse.jsonUnsafe(
    {
      code:
        status === "offline"
          ? "cluster_member_unreachable"
          : status === "incompatible"
            ? "cluster_member_incompatible"
            : "cluster_member_revoked",
      memberId,
    },
    { status: 502 },
  );

const forwardPublicDescriptor = (memberId: EnvironmentId, request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const cluster = yield* ClusterService.ClusterService;
    const connected = yield* Effect.result(cluster.connect(memberId));
    if (Result.isFailure(connected)) {
      return connected.failure.reason === "disabled"
        ? HttpServerResponse.jsonUnsafe({ code: "cluster_disabled" }, { status: 403 })
        : connected.failure.reason === "unknown_member"
          ? HttpServerResponse.text("Not Found", { status: 404 })
          : memberFailure(memberId, "offline");
    }
    const { upstream } = connected.success;
    const response = yield* upstream.httpClient
      .execute(
        HttpClientRequest.get(`${upstream.origin}/.well-known/t3/environment`).pipe(
          HttpClientRequest.setHeaders({ accept: request.headers.accept ?? "application/json" }),
        ),
      )
      .pipe(Effect.option);
    if (Option.isNone(response)) return memberFailure(memberId, "offline");
    return HttpServerResponse.jsonUnsafe(yield* response.value.json.pipe(Effect.orDie), {
      status: response.value.status,
    });
  });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  const match = Option.isSome(url) ? MEMBER_PATH.exec(url.value.pathname) : null;
  if (Option.isNone(url) || match === null) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const memberId = EnvironmentId.make(decodeURIComponent(match[1]!));
  const path = match[2] ?? "/";
  const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";

  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  // The descriptor is public on every environment; clients read it before they hold credentials.
  if (!upgrade && request.method === "GET" && path === "/.well-known/t3/environment") {
    return yield* forwardPublicDescriptor(memberId, request);
  }
  const session = yield* (
    upgrade
      ? serverAuth.authenticateWebSocketUpgrade(request, path === "/ws" ? "rpc" : "media")
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

  const ticketUse = request.method === "POST" ? TICKET_PATH.exec(path) : null;
  if (ticketUse !== null) {
    const use = ticketUse[1] === "rpc" || ticketUse[1] === "media" ? ticketUse[1] : undefined;
    const ticket = yield* serverAuth
      .issueWebSocketTicket(session, use === undefined ? undefined : { use })
      .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
    return HttpServerResponse.jsonUnsafe(yield* encodeTicket(ticket).pipe(Effect.orDie));
  }

  const cluster = yield* ClusterService.ClusterService;
  const connected = yield* Effect.result(cluster.connect(memberId));
  if (Result.isFailure(connected)) {
    const { reason } = connected.failure;
    return reason === "disabled"
      ? HttpServerResponse.jsonUnsafe({ code: "cluster_disabled" }, { status: 403 })
      : reason === "unknown_member"
        ? HttpServerResponse.text("Not Found", { status: 404 })
        : memberFailure(memberId, "offline");
  }
  const { upstream, token, member } = connected.success;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!DROPPED_REQUEST_HEADERS.has(name) && value !== undefined) headers[name] = value;
  }
  const credentials = {
    authorization: `Bearer ${token}`,
    [CLUSTER_SCOPES_HEADER]: encodeOAuthScope(session.scopes),
  };
  const search = new URLSearchParams(url.value.search);
  search.delete("wsTicket");
  search.delete("dpop");
  const upstreamUrl = `${upstream.origin}${path}${search.size > 0 ? `?${search}` : ""}`;

  const sessions = yield* SessionStore.SessionStore;
  // A revoked client session or a removed member ends what is in flight.
  const ended = Effect.raceFirst(
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

  const method = request.method;
  if (!HttpMethod.isHttpMethod(method)) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const response = yield* HttpClient.withScope(upstream.httpClient)
    .execute(
      HttpClientRequest.make(method)(upstreamUrl).pipe(
        HttpClientRequest.setHeaders({ ...headers, ...credentials }),
        method === "GET" || method === "HEAD"
          ? (self) => self
          : HttpClientRequest.bodyStream(request.stream, {
              contentType: request.headers["content-type"],
            }),
      ),
    )
    .pipe(Effect.option);
  // Status is the control link's to record; the proxy only answers this request.
  if (Option.isNone(response)) return memberFailure(memberId, "offline");
  if (response.value.status === 401) return memberFailure(memberId, "revoked");
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.value.headers)) {
    if (!DROPPED_RESPONSE_HEADERS.has(name) && value !== undefined) responseHeaders[name] = value;
  }
  return HttpServerResponse.stream(response.value.stream.pipe(Stream.interruptWhen(ended)), {
    status: response.value.status,
    headers: responseHeaders,
    ...(responseHeaders["content-type"] ? { contentType: responseHeaders["content-type"] } : {}),
  });
});

export const layer = HttpRouter.add("*", `${CLUSTER_ROUTE_PREFIX}/*`, handler);
```

`apps/server/src/server.ts` — import `* as ClusterProxy from "./cluster/ClusterProxy.ts"` and add `ClusterProxy.layer,` after `DeviceHubProxy.layer,` in `layerMakeRoutes`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/cluster/ClusterProxy.test.ts apps/server/src/device/DeviceHubProxy.test.ts`
Expected: PASS.

Run: `vp run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/cluster/ClusterProxy.ts apps/server/src/cluster/ClusterProxy.test.ts apps/server/src/cluster/ClusterService.testkit.ts apps/server/src/device/DeviceHubProxy.ts apps/server/src/server.ts
git commit -m "feat(server): proxy /cluster/:memberId to cluster members

Each client socket gets its own upstream socket with the main host's
cluster-host credential and the client's scopes as the cap.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Cluster RPCs, scopes and capability

**Files:**

- Modify: `packages/contracts/src/rpc.ts:20-28` (imports), `WS_METHODS` (after `clusterHostReply`), Rpc definitions (after `ClusterLinkRpcs`), group (after `WsClusterHostReplyRpc`) — all added in Task 8
- Modify: `packages/contracts/src/clientRpcPermissions.ts:83-87` (guarded scopes)
- Modify: `apps/server/src/auth/RpcAuthorization.ts:95` (reads)
- Modify: `apps/server/src/ws.ts:2693-2701` (handlers)
- Modify: `apps/server/src/environment/ServerEnvironment.ts:295-297` (capability)
- Test: `apps/server/src/auth/RpcAuthorization.test.ts` (in `describe("RPC authorization scopes")`, after `:84`)

**Interfaces:**

- Consumes: `ClusterService` (Tasks 6–7), already provided to `ws.ts` by Task 8; contracts from Task 1; `ClusterRpcError` (Task 8).
- Produces: the seven `WS_METHODS.cluster*` RPCs listed for Plan 3; capability `cluster: true`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/auth/RpcAuthorization.test.ts`, inside `describe("RPC authorization scopes", …)` (add `AuthAccessWriteScope` to the contracts import):

```ts
  it("keeps cluster membership changes behind access write and lets readers see members", () => {
    for (const method of [
      WS_METHODS.clusterInvite,
      WS_METHODS.clusterAddMember,
      WS_METHODS.clusterRemoveMember,
      WS_METHODS.clusterRenameMember,
      WS_METHODS.clusterLeave,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthAccessWriteScope);
    }
    for (const method of [WS_METHODS.clusterStatus, WS_METHODS.clusterMembers]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run apps/server/src/auth/RpcAuthorization.test.ts -t "cluster"`
Expected: FAIL — `RPC method undefined has no declared authorization scope.`

- [ ] **Step 3: Implement**

`packages/contracts/src/rpc.ts` — add to the `./cluster.ts` import: `ClusterAddMemberInput, ClusterInvite, ClusterInviteInput, ClusterLeaveResult, ClusterMember, ClusterMemberRef, ClusterRemoveMemberResult, ClusterRenameMemberInput, ClusterStatus`. In `WS_METHODS` after `clusterHostReply`:

```ts
  clusterStatus: "cluster.status",
  clusterMembers: "cluster.members",
  clusterInvite: "cluster.invite",
  clusterAddMember: "cluster.addMember",
  clusterRemoveMember: "cluster.removeMember",
  clusterRenameMember: "cluster.renameMember",
  clusterLeave: "cluster.leave",
```

After `ClusterLinkRpcs`:

```ts
const WsClusterStatusRpc = Rpc.make(WS_METHODS.clusterStatus, {
  payload: Schema.Struct({}),
  success: ClusterStatus,
  error: ClusterRpcError,
});

const WsClusterMembersRpc = Rpc.make(WS_METHODS.clusterMembers, {
  payload: Schema.Struct({}),
  success: Schema.Array(ClusterMember),
  stream: true,
  error: ClusterRpcError,
});

const WsClusterInviteRpc = Rpc.make(WS_METHODS.clusterInvite, {
  payload: ClusterInviteInput,
  success: ClusterInvite,
  error: ClusterRpcError,
});

const WsClusterAddMemberRpc = Rpc.make(WS_METHODS.clusterAddMember, {
  payload: ClusterAddMemberInput,
  success: ClusterMember,
  error: ClusterRpcError,
});

const WsClusterRemoveMemberRpc = Rpc.make(WS_METHODS.clusterRemoveMember, {
  payload: ClusterMemberRef,
  success: ClusterRemoveMemberResult,
  error: ClusterRpcError,
});

const WsClusterRenameMemberRpc = Rpc.make(WS_METHODS.clusterRenameMember, {
  payload: ClusterRenameMemberInput,
  success: ClusterMember,
  error: ClusterRpcError,
});

const WsClusterLeaveRpc = Rpc.make(WS_METHODS.clusterLeave, {
  payload: Schema.Struct({}),
  success: ClusterLeaveResult,
  error: ClusterRpcError,
});
```

and in `WsRpcGroup` after `WsClusterHostReplyRpc,`:

```ts
  WsClusterStatusRpc,
  WsClusterMembersRpc,
  WsClusterInviteRpc,
  WsClusterAddMemberRpc,
  WsClusterRemoveMemberRpc,
  WsClusterRenameMemberRpc,
  WsClusterLeaveRpc,
```

`packages/contracts/src/clientRpcPermissions.ts`, after `peerLinksAnswerRequest`:

```ts
  // Membership hands this environment to another host, or another host's to this one.
  [WS_METHODS.clusterInvite]: AuthAccessWriteScope,
  [WS_METHODS.clusterAddMember]: AuthAccessWriteScope,
  [WS_METHODS.clusterRemoveMember]: AuthAccessWriteScope,
  [WS_METHODS.clusterRenameMember]: AuthAccessWriteScope,
  [WS_METHODS.clusterLeave]: AuthAccessWriteScope,
```

`apps/server/src/auth/RpcAuthorization.ts`, after `[WS_METHODS.peerLinksList]`:

```ts
  // Every client lists members: they are the environments it drives through the main host.
  [WS_METHODS.clusterStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.clusterMembers]: AuthOrchestrationReadScope,
```

`apps/server/src/ws.ts` — after the `clusterHostReply` handler Task 8 added (it uses the same `cluster`):

```ts
        [WS_METHODS.clusterStatus]: (_input) => cluster.status,
        [WS_METHODS.clusterMembers]: (_input) => cluster.members,
        [WS_METHODS.clusterInvite]: (input) => cluster.invite(input),
        [WS_METHODS.clusterAddMember]: (input) => cluster.addMember(input),
        [WS_METHODS.clusterRemoveMember]: ({ memberId }) => cluster.removeMember(memberId),
        [WS_METHODS.clusterRenameMember]: (input) => cluster.renameMember(input),
        [WS_METHODS.clusterLeave]: (_input) => cluster.leave,
```

`apps/server/src/environment/ServerEnvironment.ts`, after `linkFence: true,`:

```ts
      cluster: true,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/ws.test.ts packages/client-runtime/src/state/commandPermissions.test.ts`
Expected: PASS (including "declares exactly one scope for every RPC in the server group").

Run: `vp run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/rpc.ts packages/contracts/src/clientRpcPermissions.ts apps/server/src/auth/RpcAuthorization.ts apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/ws.ts apps/server/src/environment/ServerEnvironment.ts
git commit -m "feat(server): cluster RPCs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: CLI `t3 cluster invite|add|leave|list`

**Files:**

- Create: `apps/server/src/cli/cluster.ts`
- Modify: `apps/server/src/binCli.ts:14` (import), `:89` (subcommand)

**Interfaces:**

- Consumes: `ClusterService` (Tasks 6–7), `authLocationFlags`, `resolveCliAuthConfig` (`cli/config.ts`), `EnvironmentAuth.layerRuntime`.
- Produces: `clusterCommand`; `t3 cluster invite --json` prints `{ credential, fingerprint, joinString, expiresAt }`, which `packages/ssh`'s pairing decoder reads (`credential`) for SSH joins.

No new test: each handler decodes flags and calls one service method (AGENTS.md: no tests for callback wiring). The SSH contract with `credential` is exercised in Task 5's script test and the integrated pass.

- [ ] **Step 1: Write the command**

`apps/server/src/cli/cluster.ts`:

```ts
import {
  type ClusterMember,
  ClusterInvite,
  ClusterMember as ClusterMemberSchema,
  ClusterStatus,
} from "@t3tools/contracts";
import * as SshAuth from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ClusterService from "../cluster/ClusterService.ts";
import * as ClusterUpstream from "../cluster/ClusterUpstream.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerTls from "../tls/ServerTls.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

const layerClusterCli = ClusterService.layer.pipe(
  Layer.provide(
    ClusterUpstream.layer.pipe(
      Layer.provide(SshTunnel.SshEnvironmentManager.layer()),
      Layer.provide(SshAuth.SshPasswordPrompt.disabledLayer),
    ),
  ),
  Layer.provide(PeerLinks.layer),
  Layer.provide(ServerTls.layer),
  Layer.provideMerge(ServerSettings.layer.pipe(Layer.provide(ManagedPolicy.layer))),
  Layer.provideMerge(ServerEnvironment.layer),
  Layer.provideMerge(EnvironmentAuth.layerRuntime),
  Layer.provide(FetchHttpClient.layer),
);

const runWithCluster = Effect.fn("cluster.runWithCluster")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (cluster: ClusterService.ClusterService["Service"]) => Effect.Effect<A, E>,
  options?: { readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  return yield* ClusterService.ClusterService.pipe(
    Effect.flatMap(run),
    Effect.provide(
      layerClusterCli.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const encodeInvite = Schema.encodeSync(ClusterInvite);
const encodeList = Schema.encodeSync(
  Schema.Struct({ status: ClusterStatus, members: Schema.Array(ClusterMemberSchema) }),
);

const formatList = (status: ClusterStatus, members: ReadonlyArray<ClusterMember>) =>
  status.host !== null
    ? `Member of the cluster hosted by ${status.host.label} (${status.host.environmentId}).\n`
    : members.length === 0
      ? "Standalone: this environment has no cluster members.\n"
      : `${members
          .map((member) =>
            [member.label, member.environmentId, member.transport, member.address, member.status, member.lastError ?? ""]
              .join("\t")
              .trimEnd(),
          )
          .join("\n")}\n`;

const inviteCommand = Command.make("invite", {
  ...authLocationFlags,
  url: Flag.String("url").pipe(
    Flag.withDescription(
      "Where the main host reaches this environment, such as https://box.local:3773. Prints a join string.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Mint a one-time code that lets a main host add this environment to its cluster."),
  Command.withHandler((flags) =>
    runWithCluster(
      flags,
      (cluster) =>
        cluster.invite(Option.isSome(flags.url) ? { url: flags.url.value } : {}).pipe(
          Effect.flatMap((invite) => {
            const encoded = encodeInvite(invite);
            return Console.log(
              flags.json
                ? JSON.stringify({
                    credential: encoded.code,
                    fingerprint: encoded.fingerprint,
                    joinString: encoded.joinString,
                    expiresAt: encoded.expiresAt,
                  })
                : invite.joinString !== null
                  ? `Join string (expires ${encoded.expiresAt}):\n${invite.joinString}\n`
                  : `Code: ${invite.code}\nCertificate SHA-256: ${invite.fingerprint}\nPass --url to print a join string.\n`,
            );
          }),
        ),
      { quietLogs: flags.json },
    ),
  ),
);

const addCommand = Command.make("add", {
  ...authLocationFlags,
  target: Argument.String("target").pipe(
    Argument.withDescription("The member's join string, or an ssh target such as ssh://me@box."),
  ),
  label: Flag.String("label").pipe(Flag.withDescription("What to call the member."), Flag.optional),
}).pipe(
  Command.withDescription("Add an environment to this machine's cluster."),
  Command.withHandler((flags) =>
    runWithCluster(flags, (cluster) =>
      cluster
        .addMember({
          target: flags.target,
          ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
        })
        .pipe(
          Effect.flatMap((member) =>
            Console.log(`Added ${member.label} (${member.environmentId}) over ${member.transport}.\n`),
          ),
        ),
    ),
  ),
);

const leaveCommand = Command.make("leave", { ...authLocationFlags }).pipe(
  Command.withDescription("Leave this environment's cluster and become standalone again."),
  Command.withHandler((flags) =>
    runWithCluster(flags, (cluster) =>
      cluster.leave.pipe(
        Effect.flatMap(({ left }) =>
          Console.log(
            left
              ? "Left the cluster. Pair clients with this environment as usual.\n"
              : "This environment is not a member of a cluster.\n",
          ),
        ),
      ),
    ),
  ),
);

const listCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("Show this environment's cluster and its members."),
  Command.withHandler((flags) =>
    runWithCluster(
      flags,
      (cluster) =>
        Effect.gen(function* () {
          const status = yield* cluster.status;
          const members = Option.getOrElse(yield* Stream.runHead(cluster.members), () => []);
          yield* Console.log(
            flags.json ? JSON.stringify(encodeList({ status, members })) : formatList(status, members),
          );
        }),
      { quietLogs: flags.json },
    ),
  ),
);

export const clusterCommand = Command.make("cluster").pipe(
  Command.withDescription("Group environments under one main host."),
  Command.withSubcommands([inviteCommand, addCommand, leaveCommand, listCommand]),
);
```

`apps/server/src/binCli.ts` — `import { clusterCommand } from "./cli/cluster.ts";` and add `clusterCommand,` after `authCommand,` in `Command.withSubcommands`.

- [ ] **Step 2: Typecheck and smoke the help text**

Run: `vp run typecheck`
Expected: no errors. If the checker names a service `layerClusterCli` lacks (for example a `HostProcess` service for `ServerEnvironment.layer`), provide it the way `apps/server/src/server.ts` composes `ServerEnvironment.layer`.

Run: `node apps/server/src/bin.ts cluster --help`
Expected: lists `invite`, `add`, `leave`, `list`.

Run against a throwaway home, never `~/.t3`: `node apps/server/src/bin.ts cluster invite --base-dir "$(mktemp -d)" --url https://box.local:3773`
Expected: `Join string (expires …):` followed by `https://box.local:3773#<12 chars>.<64 hex>`.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/cli/cluster.ts apps/server/src/binCli.ts
git commit -m "feat(server): t3 cluster invite, add, leave and list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: Internal docs

**Files:**

- Modify: `docs/internals/remote.md:148-153`
- Modify: `docs/internals/environment-auth.md` (new subsection after "### MCP clients are a separate audience")

User docs (`docs/user` Cluster section) ship with Plan 3, which adds the Settings → Cluster screens they describe.

- [ ] **Step 1: Rewrite the "does not proxy" statement**

In `docs/internals/remote.md`, replace

```md
The hosted web app stores its connection catalog in the browser and connects
directly to each environment. It does not proxy traffic or hold server-side
pairing state.
```

with

```md
The hosted web app stores its connection catalog in the browser and connects
directly to each environment. It holds no server-side pairing state, and
environments do not proxy for one another, with one exception: a cluster's main
host forwards `/cluster/<memberId>/*` to its members
([ClusterProxy](../../apps/server/src/cluster/ClusterProxy.ts)), so a client
paired only with the main host can drive them without holding member
credentials.
```

- [ ] **Step 2: Document the cluster-host trust boundary**

Append to `docs/internals/environment-auth.md` after the MCP section:

```md
### A cluster member trusts only its main host

A member's one remote client is its main host's `cluster-host` session, minted by
spending a cluster invite ([ClusterService](../../apps/server/src/cluster/ClusterService.ts)).
Invites live under the purpose-bound `mcp-approval:` subject prefix, so ordinary
token exchange, Connections and older servers never spend or show them. Joining
revokes every session that did not come from this machine, every unspent code,
and every peer link; afterwards the member mints only invites and its startup
link, so exclusivity holds without checking addresses per request.

The main host forwards each client request with its own `cluster-host` token and
`x-t3-cluster-scopes` naming the client's scopes. The member intersects the
session with that header, which only narrows, and only for `cluster-host`
sessions; the proxy always overwrites a header the client sent. An unparseable
header grants nothing.

The main host also keeps one `cluster-host` WebSocket to each member, its
control link. The member's status is that link's state, and calls from the
member's agents ride it back (`cluster.hostChannel`, answered by
`cluster.hostReply`), so a member never needs the main host's address or a
credential for it. Only the session the member recorded at join can open that
channel. A call waiting when the link drops fails as "cluster host unreachable"
and is never sent again on a later link.
```

- [ ] **Step 3: Commit**

```bash
git add docs/internals/remote.md docs/internals/environment-auth.md
git commit -m "docs: cluster proxy, cluster-host trust and the control link

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run: `vp test run packages/contracts/src/cluster.test.ts apps/server/src/cluster apps/server/src/auth/EnvironmentAuth.test.ts apps/server/src/auth/McpOAuth.test.ts apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/peer/PeerLinks.test.ts packages/ssh/src/tunnel.test.ts apps/server/src/ws.test.ts apps/server/src/persistence/reconcileV2PreviewMigration.test.ts`
  Expected: PASS.
- [ ] Run: `vp run check:changed`
  Expected: clean (format, lint, knip, typecheck, tests beside changes).
- [ ] The integrated two-server pass in the spec's Testing section (two dev servers, join over HTTPS, drive a member thread with the Replay provider) runs once Plan 3's client route exists; it is not part of this plan.

---

## Self-Review Against the Spec

| Spec item | Where |
| --- | --- |
| Main host proxies `/cluster/<id>/*`, HTTP forward + WS pipe, prefix stripped | Task 9 |
| Per-client upstream socket, no multiplexer | Task 9 (`Socket.makeWebSocket` per upgrade) |
| `cluster-host` credential + scope header, cap once per socket | Task 3 (cap), Task 9 (header) |
| Proxy covers `/ws`, `/api/*`, `/oauth`, static | Task 9 forwards every path; ticket mint answered locally |
| Members fully trust main host; exclusivity enforced by the member | Task 3 (pairing refusal), Task 6 (`keepOnlyHostAndLoopback`) |
| No nesting | Task 6 (join on main host), Task 7 (add on member), tests both |
| Join over HTTPS with pinned fingerprint, join string format | Tasks 1, 5, 7 |
| Join step 3: main host gets a `cluster-host` session (RPC, HTTP, MCP) and opens the control link | Task 3 (session, `cluster: true` on `/mcp`), Tasks 7, 8 (a new row starts its link) |
| Join over SSH with the main host machine's keys or agent, prompts fail clearly, no client involved, forward restored | Tasks 5, 7 (`SshPasswordPrompt.disabledLayer`; `ensureEnvironment` reuses or rebuilds the forward per connect, so each link attempt restores it) |
| Control link: one long-lived WebSocket RPC session per member, over pinned HTTPS or the SSH forward, reconnecting with backoff | Task 8 (`start`, `runLink`, `LINK_BACKOFF`) |
| Status from the link: connected `online`, protocol mismatch `incompatible`, `401` `revoked`, else `offline`; no polling loop | Task 8 (`ready` event, preflight); the proxy only reads it (Task 9) |
| Member→main calls ride the link: `cluster.hostChannel` + `cluster.hostReply(requestId, result)` | Task 8 (contracts, member side, link fiber) |
| Calls queued while the link is down fail "cluster host unreachable", never delivered twice | Task 8 (`hostCall`, `closeHostChannel`), tested |
| Member writes membership, revokes non-loopback sessions and peer links, stops minting ordinary codes | Tasks 3, 6 |
| Leave from main host (remove) and from member | Tasks 6, 7, CLI Task 11 |
| Refusals: peer link create/accept on clustered envs; ordinary pairing on member; add on member; join on main | Tasks 4, 3, 7, 6 |
| Status `online/offline/incompatible/revoked`; 502 unreachable; certificate changed; 401 → revoked; protocol checked per upstream connect | Task 8 (each link connect), Task 9 (502 bodies) |
| `cluster_members` / `cluster_membership` tables | Task 2 (adds `status`; the reconcile lists gain 99) |
| RPCs, guarded `access:write` | Task 10 (the host channel pair in Task 8) |
| Labs `clusterEnabled` gating both sides | Task 1; main side gated in `connect`/`addMember`/proxy and the links, which stop while it is off (Tasks 7, 8, 9) |
| New auth subject `cluster-host` only | Task 3 |
| Capability flag | Tasks 1, 10 |
| CLI `invite|add|leave|list` | Task 11 |
| Docs: `remote.md` exception | Task 12 (`docs/user` moves to Plan 3) |

Resolved ambiguities (each is a deliberate choice an implementer should not re-litigate):

1. **Invite on the member is not Labs-gated server-side**; the flag gates the main side (add, proxy, links) and Plan 3 hides the member UI behind it. Reason: SSH joins mint the invite with the remote's CLI, and a headless member cannot flip its Labs flag. The member side of the host channel is not gated either: membership is the gate.
2. **Re-invite rotates**: a member accepts a join from the host it already belongs to and revokes the old `cluster-host` session. This is the "admin re-invites" path for a changed certificate or address; the new token restarts that member's link.
3. **A main host also drops its outbound peer links on its first member**, and `/mcp` refuses linked clients on any clustered environment (403 with the existing `linked_environments_off` code so older peers degrade the same way).
4. **Upstream 401 is surfaced to the client as `502 cluster_member_revoked`**, not 401, so clients do not discard their own valid main-host credential.
5. **Member list and status RPCs need only `orchestration:read`**: every client must see members to drive them.
6. **`cluster-host` sessions last 10 years** (no renewal channel); leave or removal ends them.
7. **No client answers SSH prompts**: the server uses `SshPasswordPrompt.disabledLayer` everywhere, desktop included.
8. **Join strings accept `http:` only for loopback hosts** (no pin, nothing on the network), which also lets tests run without TLS; the pinned path is tested directly in Task 5.
9. **The link opens the member's ordinary `/ws`** with `?orchestrationProtocol=<v>`, after an HTTP preflight. The preflight is what tells `incompatible` and `revoked` apart, because a WebSocket client cannot read the status of a refused upgrade.
10. **`ready` marks online**, not the socket opening: a member's agent call can only succeed once the member has installed the channel, so status and `hostCall` agree.
11. **A main host restart resets every `online` row to `offline`** before its links start; a revoked member keeps retrying at the 30 s cap until it is removed or re-added.
12. **Proxied sockets need an `online` link**: a member that is up while its link is still reconnecting gets `502` for that moment, and the client retries.

Known limits worth a reviewer's eye: the main host mirrors `cluster_members` in memory and rereads it every 30 s (only rows; status never polls), so a `t3 cluster add` run beside a live server reaches the proxy and gets its link within 30 s; `reload` publishes only when the rows changed, so clients hear no repeats. A call the main host started before its link dropped may still have run on the target although the member's agent heard "unreachable"; Plan 4 keeps `clientRequestId` stable so the agent's retry lands once.
