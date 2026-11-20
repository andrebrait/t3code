import { useAtomValue } from "@effect/atom-react";
import {
  clusterActions,
  clusterJoinTarget,
  clusterKeyPathValid,
  clusterMemberConnectionPhase,
  clusterMemberStatusText,
  clusterSshLogin,
  clusterSshTarget,
  defaultClusterJoinAddress,
} from "@t3tools/client-runtime/state/cluster";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ClusterAddMemberInput,
  ClusterError,
  type ClusterJoinCode,
  type ClusterMember,
  type ClusterSshKeyFile,
  type ClusterSshLogin,
  type EnvironmentId,
  parseClusterJoinUrl,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, LinkIcon, PlusIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { type ComponentProps, type ReactNode, useId, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import { clusterEnvironment } from "~/state/cluster";
import { useEnvironmentHttpBaseUrl, useEnvironments } from "~/state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import type { MessageResolver } from "../../i18n/messages";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const commandFailure = (result: AtomCommandResult<unknown, unknown>, m: MessageResolver) =>
  result._tag === "Failure" && !isAtomCommandInterrupted(result)
    ? formatEnvironmentQueryError(result.cause, m)
    : null;

const isClusterError = Schema.is(ClusterError);

/** The host key an ssh add stopped at, for the user to trust or replace. */
const hostKeyFailure = (result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag !== "Failure") return null;
  const error = Cause.squash(result.cause);
  return isClusterError(error) &&
    error.hostKey !== undefined &&
    (error.reason === "host_key_unknown" || error.reason === "host_key_changed")
    ? { changed: error.reason === "host_key_changed", ...error.hostKey }
    : null;
};

const FailureText = ({ error }: { readonly error: string | null }) =>
  error === null ? null : (
    <p role="alert" className="mt-2 text-xs text-destructive">
      {error}
    </p>
  );

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
  const role = status.data?.role ?? null;
  const actions = clusterActions(role ?? "standalone", {
    enabled,
    canAdd: useAtomValue(clusterEnvironment.addMember.permissionAtom(environmentId)),
    canJoin: useAtomValue(clusterEnvironment.createJoinCode.permissionAtom(environmentId)),
  });
  if (!enabled && role !== "main" && role !== "member") return null;
  return (
    <SettingsSection
      {...(isSearchTarget ? { id: search.id } : {})}
      title={showLabel ? `${search.title} · ${label}` : search.title}
    >
      {status.error ? (
        <SettingsRow title={gt("Could not load the cluster")} description={status.error} />
      ) : status.data === null ? (
        <SettingsRow title={gt("Loading the cluster…")} role="status" />
      ) : status.data.role === "member" ? (
        <MemberOfRow environmentId={environmentId} hostLabel={status.data.host?.label ?? ""} />
      ) : (
        <>
          {status.data.role === "main" ? (
            <ClusterMemberList environmentId={environmentId} hostLabel={label} />
          ) : null}
          {actions.join ? <JoinAction environmentId={environmentId} /> : null}
          {actions.add ? (
            <AddMemberAction
              environmentId={environmentId}
              description={
                status.data.role === "standalone"
                  ? gt("Makes this machine the main host of a new cluster.")
                  : null
              }
            />
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
          "On the other machine, choose Join a cluster… and enter its join URL in Add member.",
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

/** A settings row that opens a dialog, so adding or joining never reads as editing a member. */
function DialogRowTrigger({
  icon,
  title,
  description,
  dimmed = false,
  ...props
}: Omit<ComponentProps<"button">, "title"> & {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly dimmed?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        ITEM_ROW_CLASSNAME,
        "flex w-full min-w-0 cursor-pointer items-center gap-3 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      <div className={cn("min-w-0 flex-1 space-y-1", dimmed && "opacity-60")}>
        <div className="flex min-h-5 items-center gap-1.5">
          {icon}
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
        </div>
        {description}
      </div>
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
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
  const { presentationById } = useEnvironments();
  const phase = clusterMemberConnectionPhase(
    member,
    presentationById.get(member.environmentId)?.connection.phase,
  );
  const canWrite = useAtomValue(clusterEnvironment.removeMember.permissionAtom(environmentId));
  const removeMember = useAtomCommand(clusterEnvironment.removeMember, {
    label: "remove cluster member",
  });
  const rename = useAtomCommand(clusterEnvironment.renameMember, {
    label: "rename cluster member",
  });
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(member.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const statusText = clusterMemberStatusText(member, hostLabel, m);
  const lastSeen =
    member.lastReachedAt === null
      ? gt("Never reached")
      : gt("Last seen {time}", {
          time: formatRelativeTimeLabel(DateTime.formatIso(member.lastReachedAt), nowMs, m),
        });
  const summary = `${member.transport === "ssh" ? "SSH" : "HTTPS"} · ${member.address} · ${lastSeen}`;
  const renamed = label.trim();
  const submit = async () => {
    if (busy || renamed.length === 0 || renamed === member.label) return;
    setBusy(true);
    const result = await rename({
      environmentId,
      input: { memberId: member.environmentId, label: renamed },
    });
    setBusy(false);
    setError(commandFailure(result, m));
    if (result._tag === "Success") setOpen(false);
  };
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
    const failure = commandFailure(result, m);
    if (failure !== null) {
      setError(failure);
      return;
    }
    if (result._tag !== "Success") return;
    setOpen(false);
    if (!result.value.memberNotified) {
      toastManager.add({
        type: "warning",
        title: gt("Removed {label} here", { label: member.label }),
        description: gt("It did not answer. Run t3 cluster leave on it to finish."),
      });
    }
    if (result.value.keyRevoked === false) {
      toastManager.add({
        type: "warning",
        title: gt("The cluster key is still on {label}", { label: member.label }),
        description: gt(
          "The main host could not reach it to remove its key. Delete the t3code-cluster line in ~/.ssh/authorized_keys there.",
        ),
      });
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        setError(null);
        if (next) setLabel(member.label);
      }}
    >
      <DialogTrigger
        render={
          <DialogRowTrigger
            dimmed={member.status !== "online"}
            icon={
              <ConnectionStatusDot
                tooltipText={null}
                dotClassName={connectionPhaseDotClassName(phase)}
                pingClassName={connectionPhasePingClassName(phase)}
              />
            }
            title={member.label}
            description={
              <>
                <p className="truncate text-xs text-muted-foreground">{summary}</p>
                {member.status === "online" ? null : (
                  <p className="text-xs text-muted-foreground">{statusText}</p>
                )}
              </>
            }
          />
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{member.label}</DialogTitle>
          <DialogDescription>
            {summary}
            {member.status === "online" ? null : (
              <>
                <br />
                {statusText}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {canWrite ? (
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">
                  {gt("Member name")}
                </span>
                <Input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  disabled={busy}
                  nativeInput
                />
              </label>
            </form>
          ) : null}
          <FailureText error={error} />
        </DialogPanel>
        <DialogFooter variant="bare">
          {canWrite ? (
            <Button
              type="button"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void remove()}
            >
              {gt("Remove")}
            </Button>
          ) : null}
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            <T>Close</T>
          </DialogClose>
          {canWrite ? (
            <Button
              form={formId}
              type="submit"
              disabled={busy || renamed.length === 0 || renamed === member.label}
            >
              {busy ? gt("Saving…") : gt("Save")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const CUSTOM_KEY = "custom";

function AddMemberAction({
  environmentId,
  description,
}: {
  readonly environmentId: EnvironmentId;
  readonly description: string | null;
}) {
  const gt = useGT();
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"join" | "ssh">("join");
  const [joinUrl, setJoinUrl] = useState("");
  const [joinCode, setJoinCode] = useState("");
  // Comes only from a pasted join URL; the main host pins the member's certificate with it.
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [sshRaw, setSshRaw] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const [method, setMethod] = useState<ClusterSshLogin["_tag"]>("config");
  const [password, setPassword] = useState("");
  const [keyChoice, setKeyChoice] = useState<string | null>(null);
  const [customKeyPath, setCustomKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [keys, setKeys] = useState<ReadonlyArray<ClusterSshKeyFile> | null>(null);
  const [hostKey, setHostKey] = useState<ReturnType<typeof hostKeyFailure>>(null);
  const addMember = useAtomCommand(clusterEnvironment.addMember, { label: "add cluster member" });
  const listKeys = useAtomCommand(clusterEnvironment.sshKeys, { label: "list cluster ssh keys" });
  const ssh = mode === "ssh";
  const target = ssh
    ? clusterSshTarget(sshRaw)
    : clusterJoinTarget({ url: joinUrl, code: joinCode, fingerprint });
  const chosenKey = keys?.find((key) => key.path === keyChoice);
  const custom = keyChoice === CUSTOM_KEY;
  const login = ssh
    ? clusterSshLogin({
        method,
        password,
        keyPath: custom ? customKeyPath : (chosenKey?.path ?? ""),
        passphrase: custom || chosenKey?.encrypted === true ? passphrase : "",
      })
    : null;
  const reset = () => {
    setMode("join");
    setJoinUrl("");
    setJoinCode("");
    setFingerprint(null);
    setSshRaw("");
    setLabel("");
    setMethod("config");
    setPassword("");
    setKeyChoice(null);
    setCustomKeyPath("");
    setPassphrase("");
    setKeys(null);
    setHostKey(null);
  };
  const changeJoinUrl = (value: string) => {
    const pasted = parseClusterJoinUrl(value);
    if (pasted === undefined) {
      setJoinUrl(value);
      return;
    }
    setJoinUrl(pasted.url);
    setJoinCode(pasted.code);
    setFingerprint(pasted.fingerprint);
  };
  const chooseMethod = async (next: ClusterSshLogin["_tag"]) => {
    setMethod(next);
    if (next !== "keyFile" || keys !== null) return;
    const result = await listKeys({ environmentId, input: {} });
    setKeys(result._tag === "Success" ? result.value : []);
    setError(commandFailure(result, m));
  };
  const submit = async (trustHostKey?: ClusterAddMemberInput["trustHostKey"]) => {
    if (busy || target === null || (ssh && login === null)) return;
    setBusy(true);
    const result = await addMember({
      environmentId,
      input: {
        target,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(ssh && login !== null ? { login } : {}),
        ...(trustHostKey === undefined ? {} : { trustHostKey }),
      },
    });
    setBusy(false);
    const presented = hostKeyFailure(result);
    setHostKey(presented);
    setError(presented === null ? commandFailure(result, m) : null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Added {label}", { label: result.value.label }),
      });
      setOpen(false);
      reset();
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        setError(null);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <DialogRowTrigger
            icon={<PlusIcon aria-hidden className="size-3.5 text-muted-foreground" />}
            title={gt("Add member")}
            description={
              description === null ? null : (
                <p className="text-xs text-muted-foreground">{description}</p>
              )
            }
          />
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Add a member</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Enter the join URL and code from the other machine, or add it over SSH. Over SSH, the
              main host signs in once and installs its own key, so it can reconnect on its own.
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
            <ToggleGroup
              aria-label={gt("Add the member with")}
              value={[mode]}
              disabled={busy}
              onValueChange={(next) => {
                const value = next[0];
                if (value !== "join" && value !== "ssh") return;
                setMode(value);
                setError(null);
              }}
            >
              <Toggle value="join">
                <T>Join code</T>
              </Toggle>
              <Toggle value="ssh">SSH</Toggle>
            </ToggleGroup>
            {ssh ? (
              <>
                <label className="block space-y-1.5">
                  <span className="block text-xs font-medium text-foreground">
                    <T>SSH target</T>
                  </span>
                  <Input
                    value={sshRaw}
                    onChange={(event) => setSshRaw(event.target.value)}
                    placeholder="me@box"
                    disabled={busy}
                    autoFocus
                    nativeInput
                    spellCheck={false}
                  />
                </label>
                <Alert variant="warning">
                  <AlertTitle>
                    <T>The main host will install its own key on this machine</T>
                  </AlertTitle>
                  <AlertDescription>
                    <T>
                      It signs in once with what you choose, then adds a cluster key to{" "}
                      <code>~/.ssh/authorized_keys</code> there so it can reconnect on its own.
                      Removing the member deletes that key.
                    </T>
                  </AlertDescription>
                </Alert>
                <div className="space-y-1.5">
                  <span className="block text-xs font-medium text-foreground">
                    <T>Sign in with</T>
                  </span>
                  <RadioGroup
                    aria-label={gt("Sign in with")}
                    disabled={busy}
                    value={method}
                    onValueChange={(value) => {
                      if (value === "config" || value === "password" || value === "keyFile") {
                        void chooseMethod(value);
                      }
                    }}
                  >
                    <label className="flex items-center gap-2 text-sm">
                      <Radio value="config" />
                      <T>SSH config or agent</T>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Radio value="password" />
                      <T>Password</T>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Radio value="keyFile" />
                      <T>Key file</T>
                    </label>
                  </RadioGroup>
                </div>
                {method === "password" ? (
                  <label className="block space-y-1.5">
                    <span className="block text-xs font-medium text-foreground">
                      <T>Password</T>
                    </span>
                    <Input
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      disabled={busy}
                      autoComplete="off"
                      nativeInput
                    />
                  </label>
                ) : null}
                {method === "keyFile" ? (
                  <div className="space-y-1.5">
                    <span className="block text-xs font-medium text-foreground">
                      <T>Key on the main host</T>
                    </span>
                    <Select
                      value={keyChoice}
                      disabled={busy || keys === null}
                      onValueChange={(value) => {
                        if (typeof value === "string") setKeyChoice(value);
                      }}
                    >
                      <SelectTrigger size="sm" aria-label={gt("Key on the main host")}>
                        <SelectValue
                          placeholder={keys === null ? gt("Loading keys…") : gt("Choose a key")}
                        >
                          {(value: string | null) =>
                            value === CUSTOM_KEY
                              ? gt("Custom key path…")
                              : (keys?.find((key) => key.path === value)?.name ?? value)
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {(keys ?? []).map((key) => (
                          <SelectItem key={key.path} value={key.path}>
                            {key.encrypted
                              ? gt("{name} (passphrase)", { name: key.name })
                              : key.name}
                          </SelectItem>
                        ))}
                        <SelectItem value={CUSTOM_KEY}>
                          <T>Custom key path…</T>
                        </SelectItem>
                      </SelectPopup>
                    </Select>
                    {custom ? (
                      <Input
                        value={customKeyPath}
                        onChange={(event) => setCustomKeyPath(event.target.value)}
                        placeholder="~/.ssh/id_ed25519"
                        aria-label={gt("Custom key path")}
                        disabled={busy}
                        nativeInput
                        spellCheck={false}
                      />
                    ) : null}
                    {custom &&
                    customKeyPath.trim() !== "" &&
                    !clusterKeyPathValid(customKeyPath) ? (
                      <p role="alert" className="text-xs text-destructive">
                        <T>Enter a full path, or one that starts with ~.</T>
                      </p>
                    ) : null}
                    {custom || chosenKey?.encrypted === true ? (
                      <label className="block space-y-1.5">
                        <span className="block text-xs font-medium text-foreground">
                          <T>Passphrase</T>
                        </span>
                        <Input
                          type="password"
                          value={passphrase}
                          onChange={(event) => setPassphrase(event.target.value)}
                          disabled={busy}
                          autoComplete="off"
                          nativeInput
                        />
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="space-y-1.5">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  <label className="block space-y-1.5">
                    <span className="block text-xs font-medium text-foreground">
                      <T>URL</T>
                    </span>
                    <Input
                      value={joinUrl}
                      onChange={(event) => changeJoinUrl(event.target.value)}
                      placeholder="https://box.local:3773"
                      disabled={busy}
                      autoFocus
                      nativeInput
                      spellCheck={false}
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="block text-xs font-medium text-foreground">
                      <T>Join code</T>
                    </span>
                    <Input
                      value={joinCode}
                      onChange={(event) => setJoinCode(event.target.value)}
                      placeholder="K7M2Q9RZ3NWD"
                      disabled={busy}
                      nativeInput
                      spellCheck={false}
                    />
                  </label>
                </div>
                <p className="text-2xs text-muted-foreground">
                  <T>Paste the full join URL here to fill both fields automatically.</T>
                </p>
              </div>
            )}
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
            <FailureText error={error} />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button
            form={formId}
            type="submit"
            disabled={busy || target === null || (ssh && login === null)}
          >
            {busy ? gt("Adding…") : gt("Add member")}
          </Button>
        </DialogFooter>
      </DialogPopup>
      <AlertDialog
        open={hostKey !== null}
        onOpenChange={(next) => {
          if (!next) setHostKey(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {hostKey?.changed ? gt("Host key changed") : gt("Unknown host")}
            </AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line break-all">
              {hostKey === null
                ? null
                : hostKey.changed
                  ? gt(
                      "The host key for {host} has changed. Someone may be intercepting the connection, or the machine was reinstalled.\nNew {keyType} key fingerprint: {fingerprint}\nPreviously known: {known}",
                      {
                        host: hostKey.host,
                        keyType: hostKey.keyType,
                        fingerprint: hostKey.fingerprint,
                        known: hostKey.knownFingerprints.join(", "),
                      },
                    )
                  : gt(
                      "The authenticity of {host} can't be established. {keyType} key fingerprint is {fingerprint}. Trust this host and continue?",
                      {
                        host: hostKey.host,
                        keyType: hostKey.keyType,
                        fingerprint: hostKey.fingerprint,
                      },
                    )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant={hostKey?.changed ? "destructive" : "default"}
              onClick={() => {
                if (hostKey === null) return;
                setHostKey(null);
                void submit({ fingerprint: hostKey.fingerprint, replace: hostKey.changed });
              }}
            >
              {hostKey?.changed ? gt("Replace and continue") : gt("Trust")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Dialog>
  );
}

function JoinAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ClusterJoinCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const createJoinCode = useAtomCommand(clusterEnvironment.createJoinCode, {
    label: "create cluster join code",
  });
  const [copied, setCopied] = useState<"url" | "code" | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<"url" | "code">({ onCopy: setCopied });
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const result = await createJoinCode({
      environmentId,
      input: url.trim() ? { url: url.trim() } : {},
    });
    setBusy(false);
    setError(commandFailure(result, m));
    if (result._tag === "Success") setCreated(result.value);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        // The join code carries a one-time secret, so it does not outlive the dialog.
        setCreated(null);
        setError(null);
        if (next) setUrl(defaultClusterJoinAddress(httpBaseUrl));
      }}
    >
      <DialogTrigger
        render={
          <DialogRowTrigger
            icon={<LinkIcon aria-hidden className="size-3.5 text-muted-foreground" />}
            title={gt("Join a cluster…")}
            description={
              <p className="text-xs text-muted-foreground">
                <T>Lets a main host add this machine as a member.</T>
              </p>
            }
          />
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Join a cluster</T>
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
              <FailureText error={error} />
            </form>
          ) : (
            <div className="space-y-3 text-sm">
              {created.joinUrl === null ? null : (
                <CopyField
                  label={gt("Join URL")}
                  value={created.joinUrl}
                  copied={isCopied && copied === "url"}
                  onCopy={() => copyToClipboard(created.joinUrl ?? "", "url")}
                />
              )}
              <CopyField
                label={gt("Join code")}
                value={created.code}
                copied={isCopied && copied === "code"}
                onCopy={() => copyToClipboard(created.code, "code")}
              />
              <p className="text-xs text-muted-foreground">
                {created.joinUrl === null ? (
                  <T>Add an address to get a join URL.</T>
                ) : (
                  <T>
                    Paste the join URL in the main host's Add member. Certificate SHA-256:{" "}
                    <Var>{created.fingerprint}</Var>
                  </T>
                )}
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
              {busy ? gt("Creating…") : gt("Create join code")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CopyField(props: {
  readonly label: string;
  readonly value: string;
  readonly copied: boolean;
  readonly onCopy: () => void;
}) {
  const gt = useGT();
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-foreground">{props.label}</span>
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 break-all font-mono text-xs">{props.value}</code>
        <Button size="xs" variant="ghost" className="shrink-0" onClick={props.onCopy}>
          {props.copied ? gt("Copied") : gt("Copy")}
        </Button>
      </div>
    </div>
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
  const m = useMessages();
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
    const result = await leave({ environmentId, input: {} });
    setBusy(false);
    const error = commandFailure(result, m);
    if (error !== null) {
      toastManager.add({
        type: "error",
        title: gt("Could not leave the cluster"),
        description: error,
      });
    }
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
