// @effect-diagnostics nodeBuiltinImport:off - Reads the test's secrets directory directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  ClusterError,
  type ClusterHostRequest,
  type ClusterLinkEvent,
  type ClusterSshLogin,
  EnvironmentId,
} from "@t3tools/contracts";
import { SshCommandError } from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ClusterService from "./ClusterService.ts";
import * as ClusterSshKey from "./ClusterSshKey.ts";
import {
  awaitStatus,
  type ClusterEnvironment,
  clusterDescriptor,
  FINGERPRINT,
  makeEnvironment,
  serveMember,
} from "./ClusterService.testkit.ts";

const box = clusterDescriptor("environment-box", "Box");
const studioDescriptor = clusterDescriptor("environment-studio", "Studio");
const studio = { environmentId: studioDescriptor.environmentId, label: "Studio" };
const other = { environmentId: EnvironmentId.make("environment-other"), label: "Other" };
const bot = { deviceType: "bot" as const, ipAddress: "192.168.1.10" };
const bearer = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

it.effect("a member keeps only its cluster host and loopback sessions after joining", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* makeEnvironment(box);
      const pair = (ipAddress: string) =>
        member.auth.issuePairingCredential().pipe(
          Effect.flatMap((pairing) =>
            member.auth.exchangeBootstrapCredentialForAccessToken(pairing.credential, undefined, {
              deviceType: "mobile",
              ipAddress,
            }),
          ),
        );
      yield* pair("192.168.1.40");
      yield* pair("127.0.0.1");
      const agent = (ipAddress: string) =>
        member.auth.issueMcpClientSession({
          label: "Agent",
          access: "read-only",
          peerLink: false,
          client: { deviceType: "bot", ipAddress },
        });
      yield* agent("127.0.0.1");
      yield* agent("192.168.1.41");
      const unspent = yield* member.auth.issuePairingCredential();
      yield* member.sql`
        INSERT INTO peer_environment_links (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
        VALUES ('environment-peer', 'peer-link-1', 'Peer', '[]', 'auto', '2026-11-19T00:00:00.000Z', '2026-12-19T00:00:00.000Z')
      `;

      const invite = yield* member.cluster.invite({ url: "https://box.local:3773" });
      expect(invite).toMatchObject({
        fingerprint: FINGERPRINT,
        joinString: `https://box.local:3773#${invite.code}.${FINGERPRINT}`,
      });
      // The main host trusts either the pin or a CA-valid chain, so every address carries the pin.
      for (const url of [
        "https://192.168.1.20:3773",
        "https://[fd00::1]:3773",
        "http://localhost:3773",
        "https://box.lan:3773",
        "https://box.tail1234.ts.net",
      ]) {
        const { code, joinString } = yield* member.cluster.invite({ url });
        expect(joinString).toBe(`${new URL(url).origin}#${code}.${FINGERPRINT}`);
      }
      const joined = yield* member.cluster.acceptJoin({ code: invite.code, host: studio }, bot);
      expect(joined).toMatchObject({ environmentId: box.environmentId, label: "Box" });

      expect(
        (yield* member.auth.listSessions())
          .map((session) => [session.subject, session.client.ipAddress ?? null])
          .toSorted(),
      ).toEqual([
        [EnvironmentAuth.CLUSTER_HOST_SUBJECT, "192.168.1.10"],
        ["mcp-client", "127.0.0.1"],
        ["one-time-token", "127.0.0.1"],
      ]);
      expect(yield* member.auth.listPairingLinks({ includePurposeBound: true })).toEqual([]);
      expect(
        yield* member.auth
          .exchangeBootstrapCredentialForAccessToken(unspent.credential, undefined, bot)
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
      expect(yield* member.auth.issuePairingCredential().pipe(Effect.flip)).toMatchObject({
        reason: "is_member",
      });
      expect(yield* member.sql`SELECT environment_id FROM peer_environment_links`).toEqual([]);
      expect(yield* member.cluster.status).toMatchObject({
        role: "member",
        fingerprint: FINGERPRINT,
        host: { environmentId: studio.environmentId, label: "Studio" },
      });
    }),
  ),
);

it.effect("a member refuses another cluster and itself; a main host refuses to join", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* makeEnvironment(box);
      const first = yield* member.cluster.invite({});
      yield* member.cluster.acceptJoin({ code: first.code, host: studio }, bot);
      expect(
        yield* member.cluster
          .acceptJoin({ code: "K7M2Q9RZ3NWD", host: other }, bot)
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "pairing_rejected" });
      const second = yield* member.cluster.invite({});
      expect(
        yield* member.cluster.acceptJoin({ code: second.code, host: other }, bot).pipe(Effect.flip),
      ).toMatchObject({
        reason: "is_member",
        message:
          "This environment is already a member of the cluster hosted by Studio. Leave it there first.",
      });
      const third = yield* member.cluster.invite({});
      expect(
        yield* member.cluster
          .acceptJoin(
            { code: third.code, host: { environmentId: box.environmentId, label: "Box" } },
            bot,
          )
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "self" });

      const main = yield* makeEnvironment(studioDescriptor);
      const unspent = yield* main.cluster.invite({});
      yield* main.sql`
        INSERT INTO cluster_members (environment_id, label, transport, url, cert_sha256, secret_name, status, joined_at)
        VALUES ('environment-x', 'X', 'https', 'https://x:3773', ${FINGERPRINT}, 'cluster-member-1', 'online', '2026-11-19T00:00:00.000Z')
      `;
      expect(yield* main.cluster.invite({}).pipe(Effect.flip)).toMatchObject({
        reason: "is_main_host",
      });
      expect(
        yield* main.cluster
          .acceptJoin({ code: "K7M2Q9RZ3NWD", host: other }, bot)
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "pairing_rejected" });
      expect(
        yield* main.cluster.acceptJoin({ code: unspent.code, host: other }, bot).pipe(Effect.flip),
      ).toMatchObject({ reason: "is_main_host" });
      expect(
        (yield* main.auth.listSessions()).filter(
          (session) => session.subject === EnvironmentAuth.CLUSTER_HOST_SUBJECT,
        ),
      ).toEqual([]);
    }),
  ),
);

it.effect("rejoining from the same host rotates its token and keeps the join time", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* makeEnvironment(box);
      const first = yield* member.cluster.invite({});
      const joined = yield* member.cluster.acceptJoin({ code: first.code, host: studio }, bot);
      const before = yield* member.cluster.status;
      yield* TestClock.adjust("1 hour");
      const second = yield* member.cluster.invite({});
      const rejoined = yield* member.cluster.acceptJoin({ code: second.code, host: studio }, bot);

      expect(
        yield* member.auth.authenticateHttpRequest(bearer(joined.token)).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
      yield* member.auth.authenticateHttpRequest(bearer(rejoined.token));
      expect(
        (yield* member.auth.listSessions()).filter(
          (session) => session.subject === EnvironmentAuth.CLUSTER_HOST_SUBJECT,
        ),
      ).toHaveLength(1);
      expect((yield* member.cluster.status).host?.joinedAt).toEqual(before.host?.joinedAt);
    }),
  ),
);

it.effect("a member that stopped between joining and revoking finishes on start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* makeEnvironment(box);
      const pairing = yield* member.auth.issuePairingCredential();
      yield* member.auth.exchangeBootstrapCredentialForAccessToken(pairing.credential, undefined, {
        deviceType: "mobile",
        ipAddress: "192.168.1.40",
      });
      yield* member.sql`
        INSERT INTO cluster_membership (singleton, host_environment_id, host_label, joined_at, host_session_id)
        VALUES (1, 'environment-studio', 'Studio', '2026-11-19T00:00:00.000Z', 'session-host')
      `;

      const context = yield* Layer.build(
        ClusterService.layer.pipe(Layer.provide(Layer.succeedContext(member.context))),
      );
      // Building the service is not starting the server: `t3 cluster` commands build it too.
      expect(yield* member.auth.listSessions()).toHaveLength(1);
      yield* Context.get(context, ClusterService.ClusterService).start(
        ClusterService.refuseHostRequests,
      );
      expect(yield* member.auth.listSessions()).toEqual([]);
    }),
  ),
);

it.effect("two hosts racing to join one member: one wins", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* makeEnvironment(box);
      const first = yield* member.cluster.invite({});
      const second = yield* member.cluster.invite({});
      const results = yield* Effect.all(
        [
          member.cluster.acceptJoin({ code: first.code, host: studio }, bot),
          member.cluster.acceptJoin({ code: second.code, host: other }, bot),
        ],
        { concurrency: 2, mode: "result" },
      );
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      // The winner revokes every outstanding invite, so the loser's code is gone.
      expect(results.filter(Result.isFailure).map((result) => result.failure.reason)).toEqual([
        "pairing_rejected",
      ]);
      expect(
        (yield* member.auth.listSessions()).filter(
          (session) => session.subject === EnvironmentAuth.CLUSTER_HOST_SUBJECT,
        ),
      ).toHaveLength(1);
    }),
  ),
);

it.effect("a member leaves without its main host and is standalone again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* makeEnvironment(box);
      const invite = yield* member.cluster.invite({});
      const joined = yield* member.cluster.acceptJoin({ code: invite.code, host: studio }, bot);

      expect(yield* member.cluster.leave).toEqual({ left: true });
      expect(
        yield* member.auth.authenticateHttpRequest(bearer(joined.token)).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
      expect(yield* member.cluster.status).toMatchObject({ role: "standalone", host: null });
      yield* member.auth.issuePairingCredential();
      expect(yield* member.cluster.leave).toEqual({ left: false });
    }),
  ),
);

const memberCount = (main: { cluster: { members: Stream.Stream<ReadonlyArray<unknown>> } }) =>
  main.cluster.members.pipe(Stream.runHead, Effect.map(Option.map((members) => members.length)));

it.effect("adds a member with its join string, and neither side nests", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box);
      const main = yield* makeEnvironment(studioDescriptor);
      const joinString = (yield* member.cluster.invite({ url: member.url })).joinString ?? "";
      const added = yield* main.cluster.addMember({ target: joinString });
      // Online once its control link is up (Task 8).
      expect(added).toMatchObject({
        environmentId: box.environmentId,
        label: "Box",
        transport: "https",
        address: member.url,
        status: "offline",
      });
      expect(yield* member.cluster.status).toMatchObject({
        role: "member",
        host: { environmentId: studio.environmentId, label: "Studio" },
      });
      expect(yield* main.cluster.status).toMatchObject({ role: "main", host: null });

      expect(
        yield* member.cluster.addMember({ target: joinString }).pipe(Effect.flip),
      ).toMatchObject({ reason: "is_member" });
      expect(yield* main.cluster.invite({}).pipe(Effect.flip)).toMatchObject({
        reason: "is_main_host",
      });

      const renamed = yield* main.cluster.renameMember({
        memberId: box.environmentId,
        label: "Build box",
      });
      expect(renamed.label).toBe("Build box");
      expect(yield* main.cluster.members.pipe(Stream.runHead)).toEqual(Option.some([renamed]));

      yield* main.settings.updateSettings({ clusterEnabled: false });
      expect(yield* main.cluster.members.pipe(Stream.runHead)).toEqual(Option.some([]));
      // `t3 cluster list` still shows the ids `t3 cluster remove` takes.
      expect(yield* main.cluster.storedMembers).toEqual([renamed]);
      expect(yield* main.cluster.addMember({ target: joinString }).pipe(Effect.flip)).toMatchObject(
        { reason: "disabled" },
      );
    }),
  ),
);

it.effect("removal tells a reachable member, and forgets one that already left", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box);
      const main = yield* makeEnvironment(studioDescriptor);
      const add = member.cluster
        .invite({ url: member.url })
        .pipe(
          Effect.flatMap((invite) => main.cluster.addMember({ target: invite.joinString ?? "" })),
        );
      yield* add;
      yield* member.cluster.leave;
      expect(yield* main.cluster.removeMember(box.environmentId)).toEqual({
        removed: true,
        memberNotified: false,
        keyRevoked: null,
      });
      expect(yield* main.cluster.status).toMatchObject({ role: "standalone" });

      yield* add;
      expect(yield* main.cluster.removeMember(box.environmentId)).toEqual({
        removed: true,
        memberNotified: true,
        keyRevoked: null,
      });
      expect(yield* member.cluster.status).toMatchObject({ role: "standalone", host: null });
      expect(yield* memberCount(main)).toEqual(Option.some(0));

      // Turning the cluster off still lets a removal reach the member.
      yield* add;
      yield* main.settings.updateSettings({ clusterEnabled: false });
      expect(yield* main.cluster.removeMember(box.environmentId)).toEqual({
        removed: true,
        memberNotified: true,
        keyRevoked: null,
      });
      expect(yield* member.cluster.status).toMatchObject({ role: "standalone", host: null });

      // An add that fails after the member joined tells it to leave, so remote pairing works there.
      yield* main.settings.updateSettings({ clusterEnabled: true });
      yield* main.sql`CREATE TRIGGER refuse_members BEFORE INSERT ON cluster_members
        BEGIN SELECT RAISE(ABORT, 'refused'); END`;
      expect(yield* add.pipe(Effect.flip)).toMatchObject({ reason: "storage" });
      expect(yield* member.cluster.status).toMatchObject({ role: "standalone", host: null });
    }),
  ),
);

it.effect(
  "re-adding a member at a new address moves the proxy there and retires the old token",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const member = yield* serveMember(box);
        const main = yield* makeEnvironment(studioDescriptor);
        const addAt = (url: string) =>
          member.cluster
            .invite({ url })
            .pipe(
              Effect.flatMap((invite) =>
                main.cluster.addMember({ target: invite.joinString ?? "" }),
              ),
            );
        yield* addAt(member.url);
        const before = yield* main.cluster.connect(box.environmentId);

        const moved = yield* member.serveAgain;
        expect(
          yield* member.cluster
            .invite({ url: moved })
            .pipe(
              Effect.flatMap((invite) =>
                main.cluster.addMember({ target: invite.joinString ?? "", label: "Moved box" }),
              ),
            ),
        ).toMatchObject({ address: moved, label: "Moved box" });
        const after = yield* main.cluster.connect(box.environmentId);
        expect(after.upstream.origin).toBe(moved);
        expect(after.token).not.toBe(before.token);
        expect(
          yield* member.auth.authenticateHttpRequest(bearer(before.token)).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
        expect(yield* memberCount(main)).toEqual(Option.some(1));
      }),
    ),
);

it.effect("two adds of one member racing leave the stored token the live one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box);
      const main = yield* makeEnvironment(studioDescriptor);
      const first = (yield* member.cluster.invite({ url: member.url })).joinString ?? "";
      const second = (yield* member.cluster.invite({ url: member.url })).joinString ?? "";
      const results = yield* Effect.all(
        [main.cluster.addMember({ target: first }), main.cluster.addMember({ target: second })],
        { concurrency: 2, mode: "result" },
      );
      // The winning join revokes the member's other invites.
      expect(results.filter(Result.isFailure).map((result) => result.failure.reason)).toEqual([
        "pairing_rejected",
      ]);
      const { token } = yield* main.cluster.connect(box.environmentId);
      expect((yield* member.auth.authenticateHttpRequest(bearer(token))).subject).toBe(
        EnvironmentAuth.CLUSTER_HOST_SUBJECT,
      );
      expect(
        (yield* member.auth.listSessions()).filter(
          (session) => session.subject === EnvironmentAuth.CLUSTER_HOST_SUBJECT,
        ),
      ).toHaveLength(1);
    }),
  ),
);

it.effect(
  "adds an ssh member after installing its key with the chosen login, and revokes it on removal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const member = yield* serveMember(box);
        // Answers as the main host itself, as an ssh target naming its own machine would.
        const itself = yield* serveMember(studioDescriptor);
        const ssh = SshTunnel.SshEnvironmentManager.of({
          ensureEnvironment: (target, options) => {
            const served = target.username === "self" ? itself : member;
            return target.username === "nokey"
              ? Effect.fail(
                  new SshCommandError({
                    message: "Permission denied (publickey,password).",
                    command: ["ssh"],
                    exitCode: 255,
                    stderr: "",
                  }),
                )
              : served.cluster.invite({}).pipe(
                  Effect.orDie,
                  Effect.map((invite) => ({
                    target,
                    httpBaseUrl: served.url,
                    wsBaseUrl: served.url.replace(/^http/, "ws"),
                    pairingToken: options?.pairingPurpose === "cluster-member" ? invite.code : null,
                  })),
                );
          },
          disconnectEnvironment: (target) =>
            Effect.sync(() => void disconnected.push(`${target.username}@${target.hostname}`)),
          closeAllTunnels: Effect.void,
        });
        const disconnected: Array<string> = [];
        const authorized: Array<readonly [string, ClusterSshLogin]> = [];
        let failRevokeOfBox2 = false;
        const revoked: Array<string> = [];
        const sshKey = ClusterSshKey.ClusterSshKey.of({
          identityFile: Effect.succeed("/state/cluster_ed25519"),
          authorize: (target, login, trust) =>
            target === "refused@box"
              ? Effect.fail(new ClusterError({ reason: "ssh", message: "refused" }))
              : target === "me@box9" && trust?.fingerprint !== "SHA256:box9"
                ? Effect.fail(
                    new ClusterError({
                      reason: "host_key_unknown",
                      message: "unknown",
                      hostKey: {
                        host: "box9",
                        keyType: "ED25519",
                        fingerprint: "SHA256:box9",
                        knownFingerprints: [],
                      },
                    }),
                  )
                : Effect.sync(() => void authorized.push([target, login])),
          revoke: (target) =>
            target === "me@box2" && failRevokeOfBox2
              ? Effect.die("the old target's revoke broke")
              : Effect.sync(() => revoked.push(target)).pipe(Effect.as(false)),
          list: Effect.succeed([]),
        });
        const main = yield* makeEnvironment(studioDescriptor, ssh, sshKey);
        const password = { _tag: "password", password: Redacted.make("hunter2-secret") } as const;
        const keyFile = {
          _tag: "keyFile",
          path: "/home/me/.ssh/id_ed25519",
          passphrase: Redacted.make("passphrase-secret"),
        } as const;
        expect(
          yield* main.cluster.addMember({ target: "ssh://me@box:2222", login: password }),
        ).toMatchObject({ transport: "ssh", address: "me@box:2222" });
        yield* main.cluster.addMember({ target: "me@box:2222", login: keyFile });
        yield* main.cluster.addMember({ target: "me@box:2222" });
        expect(authorized).toEqual([
          ["me@box:2222", password],
          ["me@box:2222", keyFile],
          ["me@box:2222", { _tag: "config" }],
        ]);
        // What the user typed is never stored.
        const stored = [
          JSON.stringify(yield* main.sql`SELECT * FROM cluster_members`),
          ...NodeFS.readdirSync(main.secretsDir).map((name) =>
            NodeFS.readFileSync(NodePath.join(main.secretsDir, name), "utf8"),
          ),
        ].join("\n");
        expect(stored).not.toContain("hunter2-secret");
        expect(stored).not.toContain("passphrase-secret");

        expect(
          yield* main.cluster.addMember({ target: "refused@box" }).pipe(Effect.flip),
        ).toMatchObject({ reason: "ssh", message: "refused" });
        expect(
          yield* main.cluster.addMember({ target: "nokey@other" }).pipe(Effect.flip),
        ).toMatchObject({
          reason: "ssh",
          message:
            "SSH to nokey@other refused this host's cluster key. Add the member again to reinstall it.",
        });
        expect(
          yield* main.cluster.addMember({ target: "self@studio" }).pipe(Effect.flip),
        ).toMatchObject({ reason: "self" });
        // A failed add takes back the key it installed; re-adding the same target never does.
        expect(revoked).toEqual(["nokey@other", "self@studio"]);

        // Moving the member to another ssh target takes the key off the old one.
        expect(yield* main.cluster.addMember({ target: "me@box2" })).toMatchObject({
          address: "me@box2",
        });
        expect(revoked).toEqual(["nokey@other", "self@studio", "me@box:2222"]);
        expect(disconnected).toEqual(["me@box"]);

        // An unknown host key stops the add before any login, until the user approves that key.
        expect(
          yield* main.cluster.addMember({ target: "me@box9" }).pipe(Effect.flip),
        ).toMatchObject({
          reason: "host_key_unknown",
          hostKey: { host: "box9", fingerprint: "SHA256:box9" },
        });
        expect(revoked).toEqual(["nokey@other", "self@studio", "me@box:2222"]);
        // A step failing once the member's row points at its new target leaves the key there.
        failRevokeOfBox2 = true;
        yield* main.cluster
          .addMember({
            target: "me@box9",
            trustHostKey: { fingerprint: "SHA256:box9", replace: false },
          })
          .pipe(Effect.exit);
        failRevokeOfBox2 = false;
        expect(authorized.at(-1)).toEqual(["me@box9", { _tag: "config" }]);
        expect(revoked).toEqual(["nokey@other", "self@studio", "me@box:2222"]);

        expect(yield* main.cluster.removeMember(box.environmentId)).toEqual({
          removed: true,
          memberNotified: true,
          keyRevoked: false,
        });
        expect(revoked).toEqual(["nokey@other", "self@studio", "me@box:2222", "me@box9"]);
      }),
    ),
);

const readCall = {
  tool: "t3_thread_read",
  arguments: { environmentId: "environment-other", threadId: "thread-1" },
  limits: { runtimeMode: "full-access", interactionMode: "default" },
} satisfies ClusterService.ClusterHostCall;

const UNREACHABLE =
  'Cluster host unreachable: "Studio" is not connected, so other environments in the cluster cannot be reached. Work here continues.';

/** The session a member recorded for its main host at join. */
const hostSessionOf = (member: ClusterEnvironment) =>
  member.sql<{ readonly host_session_id: string }>`
    SELECT host_session_id FROM cluster_membership
  `.pipe(Effect.map(([membership]) => ({ sessionId: membership?.host_session_id ?? "" })));

it.effect(
  "the control link carries a member's calls, fails them when it drops, and never sends one twice",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const member = yield* serveMember(box);
        const main = yield* makeEnvironment(studioDescriptor);
        const invite = yield* member.cluster.invite({ url: member.url });
        yield* main.cluster.addMember({ target: invite.joinString ?? "" });
        // No link yet: an agent's call fails at once instead of waiting for one.
        expect(yield* member.cluster.hostCall(readCall).pipe(Effect.flip)).toMatchObject({
          reason: "unreachable",
          message: UNREACHABLE,
        });

        const served = yield* Queue.unbounded<ClusterHostRequest>();
        const interrupted = yield* Deferred.make<string>();
        const serve: ClusterService.ClusterHostServe = (from, request) =>
          Queue.offer(served, request).pipe(
            Effect.andThen(
              request.tool === "slow"
                ? Effect.never.pipe(
                    Effect.onInterrupt(() => Deferred.succeed(interrupted, request.requestId)),
                  )
                : Effect.succeed({
                    isError: false,
                    text: JSON.stringify({ from: from.environmentId }),
                  }),
            ),
          );
        const firstRun = yield* Scope.make();
        yield* main.cluster.start(serve).pipe(Effect.provideService(Scope.Scope, firstRun));
        expect(yield* awaitStatus(main, box.environmentId, "online")).toMatchObject({
          lastError: null,
        });

        expect(yield* member.cluster.hostCall(readCall)).toEqual({
          isError: false,
          text: JSON.stringify({ from: box.environmentId }),
        });
        const answered = yield* Queue.take(served);
        expect(answered).toMatchObject(readCall);
        // A second answer for that call, as a retried POST would bring, finds nothing waiting.
        expect(
          yield* member.cluster
            .hostReply(yield* hostSessionOf(member), {
              requestId: answered.requestId,
              result: { isError: false, text: "again" },
            })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "unknown_request" });

        // The main host stops with a call in flight: the member hears so, the work there stops.
        const slow = yield* member.cluster
          .hostCall({ ...readCall, tool: "slow" })
          .pipe(Effect.flip, Effect.forkScoped);
        const inFlight = yield* Queue.take(served);
        yield* Scope.close(firstRun, Exit.void);
        expect(yield* Deferred.await(interrupted)).toBe(inFlight.requestId);
        // A stopped link never leaves its member listed online.
        expect(Option.getOrThrow(yield* main.cluster.members.pipe(Stream.runHead))[0]?.status).toBe(
          "offline",
        );
        expect(yield* Fiber.join(slow)).toMatchObject({
          reason: "unreachable",
          message: UNREACHABLE,
        });

        // It starts again: nothing is online until its link is, and the old call never comes back.
        yield* main.cluster.start(serve);
        yield* awaitStatus(main, box.environmentId, "online");
        yield* member.cluster.hostCall(readCall);
        const next = yield* Queue.take(served);
        expect(next.tool).toBe("t3_thread_read");
        expect(next.requestId).not.toBe(inFlight.requestId);
      }),
    ),
);

it.effect(
  "a member holds each call until its link fetches it once, and drops them with the link",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const member = yield* serveMember(box);
        const main = yield* makeEnvironment(studioDescriptor);
        const invite = yield* member.cluster.invite({ url: member.url });
        yield* main.cluster.addMember({ target: invite.joinString ?? "" });
        const host = yield* hostSessionOf(member);
        // The main host's end of the link, held by hand: nothing fetches unless the test does.
        const link = yield* Scope.make();
        const doorbells = yield* Queue.unbounded<ClusterLinkEvent>();
        yield* member.cluster
          .hostEvents(host)
          .pipe(
            Effect.flatMap(Stream.runForEach((event) => Queue.offer(doorbells, event))),
            Effect.forkScoped,
            Effect.provideService(Scope.Scope, link),
          );
        expect(yield* Queue.take(doorbells)).toEqual({ _tag: "ready" });

        const first = yield* member.cluster.hostCall(readCall).pipe(Effect.forkScoped);
        const ring = yield* Queue.take(doorbells);
        if (ring._tag !== "request") return yield* Effect.die("expected a doorbell");
        // The doorbell names the call; its body stays on the member until it is fetched, once.
        expect(Object.keys(ring)).toEqual(["_tag", "requestId"]);
        expect(yield* member.cluster.hostRequest(host, ring.requestId)).toMatchObject(readCall);
        expect(
          yield* member.cluster.hostRequest(host, ring.requestId).pipe(Effect.flip),
        ).toMatchObject({ reason: "unknown_request" });
        yield* member.cluster.hostReply(host, {
          requestId: ring.requestId,
          result: { isError: false, text: "done" },
        });
        expect(yield* Fiber.join(first)).toEqual({ isError: false, text: "done" });

        // The link drops before the next call is fetched: it fails, and its id is gone.
        const second = yield* member.cluster
          .hostCall(readCall)
          .pipe(Effect.flip, Effect.forkScoped);
        const pending = yield* Queue.take(doorbells);
        if (pending._tag !== "request") return yield* Effect.die("expected a doorbell");
        yield* Scope.close(link, Exit.void);
        expect(yield* Fiber.join(second)).toMatchObject({ reason: "unreachable" });
        expect(
          yield* member.cluster.hostRequest(host, pending.requestId).pipe(Effect.flip),
        ).toMatchObject({ reason: "unknown_request" });
      }),
    ),
);

it.effect("a call its host never answers fails after 5 minutes and is forgotten", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* makeEnvironment(box);
      const invite = yield* member.cluster.invite({});
      yield* member.cluster.acceptJoin({ code: invite.code, host: studio }, bot);
      const host = yield* hostSessionOf(member);
      const doorbells = yield* Queue.unbounded<ClusterLinkEvent>();
      yield* member.cluster
        .hostEvents(host)
        .pipe(
          Effect.flatMap(Stream.runForEach((event) => Queue.offer(doorbells, event))),
          Effect.forkScoped,
        );
      expect(yield* Queue.take(doorbells)).toEqual({ _tag: "ready" });

      const call = yield* member.cluster.hostCall(readCall).pipe(Effect.flip, Effect.forkScoped);
      const ring = yield* Queue.take(doorbells);
      if (ring._tag !== "request") return yield* Effect.die("expected a doorbell");
      yield* TestClock.adjust("5 minutes");
      expect(yield* Fiber.join(call)).toMatchObject({
        reason: "unreachable",
        message: UNREACHABLE,
      });
      expect(
        yield* member.cluster.hostRequest(host, ring.requestId).pipe(Effect.flip),
      ).toMatchObject({ reason: "unknown_request" });
    }),
  ),
);

it.effect("a call the main host cannot fetch or run is answered with an error at once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box, {
        hostRequestGate: (request) =>
          request.tool === "unfetchable" ? Effect.die("the fetch broke") : Effect.void,
      });
      const main = yield* makeEnvironment(studioDescriptor);
      const invite = yield* member.cluster.invite({ url: member.url });
      yield* main.cluster.addMember({ target: invite.joinString ?? "" });
      yield* main.cluster.start((_from, request) =>
        request.tool === "crash"
          ? Effect.die("serve broke")
          : Effect.succeed({ isError: false, text: "ok" }),
      );
      yield* awaitStatus(main, box.environmentId, "online");

      for (const tool of ["unfetchable", "crash"]) {
        const result = yield* member.cluster.hostCall({ ...readCall, tool });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.text)).toMatchObject({
          code: "orchestration_error",
          message: expect.stringContaining("Cluster host could not run this call"),
        });
      }
      expect(yield* member.cluster.hostCall(readCall)).toEqual({ isError: false, text: "ok" });
    }),
  ),
);

it.effect("a member that leaves shows revoked over its link, and only its host opens it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box);
      const main = yield* makeEnvironment(studioDescriptor);
      const invite = yield* member.cluster.invite({ url: member.url });
      yield* main.cluster.addMember({ target: invite.joinString ?? "" });
      yield* main.cluster.start(ClusterService.refuseHostRequests);
      yield* awaitStatus(main, box.environmentId, "online");
      expect(yield* member.cluster.hostCall(readCall)).toMatchObject({ isError: true });
      const someoneElse = { sessionId: "session-someone-else" };
      expect(yield* member.cluster.hostEvents(someoneElse).pipe(Effect.flip)).toMatchObject({
        reason: "forbidden",
      });
      expect(
        yield* member.cluster.hostRequest(someoneElse, "request-1").pipe(Effect.flip),
      ).toMatchObject({ reason: "forbidden" });
      expect(
        yield* member.cluster
          .hostReply(someoneElse, {
            requestId: "request-1",
            result: { isError: false, text: "{}" },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "forbidden" });

      // Up long enough not to count as flapping, so the drop reconnects at once.
      yield* TestClock.adjust("5 seconds");
      yield* member.cluster.leave;
      expect(yield* awaitStatus(main, box.environmentId, "revoked")).toMatchObject({
        lastError: "It no longer accepts this host. Invite it again.",
      });
      yield* main.cluster.removeMember(box.environmentId);
      expect(yield* memberCount(main)).toEqual(Option.some(0));
    }),
  ),
);

it.effect("the control link runs at most 32 of a member's calls at a time", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const member = yield* serveMember(box);
      const main = yield* makeEnvironment(studioDescriptor);
      const invite = yield* member.cluster.invite({ url: member.url });
      yield* main.cluster.addMember({ target: invite.joinString ?? "" });
      const served = yield* Queue.unbounded<ClusterHostRequest>();
      yield* main.cluster.start((_from, request) =>
        Queue.offer(served, request).pipe(Effect.andThen(Effect.never)),
      );
      yield* awaitStatus(main, box.environmentId, "online");

      // 32 calls run; the 33rd is answered busy at once and never reaches `serve`.
      yield* Effect.forEach(
        Array.from({ length: 32 }),
        () => member.cluster.hostCall(readCall).pipe(Effect.forkScoped),
        { discard: true },
      );
      yield* Effect.forEach(Array.from({ length: 32 }), () => Queue.take(served), {
        discard: true,
      });
      const busy = yield* member.cluster.hostCall(readCall);
      expect(busy.isError).toBe(true);
      expect(JSON.parse(busy.text)).toMatchObject({
        code: "orchestration_error",
        message: expect.stringContaining("Cluster host busy"),
      });
      expect(yield* Queue.size(served)).toBe(0);
    }),
  ),
);

it.effect("a large request or reply on the control link does not hold back a small one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const large = "x".repeat(3 * 1024 * 1024);
      const largeFetched = yield* Deferred.make<void>();
      const releaseFetch = yield* Deferred.make<void>();
      const largeAtMember = yield* Deferred.make<void>();
      const releaseReply = yield* Deferred.make<void>();
      // The member holds the 3 MiB call's fetch, then the 3 MiB answer, until the test lets go.
      const member = yield* serveMember(box, {
        hostRequestGate: (request) =>
          request.arguments.message === large
            ? Deferred.succeed(largeFetched, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFetch)),
              )
            : Effect.void,
        hostReplyGate: (input) =>
          input.result.text === large
            ? Deferred.succeed(largeAtMember, undefined).pipe(
                Effect.andThen(Deferred.await(releaseReply)),
              )
            : Effect.void,
      });
      const main = yield* makeEnvironment(studioDescriptor);
      const invite = yield* member.cluster.invite({ url: member.url });
      yield* main.cluster.addMember({ target: invite.joinString ?? "" });
      yield* main.cluster.start((_from, request) =>
        Effect.succeed({ isError: false, text: request.tool === "large" ? large : "small" }),
      );
      yield* awaitStatus(main, box.environmentId, "online");

      const largeRequest = yield* member.cluster
        .hostCall({ ...readCall, arguments: { message: large } })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(largeFetched);
      expect(yield* member.cluster.hostCall(readCall)).toEqual({ isError: false, text: "small" });
      expect(largeRequest.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(releaseFetch, undefined);
      expect(yield* Fiber.join(largeRequest)).toEqual({ isError: false, text: "small" });

      const largeReply = yield* member.cluster
        .hostCall({ ...readCall, tool: "large" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(largeAtMember);
      expect(yield* member.cluster.hostCall(readCall)).toEqual({ isError: false, text: "small" });
      expect(largeReply.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(releaseReply, undefined);
      expect((yield* Fiber.join(largeReply)).text.length).toBe(large.length);
    }),
  ),
);

it.effect("the control link lives on heartbeats and ends after 40 s without a byte", () =>
  Effect.gen(function* () {
    const bytes = yield* Queue.unbounded<string>();
    const reading = yield* Stream.fromQueue(bytes).pipe(
      Stream.encodeText,
      ClusterService.readLinkEvents,
      Stream.runCollect,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Queue.offer(bytes, 'event: ready\ndata: {"_tag":"ready"}\n\n');
    // Comments only, 15 s apart: a minute with no event, and the link is still up.
    for (let beat = 0; beat < 4; beat++) {
      yield* TestClock.adjust("15 seconds");
      yield* Queue.offer(bytes, ": heartbeat\n\n");
    }
    yield* Queue.offer(bytes, 'event: request\ndata: {"_tag":"request","requestId":"r1"}\n\n');
    expect(reading.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust("40 seconds");
    expect(Array.from(yield* Fiber.join(reading))).toEqual([
      { _tag: "ready" },
      { _tag: "request", requestId: "r1" },
    ]);
  }),
);

it.effect("rereads members a CLI add wrote, except on a member, which never has any", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const writeRow = (environment: ClusterEnvironment) => environment.sql`
        INSERT INTO cluster_members (environment_id, label, transport, url, ssh_target, cert_sha256, secret_name, status, joined_at, last_reached_at, last_error)
        VALUES ('environment-added', 'Added', 'https', 'https://192.168.1.30:3773', NULL, NULL, 'cluster-member-added', 'offline', '2026-11-19T00:00:00.000Z', NULL, NULL)
      `;
      const standalone = yield* makeEnvironment(studioDescriptor);
      yield* standalone.cluster.start(ClusterService.refuseHostRequests);
      const member = yield* makeEnvironment(box);
      const invite = yield* member.cluster.invite({});
      yield* member.cluster.acceptJoin({ code: invite.code, host: studio }, bot);
      yield* member.cluster.start(ClusterService.refuseHostRequests);
      yield* writeRow(member);
      yield* writeRow(standalone);

      yield* TestClock.adjust("30 seconds");
      yield* standalone.cluster.members.pipe(
        Stream.filter((members) => members.length === 1),
        Stream.runHead,
      );
      // A member's timer would have fired twice by now; only a skipped reread leaves this empty.
      yield* TestClock.adjust("30 seconds");
      yield* standalone.cluster.renameMember({
        memberId: EnvironmentId.make("environment-added"),
        label: "Renamed",
      });
      expect(yield* member.cluster.members.pipe(Stream.runHead)).toEqual(Option.some([]));
    }),
  ),
);
