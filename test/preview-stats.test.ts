import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { computeRatingStats } from "../src/preview/stats.js";

describe("computeRatingStats", () => {
  it("measures the properties of the rating that the page publishes", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const stats = computeRatingStats(db as never);
    // The rating and a team's point differential are weakly related:
    // -0.131 Pearson over 41 team-leagues, so about 1.7% of the variance.
    // The figure is pinned, sign and all, because the page's own copy
    // says the correlation is negative.
    expect(stats.correlationWithPointDiff).toBeCloseTo(-0.131, 2);
    // The rating is not a sample-size proxy.
    expect(stats.correlationWithSharedPoints).toBeCloseTo(-0.082, 2);
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
});
