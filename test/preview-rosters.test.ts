import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveAndRateTeams } from "../src/preview/rosters.js";
import { ParityApiSource } from "parity-mcp/data/api";
import type { DataSource } from "parity-mcp/data/source";

describe("resolveAndRateTeams", () => {
  // resolveAndRateTeams costs several seconds (the 41-team reference
  // pass over the real store) plus one live-API roster fetch, so it is
  // computed once here rather than three times, one per test.
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

  it("places each team against the 41-team reference distribution", () => {
    const byName = new Map(teams.map((t) => [t.name, t]));
    const nick = byName.get("Set Phasers to Huck (Nick)")!;
    const deanna = byName.get("Huck to the Future (Deanna)")!;
    const cath = byName.get("Hold the Force, Luke (Cath)")!;
    // Percentile is the fraction of the 41 reference values strictly below the rating.
    expect(nick.percentile).toBeCloseTo(41 / 41, 5);
    expect(deanna.percentile).toBeCloseTo(3 / 41, 5);
    expect(cath.percentile).toBeCloseTo(19 / 41, 5);
  });

  it("does not let league 25 games change the rating", async () => {
    // Read-write for this one case: the test inserts its own rows and
    // deletes them again, so the store is left exactly as it was found.
    const db = new Database("parity-synergy.db");
    const source = new ParityApiSource({
      baseUrl: "https://parity.kevinhughes27.workers.dev",
    });
    const before = await resolveAndRateTeams(db as never, source as unknown as DataSource, 25);

    // Simulate a league-25 game by inserting facts, then check the rating is unmoved.
    const insert = db.transaction(() => {
      db.prepare(
        "INSERT INTO games (game_id, league_id, week, date, home_team, away_team, home_score, away_score, salary_rules_version, imported_at) VALUES (2000, 25, 1, NULL, 'Test A', 'Test B', 1, 0, 1, 'now')",
      ).run();
      db.prepare(
        "INSERT INTO points (point_id, game_id, point_number, offense_team, defense_team, duration_sec) VALUES (99999, 2000, 1, 'Test A', 'Test B', 60)",
      ).run();
      db.prepare(
        "INSERT INTO appearances (point_id, player_id, line, is_substitute, touches, line_changed) VALUES (99999, 1, 'offense', 0, 0, 0)",
      ).run();
      db.prepare(
        "INSERT INTO appearances (point_id, player_id, line, is_substitute, touches, line_changed) VALUES (99999, 2, 'offense', 0, 0, 0)",
      ).run();
    });
    insert();
    try {
      const after = await resolveAndRateTeams(db as never, source as unknown as DataSource, 25);
      expect(after.map((t) => t.rating.rating)).toEqual(before.map((t) => t.rating.rating));
    } finally {
      db.prepare("DELETE FROM appearances WHERE point_id = 99999").run();
      db.prepare("DELETE FROM points WHERE point_id = 99999").run();
      db.prepare("DELETE FROM games WHERE game_id = 2000").run();
      db.close();
    }
  }, 180_000);
});
