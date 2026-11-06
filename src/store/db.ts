import Database from "better-sqlite3";
import { resolveDbPath } from "../paths.js";
import { migrate } from "./schema.js";

export type Db = Database.Database;

/**
 * Open the SQLite store at `dbPath`, applying migrations. The file is
 * created if it does not exist. If migration fails, the handle is closed
 * before the error is rethrown, so the file is not left locked.
 */
export function openDb(dbPath?: string): Db {
  const db = new Database(resolveDbPath(dbPath));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  try {
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
