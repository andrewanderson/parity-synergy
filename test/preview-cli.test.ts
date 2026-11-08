import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPreview } from "../src/preview/index.js";
import { openExistingDb } from "../src/store/db.js";

describe("buildPreview", () => {
  /**
   * The history table lives in the store and persists between runs, so
   * every test that writes to it clears its own rows afterwards and
   * leaves the store as it was found.
   */
  async function withCleanHistory(fn: (db: Database.Database) => Promise<void>): Promise<void> {
    const db = openExistingDb("parity-synergy.db");
    db.prepare("DELETE FROM synergy_history WHERE league_id = 25").run();
    try {
      await fn(db);
    } finally {
      db.prepare("DELETE FROM synergy_history WHERE league_id = 25").run();
      db.close();
    }
  }

  it("writes a self-contained page with the eight teams", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "preview-"));
    try {
      await withCleanHistory(async (db) => {
        const out = path.join(dir, "preview.html");
        const result = await buildPreview({
          db,
          baseUrl: "https://parity.kevinhughes27.workers.dev",
          leagueId: 25,
          outPath: out,
        });
        expect(result.teamCount).toBe(8);
        expect(result.byteLength).toBeGreaterThan(1000);
        const html = await readFile(out, "utf8");
        expect(html).toContain("Set Phasers to Huck (Nick)");
        expect(html).not.toMatch(/https?:\/\//);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("carries each team's shared-games total onto the page", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "preview-"));
    try {
      await withCleanHistory(async (db) => {
        const out = path.join(dir, "preview.html");
        await buildPreview({
          db,
          baseUrl: "https://parity.kevinhughes27.workers.dev",
          leagueId: 25,
          outPath: out,
        });
        const html = await readFile(out, "utf8");
        expect(html).toMatch(/shared games/i);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("records the season's first figures and does not record again without new games", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "preview-"));
    try {
      await withCleanHistory(async (db) => {
        const out = path.join(dir, "preview.html");

        const first = await buildPreview({
          db,
          baseUrl: "https://parity.kevinhughes27.workers.dev",
          leagueId: 25,
          outPath: out,
        });
        expect(first.recorded).toBe("season_opening");
        const rows = db
          .prepare("SELECT COUNT(*) c FROM synergy_history WHERE league_id = 25")
          .get() as { c: number };
        expect(rows.c).toBe(8);

        // A second run over the same games records nothing new: the game
        // watermark has not advanced, so the comparison must not move.
        const second = await buildPreview({
          db,
          baseUrl: "https://parity.kevinhughes27.workers.dev",
          leagueId: 25,
          outPath: out,
        });
        expect(second.recorded).toBe("unchanged");
        const after = db
          .prepare("SELECT COUNT(*) c FROM synergy_history WHERE league_id = 25")
          .get() as { c: number };
        expect(after.c).toBe(8);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("shows a change since the last game once there is history to compare against", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "preview-"));
    try {
      await withCleanHistory(async (db) => {
        const out = path.join(dir, "preview.html");
        await buildPreview({
          db,
          baseUrl: "https://parity.kevinhughes27.workers.dev",
          leagueId: 25,
          outPath: out,
        });
        // A second report at an earlier game mark stands in for a previous
        // report, so the card has something to compare against.
        db.prepare(
          `INSERT INTO synergy_history
             (league_id, team_name, entry_type, taken_at, rating, pair_count,
              shared_point_count, shared_game_count, roster_signature, game_high_water)
           SELECT league_id, team_name, 'ingest', '2026-11-01T00:00:00.000Z', rating - 5,
                  pair_count, shared_point_count, shared_game_count, roster_signature, 1000
           FROM synergy_history WHERE league_id = 25`,
        ).run();
        await buildPreview({
          db,
          baseUrl: "https://parity.kevinhughes27.workers.dev",
          leagueId: 25,
          outPath: out,
        });
        const html = await readFile(out, "utf8");
        expect(html).toContain("since last game");
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
