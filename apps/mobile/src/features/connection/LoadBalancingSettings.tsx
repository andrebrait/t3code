import { msg, useGT, useMessages } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  groupEnvironmentsByCluster,
  LOAD_BALANCING_PREFERENCES,
  type LoadBalancingPreference,
  loadBalancingPreferenceForWeight,
} from "@t3tools/client-runtime/load-balancing";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { CLUSTER_SYMBOL } from "../../lib/clusterSymbol";
import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";

const preferenceLabels: Record<LoadBalancingPreference, string> = {
  100: msg("Prefer"),
  50: msg("Normal", { $context: "load balancing preference" }),
  25: msg("Less often"),
  0: msg("Manual only"),
};

export function LoadBalancingSettings() {
  const gt = useGT();
  const m = useMessages();
  const { environments: allEnvironments } = useEnvironments();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Members run threads like any machine, so each gets its own share of the load.
  const environments = allEnvironments.filter(
    (environment) => environment.entry.enabled && environment.connection.phase !== "unsupported",
  );
  if (environments.length < 2) return null;

  const ready = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
  const enabled = preferences.loadBalancingEnabled ?? false;
  const weights = preferences.loadBalancingWeights ?? {};
  const { clusters, standalone } = groupEnvironmentsByCluster(environments);
  const skippedConfirms = preferences.loadBalancingConfirmSkippedProjects?.length ?? 0;
  // The way back from "Don't ask again" on the fewer-machines confirm.
  const resetConfirmsSection =
    skippedConfirms > 0 ? (
      <SettingsSection
        title={gt("Asking before balancing across fewer machines")}
        footer={gt(
          "You chose not to be asked again for {count, plural, one {# project} other {# projects}}.",
          { count: skippedConfirms },
        )}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          className="p-4"
          onPress={() => void savePreferences({ loadBalancingConfirmSkippedProjects: [] })}
        >
          <Text className="text-base text-foreground">
            {gt('Reset "Don\'t ask again" choices')}
          </Text>
        </Pressable>
      </SettingsSection>
    ) : null;
  const switchRow = (label: string) => (
    <SettingsSwitchRow
      label={label}
      disabled={!ready}
      value={enabled}
      onValueChange={(loadBalancingEnabled) => void savePreferences({ loadBalancingEnabled })}
    />
  );
  const preferenceRow = (environment: (typeof environments)[number], canEdit: boolean) => {
    const environmentId = environment.environmentId;
    const editable = ready && canEdit;
    const selected = loadBalancingPreferenceForWeight(weights[environmentId]);
    return (
      <View key={environmentId}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("{environment} load preference", {
            environment: environment.label,
          })}
          accessibilityState={{ expanded: expanded === environmentId, disabled: !editable }}
          disabled={!editable}
          className="flex-row items-center gap-3 p-4"
          onPress={() => setExpanded(expanded === environmentId ? null : environmentId)}
        >
          <Text className="min-w-0 flex-1 text-base font-t3-bold text-foreground">
            {environment.label}
          </Text>
          <Text className="text-sm text-foreground-muted">{m(preferenceLabels[selected])}</Text>
          <SymbolView
            name={expanded === environmentId ? "chevron.up" : "chevron.down"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        </Pressable>
        {expanded === environmentId
          ? LOAD_BALANCING_PREFERENCES.map((preference) => (
              <ListChoiceRow
                key={preference}
                label={m(preferenceLabels[preference])}
                selected={selected === preference}
                disabled={!editable}
                onPress={() =>
                  void savePreferences({
                    transform: (current) => ({
                      loadBalancingWeights: {
                        ...current.loadBalancingWeights,
                        [environmentId]: preference,
                      },
                    }),
                  })
                }
              />
            ))
          : null}
      </View>
    );
  };

  if (clusters.length === 0) {
    return (
      <View className="mt-5">
        <SettingsSection
          title={gt("Load balancing")}
          footer={gt(
            "New threads in shared projects start on the machine with the most free CPU and memory, weighted by each machine's preference.",
          )}
        >
          {switchRow(gt("Automatically balance load"))}
          {standalone.map((environment) => preferenceRow(environment, enabled))}
        </SettingsSection>
        {resetConfirmsSection ? <View className="mt-5">{resetConfirmsSection}</View> : null}
      </View>
    );
  }

  return (
    <View className="mt-5 gap-5">
      {clusters.map((cluster) => (
        <SettingsSection
          key={cluster.hostEnvironmentId}
          title={`${gt("Load balancing")} · ${gt("{host} cluster", { host: cluster.label })}`}
          titleIcon={
            <SymbolView name={CLUSTER_SYMBOL} size={14} tintColorClassName="accent-icon-muted" />
          }
          footer={gt(
            "On this device, new threads started on this cluster always balance across its machines, weighted by each machine's preference.",
          )}
        >
          {cluster.environments.map((environment) => preferenceRow(environment, true))}
        </SettingsSection>
      ))}
      {/* With one cluster and nothing outside it, balancing across all machines is that cluster's. */}
      {clusters.length > 1 || standalone.length > 0 ? (
        <SettingsSection
          title={`${gt("Load balancing")} · ${gt("Other machines")}`}
          footer={gt(
            "Balance across all machines: when on, new threads in shared projects may also start on any machine, cluster machines included, weighted by the same preferences.",
          )}
        >
          {switchRow(gt("Balance across all machines"))}
          {standalone.map((environment) => preferenceRow(environment, enabled))}
        </SettingsSection>
      ) : null}
      {resetConfirmsSection}
    </View>
  );
}
