import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The project root, one level above `src/`. */
export const PROJECT_ROOT: string = path.resolve(here, "..");

/** The default store location: `<project root>/parity-synergy.db`. */
export const DEFAULT_DB_PATH: string = path.join(PROJECT_ROOT, "parity-synergy.db");

/** Resolve the database path, preferring an explicit argument. */
export function resolveDbPath(explicit?: string): string {
  return explicit !== undefined && explicit !== "" ? explicit : DEFAULT_DB_PATH;
}
