import type { Db } from "../store/db.js";
import { playerIdFor } from "../store/baselines.js";
import { MIN_SHARED_POINTS, nameKeyFor, type PairRow } from "./pairs.js";

export type TeamEvaluation = {
  /**
   * One entry per input name that resolved to a player, in input order, in
   * the caller's spelling: a repeated spelling appears once per input.
   * Together with `unknownPlayers` this counts every input entry exactly
   * once, so `players.length + unknownPlayers.length` equals the input
   * length. Distinct resolved players are what `pairs` is built from.
   */
  players: string[];
  /** One entry per input name that was not in the store, in input order, so a typo is visible rather than dropped. */
  unknownPlayers: string[];
  pairs: PairRow[];
  riskyPairs: PairRow[];
  teamTotalShrunkDelta: number;
};

/**
 * A pair is risky when the salary effect is positive but the negative rate
 * (drops, throw-aways, threw-drops per point) is worse than the member's
 * baseline. Either member being risky makes the pair risky.
 */
function isRisky(pair: PairRow): boolean {
  const aRisky =
    (pair.a_delta as number) > 0 &&
    (pair.a_negative_rate_with_b as number) > (pair.a_negative_rate_baseline as number);
  const bRisky =
    (pair.b_delta as number) > 0 &&
    (pair.b_negative_rate_with_b as number) > (pair.b_negative_rate_baseline as number);
  return aRisky || bRisky;
}

/**
 * Evaluate a proposed team: every teammate pair among the resolved players
 * that shares at least `MIN_SHARED_POINTS` points, the risky subset, and a
 * rough total. Names resolve case-insensitively with a terminal `(S)`
 * stripped; unresolved names are reported in `unknownPlayers` rather than
 * silently dropped. A repeated spelling resolves once for the pair query, so
 * it does not change `pairs` or `teamTotalShrunkDelta`, while each input
 * entry still appears exactly once across `players` and `unknownPlayers`.
 *
 * The view stores `player_a` as the lower `name_key`, so the query never
 * assumes the caller's ordering: it asks for rows whose `player_a` and
 * `player_b` are both team members, which is exactly the pairs among the
 * team. Keys are bound as positional parameters, never interpolated.
 *
 * `teamTotalShrunkDelta` is a rough indicator, not a team score: a player
 * in six pairs has their effect counted once per pair.
 */
export function evaluateTeam(db: Db, playerNames: string[]): TeamEvaluation {
  const players: string[] = [];
  const unknownPlayers: string[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const name of playerNames) {
    const key = nameKeyFor(name);
    if (playerIdFor(db, key) === undefined) {
      unknownPlayers.push(name);
      continue;
    }
    players.push(name);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }

  if (keys.length < 2) {
    return { players, unknownPlayers, pairs: [], riskyPairs: [], teamTotalShrunkDelta: 0 };
  }

  const inList = keys.map(() => "?").join(", ");
  const pairs = db
    .prepare(
      `SELECT * FROM pair_effects
       WHERE player_a IN (${inList}) AND player_b IN (${inList})
         AND points_together >= ?
       ORDER BY points_together DESC, player_a ASC`,
    )
    .all(...keys, ...keys, MIN_SHARED_POINTS) as PairRow[];

  const riskyPairs = pairs.filter(isRisky);
  const teamTotalShrunkDelta = pairs.reduce(
    (total, pair) => total + (pair.a_shrunk_delta as number) + (pair.b_shrunk_delta as number),
    0,
  );

  return { players, unknownPlayers, pairs, riskyPairs, teamTotalShrunkDelta };
}
