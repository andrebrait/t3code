import { ClusterError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { addTarget, formatJoinOutput, hostKeyHint } from "./cluster.ts";

const hostKey = {
  host: "[box]:2222",
  keyType: "ED25519",
  fingerprint: "SHA256:abc",
  knownFingerprints: ["SHA256:old"],
};

it("tells a script which flags trust the host key it was shown", () => {
  const unknown = hostKeyHint(
    new ClusterError({ reason: "host_key_unknown", message: "Unknown.", hostKey }),
  );
  assert.equal(unknown.reason, "host_key_unknown");
  assert.include(unknown.message, "Unknown.");
  assert.include(unknown.message, "--trust-host-key SHA256:abc");
  assert.notInclude(unknown.message, "--replace-host-key");
  const changed = hostKeyHint(
    new ClusterError({ reason: "host_key_changed", message: "Changed.", hostKey }),
  );
  assert.include(changed.message, "--trust-host-key SHA256:abc --replace-host-key");
});

it("prints a join URL with its join code and expiry, like t3 pair", () => {
  const joinCode = {
    code: "K7M2Q9RZ3NWD",
    fingerprint: "ab".repeat(32),
    joinUrl: "https://box.example/pair#token=K7M2Q9RZ3NWD",
    expiresAt: DateTime.makeUnsafe("2026-11-20T12:00:00.000Z"),
  };
  const lines = formatJoinOutput(joinCode).split("\n");
  assert.equal(lines[0], "Add https://box.example to a cluster from its main host.");
  assert.includeMembers(lines, [
    "Join URL: https://box.example/pair#token=K7M2Q9RZ3NWD",
    "Join code: K7M2Q9RZ3NWD",
    "Expires: 2026-11-20T12:00:00.000Z",
  ]);
  assert.equal(
    formatJoinOutput({ ...joinCode, joinUrl: null }),
    "Join code: K7M2Q9RZ3NWD\nExpires: 2026-11-20T12:00:00.000Z\nPass --url to print a join URL.",
  );
});

it.effect("builds the join URL from an address and --code, and refuses other targets", () =>
  Effect.gen(function* () {
    assert.equal(yield* addTarget("me@box", Option.none()), "me@box");
    assert.equal(
      yield* addTarget("https://box.example:3773", Option.some(" K7M2Q9RZ3NWD ")),
      "https://box.example:3773/pair#token=K7M2Q9RZ3NWD",
    );
    for (const target of [
      "me@box",
      "ssh://me@box",
      "https://box.example/pair#token=K7M2Q9RZ3NWD",
    ]) {
      const error = yield* addTarget(target, Option.some("K7M2Q9RZ3NWD")).pipe(Effect.flip);
      assert.equal(error.reason, "invalid_target");
    }
  }),
);
