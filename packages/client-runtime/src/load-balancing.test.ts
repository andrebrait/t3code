import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { loadBalancingCandidateIds } from "./load-balancing.ts";

const local = EnvironmentId.make("local");

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
