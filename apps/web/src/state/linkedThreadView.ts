import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  connectLinkedEnvironment,
  createLinkedThreadSession,
  type LinkedThreadOpen,
  resolveLinkedThreadOpen,
} from "@t3tools/client-runtime/linked-thread";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { SideThreadOpenIntent } from "@t3tools/client-runtime/side-thread";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { connectPairing, reachesEnvironment } from "../connection/onboarding";
import { getDocumentActivity } from "../lib/documentActivity";
import { openLinkedThreadRead } from "../lib/sideChatPane";
import type { LinkedThreadSurface } from "../linkedThreadSurface";
import { buildThreadRouteParams } from "../threadRoutes";
import { useEnvironment } from "./environments";
import { peerLinkEnvironment, useLinkedEnvironments } from "./peerLinks";
import { useAtomCommand } from "./use-atom-command";

/**
 * How a click opens a thread `panelRef` says is on a linked environment: in place when this client
 * is connected there, else read-only through `panelRef`'s environment, in its right panel or on
 * the main screen as the click asks. A saved environment whose link is gone opens in place.
 */
export function useLinkedThreadOpener(
  panelRef: ScopedThreadRef,
  thread:
    | {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly label: string;
      }
    | undefined,
  title: string | null,
): {
  readonly mode: Exclude<LinkedThreadOpen, "unavailable">;
  readonly open: (intent: SideThreadOpenIntent) => void;
} | null {
  const navigate = useNavigate();
  const viaEnvironmentId = panelRef.environmentId;
  const own = useEnvironment(thread?.environmentId ?? null);
  const connected = own?.connection.phase === "connected";
  const links = useLinkedEnvironments(thread === undefined || connected ? null : viaEnvironmentId);
  if (thread === undefined) return null;
  const resolved = resolveLinkedThreadOpen({
    environmentId: thread.environmentId,
    viaEnvironmentId,
    own: own === null ? undefined : { connected },
    linked: links.has(thread.environmentId),
  });
  const mode = resolved === "direct" ? "direct" : "linked";
  return {
    mode,
    open: (intent) => {
      if (mode === "linked") {
        openLinkedThreadRead({
          panelRef,
          target: {
            viaEnvironmentId,
            environmentId: thread.environmentId,
            threadId: thread.threadId,
            label: own?.label ?? thread.label,
            title,
          },
          intent,
          navigate,
        });
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.threadId)),
      });
    },
  };
}

type SessionKey = readonly [
  /** Null on the main screen, where no tab shows the title. */
  panelEnvironmentId: EnvironmentId | null,
  panelThreadId: ThreadId | null,
  surfaceId: string,
  viaEnvironmentId: EnvironmentId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
];

/**
 * One tab's reads. It outlives the pane for a while, so coming back to the tab shows what was
 * read and carries on from there; a session nothing subscribes to asks for nothing.
 */
const linkedThreadSessionAtom = Atom.family((key: string) => {
  const [panelEnvironmentId, panelThreadId, surfaceId, viaEnvironmentId, environmentId, threadId] =
    JSON.parse(key) as SessionKey;
  const panelRef =
    panelEnvironmentId === null || panelThreadId === null
      ? null
      : scopeThreadRef(panelEnvironmentId, panelThreadId);
  return Atom.make((get) =>
    createLinkedThreadSession({
      read: async (cursor) => {
        const result = await runAtomCommand(
          get.registry,
          peerLinkEnvironment.readThread,
          { environmentId: viaEnvironmentId, input: { environmentId, threadId, ...cursor } },
          { reportFailure: false, reportDefect: false },
        );
        if (result._tag !== "Success") {
          return { ok: false, error: squashAtomCommandFailure(result) };
        }
        return { ok: true, page: result.value };
      },
      onRead: (page) => {
        const { title } = page.thread;
        if (title && panelRef !== null) {
          useRightPanelStore.getState().setLinkedThreadTitle(panelRef, surfaceId, title);
        }
      },
      schedule: (run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
      isActive: () => getDocumentActivity().visible,
    }),
  ).pipe(Atom.setIdleTTL(5 * 60_000), Atom.withLabel(`linked-thread-session:${key}`));
});

/** A linked environment the add-environment dialog opens for, with what is known about it filled in. */
export interface AddEnvironmentPrefill {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly host: string | null;
}

export const addEnvironmentPrefillAtom = Atom.make<AddEnvironmentPrefill | null>(null).pipe(
  Atom.withLabel("add-environment-prefill"),
);

export type LinkedEnvironmentConnectState =
  | { readonly phase: "idle" | "connecting" }
  | { readonly phase: "unreachable"; readonly label: string }
  /** The user pairs with a code of their own; `prefill` reopens the dialog for it. */
  | { readonly phase: "manual"; readonly prefill: AddEnvironmentPrefill };

// Kept like the tab's reads, so the tab still says what happened after a visit to Settings.
const linkedEnvironmentConnectAtom = Atom.family((key: string) =>
  Atom.make<LinkedEnvironmentConnectState>({ phase: "idle" }).pipe(
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`linked-environment-connect:${key}`),
  ),
);

/**
 * Connects this client to the environment `surface`'s thread lives in. One step when the linking
 * environment can get a pairing for this client: the thread then opens there, in place of the
 * read-only view. Otherwise the add-environment dialog opens for that machine. `panelRef` is the
 * thread whose panel shows the read, or null on the main screen.
 */
export function useConnectLinkedEnvironment(
  panelRef: ScopedThreadRef | null,
  surface: LinkedThreadSurface,
) {
  const navigate = useNavigate();
  const setPrefill = useAtomSet(addEnvironmentPrefillAtom);
  const mayPair = useAtomValue(
    peerLinkEnvironment.pairClient.permissionAtom(surface.viaEnvironmentId),
  );
  const quiet = { reportFailure: false, reportDefect: false } as const;
  const requestPairing = useAtomCommand(peerLinkEnvironment.pairClient, quiet);
  const reaches = useAtomCommand(reachesEnvironment, quiet);
  const pair = useAtomCommand(connectPairing, quiet);
  const [state, setState] = useAtom(
    linkedEnvironmentConnectAtom(
      `${panelRef === null ? "main" : scopedThreadKey(panelRef)}:${surface.id}`,
    ),
  );
  const addWithCode = (prefill: AddEnvironmentPrefill) => {
    setPrefill(prefill);
    void navigate({ to: "/settings/connections" });
  };
  const connect = async () => {
    setState({ phase: "connecting" });
    const outcome = await connectLinkedEnvironment({
      label: surface.label,
      requestPairing: async () => {
        // Without it the linking environment refuses; the user can still pair by hand.
        if (!mayPair) return null;
        const result = await requestPairing({
          environmentId: surface.viaEnvironmentId,
          input: { environmentId: surface.environmentId },
        });
        return result._tag === "Success" ? result.value : null;
      },
      reaches: async (host) => {
        const result = await reaches({ host, environmentId: surface.environmentId });
        return result._tag === "Success" && result.value;
      },
      pair: async ({ host, pairingCode }) => {
        const result = await pair({
          host,
          pairingCode,
          expectedEnvironmentId: surface.environmentId,
        });
        return result._tag === "Success";
      },
    });
    if (outcome.type === "unreachable") {
      setState({ phase: "unreachable", label: outcome.label });
      return outcome;
    }
    if (outcome.type === "connected") {
      setState({ phase: "idle" });
      // The thread opens where every thread on a connected environment does, so its tab is done.
      if (panelRef !== null) useRightPanelStore.getState().closeSurface(panelRef, surface.id);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(surface.environmentId, surface.threadId)),
        // The read-only page has nothing left to go back to.
        replace: panelRef === null,
      });
      return outcome;
    }
    const prefill = {
      environmentId: surface.environmentId,
      label: outcome.label,
      host: outcome.host,
    };
    setState({ phase: "manual", prefill });
    addWithCode(prefill);
    return outcome;
  };
  return { state, connect, addWithCode };
}

const noSubscription = () => () => {};

/**
 * The transcript of `surface`, read through the environment that links to it, for the tab in
 * `panelRef`'s panel or, with null, the main screen. Reads run only while `visible`.
 */
export function useLinkedThreadSession(
  panelRef: ScopedThreadRef | null,
  surface: Pick<LinkedThreadSurface, "id" | "viaEnvironmentId" | "environmentId" | "threadId">,
  visible: boolean,
) {
  const key: SessionKey = [
    panelRef?.environmentId ?? null,
    panelRef?.threadId ?? null,
    surface.id,
    surface.viaEnvironmentId,
    surface.environmentId,
    surface.threadId,
  ];
  const session = useAtomValue(linkedThreadSessionAtom(JSON.stringify(key)));
  const state = useSyncExternalStore(
    visible ? session.subscribe : noSubscription,
    session.getSnapshot,
    session.getSnapshot,
  );
  return { state, session };
}
