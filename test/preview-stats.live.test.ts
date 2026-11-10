import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { computeRatingStats } from "../src/preview/stats.js";

describe("computeRatingStats", () => {
  it("measures the properties of the rating that the page publishes", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const stats = computeRatingStats(db as never);
    // The figures themselves are not pinned here: the store grows every
    // week, so a pinned correlation would be stale by the next ingest.
    // The store's current figures are recorded in
    // test/fixtures/live-store.json, and the measure's arithmetic is
    // pinned against a fixture in test/preview-history.test.ts.
    expect(Number.isFinite(stats.correlationWithPointDiff)).toBe(true);
    expect(Number.isFinite(stats.correlationWithSharedPoints)).toBe(true);
    expect(stats.medianGameMargin).toBeGreaterThan(0);
    expect(stats.gamesDecidedByThreeOrFewer).toBeGreaterThan(0);
    expect(stats.gamesDecidedByThreeOrFewer).toBeLessThanOrEqual(stats.gamesInStore);
    expect(stats.gamesInStore).toBeGreaterThan(0);
    expect(stats.pointsInStore).toBeGreaterThan(0);
    expect(stats.playersInStore).toBeGreaterThan(0);
    db.close();
  }, 180_000);

  it("shows the rating's spread is wider where the evidence is thinner", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const stats = computeRatingStats(db as never);
    // The team-leagues with the least shared history hold the extreme
    // ratings in both directions, so the rating is related to how much
    // history it rests on, and the relation is negative. The page's
    // method section says so in words, so the sign matters.
    expect(stats.correlationWithSharedPoints).toBeLessThan(0);
    db.close();
  }, 180_000);
});
