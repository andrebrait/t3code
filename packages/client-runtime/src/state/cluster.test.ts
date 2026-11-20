import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import {
  clusterActions,
  clusterAddTarget,
  clusterMemberStatusText,
  clusterName,
  clusterSshLogin,
  defaultClusterInviteUrl,
  offersCluster,
} from "./cluster.ts";

const SHA = "ab".repeat(32);
const JOIN = `https://box.local:3773#K7M2Q9RZ3NWD.${SHA}`;

describe("clusterAddTarget", () => {
  it("accepts a join string pasted with spaces and line breaks", () => {
    const wrapped = ` ${JOIN.slice(0, 30)}\n${JOIN.slice(30, 70)}\r\n  ${JOIN.slice(70)}\t`;
    expect(clusterAddTarget(wrapped, { ssh: false })).toBe(JOIN);
  });

  it("takes ssh targets only where the main host can dial them", () => {
    expect(clusterAddTarget(" me@box ", { ssh: true })).toBe("me@box");
    expect(clusterAddTarget("ssh://me@box:2222", { ssh: true })).toBe("ssh://me@box:2222");
    expect(clusterAddTarget("me@box", { ssh: false })).toBeNull();
    expect(clusterAddTarget(`https://box.local:3773#K7M2Q9RZ3NWD`, { ssh: true })).toBe(
      `https://box.local:3773#K7M2Q9RZ3NWD`,
    );
    expect(clusterAddTarget(`me@box#K7M2Q9RZ3NWD`, { ssh: true })).toBeNull();
    expect(clusterAddTarget("", { ssh: true })).toBeNull();
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
    const all = { enabled: true, canAdd: true, canInvite: true };
    expect(clusterActions("standalone", all)).toEqual({ add: true, join: true });
    expect(clusterActions("main", all)).toEqual({ add: true, join: false });
    expect(clusterActions("member", all)).toEqual({ add: false, join: false });
    expect(clusterActions("main", { ...all, enabled: false })).toEqual({ add: false, join: false });
    expect(clusterActions("standalone", { ...all, canAdd: false })).toEqual({
      add: false,
      join: true,
    });
    expect(clusterActions("standalone", { ...all, canInvite: false })).toEqual({
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

  it("defaults the invite URL to https on the served host and port", () => {
    expect(defaultClusterInviteUrl("http://box.local:3773/x")).toBe("https://box.local:3773");
    expect(defaultClusterInviteUrl(null)).toBe("");
    expect(defaultClusterInviteUrl("nonsense")).toBe("");
  });
});
