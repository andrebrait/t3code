import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import {
  clusterMemberConnectionPhase,
  clusterActions,
  clusterJoinTarget,
  clusterMemberStatusText,
  clusterName,
  clusterSshLogin,
  clusterSshTarget,
  defaultClusterJoinAddress,
  offersCluster,
} from "./cluster.ts";

const SHA = "ab".repeat(32);

describe("clusterJoinTarget", () => {
  it("builds the join URL from the address and a code pasted with spaces and line breaks", () => {
    expect(
      clusterJoinTarget({ url: " box.local:3773 ", code: "K7M2 Q9RZ\n3NWD", fingerprint: SHA }),
    ).toBe(`https://box.local:3773/pair#token=K7M2Q9RZ3NWD&sha256=${SHA}`);
    expect(
      clusterJoinTarget({ url: "http://box.local:3773", code: "k7m2q9rz3nwd", fingerprint: null }),
    ).toBe("http://box.local:3773/pair#token=k7m2q9rz3nwd");
  });

  it("is null until the address and code are both valid", () => {
    expect(clusterJoinTarget({ url: "", code: "K7M2Q9RZ3NWD", fingerprint: null })).toBeNull();
    expect(clusterJoinTarget({ url: "box.local", code: "", fingerprint: null })).toBeNull();
    expect(
      clusterJoinTarget({ url: "box.local", code: "K7M2Q9RZ3NW1", fingerprint: null }),
    ).toBeNull();
    expect(
      clusterJoinTarget({ url: "ftp://box", code: "K7M2Q9RZ3NWD", fingerprint: null }),
    ).toBeNull();
  });
});

describe("clusterSshTarget", () => {
  it("takes only ssh targets", () => {
    expect(clusterSshTarget(" me@box ")).toBe("me@box");
    expect(clusterSshTarget("ssh://me@box:2222")).toBe("ssh://me@box:2222");
    expect(clusterSshTarget("https://box.local:3773/pair#token=K7M2Q9RZ3NWD")).toBeNull();
    expect(clusterSshTarget("")).toBeNull();
  });
});

describe("clusterSshLogin", () => {
  const login = (input: Partial<Parameters<typeof clusterSshLogin>[0]>) => {
    const result = clusterSshLogin({
      method: "config",
      password: "",
      keyPath: "",
      passphrase: "",
      ...input,
    });
    // Secrets stay redacted until the RPC encodes them.
    return result === null
      ? null
      : Object.fromEntries(
          Object.entries(result).map(([key, value]) => [
            key,
            Redacted.isRedacted(value) ? `redacted:${Redacted.value(value)}` : value,
          ]),
        );
  };

  it("builds the one-time login, and none until its required field is filled", () => {
    expect(login({ password: "pw" })).toEqual({ _tag: "config" });
    expect(login({ method: "password" })).toBeNull();
    expect(login({ method: "password", password: "pw" })).toEqual({
      _tag: "password",
      password: "redacted:pw",
    });
    expect(login({ method: "keyFile", keyPath: "  " })).toBeNull();
    // A relative path would resolve against the server's working directory.
    expect(login({ method: "keyFile", keyPath: "id_ed25519" })).toBeNull();
    expect(login({ method: "keyFile", keyPath: "~/.ssh/id" })).toEqual({
      _tag: "keyFile",
      path: "~/.ssh/id",
    });
    expect(login({ method: "keyFile", keyPath: String.raw`C:\Users\me\.ssh\id` })).not.toBeNull();
    expect(login({ method: "keyFile", keyPath: " /k/id ", password: "pw" })).toEqual({
      _tag: "keyFile",
      path: "/k/id",
    });
    expect(login({ method: "keyFile", keyPath: "/k/id", passphrase: "secret" })).toEqual({
      _tag: "keyFile",
      path: "/k/id",
      passphrase: "redacted:secret",
    });
  });
});

describe("cluster presentation", () => {
  it("lights a member by this device's connection unless the main host rules it out", () => {
    expect(clusterMemberConnectionPhase({ status: "online" }, "reconnecting")).toBe("reconnecting");
    expect(clusterMemberConnectionPhase({ status: "offline" }, "connecting")).toBe("connecting");
    expect(clusterMemberConnectionPhase({ status: "revoked" }, "connected")).toBe("error");
    expect(clusterMemberConnectionPhase({ status: "incompatible" }, undefined)).toBe("error");
    expect(clusterMemberConnectionPhase({ status: "online" }, undefined)).toBe("connected");
    expect(clusterMemberConnectionPhase({ status: "offline" }, undefined)).toBe("offline");
  });

  it("names the cluster after its main host", () => {
    const joinedAt = DateTime.makeUnsafe(0);
    const host = {
      environmentId: EnvironmentId.make("environment-studio"),
      label: "Studio",
      joinedAt,
    };
    expect(clusterName({ role: "standalone", host: null }, "Box")).toBeNull();
    expect(clusterName({ role: "main", host: null }, "Studio")).toBe("Studio");
    expect(clusterName({ role: "member", host }, "Box")).toBe("Studio");
  });

  it("offers the cluster only where the capability and the Labs flag are both on", () => {
    const config = (cluster: boolean | undefined, clusterEnabled: boolean) => ({
      environment: { capabilities: cluster === undefined ? {} : { cluster } },
      settings: { clusterEnabled },
    });
    expect(offersCluster(config(true, true))).toBe(true);
    expect(offersCluster(config(true, false))).toBe(false);
    expect(offersCluster(config(undefined, true))).toBe(false);
    expect(offersCluster(null)).toBe(false);
  });

  it("offers joining only to a standalone machine and adding to all but members", () => {
    const all = { enabled: true, canAdd: true, canJoin: true };
    expect(clusterActions("standalone", all)).toEqual({ add: true, join: true });
    expect(clusterActions("main", all)).toEqual({ add: true, join: false });
    expect(clusterActions("member", all)).toEqual({ add: false, join: false });
    expect(clusterActions("main", { ...all, enabled: false })).toEqual({ add: false, join: false });
    expect(clusterActions("standalone", { ...all, canAdd: false })).toEqual({
      add: false,
      join: true,
    });
    expect(clusterActions("standalone", { ...all, canJoin: false })).toEqual({
      add: true,
      join: false,
    });
  });

  it("reads member status, showing the last error or Connecting while offline", () => {
    expect(clusterMemberStatusText({ status: "online", lastError: null }, "Studio")).toBe("Online");
    expect(clusterMemberStatusText({ status: "offline", lastError: null }, "Studio")).toBe(
      "Connecting…",
    );
    expect(clusterMemberStatusText({ status: "offline", lastError: "boom" }, "Studio")).toBe(
      "boom",
    );
  });

  it("defaults the join address to https on the served host and port", () => {
    expect(defaultClusterJoinAddress("http://box.local:3773/x")).toBe("https://box.local:3773");
    expect(defaultClusterJoinAddress(null)).toBe("");
    expect(defaultClusterJoinAddress("nonsense")).toBe("");
  });
});
