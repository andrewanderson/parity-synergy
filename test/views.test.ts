import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeGame } from "parity-mcp/data/normalize";
import { assembleFullGame } from "parity-mcp/server";
import { buildPointStats } from "parity-mcp/engine/pointStats";
import type { ApiGame, SupportedLeague } from "parity-mcp/domain/types";
import { writeGameFacts } from "../src/store/facts.js";
import { playerIdFor, recomputeBaselines, upsertPlayer } from "../src/store/baselines.js";
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

const payload = canonicalizeGame(rawGame, league);
const full = assembleFullGame(payload);
const pointStats = buildPointStats(payload);

/** One row of the `pair_effects` view, as the store reports it. */
type PairRow = {
  player_a: string;
  player_b: string;
  player_a_name: string;
  player_b_name: string;
  points_together: number;
  a_salary_with_b: number;
  a_baseline: number;
  a_delta: number;
  b_salary_with_b: number;
  b_baseline: number;
  b_delta: number;
  a_shrunk_delta: number;
  b_shrunk_delta: number;
  a_negative_rate_with_b: number;
  a_negative_rate_baseline: number;
  b_negative_rate_with_b: number;
  b_negative_rate_baseline: number;
  a_goals_delta: number;
  b_goals_delta: number;
  a_assists_delta: number;
  b_assists_delta: number;
  a_drops_delta: number;
  b_drops_delta: number;
  a_throw_aways_delta: number;
  b_throw_aways_delta: number;
  a_threw_drops_delta: number;
  b_threw_drops_delta: number;
  a_second_assists_delta: number;
  b_second_assists_delta: number;
  a_d_blocks_delta: number;
  b_d_blocks_delta: number;
  a_completions_delta: number;
  b_completions_delta: number;
  a_catches_delta: number;
  b_catches_delta: number;
  a_pulls_delta: number;
  b_pulls_delta: number;
  a_hold_delta: number;
  b_hold_delta: number;
  a_break_delta: number;
  b_break_delta: number;
  a_goal_delta: number;
  b_goal_delta: number;
  a_defense_delta: number;
  b_defense_delta: number;
  first_game_id: number;
  last_game_id: number;
};

/** One row of the `opponent_effects` view, as the store reports it. */
type OpponentRow = {
  player_id: number;
  opponent_id: number;
  player_name: string;
  opponent_name: string;
  points_against: number;
  affected_delta: number;
  total_credit: number;
  weighted_points: number;
  goal_delta: number;
  assist_delta: number;
  second_assist_delta: number;
  defense_delta: number;
  hold_delta: number;
  break_delta: number;
  throw_away_delta: number;
  completion_delta: number;
  catch_delta: number;
  drop_delta: number;
  threw_drop_delta: number;
};

type BaselineRow = { points: number; total: number; mean: number };

let db: Db;
const dirs: string[] = [];

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "synergy-views-"));
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

function idOf(nameKey: string): number {
  const id = playerIdFor(db, nameKey);
  if (id === undefined) throw new Error(`no player recorded as ${nameKey}`);
  return id;
}

function pointIdFor(gameId: number, pointNumber: number): number {
  const row = db
    .prepare("SELECT point_id FROM points WHERE game_id = ? AND point_number = ?")
    .get(gameId, pointNumber) as { point_id: number } | undefined;
  if (row === undefined) throw new Error(`no point ${pointNumber} in game ${gameId}`);
  return row.point_id;
}

/** The view row for the teammate pair, whichever way round the keys were passed. */
function pairRow(keyA: string, keyB: string): PairRow | undefined {
  return db
    .prepare(
      `SELECT * FROM pair_effects
       WHERE (player_a = ? AND player_b = ?) OR (player_a = ? AND player_b = ?)`,
    )
    .get(keyA, keyB, keyB, keyA) as PairRow | undefined;
}

function teammateRowCount(idA: number, idB: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pair_effects pe
       JOIN players pa ON pa.name_key = pe.player_a
       JOIN players pb ON pb.name_key = pe.player_b
       WHERE (pa.player_id = ? AND pb.player_id = ?) OR (pa.player_id = ? AND pb.player_id = ?)`,
    )
    .get(idA, idB, idB, idA) as { n: number };
  return row.n;
}

function opponentRowById(idA: number, idB: number): OpponentRow | undefined {
  return db
    .prepare("SELECT * FROM opponent_effects WHERE player_id = ? AND opponent_id = ?")
    .get(idA, idB) as OpponentRow | undefined;
}

function baselineRow(playerId: number, metric: string): BaselineRow | undefined {
  return db
    .prepare("SELECT points, total, mean FROM player_baselines WHERE player_id = ? AND metric = ?")
    .get(playerId, metric) as BaselineRow | undefined;
}

/** The player's mean for a metric, 0 when they have no facts for it. */
function baselineMean(playerId: number, metric: string): number {
  return baselineRow(playerId, metric)?.mean ?? 0;
}

function baselineTotal(playerId: number, metric: string): number {
  return baselineRow(playerId, metric)?.total ?? 0;
}

/** The player's appearance count, carried by every baseline row. */
function baselinePoints(playerId: number): number {
  const row = baselineRow(playerId, "salary");
  if (row === undefined) throw new Error(`player ${playerId} has no salary baseline`);
  return row.points;
}

/**
 * Point ids where both players have an appearance on the same line, with
 * outside-line actors (line_changed = 1) excluded: the teammate relation.
 */
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

/** Point ids where both players appear on the same line, outside actor or not. */
function rawSameLinePointIds(idA: number, idB: number): number[] {
  return (
    db
      .prepare(
        `SELECT a.point_id AS point_id FROM appearances a
         JOIN appearances b ON b.point_id = a.point_id AND b.line = a.line
         WHERE a.player_id = ? AND b.player_id = ?`,
      )
      .all(idA, idB) as Array<{ point_id: number }>
  ).map((row) => row.point_id);
}

/** Points where the affected player faced the opponent, with the stored weight. */
function opponentPoints(idA: number, idB: number): Array<{ point_id: number; weight: number }> {
  return db
    .prepare(
      `SELECT point_id, weight FROM opponent_weight
       WHERE player_id = ? AND opponent_id = ? ORDER BY point_id`,
    )
    .all(idA, idB) as Array<{ point_id: number; weight: number }>;
}

/** The player's metric value on one point, 0 when no such fact exists. */
function metricValue(pointId: number, playerId: number, metric: string): number {
  const row = db
    .prepare(
      "SELECT value FROM appearance_metric WHERE point_id = ? AND player_id = ? AND metric = ?",
    )
    .get(pointId, playerId, metric) as { value: number } | undefined;
  return row?.value ?? 0;
}

/** The player's summed salary-rule amount on one point, 0 when absent. */
function ruleAmount(pointId: number, playerId: number, ruleName: string): number {
  const row = db
    .prepare(
      "SELECT amount FROM salary_rule WHERE point_id = ? AND player_id = ? AND rule_name = ?",
    )
    .get(pointId, playerId, ruleName) as { amount: number } | undefined;
  return row?.amount ?? 0;
}

/** The player's recorded touches on one point. */
function touchesOn(pointId: number, playerId: number): number {
  const row = db
    .prepare("SELECT touches FROM appearances WHERE point_id = ? AND player_id = ?")
    .get(pointId, playerId) as { touches: number } | undefined;
  if (row === undefined) throw new Error(`player ${playerId} has no appearance on point ${pointId}`);
  return row.touches;
}

/** Sum a metric over a fixed set of points, in TypeScript. */
function sumMetric(pointIds: number[], playerId: number, metric: string): number {
  let sum = 0;
  for (const pointId of pointIds) sum += metricValue(pointId, playerId, metric);
  return sum;
}

/** Sum a salary rule over a fixed set of points, in TypeScript. */
function sumRule(pointIds: number[], playerId: number, ruleName: string): number {
  let sum = 0;
  for (const pointId of pointIds) sum += ruleAmount(pointId, playerId, ruleName);
  return sum;
}

describe("pair_effects view", () => {
  it("never pairs a player with themselves", () => {
    const selfPairs = db
      .prepare("SELECT COUNT(*) AS n FROM pair_effects WHERE player_a = player_b")
      .get() as { n: number };
    expect(selfPairs.n).toBe(0);

    const total = db.prepare("SELECT COUNT(*) AS n FROM pair_effects").get() as { n: number };
    expect(total.n).toBeGreaterThan(0);
  });

  it("orders player_a before player_b by name_key", () => {
    // Every row's player_a is the lower name_key, so the per-member columns
    // always describe the player the column names say they do.
    const unordered = db
      .prepare("SELECT COUNT(*) AS n FROM pair_effects WHERE player_a >= player_b")
      .get() as { n: number };
    expect(unordered.n).toBe(0);

    // The fixture contains pairs whose id order disagrees with the name_key
    // order, so this assertion exercises the swap rather than passing by luck.
    const reversed = db
      .prepare(
        `SELECT COUNT(*) AS n FROM pair_effects pe
         JOIN players pa ON pa.name_key = pe.player_a
         JOIN players pb ON pb.name_key = pe.player_b
         WHERE pa.player_id > pb.player_id`,
      )
      .get() as { n: number };
    expect(reversed.n).toBeGreaterThan(0);
  });

  it("counts every shared point once, regardless of line type", () => {
    const rows = db
      .prepare(
        `SELECT * FROM pair_effects
         WHERE (player_a = 'eric moore' AND player_b = 'jon rowe')
            OR (player_a = 'jon rowe' AND player_b = 'eric moore')`,
      )
      .all() as PairRow[];
    expect(rows).toHaveLength(1); // one blended row, not one per line type
    const row = rows[0]!;

    const shared = sharedPointIds(idOf("eric moore"), idOf("jon rowe"));
    expect(shared).toHaveLength(23);
    expect(row.points_together).toBe(shared.length);

    // The shared points really do span both line types, so the count is a
    // blend rather than a same-line count that happens to coincide.
    const lines = new Set(
      (
        db
          .prepare(
            `SELECT a.line AS line FROM appearances a
             JOIN appearances b ON b.point_id = a.point_id AND b.line = a.line
             WHERE a.player_id = ? AND b.player_id = ?
               AND a.line_changed = 0 AND b.line_changed = 0`,
          )
          .all(idOf("eric moore"), idOf("jon rowe")) as Array<{ line: string }>
      ).map((r) => r.line),
    );
    expect(lines).toEqual(new Set(["offense", "defense"]));

    // One game in the fixture, so every shared point belongs to it.
    expect(row.first_game_id).toBe(1000);
    expect(row.last_game_id).toBe(1000);
  });

  it("computes delta as actual minus baseline times points", () => {
    const rows = db.prepare("SELECT * FROM pair_effects").all() as PairRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.a_delta).toBe(row.a_salary_with_b - row.a_baseline * row.points_together);
      expect(row.b_delta).toBe(row.b_salary_with_b - row.b_baseline * row.points_together);
    }
  });

  it("applies the shrinkage factor n / (n + 8)", () => {
    const rows = db.prepare("SELECT * FROM pair_effects").all() as PairRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.a_shrunk_delta).toBe(
        (row.a_delta * row.points_together) / (row.points_together + 8),
      );
      expect(row.b_shrunk_delta).toBe(
        (row.b_delta * row.points_together) / (row.points_together + 8),
      );
    }
  });

  it("matches a full recomputation from raw facts", () => {
    // The pair whose id order (7 < 13) disagrees with its name_key order
    // ('catherine desloges' < 'chelsea roesler'), so the a_/b_ columns must
    // belong to catherine even though the raw pair lists chelsea first.
    const row = pairRow("catherine desloges", "chelsea roesler");
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.player_a).toBe("catherine desloges");
    expect(row.player_b).toBe("chelsea roesler");
    expect(row.player_a_name).toBe("Catherine Desloges");
    expect(row.player_b_name).toBe("Chelsea Roesler");

    const aId = idOf("catherine desloges");
    const bId = idOf("chelsea roesler");
    const shared = sharedPointIds(aId, bId);
    expect(shared).toHaveLength(22);
    expect(row.points_together).toBe(shared.length);

    // Salary: summed over the shared points, against the stored mean.
    const aSalary = sumMetric(shared, aId, "salary");
    expect(row.a_salary_with_b).toBe(aSalary);
    expect(row.a_baseline).toBe(baselineRow(aId, "salary")!.mean);
    expect(row.a_delta).toBe(aSalary - baselineMean(aId, "salary") * shared.length);
    expect(row.a_shrunk_delta).toBe(
      ((aSalary - baselineMean(aId, "salary") * shared.length) * shared.length) /
        (shared.length + 8),
    );

    const bSalary = sumMetric(shared, bId, "salary");
    expect(row.b_salary_with_b).toBe(bSalary);
    expect(row.b_baseline).toBe(baselineRow(bId, "salary")!.mean);
    expect(row.b_delta).toBe(bSalary - baselineMean(bId, "salary") * shared.length);
    expect(row.b_shrunk_delta).toBe(
      ((bSalary - baselineMean(bId, "salary") * shared.length) * shared.length) /
        (shared.length + 8),
    );

    // Statistic deltas: raw counts minus baseline mean times shared points.
    expect(row.a_goals_delta).toBe(
      sumMetric(shared, aId, "goals") - baselineMean(aId, "goals") * shared.length,
    );
    expect(row.b_goals_delta).toBe(
      sumMetric(shared, bId, "goals") - baselineMean(bId, "goals") * shared.length,
    );

    // The five statistics the design's metric list needs and the view did
    // not have: the same recomputation, per member, so a swapped a_/b_
    // column cannot pass here.
    for (const metric of ["second_assists", "d_blocks", "completions", "catches", "pulls"]) {
      expect(row[`a_${metric}_delta` as keyof PairRow]).toBe(
        sumMetric(shared, aId, metric) - baselineMean(aId, metric) * shared.length,
      );
      expect(row[`b_${metric}_delta` as keyof PairRow]).toBe(
        sumMetric(shared, bId, metric) - baselineMean(bId, metric) * shared.length,
      );
    }

    // Rule deltas: salary-rule units, the synergy signal.
    expect(row.a_hold_delta).toBe(
      sumRule(shared, aId, "HOLD") - baselineMean(aId, "salary:HOLD") * shared.length,
    );
    expect(row.b_hold_delta).toBe(
      sumRule(shared, bId, "HOLD") - baselineMean(bId, "salary:HOLD") * shared.length,
    );
    expect(row.a_goal_delta).toBe(
      sumRule(shared, aId, "GOAL") - baselineMean(aId, "salary:GOAL") * shared.length,
    );
    expect(row.b_break_delta).toBe(
      sumRule(shared, bId, "BREAK") - baselineMean(bId, "salary:BREAK") * shared.length,
    );

    // Negative rate with the partner, over the shared points.
    const aNegative = ["drops", "throw_aways", "threw_drops"].reduce(
      (sum, metric) => sum + sumMetric(shared, aId, metric),
      0,
    );
    expect(row.a_negative_rate_with_b).toBe(aNegative / shared.length);
    const bNegative = ["drops", "throw_aways", "threw_drops"].reduce(
      (sum, metric) => sum + sumMetric(shared, bId, metric),
      0,
    );
    expect(row.b_negative_rate_with_b).toBe(bNegative / shared.length);

    // Negative rate baseline: all-time negative events over all appearances.
    const aNegativeTotal = ["drops", "throw_aways", "threw_drops"].reduce(
      (sum, metric) => sum + baselineTotal(aId, metric),
      0,
    );
    expect(row.a_negative_rate_baseline).toBe(aNegativeTotal / baselinePoints(aId));
    const bNegativeTotal = ["drops", "throw_aways", "threw_drops"].reduce(
      (sum, metric) => sum + baselineTotal(bId, metric),
      0,
    );
    expect(row.b_negative_rate_baseline).toBe(bNegativeTotal / baselinePoints(bId));
  });

  it("forms no teammate pairs for an outside-line actor's point", () => {
    // Geoff Solomon is the fixture's only event actor outside both recorded
    // lines: at point 24 his resolved team is that point's offence team, so
    // he gets an offense appearance with line_changed = 1. The six offence
    // players recorded on the point are his same-line co-appearances, but
    // the teammate join requires line_changed = 0 on both sides, so point
    // 24 never becomes a teammate point for any of them.
    const geoffId = idOf("geoff solomon");
    const point24 = pointIdFor(1000, 24);
    const peers = db
      .prepare(
        `SELECT pl.player_id AS player_id, pl.name_key AS name_key FROM appearances a
         JOIN points p ON p.point_id = a.point_id
         JOIN players pl ON pl.player_id = a.player_id
         WHERE p.point_number = 24 AND a.line = 'offense' AND a.line_changed = 0`,
      )
      .all() as Array<{ player_id: number; name_key: string }>;
    expect(peers).toHaveLength(6);

    let excluded = 0;
    for (const peer of peers) {
      const shared = sharedPointIds(geoffId, peer.player_id);
      expect(rawSameLinePointIds(geoffId, peer.player_id)).toContain(point24);
      const row = pairRow("geoff solomon", peer.name_key);
      if (shared.length === 0) {
        // Point 24 is the only point they ever shared a line on, so without
        // the exclusion each of these would be a one-point teammate pair
        // built solely from the outside-actor row.
        expect(rawSameLinePointIds(geoffId, peer.player_id)).toEqual([point24]);
        expect(row).toBeUndefined();
        excluded += 1;
      } else {
        expect(row).toBeDefined();
        expect(row!.points_together).toBe(shared.length);
      }
    }
    expect(excluded).toBe(3); // non-vacuous: three of the six really are excluded

    // The exclusion is specific to the outside-actor row: Geoff still forms
    // teammate pairs on his ordinary line points.
    const ericId = idOf("eric moore");
    expect(sharedPointIds(geoffId, ericId)).toHaveLength(23);
    expect(teammateRowCount(geoffId, ericId)).toBe(1);
    expect(pairRow("eric moore", "geoff solomon")!.points_together).toBe(23);
  });
});

describe("opponent_effects view", () => {
  it("never pairs a player with themselves", () => {
    const selfPairs = db
      .prepare("SELECT COUNT(*) AS n FROM opponent_effects WHERE player_id = opponent_id")
      .get() as { n: number };
    expect(selfPairs.n).toBe(0);

    const total = db.prepare("SELECT COUNT(*) AS n FROM opponent_effects").get() as { n: number };
    expect(total.n).toBeGreaterThan(0);
  });

  it("computes affected_delta as total credit over weighted points", () => {
    const rows = db.prepare("SELECT * FROM opponent_effects").all() as OpponentRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.weighted_points === 0) {
        // A pair whose opponent never touched the disc on any shared point:
        // no weight, no credit, and a guarded zero rather than a division by
        // zero.
        expect(row.affected_delta).toBe(0);
        expect(row.total_credit).toBe(0);
      } else {
        expect(row.affected_delta).toBe(row.total_credit / row.weighted_points);
      }
    }

    // The fixture holds no naturally zero-weight pair, so build one:
    // zeroing every weight of one directed pair leaves both terms of the
    // ratio at 0, which is the case the guard exists for.
    const pair = db
      .prepare(
        `SELECT player_id, opponent_id FROM opponent_weight
         GROUP BY player_id, opponent_id ORDER BY COUNT(*) DESC, player_id LIMIT 1`,
      )
      .get() as { player_id: number; opponent_id: number };
    db.prepare("UPDATE opponent_weight SET weight = 0 WHERE player_id = ? AND opponent_id = ?").run(
      pair.player_id,
      pair.opponent_id,
    );
    const built = db
      .prepare("SELECT * FROM opponent_effects WHERE player_id = ? AND opponent_id = ?")
      .get(pair.player_id, pair.opponent_id) as OpponentRow;
    expect(built.weighted_points).toBe(0);
    expect(built.total_credit).toBe(0);
    expect(built.affected_delta).toBe(0);
  });

  it("matches a full recomputation from raw facts", () => {
    const justinId = idOf("justin ye");
    const gabeId = idOf("gabe senecal");
    const row = opponentRowById(justinId, gabeId);
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.player_name).toBe("Justin Ye");
    expect(row.opponent_name).toBe("Gabe Senecal");

    const points = opponentPoints(justinId, gabeId);
    expect(points).toHaveLength(14);
    expect(row.points_against).toBe(points.length);

    // Credit: residual (actual - baseline) times the stored weight, summed.
    const salaryMean = baselineRow(justinId, "salary")!.mean;
    expect(row.weighted_points).toBeCloseTo(
      points.reduce((sum, p) => sum + p.weight, 0),
      6,
    );
    const totalCredit = points.reduce(
      (sum, p) => sum + (metricValue(p.point_id, justinId, "salary") - salaryMean) * p.weight,
      0,
    );
    expect(row.total_credit).toBeCloseTo(totalCredit, 6);
    expect(row.affected_delta).toBeCloseTo(totalCredit / row.weighted_points, 6);

    // The per-rule breakdown: (weighted rule amount minus the rule's mean
    // charged on every weighted point) divided by the weighted points, so
    // each column is credit per weighted point like the headline.
    const weightedPoints = points.reduce((sum, p) => sum + p.weight, 0);
    const ruleDelta = (ruleName: string): number => {
      const weightedAmount = points.reduce(
        (sum, p) => sum + ruleAmount(p.point_id, justinId, ruleName) * p.weight,
        0,
      );
      return (
        (weightedAmount - baselineMean(justinId, `salary:${ruleName}`) * weightedPoints) /
        weightedPoints
      );
    };
    expect(row.goal_delta).toBeCloseTo(ruleDelta("GOAL"), 6);
    expect(row.hold_delta).toBeCloseTo(ruleDelta("HOLD"), 6);
    expect(row.throw_away_delta).toBeCloseTo(ruleDelta("THROWAWAY"), 6);
    expect(row.drop_delta).toBeCloseTo(ruleDelta("DROP"), 6);
    expect(row.assist_delta).toBeCloseTo(ruleDelta("ASSIST"), 6);
    expect(row.second_assist_delta).toBeCloseTo(ruleDelta("SECOND_ASSIST"), 6);
    expect(row.completion_delta).toBeCloseTo(ruleDelta("COMPLETION"), 6);
    expect(row.catch_delta).toBeCloseTo(ruleDelta("CATCH"), 6);
    expect(row.threw_drop_delta).toBeCloseTo(ruleDelta("THREW_DROP"), 6);
    expect(row.defense_delta).toBeCloseTo(ruleDelta("DEFENSE"), 6);
    expect(row.break_delta).toBeCloseTo(ruleDelta("BREAK"), 6);
  });

  it("adds the eleven rule columns up to the headline on every row", () => {
    // The printed report must reconcile by hand: the rule columns and the
    // headline are all credit per weighted point, and the eleven salary
    // rules partition the salary metric, so they sum to it. A rule left
    // out of the view, or one column left in salary units, breaks this.
    const rules = [
      "goal",
      "assist",
      "second_assist",
      "defense",
      "hold",
      "break",
      "throw_away",
      "completion",
      "catch",
      "drop",
      "threw_drop",
    ];
    const rows = db.prepare("SELECT * FROM opponent_effects").all() as Array<
      Record<string, number>
    >;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const sum = rules.reduce((total, rule) => total + row[`${rule}_delta`], 0);
      expect(sum).toBeCloseTo(row.affected_delta, 4);
      if (row.weighted_points === 0) {
        expect(row.affected_delta).toBe(0);
        for (const rule of rules) expect(row[`${rule}_delta`]).toBe(0);
      }
    }

    // Non-vacuous: the breakdown is a real share of the credit rather than
    // a rounding of it, so the sum above is not trivially satisfied.
    const withCredit = rows.filter((row) => row.weighted_points > 0);
    expect(withCredit.length).toBeGreaterThan(0);
  });

  it("gives a negative affected_delta when the opponent suppressed the player", () => {
    // Justin Ye earned far less salary than his baseline when Gabe Senecal
    // was on the other line, so the credit is negative and the sign carries
    // through the ratio.
    const row = opponentRowById(idOf("justin ye"), idOf("gabe senecal"));
    expect(row).toBeDefined();
    expect(row!.total_credit).toBeLessThan(0);
    expect(row!.affected_delta).toBeLessThan(0);

    // Sign convention across every row: the ratio never disagrees with the
    // signed sum it divides.
    const rows = db
      .prepare("SELECT * FROM opponent_effects WHERE weighted_points > 0")
      .all() as OpponentRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Math.sign(r.affected_delta)).toBe(Math.sign(r.total_credit));
    }
  });

  it("gives a zero-touch opponent a weight of zero, not a share of the remainder", () => {
    // Under involvement weighting a zero-touch opponent divides by the
    // side's full touch total and receives exactly 0. (When the whole
    // opposing line touched nothing the weight splits equally instead, which
    // the next test covers.)
    const violations = db
      .prepare(
        `SELECT COUNT(*) AS n FROM opponent_weight ow
         JOIN appearances a ON a.point_id = ow.point_id AND a.player_id = ow.opponent_id
         WHERE ow.weighting = 'involvement' AND a.touches = 0 AND ow.weight <> 0`,
      )
      .get() as { n: number };
    expect(violations.n).toBe(0);

    const zeroTouch = db
      .prepare(
        `SELECT COUNT(*) AS n FROM opponent_weight ow
         JOIN appearances a ON a.point_id = ow.point_id AND a.player_id = ow.opponent_id
         WHERE ow.weighting = 'involvement' AND a.touches = 0`,
      )
      .get() as { n: number };
    expect(zeroTouch.n).toBeGreaterThan(0); // non-vacuous
  });

  it("splits the weight equally when the whole opposing line touched nothing", () => {
    // The first point where a recorded line finished with no touches at all.
    const zeroLine = db
      .prepare(
        `SELECT p.point_id AS point_id, a.line AS line
         FROM appearances a
         JOIN points p ON p.point_id = a.point_id
         GROUP BY p.point_id, a.line
         HAVING SUM(a.touches) = 0
         ORDER BY p.point_number LIMIT 1`,
      )
      .get() as { point_id: number; line: string } | undefined;
    expect(zeroLine).toBeDefined();

    // A player on the other line at that point faces the zero-touch line.
    const otherLine = zeroLine!.line === "offense" ? "defense" : "offense";
    const player = db
      .prepare("SELECT player_id FROM appearances WHERE point_id = ? AND line = ?")
      .get(zeroLine!.point_id, otherLine) as { player_id: number } | undefined;
    expect(player).toBeDefined();

    const rows = db
      .prepare(
        `SELECT ow.weight AS weight, ow.weighting AS weighting, opp.touches AS touches
         FROM opponent_weight ow
         JOIN appearances opp
           ON opp.point_id = ow.point_id AND opp.player_id = ow.opponent_id
         WHERE ow.point_id = ? AND ow.player_id = ?`,
      )
      .all(zeroLine!.point_id, player!.player_id) as Array<{
      weight: number;
      weighting: string;
      touches: number;
    }>;
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.weighting).toBe("equal");
      expect(row.touches).toBe(0);
      expect(row.weight).toBeCloseTo(1 / 6, 12);
    }
    // Every opponent gets the same share, not a share of the remainder.
    expect(new Set(rows.map((r) => r.weight)).size).toBe(1);
  });

  it("gives an opponent who never touched the disc a row with a zero credit share", () => {
    // Gabe Senecal did not touch the disc on points 12 and 28 of this pair's
    // points, so his weight there is 0 and those points contribute no credit,
    // even though Justin Ye's salary on them was well above his baseline.
    const justinId = idOf("justin ye");
    const gabeId = idOf("gabe senecal");
    const row = opponentRowById(justinId, gabeId);
    expect(row).toBeDefined();

    const points = opponentPoints(justinId, gabeId);
    const zeroWeight = points.filter((p) => p.weight === 0);
    expect(zeroWeight).toHaveLength(2);
    for (const p of zeroWeight) {
      expect(touchesOn(p.point_id, gabeId)).toBe(0);
      expect(metricValue(p.point_id, justinId, "salary")).toBeGreaterThan(0);
    }

    // Recomputing over only the weight-bearing points reproduces the view's
    // credit: the zero-weight points carry no share of it.
    const salaryMean = baselineRow(justinId, "salary")!.mean;
    const contributing = points.filter((p) => p.weight > 0);
    const totalCredit = contributing.reduce(
      (sum, p) => sum + (metricValue(p.point_id, justinId, "salary") - salaryMean) * p.weight,
      0,
    );
    expect(row!.total_credit).toBeCloseTo(totalCredit, 6);
  });

  it("produces no row for a player with no appearances", () => {
    const ghostId = upsertPlayer(db, "Ghost Player", "ghost player", false);

    const inPairs = db
      .prepare(
        "SELECT COUNT(*) AS n FROM pair_effects WHERE player_a = 'ghost player' OR player_b = 'ghost player'",
      )
      .get() as { n: number };
    expect(inPairs.n).toBe(0);

    const inOpponents = db
      .prepare(
        "SELECT COUNT(*) AS n FROM opponent_effects WHERE player_id = ? OR opponent_id = ?",
      )
      .get(ghostId, ghostId) as { n: number };
    expect(inOpponents.n).toBe(0);

    // Non-vacuous: players who did appear do show up in both views.
    const ericInPairs = teammateRowCount(idOf("eric moore"), idOf("jon rowe"));
    expect(ericInPairs).toBe(1);
    expect(opponentRowById(idOf("justin ye"), idOf("gabe senecal"))).toBeDefined();
  });

  it("forms opponent pairs for an outside-line actor's point", () => {
    // The same point 24: Geoff's resolved team is the point's offence team,
    // so he is stored on the offense line and the opponent view counts him
    // against all six defence players, in both directions.
    const geoffId = idOf("geoff solomon");
    const point24 = pointIdFor(1000, 24);
    const defenseAt24 = db
      .prepare(
        `SELECT a.player_id AS player_id FROM appearances a
         JOIN points p ON p.point_id = a.point_id
         WHERE p.point_number = 24 AND a.line = 'defense'`,
      )
      .all() as Array<{ player_id: number }>;
    expect(defenseAt24).toHaveLength(6);
    for (const opponent of defenseAt24) {
      expect(opponentRowById(geoffId, opponent.player_id)).toBeDefined();
      expect(opponentRowById(opponent.player_id, geoffId)).toBeDefined();
      expect(opponentPoints(geoffId, opponent.player_id).map((p) => p.point_id)).toContain(point24);
      expect(opponentPoints(opponent.player_id, geoffId).map((p) => p.point_id)).toContain(point24);
    }

    // The offence line he joined is his own side at that point: no opponent
    // weight, in either direction, runs between him and them there.
    const offenseAt24 = db
      .prepare(
        `SELECT a.player_id AS player_id FROM appearances a
         JOIN points p ON p.point_id = a.point_id
         WHERE p.point_number = 24 AND a.line = 'offense' AND a.line_changed = 0`,
      )
      .all() as Array<{ player_id: number }>;
    expect(offenseAt24).toHaveLength(6);
    for (const peer of offenseAt24) {
      expect(opponentPoints(geoffId, peer.player_id).map((p) => p.point_id)).not.toContain(point24);
      expect(opponentPoints(peer.player_id, geoffId).map((p) => p.point_id)).not.toContain(point24);
    }

    // Point 24 is one of the points counted in Geoff's points_against,
    // against the defence line he faced there.
    const justinId = idOf("justin ye");
    const faced = opponentPoints(geoffId, justinId).map((p) => p.point_id);
    expect(faced).toContain(point24);
    const row = opponentRowById(geoffId, justinId);
    expect(row).toBeDefined();
    expect(row!.points_against).toBe(faced.length);
  });
});
