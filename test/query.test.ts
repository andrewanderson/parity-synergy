import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeGame, normalizePlayerRef } from "parity-mcp/data/normalize";
import { assembleFullGame } from "parity-mcp/server";
import { buildPointStats } from "parity-mcp/engine/pointStats";
import type { ApiGame, SupportedLeague } from "parity-mcp/domain/types";
import { writeGameFacts } from "../src/store/facts.js";
import { playerIdFor, recomputeBaselines } from "../src/store/baselines.js";
import { openDb, type Db } from "../src/store/db.js";
import { MIN_SHARED_POINTS, pairDetail, pairLeaderboard, type PairRow } from "../src/query/pairs.js";
import { opponentEffects, playerProfile, type OpponentRow } from "../src/query/opponents.js";
import { evaluateTeam } from "../src/query/teams.js";

const fixturePath = path.resolve(
  process.cwd(),
  "..",
  "parity-mcp",
  "test",
  "fixtures",
  "captures",
  "game-1000.json",
);
const rawGame = JSON.parse(readFileSync(fixturePath, "utf8")) as ApiGame;

const league: SupportedLeague = {
  id: 24,
  name: "Winter Indoor Parity 2026",
  statValues: "v2",
  lineSize: 6,
  salaryCalc: "pro_rate",
};

const payload = canonicalizeGame(rawGame, league);
const full = assembleFullGame(payload);
const pointStats = buildPointStats(payload);

let db: Db;
const dirs: string[] = [];

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "synergy-query-"));
  dirs.push(dir);
  db = openDb(path.join(dir, "test.db"));
  recomputeBaselines(db, writeGameFacts(db, full, pointStats));
});

afterEach(async () => {
  db.close();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** The stored id for a display name, matched the way the query layer matches. */
function idOf(name: string): number {
  const key = normalizePlayerRef(name).name.toLowerCase();
  const id = playerIdFor(db, key);
  if (id === undefined) throw new Error(`no player recorded as ${name}`);
  return id;
}

/** Point ids where both players share a line, outside actors excluded. */
function sharedPointIds(idA: number, idB: number): number[] {
  return (
    db
      .prepare(
        `SELECT a.point_id AS point_id FROM appearances a
         JOIN appearances b ON b.point_id = a.point_id AND b.line = a.line
         WHERE a.player_id = ? AND b.player_id = ?
           AND a.line_changed = 0 AND b.line_changed = 0`,
      )
      .all(idA, idB) as Array<{ point_id: number }>
  ).map((row) => row.point_id);
}

function viewCount(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("fixture ground truth", () => {
  it("holds the captured game's known sizes", () => {
    const points = db.prepare("SELECT COUNT(*) AS n FROM points").get() as { n: number };
    const players = db.prepare("SELECT COUNT(*) AS n FROM players").get() as { n: number };
    expect(points.n).toBe(45);
    expect(players.n).toBe(22);
    expect(viewCount("pair_effects")).toBe(96);
    expect(viewCount("opponent_effects")).toBe(246);
  });
});

describe("pairLeaderboard", () => {
  it("excludes pairs below the minimum shared points", () => {
    const rows = pairLeaderboard(db, { minPoints: MIN_SHARED_POINTS });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.points_together as number).toBeGreaterThanOrEqual(MIN_SHARED_POINTS);
    }

    // Non-vacuous: the view really does hold pairs below the threshold.
    const below = db
      .prepare("SELECT COUNT(*) AS n FROM pair_effects WHERE points_together < ?")
      .get(MIN_SHARED_POINTS) as { n: number };
    expect(below.n).toBeGreaterThan(0);
    const all = pairLeaderboard(db, { minPoints: 1, limit: 1000 });
    expect(all.length).toBe(96);
    expect(all.length).toBeGreaterThan(rows.length);

    // A stricter threshold keeps only stronger pairs.
    const strict = pairLeaderboard(db, { minPoints: 20, limit: 1000 });
    expect(strict.length).toBeGreaterThan(0);
    expect(strict.length).toBeLessThan(all.length);
    for (const row of strict) expect(row.points_together as number).toBeGreaterThanOrEqual(20);
  });

  it("never returns an opponent pair as a teammate pair", () => {
    // Every returned pair has both players on the same line on at least one
    // point, recomputed from the raw appearances rather than trusted.
    const rows = pairLeaderboard(db, { minPoints: 1, limit: 1000 });
    expect(rows).toHaveLength(96); // every row of the view is checked
    for (const row of rows) {
      const shared = sharedPointIds(idOf(row.player_a as string), idOf(row.player_b as string));
      expect(shared.length).toBeGreaterThanOrEqual(1);
      expect(shared.length).toBe(row.points_together as number);
    }
  });

  it("orders by the shrunk delta", () => {
    const rows = pairLeaderboard(db, { minPoints: MIN_SHARED_POINTS, limit: 20 });
    expect(rows).toHaveLength(20);
    const deltas = rows.map((row) => row.a_shrunk_delta as number);
    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i]!).toBeLessThanOrEqual(deltas[i - 1]!);
    }

    const ascending = pairLeaderboard(db, {
      minPoints: MIN_SHARED_POINTS,
      limit: 20,
      order: "asc",
    });
    const ascDeltas = ascending.map((row) => row.a_shrunk_delta as number);
    for (let i = 1; i < ascDeltas.length; i++) {
      expect(ascDeltas[i]!).toBeGreaterThanOrEqual(ascDeltas[i - 1]!);
    }
  });

  it("sorts by the requested metric's column", () => {
    const rows = pairLeaderboard(db, { metric: "goals", minPoints: MIN_SHARED_POINTS, limit: 20 });
    const goals = rows.map((row) => row.a_goals_delta as number);
    for (let i = 1; i < goals.length; i++) {
      expect(goals[i]!).toBeLessThanOrEqual(goals[i - 1]!);
    }
  });

  it("falls back to the shrunk delta for an unknown metric", () => {
    // The metric name selects a column from a fixed map; anything else, up
    // to and including an injection attempt, behaves like the default and
    // leaves the store intact.
    const fallback = pairLeaderboard(db, { metric: "no such metric" });
    expect(fallback).toEqual(pairLeaderboard(db, {}));
    const injected = pairLeaderboard(db, { metric: "a_shrunk_delta; DROP TABLE players--" });
    expect(injected).toEqual(pairLeaderboard(db, {}));
    expect(viewCount("players")).toBe(22);
  });

  it("returns sample sizes with every row", () => {
    const rows = pairLeaderboard(db);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.points_together).toBeDefined();
      expect(typeof row.points_together).toBe("number");
      expect(row.a_shrunk_delta).toBeDefined();
    }
  });
});

describe("pairDetail", () => {
  it("finds the pair in either argument order", () => {
    const forward = pairDetail(db, "Eric Moore", "Geoff Solomon");
    const backward = pairDetail(db, "geoff solomon", "ERIC MOORE");
    expect(forward).toBeDefined();
    expect(backward).toEqual(forward);
    expect(forward!.points_together).toBe(23); // the fixture's most-shared pair
  });

  it("strips a terminal (S) from a name", () => {
    expect(pairDetail(db, "Geoff Solomon (S)", "Eric Moore (S)")).toEqual(
      pairDetail(db, "Eric Moore", "Geoff Solomon"),
    );
  });

  it("returns undefined for a pair that never shared a point", () => {
    expect(pairDetail(db, "Nobody At All", "Eric Moore")).toBeUndefined();
    expect(pairDetail(db, "Eric Moore", "Eric Moore")).toBeUndefined();
  });
});

describe("opponentEffects", () => {
  it("orders by affected delta ascending, most suppressing first", () => {
    const rows = opponentEffects(db, "Justin Ye");
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.affected_delta).toBeGreaterThanOrEqual(rows[i - 1]!.affected_delta);
    }
    for (const row of rows) {
      expect(row.points_against as number).toBeGreaterThanOrEqual(MIN_SHARED_POINTS);
    }
  });

  it("filters on points_against and applies the limit", () => {
    const all = opponentEffects(db, "Justin Ye", { minPoints: 1, limit: 1000 });
    const strict = opponentEffects(db, "Justin Ye", { minPoints: 30, limit: 1000 });
    expect(all.length).toBeGreaterThan(strict.length);
    for (const row of strict) expect(row.points_against as number).toBeGreaterThanOrEqual(30);

    const capped = opponentEffects(db, "Justin Ye", { limit: 3 });
    expect(capped).toHaveLength(3);
  });

  it("matches the player's name case-insensitively with a terminal (S) stripped", () => {
    expect(opponentEffects(db, "JUSTIN YE (S)")).toEqual(opponentEffects(db, "Justin Ye"));
  });

  it("returns an empty array for a player not in the store", () => {
    expect(opponentEffects(db, "Nobody At All")).toEqual([]);
  });
});

describe("playerProfile", () => {
  it("returns the player's baseline, teammate, and opponent rows", () => {
    const profile = playerProfile(db, "Justin Ye");
    expect(profile.baseline.length).toBeGreaterThan(0);
    for (const row of profile.baseline) {
      expect(typeof row.metric).toBe("string");
      expect(row.points).toBeGreaterThan(0);
    }
    expect(profile.teammates.length).toBeGreaterThan(0);
    for (const row of profile.teammates) {
      expect(row.player_a === "justin ye" || row.player_b === "justin ye").toBe(true);
    }
    expect(profile.opponents.length).toBeGreaterThan(0);
    for (const row of profile.opponents) {
      expect(row.player_id).toBe(idOf("Justin Ye"));
    }
  });

  it("returns empty arrays for a player not in the store", () => {
    expect(playerProfile(db, "Nobody At All")).toEqual({
      baseline: [],
      teammates: [],
      opponents: [],
    });
  });
});

/** The brief's risk predicate: a positive salary effect with a worse negative rate. */
function isRisky(pair: PairRow): boolean {
  const aRisky =
    (pair.a_delta as number) > 0 &&
    (pair.a_negative_rate_with_b as number) > (pair.a_negative_rate_baseline as number);
  const bRisky =
    (pair.b_delta as number) > 0 &&
    (pair.b_negative_rate_with_b as number) > (pair.b_negative_rate_baseline as number);
  return aRisky || bRisky;
}

describe("evaluateTeam", () => {
  it("flags a pair whose positive salary delta comes with a worse negative rate", () => {
    const result = evaluateTeam(db, ["Andrew Croisier", "Angela Mueller"]);
    expect(result.pairs.length).toBeGreaterThan(0);
    expect(result.players).toEqual(["Andrew Croisier", "Angela Mueller"]);
    for (const pair of result.riskyPairs) {
      const aRisky =
        (pair.a_delta as number) > 0 &&
        (pair.a_negative_rate_with_b as number) > (pair.a_negative_rate_baseline as number);
      const bRisky =
        (pair.b_delta as number) > 0 &&
        (pair.b_negative_rate_with_b as number) > (pair.b_negative_rate_baseline as number);
      expect(aRisky || bRisky).toBe(true);
    }
    // Exactly the risky pairs of the team, none missing and none extra.
    expect(result.riskyPairs).toEqual(result.pairs.filter(isRisky));

    // Non-vacuous: this pair is risky in the fixture (positive salary delta
    // for A with a negative rate above A's baseline), so a team of the two
    // must flag it.
    const flagged = evaluateTeam(db, ["Andrew Croisier", "Hadrian Mertins-Kirkwood"]);
    expect(flagged.pairs).toHaveLength(1);
    expect(flagged.riskyPairs).toHaveLength(1);
    expect(flagged.riskyPairs).toEqual(flagged.pairs.filter(isRisky));
  });

  it("reports a name that is not in the store", () => {
    const result = evaluateTeam(db, ["Andrew Croisier", "Nobody At All"]);
    expect(result.unknownPlayers).toContain("Nobody At All");
    expect(result.players).toEqual(["Andrew Croisier"]);
    expect(result.pairs).toEqual([]);
    expect(result.riskyPairs).toEqual([]);
    expect(result.teamTotalShrunkDelta).toBe(0);
  });

  it("finds every pair among the team regardless of the caller's order", () => {
    const names = [
      "Andrew Croisier",
      "Angela Mueller",
      "Eric Moore",
      "Geoff Solomon",
      "Jon Rowe",
      "Justin Ye",
    ];
    const forward = evaluateTeam(db, names);
    const reversed = evaluateTeam(db, [...names].reverse());
    expect(forward.unknownPlayers).toEqual([]);
    expect(reversed.unknownPlayers).toEqual([]);

    const keyPairs = (result: typeof forward): string[] =>
      result.pairs.map((row) => `${row.player_a}/${row.player_b}`).sort();
    expect(keyPairs(forward)).toEqual(keyPairs(reversed));
    expect(forward.pairs.length).toBeGreaterThan(0);

    // The fixture's most-shared pair is on the team and passes the threshold.
    const mostShared = forward.pairs.find(
      (row) => row.player_a === "eric moore" && row.player_b === "geoff solomon",
    );
    expect(mostShared).toBeDefined();
    expect(mostShared!.points_together).toBe(23);

    // Both members are team players on every returned pair.
    const keys = names.map((name) => normalizePlayerRef(name).name.toLowerCase());
    for (const row of forward.pairs) {
      expect(keys).toContain(row.player_a as string);
      expect(keys).toContain(row.player_b as string);
      expect(row.points_together as number).toBeGreaterThanOrEqual(MIN_SHARED_POINTS);
    }
  });

  it("sums the shrunk deltas of the returned pairs", () => {
    const result = evaluateTeam(db, ["Eric Moore", "Geoff Solomon", "Jon Rowe"]);
    const sum = result.pairs.reduce(
      (total, row) => total + (row.a_shrunk_delta as number) + (row.b_shrunk_delta as number),
      0,
    );
    expect(result.teamTotalShrunkDelta).toBeCloseTo(sum, 10);
  });
});
