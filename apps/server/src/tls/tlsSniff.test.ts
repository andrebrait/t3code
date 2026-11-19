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
