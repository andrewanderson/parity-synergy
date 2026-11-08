import type { Db } from "../store/db.js";
import {
  RATING_MIN_SHARED_POINTS,
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
 * window empty; `preSeasonWindow` is the function for that case.
 */
export function windowBeforeLeague(db: Db, leagueId: number): Window {
  const row = db
    .prepare("SELECT MIN(game_id) AS g FROM games WHERE league_id = ?")
    .get(leagueId) as { g: number | null };
  const boundary = row.g ?? 0;
  return { baselineMaxGameId: boundary, sharedMaxGameId: boundary };
}

/**
 * The window of history that existed before `leagueId` began, for rating
 * a roster going into that league. A league with no games yet is bounded
 * one past the last game in the store, so the window covers all of the
 * store's history; once the league's games are ingested, the boundary
 * becomes the league's first game id and its own games are excluded.
 * This is what keeps the rating a pre-season rating.
 */
export function preSeasonWindow(db: Db, leagueId: number): Window {
  const first = firstGameIdOfLeague(db, leagueId);
  const last = db.prepare("SELECT MAX(game_id) AS g FROM games").get() as { g: number | null };
  const boundary = first ?? (last.g ?? 0) + 1;
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

const HOLD_BREAK_BASELINE_SQL = `
  SELECT a.player_id AS pid, COUNT(*) AS n, COALESCE(SUM(hb.total), 0) AS hb
  FROM appearances a
  LEFT JOIN (
    SELECT point_id, player_id, SUM(amount) AS total
    FROM salary_rule WHERE rule_name IN ('HOLD','BREAK') GROUP BY point_id, player_id
  ) hb ON hb.point_id = a.point_id AND hb.player_id = a.player_id
  JOIN points p ON p.point_id = a.point_id
  WHERE p.game_id < @baselineMaxGameId
  GROUP BY a.player_id
`;

/**
 * Hold-and-break baselines for every player over the window: their total
 * HOLD and BREAK salary and their appearance count over games before
 * `window.baselineMaxGameId`. A player with no qualifying appearances is
 * absent; a player with no HOLD or BREAK rows gets a total of 0.
 */
export function baselinesInWindow(db: Db, window: Window): Map<number, PlayerBaseline> {
  const rows = db
    .prepare(HOLD_BREAK_BASELINE_SQL)
    .all({ baselineMaxGameId: window.baselineMaxGameId }) as {
    pid: number;
    n: number;
    hb: number;
  }[];
  const baselines = new Map<number, PlayerBaseline>();
  for (const row of rows) {
    baselines.set(row.pid, {
      playerId: row.pid,
      holdBreakTotal: row.hb,
      appearanceCount: row.n,
    });
  }
  return baselines;
}

const SHARED_PAIRS_SQL = `
  SELECT a.player_id AS pid_a, b.player_id AS pid_b,
         COUNT(*) AS n,
         COALESCE(SUM(ha.total), 0) AS hb_a,
         COALESCE(SUM(hb2.total), 0) AS hb_b
  FROM appearances a
  JOIN appearances b ON b.point_id = a.point_id AND b.line = a.line AND b.player_id > a.player_id
  JOIN points p ON p.point_id = a.point_id
  LEFT JOIN (SELECT point_id, player_id, SUM(amount) AS total FROM salary_rule
             WHERE rule_name IN ('HOLD','BREAK') GROUP BY point_id, player_id) ha
    ON ha.point_id = a.point_id AND ha.player_id = a.player_id
  LEFT JOIN (SELECT point_id, player_id, SUM(amount) AS total FROM salary_rule
             WHERE rule_name IN ('HOLD','BREAK') GROUP BY point_id, player_id) hb2
    ON hb2.point_id = a.point_id AND hb2.player_id = b.player_id
  WHERE a.line_changed = 0 AND b.line_changed = 0 AND p.game_id < @sharedMaxGameId
  GROUP BY a.player_id, b.player_id
`;

/**
 * Every pair of players who shared a line within the window, one row per
 * unordered pair. `hb_a` and `hb_b` are each member's own hold-and-break
 * total across the pair's shared points, never the pair's combined total.
 */
export function sharedPairsInWindow(db: Db, window: Window): PairFacts[] {
  const rows = db
    .prepare(SHARED_PAIRS_SQL)
    .all({ sharedMaxGameId: window.sharedMaxGameId }) as {
    pid_a: number;
    pid_b: number;
    n: number;
    hb_a: number;
    hb_b: number;
  }[];
  return rows.map((row) => ({
    playerId: row.pid_a,
    teammateId: row.pid_b,
    sharedPointCount: row.n,
    playerHoldBreakTotal: row.hb_a,
    teammateHoldBreakTotal: row.hb_b,
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
export function rateRoster(db: Db, window: Window, playerIds: number[]): TeamRating {
  const baselines = baselinesInWindow(db, window);
  const pairs = rosterPairs(sharedPairsInWindow(db, window), playerIds);
  return teamRating(playerIds, pairs, baselines);
}

/**
 * How many games in the window contain at least one point where two
 * roster players shared a line. This is the team's shared-parity-games
 * count over distinct games, not the sum over pairs.
 */
export function sharedGamesForRoster(db: Db, window: Window, playerIds: number[]): number {
  if (playerIds.length === 0) return 0;
  const roster = new Set(playerIds);
  const marks = playerIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT p.game_id AS gid
       FROM appearances a
       JOIN appearances b
         ON b.point_id = a.point_id AND b.line = a.line AND b.player_id > a.player_id
       JOIN points p ON p.point_id = a.point_id
       WHERE a.line_changed = 0 AND b.line_changed = 0
         AND p.game_id < ? AND a.player_id IN (${marks}) AND b.player_id IN (${marks})`,
    )
    .all(window.sharedMaxGameId, ...playerIds, ...playerIds) as { gid: number }[];
  return rows.length;
}

/** One directed opponent effect between two players on different rosters. */
export type OpponentCell = {
  playerId: number;
  opponentId: number;
  pointsAgainst: number;
  affectedDelta: number;
};

/**
 * Every directed opponent effect where the affected player comes off
 * roster A and the opponent off roster B, with at least 5 points of
 * sample. Membership is checked in SQL, not in JavaScript.
 */
export function crossRosterOpponentEffects(
  db: Db,
  rosterA: number[],
  rosterB: number[],
): OpponentCell[] {
  if (rosterA.length === 0 || rosterB.length === 0) return [];
  const marksA = rosterA.map(() => "?").join(",");
  const marksB = rosterB.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT player_id, opponent_id, points_against, affected_delta
       FROM opponent_effects
       WHERE points_against >= ?
         AND player_id IN (${marksA})
         AND opponent_id IN (${marksB})`,
    )
    .all(RATING_MIN_SHARED_POINTS, ...rosterA, ...rosterB) as {
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
 * Rate every historical team-league named by `leagues`, each team from
 * the window before its own league began. One rating per distinct team
 * name, which is the reference distribution the percentile comes from.
 */
export function referenceRatings(db: Db, leagues: number[]): number[] {
  const ratings: number[] = [];
  for (const leagueId of leagues) {
    const window = windowBeforeLeague(db, leagueId);
    const baselines = baselinesInWindow(db, window);
    const pairs = sharedPairsInWindow(db, window);
    for (const team of leagueTeams(db, leagueId)) {
      const roster = new Set(team.playerIds);
      const teamPairs = pairs.filter(
        (p) => roster.has(p.playerId) && roster.has(p.teammateId) && p.playerId !== p.teammateId,
      );
      const rating = teamRating(team.playerIds, teamPairs, baselines);
      ratings.push(rating.rating);
    }
  }
  return ratings;
}
