# Cluster 1: Self-signed HTTPS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every T3 Code server answers HTTPS on its existing port with a self-signed certificate it creates once, exposes that certificate's SHA-256 fingerprint as a service field for the cluster join flow (plan 2), and offers a "Plain HTTP on the network" setting (`allow` | `redirect`) that pushes network clients to HTTPS while loopback and Tailscale stay exempt.

**Architecture:** `serveTlsOnSamePort` replaces `http.Server`'s own `connection` listener with a first-byte router: `0x16` wraps the raw socket in a `tls.TLSSocket` and hands it to the same HTTP connection handler, anything else goes to the handler untouched, so Effect's request and upgrade handlers serve both protocols unchanged. A new `ServerTls` service loads or creates the key and certificate in `ServerSecretStore` at startup and owns the `SecureContext` and fingerprint. A global `HttpRouter` middleware reads `networkPlainHttp` from `ServerSettingsService` and, for plain HTTP from a non-loopback, non-Tailscale socket peer, answers `308` (browser navigation) or `426 {code:"https_required"}` (everything else).

**Tech Stack:** Node `http`/`tls`/`crypto` (`X509Certificate`), npm `selfsigned@5.5.0` (async `generate`, EC P-256), Effect 4 (`Context.Service`, `HttpRouter.middleware`, `@effect/vitest`), React (web), React Native + `gt-react-native` (mobile), GT catalogs.

**Spec:** `docs/superpowers/specs/2026-11-19-environment-cluster-design.md`, section "Self-signed HTTPS" (sub-project 1 of 4).

## Global Constraints

Verbatim from the spec:

- "The listener peeks the first byte of each connection: `0x16` (TLS handshake) goes to the HTTPS server, anything else to the HTTP server. Loopback HTTP, SSH forwards, Tailscale Serve, and the T3 Connect tunnel keep working."
- "Key and certificate are generated once with the `selfsigned` package and stored in `ServerSecretStore`. SANs: hostname, LAN IPs, `localhost`. Regenerated only at expiry."
- "The fingerprint is shown in Settings → Cluster and in `t3 cluster invite`." (Both surfaces belong to plan 2; this plan produces `ServerTls.fingerprint` for them.)
- "Client pairing is unchanged. `peerOrigin` rules are unchanged."
- "Setting "Plain HTTP on the network" (Settings → Connections): `allow` (v1 default) or `redirect to HTTPS`. With `redirect`, non-loopback, non-Tailscale plain HTTP gets `308` to HTTPS for browser navigation and `426 {code:"https_required"}` for WebSocket upgrades and API calls, since WebSocket clients do not follow redirects."
- "Loopback is always exempt (T3 Connect tunnel, Tailscale Serve, SSH forwards, desktop renderer all reach the server over loopback HTTP). Tailscale addresses (`100.x`, `*.ts.net`) are exempt, matching `peerOrigin`."
- "Follow-up, not this project: client pairing pins the certificate ... new installs default to `redirect` while existing installs keep `allow` through a one-time settings migration." (So the default here stays `allow`; no migration.)
- Testing: "TLS sniffing: one port serves TLS and plain HTTP." and "HTTP policy: `redirect` gives `308` for navigation and `426` for WS/API on network HTTP; loopback and Tailscale exempt; `allow` passes through."
- "New strings ship in every web and mobile locale."

Repo rules that bind every task: services use `Effect.fn("Service.op")` for reusable functions; tests at the lowest layer that fails on `main`; extend an existing test before adding one; `it.effect` + `TestClock`, no sleeps or polling; default to no comment; `vp test run <files>`; per-package typecheck only (never `vp run -r typecheck`); run `vp run check:changed` before pushing.

## Review Focus

Five failure modes the spec's tests would not catch, each with its test in the owning task:

1. **ClientHello split across TCP reads (first chunk is one byte).** A router that needs more than one byte, or that drops the byte it read, hangs or corrupts the handshake. Test: Task 3, "routes on a one-byte first chunk and keeps that byte for the chosen server".
2. **IPv6 and IPv4-mapped loopback.** A dual-stack listener reports `::ffff:127.0.0.1`, which `isLocalLoopbackHost` alone does not classify as loopback, so the desktop renderer or cloudflared could get `426` and lock users out. Test: Task 4, `it.each` over `::1`, `::ffff:127.0.0.1`, `::ffff:100.64.0.1`.
3. **`X-Forwarded-*` from the tunnel.** cloudflared and Tailscale Serve connect over loopback but forward `X-Forwarded-For: <public ip>` and `X-Forwarded-Proto: http`; trusting those headers would redirect tunnel traffic, and trusting them the other way would let a LAN client spoof exemption. Test: Task 4, "judges the socket peer, never X-Forwarded-* headers".
4. **SANs drift when a LAN IP changes.** Regenerating on SAN mismatch would change the fingerprint and break every pin plan 2 creates. Test: Task 2, "keeps a valid certificate across restarts even when this host's addresses change".
5. **Secret store holds a missing, corrupt, or mismatched certificate.** A bad blob must be replaced, not crash startup or serve a key that does not match its certificate. Tests: Task 2, "creates and stores a certificate ... on first start" and "replaces a stored certificate that is corrupt or does not match its key".

---

### Task 1: `networkPlainHttp` setting contract with access-scope guard

**Files:**
- Modify: `packages/contracts/src/settings.ts:1134-1135` (add literal schema after `ResponseStreamingMode`), `:1393-1396` (add field after `requireConnectDeviceApproval`), `:1859` (patch field), `:2009` (scope)
- Test: `apps/server/src/auth/RpcAuthorization.test.ts:352-357` (extend existing case)

**Interfaces:**
- Consumes: `requiredScopesForServerSettingsPatch`, `AuthAccessWriteScope` (existing)
- Produces: `NetworkPlainHttp` schema and type `"allow" | "redirect"`; `ServerSettings.networkPlainHttp: NetworkPlainHttp` (decoding default `"allow"`); `ServerSettingsPatch.networkPlainHttp?: NetworkPlainHttp`; writing it requires `access:write`

- [ ] **Step 1: Write the failing test.** In `apps/server/src/auth/RpcAuthorization.test.ts`, in the case "does not let a settings grant manage providers or turn off T3 Connect device approval", directly after the `requireConnectDeviceApproval` expectation (ends line 357), add:

```ts
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: { networkPlainHttp: "allow" },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthAccessWriteScope });
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `vp test run apps/server/src/auth/RpcAuthorization.test.ts -t "device approval"`
Expected: FAIL. The patch decodes without `networkPlainHttp` (unknown key), so the call either fails to decode or reports `requiredPermission: "settings:write"` instead of `access:write`.

- [ ] **Step 3: Implement.** In `packages/contracts/src/settings.ts`:

After line 1135 (`export type ResponseStreamingMode = ...`):

```ts
export const NetworkPlainHttp = Schema.Literals(["allow", "redirect"]);
export type NetworkPlainHttp = typeof NetworkPlainHttp.Type;
```

In `ServerSettings`, after the `requireConnectDeviceApproval` field (line 1396):

```ts
  /** Loopback and Tailscale peers are exempt; see apps/server/src/tls/plainHttpPolicy.ts. */
  networkPlainHttp: NetworkPlainHttp.pipe(
    Schema.withDecodingDefault(Effect.succeed("allow" as const)),
  ),
```

In `ServerSettingsPatch`, after `requireConnectDeviceApproval: Schema.optionalKey(Schema.Boolean),` (line 1859):

```ts
  networkPlainHttp: Schema.optionalKey(NetworkPlainHttp),
```

In `requiredScopesForServerSettingsPatch`, replace line 2009:

```ts
    if (key === "requireConnectDeviceApproval" || key === "networkPlainHttp") {
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `vp test run apps/server/src/auth/RpcAuthorization.test.ts -t "device approval"` then `vp run --filter @t3tools/contracts typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit.**

```bash
git add packages/contracts/src/settings.ts apps/server/src/auth/RpcAuthorization.test.ts
git commit -m "feat(contracts): add plain HTTP on the network setting" -m "Writing it needs access:write, like T3 Connect device approval." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `ServerTls` service (create once, store, reuse, regenerate at expiry)

**Files:**
- Modify: `apps/server/package.json` (dependency via `vp add`), lockfile
- Create: `apps/server/src/tls/ServerTls.ts`
- Test: `apps/server/src/tls/ServerTls.test.ts`

**Interfaces:**
- Consumes: `ServerSecretStore.ServerSecretStore` (`get`, `set`), `DateTime.now`
- Produces:
  - `ServerTls.ServerTls` service: `{ readonly secureContext: NodeTls.SecureContext; readonly fingerprint: string }`, where `fingerprint` is the SHA-256 of the certificate DER as 64 lowercase hex characters, no colons. Plan 2 reads it with `yield* ServerTls.ServerTls` in `ClusterService` (Settings → Cluster) and for `t3 cluster invite` join strings `<url>#<code>.<fingerprint>`.
  - `ServerTls.layer: Layer<ServerTls, SecretStoreError | ServerTlsGenerateError, ServerSecretStore>`
  - `ServerTls.TLS_CERTIFICATE_SECRET = "tls-certificate"` (secret file `tls-certificate.bin`, JSON `{key, cert}` PEMs)
  - `ServerTls.ServerTlsGenerateError`

- [ ] **Step 1: Add the dependency.**

```bash
cd apps/server && vp add selfsigned@5.5.0
```

Confirm `apps/server/package.json` now lists `"selfsigned": "5.5.0"`. Version 5 is async only: `generate(attrs, options): Promise<{ private, public, cert, fingerprint }>`; options used here are `keyType: "ec"`, `algorithm: "sha256"`, `notBeforeDate`, `notAfterDate`, `extensions` (SAN entries `{ type: 2, value }` for DNS, `{ type: 7, ip }` for IPs). Its own `fingerprint` is not SHA-256, so the service computes its own.

- [ ] **Step 2: Write the failing tests.** Create `apps/server/src/tls/ServerTls.test.ts`:

```ts
// Certificates are checked with Node's X.509 parser and made directly with selfsigned.
// @effect-diagnostics nodeBuiltinImport:off
import { X509Certificate } from "node:crypto";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { generate } from "selfsigned";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerTls from "./ServerTls.ts";

const layerSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-tls-test-" })),
  );

// Each yield builds the layer afresh, as a server restart does.
const startServerTls = ServerTls.ServerTls.pipe(Effect.provide(ServerTls.layer));

const storedCertificate = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const bytes = Option.getOrThrow(yield* store.get(ServerTls.TLS_CERTIFICATE_SECRET));
  return JSON.parse(new TextDecoder().decode(bytes)) as { key: string; cert: string };
});

const writeStored = (value: string) =>
  Effect.flatMap(ServerSecretStore.ServerSecretStore, (store) =>
    store.set(ServerTls.TLS_CERTIFICATE_SECRET, new TextEncoder().encode(value)),
  );

const fingerprintOf = (cert: string) =>
  new X509Certificate(cert).fingerprint256.replaceAll(":", "").toLowerCase();

const certificateValidAtEpoch = (commonName: string) =>
  Effect.promise(() =>
    generate([{ name: "commonName", value: commonName }], {
      keyType: "ec",
      algorithm: "sha256",
      notBeforeDate: new Date(0),
      notAfterDate: new Date(Duration.toMillis(Duration.days(400))),
    }),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("ServerTls.layer", (it) => {
  it.effect("creates and stores a certificate for localhost and loopback on first start", () =>
    Effect.gen(function* () {
      const tls = yield* startServerTls;
      const stored = yield* storedCertificate;
      assert.match(tls.fingerprint, /^[0-9a-f]{64}$/);
      assert.strictEqual(tls.fingerprint, fingerprintOf(stored.cert));
      const altNames = new X509Certificate(stored.cert).subjectAltName ?? "";
      assert.include(altNames, "DNS:localhost");
      assert.include(altNames, "IP Address:127.0.0.1");
    }).pipe(Effect.provide(layerSecretStore())),
  );

  it.effect("keeps a valid certificate across restarts even when this host's addresses change", () =>
    Effect.gen(function* () {
      // Signed for localhost only, as if every LAN address changed since it was made.
      const pems = yield* certificateValidAtEpoch("localhost");
      yield* writeStored(JSON.stringify({ key: pems.private, cert: pems.cert }));
      const first = yield* startServerTls;
      yield* TestClock.adjust(Duration.days(30));
      const second = yield* startServerTls;
      assert.strictEqual(first.fingerprint, fingerprintOf(pems.cert));
      assert.strictEqual(second.fingerprint, first.fingerprint);
    }).pipe(Effect.provide(layerSecretStore())),
  );

  it.effect("regenerates the certificate once it expires", () =>
    Effect.gen(function* () {
      const first = yield* startServerTls;
      yield* TestClock.adjust(Duration.days(826));
      const second = yield* startServerTls;
      assert.notStrictEqual(second.fingerprint, first.fingerprint);
      assert.strictEqual(second.fingerprint, fingerprintOf((yield* storedCertificate).cert));
    }).pipe(Effect.provide(layerSecretStore())),
  );

  it.effect("replaces a stored certificate that is corrupt or does not match its key", () =>
    Effect.gen(function* () {
      yield* startServerTls;
      const { key } = yield* storedCertificate;
      const other = yield* certificateValidAtEpoch("other");
      for (const corrupt of [
        "not json",
        JSON.stringify({ key: "garbage", cert: "garbage" }),
        JSON.stringify({ key, cert: other.cert }),
      ]) {
        yield* writeStored(corrupt);
        const replaced = yield* startServerTls;
        assert.notStrictEqual(replaced.fingerprint, fingerprintOf(other.cert));
        assert.strictEqual(replaced.fingerprint, fingerprintOf((yield* storedCertificate).cert));
      }
    }).pipe(Effect.provide(layerSecretStore())),
  );
});
```

- [ ] **Step 3: Run them and watch them fail.**

Run: `vp test run apps/server/src/tls/ServerTls.test.ts`
Expected: FAIL with `Failed to resolve import "./ServerTls.ts"`.

- [ ] **Step 4: Implement.** Create `apps/server/src/tls/ServerTls.ts`:

```ts
// X.509 parsing and TLS secure contexts have no Effect equivalent.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeTls from "node:tls";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { generate } from "selfsigned";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const TLS_CERTIFICATE_SECRET = "tls-certificate";
// Each regeneration breaks pinned clients; 825 days is Apple's cap for TLS server certificates.
const CERTIFICATE_VALIDITY_DAYS = 825;

export class ServerTlsGenerateError extends Schema.TaggedError<ServerTlsGenerateError>()(
  "ServerTlsGenerateError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to generate the server's TLS certificate.";
  }
}

export class ServerTls extends Context.Service<
  ServerTls,
  {
    readonly secureContext: NodeTls.SecureContext;
    /** SHA-256 of the certificate's DER bytes, 64 lowercase hex characters; clients pin it. */
    readonly fingerprint: string;
  }
>()("t3/tls/ServerTls") {}

const StoredCertificate = Schema.fromJsonString(
  Schema.Struct({ key: Schema.String, cert: Schema.String }),
);
type StoredCertificate = typeof StoredCertificate.Type;
const decodeStoredCertificate = Schema.decodeUnknownOption(StoredCertificate);
const encodeStoredCertificate = Schema.encodeSync(StoredCertificate);

const usableCertificate = (
  { key, cert }: StoredCertificate,
  now: DateTime.Utc,
): Option.Option<ServerTls["Service"]> => {
  try {
    const certificate = new NodeCrypto.X509Certificate(cert);
    if (certificate.validToDate.getTime() <= now.epochMilliseconds) return Option.none();
    if (!certificate.checkPrivateKey(NodeCrypto.createPrivateKey(key))) return Option.none();
    return Option.some({
      secureContext: NodeTls.createSecureContext({ key, cert }),
      fingerprint: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
    });
  } catch {
    return Option.none();
  }
};

const subjectAltNames = (hostname: string) => {
  const addresses = Object.values(NodeOS.networkInterfaces()).flatMap((entries) =>
    (entries ?? []).filter((entry) => !entry.internal).map((entry) => entry.address),
  );
  return [
    ...[...new Set(["localhost", hostname])].map((value) => ({ type: 2 as const, value })),
    ...[...new Set(["127.0.0.1", "::1", ...addresses])].map((ip) => ({ type: 7 as const, ip })),
  ];
};

const generateCertificate = Effect.fn("ServerTls.generateCertificate")(function* (
  now: DateTime.Utc,
) {
  const hostname = NodeOS.hostname();
  const pems = yield* Effect.tryPromise({
    try: () =>
      generate([{ name: "commonName", value: hostname }], {
        keyType: "ec",
        algorithm: "sha256",
        notBeforeDate: DateTime.toDate(now),
        notAfterDate: DateTime.toDate(DateTime.add(now, { days: CERTIFICATE_VALIDITY_DAYS })),
        extensions: [
          { name: "basicConstraints", cA: false, critical: true },
          { name: "keyUsage", digitalSignature: true, critical: true },
          { name: "extKeyUsage", serverAuth: true },
          { name: "subjectAltName", altNames: subjectAltNames(hostname) },
        ],
      }),
    catch: (cause) => new ServerTlsGenerateError({ cause }),
  });
  return { key: pems.private, cert: pems.cert };
});

const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const now = yield* DateTime.now;
  const stored = yield* secretStore.get(TLS_CERTIFICATE_SECRET);
  const existing = stored.pipe(
    Option.flatMap((bytes) => decodeStoredCertificate(new TextDecoder().decode(bytes))),
    Option.flatMap((certificate) => usableCertificate(certificate, now)),
  );
  if (Option.isSome(existing)) return ServerTls.of(existing.value);
  if (Option.isSome(stored)) {
    yield* Effect.logWarning("replacing the stored TLS certificate: expired or unreadable");
  }
  const generated = yield* generateCertificate(now);
  yield* secretStore.set(
    TLS_CERTIFICATE_SECRET,
    new TextEncoder().encode(encodeStoredCertificate(generated)),
  );
  return yield* Option.match(usableCertificate(generated, now), {
    onNone: () =>
      Effect.fail(new ServerTlsGenerateError({ cause: "generated certificate did not load" })),
    onSome: (tls) => Effect.succeed(ServerTls.of(tls)),
  });
});

export const layer = Layer.effect(ServerTls, make);
```

- [ ] **Step 5: Run them and watch them pass.**

Run: `vp test run apps/server/src/tls/ServerTls.test.ts` then `vp run --filter t3 typecheck`
Expected: 4 passed; typecheck clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/tls/ServerTls.ts apps/server/src/tls/ServerTls.test.ts
git commit -m "feat(server): create and keep a self-signed TLS certificate" -m "ServerTls stores the key and certificate in the secret store, reuses them until expiry, replaces a corrupt or mismatched pair, and exposes the SHA-256 fingerprint." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: One port serves TLS and plain HTTP

**Files:**
- Create: `apps/server/src/tls/tlsSniff.ts`
- Test: `apps/server/src/tls/tlsSniff.test.ts`
- Modify: `apps/server/src/server.ts:37-41` (imports), `:160` (import neighbor), `:360-400` (`layerHttpServer`)

**Interfaces:**
- Consumes: `ServerTls.ServerTls.secureContext` (Task 2)
- Produces:
  - `routeByFirstByte(socket: NodeNet.Socket, routes: { readonly tls: (socket: NodeNet.Socket) => void; readonly plain: (socket: NodeNet.Socket) => void }): void`
  - `serveTlsOnSamePort<T extends NodeHttp.Server>(server: T, secureContext: NodeTls.SecureContext): T`
  - `ServerTls.ServerTls` in the server application context (`layerHttpServer` provides and merges it), so plan 2 services can `yield* ServerTls.ServerTls`
  - Request sockets for TLS connections are `tls.TLSSocket` with `encrypted === true`; Effect's `originalUrl` then reports `https://`

- [ ] **Step 1: Write the failing tests.** Create `apps/server/src/tls/tlsSniff.test.ts`:

```ts
// Exercise the raw Node listener that splits TLS from plain HTTP on one port.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import { generate } from "selfsigned";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { routeByFirstByte, serveTlsOnSamePort } from "./tlsSniff.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function listen(server: NodeNet.Server): Promise<number> {
  cleanups.push(() => server.close());
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });
}

async function secureContext(): Promise<NodeTls.SecureContext> {
  const pems = await generate([{ name: "commonName", value: "localhost" }], {
    keyType: "ec",
    algorithm: "sha256",
  });
  return NodeTls.createSecureContext({ key: pems.private, cert: pems.cert });
}

function responseText(request: NodeHttp.ClientRequest): Promise<string> {
  cleanups.push(() => request.destroy());
  return new Promise((resolve, reject) => {
    request.on("error", reject);
    request.on("response", (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve(text));
    });
    request.end();
  });
}

describe("serveTlsOnSamePort", () => {
  it("serves plain HTTP and HTTPS on one port through the same handler", async () => {
    const server = serveTlsOnSamePort(
      NodeHttp.createServer((request, response) => {
        response.end((request.socket as NodeTls.TLSSocket).encrypted ? "https" : "http");
      }),
      await secureContext(),
    );
    const port = await listen(server);
    expect(await responseText(NodeHttp.request({ host: "127.0.0.1", port, agent: false }))).toBe(
      "http",
    );
    expect(
      await responseText(
        NodeHttps.request({ host: "127.0.0.1", port, agent: false, rejectUnauthorized: false }),
      ),
    ).toBe("https");
  });

  it("delivers WebSocket upgrades over TLS to the upgrade handler", async () => {
    const server = serveTlsOnSamePort(NodeHttp.createServer(), await secureContext());
    const upgraded = Promise.withResolvers<boolean>();
    server.on("upgrade", (_request, socket) => {
      upgraded.resolve((socket as NodeTls.TLSSocket).encrypted === true);
      socket.destroy();
    });
    const port = await listen(server);
    const request = NodeHttps.request({
      host: "127.0.0.1",
      port,
      agent: false,
      rejectUnauthorized: false,
      headers: { connection: "Upgrade", upgrade: "websocket" },
    });
    request.on("error", () => {});
    request.end();
    cleanups.push(() => request.destroy());
    expect(await upgraded.promise).toBe(true);
  });
});

describe("routeByFirstByte", () => {
  it("routes on a one-byte first chunk and keeps that byte for the chosen server", async () => {
    const routed = Promise.withResolvers<string>();
    const received = Promise.withResolvers<number[]>();
    const collect = (kind: string) => (socket: NodeNet.Socket) => {
      const bytes: number[] = [];
      socket.on("data", (chunk: Buffer) => {
        bytes.push(...chunk);
        if (bytes.length >= 3) received.resolve(bytes);
      });
      routed.resolve(kind);
    };
    const port = await listen(
      NodeNet.createServer((socket) =>
        routeByFirstByte(socket, { tls: collect("tls"), plain: collect("plain") }),
      ),
    );
    const client = NodeNet.connect(port, "127.0.0.1");
    cleanups.push(() => client.destroy());
    client.write(Buffer.from([0x16]));
    expect(await routed.promise).toBe("tls");
    client.write(Buffer.from([0x03, 0x01]));
    expect(await received.promise).toEqual([0x16, 0x03, 0x01]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `vp test run apps/server/src/tls/tlsSniff.test.ts`
Expected: FAIL with `Failed to resolve import "./tlsSniff.ts"`.

- [ ] **Step 3: Implement the router.** Create `apps/server/src/tls/tlsSniff.ts`:

```ts
// The split happens on raw sockets, before Node's HTTP parser or TLS layer sees a byte.
// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

const TLS_HANDSHAKE_RECORD = 0x16;
// http.Server cannot see or close a socket before it is routed, so a silent one must not live on.
const FIRST_BYTE_TIMEOUT_MS = 10_000;

/** Hands `socket` on with its first byte still unread: to `tls` when it opens a TLS handshake. */
export function routeByFirstByte(
  socket: NodeNet.Socket,
  routes: {
    readonly tls: (socket: NodeNet.Socket) => void;
    readonly plain: (socket: NodeNet.Socket) => void;
  },
): void {
  const destroy = () => socket.destroy();
  const route = () => {
    const first: Buffer | null = socket.read(1);
    if (first === null) return;
    socket.off("readable", route);
    socket.off("error", destroy);
    socket.off("timeout", destroy);
    socket.setTimeout(0);
    socket.unshift(first);
    (first[0] === TLS_HANDSHAKE_RECORD ? routes.tls : routes.plain)(socket);
  };
  socket.on("error", destroy);
  socket.on("timeout", destroy);
  socket.setTimeout(FIRST_BYTE_TIMEOUT_MS);
  socket.on("readable", route);
}

/** Serves TLS and plain HTTP on one listener; both reach the server's own request handlers. */
export function serveTlsOnSamePort<T extends NodeHttp.Server>(
  server: T,
  secureContext: NodeTls.SecureContext,
): T {
  // A fresh http.Server has exactly one "connection" listener: its parser setup.
  const serveHttp = server.listeners("connection")[0] as
    | ((socket: NodeNet.Socket) => void)
    | undefined;
  if (serveHttp === undefined || server.listenerCount("connection") !== 1) {
    throw new Error("serveTlsOnSamePort needs a freshly created http.Server.");
  }
  server.off("connection", serveHttp);
  server.on("connection", (socket: NodeNet.Socket) =>
    routeByFirstByte(socket, {
      plain: (plain) => serveHttp.call(server, plain),
      tls: (raw) => {
        const secure = new NodeTls.TLSSocket(raw, { isServer: true, secureContext });
        secure.on("error", () => secure.destroy());
        serveHttp.call(server, secure);
      },
    }),
  );
  return server;
}
```

- [ ] **Step 4: Run the tests and watch them pass.**

Run: `vp test run apps/server/src/tls/tlsSniff.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Wire it into the server listener.** In `apps/server/src/server.ts`:

After the `httpResponseErrorGuard.ts` import (ends line 41), add:

```ts
import { serveTlsOnSamePort } from "./tls/tlsSniff.ts";
```

After `import * as ServerSecretStore from "./auth/ServerSecretStore.ts";` (line 160), add:

```ts
import * as ServerTls from "./tls/ServerTls.ts";
```

In `layerHttpServer` (lines 360-400), read the service before `runSync`, wrap the fresh server first, and provide the service:

```ts
    yield* ManagedLimits.closeTailscaleServeTo(policy, { host: bindHost, port: config.port });
    const tls = yield* ServerTls.ServerTls;
    const runSync = Effect.runSyncWith(yield* Effect.context<never>());
    return NodeHttpServer.layer(
      () => {
        const server = rejectRequestsUntilServing(
          keepIdleConnections(
            guardHttpResponseWriteErrors(
              serveTlsOnSamePort(NodeHttp.createServer(), tls.secureContext),
            ),
          ),
        );
```

and change the trailing pipe from

```ts
).pipe(
  Layer.provide(ManagedPolicy.layer),
```

to

```ts
).pipe(
  Layer.provide(ManagedPolicy.layer),
  Layer.provideMerge(ServerTls.layer.pipe(Layer.provide(ServerSecretStore.layer))),
```

- [ ] **Step 6: Verify.**

Run: `vp run --filter t3 typecheck` then `vp test run apps/server/src/tls apps/server/src/httpResponseErrorGuard.test.ts`
Expected: typecheck clean; all pass.

- [ ] **Step 7: Commit.**

```bash
git add apps/server/src/tls/tlsSniff.ts apps/server/src/tls/tlsSniff.test.ts apps/server/src/server.ts
git commit -m "feat(server): serve HTTPS and HTTP on the same port" -m "The listener routes each connection on its first byte: a TLS handshake gets the self-signed certificate, anything else stays plain HTTP, and both reach the same handlers." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Plain HTTP policy middleware (`308` / `426`, loopback and Tailscale exempt)

**Files:**
- Create: `apps/server/src/tls/plainHttpPolicy.ts`
- Test: `apps/server/src/tls/plainHttpPolicy.test.ts`
- Modify: `apps/server/src/server.ts` (import next to Task 3's; `layerMakeRoutes` pipe at lines 902-908)

**Interfaces:**
- Consumes: `NetworkPlainHttp` (Task 1), `ServerSettings.ServerSettingsService.getSettings`, `isLocalLoopbackHost` / `isTailnetHost` / `isSharedAddressSpaceHost` from `@t3tools/shared/hostClassification`
- Produces:
  - `plainHttpDecision(input: { readonly policy: NetworkPlainHttp; readonly encrypted: boolean; readonly remoteAddress: string | undefined; readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string | undefined>> }): PlainHttpDecision`
  - `type PlainHttpDecision = { readonly _tag: "pass" } | { readonly _tag: "redirect"; readonly location: string } | { readonly _tag: "httpsRequired" }`
  - `layer`: global `HttpRouter` middleware; wire responses `308 Location: https://<host><url>` and `426 {"code":"https_required"}`

- [ ] **Step 1: Write the failing tests.** Create `apps/server/src/tls/plainHttpPolicy.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import { plainHttpDecision } from "./plainHttpPolicy.ts";

const decide = (overrides: Partial<Parameters<typeof plainHttpDecision>[0]> = {}) =>
  plainHttpDecision({
    policy: "redirect",
    encrypted: false,
    remoteAddress: "192.168.1.20",
    method: "GET",
    url: "/threads?view=all",
    headers: { host: "192.168.1.10:3773", accept: "text/html,application/xhtml+xml" },
    ...overrides,
  });

describe("plainHttpDecision", () => {
  it("redirects browser navigation on network HTTP to the same host and path over HTTPS", () => {
    expect(decide()).toEqual({
      _tag: "redirect",
      location: "https://192.168.1.10:3773/threads?view=all",
    });
    expect(decide({ headers: { host: "box.lan:3773", "sec-fetch-mode": "navigate" } })).toEqual({
      _tag: "redirect",
      location: "https://box.lan:3773/threads?view=all",
    });
  });

  it("refuses WebSocket upgrades and API calls with https_required", () => {
    for (const input of [
      {
        url: "/ws",
        headers: { host: "192.168.1.10:3773", upgrade: "websocket", accept: "text/html" },
      },
      { url: "/api/auth/session", headers: { host: "192.168.1.10:3773", accept: "*/*" } },
      { method: "POST", headers: { host: "192.168.1.10:3773", accept: "text/html" } },
      { headers: { accept: "text/html" } },
    ]) {
      expect(decide(input)).toEqual({ _tag: "httpsRequired" });
    }
  });

  it.each([
    "127.0.0.1",
    "127.8.9.10",
    "::1",
    "::ffff:127.0.0.1",
    "100.101.102.103",
    "::ffff:100.64.0.1",
    "fd7a:115c:a1e0::1",
  ])("exempts the loopback or Tailscale peer %s", (remoteAddress) => {
    expect(decide({ remoteAddress })).toEqual({ _tag: "pass" });
  });

  it.each(["192.168.1.20", "::ffff:192.168.1.20", "10.0.0.5", "fe80::1", "203.0.113.9", undefined])(
    "does not exempt the network peer %s",
    (remoteAddress) => {
      expect(decide({ remoteAddress })._tag).toBe("redirect");
    },
  );

  it("judges the socket peer, never X-Forwarded-* headers", () => {
    expect(
      decide({
        remoteAddress: "127.0.0.1",
        headers: {
          host: "t3.example.com",
          accept: "application/json",
          "x-forwarded-for": "203.0.113.9",
          "x-forwarded-proto": "http",
        },
      }),
    ).toEqual({ _tag: "pass" });
    expect(
      decide({
        remoteAddress: "192.168.1.20",
        headers: {
          host: "192.168.1.10:3773",
          accept: "application/json",
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-proto": "https",
        },
      }),
    ).toEqual({ _tag: "httpsRequired" });
  });

  it("passes TLS connections and the allow policy", () => {
    expect(decide({ encrypted: true })).toEqual({ _tag: "pass" });
    expect(decide({ policy: "allow" })).toEqual({ _tag: "pass" });
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `vp test run apps/server/src/tls/plainHttpPolicy.test.ts`
Expected: FAIL with `Failed to resolve import "./plainHttpPolicy.ts"`.

- [ ] **Step 3: Implement.** Create `apps/server/src/tls/plainHttpPolicy.ts`:

```ts
import type { NetworkPlainHttp } from "@t3tools/contracts";
import {
  isLocalLoopbackHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
} from "@t3tools/shared/hostClassification";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";

export type PlainHttpDecision =
  | { readonly _tag: "pass" }
  | { readonly _tag: "redirect"; readonly location: string }
  | { readonly _tag: "httpsRequired" };

// The socket peer, not a header: loopback carries T3 Connect, Tailscale Serve, SSH forwards, and the desktop renderer.
const isExemptPeer = (remoteAddress: string | undefined): boolean => {
  if (remoteAddress === undefined) return false;
  const address = remoteAddress.replace(/^::ffff:/i, "");
  return (
    isLocalLoopbackHost(address) || isTailnetHost(address) || isSharedAddressSpaceHost(address)
  );
};

export const plainHttpDecision = (input: {
  readonly policy: NetworkPlainHttp;
  readonly encrypted: boolean;
  readonly remoteAddress: string | undefined;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}): PlainHttpDecision => {
  if (input.policy === "allow" || input.encrypted || isExemptPeer(input.remoteAddress)) {
    return { _tag: "pass" };
  }
  const { headers } = input;
  const navigation =
    (input.method === "GET" || input.method === "HEAD") &&
    headers.upgrade === undefined &&
    headers.host !== undefined &&
    (headers["sec-fetch-mode"] === "navigate" || (headers.accept ?? "").includes("text/html"));
  return navigation
    ? { _tag: "redirect", location: `https://${headers.host}${input.url}` }
    : { _tag: "httpsRequired" };
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    return HttpRouter.middleware(
      (httpEffect) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
          settings.getSettings.pipe(
            Effect.orDie,
            Effect.flatMap((current) => {
              const socket = (
                request.source as {
                  readonly socket?: { readonly encrypted?: boolean; readonly remoteAddress?: string };
                }
              ).socket;
              const decision = plainHttpDecision({
                policy: current.networkPlainHttp,
                encrypted: socket?.encrypted === true,
                remoteAddress: socket?.remoteAddress,
                method: request.method,
                url: request.url,
                headers: request.headers,
              });
              if (decision._tag === "pass") return httpEffect;
              return Effect.succeed(
                decision._tag === "redirect"
                  ? HttpServerResponse.redirect(decision.location, { status: 308 })
                  : HttpServerResponse.jsonUnsafe({ code: "https_required" }, { status: 426 }),
              );
            }),
          ),
        ),
      { global: true },
    );
  }),
);
```

- [ ] **Step 4: Run the tests and watch them pass.**

Run: `vp test run apps/server/src/tls/plainHttpPolicy.test.ts`
Expected: all passed (5 cases plus 13 `it.each` rows).

- [ ] **Step 5: Wire the middleware.** In `apps/server/src/server.ts`, next to the Task 3 import add:

```ts
import * as PlainHttpPolicy from "./tls/plainHttpPolicy.ts";
```

In the `layerMakeRoutes` pipe, directly before `Layer.provide(layerCommandReadiness),` (line 905), add:

```ts
  Layer.provide(PlainHttpPolicy.layer.pipe(Layer.provide(layerServerSettings))),
```

- [ ] **Step 6: Verify.**

Run: `vp run --filter t3 typecheck` then `vp test run apps/server/src/tls`
Expected: typecheck clean; all pass.

- [ ] **Step 7: Commit.**

```bash
git add apps/server/src/tls/plainHttpPolicy.ts apps/server/src/tls/plainHttpPolicy.test.ts apps/server/src/server.ts
git commit -m "feat(server): optionally move network plain HTTP to HTTPS" -m "With networkPlainHttp set to redirect, browser navigation over network HTTP gets 308 to HTTPS and other requests get 426 https_required. Loopback and Tailscale peers are judged by the socket address and stay exempt." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web toggle in Settings → Sharing & access

**Files:**
- Modify: `apps/web/src/components/settings/settingsSearch.ts:1364-1374` (new search item after `connect-device-approval`)
- Modify: `apps/web/src/components/settings/ConnectionsSettings.tsx:1362-1365` (row between the network access rows and `CloudLinkRow`)
- Modify: `apps/web/src/i18n/translations/*.json` (generated plus translated)

**Interfaces:**
- Consumes: `ServerSettings.networkPlainHttp` via `accessServerConfig.settings` (absent on older servers), `updateAccessSettings` (existing `useUpdateEnvironmentSettings(accessEnvironmentId)`), `canWriteAccess` (existing `AuthAccessWriteScope` check), `Switch` (already imported)
- Produces: settings search id `"network-plain-http"`; desktop gets the same row because it wraps web

This is copy and wiring with no logic beyond a boolean mapping, so it gets no unit test (repo rule: no tests for callback wiring or static markup). Task 8 covers it in the real client.

- [ ] **Step 1: Add the search item.** In `settingsSearch.ts`, after the `connect-device-approval` item (closes line 1374):

```ts
  {
    id: "network-plain-http",
    title: msg("Redirect network HTTP to HTTPS"),
    to: "/settings/access",
    targetId: "connections-environment",
    searchTerms: [msg("https tls certificate self-signed plain http redirect secure lan network")],
  },
```

- [ ] **Step 2: Add the row.** In `ConnectionsSettings.tsx`, replace

```tsx
            ) : canManageLocalBackend ? (
              renderDisabledNetworkAccessRow()
            ) : null}
            {canReadRelay || canManageRelay ? (
```

with

```tsx
            ) : canManageLocalBackend ? (
              renderDisabledNetworkAccessRow()
            ) : null}
            {accessServerConfig?.settings.networkPlainHttp === undefined ? null : (
              <SettingsRow
                {...searchableSetting("network-plain-http")}
                description={gt(
                  "Browsers on your network switch to HTTPS, and apps on your network must use it. This device, Tailscale, and T3 Connect are unaffected.",
                )}
                control={
                  <Switch
                    checked={accessServerConfig.settings.networkPlainHttp === "redirect"}
                    disabled={!canWriteAccess}
                    onCheckedChange={(checked) =>
                      updateAccessSettings({ networkPlainHttp: checked ? "redirect" : "allow" })
                    }
                    aria-label={gt("Redirect network HTTP to HTTPS")}
                  />
                }
              />
            )}
            {canReadRelay || canManageRelay ? (
```

- [ ] **Step 3: Generate the catalog and translate.**

```bash
cd apps/web && vp run i18n:generate && cd ../..
vp run i18n:check
```

Expected: `i18n:check` FAILS listing the new keys missing from `de, es, fr, ja, ko, pt-BR, ru, sv, zh` in `apps/web`.

Fill them with this script (run from the repo root; it fills keys that are missing or still English, matching on the English text):

```bash
node --input-type=module -e '
import fs from "node:fs";
const T = {
  "Redirect network HTTP to HTTPS": {
    de: "Netzwerk-HTTP auf HTTPS umleiten",
    es: "Redirigir HTTP de la red a HTTPS",
    fr: "Rediriger le HTTP du réseau vers HTTPS",
    ja: "ネットワークの HTTP を HTTPS にリダイレクト",
    ko: "네트워크 HTTP를 HTTPS로 리디렉션",
    "pt-BR": "Redirecionar HTTP da rede para HTTPS",
    ru: "Перенаправлять сетевой HTTP на HTTPS",
    sv: "Omdirigera nätverks-HTTP till HTTPS",
    zh: "将网络 HTTP 重定向到 HTTPS",
  },
  "Browsers on your network switch to HTTPS, and apps on your network must use it. This device, Tailscale, and T3 Connect are unaffected.": {
    de: "Browser in deinem Netzwerk wechseln zu HTTPS, und Apps in deinem Netzwerk müssen es verwenden. Dieses Gerät, Tailscale und T3 Connect sind nicht betroffen.",
    es: "Los navegadores de tu red pasan a HTTPS y las apps de tu red deben usarlo. Este dispositivo, Tailscale y T3 Connect no se ven afectados.",
    fr: "Les navigateurs de votre réseau passent en HTTPS et les apps de votre réseau doivent l’utiliser. Cet appareil, Tailscale et T3 Connect ne sont pas concernés.",
    ja: "ネットワーク上のブラウザーは HTTPS に切り替わり、ネットワーク上のアプリは HTTPS を使う必要があります。このデバイス、Tailscale、T3 Connect は影響を受けません。",
    ko: "네트워크의 브라우저는 HTTPS로 전환되고, 네트워크의 앱은 HTTPS를 사용해야 합니다. 이 기기, Tailscale, T3 Connect는 영향을 받지 않습니다.",
    "pt-BR": "Navegadores na sua rede passam a usar HTTPS, e apps na sua rede precisam usá-lo. Este dispositivo, o Tailscale e o T3 Connect não são afetados.",
    ru: "Браузеры в вашей сети переходят на HTTPS, а приложения в вашей сети должны его использовать. Это устройство, Tailscale и T3 Connect не затрагиваются.",
    sv: "Webbläsare i ditt nätverk byter till HTTPS, och appar i ditt nätverk måste använda det. Den här enheten, Tailscale och T3 Connect påverkas inte.",
    zh: "网络中的浏览器会切换到 HTTPS，网络中的应用必须使用 HTTPS。本设备、Tailscale 和 T3 Connect 不受影响。",
  },
  "https tls certificate self-signed plain http redirect secure lan network": {
    de: "https tls zertifikat selbstsigniert http umleiten sicher lan netzwerk",
    es: "https tls certificado autofirmado http redirigir seguro lan red",
    fr: "https tls certificat auto-signé http rediriger sécurisé lan réseau",
    ja: "https tls 証明書 自己署名 http リダイレクト 安全 lan ネットワーク",
    ko: "https tls 인증서 자체 서명 http 리디렉션 보안 lan 네트워크",
    "pt-BR": "https tls certificado autoassinado http redirecionar seguro lan rede",
    ru: "https tls сертификат самоподписанный http перенаправление безопасность lan сеть",
    sv: "https tls certifikat självsignerat http omdirigera säker lan nätverk",
    zh: "https tls 证书 自签名 http 重定向 安全 局域网 网络",
  },
};
for (const app of process.argv.slice(1)) {
  const dir = `${app}/src/i18n/translations`;
  const en = JSON.parse(fs.readFileSync(`${dir}/en.json`, "utf8"));
  for (const locale of ["de", "es", "fr", "ja", "ko", "pt-BR", "ru", "sv", "zh"]) {
    const file = `${dir}/${locale}.json`;
    const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [key, text] of Object.entries(en)) {
      const translated = typeof text === "string" ? T[text]?.[locale] : undefined;
      if (translated !== undefined && (!(key in catalog) || catalog[key] === text)) catalog[key] = translated;
    }
    fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + "\n");
  }
}' apps/web
```

- [ ] **Step 4: Verify.**

Run: `vp run i18n:check` then `vp run check:changed`
Expected: `i18n:check` passes for `apps/web` (mobile still clean, untouched); `check:changed` passes (format, lint including `shadcn/no-restyle` and `no-untranslated-copy`, typecheck of `@t3tools/web`).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/settings/settingsSearch.ts apps/web/src/components/settings/ConnectionsSettings.tsx apps/web/src/i18n/translations
git commit -m "feat(web): toggle redirecting network HTTP to HTTPS" -m "Settings > Sharing & access gets a switch for networkPlainHttp, writable with the access:write grant, in every locale." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Mobile toggle in an environment's details (Settings → Environments)

**Files:**
- Create: `apps/mobile/src/features/connection/NetworkPlainHttpRow.tsx`
- Modify: `apps/mobile/src/features/connection/ConnectionEnvironmentRow.tsx:1-29` (import), `:236-241` (render after the diagnosis block)
- Modify: `apps/mobile/src/i18n/translations/*.json`

**Interfaces:**
- Consumes: `serverEnvironment.configValueAtom(environmentId)` and `serverEnvironment.updateSettings` from `apps/mobile/src/state/server.ts`, `useEnvironmentScope(environmentId, AuthAccessWriteScope)` from `apps/mobile/src/state/session.ts`, `useAtomCommand`, `ListToggleRow`
- Produces: `NetworkPlainHttpRow(props: { readonly environmentId: EnvironmentId })`, hidden when the server does not report the setting

Wiring only; no unit test (same reason as Task 5). The mobile integrated pass happens in Task 8.

- [ ] **Step 1: Create the row.** `apps/mobile/src/features/connection/NetworkPlainHttpRow.tsx`:

```tsx
import { useAtomValue } from "@effect/atom-react";
import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";

import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

export function NetworkPlainHttpRow(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canWriteAccess = useEnvironmentScope(props.environmentId, AuthAccessWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment settings update",
    reportFailure: true,
  });
  const policy = serverConfig?.settings.networkPlainHttp;
  if (policy === undefined) return null;
  return (
    <ListToggleRow
      label={gt("Redirect network HTTP to HTTPS")}
      description={gt(
        "Browsers on your network switch to HTTPS, and apps on your network must use it. This device, Tailscale, and T3 Connect are unaffected.",
      )}
      value={policy === "redirect"}
      disabled={!canWriteAccess}
      onValueChange={(enabled) => {
        void updateSettings({
          environmentId: props.environmentId,
          input: { patch: { networkPlainHttp: enabled ? "redirect" : "allow" } },
        });
      }}
    />
  );
}
```

- [ ] **Step 2: Render it.** In `ConnectionEnvironmentRow.tsx`, add next to the other local imports (after `import { ConnectionStatusDot } from "./ConnectionStatusDot";`):

```tsx
import { NetworkPlainHttpRow } from "./NetworkPlainHttpRow";
```

and replace

```tsx
          {diagnosis ? (
            <ConnectionDiagnosisDetails
              hostLabel={props.environment.environmentLabel}
              diagnosis={diagnosis}
            />
          ) : null}
```

with

```tsx
          {diagnosis ? (
            <ConnectionDiagnosisDetails
              hostLabel={props.environment.environmentLabel}
              diagnosis={diagnosis}
            />
          ) : null}
          <NetworkPlainHttpRow environmentId={props.environment.environmentId} />
```

- [ ] **Step 3: Generate the catalog and translate.**

```bash
cd apps/mobile && vp run i18n:generate && cd ../..
vp run i18n:check
```

Expected: FAILS listing the two new `apps/mobile` keys missing from every non-English locale. Run the Task 5 Step 3 script again with `apps/mobile` as the final argument instead of `apps/web` (same `T` table; the search-terms entry simply finds no match).

- [ ] **Step 4: Verify.**

Run: `vp run i18n:check`, `vp run --filter @t3tools/mobile typecheck`, `vp run check:changed`
Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add apps/mobile/src/features/connection/NetworkPlainHttpRow.tsx apps/mobile/src/features/connection/ConnectionEnvironmentRow.tsx apps/mobile/src/i18n/translations
git commit -m "feat(mobile): toggle redirecting network HTTP to HTTPS" -m "An environment's details in Settings > Environments get the networkPlainHttp switch, writable with the access:write grant, in every locale." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: User docs

**Files:**
- Modify: `docs/user/remote-access.md:127-133` (new subsection before "### Reach one machine several ways")

No other doc becomes inaccurate: `docs/internals/remote.md` describes pairing and `peerOrigin`, both unchanged.

- [ ] **Step 1: Add the section.** Insert after the paragraph ending "another link to share." (line 132):

```markdown

### HTTPS on your network

The server also answers HTTPS on the same port, with a self-signed certificate it
creates on first start. Open `https://<address>:<port>` and accept the browser's
certificate warning once.

To keep other devices on your network off plain HTTP, turn on **Redirect network
HTTP to HTTPS** in **Settings → Sharing & access**, or on mobile in the
environment's details under **Settings → Environments**. Browsers move to HTTPS;
apps and scripts that call the server over plain HTTP get an `https_required`
error. This machine, Tailscale, and T3 Connect are not affected. The desktop and
mobile apps do not accept the self-signed certificate yet, so leave this off while
they connect over your LAN by IP address.
```

- [ ] **Step 2: Verify.** Run `vp run check:changed`. Expected: pass (format).

- [ ] **Step 3: Commit.**

```bash
git add docs/user/remote-access.md
git commit -m "docs: explain HTTPS on the network and the redirect setting" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Integrated runtime check (primary agent only)

Subagents skip this task. It proves the wiring the unit tests cannot: the real listener, the real middleware, and both clients. Do not touch `~/.t3`; use a scratch home and stop only the PID you started.

- [ ] **Step 1: Start a server on the LAN with `redirect`.**

```bash
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/t3-https-check.XXXXXX")"
mkdir -p "$HOME_DIR/userdata"
printf '{"networkPlainHttp":"redirect"}\n' > "$HOME_DIR/userdata/settings.json"
node apps/server/src/bin.ts serve --base-dir "$HOME_DIR" --port 47731 --lan --no-browser
```

Run that last command with the harness's background option and keep its task id. Wait for the listening line in its output.

- [ ] **Step 2: Probe it.** With `LAN_IP` set to this machine's LAN address (`ipconfig getifaddr en0` on macOS, `hostname -I | cut -d" " -f1` on Linux):

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -H "Accept: text/html" "http://$LAN_IP:47731/"
curl -s -w " %{http_code}\n" "http://$LAN_IP:47731/api/auth/session"
curl -s -o /dev/null -w "%{http_code}\n" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "http://$LAN_IP:47731/ws"
curl -sk -o /dev/null -w "%{http_code}\n" "https://$LAN_IP:47731/"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:47731/"
openssl s_client -connect "127.0.0.1:47731" </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256
```

Expected, in order: `308 https://<LAN_IP>:47731/`; `{"code":"https_required"} 426`; `426`; a non-`426`/non-`308` status (the app over TLS); a non-`426`/non-`308` status (loopback exempt); a SHA-256 fingerprint whose hex, lowercased without colons, is stable across a restart of the same `--base-dir`. Restart once to confirm, then stop the background task with the harness's stop.

- [ ] **Step 3: Client pass.** Use `test-t3-app` against a worktree dev server to flip the switch in Settings → Sharing & access (on, off, disabled without `access:write`), and `test-t3-mobile` for the row in an environment's details. Capture before/after screenshots for the PR.

- [ ] **Step 4: Clean up.** `rm -rf "$HOME_DIR"`. Run `vp run check:changed` one last time.

---

## Self-review against the spec section

- First-byte sniff on one port, `0x16` to TLS, everything else to HTTP: Task 3 (`routeByFirstByte`, `serveTlsOnSamePort`, wired into `layerHttpServer`). Loopback HTTP, SSH forwards, Tailscale Serve, and the tunnel are plain HTTP over loopback and take the `plain` route unchanged.
- Generated once with `selfsigned`, stored in `ServerSecretStore`, SANs hostname + LAN IPs + `localhost` (plus `127.0.0.1`, `::1`), regenerated only at expiry: Task 2. Expiry is checked at startup; a corrupt or mismatched pair is also replaced, since serving it is impossible.
- Fingerprint: `ServerTls.fingerprint` (Task 2), in app context via `layerHttpServer` (Task 3). Showing it in Settings → Cluster and `t3 cluster invite` is plan 2's UI and CLI.
- Client pairing and `peerOrigin` unchanged: no task touches pairing or `apps/server/src/peer/PeerLinks.ts`.
- Setting `allow` (default) | `redirect`, `308` for navigation, `426 {code:"https_required"}` for WS and API: Tasks 1 and 4. Default stays `allow`; no migration (follow-up per spec).
- Loopback always exempt, Tailscale (`100.x`, `fd7a:115c:a1e0::/48`) exempt: Task 4 (`*.ts.net` peers arrive from a `100.x` or `fd7a:` socket address, or over loopback through Tailscale Serve).
- UI on web, desktop (via web), and mobile with every locale: Tasks 5 and 6.
- Tests named in the spec: "TLS sniffing: one port serves TLS and plain HTTP" is Task 3's first test; "HTTP policy ..." is Task 4's table.
- Docs: Task 7.

Fixed during review: the policy first checked only `isTailnetHost`, which excludes `100.64.0.0/10`; the spec names `100.x`, so `isSharedAddressSpaceHost` was added and covered with `100.101.102.103` and `::ffff:100.64.0.1`. The first draft paused and resumed the socket after routing, which can emit the unshifted byte before the HTTP parser attaches; `routeByFirstByte` now reads in paused mode through a `readable` listener and never resumes, so the new owner's `data` listener starts the flow.
