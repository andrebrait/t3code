import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { SshPasswordPrompt } from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ClusterUpstream from "./ClusterUpstream.ts";

const layer = ClusterUpstream.layer.pipe(
  Layer.provide(SshTunnel.SshEnvironmentManager.layer()),
  Layer.provideMerge(
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      NodeHttpClient.layerUndici,
      NetService.layer,
      SshPasswordPrompt.disabledLayer,
    ),
  ),
);

it.effect("refuses member addresses the network could read or spoof", () =>
  Effect.gen(function* () {
    const upstream = yield* ClusterUpstream.ClusterUpstream;
    const targets: ReadonlyArray<ClusterUpstream.UpstreamTarget> = [
      { transport: "https", url: "https://10.0.0.5:3773", certSha256: null },
      { transport: "https", url: "http://10.0.0.5:3773", certSha256: "0".repeat(64) },
      { transport: "https", url: "https://10.0.0.5:3773", certSha256: "not-a-pin" },
      { transport: "ssh", sshTarget: "not a target" },
    ];
    for (const target of targets) {
      const error = yield* upstream.connect(target).pipe(Effect.flip);
      assert.equal(error.reason, "invalid_target");
    }
    const local = yield* upstream.connect({
      transport: "https",
      url: "http://127.0.0.1:3773/",
      certSha256: null,
    });
    assert.equal(local.origin, "http://127.0.0.1:3773");
    const lower = yield* upstream.connect({
      transport: "https",
      url: "https://10.0.0.5:3773",
      certSha256: "ab".repeat(32),
    });
    const upper = yield* upstream.connect({
      transport: "https",
      url: "https://10.0.0.5:3773",
      certSha256: Array.from({ length: 32 }, () => "AB").join(":"),
    });
    assert.strictEqual(upper.httpClient, lower.httpClient);
  }).pipe(Effect.provide(layer)),
);
