import type { Db } from "./db.js";

/**
 * The stored player id for a case-insensitive identity key, or `undefined`
 * when no player row has been recorded under that key.
 */
export function playerIdFor(db: Db, nameKey: string): number | undefined {
  const row = db
    .prepare("SELECT player_id FROM players WHERE name_key = ?")
    .get(nameKey) as { player_id: number } | undefined;
  return row?.player_id;
}

/**
 * Insert a player row keyed by `name_key` and return its id. When the row
 * already exists it is left untouched: the first recorded display name and
 * substitute status win, matching the MCP's identity registry.
 */
export function upsertPlayer(
  db: Db,
  name: string,
  nameKey: string,
  isSubstitute: boolean,
): number {
  const existing = playerIdFor(db, nameKey);
  if (existing !== undefined) return existing;
  const info = db
    .prepare("INSERT INTO players (name, name_key, is_substitute) VALUES (?, ?, ?)")
    .run(name, nameKey, isSubstitute ? 1 : 0);
  return Number(info.lastInsertRowid);
}

/**
 * Recompute `player_baselines` for exactly the given players, from their
 * facts across the whole store. Each player's rows are replaced, never
 * patched: a metric whose facts disappeared loses its row instead of
 * keeping a stale total. `points` is the player's appearance count (one
 * row per point, so a player on both lines of a point counts once), and
 * `mean` is always `total / points`, computed fresh on every call, never
 * accumulated. A player with no appearances ends with no baseline rows.
 *
 * Two metric families are written: the stat metrics plus `salary` as they
 * appear in `appearance_metric`, and one `salary:<RULE>` row per rule with
 * facts in `salary_rule`, carrying that rule's total amount.
 */
export function recomputeBaselines(db: Db, playerIds: number[]): void {
  const clear = db.prepare("DELETE FROM player_baselines WHERE player_id = ?");
  const insert = db.prepare(
    "INSERT INTO player_baselines (player_id, metric, points, total, mean) VALUES (?, ?, ?, ?, ?)",
  );
  const pointsStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM appearances WHERE player_id = ?",
  );
  const metricStmt = db.prepare(
    "SELECT metric, SUM(value) AS total FROM appearance_metric WHERE player_id = ? GROUP BY metric",
  );
  const ruleStmt = db.prepare(
    "SELECT rule_name, SUM(amount) AS total FROM salary_rule WHERE player_id = ? GROUP BY rule_name",
  );

  const recompute = db.transaction((ids: number[]): void => {
    for (const playerId of ids) {
      clear.run(playerId);
      const points = (pointsStmt.get(playerId) as { n: number }).n;
      const metrics = metricStmt.all(playerId) as Array<{
        metric: string;
        total: number;
      }>;
      for (const row of metrics) {
        const mean = points === 0 ? 0 : row.total / points;
        insert.run(playerId, row.metric, points, row.total, mean);
      }
      const rules = ruleStmt.all(playerId) as Array<{
        rule_name: string;
        total: number;
      }>;
      for (const rule of rules) {
        const mean = points === 0 ? 0 : rule.total / points;
        insert.run(playerId, `salary:${rule.rule_name}`, points, rule.total, mean);
      }
    }
  });
  recompute(playerIds);
}
