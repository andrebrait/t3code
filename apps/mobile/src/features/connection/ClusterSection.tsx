import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import {
  clusterAddTarget,
  clusterMemberStatusText,
  offersCluster,
} from "@t3tools/client-runtime/state/cluster";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import type { ClusterMember, EnvironmentId } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useGT, useMessages } from "gt-react-native";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import type { MessageResolver } from "../../i18n/messages";
import { clusterEnvironment } from "../../state/cluster";
import { useEnvironmentServerConfig } from "../../state/entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

function alertFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
  m: MessageResolver,
) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    Dialog.alert(title, formatEnvironmentQueryError(result.cause, m));
  }
}

export function ClusterSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const config = useEnvironmentServerConfig(props.environmentId);
  const enabled = offersCluster(config);
  const status = useEnvironmentQuery(
    clusterEnvironment.status({ environmentId: props.environmentId, input: {} }),
  );
  const role = status.data?.role ?? null;
  const members = useEnvironmentQuery(
    role === "main"
      ? clusterEnvironment.members({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const canAdd = useAtomValue(clusterEnvironment.addMember.permissionAtom(props.environmentId));
  const canInvite = useAtomValue(clusterEnvironment.invite.permissionAtom(props.environmentId));
  const canLeave = useAtomValue(clusterEnvironment.leave.permissionAtom(props.environmentId));
  const addMember = useAtomCommand(clusterEnvironment.addMember, { label: "add cluster member" });
  const leave = useAtomCommand(clusterEnvironment.leave, { label: "leave cluster" });
  const invite = useAtomCommand(clusterEnvironment.invite, { label: "create cluster invite" });
  const [joinInput, setJoinInput] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [joinString, setJoinString] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The join string carries the invite secret, so it does not outlive the screen.
  useFocusEffect(useCallback(() => () => setJoinString(null), []));
  if (status.data === null || role === null) return null;
  if (!enabled && role === "standalone") return null;
  const target = clusterAddTarget(joinInput, { ssh: false });
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  return (
    <View className="mt-5 gap-3">
      <SettingsSection
        title={gt("Cluster · {environment}", { environment: props.environmentLabel })}
      >
        {role === "member" ? (
          <View className="gap-2 p-4">
            <Text className="text-base font-t3-bold text-foreground">
              {gt("Member of {host}", { host: status.data.host?.label ?? "" })}
            </Text>
            {canLeave ? (
              <Button
                label={gt("Leave cluster")}
                tone="danger"
                size="compact"
                loading={busy}
                onPress={() =>
                  Dialog.confirm({
                    title: gt("Leave cluster?"),
                    message: gt("Pair clients with this machine again afterwards."),
                    confirmText: gt("Leave cluster"),
                    destructive: true,
                    onConfirm: () =>
                      void run(async () =>
                        alertFailure(
                          gt("Could not leave the cluster"),
                          await leave({ environmentId: props.environmentId, input: {} }),
                          m,
                        ),
                      ),
                  })
                }
              />
            ) : null}
          </View>
        ) : (
          <>
            {role === "main" && members.error ? (
              <Text className="p-4 text-xs text-danger-foreground">{members.error}</Text>
            ) : null}
            {(members.data ?? []).map((member) => (
              <ClusterMemberItem
                key={member.environmentId}
                environmentId={props.environmentId}
                hostLabel={props.environmentLabel}
                member={member}
              />
            ))}
            {enabled && (canAdd || canInvite) ? (
              <View className="gap-2 p-4">
                {canAdd ? (
                  <>
                    <AppTextInput
                      value={joinInput}
                      onChangeText={setJoinInput}
                      placeholder={gt("Paste a join string")}
                      accessibilityLabel={gt("Join string")}
                      autoCapitalize="none"
                      autoCorrect={false}
                      multiline
                      className="rounded-[14px] px-4 py-3.5"
                    />
                    <Button
                      label={gt("Add member")}
                      size="compact"
                      disabled={target === null}
                      loading={busy}
                      onPress={() =>
                        void run(async () => {
                          if (target === null) return;
                          const result = await addMember({
                            environmentId: props.environmentId,
                            input: { target },
                          });
                          alertFailure(gt("Could not add the member"), result, m);
                          if (result._tag === "Success") setJoinInput("");
                        })
                      }
                    />
                  </>
                ) : null}
                {canInvite ? (
                  <>
                    <AppTextInput
                      value={inviteUrl}
                      onChangeText={setInviteUrl}
                      placeholder="https://box.local:3773"
                      accessibilityLabel={gt("Address the main host reaches this machine at")}
                      autoCapitalize="none"
                      autoCorrect={false}
                      className="rounded-[14px] px-4 py-3.5"
                    />
                    <Button
                      label={gt("Invite to cluster")}
                      size="compact"
                      tone="secondary"
                      loading={busy}
                      onPress={() =>
                        void run(async () => {
                          const result = await invite({
                            environmentId: props.environmentId,
                            input: inviteUrl.trim() ? { url: inviteUrl.trim() } : {},
                          });
                          alertFailure(gt("Could not create the invite"), result, m);
                          if (result._tag === "Success") setJoinString(result.value.joinString);
                        })
                      }
                    />
                    {joinString === null ? null : (
                      <Button
                        label={gt("Copy join string")}
                        size="compact"
                        tone="text"
                        onPress={() =>
                          void Clipboard.setStringAsync(joinString).catch(() => undefined)
                        }
                      />
                    )}
                  </>
                ) : null}
                <Text className="text-xs text-foreground-muted">
                  {gt("Certificate SHA-256: {fingerprint}", {
                    fingerprint: status.data.fingerprint,
                  })}
                </Text>
              </View>
            ) : null}
          </>
        )}
      </SettingsSection>
    </View>
  );
}

function ClusterMemberItem(props: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
  readonly member: ClusterMember;
}) {
  const gt = useGT();
  const m = useMessages();
  const canRemove = useAtomValue(
    clusterEnvironment.removeMember.permissionAtom(props.environmentId),
  );
  const removeMember = useAtomCommand(clusterEnvironment.removeMember, {
    label: "remove cluster member",
  });
  const online = props.member.status === "online";
  const remove = async () => {
    const result = await removeMember({
      environmentId: props.environmentId,
      input: { memberId: props.member.environmentId },
    });
    alertFailure(gt("Could not remove {label}", { label: props.member.label }), result, m);
    if (result._tag === "Success" && !result.value.memberNotified) {
      Dialog.alert(
        gt("Removed {label} here", { label: props.member.label }),
        gt("It did not answer. Run t3 cluster leave on it to finish."),
      );
    }
  };
  return (
    <View className={online ? "gap-0.5 p-4" : "gap-0.5 p-4 opacity-60"}>
      <Text className="text-base font-t3-bold text-foreground">{props.member.label}</Text>
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {props.member.address}
      </Text>
      <Text
        className={online ? "text-xs text-foreground-muted" : "text-xs text-danger-foreground"}
        numberOfLines={2}
      >
        {clusterMemberStatusText(props.member, props.hostLabel, m)}
      </Text>
      {canRemove ? (
        <Button
          label={gt("Remove")}
          tone="text"
          size="compact"
          onPress={() =>
            Dialog.confirm({
              title: gt("Remove {label}?", { label: props.member.label }),
              message: gt("It becomes a standalone environment again."),
              confirmText: gt("Remove"),
              destructive: true,
              onConfirm: () => void remove(),
            })
          }
        />
      ) : null}
    </View>
  );
}
