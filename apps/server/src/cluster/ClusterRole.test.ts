import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ClusterRole from "./ClusterRole.ts";

const layerTest = ClusterRole.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeServices.layer),
);

it.effect("reads its role from the cluster tables and refuses by role, naming the cluster", () =>
  Effect.gen(function* () {
    const role = yield* ClusterRole.ClusterRole;
    const sql = yield* SqlClient.SqlClient;
    expect(yield* role.current).toEqual({ role: "standalone" });
    yield* role.refuseIfClustered("Linking environments");

    yield* sql`
      INSERT INTO cluster_members (environment_id, label, transport, url, cert_sha256, secret_name, status, joined_at)
      VALUES ('environment-box', 'Box', 'https', 'https://box:3773', ${"a".repeat(64)}, 'cluster-member-1', 'online', '2026-11-19T00:00:00.000Z')
    `;
    expect(yield* role.current).toEqual({ role: "main" });
    yield* role.refuseIfMember("Pairing a client");
    expect(yield* role.refuseIfClustered("Linking environments").pipe(Effect.flip)).toMatchObject({
      reason: "is_main_host",
      message:
        "Linking environments is not available here: this environment is the main host of a cluster.",
    });

    yield* sql`DELETE FROM cluster_members`;
    yield* sql`
      INSERT INTO cluster_membership (singleton, host_environment_id, host_label, joined_at, host_session_id)
      VALUES (1, 'environment-studio', 'Studio', '2026-11-19T00:00:00.000Z', 'session-1')
    `;
    expect(yield* role.current).toEqual({
      role: "member",
      hostEnvironmentId: "environment-studio",
      hostLabel: "Studio",
    });
    expect(yield* role.refuseIfMember("Pairing a client").pipe(Effect.flip)).toMatchObject({
      reason: "is_member",
      message:
        "Pairing a client is not available here: this environment is a member of the cluster hosted by Studio.",
    });
  }).pipe(Effect.provide(layerTest)),
);
