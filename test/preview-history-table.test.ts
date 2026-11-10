import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  appendHistory,
  latestHistory,
  openHistoryTable,
  previousEntry,
  rosterSignature,
  type HistoryEntry,
} from "../src/preview/history-table.js";
import { hasPreviousReport, previousReport, rosterChangedSince } from "../src/preview/rosters.js";

/**
 * These tests use an in-memory store, never the real one. The history
 * table holds the report's memory, and a unit test that deleted from it
 * would destroy the user's record of their season.
 */
function openStore() {
  const db = new Database(":memory:");
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
    expect(previousEntry(db, 25, "Nobody", 1017)).toBeUndefined();
    db.close();
  });
});

describe("a history table that predates the measure column", () => {
  it("is migrated, and its rows are labelled with the old measure", () => {
    const db = new Database(":memory:");
    // The shape the table had before the rating moved from hold-and-break
    // to whole salary.
    db.exec(`CREATE TABLE synergy_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      team_name TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      taken_at TEXT NOT NULL,
      rating REAL NOT NULL,
      pair_count INTEGER NOT NULL,
      shared_point_count INTEGER NOT NULL,
      shared_game_count INTEGER NOT NULL,
      roster_signature TEXT NOT NULL,
      game_high_water INTEGER NOT NULL,
      UNIQUE (league_id, team_name, game_high_water)
    )`);
    db.prepare(
      `INSERT INTO synergy_history
         (league_id, team_name, entry_type, taken_at, rating, pair_count,
          shared_point_count, shared_game_count, roster_signature, game_high_water)
       VALUES (25, 'Set Phasers to Huck (Nick)', 'season_opening', '2026-11-08T00:00:00.000Z',
               65.42, 24, 1504, 54, 'abc123', 1017)`,
    ).run();

    // The read helpers must not fail on the old shape, and its rows must
    // not be read as if they were whole-salary ratings.
    expect(latestHistory(db, 25).size).toBe(0);
    expect(previousEntry(db, 25, "Set Phasers to Huck (Nick)", 1017)).toBeUndefined();

    openHistoryTable(db);
    const columns = db.prepare("PRAGMA table_info(synergy_history)").all() as { name: string }[];
    expect(columns.some((column) => column.name === "measure")).toBe(true);
    const rows = db.prepare("SELECT measure FROM synergy_history").all() as { measure: string }[];
    expect(rows[0]!.measure).toBe("hold_break");
    // The old rows are still there, and still invisible to the report.
    expect(rows).toHaveLength(1);
    expect(latestHistory(db, 25).size).toBe(0);
    // The table's unique key includes the measure, so a rating under the
    // old measure cannot block one under the current measure.
    appendHistory(db, [entry]);
    expect(
      db.prepare("SELECT COUNT(*) c FROM synergy_history WHERE league_id = 25").get(),
    ).toEqual({ c: 2 });
    db.close();
  });
});

describe("entries recorded under another measure", () => {
  it("ignores them when reading the history", () => {
    const db = openStore();
    db.prepare(
      `INSERT INTO synergy_history
         (league_id, team_name, entry_type, taken_at, rating, pair_count,
          shared_point_count, shared_game_count, roster_signature, game_high_water, measure)
       VALUES (25, 'Set Phasers to Huck (Nick)', 'ingest', '2026-11-01T00:00:00.000Z',
               65.42, 24, 1504, 54, 'abc123', 1000, 'hold_break')`,
    ).run();
    // A hold-and-break rating cannot be compared with a whole-salary one.
    expect(previousEntry(db, 25, "Set Phasers to Huck (Nick)", 1017)).toBeUndefined();
    expect(latestHistory(db, 25).size).toBe(0);
    db.close();
  });

  it("records the new measure beside the old one for the same games", () => {
    const db = openStore();
    db.prepare(
      `INSERT INTO synergy_history
         (league_id, team_name, entry_type, taken_at, rating, pair_count,
          shared_point_count, shared_game_count, roster_signature, game_high_water, measure)
       VALUES (25, 'Set Phasers to Huck (Nick)', 'season_opening', '2026-11-08T00:00:00.000Z',
               65.42, 24, 1504, 54, 'abc123', 1017, 'hold_break')`,
    ).run();
    appendHistory(db, [entry]);
    const rows = db
      .prepare("SELECT measure, rating FROM synergy_history ORDER BY measure")
      .all() as { measure: string; rating: number }[];
    // The old rating is left alone: it cannot be compared with the new
    // one, and the report reads only the current measure.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.measure)).toEqual(["hold_break", "salary"]);
    // The report sees the current measure's figure.
    expect(previousEntry(db, 25, "Set Phasers to Huck (Nick)", 1018)?.rating).toBeCloseTo(65.42, 5);
    db.close();
  });
});

describe("rosterSignature", () => {
  it("is the same for a roster however its players are ordered", () => {
    expect(rosterSignature([3, 1, 2])).toBe(rosterSignature([1, 2, 3]));
  });

  it("differs when a player joins or leaves", () => {
    expect(rosterSignature([1, 2, 3])).not.toBe(rosterSignature([1, 2, 4]));
  });
});

describe("previousReport", () => {
  it("skips the entry at the current game mark, so a re-render compares with the report before it", () => {
    const db = openStore();
    appendHistory(db, [
      { ...entry, rating: 10, gameHighWater: 1000 },
      { ...entry, rating: 20, gameHighWater: 1017 },
    ]);
    // The current report sits at 1017, so the comparison is against the
    // entry at 1000, not against the current report's own row.
    expect(previousReport(db, 25, entry.teamName, 1017)?.rating).toBeCloseTo(10, 5);
    db.close();
  });

  it("finds the entry at the current mark when there is nothing below it", () => {
    const db = openStore();
    appendHistory(db, [{ ...entry, rating: 20, gameHighWater: 1017 }]);
    // Only one report exists, so there is nothing earlier to compare
    // against: the caller must not treat the report as its own
    // comparison.
    expect(previousReport(db, 25, entry.teamName, 1017)).toBeUndefined();
    db.close();
  });

  it("reports that a comparison exists once there is an earlier report", () => {
    const db = openStore();
    expect(hasPreviousReport(db, 25, entry.teamName, 1017)).toBe(false);
    appendHistory(db, [{ ...entry, rating: 20, gameHighWater: 1017 }]);
    // The only row is the current report's own, which is still a
    // previous report: the card says no change since the last report.
    expect(hasPreviousReport(db, 25, entry.teamName, 1017)).toBe(true);
    appendHistory(db, [{ ...entry, rating: 10, gameHighWater: 1000 }]);
    expect(hasPreviousReport(db, 25, entry.teamName, 1017)).toBe(true);
    db.close();
  });
});

describe("rosterChangedSince", () => {
  it("is false when the roster is the same as it was", () => {
    const db = openStore();
    appendHistory(db, [{ ...entry, rosterSignature: "1,2,3", gameHighWater: 1017 }]);
    expect(rosterChangedSince(db, 25, entry.teamName, 1017, "1,2,3")).toBe(false);
    db.close();
  });

  it("is true when the roster changed at the same game mark", () => {
    // A trade before the next ingest: the games have not advanced, but
    // the people on the roster have, and the card must say so.
    const db = openStore();
    appendHistory(db, [{ ...entry, rosterSignature: "1,2,3", gameHighWater: 1017 }]);
    expect(rosterChangedSince(db, 25, entry.teamName, 1017, "1,2,4")).toBe(true);
    db.close();
  });

  it("is true when the roster changed in an earlier report too", () => {
    const db = openStore();
    appendHistory(db, [
      { ...entry, rosterSignature: "1,2,3", gameHighWater: 1000 },
      { ...entry, rosterSignature: "1,2,3", gameHighWater: 1017 },
    ]);
    expect(rosterChangedSince(db, 25, entry.teamName, 1017, "1,2,4")).toBe(true);
    db.close();
  });

  it("is false when there is no history to compare against", () => {
    const db = openStore();
    expect(rosterChangedSince(db, 25, entry.teamName, 1017, "1,2,4")).toBe(false);
    db.close();
  });
});

describe("reading a store with no history table", () => {
  it("returns nothing rather than failing", () => {
    // A store that has never recorded a report has no history table, and
    // the read helpers must not try to create one.
    const db = new Database(":memory:");
    expect(latestHistory(db, 25).size).toBe(0);
    expect(previousEntry(db, 25, "Nobody", 1017)).toBeUndefined();
    db.close();
  });
});
