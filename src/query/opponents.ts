import type { Db } from "../store/db.js";
import { playerIdFor } from "../store/baselines.js";
import { MIN_SHARED_POINTS, nameKeyFor, type PairRow } from "./pairs.js";

/** One row of the `opponent_effects` view, columns named as the view exposes them. */
export type OpponentRow = { [column: string]: string | number | null };

/**
 * The suppression rows for one player: opponents the player faced on at
 * least `minPoints` points, ordered by `affected_delta` ascending so the
 * most suppressing opponents come first, limited in SQL. Every row carries
 * `points_against`, `total_credit` and `weighted_points`, and each
 * `*_delta` column is credit per weighted point, so the eleven rule
 * columns sum to `affected_delta`. A player who is not in the store has no
 * `player_id` and gets an empty array; the caller checks the `players`
 * table separately to tell "no effect" from "not found".
 */
export function opponentEffects(
  db: Db,
  player: string,
  options: { minPoints?: number; limit?: number } = {},
): OpponentRow[] {
  const minPoints = options.minPoints ?? MIN_SHARED_POINTS;
  const limit = options.limit ?? 50;
  const playerId = playerIdFor(db, nameKeyFor(player));
  if (playerId === undefined) return [];
  return db
    .prepare(
      `SELECT * FROM opponent_effects
       WHERE player_id = @playerId AND points_against >= @minPoints
       ORDER BY affected_delta ASC, points_against DESC
       LIMIT @limit`,
    )
    .all({ playerId, minPoints, limit }) as OpponentRow[];
}

/**
 * One player's full read: their stored baselines, every teammate pair they
 * appear in, and every opponent row they have. Rows are unfiltered here,
 * so a report can apply its own sample-size threshold. A player who is not
 * in the store gets empty arrays, never an error.
 */
export function playerProfile(db: Db, player: string): {
  baseline: Array<{ metric: string; points: number; total: number; mean: number }>;
  teammates: PairRow[];
  opponents: OpponentRow[];
} {
  const key = nameKeyFor(player);
  const playerId = playerIdFor(db, key);
  const baseline =
    playerId === undefined
      ? []
      : (db
          .prepare(
            "SELECT metric, points, total, mean FROM player_baselines WHERE player_id = @playerId ORDER BY metric",
          )
          .all({ playerId }) as Array<{ metric: string; points: number; total: number; mean: number }>);
  const teammates = db
    .prepare(
      `SELECT * FROM pair_effects
       WHERE player_a = @key OR player_b = @key
       ORDER BY points_together DESC, player_a ASC`,
    )
    .all({ key }) as PairRow[];
  const opponents =
    playerId === undefined
      ? []
      : (db
          .prepare(
            `SELECT * FROM opponent_effects
             WHERE player_id = @playerId
             ORDER BY affected_delta ASC, opponent_id ASC`,
          )
          .all({ playerId }) as OpponentRow[]);
  return { baseline, teammates, opponents };
}
