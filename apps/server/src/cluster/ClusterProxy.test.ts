// @effect-diagnostics nodeBuiltinImport:off - A real TLS listener stands in for a re-keyed member.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";

import {
  type AuthGrantScope,
  AuthStandardClientScopes,
  authScopeResponse,
  CLUSTER_SCOPES_HEADER,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ClusterProxy from "./ClusterProxy.ts";
import * as ClusterService from "./ClusterService.ts";
import {
  awaitStatus,
  type ClusterEnvironment,
  clusterDescriptor,
  FINGERPRINT,
  makeEnvironment,
  serveMember,
  serveRoutes,
} from "./ClusterService.testkit.ts";

const box = clusterDescriptor("environment-box", "Box");
const studio = clusterDescriptor("environment-studio", "Studio");

const serveMain = Effect.gen(function* () {
  const main = yield* makeEnvironment(studio);
  const url = yield* serveRoutes(ClusterProxy.layer).pipe(Effect.provideContext(main.context));
  return { ...main, url };
});

const clientToken = (main: ClusterEnvironment, scopes: ReadonlyArray<AuthGrantScope>) =>
  main.auth.issuePairingCredential({ scopes: [...scopes] }).pipe(
    Effect.flatMap((pairing) =>
      main.auth.exchangeBootstrapCredentialForAccessToken(pairing.credential, undefined, {
        deviceType: "desktop",
      }),
    ),
    Effect.map((exchanged) => exchanged.access_token),
  );

/** A member with its control link up, so the proxy pipes sockets to it. */
const joinCluster = Effect.gen(function* () {
  const member = yield* serveMember(box);
  const main = yield* serveMain;
  const joinCode = yield* member.cluster.createJoinCode({ url: member.url });
  yield* main.cluster.addMember({ target: joinCode.joinUrl ?? "" });
  yield* main.cluster.start(ClusterService.refuseHostRequests);
  yield* awaitStatus(main, box.environmentId, "online");
  return { member, main, base: `${main.url}/cluster/${box.environmentId}` };
});

const get = (url: string, token?: string, headers: Record<string, string> = {}) =>
  HttpClient.execute(
    HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders(headers),
      token === undefined ? (request) => request : HttpClientRequest.bearerToken(token),
    ),
  );

/** An https server whose certificate is not the one the member was pinned with. */
const serveOtherCertificate = Effect.acquireRelease(
  Effect.callback<NodeHttps.Server>((resume) => {
    const server = NodeHttps.createServer(
      {
        key: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-key.pem", import.meta.url)),
        cert: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-cert.pem", import.meta.url)),
      },
      (_request, response) => response.end("{}"),
    );
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map((server) => `https://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`),
);

/** The first frames a socket at `url` receives; fails when it does not open. */
const firstFrames = (url: string) =>
  Effect.scoped(
    Socket.makeWebSocket(url).pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructor),
      Effect.flatMap((socket) => socket.reader),
      Effect.flatMap(({ pull }) => pull),
    ),
  );

/** Whether a socket at `url` opens at all. */
const opens = (url: string) =>
  Effect.scoped(
    Socket.makeWebSocket(url).pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructor),
      Effect.flatMap((socket) => socket.reader),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
  );

const ticketFor = (url: string, token: string) =>
  HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bearerToken(token))).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((body) => (body as { readonly ticket: string }).ticket),
  );

/** A POST as curl sends it, with headers fetch would refuse to set. */
const rawPost = (url: string, headers: Record<string, string>, body: string) =>
  Effect.callback<{ readonly status: number; readonly body: string }>((resume) => {
    const request = NodeHttp.request(url, { method: "POST", headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () =>
        resume(Effect.succeed({ status: response.statusCode ?? 0, body: text })),
      );
    });
    request.on("error", (error) => resume(Effect.die(error)));
    request.end(body);
  });

it.effect("forwards HTTP to the member under the client's scopes, never the client's header", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { member, main, base } = yield* joinCluster;
      const reader = yield* clientToken(main, ["orchestration:read"]);
      const session = yield* get(`${base}/api/auth/session`, reader, {
        [CLUSTER_SCOPES_HEADER]: encodeOAuthScope(AuthStandardClientScopes),
      }).pipe(Effect.flatMap((response) => response.json));
      expect(session).toMatchObject({
        authenticated: true,
        ...authScopeResponse(["orchestration:read"]),
      });
      // Clients read the descriptor before they hold credentials.
      expect(
        yield* get(`${base}/.well-known/t3/environment`).pipe(
          Effect.flatMap((response) => response.json),
        ),
      ).toMatchObject({ environmentId: box.environmentId });
      expect((yield* get(`${base}/api/auth/session`)).status).toBe(401);
      expect(
        yield* get(`${base}/.well-known/t3/environment`, reader).pipe(
          Effect.flatMap((response) => response.json),
        ),
      ).toMatchObject({ environmentId: box.environmentId });
      expect(
        (yield* get(`${main.url}/cluster/environment-nope/api/auth/session`, reader)).status,
      ).toBe(404);

      // The member's cluster endpoints are the main host's own, never a client's.
      const admin = yield* clientToken(main, AuthStandardClientScopes);
      const leave = yield* HttpClient.execute(
        HttpClientRequest.post(`${base}/api/cluster/leave`).pipe(
          HttpClientRequest.bearerToken(admin),
        ),
      );
      expect(leave.status).toBe(404);
      for (const path of [
        "/api/cluster/events",
        "//api/cluster/events",
        "/API/cluster%2Fevents",
        "/api/cluster;x",
        "/api/cluster/events;x",
        "/%61pi/cluster/events",
        "/%61pi/cluster/leave",
      ]) {
        expect((yield* get(`${base}${path}`, admin)).status).toBe(404);
      }
      // MCP is the main host's own route to the member, at full access; a client never reaches it,
      // nor the member's agent sign-in approval.
      for (const path of [
        "/mcp",
        "/mcp;x",
        "/MCP",
        "//mcp/",
        "/Mcp/tools",
        "/%6dcp",
        "/oauth/mcp/register",
        "/OAuth/mcp/decision",
      ]) {
        const mcp = yield* HttpClient.execute(
          HttpClientRequest.post(`${base}${path}`).pipe(
            HttpClientRequest.bearerToken(admin),
            HttpClientRequest.bodyJsonUnsafe({}),
          ),
        );
        expect(mcp.status, path).toBe(404);
      }
      expect(yield* member.cluster.status).toMatchObject({ role: "member" });
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect("decides by the path the member routes, not the path the client spelled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { main, base } = yield* joinCluster;
      const operator = yield* clientToken(main, ["orchestration:read", "orchestration:operate"]);
      const wsBase = base.replace(/^http/, "ws");
      // A media ticket never opens the member's RPC socket, however `/ws` is spelled.
      for (const path of ["//ws", "/WS", "/ws/", "/ws;x", "/WS;x"]) {
        const media = yield* ticketFor(`${base}/api/auth/websocket-ticket/media`, operator);
        expect(yield* opens(`${wsBase}${path}?wsTicket=${media}`)).toBe(false);
      }
      // The main host answers ticket requests, so the ticket opens sockets through it.
      for (const path of [
        "//api/auth/websocket-ticket/media",
        "/api/auth/websocket-ticket/media;x",
      ]) {
        const ticket = yield* ticketFor(`${base}${path}`, operator);
        const [hello] = yield* firstFrames(`${wsBase}/echo?wsTicket=${ticket}`);
        expect(JSON.parse(String(hello))).toMatchObject({
          scopes: "orchestration:read orchestration:operate",
        });
      }
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect(
  "forwards bodies sent chunked or after 100-continue, never the client's credentials",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { main, base } = yield* joinCluster;
        const admin = yield* clientToken(main, AuthStandardClientScopes);
        const body = JSON.stringify({ id: "x".repeat(2048) });
        for (const framing of [
          { "transfer-encoding": "chunked" },
          { expect: "100-continue", "content-length": String(body.length) },
        ]) {
          const response = yield* rawPost(
            `${base}/echo`,
            {
              authorization: `Bearer ${admin}`,
              cookie: "other=1",
              dpop: "proof",
              "content-type": "application/json",
              "keep-alive": "timeout=5",
              ...framing,
            },
            body,
          );
          expect(response.status, response.body).toBe(200);
          const echoed = JSON.parse(response.body);
          expect(echoed.length).toBe(body.length);
          expect(echoed.headers).not.toHaveProperty("cookie");
          expect(echoed.headers).not.toHaveProperty("dpop");
          expect(echoed.headers.authorization).not.toBe(`Bearer ${admin}`);
        }
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect(
  "forwards a socket to the member with the client's scopes and closes it when the member is removed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { main, base } = yield* joinCluster;
        const operator = yield* clientToken(main, ["orchestration:read", "orchestration:operate"]);
        const ticket = yield* HttpClient.execute(
          HttpClientRequest.post(`${base}/api/auth/websocket-ticket/media`).pipe(
            HttpClientRequest.bearerToken(operator),
          ),
        ).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => (body as { readonly ticket: string }).ticket),
        );
        const socket = yield* Socket.makeWebSocket(
          `${base.replace(/^http/, "ws")}/echo?wsTicket=${ticket}`,
        ).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
        // A socket that closes fails the reads below instead of leaving them waiting.
        const received = yield* Queue.unbounded<string, Socket.SocketError>();
        const { pull } = yield* socket.reader;
        const running = yield* pull.pipe(
          Effect.flatMap((frames) =>
            Queue.offerAll(
              received,
              frames.map((data) =>
                typeof data === "string" ? data : new TextDecoder().decode(data),
              ),
            ),
          ),
          Effect.forever,
          Effect.catch((error) => Queue.fail(received, error)),
          Effect.forkScoped,
        );
        const writer = yield* socket.writer;

        const hello = JSON.parse(yield* Queue.take(received)) as {
          readonly authorization: string;
          readonly scopes: string;
        };
        expect(hello.authorization).toMatch(/^Bearer /);
        expect(hello.authorization).not.toContain(ticket);
        expect(hello.scopes).toBe("orchestration:read orchestration:operate");
        yield* writer.write("ping");
        expect(yield* Queue.take(received)).toBe("ping");
        yield* main.cluster.removeMember(box.environmentId);
        yield* Fiber.await(running);
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect("answers 502 for a member that stopped answering", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const memberScope = yield* Scope.make();
      const member = yield* serveMember(box).pipe(Effect.provideService(Scope.Scope, memberScope));
      const main = yield* serveMain;
      const joinCode = yield* member.cluster.createJoinCode({ url: member.url });
      yield* main.cluster.addMember({ target: joinCode.joinUrl ?? "" });
      // Unauthenticated, so it never dials a member without a live link (for ssh, a spawned ssh).
      const anonymous = yield* get(
        `${main.url}/cluster/${box.environmentId}/.well-known/t3/environment`,
      );
      expect(anonymous.status).toBe(502);
      const reader = yield* clientToken(main, ["orchestration:read"]);
      yield* Scope.close(memberScope, Exit.void);

      const response = yield* get(
        `${main.url}/cluster/${box.environmentId}/api/auth/session`,
        reader,
      );
      expect(response.status).toBe(502);
      expect(yield* response.json).toEqual({
        code: "cluster_member_unreachable",
        memberId: box.environmentId,
      });
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect("refuses a member that presents another certificate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box);
      const main = yield* serveMain;
      const joinCode = yield* member.cluster.createJoinCode({ url: member.url });
      yield* main.cluster.addMember({ target: joinCode.joinUrl ?? "" });
      const reader = yield* clientToken(main, ["orchestration:read"]);
      const rekeyed = yield* serveOtherCertificate;
      yield* main.sql`
        UPDATE cluster_members SET url = ${rekeyed}, cert_sha256 = ${FINGERPRINT}
        WHERE environment_id = ${box.environmentId}
      `;
      // Renaming reloads the rows the proxy reads.
      yield* main.cluster.renameMember({ memberId: box.environmentId, label: "Box" });

      const response = yield* get(
        `${main.url}/cluster/${box.environmentId}/api/auth/session`,
        reader,
      );
      expect(response.status).toBe(502);
      expect(yield* response.json).toEqual({
        code: "cluster_member_unreachable",
        memberId: box.environmentId,
        message: ClusterService.CERTIFICATE_CHANGED,
      });
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect("answers 502 revoked after the member leaves, and 403 while the Labs flag is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { member, main, base } = yield* joinCluster;
      const reader = yield* clientToken(main, ["orchestration:read"]);
      // Up long enough not to count as flapping, so the link reconnects at once and hears 401.
      yield* TestClock.adjust("5 seconds");
      yield* member.cluster.leave;
      const refused = yield* HttpClient.execute(
        HttpClientRequest.post(`${base}/api/auth/pairing-token`).pipe(
          HttpClientRequest.bearerToken(reader),
          HttpClientRequest.bodyJsonUnsafe({}),
        ),
      );
      expect(refused.status).toBe(502);
      expect(yield* refused.json).toEqual({
        code: "cluster_member_revoked",
        memberId: box.environmentId,
      });
      // The session route answers 200 to any credential, so the link's status decides there.
      yield* awaitStatus(main, box.environmentId, "revoked");
      const revoked = yield* get(`${base}/api/auth/session`, reader);
      expect(revoked.status).toBe(502);
      expect(yield* revoked.json).toEqual({
        code: "cluster_member_revoked",
        memberId: box.environmentId,
      });

      yield* main.settings.updateSettings({ clusterEnabled: false });
      const off = yield* get(`${base}/api/auth/session`, reader);
      expect(off.status).toBe(403);
      expect(yield* off.json).toEqual({ code: "cluster_disabled" });
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);
