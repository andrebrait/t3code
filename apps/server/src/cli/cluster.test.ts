import { ClusterError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { hostKeyHint } from "./cluster.ts";

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
