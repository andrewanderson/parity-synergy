import type { Db } from "../store/db.js";
import {
  RATING_MIN_SHARED_POINTS,
  pairExcess,
  teamRating,
  type PairFacts,
  type PlayerBaseline,
  type TeamRating,
} from "./rating.js";

/**
 * The window a rating is computed over. The two bounds are separate
 * because a baseline and a shared point can be drawn from different
 * stretches of history. Most call sites set them equal; the split-half
 * reliability measurement needs them different, holding the baseline
 * fixed while the shared points move.
 */
export type Window = {
  /** Baselines are computed from games before this game id. */
  baselineMaxGameId: number;
  /** Shared points are counted from games before this game id. */
  sharedMaxGameId: number;
};

/**
 * The window covering every game before league `leagueId` began. A
 * league with no games in the store opens at game id 0, which makes the
 * window empty.
 */
export function windowBeforeLeague(db: Db, leagueId: number): Window {
  const row = db
    .prepare("SELECT MIN(game_id) AS g FROM games WHERE league_id = ?")
    .get(leagueId) as { g: number | null };
  const boundary = row.g ?? 0;
  return { baselineMaxGameId: boundary, sharedMaxGameId: boundary };
}

/**
 * The window covering every game in the store: the live report's
 * window. A roster's synergy is rated over all of its shared history,
 * which is what makes the figure grow as the season is played.
 */
export function allTimeWindow(db: Db): Window {
  const last = db.prepare("SELECT MAX(game_id) AS g FROM games").get() as { g: number | null };
  const boundary = (last.g ?? 0) + 1;
  return { baselineMaxGameId: boundary, sharedMaxGameId: boundary };
}

/** The first game id of a league, or undefined when it has no games. */
function firstGameIdOfLeague(db: Db, leagueId: number): number | undefined {
  const row = db
    .prepare("SELECT MIN(game_id) AS g FROM games WHERE league_id = ?")
    .get(leagueId) as { g: number | null };
  return row.g ?? undefined;
}

/** One team's roster within a league, derived from the store. */
export type StoreTeam = { name: string; playerIds: number[] };

/**
 * Every distinct team name in a league, with its roster. A player's team
 * is a property of a point, not a person: the name comes from the
 * point's `offense_team`/`defense_team` for the line the player
 * appeared on, never from the game's `home_team`/`away_team`. Teams are
 * returned sorted by name.
 */
export function leagueTeams(db: Db, leagueId: number): StoreTeam[] {
  const rows = db
    .prepare(
      `SELECT p.offense_team AS offense_team, p.defense_team AS defense_team, a.line AS line, a.player_id AS pid
       FROM appearances a
       JOIN points p ON p.point_id = a.point_id
       JOIN games g ON g.game_id = p.game_id
       WHERE g.league_id = ?`,
    )
    .all(leagueId) as { offense_team: string; defense_team: string; line: string; pid: number }[];
  const byName = new Map<string, Set<number>>();
  for (const row of rows) {
    const teamName = row.line === "offense" ? row.offense_team : row.defense_team;
    let ids = byName.get(teamName);
    if (ids === undefined) {
      ids = new Set();
      byName.set(teamName, ids);
    }
    ids.add(row.pid);
  }
  return [...byName.entries()]
    .map(([name, ids]) => ({ name, playerIds: [...ids] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const SALARY_BASELINE_SQL = `
  SELECT a.player_id AS pid, COUNT(*) AS n, COALESCE(SUM(am.value), 0) AS total
  FROM appearances a
  LEFT JOIN appearance_metric am
    ON am.point_id = a.point_id AND am.player_id = a.player_id AND am.metric = 'salary'
  JOIN points p ON p.point_id = a.point_id
  WHERE p.game_id < @baselineMaxGameId
  GROUP BY a.player_id
`;

/**
 * The whole-salary baselines over a window, for the rating: each player's
 * total salary across their appearances in the window and their
 * appearance count. A player with no qualifying appearances is absent; a
 * player with no salary rows gets a total of 0.
 */
export function baselinesInWindow(db: Db, window: Window): Map<number, PlayerBaseline> {
  const rows = db
    .prepare(SALARY_BASELINE_SQL)
    .all({ baselineMaxGameId: window.baselineMaxGameId }) as {
    pid: number;
    n: number;
    total: number;
  }[];
  const baselines = new Map<number, PlayerBaseline>();
  for (const row of rows) {
    baselines.set(row.pid, {
      playerId: row.pid,
      salaryTotal: row.total,
      appearanceCount: row.n,
    });
  }
  return baselines;
}

/**
 * One player's salary baseline over a window: their total salary over
 * their appearances in the window, divided by the number of those
 * appearances. This is the same measure the store's `player_baselines`
 * view holds, computed over the window instead of the whole store, so a
 * windowed suppression figure subtracts the right baseline.
 */
export function salaryBaselinesInWindow(
  db: Db,
  window: Window,
): Map<number, { mean: number; points: number }> {
  const rows = db
    .prepare(
      `SELECT a.player_id AS pid, COUNT(*) AS n, COALESCE(SUM(am.value), 0) AS total
       FROM appearances a
       JOIN points p ON p.point_id = a.point_id
       LEFT JOIN appearance_metric am
         ON am.point_id = a.point_id AND am.player_id = a.player_id AND am.metric = 'salary'
       WHERE p.game_id < @baselineMaxGameId
       GROUP BY a.player_id`,
    )
    .all({ baselineMaxGameId: window.baselineMaxGameId }) as {
    pid: number;
    n: number;
    total: number;
  }[];
  const baselines = new Map<number, { mean: number; points: number }>();
  for (const row of rows) {
    baselines.set(row.pid, {
      mean: row.n === 0 ? 0 : row.total / row.n,
      points: row.n,
    });
  }
  return baselines;
}

/**
 * The opponent suppression between players, over a window.
 *
 * The store's `opponent_effects` view measures this over the whole store
 * and subtracts each player's whole-store salary baseline, so its
 * figures move whenever a game is ingested. The live report needs a
 * figure that moves only because the window moved, so the same
 * calculation is done here over the window's points and the window's
 * baselines.
 *
 * The measure is the weighted mean credit per weighted point: for each
 * point, the player's salary minus their baseline, multiplied by the
 * weight the ingest recorded for that opponent, summed and divided by
 * the sum of the weights.
 */
export function windowedOpponentEffects(
  db: Db,
  window: Window,
): { playerId: number; opponentId: number; pointsAgainst: number; affectedDelta: number }[] {
  const rows = db
    .prepare(
      `WITH bl AS (
         SELECT a.player_id AS pid, COUNT(*) AS n, COALESCE(SUM(am.value), 0) AS total
         FROM appearances a
         JOIN points p ON p.point_id = a.point_id
         LEFT JOIN appearance_metric am
           ON am.point_id = a.point_id AND am.player_id = a.player_id AND am.metric = 'salary'
         WHERE p.game_id < @baselineMaxGameId
         GROUP BY a.player_id
       )
       SELECT a.player_id AS pid_a, b.player_id AS pid_b,
              COUNT(DISTINCT a.point_id) AS n,
              SUM((am.value - (bl.total / bl.n)) * ow.weight) AS credit,
              SUM(ow.weight) AS weight
       FROM appearances a
       JOIN appearances b
         ON b.point_id = a.point_id AND b.line <> a.line
       JOIN opponent_weight ow
         ON ow.point_id = a.point_id AND ow.player_id = a.player_id AND ow.opponent_id = b.player_id
       JOIN appearance_metric am
         ON am.point_id = a.point_id AND am.player_id = a.player_id AND am.metric = 'salary'
       JOIN points p ON p.point_id = a.point_id
       JOIN bl ON bl.pid = a.player_id
       WHERE p.game_id < @sharedMaxGameId
       GROUP BY a.player_id, b.player_id
       HAVING COUNT(DISTINCT a.point_id) >= @minPoints`,
    )
    .all({
      baselineMaxGameId: window.baselineMaxGameId,
      sharedMaxGameId: window.sharedMaxGameId,
      minPoints: RATING_MIN_SHARED_POINTS,
    }) as {
    pid_a: number;
    pid_b: number;
    n: number;
    credit: number;
    weight: number;
  }[];
  return rows.map((row) => ({
    playerId: row.pid_a,
    opponentId: row.pid_b,
    pointsAgainst: row.n,
    affectedDelta: row.weight === 0 ? 0 : row.credit / row.weight,
  }));
}

const SHARED_PAIRS_SQL = `
  SELECT a.player_id AS pid_a, b.player_id AS pid_b,
         COUNT(*) AS n,
         COALESCE(SUM(ha.total), 0) AS s_a,
         COALESCE(SUM(hb2.total), 0) AS s_b
  FROM appearances a
  JOIN appearances b ON b.point_id = a.point_id AND b.line = a.line AND b.player_id > a.player_id
  JOIN points p ON p.point_id = a.point_id
  LEFT JOIN (SELECT point_id, player_id, SUM(value) AS total FROM appearance_metric
             WHERE metric = 'salary' GROUP BY point_id, player_id) ha
    ON ha.point_id = a.point_id AND ha.player_id = a.player_id
  LEFT JOIN (SELECT point_id, player_id, SUM(value) AS total FROM appearance_metric
             WHERE metric = 'salary' GROUP BY point_id, player_id) hb2
    ON hb2.point_id = a.point_id AND hb2.player_id = b.player_id
  WHERE a.line_changed = 0 AND b.line_changed = 0 AND p.game_id < @sharedMaxGameId
  GROUP BY a.player_id, b.player_id
`;

/**
 * Every pair of players who shared a line within the window, one row per
 * unordered pair. `s_a` and `s_b` are each member's own whole salary
 * across the pair's shared points, never the pair's combined total.
 */
export function sharedPairsInWindow(db: Db, window: Window): PairFacts[] {
  const rows = db
    .prepare(SHARED_PAIRS_SQL)
    .all({ sharedMaxGameId: window.sharedMaxGameId }) as {
    pid_a: number;
    pid_b: number;
    n: number;
    s_a: number;
    s_b: number;
  }[];
  return rows.map((row) => ({
    playerId: row.pid_a,
    teammateId: row.pid_b,
    sharedPointCount: row.n,
    playerSalaryTotal: row.s_a,
    teammateSalaryTotal: row.s_b,
  }));
}

/** Filter a window's pairs down to those where both members are on the roster. */
function rosterPairs(pairs: PairFacts[], playerIds: number[]): PairFacts[] {
  const roster = new Set(playerIds);
  return pairs.filter(
    (p) => roster.has(p.playerId) && roster.has(p.teammateId) && p.playerId !== p.teammateId,
  );
}

/** Rate one roster against the window's history. */
export function rateRoster(
  db: Db,
  window: Window,
  playerIds: number[],
  facts?: WindowFacts,
): TeamRating {
  const loaded = facts ?? windowFacts(db, window);
  const pairs = rosterPairs(loaded.pairs, playerIds);
  return teamRating(playerIds, pairs, loaded.baselines);
}

/**
 * Every same-line pair with the game it happened in, over the window.
 * One query for the whole window, so a caller that needs this for many
 * rosters reads it once.
 */
export function sharedGamePairs(
  db: Db,
  window: Window,
): { gameId: number; playerId: number; teammateId: number }[] {
  const rows = db
    .prepare(
      `SELECT p.game_id AS gid, a.player_id AS pid_a, b.player_id AS pid_b
       FROM appearances a
       JOIN appearances b
         ON b.point_id = a.point_id AND b.line = a.line AND b.player_id > a.player_id
       JOIN points p ON p.point_id = a.point_id
       WHERE a.line_changed = 0 AND b.line_changed = 0 AND p.game_id < @sharedMaxGameId`,
    )
    .all({ sharedMaxGameId: window.sharedMaxGameId }) as {
    gid: number;
    pid_a: number;
    pid_b: number;
  }[];
  return rows.map((row) => ({
    gameId: row.gid,
    playerId: row.pid_a,
    teammateId: row.pid_b,
  }));
}

/**
 * How many games in the window contain at least one point where two
 * roster players shared a line. This is the team's shared-parity-games
 * count over distinct games, not the sum over pairs.
 *
 * `minSharedPoints` is the floor a pairing must clear to count towards
 * the rating, so the games counted here are the games behind the rating
 * and not every game two roster members happened to share a line in.
 */
export function sharedGamesForRoster(
  db: Db,
  window: Window,
  playerIds: number[],
  pairs?: { gameId: number; playerId: number; teammateId: number }[],
  minSharedPoints = RATING_MIN_SHARED_POINTS,
): number {
  if (playerIds.length === 0) return 0;
  const roster = new Set(playerIds);
  const loaded = pairs ?? sharedGamePairs(db, window);

  // The games each roster pairing appears in, and how many shared points
  // that pairing has in total.
  const gamesByPair = new Map<string, Set<number>>();
  const pointsByPair = new Map<string, number>();
  for (const pair of loaded) {
    if (!roster.has(pair.playerId) || !roster.has(pair.teammateId)) continue;
    const key = `${pair.playerId}:${pair.teammateId}`;
    let games = gamesByPair.get(key);
    if (games === undefined) {
      games = new Set();
      gamesByPair.set(key, games);
    }
    games.add(pair.gameId);
    pointsByPair.set(key, (pointsByPair.get(key) ?? 0) + 1);
  }

  const games = new Set<number>();
  for (const [key, pairGames] of gamesByPair) {
    if ((pointsByPair.get(key) ?? 0) < minSharedPoints) continue;
    for (const gameId of pairGames) games.add(gameId);
  }
  return games.size;
}

/** One directed opponent effect between two players on different rosters. */
export type OpponentCell = {
  playerId: number;
  opponentId: number;
  pointsAgainst: number;
  affectedDelta: number;
};

/**
 * Every directed opponent effect with at least 5 points of sample, read
 * once. The `opponent_effects` view is expensive to evaluate, so a
 * caller that needs many roster pairs reads it once and matches the
 * rosters in memory rather than re-running the view per pair.
 */
export function allOpponentEffects(
  db: Db,
): { playerId: number; opponentId: number; pointsAgainst: number; affectedDelta: number }[] {
  const rows = db
    .prepare(
      `SELECT player_id, opponent_id, points_against, affected_delta
       FROM opponent_effects
       WHERE points_against >= ?`,
    )
    .all(RATING_MIN_SHARED_POINTS) as {
    player_id: number;
    opponent_id: number;
    points_against: number;
    affected_delta: number;
  }[];
  return rows.map((row) => ({
    playerId: row.player_id,
    opponentId: row.opponent_id,
    pointsAgainst: row.points_against,
    affectedDelta: row.affected_delta,
  }));
}

/**
 * Every directed opponent effect where the affected player comes off
 * roster A and the opponent off roster B, with at least 5 points of
 * sample. `effects` is the window's opponent effects; without it the
 * view is read once for this pair.
 */
export function crossRosterOpponentEffects(
  db: Db,
  rosterA: number[],
  rosterB: number[],
  effects?: ReturnType<typeof allOpponentEffects>,
): OpponentCell[] {
  if (rosterA.length === 0 || rosterB.length === 0) return [];
  const inA = new Set(rosterA);
  const inB = new Set(rosterB);
  const loaded = effects ?? allOpponentEffects(db);
  return loaded
    .filter(
      (effect) =>
        effect.pointsAgainst >= RATING_MIN_SHARED_POINTS &&
        inA.has(effect.playerId) &&
        inB.has(effect.opponentId),
    )
    .map((effect) => ({
      playerId: effect.playerId,
      opponentId: effect.opponentId,
      pointsAgainst: effect.pointsAgainst,
      affectedDelta: effect.affectedDelta,
    }));
}

/**
 * The qualifying pairs within a roster, with each member's own excess
 * over their baseline and the pair's shared-point count. The pair's score
 * is the mean of its two members' excesses, so it says how well the two
 * of them do together rather than how one drags the other down.
 */
export type RosterPair = {
  playerId: number;
  teammateId: number;
  sharedPointCount: number;
  playerExcess: number;
  teammateExcess: number;
  /** The mean of the two members' excesses. */
  pairExcess: number;
};

/**
 * The facts a window holds: the baselines and the shared pairs, read
 * once. Every read of a window is expensive (the pair query is a
 * self-join over every appearance), and the same window is read by the
 * rating, the roster's pair details, and the team sections, so it is
 * read once and shared.
 */
export type WindowFacts = {
  baselines: Map<number, PlayerBaseline>;
  pairs: PairFacts[];
};

/** Read a window's baselines and shared pairs once. */
export function windowFacts(db: Db, window: Window): WindowFacts {
  return {
    baselines: baselinesInWindow(db, window),
    pairs: sharedPairsInWindow(db, window),
  };
}

/**
 * The roster's qualifying pairs, with both members' excesses. A pair
 * counts only when both members are on the roster and they have at least
 * `RATING_MIN_SHARED_POINTS` shared points.
 */
export function rosterPairsInWindow(
  db: Db,
  window: Window | undefined,
  playerIds: number[],
  facts?: WindowFacts,
): RosterPair[] {
  const loaded = facts ?? windowFacts(db, window!);
  const pairs = rosterPairs(loaded.pairs, playerIds);
  const missing: PlayerBaseline = { playerId: 0, salaryTotal: 0, appearanceCount: 0 };
  const result: RosterPair[] = [];
  for (const pair of pairs) {
    if (pair.sharedPointCount < RATING_MIN_SHARED_POINTS) continue;
    const playerBaseline = loaded.baselines.get(pair.playerId) ?? missing;
    const teammateBaseline = loaded.baselines.get(pair.teammateId) ?? missing;
    const excess = pairExcess(pair, playerBaseline, teammateBaseline);
    result.push({
      playerId: pair.playerId,
      teammateId: pair.teammateId,
      sharedPointCount: pair.sharedPointCount,
      playerExcess: excess.playerExcess,
      teammateExcess: excess.teammateExcess,
      pairExcess: (excess.playerExcess + excess.teammateExcess) / 2,
    });
  }
  return result;
}

