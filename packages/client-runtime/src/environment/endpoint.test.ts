import { describe, expect, it } from "vite-plus/test";

import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { deriveWsBaseUrl, environmentEndpointUrl, normalizeHttpBaseUrl } from "./endpoint.ts";

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it("keeps a cluster member's path prefix on every endpoint", () => {
    const member = "https://studio.example.test/cluster/environment-box";
    expect(environmentEndpointUrl(member, "/.well-known/t3/environment")).toBe(
      "https://studio.example.test/cluster/environment-box/.well-known/t3/environment",
    );
    expect(environmentEndpointUrl("https://studio.example.test/", "/api/auth/session")).toBe(
      "https://studio.example.test/api/auth/session",
    );
    expect(
      makeEnvironmentHttpApiUrlBuilder(member).auth.webSocketTicketFor({ params: { use: "rpc" } }),
    ).toBe("https://studio.example.test/cluster/environment-box/api/auth/websocket-ticket/rpc");
  });
});
