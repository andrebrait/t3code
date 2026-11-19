// @effect-diagnostics nodeBuiltinImport:off - A real TLS listener with the peer fixtures' certificate.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeUtil from "node:util";

import { normalizeCertificateFingerprint } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClientRequest } from "effect/http";

import * as PinnedTransport from "./pinnedTransport.ts";

const cert = NodeFS.readFileSync(new URL("../peer/fixtures/localhost-cert.pem", import.meta.url));
const key = NodeFS.readFileSync(new URL("../peer/fixtures/localhost-key.pem", import.meta.url));
const pin = normalizeCertificateFingerprint(new NodeCrypto.X509Certificate(cert).fingerprint256);

const serveTls = Effect.acquireRelease(
  Effect.callback<{
    readonly origin: string;
    readonly seen: Array<string>;
    readonly received: { bytes: number };
    readonly upgrades: Array<string>;
    readonly server: NodeHttps.Server;
  }>((resume) => {
    const seen: Array<string> = [];
    const received = { bytes: 0 };
    const upgrades: Array<string> = [];
    const server = NodeHttps.createServer({ key, cert }, (request, response) => {
      seen.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
      response.end("ok");
    });
    server.on("secureConnection", (socket) =>
      socket.on("data", (chunk: Buffer) => (received.bytes += chunk.length)),
    );
    server.on("upgrade", (request, socket) => {
      upgrades.push(request.url ?? "");
      socket.destroy();
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      resume(
        Effect.succeed({ origin: `https://127.0.0.1:${port}`, seen, received, upgrades, server }),
      );
    });
  }),
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
      const bytesBeforeMismatch = tls.received.bytes;

      const wrong = yield* PinnedTransport.makeAgent("0".repeat(64));
      const refused = yield* wrong.httpClient
        .execute(
          HttpClientRequest.get(`${tls.origin}/leak`).pipe(HttpClientRequest.bearerToken("secret")),
        )
        .pipe(Effect.flip);
      expect(PinnedTransport.isPinMismatch(refused)).toBe(true);
      expect(NodeUtil.inspect(refused, { depth: 10 })).toContain(
        "The member's certificate changed",
      );

      const socket = wrong.webSocket(`${tls.origin.replace("https:", "wss:")}/ws`);
      yield* Effect.callback<void>((resume) => {
        socket.addEventListener("close", () => resume(Effect.void));
      });
      expect(tls.upgrades).toEqual([]);
      expect(tls.seen).toEqual(["GET /hello Bearer secret"]);
      expect(tls.received.bytes).toBe(bytesBeforeMismatch);
    }),
  ),
);

const serveSilentTcp = Effect.acquireRelease(
  Effect.callback<{
    readonly origin: string;
    readonly server: NodeNet.Server;
    readonly sockets: Set<NodeNet.Socket>;
  }>((resume) => {
    const sockets = new Set<NodeNet.Socket>();
    const server = NodeNet.createServer((socket) => void sockets.add(socket));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      resume(Effect.succeed({ origin: `https://127.0.0.1:${port}`, server, sockets }));
    });
  }),
  ({ server, sockets }) =>
    Effect.callback<void>((resume) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resume(Effect.void));
    }),
);

it.live("gives up on a member that never answers the TLS handshake", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const silent = yield* serveSilentTcp;
      const pinned = yield* PinnedTransport.makeAgent(pin, 1);
      const error = yield* pinned.httpClient
        .execute(HttpClientRequest.get(`${silent.origin}/hello`))
        .pipe(Effect.flip);
      expect(NodeUtil.inspect(error, { depth: 10 })).toContain("UND_ERR_CONNECT_TIMEOUT");
      expect(PinnedTransport.isPinMismatch(error)).toBe(false);
    }),
  ),
);
