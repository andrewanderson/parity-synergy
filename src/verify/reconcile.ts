import type { GamePayload } from "parity-mcp/domain/types";
import type { SalaryLedger } from "parity-mcp/engine/salary";
import type { PointStatsPayload } from "parity-mcp/engine/pointStats";

export type ReconcileResult = { ok: true } | { ok: false; reason: string };

/**
 * Every stats player's API-reported `pay` must equal the salary ledger's
 * derived total. A mismatch means the salary rules changed for that game,
 * which must never enter the store.
 */
export function reconcileSalary(payload: GamePayload, ledger: SalaryLedger): ReconcileResult {
  const derived = new Map<string, number>();
  for (const total of ledger.totals) {
    derived.set(total.name.toLowerCase(), total.total);
  }
  for (const stat of payload.stats) {
    const key = stat.name.toLowerCase();
    const value = derived.get(key);
    if (value === undefined) {
      return { ok: false, reason: `${stat.raw}: no derived salary for a stats player` };
    }
    if (value !== stat.pay) {
      return {
        ok: false,
        reason: `${stat.raw}: derived salary ${value} does not match API pay ${stat.pay}`,
      };
    }
  }
  return { ok: true };
}

/**
 * The event-derived per-point stat totals must equal the API's game-level
 * stats for all ten dimensions, for every player.
 */
export function reconcilePointStats(payload: GamePayload, stats: PointStatsPayload): ReconcileResult {
  const derived = new Map<string, PointStatsPayload["totals"][number]["counts"]>();
  for (const total of stats.totals) {
    derived.set(total.name.toLowerCase(), total.counts);
  }
  for (const stat of payload.stats) {
    const key = stat.name.toLowerCase();
    const counts = derived.get(key);
    if (counts === undefined) {
      return { ok: false, reason: `${stat.raw}: no derived stats for a stats player` };
    }
    const pairs: Array<[keyof typeof counts, number]> = [
      ["goals", stat.goals],
      ["assists", stat.assists],
      ["second_assists", stat.secondAssists],
      ["d_blocks", stat.dBlocks],
      ["completions", stat.completions],
      ["catches", stat.catches],
      ["drops", stat.drops],
      ["throw_aways", stat.throwAways],
      ["threw_drops", stat.threwDrops],
      ["pulls", stat.pulls],
    ];
    for (const [field, expected] of pairs) {
      if (counts[field] !== expected) {
        return {
          ok: false,
          reason: `${stat.raw}: derived ${field} ${counts[field]} does not match API ${expected}`,
        };
      }
    }
  }
  return { ok: true };
}
