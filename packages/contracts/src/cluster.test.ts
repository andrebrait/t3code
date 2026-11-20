import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "./baseSchemas.ts";
import {
  clusterMemberBaseUrl,
  formatClusterJoinString,
  formatClusterSshTarget,
  normalizeCertificateFingerprint,
  parseClusterJoinString,
  parseClusterSshTarget,
} from "./cluster.ts";

const SHA = "ab".repeat(32);

describe("cluster join codes", () => {
  it("round-trips the member's origin, code and certificate fingerprint", () => {
    const joinString = formatClusterJoinString({
      url: "https://box.local:3773/some/path",
      code: "K7M2Q9RZ3NWD",
      fingerprint: SHA.toUpperCase().match(/../g)!.join(":"),
    });
    expect(joinString).toBe(`https://box.local:3773#K7M2Q9RZ3NWD.${SHA}`);
    expect(parseClusterJoinString(` ${joinString} `)).toEqual({
      url: "https://box.local:3773",
      code: "K7M2Q9RZ3NWD",
      fingerprint: SHA,
    });
    expect(parseClusterJoinString(`https://box.local:3773#k7m2q9rz3nwd.${SHA}`)?.code).toBe(
      "K7M2Q9RZ3NWD",
    );
  });

  it("round-trips a join code without a fingerprint", () => {
    const joinString = formatClusterJoinString({
      url: "https://box.tail1234.ts.net/",
      code: "K7M2Q9RZ3NWD",
      fingerprint: null,
    });
    expect(joinString).toBe("https://box.tail1234.ts.net#K7M2Q9RZ3NWD");
    expect(parseClusterJoinString(joinString)).toEqual({
      url: "https://box.tail1234.ts.net",
      code: "K7M2Q9RZ3NWD",
      fingerprint: null,
    });
  });

  it.each([
    "https://box.local:3773",
    `https://box.local:3773#K7M2Q9RZ3NW1`,
    `https://box.local:3773#K7M2Q9RZ3NWD.`,
    `https://box.local:3773#K7M2Q9RZ3NW1.${SHA}`,
    `https://box.local:3773#K7M2Q9RZ3NWD.${SHA}.extra`,
    `https://box.local:3773#K7M2Q9RZ3NWD.${SHA.slice(2)}`,
    `ftp://box.local#K7M2Q9RZ3NWD.${SHA}`,
    `me@box`,
  ])("rejects %s", (value) => {
    expect(parseClusterJoinString(value)).toBeUndefined();
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
