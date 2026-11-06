import type { Db } from "./db.js";

export const SCHEMA_VERSION = 1;

/**
 * The full DDL for schema version 1. Every statement uses `IF NOT EXISTS`,
 * so re-running is safe. `PRAGMA foreign_keys` is intentionally absent:
 * `openDb` sets it with `db.pragma("foreign_keys = ON")` on the connection.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  game_id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL,
  week INTEGER NOT NULL,
  date TEXT,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  salary_rules_version INTEGER NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  player_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  is_substitute INTEGER NOT NULL DEFAULT 0,
  division TEXT
);

CREATE TABLE IF NOT EXISTS points (
  point_id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
  point_number INTEGER NOT NULL,
  offense_team TEXT,
  defense_team TEXT,
  duration_sec REAL,
  UNIQUE (game_id, point_number)
);

CREATE TABLE IF NOT EXISTS appearances (
  point_id INTEGER NOT NULL REFERENCES points(point_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  line TEXT NOT NULL CHECK (line IN ('offense','defense')),
  is_substitute INTEGER NOT NULL DEFAULT 0,
  touches INTEGER NOT NULL DEFAULT 0,
  line_changed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (point_id, player_id)
);

CREATE TABLE IF NOT EXISTS appearance_metric (
  point_id INTEGER NOT NULL REFERENCES points(point_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (point_id, player_id, metric)
);

CREATE TABLE IF NOT EXISTS salary_rule (
  point_id INTEGER NOT NULL REFERENCES points(point_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  rule_name TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (point_id, player_id, rule_name)
);

CREATE TABLE IF NOT EXISTS salary_components (
  point_id INTEGER NOT NULL REFERENCES points(point_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  rule_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  event_index INTEGER
);

CREATE TABLE IF NOT EXISTS opponent_weight (
  point_id INTEGER NOT NULL REFERENCES points(point_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  opponent_id INTEGER NOT NULL REFERENCES players(player_id),
  weight REAL NOT NULL,
  weighting TEXT NOT NULL CHECK (weighting IN ('involvement','equal')),
  PRIMARY KEY (point_id, player_id, opponent_id)
);

CREATE TABLE IF NOT EXISTS player_baselines (
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  metric TEXT NOT NULL,
  points INTEGER NOT NULL,
  total REAL NOT NULL,
  mean REAL NOT NULL,
  PRIMARY KEY (player_id, metric)
);

CREATE TABLE IF NOT EXISTS ingest_log (
  game_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','rejected')),
  reason TEXT,
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appearances_player ON appearances(player_id);
CREATE INDEX IF NOT EXISTS idx_appearance_metric_player ON appearance_metric(player_id, metric);
CREATE INDEX IF NOT EXISTS idx_opponent_weight_opponent ON opponent_weight(opponent_id);
CREATE INDEX IF NOT EXISTS idx_points_game ON points(game_id);
CREATE INDEX IF NOT EXISTS idx_salary_rule_player ON salary_rule(player_id, rule_name);

CREATE VIEW IF NOT EXISTS pair_effects AS SELECT NULL AS player_a WHERE 0;
CREATE VIEW IF NOT EXISTS opponent_effects AS SELECT NULL AS player_id WHERE 0;
`;

/**
 * Apply the schema to `db` and record the schema version, atomically: the
 * DDL and the version upsert share one transaction, so a mid-exec failure
 * cannot leave partial DDL applied with no version row. Safe to run
 * repeatedly: the DDL uses `IF NOT EXISTS` and the version row upserts.
 */
export function migrate(db: Db): void {
  const apply = db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SCHEMA_VERSION));
  });
  apply();
}
