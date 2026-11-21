import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "./environment/scoped.ts";

import { threadContextRecord } from "@t3tools/shared/composerContextReferences";

import { ClusterConnectionTarget, PrimaryConnectionTarget } from "./connection/model.ts";
import {
  groupEnvironmentsByCluster,
  loadBalancingCandidateIds,
  loadBalancingPools,
  loadBalancingSendWarning,
  pickLoadBalancedEnvironment,
  sortEnvironmentOptionsByCluster,
} from "./load-balancing.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const localThread = threadContextRecord(scopeThreadRef(local, ThreadId.make("a")), "Local");
const remoteThread = threadContextRecord(scopeThreadRef(remote, ThreadId.make("b")), "Remote");

describe("loadBalancingCandidateIds", () => {
  const codex = ProviderDriverKind.make("codex");
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: codex,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const member = EnvironmentId.make("member");
  const offline = EnvironmentId.make("offline");
  const other = EnvironmentId.make("other");
  const connected = { connection: { phase: "connected" }, serverConfig: null };
  const candidateIds = (weights: Record<string, number> = {}) =>
    loadBalancingCandidateIds({
      candidates: [
        { environmentId: local, projectId: ProjectId.make("project") },
        // A cluster machine that would clone the project.
        { environmentId: member, projectId: null },
        { environmentId: offline, projectId: ProjectId.make("project") },
        { environmentId: other, projectId: ProjectId.make("project") },
      ],
      environmentById: new Map([
        [local, connected],
        [member, connected],
        [offline, { connection: { phase: "offline" }, serverConfig: null }],
        [other, connected],
      ]),
      providersByEnvironment: new Map([
        [local, [provider]],
        [member, [provider]],
        [offline, [provider]],
        [other, [provider]],
      ]),
      weights,
      referencedThreadContexts: [],
      activeProviderInstanceId: null,
      selectedProvider: codex,
    });

  it("picks only machines that already have the project", () => {
    expect(candidateIds()).toEqual([local, other]);
  });

  it("leaves out a machine set to Manual only", () => {
    expect(candidateIds({ [other]: 0 })).toEqual([local]);
  });
});

describe("pickLoadBalancedEnvironment", () => {
  it("goes straight to a lone candidate, whose resources may be busy or unreadable", async () => {
    const unreadable = () => {
      throw new Error("host resources unavailable");
    };
    expect(await pickLoadBalancedEnvironment(AtomRegistry.make(), unreadable, [remote], {})).toBe(
      remote,
    );
  });
});

describe("loadBalancingSendWarning", () => {
  it("asks the user to wait while resource checks run", () => {
    expect(
      loadBalancingSendWarning({
        pending: true,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [],
      }).title,
    ).toBe("Checking machine resources");
  });

  it("blames the attached threads when no machine can read all of them", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [local, remote],
      }).description,
    ).toMatch(/No machine can read every attached thread/);
  });

  it("blames resources when one machine can read every attached thread", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread],
        candidateEnvironmentIds: [remote, local],
      }).description,
    ).toMatch(/No eligible machine has available resources/);
  });
});

const host = EnvironmentId.make("ai-dev");
const worker2 = EnvironmentId.make("ai-worker-2");
const worker3 = EnvironmentId.make("ai-worker-3");
const laptop = EnvironmentId.make("laptop");
const machine = (environmentId: EnvironmentId, label: string, member: boolean) => ({
  environmentId,
  label,
  entry: {
    enabled: true,
    target: member
      ? new ClusterConnectionTarget({
          environmentId,
          label,
          hostEnvironmentId: host,
          hostLabel: "ai-dev",
          hostConnectionKey: null,
          status: "online",
          statusDetail: null,
        })
      : new PrimaryConnectionTarget({
          environmentId,
          label,
          httpBaseUrl: "https://example.test/",
          wsBaseUrl: "wss://example.test/",
        }),
  },
  connection: { phase: "connected" },
});
const cluster = [
  machine(host, "ai-dev", false),
  machine(worker2, "ai-worker-2", true),
  machine(worker3, "ai-worker-3", true),
];
describe("loadBalancingPools", () => {
  const pools = (
    environments: ReadonlyArray<ReturnType<typeof machine>>,
    hasProject: ReadonlyArray<EnvironmentId>,
    weights: Record<string, number> = {},
    autoEnabled = true,
  ) =>
    loadBalancingPools({ environments, weights, hasProject: new Set(hasProject), autoEnabled }).map(
      (pool) => [pool.key, pool.environmentIds, pool.missingEnvironmentIds],
    );

  it("offers a lone cluster once, with the machines that lack the project", () => {
    expect(pools(cluster, [host])).toEqual([[host, [host, worker2, worker3], [worker2, worker3]]]);
  });

  it("offers Auto over every machine beside each cluster", () => {
    expect(pools([...cluster, machine(laptop, "laptop", false)], [host, laptop])).toEqual([
      ["auto", [host, worker2, worker3, laptop], [worker2, worker3]],
      [host, [host, worker2, worker3], [worker2, worker3]],
    ]);
  });

  it("balances clusters while the client's switch is off, but offers Auto only when on", () => {
    const environments = [...cluster, machine(laptop, "laptop", false)];
    expect(pools(environments, [host, laptop], {}, false)).toEqual([
      [host, [host, worker2, worker3], [worker2, worker3]],
    ]);
  });

  it("leaves Manual only machines out of the pool and its missing list", () => {
    expect(pools(cluster, [host], { [worker3]: 0 })).toEqual([[host, [host, worker2], [worker2]]]);
  });

  it("offers nothing with one eligible machine or none with the project", () => {
    expect(pools(cluster, [host], { [worker2]: 0, [worker3]: 0 })).toEqual([]);
    expect(pools([machine(host, "ai-dev", false), machine(laptop, "laptop", false)], [])).toEqual(
      [],
    );
  });
});

describe("sortEnvironmentOptionsByCluster", () => {
  it("groups each cluster, main host first, before standalone machines", () => {
    const desktop = EnvironmentId.make("desktop");
    const worker1 = EnvironmentId.make("ai-worker-1");
    const environments = [
      ...cluster,
      machine(worker1, "ai-worker-1", true),
      machine(laptop, "laptop", false),
      machine(desktop, "desktop", false),
    ];
    const order = (
      options: ReadonlyArray<{ environmentId: EnvironmentId; cloneRemoteUrl?: string }>,
      primary: EnvironmentId | null = null,
    ) =>
      sortEnvironmentOptionsByCluster(options, environments, primary).map(
        (option) => option.environmentId,
      );
    const clone = "https://example.test/repo.git";
    expect(
      order([
        { environmentId: host },
        { environmentId: laptop },
        { environmentId: worker3 },
        { environmentId: desktop },
        { environmentId: worker1, cloneRemoteUrl: clone },
        { environmentId: worker2 },
      ]),
    ).toEqual([host, worker2, worker3, worker1, desktop, laptop]);
    expect(order([{ environmentId: desktop }, { environmentId: laptop }], laptop)).toEqual([
      laptop,
      desktop,
    ]);
  });

  it("splits settings into cluster groups, then standalone machines", () => {
    const desktop = EnvironmentId.make("desktop");
    const groups = groupEnvironmentsByCluster(
      [
        machine(laptop, "laptop", false),
        ...cluster.toReversed(),
        machine(desktop, "desktop", false),
      ],
      laptop,
    );
    expect({
      clusters: groups.clusters.map((group) => [
        group.hostEnvironmentId,
        group.label,
        group.environments.map((environment) => environment.environmentId),
      ]),
      standalone: groups.standalone.map((environment) => environment.environmentId),
    }).toEqual({
      clusters: [[host, "ai-dev", [host, worker2, worker3]]],
      standalone: [laptop, desktop],
    });
  });
});
