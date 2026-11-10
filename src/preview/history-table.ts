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
 * The measure the stored ratings are in.
 *
 * A rating measured in whole salary cannot be compared with one measured
 * in hold-and-break, so every row says which measure it is in, and the
 * report reads only the rows in the current measure.
 */
export const HISTORY_MEASURE = "salary";

/**
 * The measure the history held before it was versioned. Rows from that
 * measure are not comparable with the current one.
 */
const PREVIOUS_MEASURE = "hold_break";

/**
 * The history table's columns. The unique key on (league, team, game
 * mark, measure) makes recording idempotent: the same games cannot be
 * recorded twice under the same measure, and a rating under an older
 * measure never blocks one under the current one.
 */
const HISTORY_TABLE_COLUMNS = `
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
  measure TEXT NOT NULL DEFAULT '${HISTORY_MEASURE}',
  UNIQUE (league_id, team_name, game_high_water, measure)
`;

/**
 * The history table's DDL. It is created on demand rather than by the
 * store's migration, because it belongs to the preview feature and the
 * store's schema version covers the ingested game data only.
 */
const HISTORY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS synergy_history (${HISTORY_TABLE_COLUMNS})
`;

/**
 * Create the history table if it is not there, and bring an existing one
 * up to the current shape. Safe to call repeatedly.
 */
export function openHistoryTable(db: Db): void {
  db.exec(HISTORY_TABLE_SQL);
  migrateHistoryTable(db);
}

/**
 * Rebuild a history table that does not have the current shape.
 *
 * The rating moved from hold-and-break to whole salary, so the rows now
 * say which measure they are in and the report reads only the rows in the
 * current one. A table that predates the column is rebuilt around it, and
 * its rows are carried over labelled with the old measure, so the report
 * never compares a whole-salary rating against a hold-and-break one.
 *
 * The rebuild is one transaction: if the copy fails, the old table is
 * still there.
 */
function migrateHistoryTable(db: Db): void {
  if (historyTableIsCurrent(db)) return;
  const hasMeasure = tableColumns(db).includes("measure");
  const rebuild = db.transaction(() => {
    db.exec(`CREATE TABLE synergy_history_new (${HISTORY_TABLE_COLUMNS})`);
    db.exec(
      `INSERT INTO synergy_history_new
         (id, league_id, team_name, entry_type, taken_at, rating, pair_count,
          shared_point_count, shared_game_count, roster_signature, game_high_water, measure)
       SELECT id, league_id, team_name, entry_type, taken_at, rating, pair_count,
              shared_point_count, shared_game_count, roster_signature, game_high_water,
              ${hasMeasure ? "measure" : `'${PREVIOUS_MEASURE}'`}
       FROM synergy_history`,
    );
    db.exec("DROP TABLE synergy_history");
    db.exec("ALTER TABLE synergy_history_new RENAME TO synergy_history");
  });
  rebuild();
}

/** The columns the history table has. */
function tableColumns(db: Db): string[] {
  const columns = db.prepare("PRAGMA table_info(synergy_history)").all() as {
    name: string;
  }[];
  return columns.map((column) => column.name);
}

/**
 * Whether the history table already has the current shape: a measure
 * column whose default is the current measure, so a row written without
 * naming its measure is a current one, and a unique key that includes the
 * measure, so a rating under an older measure cannot block one under the
 * current one.
 */
function historyTableIsCurrent(db: Db): boolean {
  const columns = db.prepare("PRAGMA table_info(synergy_history)").all() as {
    name: string;
    dflt_value: string | null;
  }[];
  const measure = columns.find((column) => column.name === "measure");
  if (measure === undefined) return false;
  if ((measure.dflt_value ?? "").replace(/'/g, "") !== HISTORY_MEASURE) return false;
  const wanted = ["league_id", "team_name", "game_high_water", "measure"];
  return uniqueIndexColumns(db).some(
    (columns) =>
      columns.length === wanted.length && wanted.every((column, i) => columns[i] === column),
  );
}

/** The columns of each unique index on the history table. */
function uniqueIndexColumns(db: Db): string[][] {
  const indexes = db.prepare("PRAGMA index_list(synergy_history)").all() as {
    name: string;
    unique: number;
  }[];
  const columns: string[][] = [];
  for (const index of indexes) {
    if (index.unique !== 1) continue;
    const info = db
      .prepare(`PRAGMA index_info("${index.name}")`)
      .all() as { name: string | null }[];
    columns.push(info.map((column) => column.name ?? ""));
  }
  return columns;
}

/**
 * Whether the history table is there.
 *
 * The read helpers use this rather than creating the table, because a
 * store opened read-only cannot run the DDL and must not be written to by
 * a read.
 */
function historyTableExists(db: Db): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='synergy_history'")
    .get();
  return row !== undefined;
}

/**
 * Whether the store holds history in the current measure.
 *
 * A store whose history table predates the measure column holds only
 * hold-and-break ratings, which cannot be compared with a whole-salary
 * one, so it counts as no history at all.
 */
function hasCurrentHistory(db: Db): boolean {
  if (!historyTableExists(db)) return false;
  return tableColumns(db).includes("measure");
}

/**
 * Record entries. An entry whose (league, team, game mark, measure) is
 * already stored is ignored, so running the report twice over the same
 * games does not duplicate history.
 *
 * A rating under an older measure is left alone: it cannot be compared
 * with the current one, and the unique key keeps the two apart.
 */
export function appendHistory(db: Db, entries: HistoryEntry[]): number {
  if (entries.length === 0) return 0;
  openHistoryTable(db);
  const statement = db.prepare(
    `INSERT OR IGNORE INTO synergy_history
       (league_id, team_name, entry_type, taken_at, rating, pair_count,
        shared_point_count, shared_game_count, roster_signature, game_high_water, measure)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        HISTORY_MEASURE,
      );
      written += result.changes;
    }
    return written;
  });
  return insert(entries);
}

/** The most recent entry for each team in a league, keyed by team name. */
export function latestHistory(db: Db, leagueId: number): Map<string, HistoryEntry> {
  if (!hasCurrentHistory(db)) return new Map();
  const rows = db
    .prepare(
      `SELECT * FROM synergy_history
       WHERE league_id = ? AND measure = ?
       ORDER BY game_high_water DESC, id DESC`,
    )
    .all(leagueId, HISTORY_MEASURE) as Record<string, unknown>[];
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
  if (!hasCurrentHistory(db)) return undefined;
  const row = db
    .prepare(
      `SELECT * FROM synergy_history
       WHERE league_id = ? AND team_name = ? AND game_high_water < ? AND measure = ?
       ORDER BY game_high_water DESC, id DESC
       LIMIT 1`,
    )
    .get(leagueId, teamName, gameHighWater, HISTORY_MEASURE) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? undefined : rowToEntry(row);
}

/** Every entry for a league, oldest first. The basis for a later chart. */
export function historyForLeague(db: Db, leagueId: number): HistoryEntry[] {
  if (!hasCurrentHistory(db)) return [];
  const rows = db
    .prepare(
      `SELECT * FROM synergy_history
       WHERE league_id = ? AND measure = ?
       ORDER BY game_high_water ASC, id ASC`,
    )
    .all(leagueId, HISTORY_MEASURE) as Record<string, unknown>[];
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
