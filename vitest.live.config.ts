import { defineConfig } from "vitest/config";

/**
 * The live suite: the tests that read the store that grows every week and
 * the live Parity API.
 *
 * It runs on its own, deliberately, because its figures belong to the
 * store rather than to the code. After an ingest, run it to see what
 * moved, then `npm run repin:live` to record the new figures.
 */
export default defineConfig({
  environment: "node",
  test: {
    include: ["test/**/*.live.test.ts"],
    // These files share one SQLite store, and one of them inserts a
    // temporary league-25 game into it. Files run one at a time so the
    // others cannot see that row.
    fileParallelism: false,
  },
});
