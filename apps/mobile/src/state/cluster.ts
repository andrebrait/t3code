import { createClusterEnvironmentAtoms } from "@t3tools/client-runtime/state/cluster";

import { connectionAtomRuntime } from "../connection/runtime";

export const clusterEnvironment = createClusterEnvironmentAtoms(connectionAtomRuntime);
