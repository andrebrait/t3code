// @effect-diagnostics nodeBuiltinImport:off - A fake ssh and real ssh-keygen run against temp known_hosts files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
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
const ECDSA =
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBG6JK/Js8VRbKUzE2uzHv90djRPOXdMvJ00yXBzRJMeeOqb2M7HKhTBbHHqcT3CQFBRsTTAFTDgzzpiF8W92yP4=";
const TARGET = { alias: "box", hostname: "box", username: "me", port: 2222 };

// What OpenSSH prints to a BatchMode run with StrictHostKeyChecking=yes.
const DENIED = "me@box: Permission denied (publickey,password).\r\n";
const UNKNOWN =
  "No ED25519 host key is known for [box]:2222 and you have requested strict checking.\r\nHost key verification failed.\r\n";
const changedBanner = (fingerprint: string) =>
  [
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
    "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
    "IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!",
    "Someone could be eavesdropping on you right now (man-in-the-middle attack)!",
    "It is also possible that a host key has just been changed.",
    "The fingerprint for the ED25519 key sent by the remote host is",
    `${fingerprint}.`,
    "Please contact your system administrator.",
    "Host key for box has changed and you have requested strict checking.",
    "Host key verification failed.",
    "",
  ].join("\r\n");
const REVOKED = [
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
  "@       WARNING: REVOKED HOST KEY DETECTED!               @",
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
  "The ED25519 host key for box is marked as revoked.",
  "Host key verification failed.",
  "",
].join("\r\n");

describe("classifyHostKeyCheck", () => {
  it("lets ssh's own verdict decide", () => {
    const classify = ClusterHostKey.classifyHostKeyCheck;
    assert.deepEqual(classify(255, DENIED), { _tag: "known" });
    assert.deepEqual(
      classify(
        255,
        "Received disconnect from 10.0.0.2 port 22:2: No more authentication methods available\r\n",
      ),
      { _tag: "known" },
    );
    assert.deepEqual(classify(0, ""), { _tag: "known" });
    assert.deepEqual(classify(255, UNKNOWN), { _tag: "unknown", keyType: "ED25519" });
    assert.deepEqual(classify(255, "Host key verification failed.\r\n"), {
      _tag: "unknown",
      keyType: null,
    });
    assert.deepEqual(classify(255, changedBanner("SHA256:abc+/9")), {
      _tag: "changed",
      keyType: "ED25519",
      fingerprint: "SHA256:abc+/9",
    });
    assert.deepEqual(classify(255, REVOKED), { _tag: "revoked" });
    assert.deepEqual(
      classify(255, "ssh: Could not resolve hostname box: nodename nor servname provided\r\n"),
      {
        _tag: "unrecognized",
      },
    );
    assert.deepEqual(classify(null, ""), { _tag: "unrecognized" });
  });
});

it("pins a probe to every host key type ssh may name", () => {
  assert.equal(ClusterHostKey.HOST_KEY_ALGORITHMS.DSA, "ssh-dss");
  assert.equal(
    ClusterHostKey.HOST_KEY_ALGORITHMS["MLDSA44-ED25519"],
    "ssh-mldsa44-ed25519@openssh.com",
  );
});

it("splits ssh -G's known_hosts list, keeping paths that contain spaces", () => {
  assert.deepEqual(
    ClusterHostKey.parseKnownHostsFiles(
      "/Users/John Doe/.ssh/known_hosts /Users/John Doe/.ssh/known_hosts2",
      (file) => file.startsWith("/"),
    ),
    ["/Users/John Doe/.ssh/known_hosts", "/Users/John Doe/.ssh/known_hosts2"],
  );
  assert.deepEqual(
    ClusterHostKey.parseKnownHostsFiles("", () => true),
    [],
  );
});

/**
 * A temp HOME (with a space in it) and an `ssh` that answers `-G`, reports `check` to the
 * strict check, and presents `presented` to a probe into its own known_hosts.
 */
const fixture = (port = 2222) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-host-key-"));
  const home = NodePath.join(dir, "home dir");
  const knownHosts = NodePath.join(home, ".ssh", "known_hosts");
  const host = port === 22 ? "box" : `[box]:${port}`;
  const file = (name: string) => NodePath.join(dir, name);
  const present = (key: string) =>
    NodeFS.writeFileSync(file("presented"), key === "" ? "" : `${host} ${key}\n`);
  const check = (stderr: string) => NodeFS.writeFileSync(file("check"), stderr);
  present(PRESENTED);
  check(UNKNOWN);
  const q = (value: string) => `'${value}'`;
  const fakeSsh = file("ssh");
  NodeFS.writeFileSync(
    fakeSsh,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${q(file("calls"))}`,
      "f=",
      'for a in "$@"; do case "$a" in',
      `  -G) printf 'hostname box\\nport ${port}\\nuserknownhostsfile %s %s\\n' ${q(knownHosts)} ${q(`${knownHosts}2`)}; exit 0 ;;`,
      '  UserKnownHostsFile=*) f="${a#UserKnownHostsFile=}"; f="${f#\\\"}"; f="${f%\\\"}" ;;',
      "esac; done",
      `[ -n "$f" ] || { cat ${q(file("check"))} >&2; exit 255; }`,
      `cat ${q(file("presented"))} >> "$f"`,
      `[ -s "$f" ] || { echo 'kex_exchange_identification: Connection closed by remote host' >&2; exit 255; }`,
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
  const calls = () => NodeFS.readFileSync(file("calls"), "utf8").trim().split("\n");
  const read = () => NodeFS.readFileSync(knownHosts, "utf8");
  const write = (contents: string) => {
    NodeFS.mkdirSync(NodePath.dirname(knownHosts), { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(knownHosts, contents, { mode: 0o600 });
  };
  return { knownHosts, present, check, verify, calls, read, write };
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
    const [strict, , probe] = f.calls();
    for (const option of [
      "BatchMode=yes",
      "PreferredAuthentications=none",
      "StrictHostKeyChecking=yes",
      "ControlPath=none",
      // A pre-auth banner and the user's LogLevel stay out of the verdict.
      "LogLevel=ERROR",
    ]) {
      assert.include(strict, option);
    }
    assert.notInclude(strict, "KnownHostsFile");
    for (const option of [
      "StrictHostKeyChecking=accept-new",
      "GlobalKnownHostsFile=/dev/null",
      "HostKeyAlgorithms=ssh-ed25519",
    ]) {
      assert.include(probe, option);
    }
    // ssh splits an unquoted value on spaces. The probe's known_hosts lived only for the probe.
    assert.isFalse(NodeFS.existsSync(/UserKnownHostsFile="([^"]+)"/.exec(probe!)![1]!));

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
  }),
);

it.live("trusts what ssh accepts, such as a known ECDSA key beside an unknown ED25519 one", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.write(`[box]:2222 ${ECDSA}\n`);
    f.check(DENIED);
    yield* f.verify();
    assert.equal(f.read(), `[box]:2222 ${ECDSA}\n`);
    assert.equal(f.calls().length, 1);
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

it.live("reports a changed key and replaces it only when told to", () =>
  Effect.gen(function* () {
    const f = fixture(22);
    // Marker lines are not keys the host was known by.
    const before = `other ${PRESENTED}\nbox ${OLD}\n@revoked box ${ECDSA}\n@cert-authority box ${ECDSA}\n`;
    f.write(before);
    f.check(changedBanner(fingerprintOf(PRESENTED)));
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
    assert.equal(
      f.read(),
      `other ${PRESENTED}\n@revoked box ${ECDSA}\n@cert-authority box ${ECDSA}\nbox ${PRESENTED}\n`,
    );
    assert.equal(NodeFS.readFileSync(`${f.knownHosts}.old`, "utf8"), before);
  }),
);

it.live(
  "fails closed on a changed key the probe cannot confirm, a revoked key, or odd output",
  () =>
    Effect.gen(function* () {
      const f = fixture(22);
      f.check(changedBanner("SHA256:somethingelse"));
      const mismatch = yield* f
        .verify({ fingerprint: "SHA256:somethingelse", replace: true })
        .pipe(Effect.flip);
      assert.equal(mismatch.reason, "ssh");
      assert.isFalse(NodeFS.existsSync(f.knownHosts));

      f.check(REVOKED);
      const revoked = yield* f
        .verify({ fingerprint: fingerprintOf(PRESENTED), replace: true })
        .pipe(Effect.flip);
      assert.equal(revoked.reason, "ssh");
      assert.include(revoked.message, "revoked");
      assert.isUndefined(revoked.hostKey);

      f.check("ssh: connect to host box port 22: Connection refused\r\n");
      const refused = yield* f.verify().pipe(Effect.flip);
      assert.equal(refused.reason, "ssh");
      assert.include(refused.message, "Connection refused");
      assert.isFalse(NodeFS.existsSync(f.knownHosts));
    }),
);

it.live("surfaces ssh's own error when the probe captures no key", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.present("");
    const failed = yield* f.verify().pipe(Effect.flip);
    assert.equal(failed.reason, "ssh");
    assert.include(failed.message, "Connection closed by remote host");
  }),
);
