// X.509 parsing and TLS secure contexts have no Effect equivalent.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeTls from "node:tls";

import { normalizeCertificateFingerprint } from "@t3tools/contracts";
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
      fingerprint: normalizeCertificateFingerprint(certificate.fingerprint256),
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
