import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { clusterHostConnection } from "./clusterHosts.ts";
import {
  ClusterConnectionTarget,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "./model.ts";

const HOST_ID = EnvironmentId.make("environment-studio");
const prepared = (
  capabilities: Record<string, boolean>,
  target: PreparedConnection["target"] = new PrimaryConnectionTarget({
    environmentId: HOST_ID,
    label: "Studio",
    httpBaseUrl: "https://studio.example.test/",
    wsBaseUrl: "wss://studio.example.test/",
  }),
): PreparedConnection => ({
  environmentId: target.environmentId,
  label: "Studio",
  httpBaseUrl: "https://studio.example.test/",
  socketUrl: "wss://studio.example.test/ws",
  httpAuthorization: null,
  target,
  descriptor: {
    environmentId: target.environmentId,
    label: "Studio",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true, ...capabilities },
  },
});

describe("clusterHostConnection", () => {
  it("only a host that advertises the capability serves members", () => {
    expect(Option.isSome(clusterHostConnection(Option.some(prepared({ cluster: true }))))).toBe(
      true,
    );
    expect(Option.isNone(clusterHostConnection(Option.some(prepared({}))))).toBe(true);
    expect(Option.isNone(clusterHostConnection(Option.some(prepared({ cluster: false }))))).toBe(
      true,
    );
    expect(Option.isNone(clusterHostConnection(Option.none()))).toBe(true);
    const member = new ClusterConnectionTarget({
      environmentId: EnvironmentId.make("environment-box"),
      label: "Box",
      hostEnvironmentId: HOST_ID,
      hostLabel: "Studio",
      status: "online",
      statusDetail: null,
    });
    expect(
      Option.isNone(clusterHostConnection(Option.some(prepared({ cluster: true }, member)))),
    ).toBe(true);
  });
});
