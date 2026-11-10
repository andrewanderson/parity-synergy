import { describe, expect, it } from "vitest";
import {
  allTimeWindow,
  baselinesInWindow,
  leagueTeams,
  rateRoster,
  sharedGamesForRoster,
  sharedPairsInWindow,
  windowBeforeLeague,
} from "../src/preview/history.js";
import { measureFixtureStore } from "./fixtures/fixture-store.js";

/**
 * These tests read a fixture the tests own, never the live store. The
 * store grows every week, so a number taken from it goes stale on the
 * next ingest. A fixture's numbers do not move, so a test that pins them
 * pins the measure rather than the day's data.
 */
function openStore() {
  return measureFixtureStore();
}

describe("windowBeforeLeague", () => {
  it("is the first game id of the league, on both bounds", () => {
    const db = openStore();
    // The fixture's leagues start at game ids 1, 2 and 3.
    expect(windowBeforeLeague(db as never, 2)).toEqual({
      baselineMaxGameId: 2,
      sharedMaxGameId: 2,
    });
    expect(windowBeforeLeague(db as never, 3)).toEqual({
      baselineMaxGameId: 3,
      sharedMaxGameId: 3,
    });
    db.close();
  });
});

describe("leagueTeams", () => {
  it("returns one entry per distinct team name with its players", () => {
    const db = openStore();
    // The fixture's points name two sides, so the league has two teams.
    const teams = leagueTeams(db as never, 1);
    expect(teams).toHaveLength(2);
    const players = teams.flatMap((t) => t.playerIds);
    expect(players.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    db.close();
  });
});

describe("baselinesInWindow", () => {
  it("gives every player their whole salary per appearance point", () => {
    const db = openStore();
    const baselines = baselinesInWindow(db as never, {
      baselineMaxGameId: 4,
      sharedMaxGameId: 4,
    });
    // Ada: 13,500 over 9 appearances. Ben: 14,000 over 14. Cy: 6,000 over
    // 10. Dan: 8,000 over 4.
    const byName = new Map(
      [...baselines.values()].map((b) => [b.playerId, b.salaryTotal / b.appearanceCount]),
    );
    expect(byName.get(1)).toBe(1500);
    expect(byName.get(2)).toBe(1000);
    expect(byName.get(3)).toBe(600);
    expect(byName.get(4)).toBe(2000);
    db.close();
  });

  it("counts whole salary, not the hold-and-break slice of it", () => {
    const db = openStore();
    const baselines = baselinesInWindow(db as never, {
      baselineMaxGameId: 4,
      sharedMaxGameId: 4,
    });
    // Ada earned 6,000 of goals and 1,200 of assists. A measure that
    // read only hold-and-break would give her 1,000 a point, not 1,500.
    expect(baselines.get(1)!.salaryTotal).toBe(13500);
    expect(baselines.get(2)!.salaryTotal).toBe(14000);
    db.close();
  });

  it("uses the baseline bound, not the shared bound", () => {
    const db = openStore();
    const baselines = baselinesInWindow(db as never, {
      baselineMaxGameId: 2,
      sharedMaxGameId: 4,
    });
    const narrow = baselinesInWindow(db as never, {
      baselineMaxGameId: 2,
      sharedMaxGameId: 2,
    });
    expect([...baselines.entries()]).toEqual([...narrow.entries()]);
    // The bound excludes game 2 onwards, so only game 1's players have a
    // baseline.
    expect(baselines.size).toBe(3);
    db.close();
  });
});

describe("sharedPairsInWindow", () => {
  it("gives each member their own whole salary across the shared points", () => {
    const db = openStore();
    const pairs = sharedPairsInWindow(db as never, {
      baselineMaxGameId: 4,
      sharedMaxGameId: 4,
    });
    // Ada and Ben share 6 points: game 1's five and game 2's second.
    // Ben changed line on game 2's first point, so that one is not
    // shared, and game 2's third and fourth put them on different lines.
    const adaAndBen = pairs.find((p) => p.playerId === 1 && p.teammateId === 2);
    expect(adaAndBen).toBeDefined();
    expect(adaAndBen!.sharedPointCount).toBe(6);
    expect(adaAndBen!.playerSalaryTotal).toBe(10800);
    expect(adaAndBen!.teammateSalaryTotal).toBe(9000);
    db.close();
  });

  it("finds every pair that shared a line, including one below the floor", () => {
    const db = openStore();
    const pairs = sharedPairsInWindow(db as never, {
      baselineMaxGameId: 4,
      sharedMaxGameId: 4,
    });
    // Ada and Dan share 2 points. The floor is applied when a roster is
    // rated, not here.
    const adaAndDan = pairs.find((p) => p.playerId === 1 && p.teammateId === 4);
    expect(adaAndDan!.sharedPointCount).toBe(2);
    expect(adaAndDan!.playerSalaryTotal).toBe(1500);
    expect(adaAndDan!.teammateSalaryTotal).toBe(4000);
    db.close();
  });
});

describe("rateRoster", () => {
  it("rates each player on their own excess with each teammate", () => {
    const db = openStore();
    const rating = rateRoster(db as never, {
      baselineMaxGameId: 4,
      sharedMaxGameId: 4,
    }, [1, 2, 3, 4]);
    const byPlayer = new Map(rating.playerRatings.map((r) => [r.playerId, r.excessPerPoint]));
    // Ada has one qualifying pairing: 1,800 a point against her 1,500
    // baseline, so +300.
    expect(byPlayer.get(1)).toBeCloseTo(300, 10);
    // Ben has two: +500 with Ada over 6 points, and -600 with Cy over 5.
    // Each is weighted by n / (n + 8).
    expect(byPlayer.get(2)).toBeCloseTo(-20.27027027, 8);
    // Cy has one: 700 a point against her 600 baseline, so +100.
    expect(byPlayer.get(3)).toBeCloseTo(100, 10);
    // Dan's only pairing is below the floor, so he contributes nothing.
    expect(rating.contributingPlayers).toBe(3);
    expect(rating.pairCount).toBe(2);
    expect(rating.sharedPointCount).toBe(11);
    db.close();
  });

  it("is the mean of its players' ratings, over the players who contribute", () => {
    const db = openStore();
    const rating = rateRoster(db as never, {
      baselineMaxGameId: 4,
      sharedMaxGameId: 4,
    }, [1, 2, 3, 4]);
    // (300 - 20.27027027 + 100) / 3
    expect(rating.rating).toBeCloseTo(126.57657658, 8);
    db.close();
  });

  it("leaves out a player with no qualifying pairing, and a pair whose other member is off the roster", () => {
    const db = openStore();
    const rating = rateRoster(db as never, {
      baselineMaxGameId: 4,
      sharedMaxGameId: 4,
    }, [1, 2, 4]);
    // Dan contributes nothing, and Cy is not on this roster, so Ben's
    // pairing with Cy drops out and his one pairing with Ada is all he
    // has: the mean is (300 + 500) / 2.
    expect(rating.contributingPlayers).toBe(2);
    expect(rating.pairCount).toBe(1);
    expect(rating.rating).toBeCloseTo(400, 10);
    db.close();
  });

  it("gives a roster with no shared history a zero rating and no pairs", () => {
    const db = openStore();
    const rating = rateRoster(db as never, {
      baselineMaxGameId: 1,
      sharedMaxGameId: 1,
    }, [999999]);
    expect(rating.rating).toBe(0);
    expect(rating.pairCount).toBe(0);
    expect(rating.contributingPlayers).toBe(0);
    db.close();
  });
});

describe("sharedGamesForRoster", () => {
  it("counts the games in which two roster players shared a line", () => {
    const db = openStore();
    const games = sharedGamesForRoster(db as never, {
      baselineMaxGameId: 4,
      sharedMaxGameId: 4,
    }, [1, 2, 3]);
    // Ada and Ben share game 1 and game 2, and Ben and Cy share game 3.
    expect(games).toBe(3);
    db.close();
  });

  it("is zero for a roster with no shared history", () => {
    const db = openStore();
    expect(
      sharedGamesForRoster(db as never, {
        baselineMaxGameId: 4,
        sharedMaxGameId: 4,
      }, [999999]),
    ).toBe(0);
    db.close();
  });
});

describe("allTimeWindow", () => {
  it("covers every game in the store", () => {
    const db = openStore();
    const window = allTimeWindow(db as never);
    expect(window.baselineMaxGameId).toBe(4);
    expect(window.sharedMaxGameId).toBe(4);
    db.close();
  });
});
