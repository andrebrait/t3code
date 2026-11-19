// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it as effectIt } from "@effect/vitest";
import { ServerSettingsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";
import { generate } from "selfsigned";
import { describe, expect, it } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import { layer, plainHttpDecision } from "./plainHttpPolicy.ts";
import { serveTlsOnSamePort } from "./tlsSniff.ts";

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
      { headers: { host: "evil.com/\r\nx: y", accept: "text/html" } },
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

describe("plainHttpPolicy layer", () => {
  const app = Layer.mergeAll(
    HttpRouter.add("GET", "/x", Effect.succeed(HttpServerResponse.text("ok"))),
    layer,
  );

  const handle = (
    settings: Layer.Layer<ServerSettings.ServerSettingsService, ServerSettingsError>,
    socket: { readonly encrypted?: boolean; readonly remoteAddress?: string },
  ) =>
    Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(app);
      // The middleware reads only these fields of the Node request.
      const request = {
        source: { socket },
        method: "GET",
        url: "/x",
        headers: { host: "192.168.1.10:3773", accept: "text/html" },
      } as unknown as HttpServerRequest.HttpServerRequest;
      const response = yield* handler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      );
      return response.status;
    }).pipe(Effect.scoped, Effect.provide(settings));

  const redirect = ServerSettings.ServerSettingsService.layerTest({ networkPlainHttp: "redirect" });
  const unreadable = Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.map(ServerSettings.ServerSettingsService, (service) => ({
      ...service,
      getSettings: Effect.fail(
        new ServerSettingsError({ settingsPath: "<memory>", operation: "read-file" }),
      ),
    })),
  ).pipe(Layer.provide(redirect));

  effectIt.effect("answers a network plain peer with 308 and an exempt or TLS peer with 200", () =>
    Effect.gen(function* () {
      expect(yield* handle(redirect, { remoteAddress: "192.168.1.20" })).toBe(308);
      expect(yield* handle(redirect, { remoteAddress: "127.0.0.1" })).toBe(200);
      expect(yield* handle(redirect, { remoteAddress: "192.168.1.20", encrypted: true })).toBe(200);
    }),
  );

  effectIt.effect("keeps serving when settings cannot be read", () =>
    Effect.gen(function* () {
      expect(yield* handle(unreadable, { remoteAddress: "192.168.1.20" })).toBe(200);
      expect(yield* handle(unreadable, { remoteAddress: "127.0.0.1" })).toBe(200);
    }),
  );

  effectIt.live("passes loopback plain HTTP and TLS through a real server", () =>
    Effect.gen(function* () {
      const pems = yield* Effect.promise(() =>
        generate([{ name: "commonName", value: "localhost" }], {
          keyType: "ec",
          algorithm: "sha256",
        }),
      );
      const context = NodeTls.createSecureContext({ key: pems.private, cert: pems.cert });
      const server = yield* Layer.build(
        HttpRouter.serve(app, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(() => serveTlsOnSamePort(NodeHttp.createServer(), context), {
              host: "127.0.0.1",
              port: 0,
            }),
          ),
          Layer.provide(redirect),
        ),
      ).pipe(Effect.map(Context.get(HttpServer.HttpServer)));
      const { port } = server.address as { readonly port: number };
      const status = (protocol: "http" | "https") =>
        Effect.promise(
          () =>
            new Promise<number | undefined>((resolve, reject) => {
              const request = (protocol === "http" ? NodeHttp : NodeHttps).request(
                { host: "127.0.0.1", port, agent: false, rejectUnauthorized: false, path: "/x" },
                (response) => {
                  response.resume();
                  resolve(response.statusCode);
                },
              );
              request.on("error", reject);
              request.end();
            }),
        );
      expect(yield* status("http")).toBe(200);
      expect(yield* status("https")).toBe(200);
    }).pipe(Effect.scoped),
  );
});
