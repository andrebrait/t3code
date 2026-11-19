import {
  ClusterError,
  normalizeCertificateFingerprint,
  parseClusterSshTarget,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import type * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import type * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import type * as HttpClient from "effect/http/HttpClient";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as PinnedTransport from "./pinnedTransport.ts";

export type UpstreamTarget =
  | { readonly transport: "https"; readonly url: string; readonly certSha256: string | null }
  | { readonly transport: "ssh"; readonly sshTarget: string };

export interface Upstream extends PinnedTransport.PinnedAgent {
  /** `http(s)://host:port`, with no trailing slash. */
  readonly origin: string;
}

/** How the main host reaches a member: a pinned TLS pool, or the ssh loopback forward. */
export class ClusterUpstream extends Context.Service<
  ClusterUpstream,
  {
    /** `refresh` re-runs the ssh start and readiness probe; otherwise an ssh origin is reused. */
    readonly connect: (
      target: UpstreamTarget,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<Upstream, ClusterError>;
    /** Starts or reuses T3 on the member over ssh and mints a cluster invite there. */
    readonly inviteOverSsh: (
      sshTarget: string,
    ) => Effect.Effect<{ readonly origin: string; readonly code: string }, ClusterError>;
    /** Closes the ssh tunnel to a removed member; its server keeps running. */
    readonly closeSsh: (sshTarget: string) => Effect.Effect<void>;
  }
>()("t3/cluster/ClusterUpstream") {}

const sshError = (target: string, cause: unknown) =>
  new ClusterError({
    reason: "ssh",
    message: SshAuth.isSshAuthFailure(cause)
      ? `SSH to ${target} needs a key or a running ssh-agent; this server cannot answer password prompts.`
      : cause instanceof Error
        ? cause.message
        : `SSH to ${target} failed.`,
    cause,
  });

const make = Effect.gen(function* () {
  const ssh = yield* SshTunnel.SshEnvironmentManager;
  const sshContext = yield* Effect.context<
    | ChildProcessSpawner.ChildProcessSpawner
    | Digest.Digest
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | NetService.NetService
    | SshAuth.SshPasswordPrompt
  >();
  const scope = yield* Effect.scope;
  // Keyed by normalized pin, so a member re-invited with a new certificate gets a new pool.
  const agents = new Map<string, PinnedTransport.PinnedAgent>();
  const agentFor = (pin: string | null) => {
    const cached = agents.get(pin ?? "");
    if (cached !== undefined) return Effect.succeed(cached);
    return PinnedTransport.makeAgent(pin).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.tap((agent) => Effect.sync(() => agents.set(pin ?? "", agent))),
    );
  };

  const sshOrigins = new Map<string, string>();

  const sshBaseUrl = Effect.fn("ClusterUpstream.sshBaseUrl")(function* (
    sshTarget: string,
    pairingPurpose?: "cluster-member",
  ) {
    const parsed = parseClusterSshTarget(sshTarget);
    if (parsed === undefined) {
      return yield* new ClusterError({
        reason: "invalid_target",
        message: `${sshTarget} is not an ssh target such as me@box.`,
      });
    }
    return yield* ssh
      .ensureEnvironment(
        { alias: parsed.hostname, ...parsed },
        pairingPurpose === undefined ? undefined : { issuePairingToken: true, pairingPurpose },
      )
      .pipe(
        Effect.provideContext(sshContext),
        Effect.mapError((cause) => sshError(sshTarget, cause)),
      );
  });

  const connect: ClusterUpstream["Service"]["connect"] = Effect.fn("ClusterUpstream.connect")(
    function* (target, options) {
      if (target.transport === "ssh") {
        let origin = options?.refresh === true ? undefined : sshOrigins.get(target.sshTarget);
        if (origin === undefined) {
          origin = new URL((yield* sshBaseUrl(target.sshTarget)).httpBaseUrl).origin;
          sshOrigins.set(target.sshTarget, origin);
        }
        return { origin, ...(yield* agentFor(null)) };
      }
      const url = new URL(target.url);
      // Plain http only to this machine, where the network cannot read the token.
      if (url.protocol === "http:" && isLocalLoopbackHost(url.hostname)) {
        return { origin: url.origin, ...(yield* agentFor(null)) };
      }
      const pin =
        target.certSha256 === null ? null : normalizeCertificateFingerprint(target.certSha256);
      if (url.protocol !== "https:" || pin === null || !/^[0-9a-f]{64}$/.test(pin)) {
        return yield* new ClusterError({
          reason: "invalid_target",
          message: `${url.origin} is not an https address with a pinned certificate. Invite the member again.`,
        });
      }
      return { origin: url.origin, ...(yield* agentFor(pin)) };
    },
  );

  const inviteOverSsh: ClusterUpstream["Service"]["inviteOverSsh"] = Effect.fn(
    "ClusterUpstream.inviteOverSsh",
  )(function* (sshTarget) {
    const bootstrap = yield* sshBaseUrl(sshTarget, "cluster-member");
    if (bootstrap.pairingToken === null) {
      return yield* new ClusterError({
        reason: "ssh",
        message: `${sshTarget} started T3 Code but did not mint a cluster invite.`,
      });
    }
    return { origin: new URL(bootstrap.httpBaseUrl).origin, code: bootstrap.pairingToken };
  });

  const closeSsh: ClusterUpstream["Service"]["closeSsh"] = (sshTarget) => {
    sshOrigins.delete(sshTarget);
    const parsed = parseClusterSshTarget(sshTarget);
    if (parsed === undefined) return Effect.void;
    return ssh.disconnectEnvironment({ alias: parsed.hostname, ...parsed }).pipe(
      Effect.provideContext(sshContext),
      Effect.catch((cause) =>
        Effect.logWarning("Could not close a cluster member's ssh tunnel", { cause }),
      ),
      Effect.withSpan("ClusterUpstream.closeSsh"),
    );
  };

  return ClusterUpstream.of({ connect, inviteOverSsh, closeSsh });
});

export const layer = Layer.effect(ClusterUpstream, make);
