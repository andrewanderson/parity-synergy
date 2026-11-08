import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { computeRatingStats, sharedGameRange } from "../src/preview/stats.js";

describe("computeRatingStats", () => {
  it("measures the properties of the rating that the page publishes", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const stats = computeRatingStats(db as never);
    expect(stats.teamLeagueCount).toBe(41);
    // The rating and a team's point differential are essentially
    // uncorrelated.
    expect(Math.abs(stats.correlationWithPointDiff)).toBeLessThan(0.05);
    // The rating is not a sample-size proxy.
    expect(stats.correlationWithSharedPoints).toBeCloseTo(-0.028, 2);
    expect(stats.medianGameMargin).toBe(4);
    expect(stats.gamesDecidedByThreeOrFewer).toBe(73);
    expect(stats.gamesInStore).toBe(154);
    expect(stats.pointsInStore).toBe(5898);
    expect(stats.playersInStore).toBe(198);
    db.close();
  }, 180_000);

  it("shows the rating is not measuring sample size", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const stats = computeRatingStats(db as never);
    expect(Math.abs(stats.correlationWithSharedPoints)).toBeLessThan(0.1);
    db.close();
  }, 180_000);

  it("reports the range of shared games behind the historical team-leagues", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const range = sharedGameRange(db);
    expect(range.min).toBeGreaterThan(0);
    expect(range.max).toBeGreaterThanOrEqual(range.min);
    expect(range.count).toBe(41);
    db.close();
  }, 180_000);
});
