import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveAndRateTeams } from "../src/preview/rosters.js";
import { ParityApiSource } from "parity-mcp/data/api";
import type { DataSource } from "parity-mcp/data/source";

/**
 * Two players who are on the same league-25 roster. The test inserts a
 * game with these two on one line, so the game actually moves the
 * rating: a pair that was never on a roster together would leave the
 * numbers unchanged and the test would pass with a broken window.
 */
const PAIR_ON_ONE_ROSTER = [104, 174];

describe("resolveAndRateTeams", () => {
  // resolveAndRateTeams costs several seconds over the real store plus
  // one live-API roster fetch, so it is computed once here rather than
  // once per test.
  let teams: Awaited<ReturnType<typeof resolveAndRateTeams>>;
  beforeAll(async () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const source = new ParityApiSource({
      baseUrl: "https://parity.kevinhughes27.workers.dev",
    });
    teams = await resolveAndRateTeams(db as never, source as unknown as DataSource, 25);
    db.close();
  }, 180_000);

  it("rates every roster and orders them best first", () => {
    // The figures themselves are not pinned here: the store grows every
    // week and the rosters change with the trades, so a pinned rating
    // would be stale by the next ingest. The measure's arithmetic is
    // pinned against a fixture in test/preview-history.test.ts, and the
    // store's current figures are recorded in test/fixtures/live-store.json.
    expect(teams).toHaveLength(8);
    for (const team of teams) {
      expect(Number.isFinite(team.rating.rating)).toBe(true);
      expect(team.rating.pairCount).toBeGreaterThanOrEqual(0);
      expect(team.rating.sharedPointCount).toBeGreaterThanOrEqual(0);
      // A player who contributes is one of the roster's players.
      expect(team.rating.contributingPlayers).toBeLessThanOrEqual(team.storePlayerIds.length);
      expect(team.storePlayerIds.length + team.unknownNames.length).toBe(team.rosterNames.length);
    }
    // Sorted best rating first.
    for (let i = 1; i < teams.length; i++) {
      expect(teams[i - 1]!.rating.rating).toBeGreaterThanOrEqual(teams[i]!.rating.rating);
    }
  });

  it("counts players with store history separately from players contributing", () => {
    const gabe = teams.find((t) => t.name.startsWith("Twenty Thousand Hammers"))!;
    expect(gabe.storePlayerIds.length).toBeGreaterThan(0);
    expect(gabe.rating.contributingPlayers).toBeLessThanOrEqual(gabe.storePlayerIds.length);
    expect(gabe.unknownNames.length).toBeGreaterThanOrEqual(0);
  });

  it("compares against the previous report when there is one", async () => {
    // The history table holds the report's memory of the season, so the
    // rows are read before the test and written back afterwards, with
    // the measure they were recorded under: a row written before the
    // table gained that column is a hold-and-break rating.
    const writable = new Database("parity-synergy.db");
    const saved = writable.prepare("SELECT * FROM synergy_history").all() as Record<string, unknown>[];
    writable.prepare("DELETE FROM synergy_history").run();
    writable.close();
    try {
      const db = new Database("parity-synergy.db");
      // Seed one report at a lower game mark, so the comparison has a
      // figure to use.
      db.prepare(
        `INSERT INTO synergy_history
           (league_id, team_name, entry_type, taken_at, rating, pair_count,
            shared_point_count, shared_game_count, roster_signature, game_high_water, measure)
         VALUES (25, 'Set Phasers to Huck (Nick)', 'ingest', '2026-11-01T00:00:00.000Z',
                 60, 24, 1504, 54, '1,2,3', 1000, 'salary')`,
      ).run();
      db.close();

      const fresh = new Database("parity-synergy.db", { readonly: true });
      const source = new ParityApiSource({
        baseUrl: "https://parity.kevinhughes27.workers.dev",
      });
      const resolved = await resolveAndRateTeams(
        fresh as never,
        source as unknown as DataSource,
        25,
      );
      const nick = resolved.find((t) => t.name === "Set Phasers to Huck (Nick)")!;
      expect(nick.hasComparison).toBe(true);
      // The change is the difference between the current figure and the
      // recorded one.
      expect(nick.changeSinceLastGame).toBeCloseTo(nick.rating.rating - 60, 5);
      // A team with no recorded figure has no comparison.
      const other = resolved.find((t) => t.name !== nick.name)!;
      expect(other.hasComparison).toBe(false);
      expect(other.changeSinceLastGame).toBeUndefined();
      fresh.close();
    } finally {
      const restore = new Database("parity-synergy.db");
      restore.prepare("DELETE FROM synergy_history").run();
      if (saved.length > 0) {
        const insert = restore.prepare(
          `INSERT INTO synergy_history
             (league_id, team_name, entry_type, taken_at, rating, pair_count,
              shared_point_count, shared_game_count, roster_signature, game_high_water, measure)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const putBack = restore.transaction((rows: Record<string, unknown>[]) => {
          for (const row of rows) {
            insert.run(
              row.league_id,
              row.team_name,
              row.entry_type,
              row.taken_at,
              row.rating,
              row.pair_count,
              row.shared_point_count,
              row.shared_game_count,
              row.roster_signature,
              row.game_high_water,
              row.measure ?? "hold_break",
            );
          }
        });
        putBack(saved);
      }
      restore.close();
    }
  }, 180_000);

  it("includes a newly ingested league 25 game in the rating", async () => {
    // Read-write for this one case: the test inserts its own rows and
    // deletes them again, so the store is left exactly as it was found.
    const db = new Database("parity-synergy.db");
    const source = new ParityApiSource({
      baseUrl: "https://parity.kevinhughes27.workers.dev",
    });
    const before = await resolveAndRateTeams(db as never, source as unknown as DataSource, 25);

    // Simulate an ingested league-25 game. The players are a known
    // league-25 pair, and the point carries salary rules, so the game
    // moves the rating rather than merely existing.
    const insert = db.transaction(() => {
      db.prepare(
        "INSERT INTO games (game_id, league_id, week, date, home_team, away_team, home_score, away_score, salary_rules_version, imported_at) VALUES (2000, 25, 1, NULL, 'Test A', 'Test B', 1, 0, 1, 'now')",
      ).run();
      db.prepare(
        "INSERT INTO points (point_id, game_id, point_number, offense_team, defense_team, duration_sec) VALUES (99999, 2000, 1, 'Test A', 'Test B', 60)",
      ).run();
      for (const playerId of PAIR_ON_ONE_ROSTER) {
        db.prepare(
          "INSERT INTO appearances (point_id, player_id, line, is_substitute, touches, line_changed) VALUES (99999, ?, 'offense', 0, 0, 0)",
        ).run(playerId);
      }
      for (const playerId of PAIR_ON_ONE_ROSTER) {
        db.prepare(
          "INSERT INTO salary_rule (point_id, player_id, rule_name, amount) VALUES (99999, ?, 'HOLD', 1000)",
        ).run(playerId);
      }
    });
    insert();
    try {
      const after = await resolveAndRateTeams(db as never, source as unknown as DataSource, 25);
      const pair = after.find((team) => team.storePlayerIds.includes(PAIR_ON_ONE_ROSTER[0]!));
      expect(pair, "a league-25 roster must contain the test pair").toBeDefined();
      const beforePair = before.find((team) => team.storePlayerIds.includes(PAIR_ON_ONE_ROSTER[0]!));
      // The live report covers every game, so the new game moves the
      // rating. It must move, or the test would pass with a broken
      // window.
      expect(pair!.rating.sharedPointCount).toBeGreaterThan(
        beforePair!.rating.sharedPointCount,
      );
      expect(pair!.gameHighWater).toBe(2000);
    } finally {
      db.prepare("DELETE FROM salary_rule WHERE point_id = 99999").run();
      db.prepare("DELETE FROM appearances WHERE point_id = 99999").run();
      db.prepare("DELETE FROM points WHERE point_id = 99999").run();
      db.prepare("DELETE FROM games WHERE game_id = 2000").run();
      db.close();
    }
  }, 180_000);
});
