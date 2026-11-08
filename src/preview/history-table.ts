import type { Db } from "../store/db.js";

/**
 * One recorded entry in a team's synergy history: the rating as it stood
 * at a point in time, with the sample sizes and the game mark it covers.
 *
 * The history is what lets the report say "change since last game", and
 * it is the groundwork for a chart of how a team's synergy evolved. Each
 * league's rows are kept apart by `leagueId`, so the table holds many
 * seasons without them mixing.
 */
export type HistoryEntry = {
  leagueId: number;
  /** The team's name as the API reports it, which is how a team is identified across reports. */
  teamName: string;
  /** `season_opening` for the league's first entry, `ingest` for the rest. */
  entryType: "season_opening" | "ingest";
  /** When the entry was recorded. */
  takenAt: string;
  rating: number;
  pairCount: number;
  sharedPointCount: number;
  sharedGameCount: number;
  /** A digest of the roster's player ids, so a roster change is detectable. */
  rosterSignature: string;
  /** The highest game id included in this rating. */
  gameHighWater: number;
};

/**
 * The history table's DDL. It is created on demand rather than by the
 * store's migration, because it belongs to the preview feature and the
 * store's schema version covers the ingested game data only. The unique
 * key on (league, team, game mark) makes recording idempotent: the same
 * games cannot be recorded twice.
 */
const HISTORY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS synergy_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL,
  team_name TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  rating REAL NOT NULL,
  pair_count INTEGER NOT NULL,
  shared_point_count INTEGER NOT NULL,
  shared_game_count INTEGER NOT NULL,
  roster_signature TEXT NOT NULL,
  game_high_water INTEGER NOT NULL,
  UNIQUE (league_id, team_name, game_high_water)
);
`;

/** Create the history table if it is not there. Safe to call repeatedly. */
export function openHistoryTable(db: Db): void {
  db.exec(HISTORY_TABLE_SQL);
}

/**
 * Record entries. An entry whose (league, team, game mark) is already
 * stored is ignored, so running the report twice over the same games
 * does not duplicate history.
 */
export function appendHistory(db: Db, entries: HistoryEntry[]): number {
  if (entries.length === 0) return 0;
  openHistoryTable(db);
  const statement = db.prepare(
    `INSERT OR IGNORE INTO synergy_history
       (league_id, team_name, entry_type, taken_at, rating, pair_count,
        shared_point_count, shared_game_count, roster_signature, game_high_water)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insert = db.transaction((rows: HistoryEntry[]) => {
    let written = 0;
    for (const row of rows) {
      const result = statement.run(
        row.leagueId,
        row.teamName,
        row.entryType,
        row.takenAt,
        row.rating,
        row.pairCount,
        row.sharedPointCount,
        row.sharedGameCount,
        row.rosterSignature,
        row.gameHighWater,
      );
      written += result.changes;
    }
    return written;
  });
  return insert(entries);
}

/** The most recent entry for each team in a league, keyed by team name. */
export function latestHistory(db: Db, leagueId: number): Map<string, HistoryEntry> {
  openHistoryTable(db);
  const rows = db
    .prepare(
      `SELECT * FROM synergy_history
       WHERE league_id = ?
       ORDER BY game_high_water DESC, id DESC`,
    )
    .all(leagueId) as Record<string, unknown>[];
  const latest = new Map<string, HistoryEntry>();
  for (const row of rows) {
    const entry = rowToEntry(row);
    if (!latest.has(entry.teamName)) latest.set(entry.teamName, entry);
  }
  return latest;
}

/**
 * The entry for a team that came before the given game mark. This is the
 * figure the report compares against for "change since last game".
 */
export function previousEntry(
  db: Db,
  leagueId: number,
  teamName: string,
  gameHighWater: number,
): HistoryEntry | undefined {
  openHistoryTable(db);
  const row = db
    .prepare(
      `SELECT * FROM synergy_history
       WHERE league_id = ? AND team_name = ? AND game_high_water < ?
       ORDER BY game_high_water DESC, id DESC
       LIMIT 1`,
    )
    .get(leagueId, teamName, gameHighWater) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : rowToEntry(row);
}

/** Every entry for a league, oldest first. The basis for a later chart. */
export function historyForLeague(db: Db, leagueId: number): HistoryEntry[] {
  openHistoryTable(db);
  const rows = db
    .prepare(
      `SELECT * FROM synergy_history
       WHERE league_id = ?
       ORDER BY game_high_water ASC, id ASC`,
    )
    .all(leagueId) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

/** One stored row as a history entry. */
function rowToEntry(row: Record<string, unknown>): HistoryEntry {
  return {
    leagueId: Number(row.league_id),
    teamName: String(row.team_name),
    entryType: String(row.entry_type) as HistoryEntry["entryType"],
    takenAt: String(row.taken_at),
    rating: Number(row.rating),
    pairCount: Number(row.pair_count),
    sharedPointCount: Number(row.shared_point_count),
    sharedGameCount: Number(row.shared_game_count),
    rosterSignature: String(row.roster_signature),
    gameHighWater: Number(row.game_high_water),
  };
}

/**
 * A digest of a roster's player ids, so two reports can tell whether the
 * roster changed between them without storing the roster itself.
 */
export function rosterSignature(playerIds: number[]): string {
  return [...playerIds].sort((a, b) => a - b).join(",");
}
