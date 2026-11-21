import { createClusterEnvironmentAtoms } from "@t3tools/client-runtime/state/cluster";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { useEnvironmentsWithScope } from "./session";

export const clusterEnvironment = createClusterEnvironmentAtoms(connectionAtomRuntime);

/** Connected environments that can show a Cluster section. Members show under their main host. */
export function useClusterHosts() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.entry.target._tag !== "ClusterConnectionTarget" &&
      environment.serverConfig?.environment.capabilities.cluster === true,
  );
  const readable = useEnvironmentsWithScope(supported, AuthOrchestrationReadScope);
  return supported.filter((environment) => readable.has(environment.environmentId));
}

/** Cluster members are ephemeral routes through a main host, managed in its Cluster section. */
export function useClusterMemberIds(): ReadonlySet<EnvironmentId> {
  const { environments } = useEnvironments();
  return new Set(
    environments
      .filter((environment) => environment.entry.target._tag === "ClusterConnectionTarget")
      .map((environment) => environment.environmentId),
  );
}
