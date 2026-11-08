import type { Db } from "../store/db.js";
import {
  leagueTeams,
  preSeasonWindow,
  rateRoster,
  referenceRatings,
  sharedGamePairs,
  sharedGamesForRoster,
  windowBeforeLeague,
  windowFacts,
} from "./history.js";
import { teamRating } from "./rating.js";

/** How the rating behaves, measured over the historical team-leagues. */
export type RatingStats = {
  /** How many team-leagues the statistics cover. */
  teamLeagueCount: number;
  /** Correlation of the rating with that league's point differential. */
  correlationWithPointDiff: number;
  /** Spearman correlation of the rating with the amount of shared history. */
  correlationWithSharedPoints: number;
  /** Median game margin across every game in the store. */
  medianGameMargin: number;
  /** How many games were decided by three points or fewer. */
  gamesDecidedByThreeOrFewer: number;
  /** How many games are in the store. */
  gamesInStore: number;
  /** How many points are in the store. */
  pointsInStore: number;
  /** How many players are in the store. */
  playersInStore: number;
  /** The range of shared games behind the historical team-leagues. */
  sharedGameRange: { min: number; max: number; count: number };
};

/** The leagues the reference distribution and the statistics cover. */
const REFERENCE_LEAGUES = [21, 22, 23, 24];

/**
 * Measure the rating's predictive power and the store's shape.
 *
 * The rating's reliability is deliberately not measured here. Splitting a
 * league in half is not a clean repeated measure in a league with trades
 * every two games: a half-season boundary falls mid-rebuild, so the two
 * halves are not the same roster. The page publishes sample sizes per
 * team instead, which say how much history backs each rating.
 */
export function computeRatingStats(db: Db): RatingStats {
  const teamLeagues = historicalTeamLeagues(db);
  const ratings: number[] = [];
  const sharedPoints: number[] = [];
  const pointDiffs: number[] = [];

  // One read per league window, shared by every team-league in it.
  const factsByLeague = new Map<number, ReturnType<typeof windowFacts>>();
  for (const leagueId of REFERENCE_LEAGUES) {
    factsByLeague.set(leagueId, windowFacts(db, windowBeforeLeague(db, leagueId)));
  }

  for (const teamLeague of teamLeagues) {
    const rating = rateRoster(
      db,
      windowBeforeLeague(db, teamLeague.leagueId),
      teamLeague.playerIds,
      factsByLeague.get(teamLeague.leagueId),
    );
    ratings.push(rating.rating);
    sharedPoints.push(rating.sharedPointCount);
    pointDiffs.push(teamPointDifferential(db, teamLeague));
  }

  const margins = (
    db.prepare("SELECT ABS(home_score - away_score) AS margin FROM games").all() as {
      margin: number;
    }[]
  ).map((m) => m.margin);

  return {
    teamLeagueCount: teamLeagues.length,
    correlationWithPointDiff: pearson(ratings, pointDiffs),
    correlationWithSharedPoints: spearman(ratings, sharedPoints),
    medianGameMargin: median(margins),
    gamesDecidedByThreeOrFewer: margins.filter((m) => m <= 3).length,
    gamesInStore: count(db, "SELECT COUNT(*) AS c FROM games"),
    pointsInStore: count(db, "SELECT COUNT(*) AS c FROM points"),
    playersInStore: count(db, "SELECT COUNT(*) AS c FROM players"),
    sharedGameRange: sharedGameRange(db),
  };
}

/**
 * The range of shared games behind the historical team-leagues: how many
 * games each team-league's roster shared a line in, from the smallest to
 * the largest. This is the sample size behind the ratings, and the range
 * is what the page publishes instead of a reliability coefficient.
 */
export function sharedGameRange(db: Db): { min: number; max: number; count: number } {
  const counts: number[] = [];
  for (const leagueId of REFERENCE_LEAGUES) {
    const window = windowBeforeLeague(db, leagueId);
    // One read of the window's pairs, shared by every team-league in it.
    const pairs = sharedGamePairs(db, window);
    for (const team of leagueTeams(db, leagueId)) {
      counts.push(sharedGamesForRoster(db, window, team.playerIds, pairs));
    }
  }
  if (counts.length === 0) return { min: 0, max: 0, count: 0 };
  return {
    min: Math.min(...counts),
    max: Math.max(...counts),
    count: counts.length,
  };
}

/** One historical team-league: a team name inside a league, with its roster. */
type HistoricalTeamLeague = {
  leagueId: number;
  name: string;
  playerIds: number[];
};

/** Every team-league in the reference leagues, one per distinct team name. */
function historicalTeamLeagues(db: Db): HistoricalTeamLeague[] {
  const teamLeagues: HistoricalTeamLeague[] = [];
  for (const leagueId of REFERENCE_LEAGUES) {
    for (const team of leagueTeams(db, leagueId)) {
      teamLeagues.push({ leagueId, name: team.name, playerIds: team.playerIds });
    }
  }
  return teamLeagues;
}

/**
 * A team-league's point differential per game.
 *
 * The game's own `home_team`/`away_team` names and the game's score are
 * the source. A team's name can change mid-league, and the point rows
 * record the name at the time of the point, so the game's names are the
 * league's own record of who played that game. A team-league that shares
 * a name with a game counts that game.
 */
function teamPointDifferential(db: Db, teamLeague: HistoricalTeamLeague): number {
  const rows = db
    .prepare(
      `SELECT game_id AS gid, home_team AS home, away_team AS away,
              home_score AS hs, away_score AS as_
       FROM games
       WHERE league_id = ?`,
    )
    .all(teamLeague.leagueId) as {
    gid: number;
    home: string;
    away: string;
    hs: number;
    as_: number;
  }[];
  let total = 0;
  let games = 0;
  for (const row of rows) {
    if (row.home === teamLeague.name) {
      total += row.hs - row.as_;
      games++;
    } else if (row.away === teamLeague.name) {
      total += row.as_ - row.hs;
      games++;
    }
  }
  return games === 0 ? 0 : total / games;
}

/** Pearson correlation, 0 when either series has no variance. */
export function pearson(xs: number[], ys: number[]): number {
  if (xs.length === 0 || xs.length !== ys.length) return 0;
  const n = xs.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return 0;
  return num / Math.sqrt(dx2 * dy2);
}

/** Spearman correlation: Pearson over the ranks, 0 when undefined. */
export function spearman(xs: number[], ys: number[]): number {
  if (xs.length === 0 || xs.length !== ys.length) return 0;
  return pearson(ranks(xs), ranks(ys));
}

/** Ranks with ties sharing the average of their positions. */
function ranks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j++;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[indexed[k].index] = averageRank;
    i = j + 1;
  }
  return out;
}

/** The median of a series, 0 when empty. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** One count from a scalar query. */
function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

/**
 * The reference distribution's ratings: one per historical team-league,
 * each rated from the window before its own league began.
 */
export function referenceDistribution(db: Db): number[] {
  return referenceRatings(db, REFERENCE_LEAGUES);
}

/**
 * The rating of one roster with explicit pairs and baselines. Used by
 * callers that already hold the window's facts.
 */
export function rateWith(
  playerIds: number[],
  pairs: Parameters<typeof teamRating>[1],
  baselines: Parameters<typeof teamRating>[2],
) {
  return teamRating(playerIds, pairs, baselines);
}

/**
 * The pre-season window of a league, exposed so the page can label the
 * data window it used.
 */
export function leaguePreSeasonWindow(db: Db, leagueId: number) {
  return preSeasonWindow(db, leagueId);
}
