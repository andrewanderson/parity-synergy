import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  windowBeforeLeague,
  leagueTeams,
  baselinesInWindow,
  sharedPairsInWindow,
  rateRoster,
  referenceRatings,
  crossRosterOpponentEffects,
  sharedGamesForRoster,
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
  it("gives every player a hold-and-break baseline over the window", () => {
    const db = openStore();
    const baselines = baselinesInWindow(db as never, {
      baselineMaxGameId: 1018,
      sharedMaxGameId: 1018,
    });
    // 196 of 198 players have salary:HOLD and salary:BREAK baseline rows
    // over the whole store; the pre-league-24 window (game ids below
    // 1000) holds only 191, so the whole-store window is what the pinned
    // count spans.
    expect(baselines.size).toBeGreaterThanOrEqual(196);
    const values = [...baselines.values()].map((b) => b.holdBreakTotal / b.appearanceCount);
    expect(values.every((v) => Number.isFinite(v))).toBe(true);
    expect(values.some((v) => v > 0)).toBe(true);
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

describe("referenceRatings", () => {
  it("produces one rating per team-league in leagues 21 to 24", () => {
    const db = openStore();
    const ratings = referenceRatings(db as never, [21, 22, 23, 24]);
    expect(ratings).toHaveLength(41);
    expect(Math.min(...ratings)).toBeCloseTo(-177.74, 1);
    expect(Math.max(...ratings)).toBeCloseTo(49.17, 1);
    expect([...ratings].sort((a, b) => a - b)[Math.floor(ratings.length / 2)]).toBeCloseTo(2.42, 1);
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
