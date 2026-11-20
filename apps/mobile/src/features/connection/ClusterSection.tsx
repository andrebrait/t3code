import { useAtomValue } from "@effect/atom-react";
import {
  clusterActions,
  clusterJoinTarget,
  clusterMemberConnectionPhase,
  clusterMemberStatusText,
  offersCluster,
} from "@t3tools/client-runtime/state/cluster";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ClusterJoinCode,
  type ClusterMember,
  type EnvironmentId,
  parseClusterJoinUrl,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import * as Clipboard from "expo-clipboard";
import { useGT, useMessages } from "gt-react-native";
import { type ReactNode, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { Sheet } from "../../components/ui/Sheet";
import type { MessageResolver } from "../../i18n/messages";
import { cn } from "../../lib/cn";
import { clusterEnvironment } from "../../state/cluster";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentServerConfig } from "../../state/entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
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

type Sheets = "add" | "join" | { readonly member: ClusterMember } | null;

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
  const { presentationById } = useEnvironments();
  const members = useEnvironmentQuery(
    role === "main"
      ? clusterEnvironment.members({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const actions = clusterActions(role ?? "standalone", {
    enabled,
    canAdd: useAtomValue(clusterEnvironment.addMember.permissionAtom(props.environmentId)),
    canJoin: useAtomValue(clusterEnvironment.createJoinCode.permissionAtom(props.environmentId)),
  });
  const canLeave = useAtomValue(clusterEnvironment.leave.permissionAtom(props.environmentId));
  const leave = useAtomCommand(clusterEnvironment.leave, { label: "leave cluster" });
  const [leaving, setLeaving] = useState(false);
  const [sheet, setSheet] = useState<Sheets>(null);
  if (status.data === null || role === null) return null;
  if (!enabled && role === "standalone") return null;
  const title = gt("Cluster · {environment}", { environment: props.environmentLabel });
  const closeSheet = () => setSheet(null);
  const addRow = actions.add ? (
    <ListActionRow
      icon="plus"
      label={gt("Add member")}
      {...(role === "standalone"
        ? { description: gt("Makes this machine the main host of a new cluster.") }
        : {})}
      onPress={() => setSheet("add")}
    />
  ) : null;

  if (role === "member") {
    const host = status.data.host?.label ?? "";
    return (
      <View className="mt-5">
        <SettingsSection title={title}>
          <Row>
            <Text className="text-base font-t3-bold text-foreground">
              {gt("Member of {host}", { host })}
            </Text>
          </Row>
          {canLeave ? (
            <Separated>
              <ListActionRow
                icon="arrow.left"
                tone="danger"
                label={gt("Leave cluster")}
                loading={leaving}
                onPress={() =>
                  Dialog.confirm({
                    title: gt("Leave cluster?"),
                    message: gt("Pair clients with this machine again afterwards."),
                    confirmText: gt("Leave cluster"),
                    destructive: true,
                    onConfirm: () =>
                      void (async () => {
                        setLeaving(true);
                        const result = await leave({
                          environmentId: props.environmentId,
                          input: {},
                        });
                        setLeaving(false);
                        alertFailure(gt("Could not leave the cluster"), result, m);
                      })(),
                  })
                }
              />
            </Separated>
          ) : null}
        </SettingsSection>
      </View>
    );
  }

  return (
    <View className="mt-5 gap-3">
      {role === "main" ? (
        <SettingsSection title={title}>
          {members.error ? (
            <Row>
              <Text className="text-xs text-danger-foreground">{members.error}</Text>
            </Row>
          ) : members.data === null ? (
            <Row>
              <View className="flex-row items-center gap-2" accessibilityRole="progressbar">
                <AppActivityIndicator />
                <Text className="text-sm text-foreground-muted">
                  {gt("Loading cluster members…")}
                </Text>
              </View>
            </Row>
          ) : members.data.length === 0 ? (
            <Row>
              <Text className="text-sm text-foreground-muted">{gt("No members yet")}</Text>
              <Text className="text-xs text-foreground-muted">
                {gt(
                  "On the other machine, choose Join a cluster… and enter its join URL in Add member.",
                )}
              </Text>
            </Row>
          ) : (
            members.data.map((member, index) => (
              <View
                key={member.environmentId}
                className={cn(
                  index > 0 && "border-t border-border-subtle",
                  member.status !== "online" && "opacity-60",
                )}
              >
                <ListRow
                  leading={
                    <ClusterMemberLight
                      member={member}
                      devicePhase={presentationById.get(member.environmentId)?.connection.phase}
                    />
                  }
                  label={member.label}
                  description={member.address}
                  meta={
                    <Text
                      textRole="footnote"
                      className={
                        member.status === "online"
                          ? "text-foreground-muted"
                          : "text-danger-foreground"
                      }
                      numberOfLines={2}
                    >
                      {clusterMemberStatusText(member, props.environmentLabel, m)}
                    </Text>
                  }
                  onPress={() => setSheet({ member })}
                />
              </View>
            ))
          )}
        </SettingsSection>
      ) : actions.join || actions.add ? (
        <SettingsSection title={title}>
          {actions.join ? (
            <ListActionRow
              icon="link"
              label={gt("Join a cluster…")}
              onPress={() => setSheet("join")}
            />
          ) : null}
          {actions.join && addRow !== null ? <Separated>{addRow}</Separated> : addRow}
        </SettingsSection>
      ) : null}
      {role === "main" && addRow !== null ? <SettingsSection>{addRow}</SettingsSection> : null}
      {sheet === "add" ? (
        <AddMemberSheet environmentId={props.environmentId} onClose={closeSheet} />
      ) : sheet === "join" ? (
        <JoinSheet environmentId={props.environmentId} onClose={closeSheet} />
      ) : sheet !== null ? (
        <MemberSheet
          environmentId={props.environmentId}
          hostLabel={props.environmentLabel}
          member={
            members.data?.find((member) => member.environmentId === sheet.member.environmentId) ??
            sheet.member
          }
          onClose={closeSheet}
        />
      ) : null}
    </View>
  );
}

const Row = ({ children }: { readonly children: ReactNode }) => (
  <View className="gap-0.5 p-4">{children}</View>
);

const Separated = ({ children }: { readonly children: ReactNode }) => (
  <View className="border-t border-border-subtle">{children}</View>
);

function ClusterMemberLight(props: {
  readonly member: ClusterMember;
  readonly devicePhase: EnvironmentConnectionPhase | undefined;
}) {
  const phase = clusterMemberConnectionPhase(props.member, props.devicePhase);
  return (
    <ConnectionStatusDot
      state={phase}
      pulse={phase === "connecting" || phase === "reconnecting"}
      size={8}
    />
  );
}

function SheetBody({ children }: { readonly children: ReactNode }) {
  return (
    <ScrollView
      className="flex-1 bg-sheet-solid"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-4 p-5 pb-10"
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

function MemberSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
  readonly member: ClusterMember;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const canRemove = useAtomValue(
    clusterEnvironment.removeMember.permissionAtom(props.environmentId),
  );
  const removeMember = useAtomCommand(clusterEnvironment.removeMember, {
    label: "remove cluster member",
  });
  const [busy, setBusy] = useState(false);
  const { member } = props;
  const remove = async () => {
    setBusy(true);
    const result = await removeMember({
      environmentId: props.environmentId,
      input: { memberId: member.environmentId },
    });
    setBusy(false);
    alertFailure(gt("Could not remove {label}", { label: member.label }), result, m);
    if (result._tag !== "Success") return;
    if (!result.value.memberNotified) {
      Dialog.alert(
        gt("Removed {label} here", { label: member.label }),
        gt("It did not answer. Run t3 cluster leave on it to finish."),
      );
    }
    if (result.value.keyRevoked === false) {
      Dialog.alert(
        gt("The cluster key is still on {label}", { label: member.label }),
        gt(
          "The main host could not reach it to remove its key. Delete the t3code-cluster line in ~/.ssh/authorized_keys there.",
        ),
      );
    }
    props.onClose();
  };
  return (
    <Sheet title={member.label} onClose={props.onClose} dismissDisabled={busy}>
      <SheetBody>
        <View className="gap-1">
          <Text selectable className="text-sm text-foreground-muted">
            {member.address}
          </Text>
          <Text
            className={
              member.status === "online"
                ? "text-sm text-foreground-muted"
                : "text-sm text-danger-foreground"
            }
          >
            {clusterMemberStatusText(member, props.hostLabel, m)}
          </Text>
        </View>
        {canRemove ? (
          <SettingsSection>
            <ListActionRow
              icon="trash"
              tone="danger"
              label={gt("Remove")}
              loading={busy}
              onPress={() =>
                Dialog.confirm({
                  title: gt("Remove {label}?", { label: member.label }),
                  message: gt("It becomes a standalone environment again."),
                  confirmText: gt("Remove"),
                  destructive: true,
                  onConfirm: () => void remove(),
                })
              }
            />
          </SettingsSection>
        ) : null}
      </SheetBody>
    </Sheet>
  );
}

function AddMemberSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const addMember = useAtomCommand(clusterEnvironment.addMember, { label: "add cluster member" });
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  // Comes only from a pasted join URL; the main host pins the member's certificate with it.
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = clusterJoinTarget({ url, code, fingerprint });
  const changeUrl = (value: string) => {
    const pasted = parseClusterJoinUrl(value);
    if (pasted === undefined) {
      setUrl(value);
      return;
    }
    setUrl(pasted.url);
    setCode(pasted.code);
    setFingerprint(pasted.fingerprint);
  };
  const submit = async () => {
    if (target === null) return;
    setBusy(true);
    const result = await addMember({ environmentId: props.environmentId, input: { target } });
    setBusy(false);
    alertFailure(gt("Could not add the member"), result, m);
    if (result._tag === "Success") props.onClose();
  };
  return (
    <Sheet title={gt("Add a member")} onClose={props.onClose} dismissDisabled={busy}>
      <SheetBody>
        <Text className="text-sm text-foreground-muted">
          {gt(
            "On the other machine, choose Join a cluster…, then enter its URL and join code here. Pasting the full join URL fills both.",
          )}
        </Text>
        <AppTextInput
          value={url}
          onChangeText={changeUrl}
          placeholder="https://box.local:3773"
          accessibilityLabel={gt("URL")}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          className="rounded-[14px] px-4 py-3.5"
        />
        <AppTextInput
          value={code}
          onChangeText={setCode}
          placeholder={gt("Join code")}
          accessibilityLabel={gt("Join code")}
          autoCapitalize="characters"
          autoCorrect={false}
          className="rounded-[14px] px-4 py-3.5"
        />
        <Button
          label={gt("Add member")}
          disabled={target === null}
          loading={busy}
          onPress={() => void submit()}
        />
      </SheetBody>
    </Sheet>
  );
}

function JoinSheet(props: { readonly environmentId: EnvironmentId; readonly onClose: () => void }) {
  const gt = useGT();
  const m = useMessages();
  const createJoinCode = useAtomCommand(clusterEnvironment.createJoinCode, {
    label: "create cluster join code",
  });
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  // Lives only in this sheet: the join code carries a one-time secret.
  const [created, setCreated] = useState<ClusterJoinCode | null>(null);
  const submit = async () => {
    setBusy(true);
    const result = await createJoinCode({
      environmentId: props.environmentId,
      input: { url: url.trim() },
    });
    setBusy(false);
    alertFailure(gt("Could not create the join code"), result, m);
    if (result._tag === "Success") setCreated(result.value);
  };
  return (
    <Sheet title={gt("Join a cluster")} onClose={props.onClose} dismissDisabled={busy}>
      <SheetBody>
        <Text className="text-sm text-foreground-muted">
          {gt(
            "Joining signs out this machine's other clients and ends its linked environments. Afterwards it is reached through the main host.",
          )}
        </Text>
        {created ? (
          <>
            {created.joinUrl === null ? null : (
              <CopyField
                label={gt("Join URL")}
                copyLabel={gt("Copy join URL")}
                value={created.joinUrl}
              />
            )}
            <CopyField
              label={gt("Join code")}
              copyLabel={gt("Copy join code")}
              value={created.code}
            />
            <Text className="text-sm text-foreground-muted">
              {gt("Paste the join URL in the main host's Add member.")}
            </Text>
            <Text selectable className="text-xs text-foreground-muted">
              {gt("Certificate SHA-256: {fingerprint}", { fingerprint: created.fingerprint })}
            </Text>
          </>
        ) : (
          <>
            <Text className="text-xs text-foreground-muted">
              {gt("Address the main host reaches this machine at")}
            </Text>
            <AppTextInput
              value={url}
              onChangeText={setUrl}
              placeholder="https://box.local:3773"
              accessibilityLabel={gt("Address the main host reaches this machine at")}
              autoCapitalize="none"
              autoCorrect={false}
              className="rounded-[14px] px-4 py-3.5"
            />
            <Button
              label={gt("Create join code")}
              disabled={url.trim().length === 0}
              loading={busy}
              onPress={() => void submit()}
            />
          </>
        )}
      </SheetBody>
    </Sheet>
  );
}

function CopyField(props: {
  readonly label: string;
  readonly copyLabel: string;
  readonly value: string;
}) {
  return (
    <View className="gap-2">
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      <Text selectable className="rounded-xl bg-subtle p-3 font-mono text-xs text-foreground">
        {props.value}
      </Text>
      <Button
        label={props.copyLabel}
        onPress={() => void Clipboard.setStringAsync(props.value).catch(() => undefined)}
      />
    </View>
  );
}
