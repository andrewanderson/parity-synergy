import { writeFile } from "node:fs/promises";
import { ParityApiSource } from "parity-mcp/data/api";
import type { Db } from "../store/db.js";
import {
  allOpponentEffects,
  crossRosterOpponentEffects,
  preSeasonWindow,
  rosterPairsInWindow,
  windowFacts,
  type RosterPair,
  type WindowFacts,
} from "./history.js";
import { renderPage, type PageData, type TeamSection } from "./render.js";
import { resolveAndRateTeams, type ResolvedTeam } from "./rosters.js";
import { computeRatingStats } from "./stats.js";

/** Build the page and write it to disk. */
export async function buildPreview(options: {
  db: Db;
  baseUrl: string;
  leagueId: number;
  outPath: string;
}): Promise<{ outPath: string; byteLength: number; teamCount: number }> {
  const source = new ParityApiSource({ baseUrl: options.baseUrl });
  const teams = await resolveAndRateTeams(options.db, source, options.leagueId);
  // One read of the window, shared by every team section.
  const window = preSeasonWindow(options.db, options.leagueId);
  const facts = windowFacts(options.db, window);
  const sections = teams.map((team) => buildTeamSection(options.db, team, facts));
  const heatmap = buildHeatmap(options.db, teams);
  const method = computeRatingStats(options.db);
  const html = renderPage({
    leagueId: options.leagueId,
    teams: sections,
    heatmap: heatmap.cells,
    heatmapMax: heatmap.max,
    method,
  });
  await writeFile(options.outPath, html, "utf8");
  return {
    outPath: options.outPath,
    byteLength: Buffer.byteLength(html, "utf8"),
    teamCount: teams.length,
  };
}

/**
 * One team section: the chemistry list, the best and worst pairing, and
 * the top earners by baseline salary per point.
 */
export function buildTeamSection(
  db: Db,
  team: ResolvedTeam,
  facts: WindowFacts,
): TeamSection {
  const pairs = rosterPairsInWindow(db, undefined, team.storePlayerIds, facts);
  const names = playerNames(db, team.storePlayerIds);

  // Each player's own excess with each teammate, one entry per player.
  const chemistry = team.storePlayerIds.map((playerId) => {
    const teammates = pairs
      .filter((pair) => pair.playerId === playerId || pair.teammateId === playerId)
      .map((pair): { name: string; excess: number; sharedPoints: number } => {
        const isPlayer = pair.playerId === playerId;
        return {
          name: names.get(isPlayer ? pair.teammateId : pair.playerId) ?? "unknown",
          excess: isPlayer ? pair.playerExcess : pair.teammateExcess,
          sharedPoints: pair.sharedPointCount,
        };
      })
      .sort((a, b) => b.excess - a.excess);
    return { playerName: names.get(playerId) ?? "unknown", teammates };
  });

  const best = bestAndWorst(pairs, names, "best");
  const worst = bestAndWorst(pairs, names, "worst");

  return {
    team,
    chemistry,
    bestPair: best,
    worstPair: worst,
    topEarners: topEarners(db, team.storePlayerIds, names),
  };
}

/** The best or worst pairing of a roster, by the pair's mean excess. */
function bestAndWorst(
  pairs: RosterPair[],
  names: Map<number, string>,
  which: "best" | "worst",
): { a: string; b: string; sharedPoints: number; excess: number } | undefined {
  if (pairs.length === 0) return undefined;
  const sorted = [...pairs].sort((x, y) =>
    which === "best" ? y.pairExcess - x.pairExcess : x.pairExcess - y.pairExcess,
  );
  const pair = sorted[0]!;
  return {
    a: names.get(pair.playerId) ?? "unknown",
    b: names.get(pair.teammateId) ?? "unknown",
    sharedPoints: pair.sharedPointCount,
    excess: pair.pairExcess,
  };
}

/** Display names for a set of player ids. */
function playerNames(db: Db, playerIds: number[]): Map<number, string> {
  const names = new Map<number, string>();
  if (playerIds.length === 0) return names;
  const marks = playerIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT player_id, name FROM players WHERE player_id IN (${marks})`)
    .all(...playerIds) as { player_id: number; name: string }[];
  for (const row of rows) names.set(row.player_id, row.name);
  return names;
}

/**
 * A team's top three earners by baseline salary per point, from the
 * store's own baseline means.
 */
function topEarners(
  db: Db,
  playerIds: number[],
  names: Map<number, string>,
): { name: string; salaryPerPoint: number }[] {
  if (playerIds.length === 0) return [];
  const marks = playerIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT player_id, mean FROM player_baselines
       WHERE metric = 'salary' AND player_id IN (${marks})
       ORDER BY mean DESC
       LIMIT 3`,
    )
    .all(...playerIds) as { player_id: number; mean: number }[];
  return rows.map((row) => ({
    name: names.get(row.player_id) ?? "unknown",
    salaryPerPoint: row.mean,
  }));
}

/** One heatmap cell: two rosters against each other. */
type Cell = { rowLabel: string; columnLabel: string; value: number; pairCount: number };

/**
 * The roster-vs-roster matrix: for each ordered pair of teams, the
 * points-weighted mean of the opponent effects between the people on the
 * two rosters, and the number of player pairs behind it.
 */
export function buildHeatmap(
  db: Db,
  teams: ResolvedTeam[],
): { cells: Cell[]; max: number } {
  const cells: Cell[] = [];
  let max = 0;
  // One read of the opponent effects, shared by every cell. The view is
  // expensive to evaluate, and the matrix needs every ordered pair.
  const effects = allOpponentEffects(db);
  for (const row of teams) {
    for (const column of teams) {
      if (row.name === column.name) {
        cells.push({ rowLabel: shortLabel(row.name), columnLabel: shortLabel(column.name), value: 0, pairCount: 0 });
        continue;
      }
      const cellEffects = crossRosterOpponentEffects(
        db,
        row.storePlayerIds,
        column.storePlayerIds,
        effects,
      );
      let weighted = 0;
      let weight = 0;
      for (const effect of cellEffects) {
        weighted += effect.affectedDelta * effect.pointsAgainst;
        weight += effect.pointsAgainst;
      }
      const value = weight === 0 ? 0 : weighted / weight;
      cells.push({
        rowLabel: shortLabel(row.name),
        columnLabel: shortLabel(column.name),
        value,
        pairCount: cellEffects.length,
      });
      if (Math.abs(value) > max) max = Math.abs(value);
    }
  }
  return { cells, max };
}

/**
 * A team name shortened to its parenthetical captain where there is one,
 * because eight full names do not fit in a heatmap.
 */
export function shortLabel(name: string): string {
  const match = /\(([^()]+)\)\s*$/.exec(name);
  return match ? match[1]! : name;
}
