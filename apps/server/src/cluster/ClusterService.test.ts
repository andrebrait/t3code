import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { clusterDescriptor, FINGERPRINT, makeEnvironment } from "./ClusterService.testkit.ts";

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
      const joined = yield* member.cluster.acceptJoin({ code: invite.code, host: studio }, bot);
      expect(joined).toMatchObject({ environmentId: box.environmentId, label: "Box" });

      expect(
        (yield* member.auth.listSessions())
          .map((session) => [session.subject, session.client.ipAddress ?? null])
          .toSorted(),
      ).toEqual([
        [EnvironmentAuth.CLUSTER_HOST_SUBJECT, "192.168.1.10"],
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
      const second = yield* member.cluster.invite({});
      expect(
        yield* member.cluster.acceptJoin({ code: second.code, host: other }, bot).pipe(Effect.flip),
      ).toMatchObject({
        reason: "is_member",
        message:
          "This environment is already a member of the cluster hosted by Studio. Leave it there first.",
      });
      expect(
        yield* member.cluster
          .acceptJoin(
            { code: second.code, host: { environmentId: box.environmentId, label: "Box" } },
            bot,
          )
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "self" });

      const main = yield* makeEnvironment(studioDescriptor);
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
      ).toMatchObject({ reason: "is_main_host" });
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
      expect(results.filter(Result.isFailure).map((result) => result.failure.reason)).toEqual([
        "is_member",
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
