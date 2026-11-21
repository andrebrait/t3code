import { msg, useGT, useMessages } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  clusterEnvironmentIds,
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
  // Clusters balance with the switch off too, so their machines stay editable.
  const clusterIds = clusterEnvironmentIds(environments);

  return (
    <View className="mt-5 gap-3">
      <SettingsSection title={gt("Load balancing")}>
        <SettingsSwitchRow
          label={gt("Automatically balance load")}
          disabled={!ready}
          value={enabled}
          onValueChange={(loadBalancingEnabled) => void savePreferences({ loadBalancingEnabled })}
        />
        {environments.map((environment) => {
          const environmentId = environment.environmentId;
          const editable = ready && (enabled || clusterIds.has(environmentId));
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
                <Text className="text-sm text-foreground-muted">
                  {m(preferenceLabels[selected])}
                </Text>
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
        })}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {gt(
          "New threads start on the machine with the most free CPU and memory, weighted by each machine's preference. Clusters always balance across their own machines; turn this on to also balance across all your machines.",
        )}
      </Text>
    </View>
  );
}
