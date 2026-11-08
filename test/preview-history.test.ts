import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  windowBeforeLeague,
  allTimeWindow,
  leagueTeams,
  baselinesInWindow,
  sharedPairsInWindow,
  rateRoster,
  crossRosterOpponentEffects,
  sharedGamesForRoster,
  windowedOpponentEffects,
} from "../src/preview/history.js";

function openStore() {
  const db = new Database("parity-synergy.db", { readonly: true });
  return db;
}

describe("windowBeforeLeague", () => {
  it("is the first game id of the league, on both bounds", () => {
    const db = openStore();
    expect(windowBeforeLeague(db as never, 24)).toEqual({
      baselineMaxGameId: 1000,
      sharedMaxGameId: 1000,
    });
    expect(windowBeforeLeague(db as never, 21)).toEqual({
      baselineMaxGameId: 877,
      sharedMaxGameId: 877,
    });
    db.close();
  });
});

describe("leagueTeams", () => {
  it("returns one entry per distinct team name with its players", () => {
    const db = openStore();
    const teams = leagueTeams(db as never, 24);
    expect(teams).toHaveLength(7);
    for (const team of teams) {
      expect(team.playerIds.length).toBeGreaterThan(0);
      expect(team.playerIds.every((id) => Number.isInteger(id))).toBe(true);
    }
    db.close();
  });
});

describe("baselinesInWindow", () => {
  it("gives every player a whole-salary baseline over the window", () => {
    const db = openStore();
    const baselines = baselinesInWindow(db as never, {
      baselineMaxGameId: 1018,
      sharedMaxGameId: 1018,
    });
    expect(baselines.size).toBeGreaterThanOrEqual(323);
    const values = [...baselines.values()].map((b) => b.salaryTotal / b.appearanceCount);
    expect(values.every((v) => Number.isFinite(v))).toBe(true);
    expect(values.some((v) => v > 0)).toBe(true);
    // Whole salary per appearance point, not the hold-and-break slice of it.
    // Kendall Carmichael: 6,366,500 over 1,541 appearances.
    const kendall = baselines.get(12);
    expect(kendall).toBeDefined();
    expect(kendall!.salaryTotal).toBe(6366500);
    expect(kendall!.appearanceCount).toBe(1541);
    db.close();
  });

  it("uses the baseline bound, not the shared bound", () => {
    const db = openStore();
    // The two bounds differ, so the baselines must reflect only the baseline bound.
    const baselines = baselinesInWindow(db as never, {
      baselineMaxGameId: 1000,
      sharedMaxGameId: 1018,
    });
    const narrow = baselinesInWindow(db as never, {
      baselineMaxGameId: 1000,
      sharedMaxGameId: 1000,
    });
    expect([...baselines.entries()]).toEqual([...narrow.entries()]);
    db.close();
  });
});

describe("sharedPairsInWindow", () => {
  it("finds pairs that shared a line within the window", () => {
    const db = openStore();
    const pairs = sharedPairsInWindow(db as never, {
      baselineMaxGameId: 1000,
      sharedMaxGameId: 1000,
    });
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(pair.sharedPointCount).toBeGreaterThan(0);
      expect(pair.playerId).not.toBe(pair.teammateId);
    }
    db.close();
  });

  it("uses the shared bound, so a narrower bound finds fewer pairs", () => {
    const db = openStore();
    const wide = sharedPairsInWindow(db as never, {
      baselineMaxGameId: 1000,
      sharedMaxGameId: 1018,
    });
    const narrow = sharedPairsInWindow(db as never, {
      baselineMaxGameId: 1000,
      sharedMaxGameId: 1000,
    });
    expect(wide.length).toBeGreaterThanOrEqual(narrow.length);
    db.close();
  });

  it("gives each member their own whole salary across the shared points", () => {
    const db = openStore();
    const pairs = sharedPairsInWindow(db as never, {
      baselineMaxGameId: 1018,
      sharedMaxGameId: 1018,
    });
    // Kendall Carmichael (12) and Bryan Mendez (174) share 31 points.
    // Kendall earned 177,500 of whole salary on them, Bryan 106,000.
    const pair = pairs.find(
      (p) => p.playerId === 12 && p.teammateId === 174,
    );
    expect(pair).toBeDefined();
    expect(pair!.sharedPointCount).toBe(31);
    expect(pair!.playerSalaryTotal).toBe(177500);
    expect(pair!.teammateSalaryTotal).toBe(106000);
    db.close();
  });
});

describe("rateRoster", () => {
  it("rates a roster that appears in the store", () => {
    const db = openStore();
    const teams = leagueTeams(db as never, 24);
    const biggest = [...teams].sort((a, b) => b.playerIds.length - a.playerIds.length)[0];
    const rating = rateRoster(
      db as never,
      { baselineMaxGameId: 1018, sharedMaxGameId: 1018 },
      biggest.playerIds,
    );
    expect(Number.isFinite(rating.rating)).toBe(true);
    expect(rating.pairCount).toBeGreaterThan(0);
    db.close();
  });

  it("gives a roster with no shared history a zero rating and no pairs", () => {
    const db = openStore();
    const rating = rateRoster(
      db as never,
      { baselineMaxGameId: 1000, sharedMaxGameId: 1000 },
      [999999],
    );
    expect(rating.rating).toBe(0);
    expect(rating.pairCount).toBe(0);
    expect(rating.contributingPlayers).toBe(0);
    db.close();
  });
});

describe("sharedGamesForRoster", () => {
  it("counts the games in which two roster players shared a line", () => {
    const db = openStore();
    const teams = leagueTeams(db as never, 24);
    const biggest = [...teams].sort((a, b) => b.playerIds.length - a.playerIds.length)[0];
    const games = sharedGamesForRoster(
      db as never,
      { baselineMaxGameId: 1018, sharedMaxGameId: 1018 },
      biggest.playerIds,
    );
    expect(games).toBeGreaterThan(0);
    // The count is over the shared bound: narrowing it can only lower it.
    const fewer = sharedGamesForRoster(
      db as never,
      { baselineMaxGameId: 1018, sharedMaxGameId: 1000 },
      biggest.playerIds,
    );
    expect(fewer).toBeLessThanOrEqual(games);
    db.close();
  });

  it("is zero for a roster with no shared history", () => {
    const db = openStore();
    expect(
      sharedGamesForRoster(
        db as never,
        { baselineMaxGameId: 1000, sharedMaxGameId: 1000 },
        [999999],
      ),
    ).toBe(0);
    db.close();
  });
});

describe("crossRosterOpponentEffects", () => {
  it("returns effects from one roster's players against another's", () => {
    const db = openStore();
    const teams = leagueTeams(db as never, 24);
    const cells = crossRosterOpponentEffects(db as never, teams[0].playerIds, teams[1].playerIds);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.pointsAgainst).toBeGreaterThanOrEqual(5);
      expect(Number.isFinite(cell.affectedDelta)).toBe(true);
    }
    db.close();
  });
});

describe("windowedOpponentEffects", () => {
  it("agrees with the store's view when the window is the whole store", () => {
    const db = openStore();
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
    const db = openStore();
    const wide = windowedOpponentEffects(db as never, allTimeWindow(db as never));
    const narrow = windowedOpponentEffects(db as never, {
      baselineMaxGameId: 1000,
      sharedMaxGameId: 1000,
    });
    expect(narrow.length).toBeLessThan(wide.length);
    db.close();
  }, 300_000);

  it("applies the same sample floor the store's view applies", () => {
    const db = openStore();
    const effects = windowedOpponentEffects(db as never, allTimeWindow(db as never));
    // Every returned pair must carry at least the floor, and the pairs
    // below it must be absent rather than silently included.
    expect(effects.every((effect) => effect.pointsAgainst >= 5)).toBe(true);
    const thin = db
      .prepare(
        "SELECT COUNT(*) c FROM opponent_effects WHERE points_against < 5",
      )
      .get() as { c: number };
    expect(thin.c).toBeGreaterThan(0);
    db.close();
  }, 300_000);
});

describe("crossRosterOpponentEffects", () => {
  it("never returns a pair below the sample floor", () => {
    const db = openStore();
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
});
