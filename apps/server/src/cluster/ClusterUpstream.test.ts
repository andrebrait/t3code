import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { SshPasswordPrompt } from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ClusterUpstream from "./ClusterUpstream.ts";

const dependencies = Layer.provideMerge(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    NodeHttpClient.layerUndici,
    NetService.layer,
    SshPasswordPrompt.disabledLayer,
  ),
);

const layer = ClusterUpstream.layer.pipe(
  Layer.provide(SshTunnel.SshEnvironmentManager.layer()),
  dependencies,
);

it.effect("refuses member addresses the network could read or spoof", () =>
  Effect.gen(function* () {
    const upstream = yield* ClusterUpstream.ClusterUpstream;
    const targets: ReadonlyArray<ClusterUpstream.UpstreamTarget> = [
      { transport: "https", url: "http://10.0.0.5:3773", certSha256: "0".repeat(64) },
      { transport: "https", url: "http://10.0.0.5:3773", certSha256: null },
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
    // Without a pin, the standard CA-validated pool: a tunnel or Tailscale Serve certificate.
    const unpinned = yield* upstream.connect({
      transport: "https",
      url: "https://box.tail1234.ts.net",
      certSha256: null,
    });
    assert.equal(unpinned.origin, "https://box.tail1234.ts.net");
    assert.strictEqual(unpinned.httpClient, local.httpClient);
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

it.effect(
  "starts an ssh member's server once, until the link asks again or the tunnel closes",
  () =>
    Effect.gen(function* () {
      const ensured = yield* Ref.make(0);
      const ssh = SshTunnel.SshEnvironmentManager.of({
        ensureEnvironment: (target, options) =>
          Ref.updateAndGet(ensured, (count) => count + 1).pipe(
            Effect.map((count) => ({
              target,
              httpBaseUrl: `http://127.0.0.1:${4000 + count}/`,
              wsBaseUrl: `ws://127.0.0.1:${4000 + count}/`,
              pairingToken: options?.issuePairingToken === true ? "K7M2Q9RZ3NWD" : null,
            })),
          ),
        disconnectEnvironment: () => Effect.void,
        closeAllTunnels: Effect.void,
      });
      const upstream = yield* ClusterUpstream.ClusterUpstream.pipe(
        Effect.provide(
          ClusterUpstream.layer.pipe(
            Layer.provide(Layer.succeed(SshTunnel.SshEnvironmentManager, ssh)),
            dependencies,
          ),
        ),
      );
      const target = { transport: "ssh", sshTarget: "me@box" } as const;
      assert.equal(yield* upstream.createJoinCodeOverSsh("me@box"), "K7M2Q9RZ3NWD");
      for (let request = 0; request < 3; request++) {
        assert.equal((yield* upstream.connect(target)).origin, "http://127.0.0.1:4001");
      }
      assert.equal(yield* Ref.get(ensured), 1);
      assert.equal(
        (yield* upstream.connect(target, { refresh: true })).origin,
        "http://127.0.0.1:4002",
      );
      assert.equal((yield* upstream.connect(target)).origin, "http://127.0.0.1:4002");
      yield* upstream.closeSsh("me@box");
      assert.equal((yield* upstream.connect(target)).origin, "http://127.0.0.1:4003");
      assert.equal(yield* Ref.get(ensured), 3);
    }),
);

it.effect("turns a throw while launching the remote runner into a ClusterError", () =>
  Effect.gen(function* () {
    const ssh = SshTunnel.SshEnvironmentManager.of({
      ensureEnvironment: () =>
        Effect.sync(() => SshTunnel.buildRemoteT3RunnerScript()).pipe(
          Effect.flatMap(() => Effect.never),
        ),
      disconnectEnvironment: () => Effect.void,
      closeAllTunnels: Effect.void,
    });
    const upstream = yield* ClusterUpstream.ClusterUpstream.pipe(
      Effect.provide(
        ClusterUpstream.layer.pipe(
          Layer.provide(Layer.succeed(SshTunnel.SshEnvironmentManager, ssh)),
          dependencies,
        ),
      ),
    );
    const error = yield* upstream
      .connect({ transport: "ssh", sshTarget: "me@box" })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ClusterError");
    assert.match(error.message, /runner/);
  }),
);
