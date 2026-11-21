import { describe, expect, it } from "vite-plus/test";

import { DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES, isDevProxiedPath } from "./devProxy.ts";

describe("devProxy", () => {
  it.each(["/cluster/abc/ws", "/cluster/abc/.well-known/t3/environment"])(
    "proxies %s to the server",
    (pathname) => {
      expect(isDevProxiedPath(pathname)).toBe(true);
    },
  );

  it("preserves the origin for cluster member sockets", () => {
    expect(DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES.has("/cluster")).toBe(true);
  });
});
