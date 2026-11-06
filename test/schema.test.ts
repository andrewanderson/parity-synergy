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
    db.close();
  });

  it("is idempotent when migrated twice", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "synergy-schema-"));
    dirs.push(dir);
    const db = openDb(path.join(dir, "test.db"));
    let second: Db | undefined;
    expect(() => {
      second = openDb(path.join(dir, "test.db"));
    }).not.toThrow();
    const version = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe(String(SCHEMA_VERSION));
    second?.close();
    db.close();
  });
});
