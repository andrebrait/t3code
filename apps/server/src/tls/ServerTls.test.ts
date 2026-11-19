// Certificates are checked with Node's X.509 parser and made directly with selfsigned.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
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
  new NodeCrypto.X509Certificate(cert).fingerprint256.replaceAll(":", "").toLowerCase();

const certificateValidAtEpoch = (commonName: string) =>
  Effect.promise(() =>
    generate([{ name: "commonName", value: commonName }], {
      keyType: "ec",
      algorithm: "sha256",
      notBeforeDate: DateTime.toDate(DateTime.makeUnsafe(0)),
      notAfterDate: DateTime.toDate(DateTime.makeUnsafe(Duration.toMillis(Duration.days(400)))),
    }),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCryptoLayer.layer))("ServerTls.layer", (it) => {
  it.effect("creates and stores a certificate for localhost and loopback on first start", () =>
    Effect.gen(function* () {
      const tls = yield* startServerTls;
      const stored = yield* storedCertificate;
      assert.match(tls.fingerprint, /^[0-9a-f]{64}$/);
      assert.strictEqual(tls.fingerprint, fingerprintOf(stored.cert));
      const altNames = new NodeCrypto.X509Certificate(stored.cert).subjectAltName ?? "";
      assert.include(altNames, "DNS:localhost");
      assert.include(altNames, "IP Address:127.0.0.1");
    }).pipe(Effect.provide(layerSecretStore())),
  );

  it.effect(
    "keeps a valid certificate across restarts even when this host's addresses change",
    () =>
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
