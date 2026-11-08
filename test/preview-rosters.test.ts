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

  it("produces the pinned league-25 ratings", () => {
    expect(teams).toHaveLength(8);
    const byName = new Map(teams.map((t) => [t.name, t]));

    // The store holds leagues 20 to 24 only, so the live rating over all
    // history and the season-opening rating over the pre-season history
    // are the same figures today.
    expect(byName.get("Set Phasers to Huck (Nick)")!.rating.rating).toBeCloseTo(65.42, 1);
    expect(byName.get("The Empire Throws Back (Des)")!.rating.rating).toBeCloseTo(26.58, 1);
    expect(byName.get("The Away Team (Al)")!.rating.rating).toBeCloseTo(21.17, 1);
    expect(byName.get("Twenty Thousand Hammers to Stay Under the Salary Cap (Gabe)")!.rating.rating).toBeCloseTo(13.3, 1);
    expect(byName.get("A Handler's Guide to the Galaxy Point (Heath)")!.rating.rating).toBeCloseTo(8.57, 1);
    expect(byName.get("Disc Side of the Force (Noah)")!.rating.rating).toBeCloseTo(3.27, 1);
    expect(byName.get("Hold the Force, Luke (Cath)")!.rating.rating).toBeCloseTo(1.19, 1);
    expect(byName.get("Huck to the Future (Deanna)")!.rating.rating).toBeCloseTo(-46.55, 1);

    // Sorted best rating first.
    expect(teams[0].name).toBe("Set Phasers to Huck (Nick)");
    expect(teams[7].name).toBe("Huck to the Future (Deanna)");
  });

  it("counts players with store history separately from players contributing", () => {
    const gabe = teams.find((t) => t.name.startsWith("Twenty Thousand Hammers"))!;
    expect(gabe.storePlayerIds).toHaveLength(9);
    expect(gabe.rating.contributingPlayers).toBe(8);
    expect(gabe.unknownNames).toHaveLength(3);
  });

  it("compares against the previous report when there is one", async () => {
    // The history table persists between runs, so this check compares
    // the figure against the recorded history rather than asserting an
    // absolute value.
    const db = new Database("parity-synergy.db", { readonly: true });
    const source = new ParityApiSource({
      baseUrl: "https://parity.kevinhughes27.workers.dev",
    });
    const resolved = await resolveAndRateTeams(db as never, source as unknown as DataSource, 25);
    const recorded = db
      .prepare(
        "SELECT team_name, rating FROM synergy_history WHERE league_id = 25 ORDER BY game_high_water DESC, id DESC",
      )
      .all() as { team_name: string; rating: number }[];
    for (const team of resolved) {
      const entry = recorded.find((row) => row.team_name === team.name);
      if (entry === undefined) {
        expect(team.changeSinceLastGame).toBeUndefined();
        expect(team.hasComparison).toBe(false);
      } else {
        expect(team.hasComparison).toBe(true);
        // The recorded figure is one of the two the comparison may use,
        // and the change is the difference between them.
        const candidates = recorded
          .filter((row) => row.team_name === team.name)
          .map((row) => team.rating.rating - row.rating);
        expect(candidates).toContain(team.changeSinceLastGame);
      }
    }
    db.close();
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
