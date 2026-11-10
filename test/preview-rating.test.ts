import { describe, expect, it } from "vitest";
import {
  RATING_MIN_SHARED_POINTS,
  RATING_SHRINKAGE_K,
  pairExcess,
  playerRating,
  salaryBaseline,
  teamRating,
  type PairFacts,
  type PlayerBaseline,
} from "../src/preview/rating.js";

describe("salaryBaseline", () => {
  it("is the player's whole salary per appearance point", () => {
    expect(salaryBaseline({ playerId: 1, salaryTotal: 6132, appearanceCount: 10 })).toBeCloseTo(613.2, 10);
  });

  it("is zero when the player has no appearance points", () => {
    expect(salaryBaseline({ playerId: 1, salaryTotal: 0, appearanceCount: 0 })).toBe(0);
  });
});

describe("pairExcess", () => {
  it("subtracts each member's own baseline from their shared rate", () => {
    const pair: PairFacts = {
      playerId: 1,
      teammateId: 2,
      sharedPointCount: 10,
      playerSalaryTotal: 8000,
      teammateSalaryTotal: 8000,
    };
    const result = pairExcess(
      pair,
      { playerId: 1, salaryTotal: 6000, appearanceCount: 10 },
      { playerId: 2, salaryTotal: 5000, appearanceCount: 10 },
    );
    expect(result.playerExcess).toBeCloseTo(800 - 600, 10);
    expect(result.teammateExcess).toBeCloseTo(800 - 500, 10);
  });

  it("gives a player with no baseline an excess of zero rather than NaN", () => {
    const pair: PairFacts = {
      playerId: 1,
      teammateId: 2,
      sharedPointCount: 4,
      playerSalaryTotal: 4000,
      teammateSalaryTotal: 4000,
    };
    const result = pairExcess(
      pair,
      { playerId: 1, salaryTotal: 0, appearanceCount: 0 },
      { playerId: 2, salaryTotal: 0, appearanceCount: 0 },
    );
    expect(result.playerExcess).toBe(1000);
    expect(Number.isFinite(result.playerExcess)).toBe(true);
  });
});

describe("playerRating", () => {
  it("weights each teammate by n / (n + 8) and returns undefined with no teammates", () => {
    const baselines = new Map([
      [1, { playerId: 1, salaryTotal: 0, appearanceCount: 10 }],
      [2, { playerId: 2, salaryTotal: 0, appearanceCount: 10 }],
      [3, { playerId: 3, salaryTotal: 0, appearanceCount: 10 }],
    ]);
    const pairs: PairFacts[] = [
      { playerId: 1, teammateId: 2, sharedPointCount: 10, playerSalaryTotal: 10000, teammateSalaryTotal: 10000 },
      { playerId: 1, teammateId: 3, sharedPointCount: 30, playerSalaryTotal: 30000, teammateSalaryTotal: 30000 },
    ];
    const rating = playerRating(1, pairs, baselines);
    expect(rating).toBeDefined();
    expect(rating!.teammateCount).toBe(2);
    // excess with 2: 1000 - 0 = 1000, weight 10/18
    // excess with 3: 1000 - 0 = 1000, weight 30/38
    const expected = (1000 * (10 / 18) + 1000 * (30 / 38)) / ((10 / 18) + (30 / 38));
    expect(rating!.excessPerPoint).toBeCloseTo(expected, 10);
  });

  it("is undefined for a player with no qualifying teammate", () => {
    expect(playerRating(9, [], new Map())).toBeUndefined();
  });
});

describe("teamRating", () => {
  it("is the mean of its players' ratings", () => {
    const baselines = new Map([
      [1, { playerId: 1, salaryTotal: 0, appearanceCount: 10 }],
      [2, { playerId: 2, salaryTotal: 0, appearanceCount: 10 }],
    ]);
    const pairs: PairFacts[] = [
      { playerId: 1, teammateId: 2, sharedPointCount: 10, playerSalaryTotal: 10000, teammateSalaryTotal: 6000 },
    ];
    const team = teamRating([1, 2], pairs, baselines);
    expect(team.rating).toBeCloseTo((1000 + 600) / 2, 10);
    expect(team.pairCount).toBe(1);
    expect(team.contributingPlayers).toBe(2);
    expect(team.sharedPointCount).toBe(10);
  });

  it("excludes a player who never shared a line from the rating but counts them separately", () => {
    const baselines = new Map([
      [1, { playerId: 1, salaryTotal: 0, appearanceCount: 10 }],
      [2, { playerId: 2, salaryTotal: 0, appearanceCount: 10 }],
    ]);
    const pairs: PairFacts[] = [
      { playerId: 1, teammateId: 2, sharedPointCount: 10, playerSalaryTotal: 10000, teammateSalaryTotal: 10000 },
    ];
    const team = teamRating([1, 2, 3], pairs, baselines);
    expect(team.contributingPlayers).toBe(2);
    expect(team.rating).toBeCloseTo(1000, 10);
  });

  it("excludes pairs below the shared-point floor", () => {
    const baselines = new Map([
      [1, { playerId: 1, salaryTotal: 0, appearanceCount: 10 }],
      [2, { playerId: 2, salaryTotal: 0, appearanceCount: 10 }],
    ]);
    const pairs: PairFacts[] = [
      { playerId: 1, teammateId: 2, sharedPointCount: RATING_MIN_SHARED_POINTS - 1, playerSalaryTotal: 4000, teammateSalaryTotal: 4000 },
    ];
    const team = teamRating([1, 2], pairs, baselines);
    expect(team.pairCount).toBe(0);
    expect(team.contributingPlayers).toBe(0);
  });
});

describe("constants", () => {
  it("pins the floor and shrinkage constant", () => {
    expect(RATING_MIN_SHARED_POINTS).toBe(5);
    expect(RATING_SHRINKAGE_K).toBe(8);
  });
});
