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
  // http.Server does not track a socket before it is routed, so close() would wait out its timeout.
  const unrouted = new Set<NodeNet.Socket>();
  const closeIdleConnections = server.closeIdleConnections.bind(server);
  server.closeIdleConnections = () => {
    for (const socket of unrouted) socket.destroy();
    closeIdleConnections();
  };
  server.on("connection", (socket: NodeNet.Socket) => {
    unrouted.add(socket);
    socket.once("close", () => unrouted.delete(socket));
    routeByFirstByte(socket, {
      plain: (plain) => {
        unrouted.delete(plain);
        serveHttp.call(server, plain);
      },
      tls: (raw) => {
        unrouted.delete(raw);
        const secure = new NodeTls.TLSSocket(raw, { isServer: true, secureContext });
        secure.on("error", () => secure.destroy());
        serveHttp.call(server, secure);
      },
    });
  });
  return server;
}
