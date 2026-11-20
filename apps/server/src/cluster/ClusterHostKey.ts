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

/** `ssh-keygen -l` lines: `256 SHA256:… host (ED25519)`, or `host ED25519 SHA256:…` with `-F`. */
const parseFingerprints = (stdout: string) =>
  stdout.split("\n").flatMap((line) => {
    const fingerprint = /\bSHA256:[A-Za-z0-9+/]+/.exec(line)?.[0];
    if (fingerprint === undefined || line.startsWith("#")) return [];
    const keyType = /\(([^)]+)\)\s*$/.exec(line)?.[1] ?? line.trim().split(/\s+/)[1] ?? "";
    return [{ fingerprint, keyType }];
  });

const sshError = (message: string, cause?: unknown) =>
  new ClusterError({ reason: "ssh", message, ...(cause === undefined ? {} : { cause }) });

/**
 * Checks the host key `target` presents against this machine's known_hosts the way ssh would,
 * and, once the user approved that exact key, records it there as ssh does.
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

  // ssh -G resolves the same config, aliases and ports the real runs use.
  const config = parseSshConfigOutput(
    (yield* runSshCommand(target, { preHostArgs: ["-G"] }).pipe(
      Effect.mapError((cause) => sshError(cause.message, cause)),
    )).stdout,
  );
  const alias = config.get("hostkeyalias");
  const port = Number(config.get("port") ?? 22);
  const hostname = config.get("hostname") ?? target.hostname;
  const host = alias ?? (port === 22 ? hostname : `[${hostname}]:${port}`);
  const knownHostsFiles = (config.get("userknownhostsfile") ?? "")
    .split(" ")
    .filter((file) => path.isAbsolute(file));

  const probe = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "t3-host-key-" }), "kh");
      const failure = yield* runSshCommand(target, {
        batchMode: "yes",
        preHostArgs: [
          "-o",
          "PreferredAuthentications=none",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `UserKnownHostsFile=${file}`,
          "-o",
          "GlobalKnownHostsFile=/dev/null",
          // A shared connection would skip the key exchange this reads.
          "-o",
          "ControlPath=none",
        ],
        remoteCommandArgs: ["true"],
        timeoutMs: PROBE_TIMEOUT_MS,
      }).pipe(
        Effect.as(undefined),
        Effect.catch((cause) => Effect.succeed(cause)),
      );
      const lines = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      const keys = parseFingerprints(yield* keygen(["-l", "-E", "sha256", "-f", file]));
      const first = keys[0];
      if (first === undefined) {
        return yield* sshError(
          failure?.message ?? `SSH to ${host} did not present a host key.`,
          failure,
        );
      }
      if (keys.some((key) => key.fingerprint !== first.fingerprint)) {
        return yield* sshError(`SSH to ${host} presented more than one host key.`);
      }
      return { ...first, lines };
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause._tag === "ClusterError" ? cause : sshError(cause.message, cause),
    ),
  );

  const known = yield* Effect.forEach(knownHostsFiles, (file) =>
    fs.exists(file).pipe(
      Effect.flatMap((exists) =>
        exists ? keygen(["-l", "-E", "sha256", "-F", host, "-f", file]) : Effect.succeed(""),
      ),
      Effect.map((stdout) => ({
        file,
        fingerprints: parseFingerprints(stdout).map((key) => key.fingerprint),
      })),
    ),
  ).pipe(Effect.mapError((cause) => sshError(cause.message, cause)));
  const knownFingerprints = [...new Set(known.flatMap((entry) => entry.fingerprints))];
  if (knownFingerprints.includes(probe.fingerprint)) return;

  const changed = knownFingerprints.length > 0;
  const approved =
    trust !== undefined && trust.fingerprint === probe.fingerprint && (trust.replace || !changed);
  if (!approved) {
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
            message: `The host key for ${host} has changed. Someone may be intercepting the connection, or the machine was reinstalled. It now presents ${probe.keyType} key ${probe.fingerprint}; this machine knew ${knownFingerprints.join(", ")}.`,
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
    for (const entry of known) {
      if (entry.fingerprints.length === 0) continue;
      const exitCode = yield* spawner.exitCode(
        ChildProcess.make("ssh-keygen", ["-R", host, "-f", entry.file], { stdin: "ignore" }),
      );
      if (exitCode !== 0) {
        return yield* sshError(`Could not remove the old host key for ${host} from ${entry.file}.`);
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
