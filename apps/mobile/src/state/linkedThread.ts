import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  connectLinkedEnvironment,
  createLinkedThreadSession,
  type LinkedThreadTarget,
} from "@t3tools/client-runtime/linked-thread";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import { useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { connectPairingUrl, reachesEnvironment } from "../connection/onboarding";
import { linkedEnvironmentPrefillAtom } from "../features/connection/linkedEnvironmentPrefill";
import { buildPairingUrl } from "../features/connection/pairing";
import { useEnvironments } from "./environments";
import { peerLinkEnvironment, useLinkedEnvironments } from "./peerLinks";
import { useAtomCommand } from "./use-atom-command";

/**
 * What places a delegated task's thread: this app's own connections, and the links `environmentId`
 * holds. Links are listed only while a task runs somewhere this app is not connected to.
 */
export function useLinkedThreadReach(
  environmentId: EnvironmentId,
  subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "childThreadId" | "remoteChild">>,
) {
  const { presentationById } = useEnvironments();
  const ownConnection = (id: EnvironmentId) => {
    const own = presentationById.get(id);
    return own && { connected: own.connection.phase === "connected" };
  };
  const links = useLinkedEnvironments(
    subagents.some(
      (subagent) =>
        subagent.childThreadId === null &&
        subagent.remoteChild !== undefined &&
        ownConnection(subagent.remoteChild.environmentId)?.connected !== true,
    )
      ? environmentId
      : null,
  );
  return { ownConnection, isLinked: (id: EnvironmentId) => links.has(id) };
}

export type LinkedEnvironmentConnectState =
  | { readonly phase: "idle" | "connecting" }
  | { readonly phase: "unreachable"; readonly label: string };

/**
 * Connects this app to the environment `target` lives in. One step when the linking environment
 * can get a pairing for this app; otherwise the caller opens the add-environment screen, which
 * reads what was learned about the machine.
 */
export function useConnectLinkedEnvironment(target: LinkedThreadTarget) {
  const setPrefill = useAtomSet(linkedEnvironmentPrefillAtom);
  const mayPair = useAtomValue(
    peerLinkEnvironment.pairClient.permissionAtom(target.viaEnvironmentId),
  );
  const quiet = { reportFailure: false, reportDefect: false } as const;
  const requestPairing = useAtomCommand(peerLinkEnvironment.pairClient, quiet);
  const reaches = useAtomCommand(reachesEnvironment, quiet);
  const pair = useAtomCommand(connectPairingUrl, quiet);
  const [state, setState] = useState<LinkedEnvironmentConnectState>({ phase: "idle" });
  const connect = async () => {
    setState({ phase: "connecting" });
    const outcome = await connectLinkedEnvironment({
      label: target.label,
      requestPairing: async () => {
        // Without it the linking environment refuses; the user can still pair by hand.
        if (!mayPair) return null;
        const result = await requestPairing({
          environmentId: target.viaEnvironmentId,
          input: { environmentId: target.environmentId },
        });
        return result._tag === "Success" ? result.value : null;
      },
      reaches: async (host) => {
        const result = await reaches({ host, environmentId: target.environmentId });
        return result._tag === "Success" && result.value;
      },
      pair: async ({ host, pairingCode }) => {
        const result = await pair({
          pairingUrl: buildPairingUrl(host, pairingCode),
          expectedEnvironmentId: target.environmentId,
        });
        return result._tag === "Success";
      },
    });
    setState(
      outcome.type === "unreachable"
        ? { phase: "unreachable", label: outcome.label }
        : { phase: "idle" },
    );
    if (outcome.type === "manual") {
      setPrefill({ environmentId: target.environmentId, label: outcome.label, host: outcome.host });
    }
    return outcome;
  };
  return { state, connect };
}

/**
 * The transcript of `target`, read through the environment that links to it. Reads start when the
 * calling screen mounts, stop when it unmounts, and wait while the app is in the background or
 * `isFocused` says another screen covers this one.
 */
export function useLinkedThreadSession(target: LinkedThreadTarget, isFocused: () => boolean) {
  const read = useAtomCommand(peerLinkEnvironment.readThread, {
    reportFailure: false,
    reportDefect: false,
  });
  const [session] = useState(() =>
    createLinkedThreadSession({
      read: async (cursor) => {
        const result = await read({
          environmentId: target.viaEnvironmentId,
          input: { environmentId: target.environmentId, threadId: target.threadId, ...cursor },
        });
        return result._tag === "Success"
          ? { ok: true, page: result.value }
          : { ok: false, error: squashAtomCommandFailure(result) };
      },
      schedule: (run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
      isActive: () => AppState.currentState === "active" && isFocused(),
    }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { state, session };
}
