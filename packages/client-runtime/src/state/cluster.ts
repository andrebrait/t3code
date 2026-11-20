import {
  type ClusterMember,
  type ClusterSshLogin,
  type ClusterStatus,
  type ServerConfig,
  parseClusterJoinString,
  parseClusterSshTarget,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Atom } from "effect/reactivity";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createClusterEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:cluster:status",
    tag: WS_METHODS.clusterStatus,
  });
  return {
    status,
    members: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:cluster:members",
      tag: WS_METHODS.clusterMembers,
    }),
    invite: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cluster:invite",
      tag: WS_METHODS.clusterInvite,
    }),
    addMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cluster:add-member",
      tag: WS_METHODS.clusterAddMember,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(status({ environmentId, input: {} }))),
    }),
    removeMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cluster:remove-member",
      tag: WS_METHODS.clusterRemoveMember,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(status({ environmentId, input: {} }))),
    }),
    renameMember: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cluster:rename-member",
      tag: WS_METHODS.clusterRenameMember,
    }),
    sshKeys: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cluster:ssh-keys",
      tag: WS_METHODS.clusterSshKeys,
    }),
    leave: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cluster:leave",
      tag: WS_METHODS.clusterLeave,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(status({ environmentId, input: {} }))),
    }),
  };
}

/** Whether an environment shows its Cluster settings: it supports clusters and its beta is on. */
export const offersCluster = (
  config:
    | {
        readonly environment: { readonly capabilities: { readonly cluster?: boolean } };
        readonly settings: Pick<ServerConfig["settings"], "clusterEnabled">;
      }
    | null
    | undefined,
): boolean => config?.environment.capabilities.cluster === true && config.settings.clusterEnabled;

/** A main host only adds members; joining another cluster is for a standalone machine. */
export const clusterActions = (
  role: ClusterStatus["role"],
  access: { readonly enabled: boolean; readonly canAdd: boolean; readonly canInvite: boolean },
) => ({
  add: access.enabled && access.canAdd && role !== "member",
  join: access.enabled && access.canInvite && role === "standalone",
});

/** Pasted join strings often wrap or carry stray spaces; none of their characters is a space. */
export function clusterAddTarget(raw: string, options: { readonly ssh: boolean }): string | null {
  const target = raw.replace(/\s+/g, "");
  if (parseClusterJoinString(target) !== undefined) return target;
  return options.ssh && !target.includes("#") && parseClusterSshTarget(target) !== undefined
    ? target
    : null;
}

/** The Add member dialog's one-time ssh login; null until its required field is filled. */
export function clusterSshLogin(input: {
  readonly method: ClusterSshLogin["_tag"];
  readonly password: string;
  readonly keyPath: string;
  readonly passphrase: string;
}): ClusterSshLogin | null {
  switch (input.method) {
    case "config":
      return { _tag: "config" };
    case "password":
      return input.password === ""
        ? null
        : { _tag: "password", password: Redacted.make(input.password) };
    case "keyFile": {
      const path = input.keyPath.trim();
      if (path === "") return null;
      return input.passphrase === ""
        ? { _tag: "keyFile", path }
        : { _tag: "keyFile", path, passphrase: Redacted.make(input.passphrase) };
    }
  }
}

export function clusterName(
  status: Pick<ClusterStatus, "role" | "host">,
  ownLabel: string,
): string | null {
  switch (status.role) {
    case "standalone":
      return null;
    case "main":
      return ownLabel;
    case "member":
      return status.host?.label ?? ownLabel;
  }
}

export function clusterMemberStatusText(
  member: Pick<ClusterMember, "status" | "lastError">,
  hostLabel: string,
  resolve: MFunctionType = mFallback,
): string {
  switch (member.status) {
    case "online":
      return resolve(msg("Online", { $context: "cluster member status" }));
    case "offline":
      // A just-added member is offline with no error until its control link first connects.
      return member.lastError ?? resolve(msg("Connecting…", { $context: "cluster member status" }));
    case "incompatible":
      return resolve(
        msg("Runs a T3 Code version {host} cannot drive. Update both to the same version.", {
          host: hostLabel,
        }),
      );
    case "revoked":
      return resolve(
        msg("No longer accepts {host}. Remove it here, then invite it again.", {
          host: hostLabel,
        }),
      );
  }
}

/** Members answer HTTPS on the port they already serve, which is what the main host dials. */
export function defaultClusterInviteUrl(httpBaseUrl: string | null): string {
  const url = httpBaseUrl === null ? null : URL.parse(httpBaseUrl);
  return url === null ? "" : `https://${url.host}`;
}
