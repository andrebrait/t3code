// @effect-diagnostics globalDate:off - Client receipt times for hooks, outside an Effect runtime.
import {
  type EnvironmentId,
  type HostResourcesSnapshot,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerConfig,
  type ServerProvider,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import type { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

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

/** Fetches fresh host resources for each candidate, then picks one; null when none qualifies. */
export async function pickLoadBalancedEnvironment(
  registry: AtomRegistry.AtomRegistry,
  hostResources: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Record<string, never>;
  }) => Atom.Atom<AsyncResult.AsyncResult<HostResourcesSnapshot, unknown>>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  weights: Readonly<Record<string, number>>,
): Promise<EnvironmentId | null> {
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
