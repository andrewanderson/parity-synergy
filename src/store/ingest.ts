import type { DataSource } from "parity-mcp/data/source";
import { assembleFullGame } from "parity-mcp/server";
import { buildPointStats } from "parity-mcp/engine/pointStats";
import type { Db } from "./db.js";
import { reconcileSalary, reconcilePointStats } from "../verify/reconcile.js";
import { writeGameFacts } from "./facts.js";
import { recomputeBaselines } from "./baselines.js";

/** The result of ingesting one game: stored and verified, or rejected. */
export type IngestOutcome = {
  gameId: number;
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
 */
function recordRejection(db: Db, gameId: number, reason: string): void {
  db.prepare(
    `INSERT INTO ingest_log (game_id, status, reason, checked_at)
     VALUES (?, 'rejected', ?, ?)`,
  ).run(gameId, reason, new Date().toISOString());
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
  gameId: number,
): Promise<IngestOutcome> {
  const payload = await source.getGame({ id: leagueId }, gameId);
  const full = assembleFullGame(payload);
  const pointStats = buildPointStats(payload);

  const salaryCheck = reconcileSalary(payload, full.salaryLedger);
  if (!salaryCheck.ok) {
    recordRejection(db, gameId, salaryCheck.reason);
    return { gameId, leagueId, status: "rejected", reason: salaryCheck.reason };
  }

  const statsCheck = reconcilePointStats(payload, pointStats);
  if (!statsCheck.ok) {
    recordRejection(db, gameId, statsCheck.reason);
    return { gameId, leagueId, status: "rejected", reason: statsCheck.reason };
  }

  const commit = db.transaction((): void => {
    const playerIds = writeGameFacts(db, full, pointStats);
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
    for (const game of games) {
      // The API reports game ids as JSON strings despite `ApiGame.id` being
      // typed `number`; coerce here so the outcome carries a real number.
      const outcome = await ingestGame(db, source, leagueId, Number(game.id));
      outcomes.push(outcome);
      onProgress?.(outcome);
    }
  }
  return outcomes;
}
