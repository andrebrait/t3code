import {
  type SideThreadOpenIntent,
  sideThreadOpenIntentOf,
} from "@t3tools/client-runtime/side-thread";
import { useGT } from "gt-react";
import type { KeyboardEvent, MouseEvent } from "react";

import { contextMenuSourceOf } from "../contextMenuSource";
import { isMacPlatform } from "../lib/utils";
import { readLocalApi } from "../localApi";

/**
 * The handlers every row, card and chip that opens a subagent, a side chat or a linked thread
 * shares: click and Enter open it where the setting says, the modifier or a middle click in the
 * other place, and the context menu names both. Pass `panel: false` where no panel can show it.
 */
export function useSideThreadTrigger() {
  const gt = useGT();
  return (open: (intent: SideThreadOpenIntent) => void, options?: { readonly panel?: boolean }) => {
    const mac = isMacPlatform(navigator.platform);
    return {
      onClick: (event: MouseEvent) => open(sideThreadOpenIntentOf(event, mac)),
      // Middle button: keeps the browser's autoscroll from starting under the click.
      onMouseDown: (event: MouseEvent) => {
        if (event.button === 1) event.preventDefault();
      },
      onAuxClick: (event: MouseEvent) => {
        if (event.button !== 1) return;
        event.preventDefault();
        open("alternate");
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key !== "Enter" || sideThreadOpenIntentOf(event, mac) !== "alternate") return;
        event.preventDefault();
        open("alternate");
      },
      onContextMenu: (event: MouseEvent) => {
        const api = readLocalApi();
        if (!api) return;
        event.preventDefault();
        event.stopPropagation();
        const items = [
          ...(options?.panel === false
            ? []
            : ([{ id: "panel", label: gt("Open in side panel") }] as const)),
          { id: "main", label: gt("Open in main view") },
        ] as const;
        void api.contextMenu
          .show(items, { x: event.clientX, y: event.clientY }, contextMenuSourceOf(event))
          .then((clicked) => {
            if (clicked === "panel" || clicked === "main") open(clicked);
          });
      },
    };
  };
}
