import type { DataSource } from "parity-mcp/data/source";
import { assembleFullGame } from "parity-mcp/server";
import { buildPointStats } from "parity-mcp/engine/pointStats";
import type { Db } from "./db.js";
import { reconcileSalary, reconcilePointStats } from "../verify/reconcile.js";
import { writeGameFacts } from "./facts.js";
import { recomputeBaselines } from "./baselines.js";
import {
  normalizeExternalGameId,
  resolveGameId,
  type ExternalGameId,
} from "./gameIds.js";

/** The result of ingesting one game: stored and verified, or rejected. */
export type IngestOutcome = {
  /**
   * The game's id as the API reports it: a number for the older leagues, a
   * UUID for the newer ones.
   */
  gameId: ExternalGameId;
  leagueId: number;
  status: "ok" | "rejected";
  reason?: string;
};

export type IngestOptions = {
  leagues: number[];
  db: Db;
  source: DataSource;
  onProgress?: (outcome: IngestOutcome) => void;
};

/**
 * Record a rejected game outside the facts transaction, so a rejection
 * leaves no partial rows: only the log line exists. `writeGameFacts` never
 * writes a rejection, so this is the only place one is recorded.
 *
 * A rejected game has no stored game, so the log names it by the API's own
 * id and leaves the store's id empty. Claiming an id that another game may
 * take later would make the log point at the wrong game.
 */
function recordRejection(
  db: Db,
  externalId: string,
  reason: string,
): void {
  db.prepare(
    `INSERT INTO ingest_log (game_id, status, reason, checked_at, external_id)
     VALUES (NULL, 'rejected', ?, ?, ?)`,
  ).run(reason, new Date().toISOString(), externalId);
}

/**
 * Fetch, verify, and store one game. The reconciliation gate is the point:
 * a game whose salary ledger or per-point stats disagree with the API's own
 * reported numbers is rejected before any fact is written, because every
 * pair and opponent effect in the store would derive from wrong facts.
 *
 * A source error is not a rejection: when `source.getGame` throws the game
 * was never fetched, so nothing is recorded and the error propagates for
 * the caller to report. A rejection means the data WAS fetched and failed
 * to reconcile.
 *
 * A verified game commits its facts, its `ok` ingest log row (written by
 * `writeGameFacts`), and the baselines of exactly the players it touched
 * in one transaction. Re-ingesting replaces the game's rows instead of
 * duplicating them, so the ingest is idempotent.
 */
export async function ingestGame(
  db: Db,
  source: DataSource,
  leagueId: number,
  externalGameId: ExternalGameId,
): Promise<IngestOutcome> {
  const gameId = normalizeExternalGameId(externalGameId);
  // The store's own id for the game. A game the API identifies by UUID has
  // no id of its own that can key an integer column, so the store gives it
  // one and records the API's id beside it.
  const internalGameId = resolveGameId(db, leagueId, gameId);

  // The API is asked for the game by the id it reported, not by the
  // normalised one: the normalisation is for the store's own keys.
  const payload = await source.getGame({ id: leagueId }, externalGameId);
  const full = assembleFullGame(payload);
  const pointStats = buildPointStats(payload);

  const salaryCheck = reconcileSalary(payload, full.salaryLedger);
  if (!salaryCheck.ok) {
    recordRejection(db, String(gameId), salaryCheck.reason);
    return { gameId, leagueId, status: "rejected", reason: salaryCheck.reason };
  }

  const statsCheck = reconcilePointStats(payload, pointStats);
  if (!statsCheck.ok) {
    recordRejection(db, String(gameId), statsCheck.reason);
    return { gameId, leagueId, status: "rejected", reason: statsCheck.reason };
  }

  const commit = db.transaction((): void => {
    const playerIds = writeGameFacts(db, full, pointStats, internalGameId);
    recomputeBaselines(db, playerIds);
  });
  commit();

  return { gameId, leagueId, status: "ok" };
}

/**
 * Ingest every listed game of every given league, in ascending league id
 * order, awaiting each game before the next so the outcome list is
 * complete only after every game has been fetched and verified.
 * `onProgress` fires after every game so a caller can report progress.
 * A source error propagates from the failing game and stops the run.
 */
export async function ingestLeagues(options: IngestOptions): Promise<IngestOutcome[]> {
  const { leagues, db, source, onProgress } = options;
  const outcomes: IngestOutcome[] = [];
  for (const leagueId of [...leagues].sort((a, b) => a - b)) {
    const games = await source.listGames({ id: leagueId });
    // A league's games are stored in week order, whatever order the API
    // lists them in: the store's ids are chronological, and the rating
    // windows read them as one.
    const ordered = [...games].sort((a, b) => a.week - b.week);
    for (const game of ordered) {
      // The API reports game ids as strings: the older leagues as a run of
      // digits, the newer ones as a UUID. Either way the id is kept as the
      // API reported it, and the store gives the game an id of its own.
      const outcome = await ingestGame(db, source, leagueId, game.id);
      outcomes.push(outcome);
      onProgress?.(outcome);
    }
  }
  return outcomes;
}
