/** What one player and one teammate did on the points they shared. */
export type PairFacts = {
  playerId: number;
  teammateId: number;
  sharedPointCount: number;
  /** Whole salary earned by `playerId` across the shared points. */
  playerSalaryTotal: number;
  /** Whole salary earned by `teammateId` across the shared points. */
  teammateSalaryTotal: number;
};

/** One player's baseline: whole salary per appearance point. */
export type PlayerBaseline = {
  playerId: number;
  /** Whole salary earned across the player's appearances. */
  salaryTotal: number;
  appearanceCount: number;
};

/** A player's rating: their mean excess with each teammate, weighted by precision. */
export type PlayerRating = {
  playerId: number;
  /** Weighted mean excess whole salary per shared point. */
  excessPerPoint: number;
  /** How many teammates contributed. */
  teammateCount: number;
};

/** A team's rating and its parts. */
export type TeamRating = {
  rating: number;
  playerRatings: PlayerRating[];
  pairCount: number;
  /** Players who contributed at least one pair. */
  contributingPlayers: number;
  /** Total shared points across all the team's pairs. */
  sharedPointCount: number;
};

/** Minimum shared points for a pair to count. */
export const RATING_MIN_SHARED_POINTS = 5;

/** The shrinkage constant: precision weight is n / (n + 8). */
export const RATING_SHRINKAGE_K = 8;

/** Whole salary per appearance point, or 0 when the player has none. */
export function salaryBaseline(player: PlayerBaseline): number {
  if (player.appearanceCount === 0) return 0;
  return player.salaryTotal / player.appearanceCount;
}

/**
 * One player's excess with one teammate, in whole salary per shared
 * point: the pair's own rate minus the player's personal baseline rate.
 */
export function pairExcess(
  pair: PairFacts,
  playerBaseline: PlayerBaseline,
  teammateBaseline: PlayerBaseline,
): { playerExcess: number; teammateExcess: number } {
  const n = pair.sharedPointCount;
  const playerRate = n === 0 ? 0 : pair.playerSalaryTotal / n;
  const teammateRate = n === 0 ? 0 : pair.teammateSalaryTotal / n;
  return {
    playerExcess: playerRate - salaryBaseline(playerBaseline),
    teammateExcess: teammateRate - salaryBaseline(teammateBaseline),
  };
}

/** Pairs that qualify for a player's rating, by shared points and membership. */
function qualifyingPairs(playerId: number, pairs: PairFacts[]): PairFacts[] {
  return pairs.filter(
    (p) =>
      p.playerId === playerId &&
      p.sharedPointCount >= RATING_MIN_SHARED_POINTS &&
      p.teammateId !== playerId,
  );
}

/**
 * A player's rating: their mean excess over their qualifying teammates,
 * each weighted by `n / (n + RATING_SHRINKAGE_K)`. Undefined when the
 * player has no qualifying pair.
 */
export function playerRating(
  playerId: number,
  pairs: PairFacts[],
  baselines: Map<number, PlayerBaseline>,
): PlayerRating | undefined {
  const mine = qualifyingPairs(playerId, pairs);
  if (mine.length === 0) return undefined;
  const missing: PlayerBaseline = { playerId, salaryTotal: 0, appearanceCount: 0 };
  let weightedSum = 0;
  let totalWeight = 0;
  for (const pair of mine) {
    const playerBaseline = baselines.get(pair.playerId) ?? missing;
    const teammateBaseline = baselines.get(pair.teammateId) ?? missing;
    const { playerExcess } = pairExcess(pair, playerBaseline, teammateBaseline);
    const weight = pair.sharedPointCount / (pair.sharedPointCount + RATING_SHRINKAGE_K);
    weightedSum += playerExcess * weight;
    totalWeight += weight;
  }
  return {
    playerId,
    excessPerPoint: weightedSum / totalWeight,
    teammateCount: mine.length,
  };
}

/**
 * A team's rating: the mean of its players' ratings. A pair counts only
 * when both members are on the roster and the pair qualifies; a player
 * who never shares a qualifying pair is counted in "in the data" by the
 * caller but contributes nothing here.
 *
 * Each unordered pair is expanded into both directions, one per member,
 * so every roster player rates against every teammate from their own
 * side of the pair. A pairing's score is the mean of its two members'
 * excesses, never one member's.
 */
export function teamRating(
  playerIds: number[],
  pairs: PairFacts[],
  baselines: Map<number, PlayerBaseline>,
): TeamRating {
  const roster = new Set(playerIds);
  const qualifying = pairs.filter(
    (p) =>
      roster.has(p.playerId) &&
      roster.has(p.teammateId) &&
      p.sharedPointCount >= RATING_MIN_SHARED_POINTS &&
      p.playerId !== p.teammateId,
  );
  const directed: PairFacts[] = qualifying.flatMap((p) => [
    p,
    {
      playerId: p.teammateId,
      teammateId: p.playerId,
      sharedPointCount: p.sharedPointCount,
      playerSalaryTotal: p.teammateSalaryTotal,
      teammateSalaryTotal: p.playerSalaryTotal,
    },
  ]);
  const ratings = playerIds
    .map((id) => playerRating(id, directed, baselines))
    .filter((r): r is PlayerRating => r !== undefined);
  if (ratings.length === 0) {
    return {
      rating: 0,
      playerRatings: [],
      pairCount: qualifying.length,
      contributingPlayers: 0,
      sharedPointCount: qualifying.reduce((sum, p) => sum + p.sharedPointCount, 0),
    };
  }
  return {
    rating: ratings.reduce((sum, r) => sum + r.excessPerPoint, 0) / ratings.length,
    playerRatings: ratings,
    pairCount: qualifying.length,
    contributingPlayers: new Set(ratings.map((r) => r.playerId)).size,
    sharedPointCount: qualifying.reduce((sum, p) => sum + p.sharedPointCount, 0),
  };
}
