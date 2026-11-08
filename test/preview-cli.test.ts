import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPreview } from "../src/preview/index.js";
import { openDb } from "../src/store/db.js";

describe("buildPreview", () => {
  it("writes a self-contained page with the eight teams", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "preview-"));
    try {
      const db = openDb("parity-synergy.db");
      const out = path.join(dir, "preview.html");
      const result = await buildPreview({
        db,
        baseUrl: "https://parity.kevinhughes27.workers.dev",
        leagueId: 25,
        outPath: out,
      });
      expect(result.teamCount).toBe(8);
      expect(result.byteLength).toBeGreaterThan(1000);
      const html = await readFile(out, "utf8");
      expect(html).toContain("Set Phasers to Huck (Nick)");
      expect(html).not.toMatch(/https?:\/\//);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("carries each team's shared-games total onto the page", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "preview-"));
    try {
      const db = openDb("parity-synergy.db");
      const out = path.join(dir, "preview.html");
      await buildPreview({
        db,
        baseUrl: "https://parity.kevinhughes27.workers.dev",
        leagueId: 25,
        outPath: out,
      });
      const html = await readFile(out, "utf8");
      expect(html).toMatch(/shared games/i);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
