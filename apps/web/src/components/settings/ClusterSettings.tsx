import { useAtomValue } from "@effect/atom-react";
import {
  clusterAddTarget,
  clusterMemberStatusText,
  defaultClusterInviteUrl,
} from "@t3tools/client-runtime/state/cluster";
import type { ClusterInvite, ClusterMember, EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { PlusIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { useId, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import { clusterEnvironment } from "~/state/cluster";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function ClusterSettings({
  environmentId,
  label,
  enabled,
  showLabel,
  isSearchTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The beta is on there. Off, only the way out of an existing cluster shows. */
  readonly enabled: boolean;
  readonly showLabel: boolean;
  readonly isSearchTarget: boolean;
}) {
  const gt = useGT();
  const search = useSearchableSetting()("cluster");
  const status = useEnvironmentQuery(
    clusterEnvironment.status({ environmentId, input: {} }),
    useMessages(),
  );
  const canAdd = useAtomValue(clusterEnvironment.addMember.permissionAtom(environmentId));
  const role = status.data?.role ?? null;
  if (!enabled && role !== "main" && role !== "member") return null;
  return (
    <SettingsSection
      {...(isSearchTarget ? { id: search.id } : {})}
      title={showLabel ? `${search.title} · ${label}` : search.title}
      headerAction={
        enabled && canAdd && (role === "standalone" || role === "main") ? (
          <AddMemberAction environmentId={environmentId} />
        ) : null
      }
    >
      {status.error ? (
        <SettingsRow title={gt("Could not load the cluster")} description={status.error} />
      ) : status.data === null ? (
        <SettingsRow title={gt("Loading the cluster…")} role="status" />
      ) : status.data.role === "member" ? (
        <MemberOfRow environmentId={environmentId} hostLabel={status.data.host?.label ?? ""} />
      ) : (
        <>
          {enabled ? (
            <InviteRow environmentId={environmentId} fingerprint={status.data.fingerprint} />
          ) : null}
          {status.data.role === "main" ? (
            <ClusterMemberList environmentId={environmentId} hostLabel={label} />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

function ClusterMemberList({
  environmentId,
  hostLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
}) {
  const gt = useGT();
  const members = useEnvironmentQuery(
    clusterEnvironment.members({ environmentId, input: {} }),
    useMessages(),
  );
  if (members.error) {
    return <SettingsRow title={gt("Could not load cluster members")} description={members.error} />;
  }
  if (members.data === null) {
    return <SettingsRow title={gt("Loading cluster members…")} role="status" />;
  }
  if (members.data.length === 0) {
    return (
      <SettingsRow
        title={gt("No members yet")}
        description={gt(
          "Invite a machine from its own Settings → Environments → Cluster, then add its join string here.",
        )}
      />
    );
  }
  return members.data.map((member) => (
    <ClusterMemberRow
      key={member.environmentId}
      environmentId={environmentId}
      hostLabel={hostLabel}
      member={member}
    />
  ));
}

function ClusterMemberRow({
  environmentId,
  hostLabel,
  member,
}: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
  readonly member: ClusterMember;
}) {
  const gt = useGT();
  const m = useMessages();
  const nowMs = Date.parse(useNowMinute());
  const canWrite = useAtomValue(clusterEnvironment.removeMember.permissionAtom(environmentId));
  const removeMember = useAtomCommand(clusterEnvironment.removeMember, {
    label: "remove cluster member",
  });
  const [busy, setBusy] = useState(false);
  const statusText = clusterMemberStatusText(member, hostLabel, m);
  const lastSeen =
    member.lastReachedAt === null
      ? gt("Never reached")
      : gt("Last seen {time}", {
          time: formatRelativeTimeLabel(DateTime.formatIso(member.lastReachedAt), nowMs, m),
        });
  const remove = async () => {
    const confirmed = await (requestConfirmDialog(
      gt("Remove {label} from the cluster? It becomes a standalone environment again.", {
        label: member.label,
      }),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await removeMember({
      environmentId,
      input: { memberId: member.environmentId },
    });
    setBusy(false);
    if (result._tag === "Success" && !result.value.memberNotified) {
      toastManager.add({
        type: "warning",
        title: gt("Removed {label} here", { label: member.label }),
        description: gt("It did not answer. Run t3 cluster leave on it to finish."),
      });
    }
  };
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className={cn("min-w-0 flex-1 space-y-1", member.status !== "online" && "opacity-60")}>
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusText}
              dotClassName={
                member.status === "online"
                  ? "bg-success"
                  : member.status === "offline"
                    ? "bg-muted-foreground/30"
                    : "bg-destructive"
              }
              pingClassName={null}
            />
            <h3 className="text-sm font-medium text-foreground">{member.label}</h3>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {member.transport === "ssh" ? "SSH" : "HTTPS"} · {member.address} · {lastSeen}
          </p>
          {member.status === "online" ? null : (
            <p className="text-xs text-muted-foreground">{statusText}</p>
          )}
        </div>
        {canWrite ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <RenameMemberAction environmentId={environmentId} member={member} />
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? gt("Removing…") : gt("Remove")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RenameMemberAction({
  environmentId,
  member,
}: {
  readonly environmentId: EnvironmentId;
  readonly member: ClusterMember;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(member.label);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const rename = useAtomCommand(clusterEnvironment.renameMember, {
    label: "rename cluster member",
  });
  const submit = async () => {
    if (busy || label.trim().length === 0) return;
    setBusy(true);
    const result = await rename({
      environmentId,
      input: { memberId: member.environmentId, label: label.trim() },
    });
    setBusy(false);
    if (result._tag === "Success") setOpen(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) setLabel(member.label);
      }}
    >
      <DialogTrigger render={<Button size="xs" variant="outline" />}>{gt("Rename")}</DialogTrigger>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <T>Rename member</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              disabled={busy}
              aria-label={gt("Member name")}
              nativeInput
            />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || label.trim().length === 0}>
            {busy ? gt("Saving…") : gt("Save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function AddMemberAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const addMember = useAtomCommand(clusterEnvironment.addMember, { label: "add cluster member" });
  const target = clusterAddTarget(raw, { ssh: true });
  const submit = async () => {
    if (busy || target === null) return;
    setBusy(true);
    const result = await addMember({
      environmentId,
      input: { target, ...(label.trim() ? { label: label.trim() } : {}) },
    });
    setBusy(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Added {label}", { label: result.value.label }),
      });
      setOpen(false);
      setRaw("");
      setLabel("");
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" />
            {gt("Add member")}
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Add a member</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Paste the join string from the machine's Invite to cluster, or enter user@host to add
              it over SSH. SSH needs a key or a running ssh-agent on this machine.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-foreground">
                <T>Join string or SSH target</T>
              </span>
              <Input
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
                placeholder="https://box.local:3773#… or me@box"
                disabled={busy}
                autoFocus
                nativeInput
                spellCheck={false}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-foreground">
                <T>Name (optional)</T>
              </span>
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                disabled={busy}
                nativeInput
              />
            </label>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || target === null}>
            {busy ? gt("Adding…") : gt("Add member")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function InviteRow({
  environmentId,
  fingerprint,
}: {
  readonly environmentId: EnvironmentId;
  readonly fingerprint: string;
}) {
  const gt = useGT();
  const canInvite = useAtomValue(clusterEnvironment.invite.permissionAtom(environmentId));
  return (
    <SettingsRow
      title={gt("Invite to cluster")}
      description={
        <T>
          Lets another machine add this one as a member. Certificate SHA-256:{" "}
          <code className="break-all">
            <Var>{fingerprint}</Var>
          </code>
        </T>
      }
      control={canInvite ? <InviteAction environmentId={environmentId} /> : null}
    />
  );
}

function InviteAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ClusterInvite | null>(null);
  const formId = useId();
  const invite = useAtomCommand(clusterEnvironment.invite, { label: "create cluster invite" });
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>();
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const result = await invite({
      environmentId,
      input: url.trim() ? { url: url.trim() } : {},
    });
    setBusy(false);
    if (result._tag === "Success") setCreated(result.value);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) {
          setUrl(defaultClusterInviteUrl(httpBaseUrl));
          setCreated(null);
        }
      }}
    >
      <DialogTrigger render={<Button size="xs" variant="outline" />}>
        {gt("Invite to cluster")}
      </DialogTrigger>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Invite to cluster</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Joining signs out this machine's other clients and ends its linked environments.
              Afterwards it is reached through the main host.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {created === null ? (
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Address the main host reaches this machine at</T>
                </span>
                <Input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://box.local:3773"
                  disabled={busy}
                  nativeInput
                  spellCheck={false}
                />
              </label>
            </form>
          ) : (
            <div className="space-y-2 text-sm">
              {created.joinString === null ? (
                <p>
                  <T>
                    Code <Var>{created.code}</Var>. Add an address to get a join string.
                  </T>
                </p>
              ) : (
                <code className="block break-all rounded-md bg-muted p-2 text-xs">
                  {created.joinString}
                </code>
              )}
              <p className="text-xs text-muted-foreground">
                <T>
                  Paste it in the main host's Add member. Certificate SHA-256:{" "}
                  <Var>{created.fingerprint}</Var>
                </T>
              </p>
            </div>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            <T>Close</T>
          </DialogClose>
          {created === null ? (
            <Button form={formId} type="submit" disabled={busy}>
              {busy ? gt("Creating…") : gt("Create invite")}
            </Button>
          ) : created.joinString !== null ? (
            <Button
              type="button"
              onClick={() => {
                if (created.joinString !== null) copyToClipboard(created.joinString, undefined);
              }}
            >
              {isCopied ? gt("Copied") : gt("Copy join string")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function MemberOfRow({
  environmentId,
  hostLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
}) {
  const gt = useGT();
  const canLeave = useAtomValue(clusterEnvironment.leave.permissionAtom(environmentId));
  const leave = useAtomCommand(clusterEnvironment.leave, { label: "leave cluster" });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const confirmed = await (requestConfirmDialog(
      gt("Leave the cluster of {host}? Pair clients with this machine again afterwards.", {
        host: hostLabel,
      }),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    await leave({ environmentId, input: {} });
    setBusy(false);
  };
  return (
    <SettingsRow
      title={gt("Member of {host}", { host: hostLabel })}
      description={gt(
        "{host} manages this environment and is the only machine besides this one that can reach it.",
        { host: hostLabel },
      )}
      control={
        canLeave ? (
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? gt("Leaving…") : gt("Leave cluster")}
          </Button>
        ) : null
      }
    />
  );
}
