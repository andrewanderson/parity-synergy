import { openDb, type Db } from "../../src/store/db.js";

/** One player's appearance on a point, with the rules that make up their salary. */
export type FixtureAppearance = {
  /** The player's name. */
  player: string;
  /** The salary rules on this appearance. They sum to the appearance's salary. */
  rules: [rule: string, amount: number][];
  /** True when the player changed line on this point. */
  changedLine?: boolean;
};

/** One point: who was on each line, and what each of them earned. */
export type FixturePoint = {
  offense: FixtureAppearance[];
  defense: FixtureAppearance[];
};

/** One game: the league and week it belongs to, and its points. */
export type FixtureGame = {
  league: number;
  week: number;
  points: FixturePoint[];
};

/**
 * Build a store in memory from a fixture.
 *
 * The store the report reads grows every week, so a test that pins a
 * number taken from it goes stale on the next ingest. A fixture is
 * owned by the tests: its numbers are fixed, and a test that pins them
 * pins the measure rather than the day's data.
 */
export function buildFixtureStore(games: FixtureGame[]): Db {
  const db = openDb(":memory:");
  const insertPlayer = db.prepare(
    "INSERT INTO players (player_id, name, name_key) VALUES (?, ?, ?)",
  );
  const insertGame = db.prepare(
    `INSERT INTO games
       (game_id, league_id, week, date, home_team, away_team, home_score, away_score,
        salary_rules_version, imported_at, external_id)
     VALUES (?, ?, ?, NULL, 'Home', 'Away', 1, 0, 1, 'fixture', ?)`,
  );
  const insertPoint = db.prepare(
    `INSERT INTO points (point_id, game_id, point_number, offense_team, defense_team, duration_sec)
     VALUES (?, ?, ?, 'Home', 'Away', 60)`,
  );
  const insertAppearance = db.prepare(
    `INSERT INTO appearances (point_id, player_id, line, is_substitute, touches, line_changed)
     VALUES (?, ?, ?, 0, 0, ?)`,
  );
  const insertMetric = db.prepare(
    `INSERT INTO appearance_metric (point_id, player_id, metric, value) VALUES (?, ?, 'salary', ?)`,
  );
  const insertRule = db.prepare(
    "INSERT INTO salary_rule (point_id, player_id, rule_name, amount) VALUES (?, ?, ?, ?)",
  );

  const playerIds = new Map<string, number>();
  let nextPlayerId = 1;
  let nextGameId = 1;
  let nextPointId = 1;

  const write = db.transaction(() => {
    const playerId = (name: string): number => {
      const known = playerIds.get(name);
      if (known !== undefined) return known;
      const id = nextPlayerId++;
      playerIds.set(name, id);
      insertPlayer.run(id, name, name.toLowerCase());
      return id;
    };
    const writeAppearance = (
      pointId: number,
      line: "offense" | "defense",
      appearance: FixtureAppearance,
    ): void => {
      const id = playerId(appearance.player);
      insertAppearance.run(pointId, id, line, appearance.changedLine === true ? 1 : 0);
      const total = appearance.rules.reduce((sum, [, amount]) => sum + amount, 0);
      insertMetric.run(pointId, id, total);
      for (const [rule, amount] of appearance.rules) insertRule.run(pointId, id, rule, amount);
    };

    for (const game of games) {
      insertGame.run(nextGameId, game.league, game.week, String(nextGameId));
      game.points.forEach((point, index) => {
        const pointId = nextPointId++;
        insertPoint.run(pointId, nextGameId, index + 1);
        for (const appearance of point.offense) writeAppearance(pointId, "offense", appearance);
        for (const appearance of point.defense) writeAppearance(pointId, "defense", appearance);
      });
      nextGameId++;
    }
  });
  write();
  return db;
}

/**
 * The fixture the measure's tests read.
 *
 * Four players over three games, with numbers small enough to check by
 * hand:
 *
 * - Ada: 9 appearances, 13,500 of salary, so a baseline of 1,500 a point.
 * - Ben: 14 appearances, 14,000 of salary, so a baseline of 1,000 a point.
 * - Cy: 10 appearances, 6,000 of salary, so a baseline of 600 a point.
 * - Dan: 4 appearances, 8,000 of salary, so a baseline of 2,000 a point.
 *
 * Three pairings come out of it, and each one says something:
 *
 * - Ada and Ben share 6 points: game 1's five, plus game 2's second. Ben
 *   changed line on game 2's first point, so that one is not shared.
 *   Ada earned 10,800 on the six, 1,800 a point, so her excess is +300
 *   against her 1,500 baseline. Ben earned 9,000, 1,500 a point, so his
 *   excess is +500 against his 1,000 baseline.
 * - Ben and Cy share 5 points, the whole of game 3: Ben's 2,000 is 400 a
 *   point, an excess of -600, and Cy's 3,500 is 700 a point, an excess of
 *   +100.
 * - Ada and Dan share 2 points, which is below the 5-point floor, so they
 *   are not a pairing at all.
 *
 * Dan therefore has no pairing and contributes nothing to a rating,
 * which is the case a roster card has to handle.
 *
 * Ada and Ben carry goals and assists, so a measure that read only
 * hold-and-break would give different numbers for them: Ada's 6,000 of
 * goals and Ben's 2,000 of break are the difference.
 */
export const MEASURE_FIXTURE: FixtureGame[] = [
  {
    league: 1,
    week: 1,
    points: [
      {
        offense: [
          { player: "Ada", rules: [["HOLD", 1000], ["GOAL", 2000]] },
          { player: "Ben", rules: [["HOLD", 1000]] },
        ],
        defense: [{ player: "Cy", rules: [["COMPLETION", 500]] }],
      },
      {
        offense: [
          { player: "Ada", rules: [["HOLD", 1000], ["GOAL", 2000]] },
          { player: "Ben", rules: [["HOLD", 1000], ["COMPLETION", 1000]] },
        ],
        defense: [{ player: "Cy", rules: [["COMPLETION", 500]] }],
      },
      {
        offense: [
          { player: "Ada", rules: [["HOLD", 1000], ["ASSIST", 200]] },
          { player: "Ben", rules: [["HOLD", 1000]] },
        ],
        defense: [{ player: "Cy", rules: [["COMPLETION", 500]] }],
      },
      {
        offense: [
          { player: "Ada", rules: [["HOLD", 1000], ["ASSIST", 200]] },
          { player: "Ben", rules: [["HOLD", 1000], ["BREAK", 2000]] },
        ],
        defense: [{ player: "Cy", rules: [["COMPLETION", 500]] }],
      },
      {
        offense: [
          { player: "Ada", rules: [["HOLD", 1000], ["ASSIST", 200]] },
          { player: "Ben", rules: [["HOLD", 1000]] },
        ],
        defense: [{ player: "Cy", rules: [["COMPLETION", 500]] }],
      },
    ],
  },
  {
    league: 2,
    week: 1,
    points: [
      {
        // Ben changed line here, so this point is not a shared line.
        offense: [
          { player: "Ada", rules: [["HOLD", 1000], ["ASSIST", 200]] },
          { player: "Ben", rules: [["HOLD", 1000]], changedLine: true },
        ],
        defense: [{ player: "Dan", rules: [["HOLD", 1000], ["GOAL", 1000]] }],
      },
      {
        offense: [
          { player: "Ada", rules: [["HOLD", 1000], ["ASSIST", 200]] },
          { player: "Ben", rules: [["HOLD", 1000]] },
        ],
        defense: [{ player: "Dan", rules: [["HOLD", 1000], ["GOAL", 1000]] }],
      },
      {
        offense: [
          { player: "Ada", rules: [["CATCH", 900]] },
          { player: "Dan", rules: [["HOLD", 1000], ["GOAL", 1000]] },
        ],
        defense: [{ player: "Ben", rules: [["HOLD", 1000]] }],
      },
      {
        offense: [
          { player: "Ada", rules: [["CATCH", 600]] },
          { player: "Dan", rules: [["HOLD", 1000], ["GOAL", 1000]] },
        ],
        defense: [{ player: "Ben", rules: [["HOLD", 1000]] }],
      },
    ],
  },
  {
    league: 3,
    week: 1,
    points: Array.from({ length: 5 }, () => ({
      offense: [
        { player: "Ben", rules: [["CATCH", 400]] },
        { player: "Cy", rules: [["COMPLETION", 700]] },
      ],
      defense: [],
    })),
  },
];

/** A fresh store holding the measure's fixture. */
export function measureFixtureStore(): Db {
  return buildFixtureStore(MEASURE_FIXTURE);
}
