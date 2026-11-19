import { describe, expect, it } from "vite-plus/test";

import { plainHttpDecision } from "./plainHttpPolicy.ts";

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
