// @effect-diagnostics nodeBuiltinImport:off - A fake ssh and real ssh-keygen run against temp known_hosts files.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ClusterHostKey from "./ClusterHostKey.ts";
import { makeKeyPair } from "./ClusterSshKey.ts";

const keyOf = (seed: number) => makeKeyPair(new Uint8Array(32).fill(seed), "").publicKey;
const fingerprintOf = (publicKey: string) =>
  `SHA256:${NodeCrypto.createHash("sha256")
    .update(Buffer.from(publicKey.split(" ")[1]!, "base64"))
    .digest("base64")
    .replace(/=+$/, "")}`;

const PRESENTED = keyOf(1);
const OLD = keyOf(2);
const TARGET = { alias: "box", hostname: "box", username: "me", port: 2222 };

/** A temp HOME and an `ssh` that answers `-G` and presents `presented` to a probe. */
const fixture = (port = 2222) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-host-key-"));
  const home = NodePath.join(dir, "home");
  const knownHosts = NodePath.join(home, ".ssh", "known_hosts");
  const host = port === 22 ? "box" : `[box]:${port}`;
  const present = (key: string) =>
    NodeFS.writeFileSync(NodePath.join(dir, "presented"), `${host} ${key}\n`);
  present(PRESENTED);
  const q = (value: string) => `'${value}'`;
  const fakeSsh = NodePath.join(dir, "ssh");
  NodeFS.writeFileSync(
    fakeSsh,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${q(NodePath.join(dir, "calls"))}`,
      "f=",
      'for a in "$@"; do case "$a" in',
      `  -G) printf 'hostname box\\nport ${port}\\nuserknownhostsfile %s %s\\n' ${q(knownHosts)} ${q(`${knownHosts}2`)}; exit 0 ;;`,
      '  UserKnownHostsFile=*) f="${a#UserKnownHostsFile=}" ;;',
      "esac; done",
      '[ -n "$f" ] || exit 2',
      `cat ${q(NodePath.join(dir, "presented"))} >> "$f"`,
      "echo 'me@box: Permission denied (publickey).' >&2",
      "exit 255",
    ].join("\n"),
    { mode: 0o755 },
  );
  const layer = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) =>
        real.spawn(
          ChildProcess.isStandardCommand(command) && command.command === "ssh"
            ? ChildProcess.make(fakeSsh, command.args, command.options)
            : command,
        ),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  const verify = (trust?: ClusterHostKey.TrustHostKey) =>
    ClusterHostKey.verifyHostKey(TARGET, trust).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, layer)),
    );
  const calls = () => NodeFS.readFileSync(NodePath.join(dir, "calls"), "utf8").trim().split("\n");
  const read = () => NodeFS.readFileSync(knownHosts, "utf8");
  const write = (contents: string) => {
    NodeFS.mkdirSync(NodePath.dirname(knownHosts), { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(knownHosts, contents, { mode: 0o600 });
  };
  return { dir, home, knownHosts, host, present, verify, calls, read, write };
};

it.live("refuses an unknown host, then trusts it once approved in private files", () =>
  Effect.gen(function* () {
    const f = fixture();
    const unknown = yield* f.verify().pipe(Effect.flip);
    assert.equal(unknown.reason, "host_key_unknown");
    assert.deepEqual(unknown.hostKey, {
      host: "[box]:2222",
      keyType: "ED25519",
      fingerprint: fingerprintOf(PRESENTED),
      knownFingerprints: [],
    });
    assert.isFalse(NodeFS.existsSync(f.knownHosts));
    const probe = f.calls().find((call) => call.includes("UserKnownHostsFile="))!;
    for (const option of [
      "PreferredAuthentications=none",
      "BatchMode=yes",
      "StrictHostKeyChecking=accept-new",
      "GlobalKnownHostsFile=/dev/null",
    ]) {
      assert.include(probe, option);
    }
    // The probe's known_hosts lived only for the probe.
    assert.isFalse(NodeFS.existsSync(/UserKnownHostsFile=(\S+)/.exec(probe)![1]!));

    // The host presents another key by the time the user approves: nothing is written.
    f.present(OLD);
    const moved = yield* f
      .verify({ fingerprint: fingerprintOf(PRESENTED), replace: false })
      .pipe(Effect.flip);
    assert.equal(moved.reason, "host_key_unknown");
    assert.equal(moved.hostKey?.fingerprint, fingerprintOf(OLD));
    assert.isFalse(NodeFS.existsSync(f.knownHosts));

    f.present(PRESENTED);
    yield* f.verify({ fingerprint: fingerprintOf(PRESENTED), replace: false });
    assert.equal(f.read(), `[box]:2222 ${PRESENTED}\n`);
    assert.equal(NodeFS.statSync(NodePath.dirname(f.knownHosts)).mode & 0o777, 0o700);
    assert.equal(NodeFS.statSync(f.knownHosts).mode & 0o777, 0o600);
    // Known from now on.
    yield* f.verify();
  }),
);

it.live("appends after the user's own lines, never over them", () =>
  Effect.gen(function* () {
    const f = fixture(22);
    f.write(`other ${OLD}`);
    yield* f.verify({ fingerprint: fingerprintOf(PRESENTED), replace: false });
    assert.equal(f.read(), `other ${OLD}\nbox ${PRESENTED}\n`);
  }),
);

it.live("matches hashed entries", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.write(`other ${OLD}\n[box]:2222 ${PRESENTED}\n`);
    assert.equal(NodeChildProcess.spawnSync("ssh-keygen", ["-H", "-f", f.knownHosts]).status, 0);
    assert.notInclude(f.read(), "box");
    yield* f.verify();
  }),
);

it.live("reports a changed key and replaces it only when told to", () =>
  Effect.gen(function* () {
    const f = fixture(22);
    const before = `other ${PRESENTED}\nbox ${OLD}\n`;
    f.write(before);
    const changed = yield* f.verify().pipe(Effect.flip);
    assert.equal(changed.reason, "host_key_changed");
    assert.deepEqual(changed.hostKey, {
      host: "box",
      keyType: "ED25519",
      fingerprint: fingerprintOf(PRESENTED),
      knownFingerprints: [fingerprintOf(OLD)],
    });
    // Approving a new host is not approving a replacement.
    const unreplaced = yield* f
      .verify({ fingerprint: fingerprintOf(PRESENTED), replace: false })
      .pipe(Effect.flip);
    assert.equal(unreplaced.reason, "host_key_changed");
    assert.equal(f.read(), before);

    yield* f.verify({ fingerprint: fingerprintOf(PRESENTED), replace: true });
    assert.equal(f.read(), `other ${PRESENTED}\nbox ${PRESENTED}\n`);
    assert.equal(NodeFS.readFileSync(`${f.knownHosts}.old`, "utf8"), before);
    yield* f.verify();
  }),
);
