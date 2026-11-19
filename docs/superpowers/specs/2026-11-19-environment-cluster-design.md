# Environment cluster design

Date: 2026-11-19. Status: approved design, pending implementation plan.

## Goal

Let several T3 Code environments form a **cluster** under one **main host**.
A client connected only to the main host sees and fully drives every member
(threads, turns, diffs, terminals, previews). Agents on any member can reach
any other member through the main host. Credential brokerage is out of scope:
clients authenticate only to the main host and never receive member
credentials.

Inspiration: ompweb "Remote hosts" (hub-and-spoke, host grouping, offline
members kept visible). Unlike ompweb, the main host always dials the member,
so no long-lived multiplexed link or resend protocol is needed.

## Decisions

- **Main host proxies.** Clients reach members through the main host, never
  directly.
- **Members fully trust the main host.** The main host authenticates clients
  and enforces their scopes; it also caps each upstream socket to the
  originating client's scopes.
- **Dial-in only.** The main host always initiates. Two transports:
  pinned HTTPS with a pairing code, or SSH. Members behind NAT use their
  T3 Connect hostname. Member-initiated dial-out is not built.
- **Self-signed HTTPS ships with this work**, server-wide, on the same port as
  plain HTTP.
- **Cluster is separate from peer links.** Any clustered environment (main
  host or member) takes no part in peer links in either direction.
- **Exclusivity is enforced by the member's server.** A member accepts only
  its cluster link and loopback sessions.
- **No nesting.** A member cannot add members; a main host cannot join
  another cluster.

## Forwarding

- The main host serves `/cluster/<memberEnvironmentId>/*`. It authenticates
  the client normally, then forwards HTTP requests and pipes WebSocket
  upgrades to the member's same path without the prefix.
- Each client socket gets its own upstream socket, opened on demand. No
  multiplexer.
- Upstream requests carry the main host's `cluster-host` credential plus a
  header with the originating client's scopes. The member caps that session
  to those scopes, once per socket.
- The proxy covers the whole client surface: `/ws`, `/api/*`
  (preview stream, devices WS, speech, observability), `/oauth`, static
  assets.

## Clients

- New connection route `Cluster { hostEnvironmentId, memberId }` whose base
  URL is `<main-url>/cluster/<memberId>`, in `packages/client-runtime`.
- The main host publishes members and statuses through a `cluster.members`
  subscription. Clients add members to the registry ephemerally (not saved
  in the catalog) and drop them when they leave the list.
- The existing connection runtime handles drivers, reconnects, and
  capability checks for member environments. Web, desktop, and mobile share
  this.

## Agents

- On the main host, MCP tools with an `environmentId` target forward to the
  member's `/mcp` using the `cluster-host` credential.
- Each member receives a `cluster-member` MCP credential for the main host
  at join time. A member agent targeting another member calls the main
  host's `/mcp`, which forwards. All cross-member traffic hairpins through
  the main host.
- The existing forwarded-wait limits (≤ 50 s) apply.

## Membership and storage

Main host table `cluster_members`:

| column | notes |
| --- | --- |
| `environment_id` | PK, the member's id |
| `label` | editable |
| `transport` | `https` or `ssh` |
| `url` / `ssh_target` | one per transport |
| `cert_sha256` | https only, pinned |
| `secret_name` | member token in `ServerSecretStore` |
| `joined_at`, `last_reached_at`, `last_error` | status |

Member table `cluster_membership`: one row with the main host's
`environment_id`, label, and `joined_at`. Its presence means "is a member".
Rows in `cluster_members` mean "is a main host".

### Join over HTTPS

1. On the member, Settings → Cluster → "Invite to cluster" (or
   `t3 cluster invite`) mints a `cluster-member` pairing code and shows the
   join string `<url>#<code>.<sha256>`.
2. On the main host, Settings → Cluster → Add member (or
   `t3 cluster add <join-string>`) dials the URL with TLS pinned to the
   fingerprint and exchanges the code.
3. The main host receives a `cluster-host` session (accepted on RPC, HTTP,
   and MCP) and the member's environment id, then hands the member a
   `cluster-member` MCP token for itself.
4. The member writes its membership row, revokes all non-loopback client
   sessions and peer links, and stops minting ordinary pairing codes.

### Join over SSH

- Add member with `user@host` (or `t3 cluster add ssh://user@host`). The main
  host uses `packages/ssh` (`launchOrReuseRemoteServer`) to start or reuse T3
  on the member, mints the code over SSH, and exchanges it through the
  loopback forward. No join string or fingerprint.
- Headless main hosts need SSH keys or an agent; a password prompt fails
  with a clear error. Desktop main handles prompts as today.
- The main host restores the forward before reconnecting, as the existing
  SSH tunnel logic does.

### Leave

- From the main host: Remove member revokes its token at the member and
  deletes the row; the member clears its membership.
- From the member: "Leave cluster" (or `t3 cluster leave`) revokes the
  `cluster-host` session and clears the row.
- Either way the member becomes a normal standalone environment; users pair
  with it again as usual.

### Refusals

Each refusal returns a clear error naming the cluster:

- peer link create or accept on any clustered environment
- ordinary pairing codes on a member
- add member on a member
- join on a main host

## Self-signed HTTPS

- The listener peeks the first byte of each connection: `0x16` (TLS
  handshake) goes to the HTTPS server, anything else to the HTTP server.
  Loopback HTTP, SSH forwards, Tailscale Serve, and the T3 Connect tunnel
  keep working.
- Key and certificate are generated once with the `selfsigned` package and
  stored in `ServerSecretStore`. SANs: hostname, LAN IPs, `localhost`.
  Regenerated only at expiry.
- The fingerprint is shown in Settings → Cluster and in
  `t3 cluster invite`.
- Client pairing is unchanged. `peerOrigin` rules are unchanged.
- Setting "Plain HTTP on the network" (Settings → Connections):
  `allow` (v1 default) or `redirect to HTTPS`. With `redirect`, non-loopback,
  non-Tailscale plain HTTP gets `308` to HTTPS for browser navigation and
  `426 {code:"https_required"}` for WebSocket upgrades and API calls, since
  WebSocket clients do not follow redirects.
- Loopback is always exempt (T3 Connect tunnel, Tailscale Serve, SSH
  forwards, desktop renderer all reach the server over loopback HTTP).
  Tailscale addresses (`100.x`, `*.ts.net`) are exempt, matching
  `peerOrigin`.
- Flipping the default to `redirect` is a follow-up, once client pairing pins
  certificates.

## Server structure

- `apps/server/src/cluster/ClusterService.ts`: join, leave, list, status,
  refusals. RPC handlers, MCP tools, and CLI commands stay thin and call it.
- Proxy route in `apps/server/src/cluster/`.
- Contracts in `packages/contracts/src/cluster.ts`; new RPCs added to
  `CLIENT_GUARDED_RPC_SCOPES` (`access:write` for add/remove/invite/leave).
- Labs setting `clusterEnabled`, default false, gating both sides.
- New auth subjects: `cluster-host` (member side) and `cluster-member` (MCP
  on the main host).

## UI

- Settings → Cluster on web, desktop, and mobile, behind the Labs flag.
  - Standalone: Invite to cluster, Add member.
  - Main host: member list (label, transport, status dot, last seen, last
    error), rename, remove.
  - Member: main host name, Leave cluster.
  - Mobile adds members by join string only; SSH needs desktop or a
    headless main host.
- Members appear as ordinary environments labeled "via <main host>".
  Offline members stay listed, dimmed, with the reason.
- Peer link screens on clustered environments show
  "Managed by cluster <name>" instead of controls.
- New strings ship in every web and mobile locale.

## Status and errors

Member status: `online | offline | incompatible | revoked`.

| case | behavior |
| --- | --- |
| member unreachable | proxy `502 {code:"cluster_member_unreachable", memberId}`; client treats as disconnect and retries; member shown offline |
| fingerprint mismatch | hard fail "certificate changed", no fallback; admin re-invites |
| member revoked main host | upstream `401`; member marked `revoked`; row kept until admin removes it |
| protocol version mismatch | checked per upstream connect; member shown `incompatible` |
| main host down | clients lose all members; member agents get "cluster host unreachable" on cross-member tools; local work continues |
| SSH failure | existing `packages/ssh` errors surfaced as is |

## Testing

At the lowest layer that fails on `main`:

- ClusterService: join/leave state machine, revocation on join, all refusals,
  standalone restore after leave.
- Auth: `cluster-host` accepted on RPC, HTTP, and MCP; per-socket scope cap;
  ordinary pairing refused on members. Extend the existing permission
  behavior tests.
- Proxy: HTTP and WS upgrade forwarding to a fake member, `502` when
  unreachable, pinned-cert mismatch refused.
- TLS sniffing: one port serves TLS and plain HTTP.
- HTTP policy: `redirect` gives `308` for navigation and `426` for WS/API on
  network HTTP; loopback and Tailscale exempt; `allow` passes through.
- Client runtime: `cluster.members` adds and removes registry entries;
  `Cluster` route resolves its URL.
- One integrated pass: two dev servers in separate worktree `.t3` homes,
  join over HTTPS, drive a member thread from the main host's web client
  with the Replay provider, leave, confirm the member is standalone.

## Docs

- `docs/user`: Cluster section (what it is, invite, SSH add, leave).
- `docs/internals/remote.md`: rewrite the "does not proxy" statement to name
  the cluster proxy as the one exception and why.

## Out of scope

- Credential brokerage to clients.
- Member dial-out to the main host.
- Peer links involving clustered environments, nested clusters, linking a
  main host to other environments.
- Per-RPC routing or inspection on the main host.
