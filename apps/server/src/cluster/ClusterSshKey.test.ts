// @effect-diagnostics nodeBuiltinImport:off - Runs the remote scripts in a local sh against a temp HOME.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as ClusterSshKey from "./ClusterSshKey.ts";

const tempHome = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cluster-key-"));

const runRemote = (home: string, script: string, stdin: string) =>
  NodeChildProcess.spawnSync("sh", ["-c", script], {
    input: stdin,
    env: { PATH: process.env.PATH, HOME: home },
    encoding: "utf8",
  });

const authorizedKeys = (home: string) =>
  NodeFS.readFileSync(NodePath.join(home, ".ssh", "authorized_keys"), "utf8");

const LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample t3code-cluster:env-main";

describe("authorized_keys scripts", () => {
  it("installs the cluster key once, in a private ~/.ssh, keeping the user's keys", () => {
    const home = tempHome();
    assert.equal(runRemote(home, ClusterSshKey.AUTHORIZE_KEY_SCRIPT, `${LINE}\n`).status, 0);
    assert.equal(runRemote(home, ClusterSshKey.AUTHORIZE_KEY_SCRIPT, `${LINE}\n`).status, 0);
    assert.equal(authorizedKeys(home), `${LINE}\n`);
    assert.equal(NodeFS.statSync(NodePath.join(home, ".ssh")).mode & 0o777, 0o700);
    assert.equal(
      NodeFS.statSync(NodePath.join(home, ".ssh", "authorized_keys")).mode & 0o777,
      0o600,
    );

    // A rotated key replaces the old tagged line; a file without a final newline stays intact.
    NodeFS.writeFileSync(
      NodePath.join(home, ".ssh", "authorized_keys"),
      `ssh-rsa AAAAuser me@laptop\n${LINE}\nssh-ed25519 AAAAother t3code-cluster:env-main-2`,
    );
    const rotated = "ssh-ed25519 AAAAnew t3code-cluster:env-main";
    assert.equal(runRemote(home, ClusterSshKey.AUTHORIZE_KEY_SCRIPT, rotated).status, 0);
    assert.equal(
      authorizedKeys(home),
      `ssh-rsa AAAAuser me@laptop\nssh-ed25519 AAAAother t3code-cluster:env-main-2\n${rotated}\n`,
    );
  });

  it("treats the key line as data, never as shell", () => {
    const home = tempHome();
    const hostile = `ssh-ed25519 $(touch pwned)';touch pwned2;' \`touch pwned3\` t3code-cluster:x`;
    assert.equal(runRemote(home, ClusterSshKey.AUTHORIZE_KEY_SCRIPT, hostile).status, 0);
    assert.equal(authorizedKeys(home), `${hostile}\n`);
    assert.deepEqual(
      NodeFS.readdirSync(home).filter((name) => name.startsWith("pwned")),
      [],
    );
    assert.deepEqual(
      NodeFS.readdirSync(process.cwd()).filter((name) => name.startsWith("pwned")),
      [],
    );
  });

  it("revokes exactly the tagged line", () => {
    const home = tempHome();
    NodeFS.mkdirSync(NodePath.join(home, ".ssh"));
    NodeFS.writeFileSync(
      NodePath.join(home, ".ssh", "authorized_keys"),
      [
        "ssh-rsa AAAAuser me@laptop",
        LINE,
        "ssh-ed25519 AAAAother t3code-cluster:env-main-2",
        'command="t3code-cluster:env-main" ssh-ed25519 AAAAforced user',
        "",
      ].join("\n"),
    );
    assert.equal(
      runRemote(home, ClusterSshKey.REVOKE_KEY_SCRIPT, "t3code-cluster:env-main\n").status,
      0,
    );
    assert.equal(
      authorizedKeys(home),
      [
        "ssh-rsa AAAAuser me@laptop",
        "ssh-ed25519 AAAAother t3code-cluster:env-main-2",
        'command="t3code-cluster:env-main" ssh-ed25519 AAAAforced user',
        "",
      ].join("\n"),
    );
    // Nothing to revoke is not an error.
    assert.equal(
      runRemote(tempHome(), ClusterSshKey.REVOKE_KEY_SCRIPT, "t3code-cluster:x").status,
      0,
    );
  });
});

it("generates an ed25519 key pair OpenSSH reads", () => {
  const dir = tempHome();
  const pair = ClusterSshKey.makeKeyPair(new Uint8Array(32).fill(7), "t3code-cluster:env-main");
  const file = NodePath.join(dir, "key");
  NodeFS.writeFileSync(file, pair.privateKey, { mode: 0o600 });
  const derived = NodeChildProcess.spawnSync("ssh-keygen", ["-y", "-f", file], {
    encoding: "utf8",
  });
  assert.equal(derived.status, 0, derived.stderr);
  assert.equal(derived.stdout.trim().split(" ").slice(0, 2).join(" "), pair.publicKey);
  assert.match(pair.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI/);
});

it("signs in once with only what the user chose", () => {
  // Every run refuses a host key known_hosts lacks; an identity file's runs do so on their own.
  assert.deepEqual(ClusterSshKey.loginOptions({ _tag: "config" }), {
    batchMode: "yes",
    preHostArgs: ["-o", "StrictHostKeyChecking=yes"],
  });
  assert.deepEqual(
    ClusterSshKey.loginOptions({ _tag: "password", password: Redacted.make("pw") }),
    {
      authSecret: "pw",
      batchMode: "no",
      interactiveAuth: true,
      preHostArgs: [
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "PreferredAuthentications=keyboard-interactive,password",
        "-o",
        "NumberOfPasswordPrompts=1",
      ],
    },
  );
  assert.deepEqual(ClusterSshKey.loginOptions({ _tag: "keyFile", path: "/k/id" }), {
    identityFile: "/k/id",
    batchMode: "yes",
    preHostArgs: ["-o", "PreferredAuthentications=publickey"],
  });
  assert.deepEqual(
    ClusterSshKey.loginOptions({
      _tag: "keyFile",
      path: "/k/id",
      passphrase: Redacted.make("secret"),
    }),
    {
      identityFile: "/k/id",
      authSecret: "secret",
      batchMode: "no",
      interactiveAuth: true,
      preHostArgs: ["-o", "PreferredAuthentications=publickey"],
    },
  );
});

it.effect("lists the private keys in ~/.ssh by their headers, never their contents", () =>
  Effect.gen(function* () {
    const dir = tempHome();
    const write = (name: string, contents: string) =>
      NodeFS.writeFileSync(NodePath.join(dir, name), contents);
    const plain = ClusterSshKey.makeKeyPair(new Uint8Array(32).fill(1), "me").privateKey;
    write("id_ed25519", plain);
    write("id_ed25519.pub", "ssh-ed25519 AAAA me");
    // An OpenSSH key whose cipher is aes256-ctr.
    write(
      "id_locked",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA==\n-----END OPENSSH PRIVATE KEY-----\n",
    );
    write("legacy.pem", "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: x\n");
    write("pkcs8", "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF\n");
    write("odd_with_pub", "not a header");
    write("odd_with_pub.pub", "ssh-ed25519 AAAA");
    write("known_hosts", "box ssh-ed25519 AAAA");
    write("known_hosts.old", "box ssh-ed25519 AAAA");
    write("config", "Host box");
    write("authorized_keys", "ssh-ed25519 AAAA");
    write("notes.txt", "hello");
    NodeFS.mkdirSync(NodePath.join(dir, "sockets"));
    const keys = yield* ClusterSshKey.listSshKeyFiles(dir);
    assert.deepEqual(keys, [
      { path: NodePath.join(dir, "id_ed25519"), name: "id_ed25519", encrypted: false },
      { path: NodePath.join(dir, "id_locked"), name: "id_locked", encrypted: true },
      { path: NodePath.join(dir, "legacy.pem"), name: "legacy.pem", encrypted: true },
      { path: NodePath.join(dir, "odd_with_pub"), name: "odd_with_pub", encrypted: false },
      { path: NodePath.join(dir, "pkcs8"), name: "pkcs8", encrypted: true },
    ]);
    assert.deepEqual(yield* ClusterSshKey.listSshKeyFiles(NodePath.join(dir, "missing")), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
