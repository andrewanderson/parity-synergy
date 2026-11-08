import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  appendHistory,
  latestHistory,
  openHistoryTable,
  previousEntry,
  type HistoryEntry,
} from "../src/preview/history-table.js";

function openStore() {
  const db = new Database("parity-synergy.db");
  openHistoryTable(db);
  return db;
}

const entry: HistoryEntry = {
  leagueId: 25,
  teamName: "Set Phasers to Huck (Nick)",
  entryType: "ingest",
  takenAt: "2026-11-08T10:00:00.000Z",
  rating: 65.42,
  pairCount: 24,
  sharedPointCount: 1504,
  sharedGameCount: 54,
  rosterSignature: "abc123",
  gameHighWater: 1017,
};

describe("openHistoryTable", () => {
  it("creates the table and is safe to run twice", () => {
    const db = openStore();
    openHistoryTable(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='synergy_history'")
      .get();
    expect(row).toBeDefined();
    db.close();
  });
});

describe("appendHistory", () => {
  it("stores an entry and reads it back", () => {
    const db = openStore();
    db.prepare("DELETE FROM synergy_history").run();
    appendHistory(db, [entry]);
    const stored = db.prepare("SELECT * FROM synergy_history").all() as Record<string, unknown>[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.team_name).toBe("Set Phasers to Huck (Nick)");
    expect(stored[0]!.league_id).toBe(25);
    expect(stored[0]!.rating).toBeCloseTo(65.42, 5);
    expect(stored[0]!.game_high_water).toBe(1017);
    db.close();
  });

  it("keeps many seasons apart", () => {
    const db = openStore();
    db.prepare("DELETE FROM synergy_history").run();
    appendHistory(db, [
      { ...entry, leagueId: 25, teamName: "A" },
      { ...entry, leagueId: 26, teamName: "A" },
      { ...entry, leagueId: 26, teamName: "B" },
    ]);
    const rows = db
      .prepare("SELECT league_id, team_name FROM synergy_history ORDER BY league_id, team_name")
      .all() as { league_id: number; team_name: string }[];
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.league_id === 25)).toHaveLength(1);
    expect(rows.filter((r) => r.league_id === 26)).toHaveLength(2);
    db.close();
  });

  it("does not store the same league and team twice for one game mark", () => {
    const db = openStore();
    db.prepare("DELETE FROM synergy_history").run();
    appendHistory(db, [entry]);
    appendHistory(db, [entry]);
    const count = db.prepare("SELECT COUNT(*) c FROM synergy_history").get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });
});

describe("latestHistory", () => {
  it("returns the most recent entry per team for a league", () => {
    const db = openStore();
    db.prepare("DELETE FROM synergy_history").run();
    appendHistory(db, [
      { ...entry, rating: 10, takenAt: "2026-11-01T00:00:00.000Z", gameHighWater: 1000 },
      { ...entry, rating: 20, takenAt: "2026-11-08T00:00:00.000Z", gameHighWater: 1017 },
    ]);
    const latest = latestHistory(db, 25);
    expect(latest.get("Set Phasers to Huck (Nick)")?.rating).toBeCloseTo(20, 5);
    db.close();
  });
});

describe("previousEntry", () => {
  it("finds the entry before the given game mark, ignoring other leagues", () => {
    const db = openStore();
    db.prepare("DELETE FROM synergy_history").run();
    appendHistory(db, [
      { ...entry, rating: 10, takenAt: "2026-11-01T00:00:00.000Z", gameHighWater: 1000 },
      { ...entry, rating: 20, takenAt: "2026-11-08T00:00:00.000Z", gameHighWater: 1017 },
      { ...entry, leagueId: 26, rating: 99, gameHighWater: 1000 },
    ]);
    const previous = previousEntry(db, 25, "Set Phasers to Huck (Nick)", 1017);
    expect(previous?.rating).toBeCloseTo(10, 5);
    db.close();
  });

  it("is undefined when there is no earlier entry", () => {
    const db = openStore();
    db.prepare("DELETE FROM synergy_history").run();
    expect(previousEntry(db, 25, "Nobody", 1017)).toBeUndefined();
    db.close();
  });
});
