import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canonicalizeGame } from "parity-mcp/data/normalize";
import { assembleFullGame } from "parity-mcp/server";
import { buildPointStats } from "parity-mcp/engine/pointStats";
import type { ApiGame, SupportedLeague } from "parity-mcp/domain/types";
import { createSynergyServer } from "../src/mcp/server.js";
import { writeGameFacts } from "../src/store/facts.js";
import { recomputeBaselines } from "../src/store/baselines.js";
import { openDb, type Db } from "../src/store/db.js";
import { MIN_SHARED_POINTS } from "../src/query/pairs.js";
import { run } from "../src/cli.js";

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

let db: Db;
let dbPath: string;
let mcp: McpServer;
let client: Client;
const dirs: string[] = [];

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "synergy-mcp-"));
  dirs.push(dir);
  dbPath = path.join(dir, "test.db");
  db = openDb(dbPath);
  recomputeBaselines(db, writeGameFacts(db, full, pointStats));
  mcp = createSynergyServer({ db });
  client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  db.close();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

type CallOK = { ok: true; data: unknown };
type CallErr = { ok: false; isError: true; text: string };
type CallResult = CallOK | CallErr;

async function call(
  target: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const result = await target.callTool({ name, arguments: args });
  const text =
    result.content[0]?.type === "text" ? result.content[0].text : "";
  if (result.isError === true) {
    return { ok: false, isError: true, text };
  }
  return { ok: true, data: JSON.parse(text) as unknown };
}

/** One table row as the query layer returns it. */
type Row = { [column: string]: string | number | null };

function viewCount(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("fixture ground truth", () => {
  it("holds the captured game's known sizes", () => {
    const points = db.prepare("SELECT COUNT(*) AS n FROM points").get() as { n: number };
    const players = db.prepare("SELECT COUNT(*) AS n FROM players").get() as { n: number };
    expect(points.n).toBe(45);
    expect(players.n).toBe(22);
    expect(viewCount("pair_effects")).toBe(96);
    expect(viewCount("opponent_effects")).toBe(236);
    expect(viewCount("player_baselines")).toBe(434);
  });
});

describe("synergy MCP server", () => {
  it("registers exactly the six expected tool names", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "synergy_list_leagues",
      "synergy_opponent_effects",
      "synergy_pair_detail",
      "synergy_pair_leaderboard",
      "synergy_player_profile",
      "synergy_team_evaluation",
    ]);
    await client.close();
  });

  it("synergy_list_leagues returns the fixture's single league with its game count", async () => {
    const result = await call(client, "synergy_list_leagues", {});
    if (!result.ok) throw new Error(result.text);
    const data = result.data as { leagues: Array<{ league_id: number; games: number }> };
    expect(data.leagues).toEqual([{ league_id: 24, games: 1 }]);
  });

  it("returns sample sizes with every effect it reports", async () => {
    const result = await call(client, "synergy_pair_leaderboard", {});
    if (!result.ok) throw new Error(result.text);
    const data = result.data as { pairs: Array<{ points_together: number }> };
    expect(data.pairs.length).toBeGreaterThan(0);
    for (const pair of data.pairs) {
      expect(pair.points_together).toBeGreaterThanOrEqual(MIN_SHARED_POINTS);
    }
  });

  it("keeps pairs below the shared-point floor out of the leaderboard whatever the caller asks for", async () => {
    const result = await call(client, "synergy_pair_leaderboard", {
      minPoints: 1,
      limit: 1000,
    });
    if (!result.ok) throw new Error(result.text);
    const data = result.data as { pairs: Array<{ points_together: number }> };
    expect(data.pairs.length).toBeGreaterThan(0);
    for (const pair of data.pairs) {
      expect(pair.points_together).toBeGreaterThanOrEqual(MIN_SHARED_POINTS);
    }
    // Non-vacuous: the view really does hold pairs below the floor, so the
    // clamp is what keeps them out rather than their absence.
    const below = db
      .prepare("SELECT COUNT(*) AS n FROM pair_effects WHERE points_together < ?")
      .get(MIN_SHARED_POINTS) as { n: number };
    expect(below.n).toBeGreaterThan(0);
  });

  it("synergy_pair_leaderboard defaults to the CLI's bare leaderboard", async () => {
    const result = await call(client, "synergy_pair_leaderboard", {});
    if (!result.ok) throw new Error(result.text);
    const data = result.data as {
      pairs: Array<{ player_a: string; player_b: string; points_together: number }>;
    };

    // The CLI's bare `leaderboard`: same query layer with its own defaults
    // (salary metric, the 8-point default, limit 50), rendered as a table.
    const cli = await run(["leaderboard"], { db });
    expect(cli.code).toBe(0);
    const cliRows = cli.stdout
      .split("\n")
      .slice(1)
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [playerA, playerB, points] = line.trim().split(/\s{2,}/);
        return { player_a: playerA!, player_b: playerB!, points_together: Number(points) };
      });
    expect(cliRows.length).toBeGreaterThan(0);
    expect(
      data.pairs.map((pair) => ({
        player_a: pair.player_a,
        player_b: pair.player_b,
        points_together: pair.points_together,
      })),
    ).toEqual(cliRows);

    // Non-vacuous: the store holds pairs between the 5-point floor and the
    // 8-point default, and the default keeps every one of them out.
    const band = db
      .prepare(
        "SELECT player_a, player_b FROM pair_effects WHERE points_together >= ? AND points_together < ?",
      )
      .all(MIN_SHARED_POINTS, 8) as Array<{ player_a: string; player_b: string }>;
    expect(band.length).toBeGreaterThan(0);
    for (const pair of band) {
      const seen = data.pairs.some(
        (row) =>
          (row.player_a === pair.player_a && row.player_b === pair.player_b) ||
          (row.player_a === pair.player_b && row.player_b === pair.player_a),
      );
      expect(seen).toBe(false);
    }
    for (const row of data.pairs) {
      expect(row.points_together).toBeGreaterThanOrEqual(8);
    }
  });

  it("synergy_pair_detail returns the fixture's most-shared pair", async () => {
    const result = await call(client, "synergy_pair_detail", {
      playerA: "Eric Moore",
      playerB: "Geoff Solomon",
    });
    if (!result.ok) throw new Error(result.text);
    const data = result.data as { pair: Row | null };
    expect(data.pair).not.toBeNull();
    expect(data.pair!.player_a).toBe("eric moore");
    expect(data.pair!.player_b).toBe("geoff solomon");
    expect(data.pair!.points_together).toBe(23);
  });

  it("synergy_pair_detail returns null rather than an error for a pair with no effect", async () => {
    const result = await call(client, "synergy_pair_detail", {
      playerA: "Nobody At All",
      playerB: "Eric Moore",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ pair: null });
  });

  it("synergy_opponent_effects returns sample sizes with every effect", async () => {
    const result = await call(client, "synergy_opponent_effects", { player: "Justin Ye" });
    if (!result.ok) throw new Error(result.text);
    const data = result.data as {
      player: string;
      opponents: Array<{ points_against: number; affected_delta: number }>;
    };
    expect(data.player).toBe("Justin Ye");
    expect(data.opponents.length).toBeGreaterThan(0);
    for (const row of data.opponents) {
      expect(row.points_against).toBeGreaterThanOrEqual(MIN_SHARED_POINTS);
    }
    // Most suppressing opponent first, the query layer's order.
    for (let i = 1; i < data.opponents.length; i++) {
      expect(data.opponents[i]!.affected_delta).toBeGreaterThanOrEqual(
        data.opponents[i - 1]!.affected_delta,
      );
    }
  });

  it("returns a team evaluation with the pair effects and risky pairs", async () => {
    const result = await call(client, "synergy_team_evaluation", {
      team: ["Andrew Croisier", "Angela Mueller"],
    });
    if (!result.ok) throw new Error(result.text);
    const data = result.data as {
      players: string[];
      unknownPlayers: string[];
      pairs: Row[];
      riskyPairs: Row[];
      teamTotalShrunkDelta: number;
    };
    expect(Array.isArray(data.pairs)).toBe(true);
    expect(Array.isArray(data.riskyPairs)).toBe(true);
    expect(data.pairs.length).toBeGreaterThan(0);
    expect(data.players).toEqual(["Andrew Croisier", "Angela Mueller"]);
    expect(data.unknownPlayers).toEqual([]);
    expect(typeof data.teamTotalShrunkDelta).toBe("number");
  });

  it("keeps a sub-5 pair among team members out of the evaluation", async () => {
    // Non-vacuous: this team really holds a pair below the floor, so the
    // exclusion below is the floor working rather than the pair's absence.
    const rawSub5 = db
      .prepare("SELECT points_together FROM pair_effects WHERE player_a = ? AND player_b = ?")
      .get("alisha zhao", "andrew croisier") as { points_together: number } | undefined;
    expect(rawSub5).toBeDefined();
    expect(rawSub5!.points_together).toBeLessThan(MIN_SHARED_POINTS);

    const result = await call(client, "synergy_team_evaluation", {
      team: ["Andrew Croisier", "Angela Mueller", "Alisha Zhao"],
    });
    if (!result.ok) throw new Error(result.text);
    const data = result.data as {
      players: string[];
      unknownPlayers: string[];
      pairs: Row[];
    };
    expect(data.players).toEqual(["Andrew Croisier", "Angela Mueller", "Alisha Zhao"]);
    expect(data.unknownPlayers).toEqual([]);
    expect(data.pairs.length).toBeGreaterThan(0);
    for (const pair of data.pairs) {
      expect(pair.points_together as number).toBeGreaterThanOrEqual(MIN_SHARED_POINTS);
    }
    const keys = data.pairs.map((pair) => `${pair.player_a}/${pair.player_b}`);
    expect(keys).not.toContain("alisha zhao/andrew croisier");
    // The qualifying pair of the same team stays, so the list is not
    // vacuously floor-compliant either.
    expect(keys).toContain("andrew croisier/angela mueller");
  });

  it("synergy_player_profile returns baselines, teammates, and opponents with sample sizes", async () => {
    const result = await call(client, "synergy_player_profile", { player: "Justin Ye" });
    if (!result.ok) throw new Error(result.text);
    const data = result.data as {
      player: string;
      baseline: Array<{ metric: string; points: number; total: number; mean: number }>;
      teammates: Row[];
      opponents: Row[];
    };
    expect(data.player).toBe("Justin Ye");
    expect(data.baseline.length).toBeGreaterThan(0);
    expect(data.teammates.length).toBeGreaterThan(0);
    expect(data.opponents.length).toBeGreaterThan(0);
    for (const row of data.teammates) {
      expect(typeof row.points_together).toBe("number");
    }
    for (const row of data.opponents) {
      expect(typeof row.points_against).toBe("number");
    }
  });

  it("keeps sub-5 rows out of the player profile", async () => {
    // Non-vacuous: this player really has a sub-5 teammate pair and sub-5
    // opponent rows in the store, so the floor has something to remove.
    const sub5Teammates = db
      .prepare(
        "SELECT COUNT(*) AS n FROM pair_effects WHERE (player_a = ? OR player_b = ?) AND points_together < ?",
      )
      .get("andrew croisier", "andrew croisier", MIN_SHARED_POINTS) as { n: number };
    const sub5Opponents = db
      .prepare(
        "SELECT COUNT(*) AS n FROM opponent_effects WHERE player_name = ? AND points_against < ?",
      )
      .get("Andrew Croisier", MIN_SHARED_POINTS) as { n: number };
    expect(sub5Teammates.n).toBeGreaterThan(0);
    expect(sub5Opponents.n).toBeGreaterThan(0);

    const result = await call(client, "synergy_player_profile", { player: "Andrew Croisier" });
    if (!result.ok) throw new Error(result.text);
    const data = result.data as { teammates: Row[]; opponents: Row[] };
    expect(data.teammates.length).toBeGreaterThan(0);
    expect(data.opponents.length).toBeGreaterThan(0);
    for (const row of data.teammates) {
      expect(row.points_together as number).toBeGreaterThanOrEqual(MIN_SHARED_POINTS);
    }
    for (const row of data.opponents) {
      expect(row.points_against as number).toBeGreaterThanOrEqual(MIN_SHARED_POINTS);
    }
    // The specific sub-5 rows are gone while a qualifying row of each kind
    // stays, so neither list passes by being emptied.
    expect(
      data.teammates.some(
        (row) => row.player_a === "alisha zhao" && row.player_b === "andrew croisier",
      ),
    ).toBe(false);
    expect(data.opponents.some((row) => row.opponent_name === "George Payne")).toBe(false);
  });

  it("returns isError with a JSON error body for every tool when the store fails", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["synergy_list_leagues", {}],
      ["synergy_pair_leaderboard", {}],
      ["synergy_pair_detail", { playerA: "Eric Moore", playerB: "Geoff Solomon" }],
      ["synergy_opponent_effects", { player: "Justin Ye" }],
      ["synergy_team_evaluation", { team: ["Andrew Croisier", "Angela Mueller"] }],
      ["synergy_player_profile", { player: "Justin Ye" }],
    ];
    // A closed store is the failure every handler must absorb and report
    // as isError rather than let the call reject.
    db.close();
    try {
      for (const [name, args] of cases) {
        const result = await call(client, name, args);
        if (result.ok) throw new Error(`${name} reported success on a closed store`);
        expect(result.isError).toBe(true);
        const body = JSON.parse(result.text) as { error: string; message: string };
        expect(body.error).toBe("INTERNAL");
        expect(typeof body.message).toBe("string");
        expect(body.message.length).toBeGreaterThan(0);
      }
    } finally {
      // Reopen so afterEach closes an open handle and the rest of the
      // suite (each test builds its own store anyway) is unaffected.
      db = openDb(dbPath);
    }
  });
});
