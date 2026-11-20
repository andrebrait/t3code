import {
  ClusterError,
  type ClusterHostKey,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { parseSshConfigOutput, runSshCommand } from "@t3tools/ssh/command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface TrustHostKey {
  readonly fingerprint: string;
  readonly replace: boolean;
}

const PROBE_TIMEOUT_MS = 30_000;

// OpenSSH has no translations, so these phrases are stable.
/** What ssh made of the host key, from a strict check that never authenticates. */
export const classifyHostKeyCheck = (exitCode: number | null, stderr: string) => {
  if (/REVOKED HOST KEY|is marked as revoked/.test(stderr)) return { _tag: "revoked" } as const;
  if (stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")) {
    const sent =
      /The fingerprint for the (\S+) key sent by the remote host is\s+(SHA256:[A-Za-z0-9+/]+)/.exec(
        stderr,
      );
    return sent === null
      ? ({ _tag: "unrecognized" } as const)
      : ({ _tag: "changed", keyType: sent[1]!, fingerprint: sent[2]! } as const);
  }
  if (stderr.includes("Host key verification failed")) {
    const keyType = /No (\S+) host key is known for/.exec(stderr)?.[1] ?? null;
    return { _tag: "unknown", keyType } as const;
  }
  if (exitCode === 0 || /Permission denied|No more authentication methods/.test(stderr)) {
    return { _tag: "known" } as const;
  }
  return { _tag: "unrecognized" } as const;
};

/**
 * `ssh -G`'s userknownhostsfile list. shortcut: ssh prints the paths joined by spaces, so a
 * token that is not an absolute path is taken as the rest of the previous one; a path whose
 * space is followed by `/` would still split.
 */
export const parseKnownHostsFiles = (value: string, isAbsolute: (file: string) => boolean) => {
  const files: Array<string> = [];
  for (const token of value.split(" ")) {
    if (files.length > 0 && !isAbsolute(token)) files[files.length - 1] += ` ${token}`;
    else if (token !== "") files.push(token);
  }
  return files.filter(isAbsolute);
};

// Keys of the type ssh named, so the probe captures the key it judged.
const HOST_KEY_ALGORITHMS: Record<string, string> = {
  ED25519: "ssh-ed25519",
  ECDSA: "ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521",
  RSA: "rsa-sha2-512,rsa-sha2-256,ssh-rsa",
  "ED25519-SK": "sk-ssh-ed25519@openssh.com",
  "ECDSA-SK": "sk-ecdsa-sha2-nistp256@openssh.com",
};

/** `ssh-keygen -l -f` lines: `256 SHA256:… host (ED25519)`. */
const parsePresented = (stdout: string) =>
  stdout.split("\n").flatMap((line) => {
    const match = /\b(SHA256:[A-Za-z0-9+/]+)\s.*\(([^)]+)\)\s*$/.exec(line);
    return match === null ? [] : [{ fingerprint: match[1]!, keyType: match[2]! }];
  });

/** `ssh-keygen -l -F` output: each match follows a `# Host … found: line N [REVOKED|CA]` header. */
const parseKnownEntries = (stdout: string) => {
  let plain = false;
  return stdout.split("\n").flatMap((line) => {
    if (line.startsWith("#")) {
      plain = /found: line \d+\s*$/.test(line);
      return [];
    }
    const fingerprint = /\bSHA256:[A-Za-z0-9+/]+/.exec(line)?.[0];
    return plain && fingerprint !== undefined ? [fingerprint] : [];
  });
};

const sshError = (message: string, cause?: unknown) =>
  new ClusterError({ reason: "ssh", message, ...(cause === undefined ? {} : { cause }) });

/**
 * Lets ssh judge the host key `target` presents against this machine's known hosts, and, once
 * the user approved that exact key, records it in known_hosts as ssh does.
 */
export const verifyHostKey = Effect.fn("ClusterHostKey.verifyHostKey")(function* (
  target: DesktopSshEnvironmentTarget,
  trust?: TrustHostKey,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const keygen = (args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make("ssh-keygen", args, { stdin: "ignore" }));
  const noAuth = ["-o", "PreferredAuthentications=none", "-o", "ControlPath=none"];

  const check = yield* runSshCommand(target, {
    batchMode: "yes",
    preHostArgs: [...noAuth, "-o", "StrictHostKeyChecking=yes"],
    remoteCommandArgs: ["true"],
    timeoutMs: PROBE_TIMEOUT_MS,
  }).pipe(
    Effect.as({ verdict: classifyHostKeyCheck(0, ""), message: "" }),
    Effect.catch((cause) =>
      Effect.succeed({
        verdict:
          cause._tag === "SshCommandError"
            ? classifyHostKeyCheck(cause.exitCode, cause.stderr)
            : ({ _tag: "unrecognized" } as const),
        message: cause.message,
      }),
    ),
  );
  const verdict = check.verdict;
  if (verdict._tag === "known") return;
  if (verdict._tag === "revoked") {
    return yield* sshError(
      `${target.hostname} presents a host key this machine marked as revoked. It cannot be trusted here.`,
    );
  }
  if (verdict._tag === "unrecognized") return yield* sshError(check.message);

  const config = parseSshConfigOutput(
    (yield* runSshCommand(target, { preHostArgs: ["-G"] }).pipe(
      Effect.mapError((cause) => sshError(cause.message, cause)),
    )).stdout,
  );
  const alias = config.get("hostkeyalias");
  const port = Number(config.get("port") ?? 22);
  const hostname = config.get("hostname") ?? target.hostname;
  const host = alias ?? (port === 22 ? hostname : `[${hostname}]:${port}`);
  const knownHostsFiles = parseKnownHostsFiles(config.get("userknownhostsfile") ?? "", (file) =>
    path.isAbsolute(file),
  );
  const algorithms = verdict.keyType === null ? undefined : HOST_KEY_ALGORITHMS[verdict.keyType];

  const probe = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "t3-host-key-" }), "kh");
      const failure = yield* runSshCommand(target, {
        batchMode: "yes",
        preHostArgs: [
          ...noAuth,
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `UserKnownHostsFile=${file}`,
          "-o",
          "GlobalKnownHostsFile=/dev/null",
          ...(algorithms === undefined ? [] : ["-o", `HostKeyAlgorithms=${algorithms}`]),
        ],
        remoteCommandArgs: ["true"],
        timeoutMs: PROBE_TIMEOUT_MS,
      }).pipe(
        Effect.as(undefined),
        Effect.catch((cause) => Effect.succeed(cause)),
      );
      const lines = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      if (lines.trim() === "") {
        return yield* sshError(failure?.message ?? `SSH to ${host} did not present a host key.`);
      }
      const keys = parsePresented(yield* keygen(["-l", "-E", "sha256", "-f", file]));
      const first = keys[0];
      if (first === undefined || keys.some((key) => key.fingerprint !== first.fingerprint)) {
        return yield* sshError(`SSH to ${host} did not present one clear host key.`);
      }
      return { ...first, lines };
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause._tag === "ClusterError" ? cause : sshError(cause.message, cause),
    ),
  );
  if (verdict._tag === "changed" && verdict.fingerprint !== probe.fingerprint) {
    return yield* sshError(
      `${host} presented ${verdict.fingerprint} to ssh but ${probe.fingerprint} on a second look. Nothing was trusted.`,
    );
  }

  const changed = verdict._tag === "changed";
  const approved =
    trust !== undefined && trust.fingerprint === probe.fingerprint && (trust.replace || !changed);
  if (!approved) {
    // Shown to the user only; ssh made the decision.
    const knownFingerprints = changed
      ? yield* Effect.forEach(knownHostsFiles, (file) =>
          fs.exists(file).pipe(
            Effect.flatMap((exists) =>
              exists ? keygen(["-l", "-E", "sha256", "-F", host, "-f", file]) : Effect.succeed(""),
            ),
            Effect.map(parseKnownEntries),
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
          ),
        ).pipe(Effect.map((lists) => [...new Set(lists.flat())]))
      : [];
    const hostKey: ClusterHostKey = {
      host,
      keyType: probe.keyType,
      fingerprint: probe.fingerprint,
      knownFingerprints,
    };
    return yield* new ClusterError(
      changed
        ? {
            reason: "host_key_changed",
            message: `The host key for ${host} has changed. Someone may be intercepting the connection, or the machine was reinstalled. It now presents ${probe.keyType} key ${probe.fingerprint}${
              knownFingerprints.length > 0
                ? `; this machine knew ${knownFingerprints.join(", ")}`
                : ""
            }.`,
            hostKey,
          }
        : {
            reason: "host_key_unknown",
            message: `The authenticity of ${host} can't be established. ${probe.keyType} key fingerprint is ${probe.fingerprint}.`,
            hostKey,
          },
    );
  }

  const destination = knownHostsFiles[0];
  if (destination === undefined) {
    return yield* sshError(`SSH has no known_hosts file to record ${host} in.`);
  }
  yield* Effect.gen(function* () {
    if (changed) {
      for (const file of knownHostsFiles) {
        if (!(yield* fs.exists(file))) continue;
        const exitCode = yield* spawner.exitCode(
          ChildProcess.make("ssh-keygen", ["-R", host, "-f", file], { stdin: "ignore" }),
        );
        if (exitCode !== 0) {
          return yield* sshError(`Could not remove the old host key for ${host} from ${file}.`);
        }
      }
    }
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true, mode: 0o700 });
    const existing = yield* fs.readFileString(destination).pipe(Effect.orElseSucceed(() => ""));
    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
    // Appended as ssh wrote it, which already follows the user's HashKnownHosts.
    yield* fs.writeFileString(destination, `${separator}${probe.lines}`, {
      flag: "a",
      mode: 0o600,
    });
  }).pipe(
    Effect.mapError((cause) =>
      cause._tag === "ClusterError"
        ? cause
        : new ClusterError({
            reason: "storage",
            message: `Could not record the host key for ${host} in ${destination}.`,
            cause,
          }),
    ),
  );
});
