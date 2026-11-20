import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "./baseSchemas.ts";
import {
  clusterMemberBaseUrl,
  formatClusterJoinUrl,
  formatClusterSshTarget,
  normalizeCertificateFingerprint,
  parseClusterJoinUrl,
  parseClusterSshTarget,
} from "./cluster.ts";

const SHA = "ab".repeat(32);

describe("cluster join URLs", () => {
  it("round-trips the member's origin, code and certificate fingerprint as a pairing URL", () => {
    const joinUrl = formatClusterJoinUrl({
      url: "https://box.local:3773/some/path",
      code: "K7M2Q9RZ3NWD",
      fingerprint: SHA.toUpperCase().match(/../g)!.join(":"),
    });
    expect(joinUrl).toBe(`https://box.local:3773/pair#token=K7M2Q9RZ3NWD&sha256=${SHA}`);
    expect(parseClusterJoinUrl(` ${joinUrl} `)).toEqual({
      url: "https://box.local:3773",
      code: "K7M2Q9RZ3NWD",
      fingerprint: SHA,
    });
    expect(
      parseClusterJoinUrl(`https://box.local:3773/pair#token=k7m2q9rz3nwd&sha256=${SHA}`)?.code,
    ).toBe("K7M2Q9RZ3NWD");
  });

  it("round-trips a join URL without a fingerprint", () => {
    const joinUrl = formatClusterJoinUrl({
      url: "https://box.tail1234.ts.net/",
      code: "K7M2Q9RZ3NWD",
      fingerprint: null,
    });
    expect(joinUrl).toBe("https://box.tail1234.ts.net/pair#token=K7M2Q9RZ3NWD");
    expect(parseClusterJoinUrl(joinUrl)).toEqual({
      url: "https://box.tail1234.ts.net",
      code: "K7M2Q9RZ3NWD",
      fingerprint: null,
    });
  });

  it.each([
    "https://box.local:3773",
    "https://box.local:3773/pair",
    "https://box.local:3773/pair#token=",
    "https://box.local:3773/pair#token=K7M2Q9RZ3NW1",
    "https://box.local:3773/pair#token=K7M2Q9RZ3NWD&sha256=",
    `https://box.local:3773/pair#token=K7M2Q9RZ3NWD&sha256=${SHA.slice(2)}`,
    `https://box.local:3773/pair#sha256=${SHA}`,
    `https://box.local:3773#K7M2Q9RZ3NWD.${SHA}`,
    `ftp://box.local/pair#token=K7M2Q9RZ3NWD&sha256=${SHA}`,
    "me@box",
  ])("rejects %s", (value) => {
    expect(parseClusterJoinUrl(value)).toBeUndefined();
  });

  it("normalizes Node's colon-separated fingerprints", () => {
    expect(normalizeCertificateFingerprint("AB:CD:EF")).toBe("abcdef");
  });
});

describe("cluster ssh targets", () => {
  it.each([
    ["me@box", { username: "me", hostname: "box", port: null }],
    ["ssh://me@box.example.com:2222", { username: "me", hostname: "box.example.com", port: 2222 }],
    ["box", { username: null, hostname: "box", port: null }],
  ] as const)("parses %s", (value, expected) => {
    expect(parseClusterSshTarget(value)).toEqual(expected);
    expect(parseClusterSshTarget(formatClusterSshTarget(expected))).toEqual(expected);
  });

  it.each(["", "me@", "me@box:0", "me@box:70000", "https://box", "a b"])("rejects %j", (value) => {
    expect(parseClusterSshTarget(value)).toBeUndefined();
  });
});

it("builds a member's base URL under the main host's origin", () => {
  expect(clusterMemberBaseUrl("https://studio.ts.net/", EnvironmentId.make("env/1"))).toBe(
    "https://studio.ts.net/cluster/env%2F1",
  );
});
