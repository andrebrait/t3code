import {
  groupEnvironmentsByCluster,
  loadBalancingPreferenceForWeight,
} from "@t3tools/client-runtime/load-balancing";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "~/hooks/useSettings";
import type { MessageResolver } from "~/i18n/messages";
import type { EnvironmentPresentation } from "~/state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ClusterIcon } from "../ClusterIcon";
import { EnvironmentRow, EnvironmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const preferences = [
  { value: 100, label: msg("Prefer") },
  { value: 50, label: msg("Normal", { $context: "load balancing preference" }) },
  { value: 25, label: msg("Less often") },
  { value: 0, label: msg("Manual only") },
] as const;

const summaryLabels = {
  100: msg("{environment} prefer"),
  25: msg("{environment} less often"),
  0: msg("{environment} manual only"),
} as const;

function summarizeLoadPreferences(
  environments: ReadonlyArray<Pick<EnvironmentPresentation, "environmentId" | "label">>,
  weights: Readonly<Record<string, number>>,
  resolve: MessageResolver,
): string | null {
  const parts = environments.flatMap((environment) => {
    const preference = loadBalancingPreferenceForWeight(weights[environment.environmentId]);
    return preference === 50
      ? []
      : [resolve(summaryLabels[preference], { environment: environment.label })];
  });
  return parts.length === 0 ? null : parts.join(" · ");
}

export function LoadBalancingSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const searchableSetting = useSearchableSetting();
  const settings = useClientSettings((current) => ({
    loadBalancingEnabled: current.loadBalancingEnabled,
    loadBalancingWeights: current.loadBalancingWeights,
    skippedConfirms: current.loadBalancingConfirmSkippedProjects.length,
  }));
  const settingsHydrated = useClientSettingsHydrated();
  const gt = useGT();
  const m = useMessages();
  const items = preferences.map((entry) => ({ ...entry, label: m(entry.label) }));

  if (environments.length < 2) return null;
  const { clusters, standalone } = groupEnvironmentsByCluster(
    environments,
    environments.find((environment) => environment.entry.target._tag === "PrimaryConnectionTarget")
      ?.environmentId ?? null,
  );

  const { id, title } = searchableSetting("load-balancing");
  const switchControl = (label: string) => (
    <Switch
      aria-label={label}
      checked={settings.loadBalancingEnabled}
      disabled={!settingsHydrated}
      onCheckedChange={(loadBalancingEnabled) => updateClientSettings({ loadBalancingEnabled })}
    />
  );
  const preferenceRow = (environment: EnvironmentPresentation, editable: boolean) => (
    <EnvironmentRow
      key={environment.environmentId}
      kind={resolveEnvironmentMachineKind(environment.serverConfig)}
      label={environment.label}
      subtitle={<EnvironmentTransportLabel environment={environment} />}
    >
      <Select
        items={items}
        value={loadBalancingPreferenceForWeight(
          settings.loadBalancingWeights[environment.environmentId],
        )}
        disabled={!settingsHydrated || !editable}
        onValueChange={(value) => {
          if (value === null) return;
          updateClientSettings({
            loadBalancingWeights: {
              ...settings.loadBalancingWeights,
              [environment.environmentId]: value,
            },
          });
        }}
      >
        <SelectTrigger
          size="xs"
          className="w-32"
          aria-label={gt("{environment} load preference", { environment: environment.label })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {items.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </EnvironmentRow>
  );
  // The way back from "Don't ask again" on the fewer-machines confirm.
  const resetConfirmsRow =
    settings.skippedConfirms > 0 ? (
      <SettingsRow
        title={gt("Asking before balancing across fewer machines")}
        description={gt(
          "You chose not to be asked again for {count, plural, one {# project} other {# projects}}.",
          { count: settings.skippedConfirms },
        )}
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={!settingsHydrated}
            onClick={() => void updateClientSettings({ loadBalancingConfirmSkippedProjects: [] })}
          >
            {gt('Reset "Don\'t ask again" choices')}
          </Button>
        }
      />
    ) : null;
  const switchSummary = settings.loadBalancingEnabled
    ? summarizeLoadPreferences(environments, settings.loadBalancingWeights, m)
    : gt("Off", { $context: "load balancing is turned off" });

  if (clusters.length === 0) {
    return (
      <FoldedSettingsSection
        id={id}
        title={title}
        summary={switchSummary}
        control={switchControl(gt("Automatically balance load"))}
      >
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          <T>
            New threads in shared projects start on the machine with the most free CPU and memory,
            weighted by each machine's preference.
          </T>
        </p>
        {standalone.map((environment) => preferenceRow(environment, settings.loadBalancingEnabled))}
        {resetConfirmsRow}
      </FoldedSettingsSection>
    );
  }

  // With one cluster and nothing outside it, balancing across all machines is that cluster's.
  const showOtherMachines = clusters.length > 1 || standalone.length > 0;
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={[
        ...clusters.map((cluster) => gt("{host} cluster", { host: cluster.label })),
        ...(showOtherMachines
          ? [switchSummary ?? gt("On", { $context: "load balancing is turned on" })]
          : []),
      ].join(" · ")}
    >
      {clusters.flatMap((cluster) => [
        <SettingsRow
          key={`cluster:${cluster.hostEnvironmentId}`}
          title={
            <span className="inline-flex items-center gap-2">
              <ClusterIcon aria-hidden className="size-4 text-muted-foreground" />
              {gt("{host} cluster", { host: cluster.label })}
            </span>
          }
          description={gt(
            "On this device, new threads started on this cluster always balance across its machines, weighted by each machine's preference.",
          )}
        />,
        ...cluster.environments.map((environment) => preferenceRow(environment, true)),
      ])}
      {showOtherMachines ? (
        <SettingsRow
          title={gt("Other machines")}
          description={gt(
            "Balance across all machines: when on, new threads in shared projects may also start on any machine, cluster machines included, weighted by the same preferences.",
          )}
          control={switchControl(gt("Balance across all machines"))}
        />
      ) : null}
      {standalone.map((environment) => preferenceRow(environment, settings.loadBalancingEnabled))}
      {resetConfirmsRow}
    </FoldedSettingsSection>
  );
}
