import type { Db } from "../store/db.js";
import type { DataSource } from "parity-mcp/data/source";
import { nameKeyFor } from "../query/pairs.js";
import { playerIdFor } from "../store/baselines.js";
import {
  preSeasonWindow,
  rateRoster,
  referenceRatings,
  sharedGamesForRoster,
} from "./history.js";
import { percentileOf, type TeamRating } from "./rating.js";

/** One league-25 team, resolved against the store. */
export type ResolvedTeam = {
  name: string;
  /** Every player on the roster, in API order. */
  rosterNames: string[];
  /** The roster players who exist in the store. */
  storePlayerIds: number[];
  /** The roster players with no store history. */
  unknownNames: string[];
  rating: TeamRating;
  percentile: number;
  /** Shared-parity-games total: distinct games with a shared roster line. */
  sharedGames: number;
};

/** Every league team, resolved and rated, sorted best rating first. */
export async function resolveAndRateTeams(
  db: Db,
  source: DataSource,
  leagueId: number,
): Promise<ResolvedTeam[]> {
  const rosters = await source.getTeamRoster({ id: leagueId });
  const reference = referenceRatings(db, [21, 22, 23, 24]);
  const window = preSeasonWindow(db, leagueId);

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
    const rating: TeamRating = rateRoster(db, window, team.storePlayerIds);
    const sharedGames = sharedGamesForRoster(db, window, team.storePlayerIds);
    return { ...team, rating, percentile: percentileOf(rating.rating, reference), sharedGames };
  });

  return withRatings.sort((a, b) => b.rating.rating - a.rating.rating);
}
