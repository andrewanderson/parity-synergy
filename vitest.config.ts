import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  environment: "node",
  test: {
    include: ["test/**/*.test.ts"],
    // The live suite reads the store that grows every week and the live
    // Parity API. It runs on its own (`npm run test:live`), so a store
    // that has moved never blocks a commit.
    exclude: [...configDefaults.exclude, "test/**/*.live.test.ts"],
  },
});
