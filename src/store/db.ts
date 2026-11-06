import Database from "better-sqlite3";
import { resolveDbPath } from "../paths.js";
import { SCHEMA_VERSION, migrate } from "./schema.js";

export type Db = Database.Database;

/**
 * Open the SQLite store at `dbPath`, applying migrations. The file is
 * created if it does not exist.
 */
export function openDb(dbPath?: string): Db {
  const db = new Database(resolveDbPath(dbPath));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
