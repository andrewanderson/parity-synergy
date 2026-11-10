import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { computeRatingStats } from "../src/preview/stats.js";
import {
  allTimeWindow,
  crossRosterOpponentEffects,
  leagueTeams,
  windowedOpponentEffects,
} from "../src/preview/history.js";
import { PROJECT_ROOT } from "../src/paths.js";

const SNAPSHOT_PATH = path.join(PROJECT_ROOT, "test", "fixtures", "live-store.json");

/** The store's recorded figures: what it holds, and what the rating does. */
type LiveSnapshot = {
  capturedAt: string;
  store: { games: number; points: number; players: number; appearances: number };
  stats: {
    correlationWithPointDiff: number;
    correlationWithSharedPoints: number;
    medianGameMargin: number;
    gamesDecidedByThreeOrFewer: number;
  };
};

function readSnapshot(): LiveSnapshot {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as LiveSnapshot;
}

describe("the live store", () => {
  it("gives every appearance a salary metric row", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const missing = db
      .prepare(
        `SELECT COUNT(*) c FROM appearances a
         WHERE NOT EXISTS (
           SELECT 1 FROM appearance_metric am
           WHERE am.point_id = a.point_id AND am.player_id = a.player_id AND am.metric = 'salary'
         )`,
      )
      .get() as { c: number };
    expect(missing.c).toBe(0);
    db.close();
  });

  it("makes every salary metric row equal the sum of its own rules", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const mismatched = db
      .prepare(
        `SELECT COUNT(*) c FROM (
           SELECT am.point_id pid, am.player_id plid, am.value value,
                  COALESCE((SELECT SUM(sr.amount) FROM salary_rule sr
                            WHERE sr.point_id = am.point_id AND sr.player_id = am.player_id), 0) rules
           FROM appearance_metric am WHERE am.metric = 'salary'
         ) WHERE ABS(value - rules) > 0.001`,
      )
      .get() as { c: number };
    expect(mismatched.c).toBe(0);
    db.close();
  }, 300_000);

  it("leaves no player with a zero salary, so no baseline is missing", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const zero = db
      .prepare(
        `SELECT COUNT(*) c FROM (
           SELECT a.player_id pid, COUNT(*) n, COALESCE(SUM(am.value), 0) total
           FROM appearances a
           LEFT JOIN appearance_metric am
             ON am.point_id = a.point_id AND am.player_id = a.player_id AND am.metric = 'salary'
           GROUP BY a.player_id
         ) WHERE total = 0`,
      )
      .get() as { c: number };
    expect(zero.c).toBe(0);
    db.close();
  }, 300_000);

  it("holds the figures the last report recorded", () => {
    // The store grows every week, so these figures are recorded rather
    // than pinned in the test. When they move, run `npm run repin:live`
    // and read the diff: it is the record of what the new games did.
    const snapshot = readSnapshot();
    const db = new Database("parity-synergy.db", { readonly: true });
    const store = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM games) games,
                (SELECT COUNT(*) FROM points) points,
                (SELECT COUNT(*) FROM players) players,
                (SELECT COUNT(*) FROM appearances) appearances`,
      )
      .get() as LiveSnapshot["store"];
    const stats = computeRatingStats(db as never);
    db.close();

    expect(
      store,
      `the store has changed since ${snapshot.capturedAt}; run npm run repin:live and read the diff`,
    ).toEqual(snapshot.store);
    expect(
      stats.correlationWithPointDiff,
      `the correlation with point differential has moved since ${snapshot.capturedAt}; run npm run repin:live`,
    ).toBeCloseTo(snapshot.stats.correlationWithPointDiff, 6);
    expect(
      stats.correlationWithSharedPoints,
      `the correlation with shared history has moved since ${snapshot.capturedAt}; run npm run repin:live`,
    ).toBeCloseTo(snapshot.stats.correlationWithSharedPoints, 6);
    expect(stats.medianGameMargin).toBe(snapshot.stats.medianGameMargin);
    expect(stats.gamesDecidedByThreeOrFewer).toBe(snapshot.stats.gamesDecidedByThreeOrFewer);
  }, 300_000);
});

describe("the opponent effects", () => {
  it("returns effects from one team's players against another's", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const teams = leagueTeams(db as never, 24);
    const cells = crossRosterOpponentEffects(db as never, teams[0]!.playerIds, teams[1]!.playerIds);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.pointsAgainst).toBeGreaterThanOrEqual(5);
      expect(Number.isFinite(cell.affectedDelta)).toBe(true);
    }
    db.close();
  }, 300_000);

  it("never returns a pair below the sample floor", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const teams = leagueTeams(db as never, 24);
    const effects = windowedOpponentEffects(db as never, allTimeWindow(db as never));
    for (const [a, b] of [
      [teams[0]!, teams[1]!],
      [teams[2]!, teams[3]!],
      [teams[4]!, teams[5]!],
    ] as const) {
      const cells = crossRosterOpponentEffects(db as never, a.playerIds, b.playerIds, effects);
      expect(cells.every((cell) => cell.pointsAgainst >= 5)).toBe(true);
    }
    db.close();
  }, 300_000);

  it("agrees with the store's view when the window is the whole store", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const window = allTimeWindow(db as never);
    const windowed = windowedOpponentEffects(db as never, window);
    const store = new Map<number, number>();
    let storeCount = 0;
    for (const row of db
      .prepare("SELECT player_id, opponent_id, affected_delta FROM opponent_effects WHERE points_against >= 5")
      .all() as { player_id: number; opponent_id: number; affected_delta: number }[]) {
      store.set(row.player_id * 100000 + row.opponent_id, row.affected_delta);
      storeCount++;
    }
    expect(windowed.length).toBe(storeCount);
    // The view's baseline is the store's whole-store baseline, which for
    // the whole-store window is the same measure, so the figures agree.
    for (const effect of windowed) {
      const key = effect.playerId * 100000 + effect.opponentId;
      const expected = store.get(key);
      expect(expected, `no store row for pair ${key}`).toBeDefined();
      expect(Math.abs(effect.affectedDelta - expected!)).toBeLessThan(1);
    }
    db.close();
  }, 300_000);

  it("excludes games outside the window", () => {
    const db = new Database("parity-synergy.db", { readonly: true });
    const wide = windowedOpponentEffects(db as never, allTimeWindow(db as never));
    const narrow = windowedOpponentEffects(db as never, {
      baselineMaxGameId: 1000,
      sharedMaxGameId: 1000,
    });
    expect(narrow.length).toBeLessThan(wide.length);
    db.close();
  }, 300_000);
});
