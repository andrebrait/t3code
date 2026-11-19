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
  (
    undici: typeof Undici,
    pin: string,
    connectTimeoutMs: number,
    ca: NodeTls.ConnectionOptions["ca"],
  ): Undici.buildConnector.connector =>
  (options, callback) => {
    let settled = false;
    const host = options.hostname.replace(/^\[(.*)\]$/, "$1");
    const socket = NodeTls.connect({
      host,
      port: Number(options.port) || 443,
      ...(NodeNet.isIP(host) === 0 ? { servername: options.servername ?? host } : {}),
      // Members are self-signed by design; below, the pin or a CA-valid chain is the trust decision.
      rejectUnauthorized: false,
      ...(ca === undefined ? {} : { ca }),
      ALPNProtocols: ["http/1.1"],
    });
    // undici applies its connect timeout only inside its own connector.
    socket.setTimeout(connectTimeoutMs, () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(new undici.errors.ConnectTimeoutError(), null);
    });
    socket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      // Typed as string, but absent when the peer sent no certificate.
      const raw: string | undefined = socket.getPeerCertificate().fingerprint256;
      const presented = raw === undefined ? null : normalizeCertificateFingerprint(raw);
      // `authorized` already covers the hostname check, so a CA-issued certificate passes whatever the pin.
      if (socket.authorized || (presented !== null && presented === pin)) {
        return callback(null, socket);
      }
      socket.destroy();
      callback(
        Object.assign(
          new Error(
            `The member's certificate changed: it presented ${presented ?? "none"}, not the pinned one. Invite the member again.`,
          ),
          { code: PIN_MISMATCH },
        ),
        null,
      );
    });
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      callback(error, null);
    });
  };

/** One connection pool to members; with a pin, nothing is sent until the certificate matches it or chains to a trusted CA. */
export const makeAgent = Effect.fn("pinnedTransport.makeAgent")(function* (
  pin: string | null,
  connectTimeoutMs = 10_000,
  ca?: NodeTls.ConnectionOptions["ca"],
) {
  const undici = requireUndici("undici") as typeof Undici;
  const dispatcher = yield* Effect.acquireRelease(
    Effect.sync(() =>
      pin === null
        ? new undici.Agent()
        : new undici.Agent({
            connect: pinnedConnector(
              undici,
              normalizeCertificateFingerprint(pin),
              connectTimeoutMs,
              ca,
            ),
          }),
    ),
    (agent) => Effect.promise(() => agent.destroy()),
  );
  const httpClient = yield* NodeHttpClient.makeUndici.pipe(
    Effect.provideService(NodeHttpClient.Dispatcher, dispatcher),
  );
  const webSocket: Socket.WebSocketConstructor["Service"] = (url, options) => {
    const { protocols, headers } =
      options === undefined || typeof options === "string" || Array.isArray(options)
        ? { protocols: options, headers: undefined }
        : options;
    const init = {
      dispatcher,
      ...(protocols === undefined ? {} : { protocols }),
      ...(headers === undefined ? {} : { headers }),
    };
    return new undici.WebSocket(url, init) as unknown as globalThis.WebSocket;
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
