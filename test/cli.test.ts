import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeGame } from "parity-mcp/data/normalize";
import { assembleFullGame } from "parity-mcp/server";
import { buildPointStats } from "parity-mcp/engine/pointStats";
import type { ApiGame, GamePayload, SupportedLeague } from "parity-mcp/domain/types";
import type { DataSource, LeagueRef, ListGamesOptions } from "parity-mcp/data/source";
import { openDb, type Db } from "../src/store/db.js";
import { writeGameFacts } from "../src/store/facts.js";
import { recomputeBaselines } from "../src/store/baselines.js";
import { evaluateTeam } from "../src/query/teams.js";
import { dbPathFromArgv, formatCsvRow, parseArgs, resolveBaseUrl, run } from "../src/cli.js";

const fixturePath = path.resolve(
  process.cwd(),
  "..",
  "parity-mcp",
  "test",
  "fixtures",
  "captures",
  "game-1000.json",
);
const rawGame = JSON.parse(readFileSync(fixturePath, "utf8")) as ApiGame;

const league: SupportedLeague = {
  id: 24,
  name: "Winter Indoor Parity 2026",
  statValues: "v2",
  lineSize: 6,
  salaryCalc: "pro_rate",
};

const payload = canonicalizeGame(rawGame, league);
const full = assembleFullGame(payload);
const pointStats = buildPointStats(payload);

/**
 * A stub `DataSource` backed only by the captured fixture, no network. The
 * id comparison is strict against the number 24, so a league id the CLI
 * failed to coerce to a number would serve no games and fail the test.
 */
class StubSource implements DataSource {
  readonly listGamesCalls: Array<number | string> = [];

  async listSupportedLeagues(): Promise<SupportedLeague[]> {
    return [league];
  }

  async listGames(leagueRef: LeagueRef, _options?: ListGamesOptions): Promise<ApiGame[]> {
    const id = "id" in leagueRef ? leagueRef.id : undefined;
    this.listGamesCalls.push(id ?? -1);
    if (id !== league.id) return [];
    return [{ ...rawGame, homeRoster: [], awayRoster: [], points: [], stats: {} }];
  }

  async getGame(leagueRef: LeagueRef, gameId: number | string): Promise<GamePayload> {
    const id = "id" in leagueRef ? leagueRef.id : undefined;
    if (id !== league.id) throw new Error(`unsupported league ${String(id)}`);
    if (Number(gameId) !== Number(rawGame.id)) {
      throw new Error(`game ${String(gameId)} not found`);
    }
    return canonicalizeGame(rawGame, league);
  }
}

/** A source whose canonical payload fails the salary reconciliation gate. */
class RejectingSource extends StubSource {
  override async getGame(leagueRef: LeagueRef, gameId: number | string): Promise<GamePayload> {
    const game = await super.getGame(leagueRef, gameId);
    game.stats[0]!.pay += 1;
    return game;
  }
}

let db: Db;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "synergy-cli-"));
  db = openDb(path.join(dir, "test.db"));
  recomputeBaselines(db, writeGameFacts(db, full, pointStats));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function count(sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

describe("cli", () => {
  it("prints a table for the leaderboard and exits 0", async () => {
    const result = await run(["leaderboard", "--min-points", "5"], { db });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("points_together");
    // Every column is padded to its width, the last one included, so a
    // right-aligned final column lines up and no line has trailing space.
    const lines = result.stdout.split("\n");
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });

  it("defaults the leaderboard floor to 8 rather than the 5-point floor", async () => {
    // Non-vacuous: the fixture holds pairs with 5 to 7 shared points,
    // which the bare command must exclude...
    const small = count(
      "SELECT COUNT(*) AS n FROM pair_effects WHERE points_together BETWEEN 5 AND 7",
    );
    expect(small).toBeGreaterThan(0);

    const bare = await run(["leaderboard", "--limit", "1000"], { db });
    const atEight = count("SELECT COUNT(*) AS n FROM pair_effects WHERE points_together >= 8");
    expect(bare.stdout.split("\n")).toHaveLength(atEight + 1);

    // ...and an explicit --min-points 5 must show them again.
    const asked = await run(["leaderboard", "--min-points", "5", "--limit", "1000"], { db });
    const atFive = count("SELECT COUNT(*) AS n FROM pair_effects WHERE points_together >= 5");
    expect(atFive).toBeGreaterThan(atEight);
    expect(asked.stdout.split("\n")).toHaveLength(atFive + 1);
  });

  it("rejects an unknown flag instead of silently using a default", async () => {
    const result = await run(["leaderboard", "--limt", "10"], { db });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Unknown flag: --limt");
    expect(result.stderr).toContain("leaderboard");
  });

  it("exits non-zero with a message on an unknown subcommand", async () => {
    const result = await run(["nope"], { db });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Unknown subcommand");
  });

  it("exports the pair_effects view to CSV", async () => {
    const out = path.join(dir, "pairs.csv");
    const result = await run(["export-csv", "--table", "pair_effects", "--out", out], { db });
    expect(result.code).toBe(0);
    const csv = await readFile(out, "utf8");
    expect(csv.split("\n")[0]).toContain("player_a");
  });

  it("exits non-zero when a player is not in the store", async () => {
    const result = await run(["opponents", "Nobody At All"], { db });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not found");
  });

  it("prints usage and exits non-zero with no arguments", async () => {
    const result = await run([], { db });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("parity-synergy leaderboard");
  });

  it("filters the leaderboard by sample size and never shows a pair below the floor", async () => {
    const strict = await run(["leaderboard", "--min-points", "8", "--limit", "1000"], { db });
    const qualifying = count("SELECT COUNT(*) AS n FROM pair_effects WHERE points_together >= 8");
    expect(qualifying).toBeGreaterThan(0);
    expect(strict.stdout.split("\n")).toHaveLength(qualifying + 1); // header + one line per pair

    // Non-vacuous: the view really does hold pairs below the floor, and a
    // flag asking for them must not surface them in a report.
    const belowFloor = count("SELECT COUNT(*) AS n FROM pair_effects WHERE points_together < 5");
    expect(belowFloor).toBeGreaterThan(0);
    const floor = await run(["leaderboard", "--min-points", "1", "--limit", "1000"], { db });
    const atFloor = count("SELECT COUNT(*) AS n FROM pair_effects WHERE points_together >= 5");
    expect(floor.stdout.split("\n")).toHaveLength(atFloor + 1);
  });

  it("honours --limit and the --flag=value form", async () => {
    expect(count("SELECT COUNT(*) AS n FROM pair_effects WHERE points_together >= 5")).toBeGreaterThanOrEqual(2);
    const limited = await run(["leaderboard", "--limit", "2"], { db });
    expect(limited.stdout.split("\n")).toHaveLength(3);

    const equals = await run(["leaderboard", "--min-points=20"], { db });
    const qualifying = count("SELECT COUNT(*) AS n FROM pair_effects WHERE points_together >= 20");
    expect(qualifying).toBeGreaterThan(0);
    expect(equals.stdout.split("\n")).toHaveLength(qualifying + 1);

    // A limit below one would misreport a populated store as empty.
    const zero = await run(["leaderboard", "--limit", "0"], { db });
    expect(zero.code).not.toBe(0);
    expect(zero.stderr).toContain("--limit");
  });

  it("shows the effect column for the requested metric and falls back safely", async () => {
    const goals = await run(["leaderboard", "--metric", "goals"], { db });
    expect(goals.code).toBe(0);
    expect(goals.stdout.split("\n")[0]).toContain("a_goals_delta");

    // An inherited object key must behave like any unknown metric: fall
    // back to the shrunk salary delta rather than crash the query.
    const inherited = await run(["leaderboard", "--metric", "constructor"], { db });
    expect(inherited.code).toBe(0);
    expect(inherited.stdout.split("\n")[0]).toContain("a_shrunk_delta");
  });

  it("reports an empty leaderboard instead of failing", async () => {
    const result = await run(["leaderboard", "--min-points", "9999"], { db });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No pairs with at least 9999 shared points");
    expect(result.stdout.split("\n")).toHaveLength(2);
  });

  it("prints the full pair row", async () => {
    const result = await run(["pair", "Eric Moore", "Geoff Solomon"], { db });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("player_a: eric moore");
    expect(result.stdout).toContain("points_together: 23");
    expect(result.stdout).toContain("a_shrunk_delta:");
    // Full precision, not the tables' two decimals: the baseline must
    // reproduce the delta in a hand check (56500 / 23).
    expect(result.stdout).toContain("a_baseline: 2456.521739130435");
  });

  it("exits non-zero when the pair never shared a point", async () => {
    const result = await run(["pair", "Nobody At All", "Eric Moore"], { db });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("No pair found for Nobody At All and Eric Moore");
  });

  it("exits non-zero when pair is missing its players", async () => {
    const result = await run(["pair", "Eric Moore"], { db });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("pair requires");
  });

  it("prints the opponent table with sample sizes and the per-rule breakdown", async () => {
    const result = await run(["opponents", "Justin Ye"], { db });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const [header, ...rows] = result.stdout.split("\n");
    expect(header).toContain("opponent_name");
    expect(header).toContain("points_against");
    // Both denominators of the headline, so a printed row reconciles.
    expect(header).toContain("total_credit");
    expect(header).toContain("weighted_points");
    expect(header).toContain("affected_delta");
    // All eleven rules, none omitted: the breakdown sums to the headline.
    for (const column of [
      "goal_delta",
      "assist_delta",
      "second_assist_delta",
      "defense_delta",
      "hold_delta",
      "break_delta",
      "throw_away_delta",
      "completion_delta",
      "catch_delta",
      "drop_delta",
      "threw_drop_delta",
    ]) {
      expect(header).toContain(column);
    }
    expect(rows.length).toBeGreaterThan(0);
    // Every row carries those sixteen columns: identity, both sample sizes,
    // the credit, the headline, and the eleven rule deltas.
    const headerCells = header.split(/\s{2,}/);
    expect(headerCells).toHaveLength(16);
    for (const line of rows) {
      expect(line.trim().split(/\s{2,}/)).toHaveLength(headerCells.length);
    }
  });

  it("distinguishes an empty opponent result from a missing player", async () => {
    const empty = await run(["opponents", "Justin Ye", "--min-points", "9999"], { db });
    expect(empty.code).toBe(0);
    expect(empty.stderr).toBe("");
    expect(empty.stdout).toContain("No opponents with at least 9999 points");

    const missing = await run(["opponents", "Nobody At All", "--min-points", "9999"], { db });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("Player not found: Nobody At All");
  });

  it("ingests through the supplied source and reports every game", async () => {
    const source = new StubSource();
    const result = await run(["ingest", "--leagues", "24"], { db, source });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("ok 1000\ningested 1 games, rejected 0");
    // The league id reaches the source as a number: the stub serves only 24.
    expect(source.listGamesCalls).toEqual([24]);
    expect(count("SELECT COUNT(*) AS n FROM points")).toBe(45); // idempotent re-ingest
  });

  it("reports a rejected game with its reason", async () => {
    const result = await run(["ingest", "--leagues", "24"], { db, source: new RejectingSource() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("rejected 1000:");
    expect(result.stdout).toContain("does not match API pay");
    expect(result.stdout).toContain("ingested 0 games, rejected 1");
    expect(count("SELECT COUNT(*) AS n FROM points")).toBe(45); // nothing was replaced
  });

  it("rejects a missing or malformed --leagues value", async () => {
    const missing = await run(["ingest"], { db, source: new StubSource() });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("--leagues");

    const malformed = await run(["ingest", "--leagues", "abc"], { db, source: new StubSource() });
    expect(malformed.code).not.toBe(0);
    expect(malformed.stderr).toContain("Invalid league id: abc");
  });

  it("prints the team's pairs, the risky pairs, and the total with its sample size", async () => {
    const names = ["Eric Moore", "Geoff Solomon", "Jon Rowe"];
    const result = await run(["evaluate", "--team", names.join(",")], { db });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("points_together");
    expect(result.stdout).toContain("risky pairs:");
    const evaluation = evaluateTeam(db, names);
    expect(evaluation.pairs.length).toBeGreaterThan(0);
    expect(result.stdout).toContain(`across ${evaluation.pairs.length} pairs`);
    expect(result.stdout).toContain("team total shrunk delta:");
  });

  it("reports unknown team names to stderr and still evaluates the rest", async () => {
    const result = await run(["evaluate", "--team", "Eric Moore,Nobody At All"], { db });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Nobody At All");
    expect(result.stdout).toContain("team total shrunk delta:");
  });

  it("exits non-zero when --team is missing", async () => {
    const result = await run(["evaluate"], { db });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--team");
  });

  it("exports every row of each allowlisted view", async () => {
    const cases: Array<[string, number]> = [
      ["pair_effects", 96],
      ["opponent_effects", 236],
      ["player_baselines", 434],
    ];
    for (const [table, expected] of cases) {
      const out = path.join(dir, `${table}.csv`);
      const result = await run(["export-csv", "--table", table, "--out", out], { db });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`wrote ${expected} rows`);
      const lines = (await readFile(out, "utf8")).trimEnd().split("\n");
      expect(lines).toHaveLength(expected + 1); // header + data rows
    }
  });

  it("refuses a table outside the allowlist and leaves the store intact", async () => {
    const out = path.join(dir, "evil.csv");
    const result = await run(
      ["export-csv", "--table", "players; DROP TABLE players", "--out", out],
      { db },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Invalid table");
    expect(result.stderr).toContain("pair_effects"); // the allowlist is named
    expect(existsSync(out)).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM players")).toBe(22);
  });

  it("quotes CSV fields containing commas, quotes, or newlines", async () => {
    const nasty = 'has, "quotes"\nand newline';
    const info = db
      .prepare("INSERT INTO players (name, name_key, is_substitute) VALUES (?, ?, 0)")
      .run(nasty, "nasty,csv");
    db.prepare(
      "INSERT INTO player_baselines (player_id, metric, points, total, mean) VALUES (?, ?, 3, 6, 2)",
    ).run(Number(info.lastInsertRowid), nasty);

    const out = path.join(dir, "baselines.csv");
    const result = await run(["export-csv", "--table", "player_baselines", "--out", out], { db });
    expect(result.code).toBe(0);
    const csv = await readFile(out, "utf8");
    expect(csv).toContain('"has, ""quotes""\nand newline"');
  });

  it("formats a CSV record with RFC 4180 quoting and an empty field for null", () => {
    expect(formatCsvRow(["plain", "a,b", 'say "hi"', "line1\nline2", null, 42, -1.5])).toBe(
      'plain,"a,b","say ""hi""","line1\nline2",,42,-1.5',
    );
  });

  it("resolves the ingest base URL from the flag, then the environment, then the default", () => {
    const env = { PARITY_API_BASE_URL: "http://env.example" };
    expect(resolveBaseUrl(parseArgs(["--base-url", "http://flag.example"]), env)).toBe(
      "http://flag.example",
    );
    expect(resolveBaseUrl(parseArgs(["--base-url=http://flag.example"]), env)).toBe(
      "http://flag.example",
    );
    expect(resolveBaseUrl(parseArgs([]), env)).toBe("http://env.example");
    expect(resolveBaseUrl(parseArgs([]), {})).toBe("http://localhost:8000");
    // The flag beats the environment, not the other way round.
    expect(
      resolveBaseUrl(parseArgs(["--base-url", "http://flag.example"]), {
        PARITY_API_BASE_URL: "http://env.example",
      }),
    ).toBe("http://flag.example");
  });

  it("finds the --db path in raw argv for the entry point", () => {
    expect(dbPathFromArgv(["leaderboard", "--db", "x.db"])).toBe("x.db");
    expect(dbPathFromArgv(["--db=x.db", "leaderboard"])).toBe("x.db");
    expect(dbPathFromArgv(["leaderboard", "--db", "a.db", "--db", "b.db"])).toBe("b.db");
    expect(dbPathFromArgv(["leaderboard"])).toBeUndefined();
    // A --db with no usable value yields the default, and `run` reports
    // the missing value itself.
    expect(dbPathFromArgv(["leaderboard", "--db"])).toBeUndefined();
    expect(dbPathFromArgv(["leaderboard", "--db", "--limit", "5"])).toBeUndefined();
  });

  it("runs against the database named by --db instead of the injected one", async () => {
    // The injected store holds the pair, so a "not found" can only come
    // from the empty store named by --db.
    const inInjected = count(
      "SELECT COUNT(*) AS n FROM pair_effects WHERE player_a = 'eric moore' AND player_b = 'geoff solomon'",
    );
    expect(inInjected).toBe(1);

    const other = path.join(dir, "other.db");
    const result = await run(["pair", "Eric Moore", "Geoff Solomon", "--db", other], { db });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("No pair found");
    expect(existsSync(other)).toBe(true);
  });
});
