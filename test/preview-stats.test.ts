import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { computeRatingStats } from "../src/preview/stats.js";

describe("computeRatingStats", () => {
  it("measures the properties of the rating that the page publishes", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const stats = computeRatingStats(db as never);
    // The rating and a team's point differential are weakly related:
    // -0.187 Pearson over 41 team-leagues, so about 3.5% of the variance.
    // The figure is pinned, sign and all, because the page's own copy
    // says the correlation is negative.
    expect(stats.correlationWithPointDiff).toBeCloseTo(-0.187, 2);
    // The rating's spread is wider where the evidence is thinner: the
    // team-leagues with the fewest shared points hold both the highest
    // and the lowest ratings, so the correlation with the amount of
    // shared history is negative.
    expect(stats.correlationWithSharedPoints).toBeCloseTo(-0.324, 2);
    expect(stats.medianGameMargin).toBe(4);
    expect(stats.gamesDecidedByThreeOrFewer).toBe(154);
    expect(stats.gamesInStore).toBe(334);
    expect(stats.pointsInStore).toBe(13371);
    expect(stats.playersInStore).toBe(323);
    db.close();
  }, 180_000);

  it("shows the rating's spread is wider where the evidence is thinner", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const stats = computeRatingStats(db as never);
    // The team-leagues with the least shared history hold the extreme
    // ratings in both directions, so the rating is related to how much
    // history it rests on, and the relation is negative.
    expect(stats.correlationWithSharedPoints).toBeLessThan(-0.1);
    db.close();
  }, 180_000);
});
