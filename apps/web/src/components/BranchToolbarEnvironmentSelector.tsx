import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import type { EnvironmentId } from "@t3tools/contracts";
import { PlusIcon, ScaleIcon, TriangleAlertIcon } from "lucide-react";
import { memo } from "react";
import { T, useGT } from "gt-react";

import {
  ADD_TO_MACHINE_LABEL_CLASS,
  type AutoEnvironmentOption,
  type EnvironmentOption,
} from "./BranchToolbar.logic";
import { ClusterIcon } from "./ClusterIcon";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: ((key: string) => void) | undefined;
  autoEnvironments?: ReadonlyArray<AutoEnvironmentOption> | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onAddToMachine?: (() => void) | undefined;
}

// Action values cannot collide with server-minted environment IDs.
const AUTO_PREFIX = "action:auto:";
const ADD_MACHINE_VALUE = "action:add-machine";
const environmentValue = (id: EnvironmentId) => `env:${id}`;

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  autoEnvironments,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  onAddToMachine,
}: BranchToolbarEnvironmentSelectorProps) {
  const gt = useGT();
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.host",
  );
  const activeEnvironment =
    availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;

  const activeAuto = autoEnvironmentLabel
    ? autoEnvironments?.find((option) => option.active)
    : undefined;
  const environmentItems = [
    ...(onAutoEnvironment
      ? (autoEnvironments ?? []).map((option) => ({
          value: `${AUTO_PREFIX}${option.key}`,
          label: option.label,
        }))
      : []),
    ...availableEnvironments.map((env) => ({
      value: environmentValue(env.environmentId),
      label: env.label,
    })),
    ...(onAddToMachine ? [{ value: ADD_MACHINE_VALUE, label: gt("Add to another machine") }] : []),
  ];

  // Match the xs control's height and padding: the composer strip has no min-height,
  // and its glass seam assumes that height even when this label is the only control.
  if (envLocked || (onEnvironmentChange === undefined && onAddToMachine === undefined)) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-sm sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        <EnvironmentMachineIcon
          kind={activeEnvironment?.machine ?? "server"}
          className="size-3 shrink-0"
        />
        <ComposerContextLabel>{activeEnvironment?.label ?? gt("Run on")}</ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>{activeEnvironment?.label ?? gt("Run on")}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={activeAuto ? `${AUTO_PREFIX}${activeAuto.key}` : environmentValue(environmentId)}
      onValueChange={(value) => {
        if (value === ADD_MACHINE_VALUE) {
          onAddToMachine?.();
        } else if (value?.startsWith(AUTO_PREFIX)) {
          onAutoEnvironment?.(value.slice(AUTO_PREFIX.length));
        } else if (value?.startsWith("env:")) {
          onEnvironmentChange?.(value.slice(4) as EnvironmentId);
        }
      }}
      items={environmentItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 max-w-full"
              aria-label={gt("Run on")}
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {activeAuto ? (
            <AutoEnvironmentIcon option={activeAuto} className="size-3 shrink-0" />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className="size-3 shrink-0"
            />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {autoEnvironmentLabel ?? activeEnvironment?.label ?? gt("Run on")}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>
            <T>Run on</T>
          </SelectGroupLabel>
          {onAutoEnvironment &&
            autoEnvironments?.map((option) => (
              <SelectItem
                key={option.key}
                value={`${AUTO_PREFIX}${option.key}`}
                onClick={() => {
                  if (option.active) onAutoEnvironment(option.key);
                }}
              >
                <AutoEnvironmentItem option={option} />
              </SelectItem>
            ))}
          {availableEnvironments.map((env) => (
            <SelectItem
              key={env.environmentId}
              value={environmentValue(env.environmentId)}
              disabled={onEnvironmentChange === undefined && env.environmentId !== environmentId}
            >
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                {env.label}
                {env.cloneRemoteUrl ? <CloneHint /> : null}
              </span>
            </SelectItem>
          ))}
          {onAddToMachine ? (
            <SelectItem value={ADD_MACHINE_VALUE}>
              <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                <PlusIcon aria-hidden="true" className="size-3" />
                <T>Add to another machine</T>
              </span>
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});

/** Marks a cluster machine that clones the project before its first thread. */
export function CloneHint() {
  return (
    <span className="shrink-0 text-muted-foreground text-xs">
      <T>clones the project</T>
    </span>
  );
}

export function AutoEnvironmentIcon(props: {
  readonly option: AutoEnvironmentOption;
  readonly className: string;
}) {
  return props.option.cluster ? (
    <ClusterIcon className={props.className} aria-hidden="true" />
  ) : (
    <ScaleIcon className={props.className} aria-hidden="true" />
  );
}

/** An Auto choice, warning when some of its machines lack the project. */
export function AutoEnvironmentItem({ option }: { readonly option: AutoEnvironmentOption }) {
  const gt = useGT();
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <AutoEnvironmentIcon option={option} className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{option.label}</span>
        {option.missingLabels.length > 0 ? (
          <TriangleAlertIcon className="size-3 shrink-0 text-warning" aria-hidden="true" />
        ) : null}
      </span>
      {option.missingLabels.length > 0 ? (
        <span className="text-muted-foreground text-xs">
          {gt("Balances only across machines with this project. Not on: {machines}", {
            machines: option.missingLabels.join(", "),
          })}
        </span>
      ) : null}
    </span>
  );
}
