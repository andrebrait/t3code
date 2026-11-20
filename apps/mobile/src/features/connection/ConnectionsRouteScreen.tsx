import { useGT } from "gt-react-native";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";

import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { Fragment, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { LocalEnvironmentList } from "./LocalEnvironmentList";
import { LoadBalancingSettings } from "./LoadBalancingSettings";
import { PullRequestRoutingSettings } from "./PullRequestRoutingSettings";
import { useClusterHosts, useClusterMemberIds } from "../../state/cluster";
import { ClusterSection } from "./ClusterSection";
import { LinkedEnvironmentsSection } from "./LinkedEnvironmentsSection";
import { LinkSeveralEnvironmentsAction } from "./LinkSeveralEnvironments";

export function ConnectionsRouteScreen() {
  const gt = useGT();
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onSetEnvironmentEnabled,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const clusterHosts = useClusterHosts();
  const clusterMemberIds = useClusterMemberIds();
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const handleToggle = (environmentId: EnvironmentId) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar
        title={gt("Environments")}
        onClose={() => navigation.goBack()}
        closeAccessibilityLabel={gt("Close environments")}
        actions={[
          {
            accessibilityLabel: gt("Add environment"),
            icon: "plus",
            onPress: () => navigation.navigate("ConnectionsNew"),
          },
        ]}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        <LocalEnvironmentList
          environments={connectedEnvironments.filter(
            (environment) => !clusterMemberIds.has(environment.environmentId),
          )}
          expandedId={expandedId}
          onToggle={handleToggle}
          onReconnect={onReconnectEnvironment}
          onRemove={onRemoveEnvironmentPress}
          onSetEnabled={onSetEnvironmentEnabled}
          onUpdate={onUpdateEnvironment}
        />
        {connectedEnvironments
          .filter((environment) => environment.connectionState === "connected")
          .map((environment) => (
            <Fragment key={environment.environmentId}>
              <LinkedEnvironmentsSection
                environmentId={environment.environmentId}
                environmentLabel={environment.environmentLabel}
              />
              <LinkSeveralEnvironmentsAction
                environmentId={environment.environmentId}
                environmentLabel={environment.environmentLabel}
              />
            </Fragment>
          ))}
        {clusterHosts.map((environment) => (
          <ClusterSection
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environmentLabel={environment.label}
          />
        ))}
        <PullRequestRoutingSettings />
        <LoadBalancingSettings />
      </ScrollView>
    </View>
  );
}
