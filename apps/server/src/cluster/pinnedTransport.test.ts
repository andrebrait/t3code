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
  Effect.callback<{
    readonly origin: string;
    readonly seen: Array<string>;
    readonly received: { bytes: number };
    readonly server: NodeHttps.Server;
  }>((resume) => {
    const seen: Array<string> = [];
    const received = { bytes: 0 };
    const server = NodeHttps.createServer({ key, cert }, (request, response) => {
      seen.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
      response.end("ok");
    });
    server.on("secureConnection", (socket) =>
      socket.on("data", (chunk: Buffer) => (received.bytes += chunk.length)),
    );
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      resume(Effect.succeed({ origin: `https://127.0.0.1:${port}`, seen, received, server }));
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
      expect(tls.seen).toEqual(["GET /hello Bearer secret"]);
      expect(tls.received.bytes).toBe(bytesBeforeMismatch);
    }),
  ),
);
