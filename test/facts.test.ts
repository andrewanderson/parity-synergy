import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeGame, normalizePlayerRef } from "parity-mcp/data/normalize";
import { assembleFullGame, type FullGamePayload } from "parity-mcp/server";
import { buildPointStats, type PointStatsPayload } from "parity-mcp/engine/pointStats";
import type { ApiGame, ApiStatLine, GamePayload, SupportedLeague } from "parity-mcp/domain/types";
import { writeGameFacts } from "../src/store/facts.js";
import { recomputeBaselines, playerIdFor } from "../src/store/baselines.js";
import { reconcileSalary, reconcilePointStats } from "../src/verify/reconcile.js";
import { openDb, type Db } from "../src/store/db.js";

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

type BuiltGame = {
  payload: GamePayload;
  full: FullGamePayload;
  pointStats: PointStatsPayload;
};

function buildGame(
  raw: ApiGame,
  genderMap?: ReadonlyMap<string, boolean>,
): BuiltGame {
  const payload = canonicalizeGame(raw, league, genderMap);
  return {
    payload,
    full: assembleFullGame(payload),
    pointStats: buildPointStats(payload),
  };
}

/** The captured game under test: 45 points, 22 players, one outside actor. */
const fixture = buildGame(rawGame);

/** An all-zero stat line for synthetic games that never hit the API. */
const zeroStat = (): ApiStatLine => ({
  goals: 0,
  assists: 0,
  second_assists: 0,
  d_blocks: 0,
  completions: 0,
  throw_aways: 0,
  threw_drops: 0,
  catches: 0,
  drops: 0,
  pulls: 0,
  callahan: 0,
  o_points_for: 0,
  o_points_against: 0,
  d_points_for: 0,
  d_points_against: 0,
  points_played: 1,
  pay: 0,
  team: null,
});

function syntheticGame(
  fields: Partial<ApiGame> & Pick<ApiGame, "id" | "points">,
): ApiGame {
  return {
    league_id: 24,
    status: "final",
    week: 1,
    homeTeam: "Home Helmets",
    awayTeam: "Away Aces",
    homeRoster: [],
    awayRoster: [],
    homeScore: 0,
    awayScore: 0,
    stats: {},
    ...fields,
  };
}

/**
 * One point where "Quinn Fielder" is recorded on both rows and "Zero Player"
 * is a line player who never touches an event, so their salary is 0.
 */
const bothRowsRaw = syntheticGame({
  id: 999001,
  points: [
    {
      offensePlayers: ["Zero Player", "Quinn Fielder"],
      defensePlayers: ["Active Player", "Quinn Fielder"],
      events: [
        {
          type: "DEFENSE",
          firstActor: "Active Player",
          secondActor: null,
          timestamp: "3/15/2026, 10:00:00 AM",
        },
        {
          type: "PASS",
          firstActor: "Quinn Fielder",
          secondActor: "Active Player",
          timestamp: "3/15/2026, 10:00:05 AM",
        },
      ],
    },
  ],
  stats: { "Zero Player": zeroStat(), "Active Player": zeroStat() },
});
const bothRows = buildGame(bothRowsRaw);

/** A game that records the fixture's "Jon Rowe" in lower case only. */
const caseVariantRaw = syntheticGame({
  id: 999002,
  points: [
    {
      offensePlayers: ["jon rowe", "Casey Brook"],
      defensePlayers: ["Dana Defender"],
      events: [
        {
          type: "PASS",
          firstActor: "jon rowe",
          secondActor: "Casey Brook",
          timestamp: "3/15/2026, 11:00:00 AM",
        },
        {
          type: "POINT",
          firstActor: "Casey Brook",
          secondActor: null,
          timestamp: "3/15/2026, 11:00:10 AM",
        },
      ],
    },
  ],
});
const caseVariant = buildGame(caseVariantRaw);

/** A game that records the fixture's substitute "Alisha Zhao(S)" bare. */
const bareVariantRaw = syntheticGame({
  id: 999003,
  points: [
    {
      offensePlayers: ["Alisha Zhao"],
      defensePlayers: ["Casey Brook"],
      events: [
        {
          type: "PASS",
          firstActor: "Alisha Zhao",
          secondActor: "Casey Brook",
          timestamp: "3/15/2026, 12:00:00 PM",
        },
        {
          type: "POINT",
          firstActor: "Casey Brook",
          secondActor: null,
          timestamp: "3/15/2026, 12:00:10 PM",
        },
      ],
    },
  ],
});
const bareVariant = buildGame(bareVariantRaw);

/** Distinct (point, player) pairs over both recorded lines and event actors. */
function countDistinctAppearances(p: GamePayload): number {
  let count = 0;
  for (const point of p.game.points) {
    const keys = new Set<string>();
    for (const ref of [...point.offensePlayers, ...point.defensePlayers]) {
      keys.add(normalizePlayerRef(ref.raw).name.toLowerCase());
    }
    for (const event of point.events) {
      for (const actor of [event.firstActor, event.secondActor]) {
        if (actor !== null) keys.add(normalizePlayerRef(actor).name.toLowerCase());
      }
    }
    count += keys.size;
  }
  return count;
}

/**
 * Row counts of every fact table. `ingest_log` is deliberately absent: it is
 * an append-only record of ingest attempts, so a re-ingest adds a row by
 * design while no fact table may change.
 */
const FACT_TABLES = [
  "games",
  "points",
  "appearances",
  "appearance_metric",
  "salary_rule",
  "salary_components",
  "opponent_weight",
  "players",
  "player_baselines",
] as const;

function factCounts(db: Db): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of FACT_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    counts[table] = row.n;
  }
  return counts;
}

function pointIdFor(db: Db, gameId: number, pointNumber: number): number {
  const row = db
    .prepare(
      "SELECT point_id FROM points WHERE game_id = ? AND point_number = ?",
    )
    .get(gameId, pointNumber) as { point_id: number } | undefined;
  if (row === undefined) throw new Error(`no point ${pointNumber} in game ${gameId}`);
  return row.point_id;
}

function appearanceIds(db: Db, pointId: number, line: "offense" | "defense"): number[] {
  return (
    db
      .prepare(
        "SELECT player_id FROM appearances WHERE point_id = ? AND line = ? ORDER BY player_id",
      )
      .all(pointId, line) as Array<{ player_id: number }>
  ).map((row) => row.player_id);
}

function opponentIds(db: Db, pointId: number, playerId: number): number[] {
  return (
    db
      .prepare(
        "SELECT opponent_id FROM opponent_weight WHERE point_id = ? AND player_id = ? ORDER BY opponent_id",
      )
      .all(pointId, playerId) as Array<{ opponent_id: number }>
  ).map((row) => row.opponent_id);
}

let db: Db;
const dirs: string[] = [];

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "synergy-facts-"));
  dirs.push(dir);
  db = openDb(path.join(dir, "test.db"));
});

afterEach(async () => {
  db.close();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function writeFixture(): number[] {
  return writeGameFacts(db, fixture.full, fixture.pointStats);
}

describe("writeGameFacts", () => {
  it("writes one appearance row per player per point", () => {
    writeFixture();

    // 45 points x 12 line players, plus the one event actor recorded on
    // neither line (geoff solomon in point 24): 541 distinct (point, player)
    // pairs in the fixture.
    expect(countDistinctAppearances(fixture.payload)).toBe(541);
    const appearances = db.prepare("SELECT COUNT(*) AS n FROM appearances").get() as {
      n: number;
    };
    expect(appearances.n).toBe(541);

    // Grounding counts for the whole fixture write.
    const games = db.prepare("SELECT COUNT(*) AS n FROM games").get() as { n: number };
    const points = db.prepare("SELECT COUNT(*) AS n FROM points").get() as { n: number };
    const players = db.prepare("SELECT COUNT(*) AS n FROM players").get() as { n: number };
    expect(games.n).toBe(1);
    expect(points.n).toBe(45);
    expect(players.n).toBe(22);

    // Every appearance carries a salary metric; the ten stat metrics exist
    // only for the 271 appearances with at least one event (541 - 270
    // zero-touch appearances): 541 + 271 * 10 = 3251 rows.
    const metrics = db.prepare("SELECT COUNT(*) AS n FROM appearance_metric").get() as {
      n: number;
    };
    expect(metrics.n).toBe(3251);

    // Ledger-derived decompositions and opponent weights: 44 points x 6 x 6
    // x 2 directions, plus point 24 where the outside actor joins the
    // defence line (6 x 7 x 2): 3168 + 84 = 3252.
    const rules = db.prepare("SELECT COUNT(*) AS n FROM salary_rule").get() as { n: number };
    const components = db
      .prepare("SELECT COUNT(*) AS n FROM salary_components")
      .get() as { n: number };
    const weights = db.prepare("SELECT COUNT(*) AS n FROM opponent_weight").get() as {
      n: number;
    };
    expect(rules.n).toBe(895);
    expect(components.n).toBe(1048);
    expect(weights.n).toBe(3252);
  });

  it("writes a player who appears on both lines of a point exactly once", () => {
    writeGameFacts(db, bothRows.full, bothRows.pointStats);
    const quinnId = playerIdFor(db, "quinn fielder");
    expect(quinnId).toBeDefined();

    const pointId = pointIdFor(db, 999001, 1);
    const rows = db
      .prepare(
        "SELECT line FROM appearances WHERE point_id = ? AND player_id = ?",
      )
      .all(pointId, quinnId) as Array<{ line: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.line).toBe("offense");
  });

  it("gives a line player with no events an appearance row with zero salary", () => {
    const ids = writeGameFacts(db, bothRows.full, bothRows.pointStats);
    recomputeBaselines(db, ids);
    const zeroId = playerIdFor(db, "zero player");
    expect(zeroId).toBeDefined();

    const appearances = db
      .prepare("SELECT COUNT(*) AS n FROM appearances WHERE player_id = ?")
      .get(zeroId) as { n: number };
    expect(appearances.n).toBe(1);

    // Step 8 of the brief: every appearance gets a salary metric, 0 when the
    // player earned nothing on the point.
    const salary = db
      .prepare(
        "SELECT value FROM appearance_metric WHERE player_id = ? AND metric = 'salary'",
      )
      .get(zeroId) as { value: number } | undefined;
    expect(salary?.value).toBe(0);

    // No stat metric rows and no salary rule rows for a player with no events.
    const stats = db
      .prepare(
        "SELECT COUNT(*) AS n FROM appearance_metric WHERE player_id = ? AND metric <> 'salary'",
      )
      .get(zeroId) as { n: number };
    expect(stats.n).toBe(0);
    const ruleRows = db
      .prepare("SELECT COUNT(*) AS n FROM salary_rule WHERE player_id = ?")
      .get(zeroId) as { n: number };
    expect(ruleRows.n).toBe(0);

    // Only the salary baseline exists, and its mean is exactly 0.
    const baselines = db
      .prepare("SELECT metric, total, mean, points FROM player_baselines WHERE player_id = ?")
      .all(zeroId) as Array<{ metric: string; total: number; mean: number; points: number }>;
    expect(baselines).toHaveLength(1);
    expect(baselines[0]?.metric).toBe("salary");
    expect(baselines[0]?.total).toBe(0);
    expect(baselines[0]?.mean).toBe(0);
    expect(baselines[0]?.points).toBe(1);
  });

  it("makes the per-rule salary decomposition sum to the player's total salary", () => {
    writeFixture();

    // Every salary metric equals the sum of that player's rule rows on the
    // point; a missing rule would show up as a short sum.
    const rows = db
      .prepare(
        `SELECT am.point_id, am.player_id, am.value AS salary,
                COALESCE((
                  SELECT SUM(sr.amount) FROM salary_rule sr
                  WHERE sr.point_id = am.point_id AND sr.player_id = am.player_id
                ), 0) AS rules
         FROM appearance_metric am
         WHERE am.metric = 'salary'`,
      )
      .all() as Array<{ point_id: number; player_id: number; salary: number; rules: number }>;
    expect(rows).toHaveLength(541);
    for (const row of rows) {
      expect(row.rules).toBe(row.salary);
    }

    // And every rule group has a salary metric to reconcile against.
    const orphans = db
      .prepare(
        `SELECT COUNT(*) AS n FROM salary_rule sr
         WHERE NOT EXISTS (
           SELECT 1 FROM appearance_metric am
           WHERE am.point_id = sr.point_id AND am.player_id = sr.player_id
             AND am.metric = 'salary'
         )`,
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it("writes opponent weights that sum to 1 across the opposing line", () => {
    writeFixture();

    // Every appearance player has exactly one weight distribution.
    const groups = db
      .prepare(
        `SELECT ow.point_id, ow.player_id, SUM(ow.weight) AS weight_sum
         FROM opponent_weight ow
         GROUP BY ow.point_id, ow.player_id`,
      )
      .all() as Array<{ point_id: number; player_id: number; weight_sum: number }>;
    const appearances = db.prepare("SELECT COUNT(*) AS n FROM appearances").get() as {
      n: number;
    };
    expect(groups).toHaveLength(appearances.n);
    for (const group of groups) {
      expect(group.weight_sum).toBeCloseTo(1, 9);
    }

    // Under involvement weighting a zero-touch opponent carries weight 0,
    // never a share of the remainder. Equal weighting only applies when the
    // whole opposing side touched nothing, where every member shares alike.
    const nonZero = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM opponent_weight ow
         JOIN appearances a
           ON a.point_id = ow.point_id AND a.player_id = ow.opponent_id
         WHERE a.touches = 0 AND ow.weighting = 'involvement' AND ow.weight <> 0`,
      )
      .get() as { n: number };
    expect(nonZero.n).toBe(0);
  });

  it("is idempotent: writing the same game twice does not double any count", () => {
    const firstIds = writeFixture();
    recomputeBaselines(db, firstIds);
    const before = factCounts(db);

    const secondIds = writeFixture();
    recomputeBaselines(db, secondIds);
    const after = factCounts(db);

    expect(after).toEqual(before);
    expect(secondIds).toEqual(firstIds);
  });

  it("resolves a name that differs only by case to one player with one baseline", () => {
    recomputeBaselines(db, writeFixture());

    // The lower-case recording merges into the fixture's "Jon Rowe".
    const ids = writeGameFacts(db, caseVariant.full, caseVariant.pointStats);
    recomputeBaselines(db, ids);

    const players = db
      .prepare("SELECT player_id, name FROM players WHERE name_key = 'jon rowe'")
      .all() as Array<{ player_id: number; name: string }>;
    expect(players).toHaveLength(1);
    expect(players[0]?.name).toBe("Jon Rowe"); // first recording wins

    const playerId = players[0]?.player_id;
    const appearances = db
      .prepare("SELECT COUNT(*) AS n FROM appearances WHERE player_id = ?")
      .get(playerId) as { n: number };
    const baselines = db
      .prepare("SELECT points FROM player_baselines WHERE player_id = ? AND metric = 'salary'")
      .get(playerId) as { points: number } | undefined;
    expect(baselines?.points).toBe(appearances.n);

    const duplicateMetrics = db
      .prepare(
        `SELECT metric FROM player_baselines WHERE player_id = ?
         GROUP BY metric HAVING COUNT(*) > 1`,
      )
      .all(playerId);
    expect(duplicateMetrics).toHaveLength(0);
  });

  it("resolves a name carrying the (S) marker to the same player as the bare name", () => {
    recomputeBaselines(db, writeFixture());

    const ids = writeGameFacts(db, bareVariant.full, bareVariant.pointStats);
    recomputeBaselines(db, ids);

    const players = db
      .prepare("SELECT player_id, is_substitute FROM players WHERE name_key = 'alisha zhao'")
      .all() as Array<{ player_id: number; is_substitute: number }>;
    expect(players).toHaveLength(1);
    expect(players[0]?.is_substitute).toBe(1); // the fixture's (S) recording wins

    const playerId = players[0]?.player_id;
    const appearances = db
      .prepare("SELECT COUNT(*) AS n FROM appearances WHERE player_id = ?")
      .get(playerId) as { n: number };
    const baselines = db
      .prepare("SELECT points FROM player_baselines WHERE player_id = ? AND metric = 'salary'")
      .get(playerId) as { points: number } | undefined;
    expect(baselines?.points).toBe(appearances.n);
  });

  it("writes opponent weights in both directions", () => {
    writeFixture();

    const pointId = pointIdFor(db, 1000, 1);
    const offenseIds = appearanceIds(db, pointId, "offense");
    const defenseIds = appearanceIds(db, pointId, "defense");
    expect(offenseIds).toHaveLength(6);
    expect(defenseIds).toHaveLength(6);

    // Each offense player's opponents are exactly the defence line, and each
    // defence player's opponents are exactly the offense line.
    for (const playerId of offenseIds) {
      expect(opponentIds(db, pointId, playerId)).toEqual(defenseIds);
    }
    for (const playerId of defenseIds) {
      expect(opponentIds(db, pointId, playerId)).toEqual(offenseIds);
    }
  });

  it("gives an event actor outside both lines an appearance row with their salary", () => {
    writeFixture();
    const geoffId = playerIdFor(db, "geoff solomon");
    expect(geoffId).toBeDefined();

    // Point 24 is the fixture's only point with an actor on neither line.
    const pointId = pointIdFor(db, 1000, 24);
    const appearance = db
      .prepare(
        "SELECT line, line_changed FROM appearances WHERE point_id = ? AND player_id = ?",
      )
      .get(pointId, geoffId) as { line: string; line_changed: number };
    expect(appearance.line).toBe("defense");
    expect(appearance.line_changed).toBe(1);

    // Their salary metric on that point equals the ledger total for it.
    const salary = db
      .prepare(
        "SELECT value FROM appearance_metric WHERE point_id = ? AND player_id = ? AND metric = 'salary'",
      )
      .get(pointId, geoffId) as { value: number };
    const ledgerPoint = fixture.full.salaryLedger.points.find(
      (point) => point.pointNumber === 24,
    );
    const ledgerTotal = ledgerPoint?.playerSalaries.find(
      (entry) => entry.name.toLowerCase() === "geoff solomon",
    )?.total;
    expect(salary.value).toBe(ledgerTotal);
    expect(salary.value).toBe(9000);

    // Across the whole game his salary metrics sum to his ledger total,
    // which the salary gate compares against the API's reported pay.
    const gameSalary = db
      .prepare(
        "SELECT SUM(value) AS n FROM appearance_metric WHERE player_id = ? AND metric = 'salary'",
      )
      .get(geoffId) as { n: number };
    expect(gameSalary.n).toBe(101500);

    // Opponent pairs run in both directions against the offense line, the
    // line he was playing against, and never against the defence line he
    // was assigned to (they are his own side, not his opponents).
    const offenseIds = appearanceIds(db, pointId, "offense");
    const defenseIds = appearanceIds(db, pointId, "defense");
    expect(defenseIds).toContain(geoffId);
    expect(opponentIds(db, pointId, geoffId)).toEqual(offenseIds);
    for (const playerId of offenseIds) {
      expect(opponentIds(db, pointId, playerId)).toContain(geoffId);
    }
    const defensePeers = defenseIds.filter((id) => id !== geoffId);
    const pairedWithPeer = db
      .prepare(
        `SELECT COUNT(*) AS n FROM opponent_weight
         WHERE point_id = ?
           AND ((player_id = ? AND opponent_id IN (${defensePeers.map(() => "?").join(",")}))
             OR (opponent_id = ? AND player_id IN (${defensePeers.map(() => "?").join(",")})))`,
      )
      .get(
        pointId,
        geoffId,
        ...defensePeers,
        geoffId,
        ...defensePeers,
      ) as { n: number };
    expect(pairedWithPeer.n).toBe(0);
  });

  it("writes a player's division on first creation and leaves it alone afterwards", () => {
    const withDivision = buildGame(
      rawGame,
      new Map([
        ["jon rowe", true],
        ["geoff solomon", false],
      ]),
    );
    writeGameFacts(db, withDivision.full, withDivision.pointStats);

    const divisionOf = (nameKey: string): string | null => {
      const row = db
        .prepare("SELECT division FROM players WHERE name_key = ?")
        .get(nameKey) as { division: string | null } | undefined;
      return row?.division ?? null;
    };

    expect(divisionOf("jon rowe")).toBe("open");
    expect(divisionOf("geoff solomon")).toBe("women");
    expect(divisionOf("justin ye")).toBeNull();

    // A later ingest with no teams source must not overwrite known values.
    writeFixture();
    expect(divisionOf("jon rowe")).toBe("open");
    expect(divisionOf("geoff solomon")).toBe("women");
    expect(divisionOf("justin ye")).toBeNull();

    // A later ingest that knows a division must not fill in one recorded as
    // unknown: division is written only when the player row is created.
    const laterKnown = buildGame(rawGame, new Map([["justin ye", true]]));
    writeGameFacts(db, laterKnown.full, laterKnown.pointStats);
    expect(divisionOf("justin ye")).toBeNull();
    expect(divisionOf("jon rowe")).toBe("open");
    expect(divisionOf("geoff solomon")).toBe("women");
  });
});

describe("recomputeBaselines", () => {
  it("sets mean exactly equal to total / points", () => {
    const ids = writeFixture();
    recomputeBaselines(db, ids);

    const rows = db
      .prepare("SELECT metric, points, total, mean FROM player_baselines")
      .all() as Array<{ metric: string; points: number; total: number; mean: number }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.points).toBeGreaterThan(0);
      expect(row.mean).toBe(row.total / row.points);
    }
  });

  it("counts a player on both lines of one point once in the baseline", () => {
    const ids = writeGameFacts(db, bothRows.full, bothRows.pointStats);
    recomputeBaselines(db, ids);
    const quinnId = playerIdFor(db, "quinn fielder");
    expect(quinnId).toBeDefined();

    const appearances = db
      .prepare("SELECT COUNT(*) AS n FROM appearances WHERE player_id = ?")
      .get(quinnId) as { n: number };
    expect(appearances.n).toBe(1);

    const baselines = db
      .prepare("SELECT points FROM player_baselines WHERE player_id = ?")
      .all(quinnId) as Array<{ points: number }>;
    expect(baselines.length).toBeGreaterThan(0);
    for (const row of baselines) {
      expect(row.points).toBe(1);
    }
  });

  it("writes a baseline row per salary rule", () => {
    const ids = writeFixture();
    recomputeBaselines(db, ids);

    for (const rule of ["HOLD", "BREAK", "GOAL", "DEFENSE"]) {
      const sums = db
        .prepare(
          "SELECT player_id, SUM(amount) AS total FROM salary_rule WHERE rule_name = ? GROUP BY player_id",
        )
        .all(rule) as Array<{ player_id: number; total: number }>;
      expect(sums.length).toBeGreaterThan(0);
      for (const sum of sums) {
        const baseline = db
          .prepare(
            "SELECT points, total, mean FROM player_baselines WHERE player_id = ? AND metric = ?",
          )
          .get(sum.player_id, `salary:${rule}`) as
          | { points: number; total: number; mean: number }
          | undefined;
        expect(baseline).toBeDefined();
        if (baseline === undefined) continue;
        expect(baseline.total).toBe(sum.total);
        expect(baseline.mean).toBe(sum.total / baseline.points);
      }
    }
  });
});

describe("reconcile", () => {
  it("passes the salary gate for every stats player in the fixture", () => {
    expect(fixture.payload.stats).toHaveLength(22);
    expect(reconcileSalary(fixture.payload, fixture.full.salaryLedger)).toEqual({
      ok: true,
    });
  });

  it("rejects a stats player whose reported pay does not match the ledger", () => {
    const tampered = structuredClone(fixture.payload);
    tampered.stats[0]!.pay += 1;
    const result = reconcileSalary(tampered, fixture.full.salaryLedger);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("does not match API pay");
    }
  });

  it("passes the point-stats gate for the fixture", () => {
    expect(reconcilePointStats(fixture.payload, fixture.pointStats)).toEqual({
      ok: true,
    });
  });
});
