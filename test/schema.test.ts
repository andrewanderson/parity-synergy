import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/store/db.js";
import { resolveGameId } from "../src/store/gameIds.js";
import { SCHEMA_VERSION } from "../src/store/schema.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("database schema", () => {
  it("creates every fact table, the baselines table, and both effect views", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "synergy-schema-"));
    dirs.push(dir);
    const db = openDb(path.join(dir, "test.db"));
    try {
      const names = (
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).all() as Array<{ name: string }>
      ).map((row) => row.name);
      for (const expected of [
        "appearances",
        "appearance_metric",
        "games",
        "ingest_log",
        "opponent_effects",
        "opponent_weight",
        "pair_effects",
        "player_baselines",
        "players",
        "points",
        "salary_components",
        "salary_rule",
      ]) {
        expect(names).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it("enables foreign keys and cascades game deletion to points", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "synergy-schema-"));
    dirs.push(dir);
    const db = openDb(path.join(dir, "test.db"));
    try {
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      db.prepare(
        "INSERT INTO games (game_id, league_id, week, home_team, away_team, home_score, away_score, salary_rules_version, imported_at, external_id) VALUES (1, 1, 1, 'Home', 'Away', 10, 7, 1, '2026-11-05T00:00:00Z', '1')",
      ).run();
      db.prepare("INSERT INTO points (game_id, point_number) VALUES (1, 1)").run();
      db.prepare("DELETE FROM games WHERE game_id = 1").run();
      const remaining = db
        .prepare("SELECT COUNT(*) AS c FROM points WHERE game_id = 1")
        .get() as { c: number };
      expect(remaining.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it("is idempotent when migrated twice", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "synergy-schema-"));
    dirs.push(dir);
    const db = openDb(path.join(dir, "test.db"));
    let second: Db | undefined;
    try {
      expect(() => {
        second = openDb(path.join(dir, "test.db"));
      }).not.toThrow();
      const version = db
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get() as { value: string };
      expect(version.value).toBe(String(SCHEMA_VERSION));
    } finally {
      second?.close();
      db.close();
    }
  });

  it("migrates a store written before the API reported UUID game ids", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "synergy-schema-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "legacy.db");

    // A store on the old schema: the games and the ingest log carry no
    // external id.
    const legacy = new Database(dbPath);
    legacy.exec(
      `CREATE TABLE games (
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
       CREATE TABLE ingest_log (
         game_id INTEGER NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('ok','rejected')),
         reason TEXT,
         checked_at TEXT NOT NULL
       );`,
    );
    legacy
      .prepare(
        `INSERT INTO games (game_id, league_id, week, date, home_team, away_team, home_score, away_score, salary_rules_version, imported_at)
         VALUES (1000, 24, 1, NULL, 'Home', 'Away', 10, 7, 1, '2026-11-05T00:00:00Z')`,
      )
      .run();
    legacy
      .prepare("INSERT INTO ingest_log (game_id, status, reason, checked_at) VALUES (1000, 'ok', NULL, '2026-11-05T00:00:00Z')")
      .run();
    legacy.close();

    const db = openDb(dbPath);
    try {
      const game = db
        .prepare("SELECT game_id, external_id FROM games WHERE game_id = 1000")
        .get() as { game_id: number; external_id: string };
      // The old numeric id becomes the external id, so the game is still the
      // same game after the migration.
      expect(game.external_id).toBe("1000");

      const log = db
        .prepare("SELECT external_id FROM ingest_log WHERE game_id = 1000")
        .get() as { external_id: string };
      expect(log.external_id).toBe("1000");

      // The migrated store still knows the game by the id the API used, so
      // an ingest of it replaces its rows instead of writing a second game.
      expect(resolveGameId(db, 24, "1000")).toBe(1000);
      expect(resolveGameId(db, 24, 1000)).toBe(1000);

      // Two games of one league cannot share an external id.
      expect(() =>
        db
          .prepare(
            `INSERT INTO games (game_id, league_id, week, home_team, away_team, home_score, away_score, salary_rules_version, imported_at, external_id)
             VALUES (2000, 24, 1, 'Home', 'Away', 10, 7, 1, '2026-11-05T00:00:00Z', '1000')`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
