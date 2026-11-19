import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Rows here make this environment a main host. Each member's `cluster-host` token
  // lives in the secret store under `secret_name`, unique per join.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cluster_members (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      transport TEXT NOT NULL CHECK (transport IN ('https', 'ssh')),
      url TEXT,
      ssh_target TEXT,
      cert_sha256 TEXT,
      secret_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'incompatible', 'revoked')),
      joined_at TEXT NOT NULL,
      last_reached_at TEXT,
      last_error TEXT,
      CHECK ((transport = 'https') = (url IS NOT NULL AND ssh_target IS NULL))
    )
  `;
  // Its one row makes this environment a member.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cluster_membership (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      host_environment_id TEXT NOT NULL,
      host_label TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      host_session_id TEXT NOT NULL
    )
  `;
});
