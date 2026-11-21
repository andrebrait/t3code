import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type {
  CommandId,
  EnvironmentId,
  ProjectMutation,
  ProjectId,
  ServerConfig,
  ServerSettings,
  SourceControlDiscoveryResult,
  SourceControlRepositoryInfo,
} from "@t3tools/contracts";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { cloneUrlRepositoryPath } from "@t3tools/shared/cloneUrl";
import { isAbsolutePath, isExplicitRelativePath, newProjectFolderName } from "@t3tools/shared/path";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseParentPath,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../state/projects.ts";
import type { EnvironmentProject } from "../state/models.ts";
import { sourceControlClients } from "../sourceControlClients.ts";
import type { SourceControlDefinition } from "../sourceControlClients.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import { sourceControlInstallHintText } from "../contractLabels.ts";

export type AddProjectRemoteSource = SourceControlProviderKind | "url";

export function canCreateProjectInEnvironment(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
): boolean {
  return connectionPhase === "connected";
}

export function availableScratchWorkspaceRoot(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
  serverConfig: Pick<ServerConfig, "scratchWorkspaceRoot"> | null | undefined,
): string | null {
  return canCreateProjectInEnvironment(connectionPhase)
    ? (serverConfig?.scratchWorkspaceRoot ?? null)
    : null;
}

export interface AddProjectRemoteSourceReadinessEntry {
  readonly ready: boolean;
  readonly hint: string | null;
}

export type AddProjectRemoteSourceReadiness = (
  source: AddProjectRemoteSource,
) => AddProjectRemoteSourceReadinessEntry;

export type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

const ADD_PROJECT_REMOTE_PROVIDER_SOURCES: ReadonlyArray<SourceControlProviderKind> =
  sourceControlClients.definitions.map((definition) => definition.kind);

export function addProjectRemoteSourceLabel(
  source: AddProjectRemoteSource,
  resolve: MFunctionType = mFallback,
): string {
  return source === "url" ? resolve(msg("Git URL")) : sourceControlClients.get(source).pickerLabel;
}

export function addProjectRemoteSourcePathHint(
  source: AddProjectRemoteSource,
  resolve: MFunctionType = mFallback,
): string {
  return source === "url"
    ? resolve(msg("URL", { $context: "placeholder for a git URL field" }))
    : sourceControlClients.get(source).repositoryPathHint;
}

export function addProjectRemoteSourceProvider(
  source: AddProjectRemoteSource,
): SourceControlProviderKind | null {
  return source === "url" ? null : source;
}

export function parseAddProjectRemoteSource(
  value: string | null | undefined,
): AddProjectRemoteSource {
  return (value ? sourceControlClients.find(value)?.kind : undefined) ?? "url";
}

const REPOSITORY_SHORTHAND = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+(?:\.git)?$/;

/**
 * The clone URL of `owner/name` on the public host of the host a repository reads as before it
 * reports one. Null when that host has no public host.
 */
export function defaultHostCloneUrl(repository: string): string | null {
  const definition = sourceControlClients.get(undefined);
  if (definition.publicHost === null) return null;
  const path = repository.endsWith(".git") ? repository : `${repository}.git`;
  return definition.defaultCloneTransport === "https"
    ? `https://${definition.publicHost}/${path}`
    : `git@${definition.publicHost}:${path}`;
}

/** Owner present, repository name missing: `owner/` or `owner//`. */
const INCOMPLETE_GITHUB_OWNER_PATH = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})\/+$/;

/**
 * Message to show when a GitHub add-project field is only `owner/`.
 * Lookup would send that to GitHub and come back as a generic failure.
 * Returns null for complete names, bare repo names, URLs, and other sources.
 */
export function githubIncompleteOwnerRepositoryMessage(
  source: AddProjectRemoteSource,
  input: string,
  resolve: MFunctionType = mFallback,
): string | null {
  if (source !== "github") return null;
  if (!INCOMPLETE_GITHUB_OWNER_PATH.test(input.trim())) return null;
  return resolve(msg("Enter the full owner/repository name."));
}

export function normalizePastedCloneUrl(input: string): string {
  const trimmed = input.trim();
  if (REPOSITORY_SHORTHAND.test(trimmed)) return defaultHostCloneUrl(trimmed) ?? trimmed;
  return sourceControlClients.repositoryUrlFromPage(trimmed) ?? trimmed;
}

export function getDefaultCloneUrl(
  repository: Pick<SourceControlRepositoryInfo, "provider" | "url" | "sshUrl">,
): string {
  return sourceControlClients.get(repository.provider).defaultCloneTransport === "https"
    ? repository.url
    : repository.sshUrl;
}

export type OfferedSourceControlProviders = ServerSettings["offeredSourceControlProviders"];

/** Whether the project pickers offer a host. Only the default host is on until the user turns others on. */
export function isSourceControlProviderOffered(
  offered: OfferedSourceControlProviders | undefined,
  kind: SourceControlProviderKind,
): boolean {
  return offered?.[kind] ?? kind === sourceControlClients.get(undefined).kind;
}

export function sortAddProjectProviderSources(
  readiness: AddProjectRemoteSourceReadiness,
  offered: OfferedSourceControlProviders | undefined,
): ReadonlyArray<SourceControlProviderKind> {
  return Arr.sort(
    ADD_PROJECT_REMOTE_PROVIDER_SOURCES.filter((source) =>
      isSourceControlProviderOffered(offered, source),
    ),
    Order.mapInput(
      Order.Struct({
        ready: Order.flip(Order.Boolean),
        label: Order.String,
      }),
      (source: SourceControlProviderKind) => ({
        ready: readiness(source).ready,
        label: addProjectRemoteSourceLabel(source),
      }),
    ),
  );
}

const READY: AddProjectRemoteSourceReadinessEntry = { ready: true, hint: null };
const UNAVAILABLE_HINT = msg(
  "Provider status unavailable. Open Source Control settings and rescan.",
);

export function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
  resolve: MFunctionType = mFallback,
): AddProjectRemoteSourceReadiness {
  const providerByKind = new Map(
    (discovery?.sourceControlProviders ?? []).map((provider) => [provider.kind, provider]),
  );
  return (source) => {
    if (source === "url") return READY;
    const provider = providerByKind.get(source);
    if (!provider) return { ready: false, hint: resolve(UNAVAILABLE_HINT) };
    if (provider.status !== "available") {
      return { ready: false, hint: sourceControlInstallHintText(provider.installHint, resolve) };
    }
    if (provider.auth.status === "unauthenticated") {
      return {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          resolve(
            msg(
              "{provider} is not authenticated. Open Source Control settings for setup guidance.",
              { provider: provider.label },
            ),
          ),
      };
    }
    return READY;
  };
}

export function getAddProjectInitialQuery(baseDirectory: string | null | undefined): string {
  const trimmed = baseDirectory?.trim() ?? "";
  if (trimmed.length === 0) return "~/";
  // A bare relative setting such as `Desktop/dev` means a folder under home. The browser
  // navigates `~/` but not `~\` home paths.
  const isAnchored =
    trimmed === "~" ||
    isAbsolutePath(trimmed) ||
    trimmed.startsWith("~/") ||
    isExplicitRelativePath(trimmed);
  return ensureBrowseDirectoryPath(isAnchored ? trimmed : `~/${trimmed}`);
}

export function getCloneDirectoryName(repositoryOrRemoteUrl: string | null | undefined): string {
  const withoutQuery = (repositoryOrRemoteUrl ?? "").split(/[?#]/)[0]?.trim() ?? "";
  const schemeIndex = withoutQuery.indexOf("://");
  const hasHost = schemeIndex >= 0 || /^[^/\\:]+@[^/\\:]+:/.test(withoutQuery);
  const pathPart = schemeIndex >= 0 ? withoutQuery.slice(schemeIndex + "://".length) : withoutQuery;
  const segments = pathPart.split(/[/\\:]+/).filter((segment) => segment.trim().length > 0);
  if (hasHost && segments.length < 2) {
    return "";
  }

  const lastSegment = segments.at(-1)?.trim() ?? "";
  if (hasHost && segments.length === 2 && /^\d+$/.test(lastSegment)) {
    return "";
  }
  return lastSegment.endsWith(".git") ? lastSegment.slice(0, -".git".length) : lastSegment;
}

/** The folder a clone gets below its base: `<repo>`, or `<host>/<owner>/<repo>` like ghq. */
export function getCloneDirectoryPath(
  remoteUrl: string,
  ghqCloneLayout: boolean,
  repository = remoteUrl,
): string {
  return (
    (ghqCloneLayout ? cloneUrlRepositoryPath(remoteUrl) : null) ?? getCloneDirectoryName(repository)
  );
}

/** The clone's own folder, which folder browsing keeps at the end of the destination. */
export function getCloneDirectoryLeafName(
  remoteUrl: string,
  ghqCloneLayout: boolean,
  repository = remoteUrl,
): string {
  return getCloneDirectoryPath(remoteUrl, ghqCloneLayout, repository).split("/").at(-1) ?? "";
}

export function getCloneDestinationPath(
  directoryPath: string,
  directoryName: string | null | undefined,
): string {
  const name = directoryName?.trim() ?? "";
  if (name.length === 0) {
    return directoryPath;
  }
  const base = ensureBrowseDirectoryPath(directoryPath);
  return `${base}${base.endsWith("\\") ? name.replaceAll("/", "\\") : name}`;
}

/** Where a clone lands by default: the machine's Add Project base folder, then the repository. */
export function getDefaultCloneDestinationPath(
  remoteUrl: string,
  settings: Pick<ServerSettings, "addProjectBaseDirectory" | "ghqCloneLayout"> | undefined,
): string {
  return getCloneDestinationPath(
    getAddProjectInitialQuery(settings?.addProjectBaseDirectory),
    getCloneDirectoryPath(remoteUrl, settings?.ghqCloneLayout === true),
  );
}

/**
 * Where clone-on-demand puts a project: the path it has on the machine it is cloned from. Under
 * that machine's home it becomes `~/…`, so it maps onto a machine whose home differs. Without
 * the source path or home, it falls back to the target's default.
 */
export function getClusterCloneDestinationPath(input: {
  readonly remoteUrl: string;
  readonly sourceWorkspaceRoot: string | null | undefined;
  readonly sourceHomeDirectory: string | null | undefined;
  readonly targetSettings:
    | Pick<ServerSettings, "addProjectBaseDirectory" | "ghqCloneLayout">
    | undefined;
}): string {
  const root = input.sourceWorkspaceRoot?.trim() ?? "";
  const home = input.sourceHomeDirectory?.trim().replace(/[\\/]+$/, "") ?? "";
  if (!root || !home || root === home) {
    return getDefaultCloneDestinationPath(input.remoteUrl, input.targetSettings);
  }
  const separator = root[home.length];
  if (root.startsWith(home) && (separator === "/" || separator === "\\")) {
    return `~/${root.slice(home.length + 1).replaceAll("\\", "/")}`;
  }
  return root;
}

/**
 * The remote a clone of the project comes from, or null when it has none. Projects group by
 * their origin remote, so a clone from it groups with the project; an origin without a known
 * URL gives null rather than a clone that would group apart.
 */
export function projectCloneRemoteUrl(
  project: Pick<EnvironmentProject, "repositoryIdentity">,
): string | null {
  const identity = project.repositoryIdentity;
  if (!identity) return null;
  return identity.origin ? (identity.origin.remoteUrl ?? null) : identity.locator.remoteUrl;
}

/**
 * Cluster machines that can clone a project living on `projectEnvironmentId`: the online
 * members of that machine's cluster, plus its main host when the project lives on a member.
 * Machines in `hasProject` are left out. Callers check the project has a remote to clone.
 */
export function clusterCloneEnvironmentIds(input: {
  readonly project: Pick<EnvironmentProject, "environmentId">;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly entry: Pick<ConnectionCatalogEntry, "enabled" | "target">;
    readonly connection: { readonly phase: EnvironmentConnectionPhase };
  }>;
  readonly hasProject: ReadonlySet<EnvironmentId>;
}): EnvironmentId[] {
  const projectTarget = input.environments.find(
    (environment) => environment.environmentId === input.project.environmentId,
  )?.entry.target;
  if (!projectTarget) return [];
  const hostId =
    projectTarget._tag === "ClusterConnectionTarget"
      ? projectTarget.hostEnvironmentId
      : projectTarget.environmentId;
  return input.environments
    .filter(({ environmentId, entry, connection }) => {
      if (!entry.enabled || connection.phase !== "connected") return false;
      if (input.hasProject.has(environmentId) || environmentId === input.project.environmentId)
        return false;
      return entry.target._tag === "ClusterConnectionTarget"
        ? entry.target.hostEnvironmentId === hostId && entry.target.status === "online"
        : environmentId === hostId;
    })
    .map((environment) => environment.environmentId);
}

export function getNewProjectPathPreview(newProjectsRoot: string, name: string): string {
  return getCloneDestinationPath(newProjectsRoot, newProjectFolderName(name));
}

export interface NewProjectPublishTarget {
  readonly definition: SourceControlDefinition;
  readonly owner: string | null;
}

export function getNewProjectPublishTargets(
  discovery: SourceControlDiscoveryResult | null,
  offered: OfferedSourceControlProviders | undefined,
): ReadonlyArray<NewProjectPublishTarget> {
  const readiness = buildAddProjectRemoteSourceReadiness(discovery);
  return sourceControlClients.definitions.flatMap((definition) => {
    if (!isSourceControlProviderOffered(offered, definition.kind)) return [];
    if (!readiness(definition.kind).ready) return [];
    const provider = discovery?.sourceControlProviders.find(
      (candidate) => candidate.kind === definition.kind,
    );
    const placement = definition.newRepositoryOwner(
      provider ? Option.getOrNull(provider.auth.account) : null,
    );
    return placement === null ? [] : [{ definition, owner: placement.owner }];
  });
}

export function getNewProjectPublishTarget(
  targets: ReadonlyArray<NewProjectPublishTarget>,
  kind: SourceControlProviderKind | null,
): NewProjectPublishTarget | null {
  return targets.find((target) => target.definition.kind === kind) ?? targets[0] ?? null;
}

export function getNewProjectRepository(
  target: Pick<NewProjectPublishTarget, "owner">,
  workspaceRoot: string,
): string {
  const folderName = workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return target.owner ? `${target.owner}/${folderName}` : folderName;
}

export function getCloneDestinationBrowsePath(input: {
  readonly browseDirectoryPath: string;
  readonly selectedDirectoryName: string;
  readonly cloneDirectoryName: string;
  readonly caseSensitive: boolean;
}): string {
  const selectedDirectoryPath = appendBrowsePathSegment(
    input.browseDirectoryPath,
    input.selectedDirectoryName,
  );
  const selectedDirectoryMatches = input.caseSensitive
    ? input.selectedDirectoryName === input.cloneDirectoryName
    : input.selectedDirectoryName.toLowerCase() === input.cloneDirectoryName.toLowerCase();
  return selectedDirectoryMatches
    ? selectedDirectoryPath
    : getCloneDestinationPath(selectedDirectoryPath, input.cloneDirectoryName);
}

// The native picker returns a full path, not a name under the browsed directory.
// Split it and reuse the in-app rules so a folder already named after the
// repository stays that folder instead of becoming repo/repo.
export function getCloneDestinationForPickedFolder(input: {
  readonly pickedPath: string;
  readonly cloneDirectoryName: string;
  readonly caseSensitive: boolean;
}): string {
  const parentPath = getBrowseParentPath(input.pickedPath);
  if (parentPath === null) {
    return getCloneDestinationPath(input.pickedPath, input.cloneDirectoryName);
  }
  return getCloneDestinationBrowsePath({
    browseDirectoryPath: parentPath,
    selectedDirectoryName: inferProjectTitleFromPath(input.pickedPath),
    cloneDirectoryName: input.cloneDirectoryName,
    caseSensitive: input.caseSensitive,
  });
}

export function resolveAddProjectPath(
  input: {
    readonly rawPath: string;
    readonly currentProjectCwd?: string | null;
    readonly platform: string;
  },
  resolve: MFunctionType = mFallback,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string } {
  const rawPath = input.rawPath.trim();
  if (rawPath.length === 0) {
    return { ok: false, error: resolve(msg("Enter a project path.")) };
  }
  if (isUnsupportedWindowsProjectPath(rawPath, input.platform)) {
    return {
      ok: false,
      error: resolve(msg("Windows-style paths are only supported on Windows environments.")),
    };
  }
  if (isExplicitRelativeProjectPath(rawPath) && !input.currentProjectCwd) {
    return {
      ok: false,
      error: resolve(msg("Relative paths require an active project in this environment.")),
    };
  }
  const path = resolveProjectPathForDispatch(rawPath, input.currentProjectCwd);
  return path.length === 0
    ? { ok: false, error: resolve(msg("Enter a project path.")) }
    : { ok: true, path };
}

export function findExistingAddProject(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId;
  readonly path: string;
}): EnvironmentProject | null {
  return (
    findProjectByPath(
      input.projects.filter((project) => project.environmentId === input.environmentId),
      input.path,
    ) ?? null
  );
}

export function buildProjectCreateCommand(input: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}): Extract<ProjectMutation, { type: "project.create" }> {
  return {
    type: "project.create",
    commandId: input.commandId,
    projectId: input.projectId,
    title: inferProjectTitleFromPath(input.workspaceRoot),
    workspaceRoot: input.workspaceRoot,
    createWorkspaceRootIfMissing: true,
    defaultModelSelection: null,
  };
}
