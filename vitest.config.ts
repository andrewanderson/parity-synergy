import { defineConfig } from "vitest/config";

export default defineConfig({
  environment: "node",
  include: ["test/**/*.test.ts"],
  test: {
    // The preview tests read one SQLite store, and one of them inserts a
    // temporary league-25 game into it to prove the rating stays
    // pre-season. Test files run in parallel by default, so the stats
    // test could observe that temporary row and count an extra game.
    // Files run one at a time instead.
    fileParallelism: false,
  },
});
