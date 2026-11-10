/**
 * Record the live store's current figures.
 *
 * The store grows every week, so the figures the page publishes cannot
 * be pinned in a test: they would be stale by the next ingest. They are
 * recorded here instead, and the diff when this runs is the record of
 * what the new games did to them.
 *
 * Run it after an ingest: `npm run repin:live`.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { computeRatingStats } from "../src/preview/stats.js";
import { openExistingDb } from "../src/store/db.js";
import { PROJECT_ROOT } from "../src/paths.js";

const SNAPSHOT_PATH = path.join(PROJECT_ROOT, "test", "fixtures", "live-store.json");

const db = openExistingDb();
const store = db
  .prepare(
    `SELECT (SELECT COUNT(*) FROM games) games,
            (SELECT COUNT(*) FROM points) points,
            (SELECT COUNT(*) FROM players) players,
            (SELECT COUNT(*) FROM appearances) appearances`,
  )
  .get() as { games: number; points: number; players: number; appearances: number };
const stats = computeRatingStats(db as never);
db.close();

const snapshot = {
  capturedAt: new Date().toISOString(),
  store,
  stats: {
    correlationWithPointDiff: Number(stats.correlationWithPointDiff.toFixed(6)),
    correlationWithSharedPoints: Number(stats.correlationWithSharedPoints.toFixed(6)),
    medianGameMargin: stats.medianGameMargin,
    gamesDecidedByThreeOrFewer: stats.gamesDecidedByThreeOrFewer,
  },
};

writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(
  `wrote ${SNAPSHOT_PATH}: ${store.games} games, ${store.points} points, ${store.players} players, correlation ${snapshot.stats.correlationWithPointDiff}`,
);
