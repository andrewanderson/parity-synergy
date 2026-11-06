import type { Db } from "../store/db.js";
import { normalizePlayerRef } from "parity-mcp/data/normalize";

/** Pairs below this many shared points are excluded from reports. */
export const MIN_SHARED_POINTS = 5;

/** One row of the `pair_effects` view, columns named as the view exposes them. */
export type PairRow = { [column: string]: string | number | null };

/**
 * The sort column for each leaderboard metric. The metric name is looked up
 * in this fixed map and never interpolated into SQL, so a metric name cannot
 * become SQL. Only own properties count as entries: inherited keys such as
 * `constructor` or `toString` fall back to `a_shrunk_delta` like any other
 * unknown metric.
 */
const METRIC_SORT_COLUMNS: Record<string, string> = {
  salary: "a_shrunk_delta",
  goals: "a_goals_delta",
  assists: "a_assists_delta",
  second_assists: "a_second_assists_delta",
  d_blocks: "a_d_blocks_delta",
  completions: "a_completions_delta",
  throw_aways: "a_throw_aways_delta",
  threw_drops: "a_threw_drops_delta",
  catches: "a_catches_delta",
  drops: "a_drops_delta",
  pulls: "a_pulls_delta",
  hold: "a_hold_delta",
  break: "a_break_delta",
};

/**
 * The metrics a pair report can be ordered by, in the map's own order.
 * Derived from the map rather than restated, so the list a caller is told
 * about can never drift from the columns the query can actually sort by.
 */
export const PAIR_METRICS: [string, ...string[]] = Object.keys(
  METRIC_SORT_COLUMNS,
) as [string, ...string[]];

/**
 * Whether `metric` names a column the leaderboard can order by. The report
 * surfaces call this before querying and reject anything else with the
 * supported set, so an unknown metric is an error rather than a silent
 * answer to a different question.
 */
export function isSupportedMetric(metric: string): boolean {
  return Object.hasOwn(METRIC_SORT_COLUMNS, metric);
}

/**
 * The teammate leaderboard: pairs with at least `minPoints` shared points,
 * ordered by the requested metric's column and limited, all inside SQL, so
 * the view is never materialized into memory. Every row carries its sample
 * size (`points_together`) alongside its effects. The final `player_a`
 * tie-breaker makes the ordering total when the metric column and the sample
 * size tie.
 *
 * A metric outside the map never reaches SQL: the lookup falls back to the
 * default column, which is the SQL-safety backstop the report surfaces
 * validate in front of, not a way to answer an unknown metric.
 */
export function pairLeaderboard(
  db: Db,
  options: { metric?: string; minPoints?: number; limit?: number; order?: "asc" | "desc" } = {},
): PairRow[] {
  const minPoints = options.minPoints ?? MIN_SHARED_POINTS;
  const limit = options.limit ?? 50;
  const order = options.order ?? "desc";
  const metric = options.metric ?? "salary";
  const sortColumn = isSupportedMetric(metric)
    ? METRIC_SORT_COLUMNS[metric]!
    : "a_shrunk_delta";
  const direction = order === "asc" ? "ASC" : "DESC";
  return db
    .prepare(
      `SELECT * FROM pair_effects
       WHERE points_together >= @minPoints
       ORDER BY ${sortColumn} ${direction}, points_together DESC, player_a ASC
       LIMIT @limit`,
    )
    .all({ minPoints, limit }) as PairRow[];
}

/**
 * The identity key a query input resolves to: case-insensitive with a
 * terminal `(S)` substitute marker stripped, the same rule the MCP's
 * `normalizePlayerRef` applies when it builds `players.name_key`.
 */
export function nameKeyFor(name: string): string {
  return normalizePlayerRef(name).name.toLowerCase();
}

/**
 * The `pair_effects` row for the teammate pair, whichever way round the
 * names were passed, or `undefined` when the two never shared a point (or
 * either name is not in the store).
 */
export function pairDetail(db: Db, playerA: string, playerB: string): PairRow | undefined {
  const keyA = nameKeyFor(playerA);
  const keyB = nameKeyFor(playerB);
  return db
    .prepare(
      `SELECT * FROM pair_effects
       WHERE (player_a = @keyA AND player_b = @keyB)
          OR (player_a = @keyB AND player_b = @keyA)`,
    )
    .get({ keyA, keyB }) as PairRow | undefined;
}
