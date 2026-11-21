// @effect-diagnostics globalDate:off - Client receipt times for hooks, outside an Effect runtime.
import {
  type EnvironmentId,
  type HostResourcesSnapshot,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RepositoryIdentity,
  repositoryGroupingKeyOf,
  resolveProjectProviderInstanceEnabled,
  type ServerConfig,
  type ServerProvider,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import type { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { ConnectionCatalogEntry } from "./connection/catalog.ts";
import { scopedProjectKey } from "./environment/scoped.ts";
import { executeAtomQuery } from "./state/runtime.ts";

/** The preferences a machine's load-balancing weight is shown as; 50 is the default. */
export const LOAD_BALANCING_PREFERENCES = [100, 50, 25, 0] as const;
export type LoadBalancingPreference = (typeof LOAD_BALANCING_PREFERENCES)[number];

export function loadBalancingPreferenceForWeight(
  weight: number | undefined,
): LoadBalancingPreference {
  if (weight === undefined || weight === 50) return 50;
  if (weight === 0) return 0;
  return weight < 50 ? 25 : 100;
}

/** The pool that spans every eligible machine; a cluster's pool is keyed by its main host. */
const AUTO_LOAD_BALANCING_POOL = "auto";

export interface LoadBalancingPool {
  readonly key: string;
  /** Null for the pool that spans every machine. */
  readonly cluster: { readonly hostEnvironmentId: EnvironmentId; readonly label: string } | null;
  /** Switched on, connected and not Manual only. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  /** Machines in the pool without the project. Auto never clones, so it skips them. */
  readonly missingEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly missingLabels: ReadonlyArray<string>;
}

/**
 * The Auto choices a project offers: every eligible machine, then each cluster on its own.
 * A pool needs two eligible machines and one that has the project. Clusters balance by default;
 * the client's switch (`autoEnabled`) only adds the pool spanning every machine, which is left
 * out when it holds the same machines as a cluster's.
 */
export function loadBalancingPools(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly entry: Pick<ConnectionCatalogEntry, "enabled" | "target">;
    readonly connection: { readonly phase: string };
  }>;
  readonly weights: Readonly<Record<string, number>>;
  readonly hasProject: ReadonlySet<EnvironmentId>;
  readonly autoEnabled: boolean;
}): LoadBalancingPool[] {
  const eligible = input.environments.filter(
    ({ environmentId, entry, connection }) =>
      (entry.enabled || entry.target._tag === "PrimaryConnectionTarget") &&
      connection.phase === "connected" &&
      (input.weights[environmentId] ?? 50) > 0,
  );
  const hostIdOf = (target: Pick<ConnectionCatalogEntry, "target">["target"]) =>
    target._tag === "ClusterConnectionTarget" ? target.hostEnvironmentId : null;
  const clusters = new Map<EnvironmentId, string>();
  for (const { entry } of input.environments) {
    const target = entry.target;
    if (target._tag !== "ClusterConnectionTarget") continue;
    const host = input.environments.find(
      (environment) => environment.environmentId === target.hostEnvironmentId,
    );
    clusters.set(target.hostEnvironmentId, host?.label ?? target.hostLabel);
  }
  const pool = (
    key: string,
    cluster: LoadBalancingPool["cluster"],
    members: typeof eligible,
  ): LoadBalancingPool | null => {
    const environmentIds = members.map((environment) => environment.environmentId);
    const missing = members.filter(({ environmentId }) => !input.hasProject.has(environmentId));
    return environmentIds.length >= 2 && missing.length < environmentIds.length
      ? {
          key,
          cluster,
          environmentIds,
          missingEnvironmentIds: missing.map((environment) => environment.environmentId),
          missingLabels: missing.map((environment) => environment.label),
        }
      : null;
  };
  const clusterPools = [...clusters]
    .map(([hostEnvironmentId, label]) =>
      pool(
        hostEnvironmentId,
        { hostEnvironmentId, label },
        eligible.filter(
          (environment) =>
            environment.environmentId === hostEnvironmentId ||
            hostIdOf(environment.entry.target) === hostEnvironmentId,
        ),
      ),
    )
    .filter((candidate) => candidate !== null)
    .sort((left, right) => left.cluster!.label.localeCompare(right.cluster!.label));
  const everywhere = input.autoEnabled ? pool(AUTO_LOAD_BALANCING_POOL, null, eligible) : null;
  const duplicatesCluster = clusterPools.some(
    (cluster) => cluster.environmentIds.length === everywhere?.environmentIds.length,
  );
  return everywhere && !duplicatesCluster ? [everywhere, ...clusterPools] : clusterPools;
}

/**
 * Machine picker order, matching the pools': each cluster together (by label, the primary's
 * first), its main host then members by label, and machines that would clone the project
 * after those that have it; then standalone machines, the primary first, then by label.
 */
export function sortEnvironmentOptionsByCluster<
  T extends { readonly environmentId: EnvironmentId; readonly cloneRemoteUrl?: string | undefined },
>(
  options: ReadonlyArray<T>,
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly entry: Pick<ConnectionCatalogEntry, "target">;
  }>,
  primaryEnvironmentId: EnvironmentId | null = null,
): T[] {
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const hostOf = new Map<EnvironmentId, EnvironmentId>();
  for (const {
    entry: { target },
  } of environments) {
    if (target._tag !== "ClusterConnectionTarget") continue;
    hostOf.set(target.environmentId, target.hostEnvironmentId);
    hostOf.set(target.hostEnvironmentId, target.hostEnvironmentId);
    if (!labels.has(target.hostEnvironmentId)) {
      labels.set(target.hostEnvironmentId, target.hostLabel);
    }
  }
  const labelOf = (environmentId: EnvironmentId) => labels.get(environmentId) ?? environmentId;
  const primaryHost = primaryEnvironmentId === null ? undefined : hostOf.get(primaryEnvironmentId);
  const sortKey = (option: T) => {
    const host = hostOf.get(option.environmentId);
    return {
      group: host === undefined ? 2 : host === primaryHost ? 0 : 1,
      host: host === undefined ? "" : `${labelOf(host)}\0${host}`,
      clones: option.cloneRemoteUrl === undefined ? 0 : 1,
      leads: option.environmentId === (host ?? primaryEnvironmentId) ? 0 : 1,
      label: labelOf(option.environmentId),
    };
  };
  return options
    .map((option) => ({ option, key: sortKey(option) }))
    .sort(
      ({ key: left }, { key: right }) =>
        left.group - right.group ||
        left.host.localeCompare(right.host) ||
        left.clones - right.clones ||
        left.leads - right.leads ||
        left.label.localeCompare(right.label),
    )
    .map(({ option }) => option);
}

/**
 * Splits machines for the load-balancing settings: one group per cluster, in picker order
 * (main host first, then members by label), then the standalone machines.
 */
export function groupEnvironmentsByCluster<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly entry: Pick<ConnectionCatalogEntry, "target">;
  },
>(environments: ReadonlyArray<T>, primaryEnvironmentId: EnvironmentId | null = null) {
  const hostIds = new Set(
    environments.flatMap(({ entry: { target } }) =>
      target._tag === "ClusterConnectionTarget" ? [target.hostEnvironmentId] : [],
    ),
  );
  const clusters = new Map<EnvironmentId, { label: string; environments: T[] }>();
  const standalone: T[] = [];
  for (const environment of sortEnvironmentOptionsByCluster(
    environments,
    environments,
    primaryEnvironmentId,
  )) {
    const { target } = environment.entry;
    const host =
      target._tag === "ClusterConnectionTarget"
        ? target.hostEnvironmentId
        : hostIds.has(environment.environmentId)
          ? environment.environmentId
          : null;
    if (host === null) {
      standalone.push(environment);
      continue;
    }
    // The main host leads its group, so its own label wins over a member's copy.
    const label = target._tag === "ClusterConnectionTarget" ? target.hostLabel : environment.label;
    const group = clusters.get(host) ?? { label, environments: [] };
    group.environments.push(environment);
    clusters.set(host, group);
  }
  return {
    clusters: [...clusters].map(([hostEnvironmentId, group]) => ({ hostEnvironmentId, ...group })),
    standalone,
  };
}

/**
 * What a "Don't ask again" for the fewer-machines confirm is stored under: the repository, so
 * the choice covers the project on every machine; a project without one is keyed by itself.
 */
export function loadBalancingConfirmKey(project: {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}): string {
  return project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity)
    : scopedProjectKey({ environmentId: project.environmentId, projectId: project.id });
}

/** The pool a draft balances in: its chosen one while offered, else Auto, else its machine's cluster. */
export function activeLoadBalancingPool(
  pools: ReadonlyArray<LoadBalancingPool>,
  chosenKey: string | null | undefined,
  environmentId: EnvironmentId,
): LoadBalancingPool | null {
  return (
    pools.find((pool) => pool.key === chosenKey) ??
    pools.find((pool) => pool.key === AUTO_LOAD_BALANCING_POOL) ??
    pools.find((pool) => pool.environmentIds.includes(environmentId)) ??
    null
  );
}

/**
 * Machines Auto balance may pick: ones that already have the project (never one that would
 * clone it), connected, weighted above zero, able to read every attached thread, and running
 * the selected provider.
 */
export function loadBalancingCandidateIds(input: {
  readonly candidates: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId | null;
  }>;
  readonly environmentById: ReadonlyMap<
    EnvironmentId,
    {
      readonly connection: { readonly phase: string };
      readonly serverConfig: Pick<ServerConfig, "settings"> | null;
    }
  >;
  readonly providersByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>;
  readonly weights: Readonly<Record<string, number>>;
  readonly referencedThreadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly selectedProvider: ProviderDriverKind;
}): EnvironmentId[] {
  return input.candidates
    .filter((candidate) => {
      const environment = input.environmentById.get(candidate.environmentId);
      return (
        candidate.projectId !== null &&
        environment?.connection.phase === "connected" &&
        (input.weights[candidate.environmentId] ?? 50) > 0 &&
        input.referencedThreadContexts.every(
          (record) => record.environmentId === candidate.environmentId,
        ) &&
        input.providersByEnvironment
          .get(candidate.environmentId)
          ?.some(
            (provider) =>
              (input.activeProviderInstanceId === null ||
                provider.instanceId === input.activeProviderInstanceId) &&
              provider.driver === input.selectedProvider &&
              (environment.serverConfig?.settings
                ? resolveProjectProviderInstanceEnabled(
                    environment.serverConfig.settings,
                    candidate.projectId,
                    provider.instanceId,
                  )
                : provider.enabled) &&
              provider.installed &&
              provider.status !== "error" &&
              provider.auth.status !== "unauthenticated" &&
              provider.availability !== "unavailable",
          )
      );
    })
    .map((candidate) => candidate.environmentId);
}

/**
 * Fetches fresh host resources for each candidate, then picks one; null when none qualifies.
 * A lone candidate is taken as is: with nowhere else to go, its load cannot block the send.
 */
export async function pickLoadBalancedEnvironment(
  registry: AtomRegistry.AtomRegistry,
  hostResources: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Record<string, never>;
  }) => Atom.Atom<AsyncResult.AsyncResult<HostResourcesSnapshot, unknown>>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  weights: Readonly<Record<string, number>>,
): Promise<EnvironmentId | null> {
  if (environmentIds.length === 1) return environmentIds[0]!;
  const candidates = await Promise.all(
    environmentIds.map(async (environmentId) => {
      const result = await executeAtomQuery(registry, hostResources({ environmentId, input: {} }), {
        refresh: true,
        reportFailure: false,
        signal: AbortSignal.timeout(5_000),
      });
      return {
        environmentId,
        resources: result._tag === "Success" ? result.value : null,
        receivedAt: Date.now(),
        weight: weights[environmentId] ?? 50,
      };
    }),
  );
  return chooseLoadBalancedEnvironment(candidates, Date.now()) as EnvironmentId | null;
}

/** Callers supply only connected machines hosting the project and selected provider. */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<{
    environmentId: string;
    resources: HostResourcesSnapshot | null;
    /** Client receipt time avoids comparing clocks on different machines. */
    receivedAt?: number;
    weight: number;
  }>,
  now: number,
): string | null {
  let selected: string | null = null;
  let bestScore = 0;
  for (const { environmentId, resources, receivedAt, weight } of candidates) {
    const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
    if (
      !resources ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      now - sampledAt > 15_000 ||
      sampledAt > now + 5_000 ||
      resources.cpuUtilization === null ||
      resources.cpuUtilization >= 0.95 ||
      resources.totalMemoryBytes <= 0 ||
      resources.cpuCount <= 0
    ) {
      continue;
    }
    const memoryAvailable = resources.availableMemoryBytes / resources.totalMemoryBytes;
    if (memoryAvailable <= 0.05) continue;
    const score = weight * resources.cpuCount * (1 - resources.cpuUtilization) * memoryAvailable;
    if (score > bestScore) {
      selected = environmentId;
      bestScore = score;
    }
  }
  return selected;
}

/** Why a send waits for the user to pick a machine when no machine was chosen automatically. */
export function loadBalancingSendWarning(
  input: {
    readonly pending: boolean;
    readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
    readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
  },
  resolve: MFunctionType = mFallback,
) {
  if (input.pending) {
    return {
      title: resolve(msg("Checking machine resources")),
      description: resolve(
        msg("Resource checks are still running. You can choose a machine in the composer."),
      ),
    };
  }
  const noMachineReadsEveryThread =
    input.threadContexts.length > 0 &&
    !input.candidateEnvironmentIds.some((environmentId) =>
      input.threadContexts.every((record) => record.environmentId === environmentId),
    );
  return {
    title: resolve(msg("Choose a machine to continue")),
    description: noMachineReadsEveryThread
      ? resolve(
          msg(
            "No machine can read every attached thread. Choose a machine in the composer or remove the threads.",
          ),
        )
      : resolve(
          msg(
            "No eligible machine has available resources. Choose a machine in the composer to override.",
          ),
        ),
  };
}
