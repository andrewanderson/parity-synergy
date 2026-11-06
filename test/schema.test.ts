import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/store/db.js";
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
        "INSERT INTO games (game_id, league_id, week, home_team, away_team, home_score, away_score, salary_rules_version, imported_at) VALUES (1, 1, 1, 'Home', 'Away', 10, 7, 1, '2026-11-05T00:00:00Z')",
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
});
