import type { Db } from "../store/db.js";
import type { DataSource } from "parity-mcp/data/source";
import { nameKeyFor } from "../query/pairs.js";
import { playerIdFor } from "../store/baselines.js";
import {
  allTimeWindow,
  rateRoster,
  sharedGamePairs,
  sharedGamesForRoster,
  windowFacts,
} from "./history.js";
import { latestHistory, previousEntry, rosterSignature, type HistoryEntry } from "./history-table.js";
import type { TeamRating } from "./rating.js";

/** One league team, resolved against the store. */
export type ResolvedTeam = {
  name: string;
  /** Every player on the roster, in API order. */
  rosterNames: string[];
  /** The roster players who exist in the store. */
  storePlayerIds: number[];
  /** The roster players with no store history. */
  unknownNames: string[];
  rating: TeamRating;
  /** Shared-parity-games total: distinct games with a shared roster line. */
  sharedGames: number;
  /** The change in rating since the last ingested game, when there is one. */
  changeSinceLastGame?: number;
  /** Whether the roster changed since the last ingested game. */
  rosterChanged: boolean;
  /** Whether a previous report exists to compare against. */
  hasComparison: boolean;
  /** The highest game id the rating covers. */
  gameHighWater: number;
  /** A digest of the roster's player ids. */
  rosterSignature: string;
};

/**
 * Every league team, resolved and rated, sorted best rating first.
 *
 * The rating covers every game in the store, so it is the roster's
 * current synergy rather than a fixed pre-season figure. The change
 * since the last ingested game comes from the history table, and is
 * absent for a team's first report.
 */
export async function resolveAndRateTeams(
  db: Db,
  source: DataSource,
  leagueId: number,
): Promise<ResolvedTeam[]> {
  const rosters = await source.getTeamRoster({ id: leagueId });
  // The live window: every game in the store, so the rating is the
  // roster's current synergy rather than a fixed pre-season figure.
  const window = allTimeWindow(db);
  // One read of the window, shared by every roster.
  const facts = windowFacts(db, window);
  const gamePairs = sharedGamePairs(db, window);
  const highWater = gameHighWater(db);

  const resolved = rosters.map((roster) => {
    const rosterNames = roster.players.map((p) => p.name);
    const storePlayerIds: number[] = [];
    const unknownNames: string[] = [];
    for (const name of rosterNames) {
      const id = playerIdFor(db, nameKeyFor(name));
      if (id === undefined) unknownNames.push(name);
      else storePlayerIds.push(id);
    }
    return { name: roster.name, rosterNames, storePlayerIds, unknownNames };
  });

  const withRatings = resolved.map((team) => {
    const rating: TeamRating = rateRoster(db, window, team.storePlayerIds, facts);
    const sharedGames = sharedGamesForRoster(db, window, team.storePlayerIds, gamePairs);
    const signature = rosterSignature(team.storePlayerIds);
    // The comparison figure is the last report for this team that did
    // not include the games this one includes. When the games have not
    // advanced, that is this same report re-rendered, so there is no
    // change to show.
    const previous = previousReport(db, leagueId, team.name, highWater);
    return {
      ...team,
      rating,
      sharedGames,
      gameHighWater: highWater,
      rosterSignature: signature,
      changeSinceLastGame:
        previous === undefined ? undefined : rating.rating - previous.rating,
      rosterChanged:
        previous !== undefined && previous.rosterSignature !== signature,
      hasComparison: hasPreviousReport(db, leagueId, team.name, highWater),
    };
  });

  return withRatings.sort((a, b) => b.rating.rating - a.rating.rating);
}

/**
 * The figure the report compares against: the most recent recorded
 * entry for the team whose game mark is below the current one.
 *
 * When the current report's own entry sits at the current game mark, it
 * is skipped, so a re-render over the same games compares against the
 * report before it rather than against itself.
 */
export function previousReport(
  db: Db,
  leagueId: number,
  teamName: string,
  gameHighWater: number,
): HistoryEntry | undefined {
  const atCurrent = previousEntry(db, leagueId, teamName, gameHighWater + 1);
  if (atCurrent !== undefined && atCurrent.gameHighWater === gameHighWater) {
    return previousEntry(db, leagueId, teamName, gameHighWater);
  }
  return atCurrent;
}

/**
 * Whether the report has a previous figure to compare against at all.
 * A team whose league has a recorded entry is being re-rendered, which
 * is different from a team with no history yet.
 */
export function hasPreviousReport(
  db: Db,
  leagueId: number,
  teamName: string,
  gameHighWater: number,
): boolean {
  return previousEntry(db, leagueId, teamName, gameHighWater + 1) !== undefined;
}

/**
 * The highest game id in the store. It is the watermark that says whether
 * new games have been ingested since the last recorded report.
 */
export function gameHighWater(db: Db): number {
  const row = db.prepare("SELECT MAX(game_id) AS g FROM games").get() as { g: number | null };
  return row.g ?? 0;
}

/**
 * The history entries to record for this report.
 *
 * An entry is written when the league has no opening row yet, or when
 * the game watermark has advanced past the last recorded row, which is
 * what an ingest does. A roster change alone advances nothing, so a
 * report over the same games records nothing and the comparison stays
 * where it was.
 */
export function entriesToRecord(
  db: Db,
  leagueId: number,
  teams: ResolvedTeam[],
  takenAt: string,
): {
  entries: {
    leagueId: number;
    teamName: string;
    entryType: "season_opening" | "ingest";
    takenAt: string;
    rating: number;
    pairCount: number;
    sharedPointCount: number;
    sharedGameCount: number;
    rosterSignature: string;
    gameHighWater: number;
  }[];
  reason: "season_opening" | "ingest" | "unchanged";
} {
  if (teams.length === 0) return { entries: [], reason: "unchanged" };
  const recorded = latestHistory(db, leagueId);
  const anyRecorded = [...recorded.values()][0];
  if (anyRecorded !== undefined && anyRecorded.gameHighWater >= teams[0]!.gameHighWater) {
    // The games have not advanced since the last recorded report.
    return { entries: [], reason: "unchanged" };
  }
  const entryType: "season_opening" | "ingest" =
    anyRecorded === undefined ? "season_opening" : "ingest";
  const entries = teams.map((team) => ({
    leagueId,
    teamName: team.name,
    entryType,
    takenAt,
    rating: team.rating.rating,
    pairCount: team.rating.pairCount,
    sharedPointCount: team.rating.sharedPointCount,
    sharedGameCount: team.sharedGames,
    rosterSignature: team.rosterSignature,
    gameHighWater: team.gameHighWater,
  }));
  return { entries, reason: entryType };
}

/** The history entry a team's figure is compared against, if any. */
export function comparisonEntry(
  db: Db,
  leagueId: number,
  teamName: string,
  highWater: number,
): HistoryEntry | undefined {
  return previousEntry(db, leagueId, teamName, highWater);
}
