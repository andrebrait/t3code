import { sortEnvironmentOptionsByCluster } from "@t3tools/client-runtime/load-balancing";
import {
  availableScratchWorkspaceRoot,
  clusterCloneEnvironmentIds,
  projectCloneRemoteUrl,
} from "@t3tools/client-runtime/operations/projects";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ProjectId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentsWithScope } from "../state/session";
import { useClientSettings } from "./useSettings";

export function useLogicalProjectEnvironments(
  activeProject: EnvironmentProject | null,
  scratchDraft: boolean,
): readonly EnvironmentOption[] {
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const canClone = useEnvironmentsWithScope(environments, AuthSourceControlWriteScope);

  if (!activeProject) return [];
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const envs: EnvironmentOption[] = [];
  const pushEnvironment = (
    environmentId: EnvironmentId,
    projectId: ProjectId | null,
    cloneRemoteUrl?: string,
  ) => {
    const environment = environmentById.get(environmentId) ?? null;
    envs.push({
      environmentId,
      projectId,
      label: environment?.label ?? environmentId,
      isPrimary: environmentId === primaryEnvironmentId,
      machine: resolveEnvironmentMachineKind(environment?.serverConfig ?? null),
      ...(cloneRemoteUrl ? { cloneRemoteUrl } : {}),
    });
  };
  if (scratchDraft) {
    for (const environment of environments) {
      const scratchRoot = availableScratchWorkspaceRoot(
        environment.connection.phase,
        environment.serverConfig,
      );
      if (scratchRoot === null && environment.environmentId !== activeProject.environmentId)
        continue;
      const scratchProject =
        environment.environmentId === activeProject.environmentId
          ? activeProject
          : allProjects.find(
              (p) =>
                p.environmentId === environment.environmentId && isScratchProject(p, scratchRoot),
            );
      pushEnvironment(environment.environmentId, scratchProject?.id ?? null);
    }
  } else {
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const seen = new Set<EnvironmentId>();
    for (const p of allProjects) {
      if (seen.has(p.environmentId)) continue;
      if (deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) !== logicalKey) continue;
      seen.add(p.environmentId);
      pushEnvironment(p.environmentId, p.id);
    }
    const remoteUrl = projectCloneRemoteUrl(activeProject);
    if (remoteUrl !== null) {
      for (const environmentId of clusterCloneEnvironmentIds({
        project: activeProject,
        environments,
        hasProject: seen,
      })) {
        if (canClone.has(environmentId)) pushEnvironment(environmentId, null, remoteUrl);
      }
    }
  }
  return sortEnvironmentOptionsByCluster(envs, environments, primaryEnvironmentId);
}
