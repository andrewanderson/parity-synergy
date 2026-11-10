import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeGame, normalizePlayerRef } from "parity-mcp/data/normalize";
import type {
  ApiGame,
  GamePayload,
  SupportedLeague,
} from "parity-mcp/domain/types";
import type {
  DataSource,
  LeagueRef,
  ListGamesOptions,
} from "parity-mcp/data/source";
import { ingestGame, ingestLeagues, type IngestOutcome } from "../src/store/ingest.js";
import { openDb, type Db } from "../src/store/db.js";

const league: SupportedLeague = {
  id: 24,
  name: "Winter Indoor Parity 2026",
  statValues: "v2",
  lineSize: 6,
  salaryCalc: "pro_rate",
};

/** Read one captured game from the parity-mcp fixtures, no network. */
function readCapture(id: number): ApiGame {
  const fixturePath = path.resolve(
    process.cwd(),
    "..",
    "parity-mcp",
    "test",
    "fixtures",
    "captures",
    `game-${id}.json`,
  );
  return JSON.parse(readFileSync(fixturePath, "utf8")) as ApiGame;
}

/**
 * The captures the stub can serve: game 1000 (22 players) and game 1001
 * (21 players). The two rosters are disjoint, so game 1001 can prove that
 * an ingest touches only the baselines of its own players.
 */
const captures = new Map<number, ApiGame>([
  [1000, readCapture(1000)],
  [1001, readCapture(1001)],
]);

/**
 * A stub `DataSource` backed only by captured fixture files, no network.
 * Same shape as parity-mcp's `StubSource`: listings carry no point payloads,
 * and `getGame` canonicalizes the capture under the fixed league. It records
 * the league ids it was asked about so a test can assert iteration order.
 */
class StubSource implements DataSource {
  readonly listGamesCalls: number[] = [];

  async listSupportedLeagues(): Promise<SupportedLeague[]> {
    return [league];
  }

  async listGames(
    leagueRef: LeagueRef,
    _options?: ListGamesOptions,
  ): Promise<ApiGame[]> {
    const id = "id" in leagueRef ? leagueRef.id : undefined;
    this.listGamesCalls.push(id ?? -1);
    if (id !== league.id) return [];
    return [...captures.keys()].map((gameId) => {
      const raw = captures.get(gameId) as ApiGame;
      return {
        ...raw,
        homeRoster: [],
        awayRoster: [],
        points: [],
        stats: {},
      };
    });
  }

  async getGame(leagueRef: LeagueRef, gameId: number | string): Promise<GamePayload> {
    const id = "id" in leagueRef ? leagueRef.id : undefined;
    if (id !== league.id) {
      throw new Error(`unsupported league ${String(id)}`);
    }
    const raw = captures.get(Number(gameId));
    if (raw === undefined) {
      throw new Error(`game ${String(gameId)} not found in league ${id}`);
    }
    return canonicalizeGame(raw, league);
  }
}

/** The id a newer league's games carry: a UUID, not a number. */
const UUID = "e5df9c1f-b861-4dc9-bf9f-2514abebb3e9";

/**
 * A stub source that serves the game 1000 capture under a UUID, the way the
 * API reports the games of a newer league. `mutate` changes the canonical
 * payload so that one reconciliation gate fails.
 */
class UuidSource implements DataSource {
  constructor(
    private readonly gameId: string = UUID,
    private readonly mutate?: (payload: GamePayload) => void,
  ) {}

  async listSupportedLeagues(): Promise<SupportedLeague[]> {
    return [league];
  }

  async listGames(): Promise<ApiGame[]> {
    const raw = captures.get(1000) as ApiGame;
    return [{ ...raw, id: this.gameId, homeRoster: [], awayRoster: [], points: [], stats: {} }];
  }

  async getGame(_leagueRef: LeagueRef, gameId: number | string): Promise<GamePayload> {
    if (String(gameId) !== this.gameId) {
      throw new Error(`game ${String(gameId)} not found`);
    }
    const raw = captures.get(1000) as ApiGame;
    const payload = canonicalizeGame({ ...raw, id: this.gameId }, league);
    this.mutate?.(payload);
    return payload;
  }
}

/**
 * A stub source that serves the two captures under the ids and weeks it is
 * given, listed in that order, so a test can pin how the store numbers a
 * league's games.
 */
class ListedSource implements DataSource {
  constructor(
    private readonly games: Array<{ id: string; week: number; capture: number }>,
  ) {}

  async listSupportedLeagues(): Promise<SupportedLeague[]> {
    return [league];
  }

  async listGames(): Promise<ApiGame[]> {
    return this.games.map((game) => {
      const raw = captures.get(game.capture) as ApiGame;
      return {
        ...raw,
        id: game.id,
        week: game.week,
        homeRoster: [],
        awayRoster: [],
        points: [],
        stats: {},
      };
    });
  }

  async getGame(_leagueRef: LeagueRef, gameId: number | string): Promise<GamePayload> {
    const wanted = this.games.find((game) => String(game.id) === String(gameId));
    if (wanted === undefined) {
      throw new Error(`game ${String(gameId)} not found`);
    }
    const raw = captures.get(wanted.capture) as ApiGame;
    return canonicalizeGame({ ...raw, id: wanted.id, week: wanted.week }, league);
  }
}

/** A source whose canonical payload is mutated so that one gate fails. */
class MutatingSource extends StubSource {
  constructor(private readonly mutate: (payload: GamePayload) => void) {
    super();
  }

  override async getGame(
    leagueRef: LeagueRef,
    gameId: number | string,
  ): Promise<GamePayload> {
    const payload = await super.getGame(leagueRef, gameId);
    this.mutate(payload);
    return payload;
  }
}

/** A source that fails before any payload exists: an unreachable league. */
class ThrowingSource extends StubSource {
  override async getGame(): Promise<GamePayload> {
    throw new Error("league unreachable");
  }
}

/** Every baseline row in the store, ordered for a stable comparison. */
function allBaselines(
  db: Db,
): Array<{ name_key: string; metric: string; points: number; total: number; mean: number }> {
  return db
    .prepare(
      `SELECT p.name_key, b.metric, b.points, b.total, b.mean
       FROM player_baselines b
       JOIN players p ON p.player_id = b.player_id
       ORDER BY p.name_key, b.metric`,
    )
    .all() as Array<{
    name_key: string;
    metric: string;
    points: number;
    total: number;
    mean: number;
  }>;
}

function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

let db: Db;
const dirs: string[] = [];

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "synergy-ingest-"));
  dirs.push(dir);
  db = openDb(path.join(dir, "test.db"));
});

afterEach(async () => {
  db.close();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("ingestGame", () => {
  it("ingests a game that reconciles and records it as ok", async () => {
    const outcome = await ingestGame(db, new StubSource(), 24, 1000);
    expect(outcome).toEqual({ gameId: 1000, leagueId: 24, status: "ok" });

    // Exactly one ingest_log row: the one writeGameFacts writes inside its
    // own transaction. A second would mean the ingest logged twice.
    const log = db
      .prepare("SELECT status FROM ingest_log WHERE game_id = 1000")
      .all();
    expect(log).toEqual([{ status: "ok" }]);

    // The facts landed with the fixture's ground-truth counts.
    expect(count(db, "SELECT COUNT(*) AS n FROM games")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM points")).toBe(45);
    expect(count(db, "SELECT COUNT(*) AS n FROM appearance_metric")).toBe(3251);
    expect(count(db, "SELECT COUNT(*) AS n FROM player_baselines")).toBe(434);
  });

  it("rejects a game whose salary does not reconcile and writes nothing", async () => {
    const badSource = new MutatingSource((payload) => {
      payload.stats[0]!.pay += 1;
    });
    const outcome = await ingestGame(db, badSource, 24, 1000);
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toContain("does not match API pay");

    // No facts at all: a rejected game leaves no partial rows.
    expect(count(db, "SELECT COUNT(*) AS n FROM games")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM points")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM appearances")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM players")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM player_baselines")).toBe(0);

    const log = db
      .prepare("SELECT game_id, status, reason FROM ingest_log WHERE external_id = '1000'")
      .get() as { game_id: number | null; status: string; reason: string };
    // The rejection names the game by the API's id: it has no stored game
    // to point at.
    expect(log.game_id).toBeNull();
    expect(log.status).toBe("rejected");
    expect(log.reason).toContain("does not match API pay");
  });

  it("rejects a game whose per-point stats do not reconcile", async () => {
    const badStatsSource = new MutatingSource((payload) => {
      payload.stats[0]!.goals += 1;
    });
    const outcome = await ingestGame(db, badStatsSource, 24, 1000);
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toContain("does not match API");
    expect(count(db, "SELECT COUNT(*) AS n FROM games")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM ingest_log")).toBe(1);
  });

  it("propagates a source error instead of recording a rejection", async () => {
    await expect(
      ingestGame(db, new ThrowingSource(), 24, 1000),
    ).rejects.toThrow("league unreachable");

    // Not fetched, not reconciled, not a rejection: nothing is recorded.
    expect(count(db, "SELECT COUNT(*) AS n FROM ingest_log")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM games")).toBe(0);
  });

  it("is idempotent across repeated ingests", async () => {
    const source = new StubSource();
    await ingestGame(db, source, 24, 1000);
    const before = count(db, "SELECT COUNT(*) AS n FROM appearance_metric");
    await ingestGame(db, source, 24, 1000);
    const after = count(db, "SELECT COUNT(*) AS n FROM appearance_metric");
    expect(after).toBe(before);
    expect(count(db, "SELECT COUNT(*) AS n FROM points")).toBe(45);
    expect(count(db, "SELECT COUNT(*) AS n FROM games")).toBe(1);
  });

  it("touches only the baselines of the players in the ingested game", async () => {
    const source = new StubSource();
    await ingestGame(db, source, 24, 1000);

    // Game 1001's roster is disjoint from game 1000's in the captures.
    const secondKeys = new Set(
      Object.keys((captures.get(1001) as ApiGame).stats).map(
        (raw) => normalizePlayerRef(raw).name.toLowerCase(),
      ),
    );
    const before = allBaselines(db);
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((row) => row.name_key === "jon rowe")).toBe(true);

    const outcome = await ingestGame(db, source, 24, 1001);
    expect(outcome.status).toBe("ok");

    const after = allBaselines(db);

    // A player who did not appear in game 1001 keeps byte-identical baselines.
    const untouchedBefore = before.filter((row) => !secondKeys.has(row.name_key));
    const untouchedAfter = after.filter((row) => !secondKeys.has(row.name_key));
    expect(untouchedBefore.length).toBeGreaterThan(0);
    expect(untouchedAfter).toEqual(untouchedBefore);

    // Game 1001's own players gained baselines, and nothing was lost.
    expect(after.filter((row) => secondKeys.has(row.name_key)).length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    expect(count(db, "SELECT COUNT(*) AS n FROM games")).toBe(2);
  });
});

describe("ingestLeagues", () => {
  it("ingests every listed game in ascending league order and reports progress", async () => {
    const source = new StubSource();
    const progress: IngestOutcome[] = [];
    const outcomes = await ingestLeagues({
      leagues: [24, 23],
      db,
      source,
      onProgress: (outcome) => progress.push(outcome),
    });

    // Ascending id order: league 23 is listed first, and has no games.
    expect(source.listGamesCalls).toEqual([23, 24]);
    expect(outcomes.map((outcome) => outcome.gameId)).toEqual([1000, 1001]);
    expect(outcomes.every((outcome) => outcome.status === "ok")).toBe(true);
    expect(progress).toEqual(outcomes);

    // One log row and one games row per ingested game, not two.
    expect(count(db, "SELECT COUNT(*) AS n FROM ingest_log")).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM games")).toBe(2);
  });
});

describe("games the API identifies by UUID", () => {
  it("ingests a UUID game under an internal id and records the external id", async () => {
    const outcome = await ingestGame(db, new UuidSource(), 24, UUID);
    expect(outcome).toEqual({ gameId: UUID, leagueId: 24, status: "ok" });

    const game = db
      .prepare("SELECT game_id, external_id FROM games")
      .get() as { game_id: number; external_id: string };
    // The store's own id is the row's key: the API's id is not a number and
    // cannot be one.
    expect(Number.isInteger(game.game_id)).toBe(true);
    expect(game.external_id).toBe(UUID);

    const log = db
      .prepare("SELECT game_id, external_id FROM ingest_log")
      .get() as { game_id: number; external_id: string };
    expect(log.external_id).toBe(UUID);
    expect(log.game_id).toBe(game.game_id);

    // The facts landed: the fixture's points.
    expect(count(db, "SELECT COUNT(*) AS n FROM points")).toBe(45);
  });

  it("is idempotent for a UUID game", async () => {
    const source = new UuidSource();
    await ingestGame(db, source, 24, UUID);
    await ingestGame(db, source, 24, UUID);
    expect(count(db, "SELECT COUNT(*) AS n FROM games")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM points")).toBe(45);
  });

  it("logs a rejected UUID game against its external id", async () => {
    const badSource = new UuidSource(UUID, (payload) => {
      payload.stats[0]!.pay += 1;
    });
    const outcome = await ingestGame(db, badSource, 24, UUID);
    expect(outcome.status).toBe("rejected");
    expect(count(db, "SELECT COUNT(*) AS n FROM games")).toBe(0);

    const log = db
      .prepare("SELECT external_id, status FROM ingest_log")
      .get() as { external_id: string; status: string };
    expect(log.external_id).toBe(UUID);
    expect(log.status).toBe("rejected");
  });

  it("gives a UUID game an internal id after the games already stored", async () => {
    await ingestGame(db, new StubSource(), 24, 1000);
    await ingestGame(db, new UuidSource(), 24, UUID);

    const ids = (
      db.prepare("SELECT game_id FROM games ORDER BY game_id").all() as {
        game_id: number;
      }[]
    ).map((row) => row.game_id);
    // Internal ids stay chronological: the rating windows read them as a
    // boundary.
    expect(ids).toEqual([1000, 1001]);
  });

  it("ingests a listed UUID game, which the listing reports as a string", async () => {
    const outcomes = await ingestLeagues({
      leagues: [24],
      db,
      source: new UuidSource(),
    });
    expect(outcomes.map((outcome) => outcome.gameId)).toEqual([UUID]);
    expect(count(db, "SELECT COUNT(*) AS n FROM games")).toBe(1);
  });

  it("does not let a rejected game take the internal id of the next game", async () => {
    const badSource = new UuidSource(UUID, (payload) => {
      payload.stats[0]!.pay += 1;
    });
    const rejected = await ingestGame(db, badSource, 24, UUID);
    expect(rejected.status).toBe("rejected");

    // A rejected game has no stored game, so it claims no internal id: the
    // id it would have had belongs to the game stored after it.
    const rejection = db
      .prepare("SELECT game_id, external_id FROM ingest_log")
      .get() as { game_id: number | null; external_id: string };
    expect(rejection.game_id).toBeNull();
    expect(rejection.external_id).toBe(UUID);

    const next = "11111111-1111-1111-1111-111111111111";
    await ingestGame(db, new UuidSource(next), 24, next);

    const rows = db
      .prepare("SELECT game_id, status FROM ingest_log ORDER BY rowid")
      .all() as { game_id: number | null; status: string }[];
    expect(rows).toEqual([
      { game_id: null, status: "rejected" },
      { game_id: 1, status: "ok" },
    ]);
  });

  it("records the API's id the same way when it looks the game up and when it writes it", async () => {
    // The API's id with stray spaces: the store normalises it once, so the
    // lookup and the write name the same game.
    const source = new ListedSource([{ id: " 1000 ", week: 1, capture: 1000 }]);
    await ingestLeagues({ leagues: [24], db, source });

    const game = db
      .prepare("SELECT game_id, external_id FROM games")
      .get() as { game_id: number; external_id: string };
    expect(game.external_id).toBe("1000");

    // A second ingest finds the same game instead of failing on the unique
    // index over the league and the external id.
    await ingestLeagues({ leagues: [24], db, source });
    expect(count(db, "SELECT COUNT(*) AS n FROM games")).toBe(1);
  });

  it("numbers a league's games in week order, whatever order the listing gives them", async () => {
    const source = new ListedSource([
      { id: "week-two", week: 2, capture: 1001 },
      { id: "week-one", week: 1, capture: 1000 },
    ]);
    await ingestLeagues({ leagues: [24], db, source });

    const rows = db
      .prepare("SELECT game_id, week FROM games ORDER BY game_id")
      .all() as { game_id: number; week: number }[];
    expect(rows).toEqual([
      { game_id: 1, week: 1 },
      { game_id: 2, week: 2 },
    ]);
  });
});
