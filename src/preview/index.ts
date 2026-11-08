import { writeFile } from "node:fs/promises";
import { ParityApiSource } from "parity-mcp/data/api";
import type { Db } from "../store/db.js";
import {
  allTimeWindow,
  crossRosterOpponentEffects,
  rosterPairsInWindow,
  salaryBaselinesInWindow,
  windowFacts,
  windowedOpponentEffects,
  type OpponentCell,
  type RosterPair,
  type Window,
  type WindowFacts,
} from "./history.js";
import { appendHistory } from "./history-table.js";
import { renderPage, type PageData, type TeamSection } from "./render.js";
import { entriesToRecord, resolveAndRateTeams, type ResolvedTeam } from "./rosters.js";
import { computeRatingStats } from "./stats.js";

/** Build the page and write it to disk. */
export async function buildPreview(options: {
  db: Db;
  baseUrl: string;
  leagueId: number;
  outPath: string;
}): Promise<{
  outPath: string;
  byteLength: number;
  teamCount: number;
  /** Whether a history entry was recorded, and why. */
  recorded: "season_opening" | "ingest" | "unchanged";
}> {
  const source = new ParityApiSource({ baseUrl: options.baseUrl });
  const teams = await resolveAndRateTeams(options.db, source, options.leagueId);
  // One read of the window, shared by every team section and by the
  // matrix, so the whole report comes from the same stretch of history.
  const window = allTimeWindow(options.db);
  const facts = windowFacts(options.db, window);
  const effects = windowedOpponentEffects(options.db, window);
  const sections = teams.map((team) => buildTeamSection(options.db, team, facts, window));
  const heatmap = buildHeatmap(options.db, teams, effects);
  const method = computeRatingStats(options.db);
  const html = renderPage({
    leagueId: options.leagueId,
    teams: sections,
    heatmap: heatmap.cells,
    heatmapMax: heatmap.max,
    method,
  });
  await writeFile(options.outPath, html, "utf8");

  // History is recorded only when there is something new to record: the
  // league's first report, or games ingested since the last one. A
  // roster change alone re-renders the page without touching history.
  const { entries, reason } = entriesToRecord(
    options.db,
    options.leagueId,
    teams,
    new Date().toISOString(),
  );
  if (reason !== "unchanged") appendHistory(options.db, entries);

  return {
    outPath: options.outPath,
    byteLength: Buffer.byteLength(html, "utf8"),
    teamCount: teams.length,
    recorded: reason,
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
  window: Window,
): TeamSection {
  const pairs = rosterPairsInWindow(db, undefined, team.storePlayerIds, facts);
  const names = playerNames(db, team.storePlayerIds);

  // Each player's own excess with each teammate, one entry per player.
  // A player who never shared a qualifying line with a teammate on this
  // roster is kept, and says so, rather than being dropped: the count of
  // players in the data and the count contributing are two different
  // numbers, and the card shows both.
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
    topEarners: topEarners(db, team.storePlayerIds, names, window),
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
 * A team's top three earners by salary per point over the window.
 *
 * The store's `player_baselines` table holds whole-store baselines, so
 * it is not used: a team card that says "top earners" beside a live
 * rating must be measured over the same history, or the card mixes a
 * current figure with a stale one.
 */
function topEarners(
  db: Db,
  playerIds: number[],
  names: Map<number, string>,
  window: Window,
): { name: string; salaryPerPoint: number }[] {
  if (playerIds.length === 0) return [];
  const baselines = salaryBaselinesInWindow(db, window);
  return playerIds
    .map((id) => ({
      name: names.get(id) ?? "unknown",
      salaryPerPoint: baselines.get(id)?.mean ?? 0,
    }))
    .sort((a, b) => b.salaryPerPoint - a.salaryPerPoint)
    .slice(0, 3);
}

/** One heatmap cell: two rosters against each other. */
type Cell = { rowLabel: string; columnLabel: string; value: number; pairCount: number };

/**
 * The roster-vs-roster matrix: for each ordered pair of teams, the
 * points-weighted mean of the opponent effects between the people on the
 * two rosters, and the number of player pairs behind it.
 *
 * The effects are the windowed ones, not the store's whole-store view,
 * so the matrix moves only because the report's window moved.
 */
export function buildHeatmap(
  db: Db,
  teams: ResolvedTeam[],
  effects: OpponentCell[],
): { cells: Cell[]; max: number } {
  const cells: Cell[] = [];
  let max = 0;
  const allNames = teams.map((team) => team.name);
  const label = (name: string) => shortLabel(name, allNames);
  for (const row of teams) {
    for (const column of teams) {
      if (row.name === column.name) {
        cells.push({ rowLabel: label(row.name), columnLabel: label(column.name), value: 0, pairCount: 0 });
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
        rowLabel: label(row.name),
        columnLabel: label(column.name),
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
 *
 * The short form is only used where it is unambiguous: if two teams share
 * a captain, the full name is used instead, so two rows of the matrix can
 * never collapse into one.
 */
export function shortLabel(name: string, allNames: string[] = []): string {
  const match = /\(([^()]+)\)\s*$/.exec(name);
  if (match === null) return name;
  const captain = match[1]!;
  const others = allNames.filter((other) => other !== name);
  const clash = others.some((other) => /\(([^()]+)\)\s*$/.exec(other)?.[1] === captain);
  return clash ? name : captain;
}
