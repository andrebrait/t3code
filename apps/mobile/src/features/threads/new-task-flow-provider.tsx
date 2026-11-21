import { ActiveNewTaskContext } from "../../state/active-new-task";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { msg, useMessages } from "gt-react-native";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { useNowMinuteMs } from "../../lib/clock";
import { m, type MessageResolver } from "../../i18n/messages";
import * as Dialog from "../../components/ui/Dialog";
import React, { useEffect, useEffectEvent, useRef, useState } from "react";

import type {
  EnvironmentId,
  ModelSelection,
  ProviderOptionSelection,
  RuntimeMode,
  ServerProvider,
  ThreadContextRecord,
} from "@t3tools/contracts";
import {
  AuthSourceControlWriteScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  repositoryGroupingKeyOf,
  ThreadId,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  threadContextsOutsideEnvironment,
} from "@t3tools/shared/composerContextReferences";
import {
  activeLoadBalancingPool,
  type LoadBalancingPool,
  loadBalancingCandidateIds,
  loadBalancingPools,
  loadBalancingSendWarning,
  pickLoadBalancedEnvironment,
  sortEnvironmentOptionsByCluster,
} from "@t3tools/client-runtime/load-balancing";
import { AsyncResult } from "effect/reactivity";
import { isTriagePrompt, replaceTriagePlaybookLink } from "@t3tools/shared/triagePrompt";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";

import {
  useProjects,
  useServerConfigs,
  useThreadShells,
  waitForProject,
} from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { uuidv4 } from "../../lib/uuid";
import type { TurnCommandMetadata } from "../../lib/commandMetadata";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import {
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
  resolveSelectableModelSelection,
  serverConfigForCwd,
} from "../../lib/modelOptions";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useAtomValue } from "@effect/atom-react";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  appendComposerDraftAttachments,
  type ComposerDraftInsertion,
  type ComposerDraftLoadBalancing,
  type ComposerDraftWorkspaceSelection,
  composerDraftsLoadedAtom,
  createNewTaskDraft,
  getComposerDraftSnapshot,
  isNewTaskDraftKey,
  removeComposerDraftAttachment,
  replaceComposerDraftAttachments,
  retargetNewTaskDraft,
  setComposerDraftText,
  setStickyComposerModelSelection,
  updateComposerDraftSettings,
  useComposerDraft,
  useStickyComposerModelSelection,
} from "../../state/use-composer-drafts";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import { useBranches, usePaginatedBranches } from "../../state/queries";
import { vcsEnvironment } from "../../state/vcs";
import { type QueuedThreadMessage } from "../../state/thread-outbox";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import {
  availableScratchWorkspaceRoot,
  clusterCloneEnvironmentIds,
  getSourceCloneDestinationPath,
  projectCloneRemoteUrl,
} from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type VcsRef } from "@t3tools/client-runtime/state/vcs";
import {
  buildHomeProjectScopes,
  sortHomeProjectScopes,
  type HomeProjectScope,
} from "../home/homeThreadList";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import {
  resolveNewTaskDraftWorkspace,
  resolveNewTaskBranchWorktreePath,
  resolveNewTaskLocalWorkspaceSelection,
} from "./new-task-context-presentation";
import { isSameRepository, resolveEnvironmentProjectMatch } from "./new-task-project-selection";
import { useNewTaskProjectDefaults } from "./use-new-task-project-defaults";
import { resolveNewThreadRuntimeMode } from "./thread-settings-options";
import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";
import {
  INACTIVE_FLOW_KEY,
  type NewTaskFlowState,
  newTaskFlowStateAtom,
  readNewTaskFlowState,
  resolveRouteDraft,
  type RouteDraftResolution,
  stampedEnvironmentProjectsLoading,
  updateNewTaskFlowState,
} from "./new-task-flow-state";
import { usePrepareTriage } from "../triage/usePrepareTriage";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { useConnectionsReady, useWorkspaceEnvironments } from "../../state/workspace";

type WorkspaceMode = "local" | "worktree";

export function branchBadgeLabel(
  input: {
    readonly branch: VcsRef;
    readonly project: EnvironmentProject | null;
  },
  resolve: MessageResolver = m,
): string | null {
  if (input.branch.current) {
    return resolve(msg("current", { $context: "branch badge, the checked-out branch" }));
  }
  if (input.branch.worktreePath && input.branch.worktreePath !== input.project?.workspaceRoot) {
    return resolve(msg("worktree", { $context: "branch badge, checked out in another worktree" }));
  }
  if (input.branch.isRemote) {
    return resolve(msg("remote", { $context: "branch badge, a remote-tracking branch" }));
  }
  if (input.branch.isDefault) {
    return resolve(msg("default", { $context: "branch badge, the repository default branch" }));
  }
  return null;
}

// Outside the component: the React compiler's purity check flags this read inside it.
const nowIso = () => new Date().toISOString();

function confirmClone(names: {
  readonly repository: string;
  readonly machine: string;
  readonly path: string;
}): Promise<boolean> {
  return new Promise((resolve) =>
    Dialog.confirm({
      title: m(msg("Clone {repository} onto {machine}?", names)),
      message: m(msg("It will be cloned into {path} before the thread starts.", names)),
      confirmText: m(msg("Clone", { $context: "clone a repository" })),
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    }),
  );
}

export interface AutoPoolOption {
  readonly key: string;
  readonly label: string;
  readonly cluster: boolean;
  /** Machines in the pool without the project, which Auto skips. */
  readonly missingLabels: ReadonlyArray<string>;
  readonly active: boolean;
}

/**
 * The Auto choices for the selected project. A hook so the compiler treats its inputs as
 * frozen: deriving pools in the provider body stops it caching the machine list.
 */
function useAutoPools(input: {
  readonly environments: ReturnType<typeof useEnvironments>["environments"];
  readonly isScratchDraft: boolean;
  readonly selectedProject: EnvironmentProject | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly flowState: NewTaskFlowState;
  readonly loadBalancing: ComposerDraftLoadBalancing | undefined;
  readonly workspaceSelection: ComposerDraftWorkspaceSelection | undefined;
}) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const { selectedProject, flowState } = input;
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
  const loadBalancingWeights = preferences.loadBalancingWeights ?? {};
  // Auto balances only across clones of the same repository; weaker matches stay manual.
  const sameRepository = new Set<EnvironmentId>(
    selectedProject ? [selectedProject.environmentId] : [],
  );
  for (const project of input.projects) {
    if (isSameRepository(project, selectedProject)) sameRepository.add(project.environmentId);
  }
  const pools = input.isScratchDraft
    ? []
    : loadBalancingPools({
        environments: input.environments,
        weights: loadBalancingWeights,
        hasProject: sameRepository,
        autoEnabled: preferences.loadBalancingEnabled === true,
      });
  // Read from the saved draft, so a reopened draft stays where its branch or worktree lives.
  // A pull request checkout is recreated on whichever machine Auto picks.
  const selection = input.workspaceSelection;
  const pinnedByWorkspace =
    selection !== undefined &&
    selection.pullRequestReference === undefined &&
    (selection.branch !== null ||
      (selection.worktreePath !== null &&
        selection.worktreePath !== selectedProject?.workspaceRoot));
  const activePool =
    selectedProject && !input.loadBalancing?.manual && !pinnedByWorkspace
      ? activeLoadBalancingPool(pools, input.loadBalancing?.pool, selectedProject.environmentId)
      : null;
  return {
    loadBalancingWeights,
    activePool,
    autoPools: autoPoolOptions(pools, activePool),
    autoBalance: activePool
      ? {
          label: autoPoolLabel(activePool),
          missingLabels: activePool.missingLabels,
          status:
            flowState.autoPick === null
              ? ("pending" as const)
              : flowState.autoPick.environmentId === null
                ? ("failed" as const)
                : ("resolved" as const),
          acknowledged: input.loadBalancing?.acknowledged === activePool.key,
        }
      : null,
  };
}

function autoPoolLabel(pool: LoadBalancingPool): string {
  return pool.cluster
    ? m(msg("{cluster} (load balanced)", { cluster: pool.cluster.label }))
    : m(msg("Auto balance"));
}

function autoPoolOptions(
  pools: ReadonlyArray<LoadBalancingPool>,
  activePool: LoadBalancingPool | null,
): AutoPoolOption[] {
  return pools.map((pool) => ({
    key: pool.key,
    label: autoPoolLabel(pool),
    cluster: pool.cluster !== null,
    missingLabels: pool.missingLabels,
    active: pool.key === activePool?.key,
  }));
}

type NewTaskFlowContextValue = {
  readonly activeNewTask: { readonly pendingKey: string | null } | null;
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly selectedModelKey: string | null;
  readonly workspaceMode: WorkspaceMode;
  readonly isGitRepo: boolean;
  readonly isGitRepoKnown: boolean;
  readonly canChooseWorkspace: boolean;
  readonly selectedBranchName: string | null;
  readonly selectedWorktreePath: string | null;
  /** Where the draft's agent will run: the selected worktree, else the project root. */
  readonly workspaceCwd: string | null;
  readonly resolveWorkspaceSelection: (
    selection: ComposerDraftWorkspaceSelection | undefined,
  ) => ComposerDraftWorkspaceSelection;
  readonly startFromOrigin: boolean;
  readonly pullRequestReference: string | undefined;
  readonly draftKey: string | null;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly submitting: boolean;
  readonly branchesLoading: boolean;
  readonly availableBranches: ReadonlyArray<VcsRef>;
  readonly currentCheckoutBranchName: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly expandedProvider: string | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    /** A cluster machine without the project, which offers to clone it from this remote when picked. */
    readonly cloneRemoteUrl?: string;
  }>;
  readonly selectedProject: EnvironmentProject | null;
  /** The machines the selected project's environment links to, whose threads it can read. */
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly isScratchDraft: boolean;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly selectedModel: ModelSelection | null;
  readonly selectedModelOption: ModelOption | null;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly setProject: (project: EnvironmentProject) => void;
  /** The flow's project, read when a continuation resumes after an await. */
  readonly getSelectedProjectKey: () => string | null;
  /**
   * The route this flow serves when its draft cannot open: the draft is gone
   * (`missing`) or only its project is (`pickProject`). Only the topmost draft
   * route is served, so a screen compares `draftId` with its own draft id.
   */
  readonly unopenableRouteDraft: {
    readonly draftId: string;
    readonly kind: "missing" | "pickProject";
  } | null;
  readonly selectEnvironment: (environmentId: EnvironmentId) => void;
  /** The Auto choices: every machine with the switch on, then each cluster. */
  readonly autoPools: ReadonlyArray<AutoPoolOption>;
  /** Set while Auto picks this draft's machine; null after the user picked one. */
  readonly autoBalance: {
    readonly label: string;
    readonly missingLabels: ReadonlyArray<string>;
    readonly status: "pending" | "resolved" | "failed";
    readonly acknowledged: boolean;
  } | null;
  readonly chooseAutoPool: (poolKey: string) => void;
  /** Keeps the draft on its machine, as choosing a branch does. */
  readonly pinEnvironment: () => void;
  /** After Auto found no machine, picks again; the machine picked, or null. */
  readonly retryAutoBalance: () => Promise<EnvironmentId | null>;
  readonly acknowledgeAutoBalance: () => void;
  /** Why an Auto send cannot start yet. */
  readonly autoBalanceWarning: () => { readonly title: string; readonly description: string };
  readonly switchEnvironment: (environmentId: EnvironmentId) => Promise<boolean>;
  readonly switchingToEnvironmentId: EnvironmentId | null;
  readonly setSelectedModelKey: (
    key: string | null,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
  readonly setWorkspaceMode: (mode: WorkspaceMode) => void;
  readonly selectBranch: (branch: VcsRef) => void;
  readonly setStartFromOrigin: (value: boolean) => void;
  readonly buildPendingTaskMessage: (
    metadata: TurnCommandMetadata,
    options?: {
      readonly currentCheckoutBranch?: string | null;
    },
  ) => QueuedThreadMessage | null;
  readonly setPrompt: (value: string) => void;
  readonly replaceAttachments: (attachments: ReadonlyArray<DraftComposerAttachment>) => void;
  /** Appends draft attachments; returns how many the live cap rejected. */
  readonly appendAttachments: (
    attachments: ReadonlyArray<DraftComposerAttachment>,
    insertion?: ComposerDraftInsertion,
  ) => number;
  readonly removeAttachment: (imageId: string) => void;
  readonly clearAttachments: () => void;
  readonly setSubmitting: (value: boolean) => void;
  readonly loadBranches: () => void;
  readonly setRuntimeMode: (value: RuntimeMode) => void;
  readonly setSelectedModelOptions: (
    value: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) => void;
  readonly setExpandedProvider: (value: string | null) => void;
};

const NewTaskFlowContext = React.createContext<NewTaskFlowContextValue | null>(null);

export function NewTaskFlowProvider(
  props: React.PropsWithChildren<{
    active?: boolean;
    /** Identifies the draft route this flow serves; a new key starts a fresh flow. */
    flowKey?: string;
    routeDraftId?: string;
  }>,
) {
  const projects = useProjects();
  const messages = useMessages();
  const threads = useThreadShells();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const groupingSettings = useMobileProjectGroupingSettings();

  const projectScopes = sortHomeProjectScopes({
    scopes: buildHomeProjectScopes(
      {
        projects,
        environmentId: null,
        projectGroupingMode: groupingSettings.sidebarProjectGroupingMode,
      },
      messages,
    ),
    threads,
    pendingTasks: [],
    projectSortOrder: "updated_at",
  });

  const flowKey = props.flowKey ?? INACTIVE_FLOW_KEY;
  const storedFlowState = useAtomValue(newTaskFlowStateAtom(flowKey));
  const draftsLoaded = useAtomValue(composerDraftsLoadedAtom);
  // A draft route opened from a list row, a deep link, or restored state binds
  // its draft here until the flow's first write stores the binding.
  const routeDraft = useComposerDraft(
    storedFlowState.draftKey === null ? (props.routeDraftId ?? null) : null,
  );
  // Readiness of the environment the route's draft is stamped to; another
  // environment's projects loading first says nothing about it.
  const stampedEnvironmentId = routeDraft.project?.environmentId ?? null;
  const connectionsReady = useConnectionsReady();
  const stampedEnvironmentConnection =
    useWorkspaceEnvironments().find(
      (environment) => environment.environmentId === stampedEnvironmentId,
    )?.connectionState ?? null;
  const stampedEnvironmentShell = useEnvironmentShellReadiness(stampedEnvironmentId);
  const stampedEnvironmentLoading = stampedEnvironmentProjectsLoading({
    connectionsReady,
    connectionState: stampedEnvironmentConnection,
    shellCacheRead: stampedEnvironmentShell.cacheRead,
    shellStatus: stampedEnvironmentShell.status,
    shellHasError: stampedEnvironmentShell.hasError,
  });
  const resolveRoute = (
    flow: NewTaskFlowState,
    loaded: boolean,
    stamp: Parameters<typeof resolveRouteDraft>[0]["stamp"],
  ): RouteDraftResolution =>
    resolveRouteDraft({
      flow,
      routeDraftId: props.routeDraftId,
      draftsLoaded: loaded,
      stamp,
      projects,
      stampedEnvironmentLoading,
    });
  const routeDraftResolution = resolveRoute(storedFlowState, draftsLoaded, routeDraft.project);
  const flowState =
    routeDraftResolution.kind === "open" ? routeDraftResolution.flow : storedFlowState;
  const {
    environmentId: selectedEnvironmentIdOverride,
    projectKey: selectedProjectKey,
    draftKey: activeDraftKey,
    submitting,
    expandedProvider,
  } = flowState;
  // Continuations read the flow at use time, with the route's draft applied.
  const readFlow = (): NewTaskFlowState => {
    const stored = readNewTaskFlowState(flowKey);
    const resolution = resolveRoute(
      stored,
      appAtomRegistry.get(composerDraftsLoadedAtom),
      props.routeDraftId === undefined
        ? undefined
        : getComposerDraftSnapshot(props.routeDraftId).project,
    );
    return resolution.kind === "open" ? resolution.flow : stored;
  };
  // Every flow write stores the route's draft binding along with it, so the
  // binding outlives the draft's project stamp (submit clears it).
  const updateFlow = (patch: Partial<NewTaskFlowState>) =>
    updateNewTaskFlowState(flowKey, { ...readFlow(), ...patch });
  // A draft's project stamp is the selection: picking a project writes it, and uploads and
  // the send read it, so the screen cannot show one project while the draft holds another.
  const draftStamp = useComposerDraft(activeDraftKey).project;
  const stampedProject =
    draftStamp === undefined
      ? undefined
      : projects.find(
          (project) =>
            project.environmentId === draftStamp.environmentId &&
            project.id === draftStamp.projectId,
        );
  const selectedEnvironmentId =
    stampedProject?.environmentId ??
    (selectedEnvironmentIdOverride !== null &&
    projects.some((project) => project.environmentId === selectedEnvironmentIdOverride)
      ? selectedEnvironmentIdOverride
      : (projects[0]?.environmentId ?? null));
  const projectsForEnvironment = pipe(
    projects,
    Arr.filter((project) => project.environmentId === selectedEnvironmentId),
  );

  // A route draft still waiting for its environment has no project yet: the
  // fallback would show, and could send to, another environment's project.
  const selectedProject =
    routeDraftResolution.kind === "pending"
      ? null
      : (stampedProject ??
        projectsForEnvironment.find(
          (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
        ) ??
        projectsForEnvironment[0] ??
        null);

  const linkedEnvironments = useLinkedEnvironments(selectedProject?.environmentId ?? null);
  const storedStickyModelSelection = useStickyComposerModelSelection();
  const modelSelectionNow = useNowMinuteMs();
  const projectDefaults = useNewTaskProjectDefaults(selectedProject);
  const isScratchDraft = projectDefaults.isScratch;
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const { environments: environmentPresentations, presentationById } = useEnvironments();
  const canClone = useEnvironmentsWithScope(environmentPresentations, AuthSourceControlWriteScope);
  const selectedProjectDraftKey = selectedProject ? activeDraftKey : null;
  const selectedProjectDraft = useComposerDraft(selectedProjectDraftKey);
  const { loadBalancingWeights, activePool, autoPools, autoBalance } = useAutoPools({
    environments: environmentPresentations,
    isScratchDraft,
    selectedProject,
    projects,
    flowState,
    loadBalancing: selectedProjectDraft.loadBalancing,
    workspaceSelection: selectedProjectDraft.workspaceSelection,
  });
  const activePendingKey =
    props.active === false
      ? null
      : props.routeDraftId
        ? `draft-task:${props.routeDraftId}`
        : selectedProjectDraftKey
          ? `draft-task:${selectedProjectDraftKey}`
          : null;
  const activeNewTask = props.active === false ? null : { pendingKey: activePendingKey };
  const prompt = selectedProjectDraft.text;
  const attachments = selectedProjectDraft.attachments;
  const projectGitStatus = useEnvironmentQuery(
    props.active !== false && selectedProject !== null && selectedProject.workspaceRoot !== ""
      ? vcsEnvironment.status({
          environmentId: selectedProject.environmentId,
          input: { cwd: selectedProject.workspaceRoot },
        })
      : null,
  );
  const currentCheckoutBranchName = projectGitStatus.data?.refName ?? null;
  // The unfiltered ref list also provides repository capability while offline.
  const projectBranches = useBranches({
    environmentId: selectedProject?.environmentId ?? null,
    cwd: selectedProject?.workspaceRoot || null,
  });
  const knownIsGitRepo = projectGitStatus.data?.isRepo ?? projectBranches.data?.isRepo ?? null;
  const isGitRepo = knownIsGitRepo ?? true;
  const projectSettings = projectDefaults.projectSettings;
  const canChooseWorkspace = !isScratchDraft;
  const defaultWorkspaceMode: WorkspaceMode = projectDefaults.defaultWorkspaceMode;
  const branchState = usePaginatedBranches({
    environmentId: selectedProject?.environmentId ?? null,
    cwd: selectedProject?.workspaceRoot || null,
  });
  const branchesLoading = branchState.isPending && branchState.data === null;
  const allBranchRefs = branchState.refs;
  const availableBranches = pipe(
    allBranchRefs,
    Arr.filter((branch) => !branch.isRemote),
  );

  const resolveWorkspaceSelection = (selection: ComposerDraftWorkspaceSelection | undefined) =>
    resolveNewTaskDraftWorkspace({
      selection,
      canChooseWorkspace,
      defaultMode: defaultWorkspaceMode,
      defaultModeSettled: projectDefaults.defaultWorkspaceModeSettled,
      isGitRepo,
      branches: allBranchRefs,
      projectCwd: selectedProject?.workspaceRoot ?? null,
    });
  const workspaceSelection = resolveWorkspaceSelection(selectedProjectDraft.workspaceSelection);
  const workspaceMode = workspaceSelection.mode;
  const selectedBranchName = workspaceSelection.branch;
  const selectedWorktreePath = workspaceSelection.worktreePath;
  // A new worktree does not exist yet, so the project root stands in for it.
  const workspaceCwd =
    (workspaceMode === "worktree"
      ? selectedProject?.workspaceRoot
      : (selectedWorktreePath ?? selectedProject?.workspaceRoot)) || null;
  const selectedEnvironmentServerConfig = serverConfigForCwd(
    projectDefaults.serverConfig,
    workspaceCwd,
  );
  // Keep the user's explicit choice separate from the resolved display value:
  // only the explicit flag is ever written back to the draft, so the resolved
  // value keeps tracking the server setting when the config loads late.
  const draftStartFromOrigin = selectedProjectDraft.workspaceSelection?.startFromOrigin;
  const startFromOrigin =
    isGitRepo && (draftStartFromOrigin ?? projectSettings.settings.newWorktreesStartFromOrigin);
  const defaultRuntimeMode = projectSettings.settings.defaultRuntimeMode;
  const managedPolicy = selectedEnvironmentServerConfig?.managedPolicy;
  const runtimeMode = resolveNewThreadRuntimeMode(
    selectedProjectDraft.runtimeMode,
    defaultRuntimeMode,
    managedPolicy,
  );

  // Antigravity keeps unavailable selections so sign-out or a catalog change
  // cannot switch the user's model.
  const draftModelSelection = resolveSelectableModelSelection(
    selectedEnvironmentServerConfig,
    selectedProjectDraft.modelSelection ?? null,
    selectedProject?.id ?? null,
  );
  const projectDefaultModelSelection = resolveDefaultableModelSelection(
    selectedEnvironmentServerConfig,
    projectSettings.settings.defaultModelSelection,
    selectedProject?.id ?? null,
  );
  const stickyModelSelection = resolveDefaultableModelSelection(
    selectedEnvironmentServerConfig,
    storedStickyModelSelection,
    selectedProject?.id ?? null,
  );
  const modelOptions = buildModelOptions(
    selectedEnvironmentServerConfig,
    draftModelSelection ?? projectDefaultModelSelection ?? stickyModelSelection,
    undefined,
    selectedProject?.id ?? null,
  );

  const selectedDefaultModel = resolveNewTaskModelSelection({
    draftSelection: draftModelSelection,
    projectDefaultSelection: projectDefaultModelSelection,
    stickySelection: stickyModelSelection,
    modelOptions,
  });
  const selectedModel = resolveNewThreadModelSelection({
    defaultSelection: selectedDefaultModel,
    explicitSelection:
      draftModelSelection ?? (projectDefaultModelSelection ? null : stickyModelSelection),
    fallbackSelection: selectedEnvironmentServerConfig?.settings.fallbackModelSelection ?? null,
    providers: selectedEnvironmentServerConfig?.providers ?? [],
    ...(selectedEnvironmentServerConfig
      ? { settings: selectedEnvironmentServerConfig.settings }
      : {}),
    projectId: selectedProject?.id ?? null,
    now: modelSelectionNow,
  }).selection;
  const selectedModelKey = selectedModel
    ? `${selectedModel.instanceId}:${selectedModel.model}`
    : null;

  const selectedModelOption =
    modelOptions.find(
      (option) =>
        selectedModel &&
        option.selection.instanceId === selectedModel.instanceId &&
        option.selection.model === selectedModel.model,
    ) ?? null;
  const selectedProviderStatus =
    selectedEnvironmentServerConfig?.providers.find(
      (provider) => provider.instanceId === selectedModel?.instanceId,
    ) ?? null;
  const setSelectedModelKey = (
    key: string | null,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => {
    if (!key || !selectedProjectDraftKey) {
      return;
    }
    const option = modelOptions.find((candidate) => candidate.key === key);
    if (!option) {
      return;
    }
    const selection = withRememberedModelOptions(
      options ? { ...option.selection, options } : option.selection,
    );
    updateComposerDraftSettings(selectedProjectDraftKey, { modelSelection: selection });
    setStickyComposerModelSelection(selection);
  };
  const setSelectedModelOptions = (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
    if (!selectedModel || !selectedProjectDraftKey) {
      return;
    }
    rememberModelOptions(selectedModel.instanceId, selectedModel.model, options ?? []);
    const nextSelection: ModelSelection = options
      ? { ...selectedModel, options }
      : {
          instanceId: selectedModel.instanceId,
          model: selectedModel.model,
        };
    updateComposerDraftSettings(selectedProjectDraftKey, {
      modelSelection: nextSelection,
    });
    setStickyComposerModelSelection(nextSelection);
  };

  const providerGroups = groupByProvider(modelOptions);
  const setPrompt = (value: string) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    setComposerDraftText(selectedProjectDraftKey, value);
  };
  const replaceAttachments = (nextAttachments: ReadonlyArray<DraftComposerAttachment>) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    replaceComposerDraftAttachments(selectedProjectDraftKey, nextAttachments);
  };
  const appendAttachments = (
    nextAttachments: ReadonlyArray<DraftComposerAttachment>,
    insertion?: ComposerDraftInsertion,
  ): number => {
    if (!selectedProjectDraftKey) {
      return 0;
    }
    return appendComposerDraftAttachments(selectedProjectDraftKey, nextAttachments, {
      appendReference: true,
      insertion,
    });
  };
  const removeAttachment = (imageId: string) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    removeComposerDraftAttachment(selectedProjectDraftKey, imageId);
  };
  const clearAttachments = () => {
    if (!selectedProjectDraftKey) {
      return;
    }
    replaceComposerDraftAttachments(selectedProjectDraftKey, []);
  };

  const carryDraftContentTo = (
    project: EnvironmentProject,
    options?: Parameters<typeof retargetNewTaskDraft>[2],
  ): string => {
    const target = { environmentId: project.environmentId, projectId: project.id };
    const current = readFlow().draftKey;
    if (current !== null && isNewTaskDraftKey(current)) {
      retargetNewTaskDraft(current, target, options);
      return current;
    }
    return createNewTaskDraft(target);
  };

  const setProject = (project: EnvironmentProject) => {
    updateFlow({
      autoPick: null,
      draftKey: carryDraftContentTo(project),
      environmentId: project.environmentId,
      projectKey: scopedProjectKey(project.environmentId, project.id),
    });
  };

  const selectEnvironment = (environmentId: EnvironmentId) => {
    const match = resolveEnvironmentProjectMatch(
      projects.filter((project) => project.environmentId === environmentId),
      selectedProject,
    );
    updateFlow({
      // A name or title match may be another repository, which must not receive the PR checkout.
      draftKey: match
        ? carryDraftContentTo(match, {
            keepPullRequestWorkspace: isSameRepository(match, selectedProject),
          })
        : readFlow().draftKey,
      environmentId,
      projectKey: match ? scopedProjectKey(match.environmentId, match.id) : null,
    });
  };

  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const prepareTriage = usePrepareTriage();
  const [switchingToEnvironmentId, setSwitchingToEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const latestSwitchRef = useRef<object | null>(null);
  const switchEnvironment = async (environmentId: EnvironmentId): Promise<boolean> => {
    const switched = await switchEnvironmentTo(environmentId);
    if (switched) updateLoadBalancing({ manual: true });
    return switched;
  };
  const switchEnvironmentTo = async (environmentId: EnvironmentId): Promise<boolean> => {
    if (environmentId === selectedEnvironmentId) {
      latestSwitchRef.current = null;
      setSwitchingToEnvironmentId(null);
      return true;
    }
    const cloneRemoteUrl = environments.find(
      (environment) => environment.environmentId === environmentId,
    )?.cloneRemoteUrl;
    if (cloneRemoteUrl && selectedProject) return cloneToEnvironment(environmentId, cloneRemoteUrl);
    if (!isScratchDraft) {
      selectEnvironment(environmentId);
      return true;
    }
    const request = {};
    latestSwitchRef.current = request;
    setSwitchingToEnvironmentId(environmentId);
    // A triage draft takes its session along: the playbook and context files
    // exist only on the machine that prepared them.
    const { draftKey, projectKey } = readFlow();
    const triage =
      draftKey !== null && isTriagePrompt(getComposerDraftSnapshot(draftKey).text)
        ? await prepareTriage(environmentId)
        : null;
    const result =
      triage?._tag === "Failure" ? triage : await openScratch({ environmentId, input: {} });
    if (latestSwitchRef.current !== request) return false;
    latestSwitchRef.current = null;
    setSwitchingToEnvironmentId(null);
    // A project picked while this waited stands.
    if (readFlow().projectKey !== projectKey) return false;
    if (result._tag === "Success") {
      if (triage?._tag === "Success" && draftKey !== null && readFlow().draftKey === draftKey) {
        // Read now, so text typed while the machine prepared the session is kept.
        const text = getComposerDraftSnapshot(draftKey).text;
        const nextText = replaceTriagePlaybookLink(text, triage.value.prompt);
        if (nextText !== text) setComposerDraftText(draftKey, nextText);
      }
      setProject(result.value);
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        m(msg("Could not switch machine")),
        errorDisplayMessage(error, m) ??
          (triage?._tag === "Failure"
            ? m(msg("The server could not prepare triage."))
            : m(msg("The folder for threads without a project could not be created."))),
      );
    }
    return false;
  };

  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  // Asks first. The draft then moves to the clone; its composer shows progress and holds the start.
  const cloneToEnvironment = async (
    environmentId: EnvironmentId,
    remoteUrl: string,
  ): Promise<boolean> => {
    if (!selectedProject) return false;
    const destinationPath = getSourceCloneDestinationPath({
      remoteUrl,
      sourceWorkspaceRoot: selectedProject.workspaceRoot,
      sourceHomeDirectory: serverConfigs.get(selectedProject.environmentId)?.homeDirectory,
      targetSettings: serverConfigs.get(environmentId)?.settings,
    });
    const confirmed = await confirmClone({
      repository: selectedProject.repositoryIdentity?.displayName ?? selectedProject.title,
      machine:
        environments.find((environment) => environment.environmentId === environmentId)
          ?.environmentLabel ?? environmentId,
      path: destinationPath,
    });
    if (!confirmed) return false;
    const request = {};
    latestSwitchRef.current = request;
    setSwitchingToEnvironmentId(environmentId);
    const { projectKey } = readFlow();
    const started = await startProjectClone({
      environmentId,
      input: {
        projectId: ProjectId.make(uuidv4()),
        title: selectedProject.title,
        createdAt: nowIso(),
        remoteUrl,
        destinationPath,
      },
    });
    const project =
      started._tag === "Success"
        ? await waitForProject({ environmentId, projectId: started.value.projectId }, 15_000)
        : null;
    if (latestSwitchRef.current !== request) return false;
    latestSwitchRef.current = null;
    setSwitchingToEnvironmentId(null);
    if (readFlow().projectKey !== projectKey) return false;
    if (project) {
      setProject(project);
      return true;
    }
    if (started._tag === "Failure" && isAtomCommandInterrupted(started)) return false;
    Dialog.alert(
      m(msg("Could not start the clone.")),
      started._tag === "Failure"
        ? (errorDisplayMessage(squashAtomCommandFailure(started), m) ??
            m(msg("An error occurred.")))
        : m(
            msg(
              "The project was created but has not reached this device yet. It will appear in the project list once the connection catches up.",
            ),
          ),
    );
    return false;
  };

  const setWorkspaceMode = (mode: WorkspaceMode) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    if (!selectedProject) {
      return;
    }
    const localSelection = resolveNewTaskLocalWorkspaceSelection({
      branches: availableBranches,
      projectCwd: selectedProject.workspaceRoot,
    });
    updateComposerDraftSettings(selectedProjectDraftKey, {
      workspaceSelection: {
        mode,
        branch: mode === "local" ? localSelection.branch : selectedBranchName,
        worktreePath: mode === "local" ? localSelection.worktreePath : selectedWorktreePath,
        ...(draftStartFromOrigin !== undefined ? { startFromOrigin: draftStartFromOrigin } : {}),
        // Refs have not named the current branch yet; the selection follows it.
        ...(mode === "local" && localSelection.awaitsCurrentBranch
          ? { followsCurrentCheckout: true }
          : {}),
      },
    });
  };

  const selectBranch = (branch: VcsRef) => {
    if (!selectedProject || !selectedProjectDraftKey) {
      return;
    }
    // A chosen branch keeps the draft on this machine.
    updateLoadBalancing({ manual: true });
    updateComposerDraftSettings(selectedProjectDraftKey, {
      workspaceSelection: {
        mode: workspaceMode,
        branch: branch.name,
        worktreePath: resolveNewTaskBranchWorktreePath({
          workspaceMode,
          projectCwd: selectedProject.workspaceRoot,
          branchWorktreePath: branch.worktreePath,
        }),
        ...(draftStartFromOrigin !== undefined ? { startFromOrigin: draftStartFromOrigin } : {}),
      },
    });
  };

  const setStartFromOrigin = (value: boolean) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    updateComposerDraftSettings(selectedProjectDraftKey, {
      workspaceSelection: {
        mode: workspaceMode,
        branch: selectedBranchName,
        worktreePath: selectedWorktreePath,
        startFromOrigin: value,
        ...(selectedBranchName === null && workspaceSelection.followsCurrentCheckout
          ? { followsCurrentCheckout: true }
          : {}),
      },
    });
  };

  const refreshBranches = branchState.refresh;
  const loadBranches = () => {
    if (!selectedProject) {
      return;
    }
    setPendingConnectionError(null);
    refreshBranches();
  };

  const setRuntimeMode = (value: RuntimeMode) => {
    if (selectedProjectDraftKey) {
      updateComposerDraftSettings(selectedProjectDraftKey, { runtimeMode: value });
    }
  };

  const buildPendingTaskMessage = (
    metadata: TurnCommandMetadata,
    options?: { readonly currentCheckoutBranch?: string | null },
  ): QueuedThreadMessage | null => {
    if (!selectedProject || !selectedProjectDraftKey) {
      return null;
    }
    const draft = getComposerDraftSnapshot(selectedProjectDraftKey);
    const text = draft.text.trim();
    const draftModelSelection =
      resolveSelectableModelSelection(
        selectedEnvironmentServerConfig,
        draft.modelSelection ?? null,
        selectedProject.id,
      ) ?? selectedModel;
    if ((text.length === 0 && draft.attachments.length === 0) || !draftModelSelection) {
      return null;
    }
    if (
      threadContextsOutsideEnvironment({
        text: draft.text,
        records: draft.context?.records ?? [],
        environmentId: selectedProject.environmentId,
        linkedEnvironments,
      }).length > 0
    ) {
      return null;
    }
    const workspaceSelection = resolveWorkspaceSelection(draft.workspaceSelection);
    const mode = workspaceSelection.mode;
    return {
      environmentId: selectedProject.environmentId,
      threadId: ThreadId.make(metadata.threadId),
      messageId: MessageId.make(metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments: draft.attachments,
      context: draft.context,
      modelSelection: draftModelSelection,
      runtimeMode: resolveNewThreadRuntimeMode(
        draft.runtimeMode,
        defaultRuntimeMode,
        managedPolicy,
      ),
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      creation: {
        projectId: selectedProject.id,
        projectTitle: selectedProject.title,
        projectCwd: selectedProject.workspaceRoot,
        workspaceMode: mode,
        ...(mode === "worktree" && workspaceSelection?.pullRequestReference
          ? { pullRequestReference: workspaceSelection.pullRequestReference }
          : {}),
        // Queued local tasks use drain-time checkout; snapshot branches only for immediate sends or explicit choices.
        branch: resolveProjectThreadCreationBranch({
          workspaceMode: mode,
          selectedBranch: workspaceSelection?.branch ?? null,
          currentCheckoutBranch: options?.currentCheckoutBranch ?? null,
        }),
        worktreePath: mode === "worktree" ? null : (workspaceSelection?.worktreePath ?? null),
        ...((workspaceSelection?.startFromOrigin ?? startFromOrigin)
          ? { startFromOrigin: true }
          : {}),
      },
      createdAt: metadata.createdAt,
    };
  };

  const scratchEnvironments = connectedEnvironments.filter(
    (environment) =>
      availableScratchWorkspaceRoot(
        environment.connectionState,
        serverConfigs.get(environment.environmentId),
      ) !== null,
  );

  const selectedRepositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  // Use || null: placeholder workspaceRoot can be empty, and an empty basename rejects real hosts.
  const selectedWorkspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  const selectedProjectTitle = selectedProject?.title ?? null;
  const environments: NewTaskFlowContextValue["environments"] = (() => {
    if (isScratchDraft) {
      return sortEnvironmentOptionsByCluster(
        scratchEnvironments.map((environment) => ({
          environmentId: environment.environmentId,
          environmentLabel: environment.environmentLabel,
        })),
        environmentPresentations,
      );
    }
    const seen = new Set<EnvironmentId>();
    const result: Array<NewTaskFlowContextValue["environments"][number]> = [];
    const hostsSelectedRepository = (project: EnvironmentProject) => {
      if (selectedRepositoryKey === null && selectedWorkspaceBasename === null) {
        return true;
      }
      const projectKey = project.repositoryIdentity
        ? repositoryGroupingKeyOf(project.repositoryIdentity)
        : null;
      if (selectedRepositoryKey !== null && projectKey !== null) {
        return projectKey === selectedRepositoryKey;
      }
      return (
        project.workspaceRoot.split("/").at(-1) === selectedWorkspaceBasename ||
        (selectedProjectTitle !== null && project.title === selectedProjectTitle)
      );
    };
    for (const project of projects) {
      if (!hostsSelectedRepository(project)) {
        continue;
      }
      if (seen.has(project.environmentId)) {
        continue;
      }
      const environment = savedConnectionsById[project.environmentId];
      if (!environment) {
        continue;
      }
      seen.add(project.environmentId);
      result.push({
        environmentId: project.environmentId,
        environmentLabel: environment.environmentLabel,
      });
    }
    const cloneRemoteUrl = selectedProject ? projectCloneRemoteUrl(selectedProject) : null;
    if (selectedProject && cloneRemoteUrl !== null) {
      for (const environmentId of clusterCloneEnvironmentIds({
        project: selectedProject,
        environments: environmentPresentations,
        hasProject: seen,
      })) {
        const environment = savedConnectionsById[environmentId];
        if (!environment || !canClone.has(environmentId)) continue;
        result.push({
          environmentId,
          environmentLabel: environment.environmentLabel,
          cloneRemoteUrl,
        });
      }
    }
    return sortEnvironmentOptionsByCluster(result, environmentPresentations);
  })();

  const sameRepositoryProjectOn = (environmentId: EnvironmentId) =>
    environmentId === selectedProject?.environmentId
      ? selectedProject
      : projects.find(
          (project) =>
            project.environmentId === environmentId && isSameRepository(project, selectedProject),
        );
  const referencedThreadContexts = () => {
    if (!selectedProjectDraftKey) return [];
    const draft = getComposerDraftSnapshot(selectedProjectDraftKey);
    const referenced = new Set(
      collectComposerContextReferences(draft.text).map((occurrence) => occurrence.contextId),
    );
    return (draft.context?.records ?? []).filter(
      (record): record is ThreadContextRecord =>
        record.kind === "thread" && "threadId" in record && referenced.has(record.contextId),
    );
  };
  const autoCandidateIds = () =>
    activePool && selectedModel && selectedProviderStatus
      ? loadBalancingCandidateIds({
          candidates: activePool.environmentIds.flatMap((environmentId) => {
            const project = sameRepositoryProjectOn(environmentId);
            return project ? [{ environmentId, projectId: project.id }] : [];
          }),
          environmentById: presentationById,
          providersByEnvironment: new Map(
            [...serverConfigs].map(([environmentId, config]) => [environmentId, config.providers]),
          ),
          weights: loadBalancingWeights,
          referencedThreadContexts: referencedThreadContexts(),
          activeProviderInstanceId: selectedModel.instanceId,
          selectedProvider: selectedProviderStatus.driver,
        })
      : [];
  // Picks once per Auto choice, then keeps the draft there, like web's composer.
  const autoPickRequestRef = useRef<object | null>(null);
  const pickAutoEnvironment = async (request: object) => {
    const { projectKey, draftKey, autoPick } = readFlow();
    const balancing = (key: string | null) =>
      key === null ? undefined : getComposerDraftSnapshot(key).loadBalancing;
    const autoPool = balancing(draftKey)?.pool;
    const target = await pickLoadBalancedEnvironment(
      appAtomRegistry,
      serverEnvironment.hostResources,
      autoCandidateIds(),
      loadBalancingWeights,
    );
    const flow = readFlow();
    if (
      autoPickRequestRef.current !== request ||
      flow.projectKey !== projectKey ||
      balancing(flow.draftKey)?.pool !== autoPool ||
      balancing(flow.draftKey)?.manual === true ||
      flow.autoPick !== autoPick ||
      flow.submitting
    ) {
      return;
    }
    autoPickRequestRef.current = null;
    const project = target === null ? undefined : sameRepositoryProjectOn(target);
    if (!project) {
      updateFlow({ autoPick: { environmentId: null } });
      return;
    }
    updateFlow({
      // The target resolves its own workspace defaults; only a PR checkout carries over.
      draftKey: carryDraftContentTo(project, { keepPullRequestWorkspace: true }),
      environmentId: project.environmentId,
      projectKey: scopedProjectKey(project.environmentId, project.id),
      autoPick: { environmentId: project.environmentId },
    });
  };
  const runAutoPick = useEffectEvent(pickAutoEnvironment);
  const needsAutoPick =
    props.active !== false &&
    activePool !== null &&
    flowState.autoPick === null &&
    selectedProjectDraftKey !== null &&
    selectedModel !== null &&
    selectedProviderStatus !== null &&
    !submitting;
  const autoPickPool = needsAutoPick ? activePool.key : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the host-resource pick that resolves an Auto draft to a machine
  useEffect(() => {
    if (autoPickPool === null) return;
    const request = {};
    autoPickRequestRef.current = request;
    void runAutoPick(request);
    return () => {
      if (autoPickRequestRef.current === request) autoPickRequestRef.current = null;
    };
  }, [autoPickPool]);
  const updateLoadBalancing = (patch: Partial<ComposerDraftLoadBalancing>) => {
    const key = readFlow().draftKey;
    if (key === null) return;
    const current = getComposerDraftSnapshot(key).loadBalancing;
    updateComposerDraftSettings(key, {
      loadBalancing: { pool: null, acknowledged: null, ...current, ...patch },
    });
  };
  const chooseAutoPool = (poolKey: string) => {
    updateFlow({ autoPick: null });
    if (!selectedProjectDraftKey) return;
    const draft = getComposerDraftSnapshot(selectedProjectDraftKey);
    const selection = draft.workspaceSelection;
    updateComposerDraftSettings(selectedProjectDraftKey, {
      // Dropping `manual` hands the machine back to Auto.
      loadBalancing: { pool: poolKey, acknowledged: draft.loadBalancing?.acknowledged ?? null },
      // Choosing Auto drops a branch or worktree that pinned the draft to its machine.
      ...(selection && !selection.pullRequestReference
        ? { workspaceSelection: { mode: selection.mode, branch: null, worktreePath: null } }
        : {}),
    });
  };
  const autoBalanceWarning = () =>
    loadBalancingSendWarning(
      {
        pending: flowState.autoPick === null,
        threadContexts: referencedThreadContexts(),
        candidateEnvironmentIds: autoCandidateIds(),
      },
      m,
    );

  const value = {
    activeNewTask,
    projectScopes,
    selectedEnvironmentId,
    selectedProjectKey,
    selectedModelKey,
    workspaceMode,
    isGitRepo,
    isGitRepoKnown: knownIsGitRepo !== null,
    canChooseWorkspace,
    selectedBranchName,
    selectedWorktreePath,
    workspaceCwd,
    resolveWorkspaceSelection,
    startFromOrigin,
    draftKey: selectedProjectDraftKey,
    pullRequestReference: selectedProjectDraft.workspaceSelection?.pullRequestReference,
    prompt,
    attachments,
    submitting,
    branchesLoading,
    availableBranches,
    currentCheckoutBranchName,
    runtimeMode,
    expandedProvider,
    environments,
    selectedProject,
    linkedEnvironments,
    isScratchDraft,
    modelOptions,
    selectedModel,
    selectedModelOption,
    selectedProviderStatus,
    providerGroups,
    setProject,
    getSelectedProjectKey: () => readFlow().projectKey,
    unopenableRouteDraft:
      props.routeDraftId !== undefined &&
      (routeDraftResolution.kind === "missing" || routeDraftResolution.kind === "pickProject")
        ? { draftId: props.routeDraftId, kind: routeDraftResolution.kind }
        : null,
    selectEnvironment,
    autoPools,
    autoBalance,
    chooseAutoPool,
    pinEnvironment: () => updateLoadBalancing({ manual: true }),
    retryAutoBalance: async () => {
      if (readFlow().autoPick?.environmentId !== null) return null;
      const request = {};
      autoPickRequestRef.current = request;
      await pickAutoEnvironment(request);
      return readFlow().autoPick?.environmentId ?? null;
    },
    acknowledgeAutoBalance: () => updateLoadBalancing({ acknowledged: activePool?.key ?? null }),
    autoBalanceWarning,
    switchEnvironment,
    switchingToEnvironmentId,
    setSelectedModelKey,
    setWorkspaceMode,
    selectBranch,
    setStartFromOrigin,
    buildPendingTaskMessage,
    setPrompt,
    replaceAttachments,
    appendAttachments,
    removeAttachment,
    clearAttachments,
    setSubmitting: (value: boolean) => {
      // A send takes the draft as it is, so a machine switch still waiting is dropped.
      if (value) {
        latestSwitchRef.current = null;
        setSwitchingToEnvironmentId(null);
      }
      updateFlow({ submitting: value });
    },
    loadBranches,
    setRuntimeMode,
    setSelectedModelOptions,
    setExpandedProvider: (value: string | null) => updateFlow({ expandedProvider: value }),
  } satisfies NewTaskFlowContextValue;

  return (
    <ActiveNewTaskContext value={activeNewTask}>
      <NewTaskFlowContext.Provider value={value}>{props.children}</NewTaskFlowContext.Provider>
    </ActiveNewTaskContext>
  );
}

export function useNewTaskFlow() {
  const value = React.use(NewTaskFlowContext);
  if (value === null) {
    throw new Error("useNewTaskFlow must be used within NewTaskFlowProvider.");
  }
  return value;
}
