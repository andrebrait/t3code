// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect has no ed25519 key export.
import * as NodeCrypto from "node:crypto";
import {
  ClusterError,
  type ClusterSshKeyFile,
  type ClusterSshLogin,
  parseClusterSshTarget,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SshAuth from "@t3tools/ssh/auth";
import { type RunSshCommandOptions, runSshCommand, shellSingleQuote } from "@t3tools/ssh/command";
import { SshCommandError } from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

// Remote scripts run as `sh -c` with their one input line on stdin, so nothing is interpolated.
// One line each: a csh login shell rejects newlines inside a quoted argument.
/** Appends the stdin key line unless present, replacing older lines with its tag (last field). */
export const AUTHORIZE_KEY_SCRIPT = `umask 077; IFS= read -r line; [ -n "$line" ] || exit 1; d="$HOME/.ssh"; f="$d/authorized_keys"; [ -d "$d" ] || mkdir -m 700 "$d" || exit 1; [ -f "$f" ] || : > "$f" || exit 1; grep -qxF -- "$line" "$f" && exit 0; t="$f.t3code.$$"; T="\${line##* }" awk '$NF != ENVIRON["T"]' "$f" > "$t" && printf '%s\\n' "$line" >> "$t" && cat "$t" > "$f"; s=$?; rm -f "$t"; exit $s`;

/** Deletes the lines whose last field is the stdin tag. */
export const REVOKE_KEY_SCRIPT = `umask 077; IFS= read -r tag; [ -n "$tag" ] || exit 1; f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] || exit 0; t="$f.t3code.$$"; T="$tag" awk '$NF != ENVIRON["T"]' "$f" > "$t" && cat "$t" > "$f"; s=$?; rm -f "$t"; exit $s`;

const KEY_SECRET = "cluster-ssh-key";
const KEY_FILE = "cluster_ed25519";
const REMOTE_TIMEOUT_MS = 30_000;

const clusterKeyTag = (environmentId: string) => `t3code-cluster:${environmentId}`;

const encoder = new TextEncoder();
const uint32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};
const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const sshString = (bytes: Uint8Array) => concat(uint32(bytes.length), bytes);
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** An ed25519 key pair from a 32-byte seed: OpenSSH's private key file and `ssh-ed25519 …`. */
export const makeKeyPair = (seed: Uint8Array, comment: string) => {
  const privateKey = NodeCrypto.createPrivateKey({
    key: Buffer.from(concat(PKCS8_ED25519_PREFIX, seed)),
    format: "der",
    type: "pkcs8",
  });
  const publicBytes = Uint8Array.from(
    Buffer.from(
      NodeCrypto.createPublicKey(privateKey).export({ format: "jwk" }).x ?? "",
      "base64url",
    ),
  );
  const keyType = encoder.encode("ssh-ed25519");
  const publicBlob = concat(sshString(keyType), sshString(publicBytes));
  const check = publicBytes.subarray(0, 4);
  const secret = concat(
    check,
    check,
    sshString(keyType),
    sshString(publicBytes),
    sshString(concat(seed, publicBytes)),
    sshString(encoder.encode(comment)),
  );
  const padding = Uint8Array.from({ length: (8 - (secret.length % 8)) % 8 }, (_, i) => i + 1);
  const body = concat(
    encoder.encode("openssh-key-v1\0"),
    sshString(encoder.encode("none")),
    sshString(encoder.encode("none")),
    sshString(new Uint8Array()),
    uint32(1),
    sshString(publicBlob),
    sshString(concat(secret, padding)),
  );
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${
      toBase64(body)
        .match(/.{1,70}/g)
        ?.join("\n") ?? ""
    }\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${toBase64(publicBlob)}`,
  };
};

/** How ssh signs in for a one-time login; secrets reach ssh only through askpass. */
export const loginOptions = (login: ClusterSshLogin): RunSshCommandOptions => {
  switch (login._tag) {
    case "config":
      return { batchMode: "yes" };
    case "password":
      return {
        authSecret: Redacted.value(login.password),
        batchMode: "no",
        interactiveAuth: true,
        preHostArgs: [
          "-o",
          "PubkeyAuthentication=no",
          "-o",
          "PreferredAuthentications=keyboard-interactive,password",
          "-o",
          "NumberOfPasswordPrompts=1",
        ],
      };
    case "keyFile":
      return {
        identityFile: login.path,
        ...(login.passphrase === undefined
          ? { batchMode: "yes" }
          : {
              authSecret: Redacted.value(login.passphrase),
              batchMode: "no",
              interactiveAuth: true,
            }),
        preHostArgs: ["-o", "PreferredAuthentications=publickey"],
      };
  }
};

const HEADER_BYTES = 2048;
const PRIVATE_KEY_HEADER = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const OPENSSH_BODY = /-----BEGIN OPENSSH PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)/;
const NOT_KEYS = /^(?:config|known_hosts.*|authorized_keys.*|.*\.pub)$/;

const isEncrypted = (header: string) => {
  if (header.includes("ENCRYPTED")) return true;
  const body = OPENSSH_BODY.exec(header)?.[1]?.replace(/\s+/g, "").slice(0, 64);
  if (body === undefined) return false;
  try {
    const bytes = atob(body.slice(0, body.length - (body.length % 4)));
    if (!bytes.startsWith("openssh-key-v1\0")) return false;
    const length = new DataView(Uint8Array.from(bytes, (c) => c.charCodeAt(0)).buffer).getUint32(
      15,
    );
    return bytes.slice(19, 19 + length) !== "none";
  } catch {
    return false;
  }
};

/** Private keys in `directory`: a header says so, or a `.pub` sits beside them. Reads headers only. */
export const listSshKeyFiles = Effect.fn("ClusterSshKey.listSshKeyFiles")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const keys: Array<ClusterSshKeyFile> = [];
  for (const name of names.toSorted()) {
    if (NOT_KEYS.test(name)) continue;
    const file = path.join(directory, name);
    const header = yield* fs.stat(file).pipe(
      Effect.flatMap((info) =>
        info.type === "File"
          ? Effect.scoped(
              fs.open(file).pipe(Effect.flatMap((handle) => handle.readAlloc(HEADER_BYTES))),
            )
          : Effect.succeedNone,
      ),
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(header)) continue;
    if (!PRIVATE_KEY_HEADER.test(header.value) && !names.includes(`${name}.pub`)) continue;
    keys.push({ path: file, name, encrypted: isEncrypted(header.value) });
  }
  return keys;
});

const toSshTarget = (sshTarget: string) => {
  const parsed = parseClusterSshTarget(sshTarget);
  return parsed === undefined
    ? Effect.fail(
        new ClusterError({
          reason: "invalid_target",
          message: `${sshTarget} is not an ssh target such as me@box.`,
        }),
      )
    : Effect.succeed({ alias: parsed.hostname, ...parsed });
};

const loginError = (sshTarget: string, login: ClusterSshLogin, cause: unknown) =>
  new ClusterError({
    reason: "ssh",
    message: SshAuth.isSshAuthFailure(cause)
      ? login._tag === "config"
        ? `SSH to ${sshTarget} refused this machine's ssh keys and agent. Sign in with a password or a key file.`
        : login._tag === "password"
          ? `SSH to ${sshTarget} refused that password.`
          : `SSH to ${sshTarget} refused that key or its passphrase.`
      : cause instanceof Error
        ? cause.message
        : `SSH to ${sshTarget} failed.`,
    cause,
  });

/** The main host's own ssh key, which every ssh member link signs in with. */
export class ClusterSshKey extends Context.Service<
  ClusterSshKey,
  {
    /** The private key file, made the first time it is needed. */
    readonly identityFile: Effect.Effect<string, ClusterError>;
    /** Signs in once with `login` and adds the cluster key to the member's authorized_keys. */
    readonly authorize: (
      sshTarget: string,
      login: ClusterSshLogin,
    ) => Effect.Effect<void, ClusterError>;
    /** Deletes the cluster key there over the cluster key itself; false when it could not. */
    readonly revoke: (sshTarget: string) => Effect.Effect<boolean>;
    /** The private keys in this machine's `~/.ssh`, for a one-time login. */
    readonly list: Effect.Effect<ReadonlyArray<ClusterSshKeyFile>>;
  }
>()("t3/cluster/ClusterSshKey") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sshContext = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >();
  const lock = yield* Semaphore.make(1);
  let prepared: { readonly file: string; readonly line: string; readonly tag: string } | undefined;

  const prepare = Effect.gen(function* () {
    const seed = yield* secrets.getOrCreateRandom(KEY_SECRET, 32);
    const tag = clusterKeyTag(yield* environment.getEnvironmentId);
    const pair = makeKeyPair(seed, tag);
    const file = path.join(config.secretsDir, KEY_FILE);
    // Renamed into place, so a CLI and the server writing it at once never leave half a key.
    const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fs.writeFileString(temp, pair.privateKey, { mode: 0o600 });
    yield* fs.chmod(temp, 0o600);
    yield* fs.rename(temp, file);
    return { file, line: `${pair.publicKey} ${tag}`, tag };
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ClusterError({
          reason: "storage",
          message: "This machine's cluster ssh key could not be read or saved.",
          cause,
        }),
    ),
  );

  const ensure = lock.withPermits(1)(
    Effect.suspend(() =>
      prepared !== undefined
        ? Effect.succeed(prepared)
        : prepare.pipe(Effect.tap((key) => Effect.sync(() => (prepared = key)))),
    ),
  );

  const authorize: ClusterSshKey["Service"]["authorize"] = Effect.fn("ClusterSshKey.authorize")(
    function* (sshTarget, login) {
      const target = yield* toSshTarget(sshTarget);
      const key = yield* ensure;
      yield* runSshCommand(target, {
        ...loginOptions(login),
        remoteCommandArgs: ["sh", "-c", shellSingleQuote(AUTHORIZE_KEY_SCRIPT)],
        stdin: `${key.line}\n`,
        timeoutMs: REMOTE_TIMEOUT_MS,
      }).pipe(
        Effect.provideContext(sshContext),
        Effect.mapError((cause) => loginError(sshTarget, login, cause)),
      );
    },
  );

  const revoke: ClusterSshKey["Service"]["revoke"] = Effect.fn("ClusterSshKey.revoke")(
    function* (sshTarget) {
      const target = yield* toSshTarget(sshTarget);
      const key = yield* ensure;
      yield* runSshCommand(target, {
        identityFile: key.file,
        batchMode: "yes",
        remoteCommandArgs: ["sh", "-c", shellSingleQuote(REVOKE_KEY_SCRIPT)],
        stdin: `${key.tag}\n`,
        timeoutMs: REMOTE_TIMEOUT_MS,
      }).pipe(Effect.provideContext(sshContext));
      return true;
    },
    Effect.catch((cause) =>
      Effect.logWarning("Could not remove the cluster key from a removed member", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  const list = Effect.gen(function* () {
    return yield* listSshKeyFiles(path.join(yield* HostProcess.HomeDirectory, ".ssh"));
  }).pipe(Effect.provideContext(sshContext));

  return ClusterSshKey.of({
    identityFile: ensure.pipe(Effect.map((key) => key.file)),
    authorize,
    revoke,
    list,
  });
});

export const layer = Layer.effect(ClusterSshKey, make);

/** The ssh manager for member links: members outlive this host, and only the cluster key signs in. */
export const layerSshManager = Layer.unwrap(
  Effect.gen(function* () {
    const key = yield* ClusterSshKey;
    return SshTunnel.SshEnvironmentManager.layer({
      keepRemoteServer: true,
      identityFile: key.identityFile.pipe(
        Effect.mapError(
          (error) =>
            new SshCommandError({
              message: error.message,
              command: ["ssh"],
              exitCode: null,
              stderr: "",
            }),
        ),
      ),
    });
  }),
);
