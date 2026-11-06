import type { Db } from "./db.js";
import type { FullGamePayload } from "parity-mcp/server";
import type { PointStatsPayload } from "parity-mcp/engine/pointStats";
import { normalizePlayerRef, resolvePlayerTeam } from "parity-mcp/data/normalize";
import { playerIdFor, upsertPlayer } from "./baselines.js";

/** One player's entry in the MCP's per-point stat derivation. */
type PointPlayer = PointStatsPayload["points"][number]["players"][number];

/** One player's entry in the MCP's per-point salary ledger. */
type LedgerPlayer = FullGamePayload["salaryLedger"]["points"][number]["playerSalaries"][number];

/**
 * Write one game's point-level facts into the store, replacing any previous
 * write of the same game. Runs in one transaction: the delete of the old
 * rows and every insert commit or roll back together, and the `points`
 * delete cascades to appearances, metrics, rules, components, and weights
 * because `openDb` enables foreign keys on the connection.
 *
 * The MCP owns every derivation: canonicalization, the salary ledger, the
 * per-point stats, player normalization, and team resolution are all read
 * from `payload` and `pointStats`, never recomputed here. The recorded line
 * rows define relationships: a line player's opponents are the opposing
 * line, and an event actor recorded on neither line is assigned the
 * defence side with `line_changed = 1`, facing the offense line they were
 * playing against.
 *
 * Returns the distinct player ids that appeared in the game, in first-seen
 * order, plus any player whose facts this write removed, so the caller can
 * rebuild exactly the baselines the write could have invalidated.
 */
export function writeGameFacts(
  db: Db,
  payload: FullGamePayload,
  pointStats: PointStatsPayload,
): number[] {
  const insertGame = db.prepare(
    `INSERT INTO games
       (game_id, league_id, week, date, home_team, away_team, home_score, away_score, salary_rules_version, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPoint = db.prepare(
    `INSERT INTO points (game_id, point_number, offense_team, defense_team, duration_sec)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertAppearance = db.prepare(
    `INSERT INTO appearances (point_id, player_id, line, is_substitute, touches, line_changed)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMetric = db.prepare(
    `INSERT INTO appearance_metric (point_id, player_id, metric, value)
     VALUES (?, ?, ?, ?)`,
  );
  const insertRule = db.prepare(
    `INSERT INTO salary_rule (point_id, player_id, rule_name, amount)
     VALUES (?, ?, ?, ?)`,
  );
  const insertComponent = db.prepare(
    `INSERT INTO salary_components (point_id, player_id, rule_name, amount, event_index)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertWeight = db.prepare(
    `INSERT INTO opponent_weight (point_id, player_id, opponent_id, weight, weighting)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertLog = db.prepare(
    `INSERT INTO ingest_log (game_id, status, reason, checked_at)
     VALUES (?, 'ok', NULL, ?)`,
  );
  const setDivision = db.prepare(
    "UPDATE players SET division = ? WHERE player_id = ?",
  );
  const deletePoints = db.prepare("DELETE FROM points WHERE game_id = ?");
  const deleteGame = db.prepare("DELETE FROM games WHERE game_id = ?");
  const selectGamePlayers = db.prepare(
    `SELECT DISTINCT a.player_id AS player_id
     FROM appearances a
     JOIN points p ON p.point_id = a.point_id
     WHERE p.game_id = ?
     ORDER BY a.player_id`,
  );

  // Division comes from the stats lines and exists only when the league's
  // teams source was available: absent is unknown, never a guess. It is
  // written when the player row is first created and left alone afterwards,
  // so a later game can never overwrite a known division with an unknown one.
  const divisionByKey = new Map<string, "open" | "women">();
  for (const stat of payload.stats) {
    if (stat.isOpen === undefined) continue;
    divisionByKey.set(stat.name.toLowerCase(), stat.isOpen ? "open" : "women");
  }

  const statsByPoint = new Map(
    pointStats.points.map((point) => [point.pointNumber, point]),
  );
  const ledgerByPoint = new Map(
    payload.salaryLedger.points.map((point) => [point.pointNumber, point]),
  );

  const touched = new Set<number>();
  const playerIds = new Map<string, number>();

  /** Resolve a player id for an identity, creating the row on first sight. */
  const registerPlayer = (key: string, raw: string): number => {
    const cached = playerIds.get(key);
    if (cached !== undefined) return cached;
    const existed = playerIdFor(db, key) !== undefined;
    const ref = normalizePlayerRef(raw);
    const playerId = upsertPlayer(db, ref.name, key, ref.isSubstitute);
    if (!existed) {
      const division = divisionByKey.get(key);
      if (division !== undefined) setDivision.run(division, playerId);
    }
    playerIds.set(key, playerId);
    touched.add(playerId);
    return playerId;
  };

  const write = db.transaction((): number[] => {
    // 1. Replace any previous write of this game; deleting points cascades
    // to every child fact table. Collect the players whose facts this write
    // is about to remove first, so a player who drops out of a re-ingested
    // game still reaches the baseline rebuild.
    const removed = selectGamePlayers.all(payload.game.id) as Array<{
      player_id: number;
    }>;
    deletePoints.run(payload.game.id);
    deleteGame.run(payload.game.id);

    // 2. The game row.
    insertGame.run(
      payload.game.id,
      payload.league.id,
      payload.game.week,
      payload.game.date,
      payload.game.homeTeam,
      payload.game.awayTeam,
      payload.game.homeScore,
      payload.game.awayScore,
      payload.salaryLedger.rulesVersion,
      new Date().toISOString(),
    );

    for (const point of payload.game.points) {
      // 3. The point row. Team columns are informational: the MCP resolves
      // each from the first recorded player of the line, or NULL when the
      // line is empty or the team is unresolvable.
      const offenseTeam =
        point.offensePlayers.length > 0
          ? resolvePlayerTeam(point.offensePlayers[0].raw, payload).team
          : null;
      const defenseTeam =
        point.defensePlayers.length > 0
          ? resolvePlayerTeam(point.defensePlayers[0].raw, payload).team
          : null;
      const pointInfo = insertPoint.run(
        payload.game.id,
        point.pointNumber,
        offenseTeam,
        defenseTeam,
        point.durationSec,
      );
      const pointId = Number(pointInfo.lastInsertRowid);

      const statsPoint = statsByPoint.get(point.pointNumber);
      const statByKey = new Map<string, PointPlayer>(
        statsPoint?.players.map((player) => [player.name.toLowerCase(), player]) ?? [],
      );
      const ledgerPoint = ledgerByPoint.get(point.pointNumber);
      const salaryByKey = new Map<string, LedgerPlayer>(
        ledgerPoint?.playerSalaries.map((entry) => [entry.name.toLowerCase(), entry]) ?? [],
      );

      // 4. Line players, offence row first so a player recorded on both rows
      // takes one appearance with line "offense".
      const offenseKeys = new Set(
        point.offensePlayers.map((player) => normalizePlayerRef(player.raw).name.toLowerCase()),
      );
      const defenseKeys = new Set(
        point.defensePlayers.map((player) => normalizePlayerRef(player.raw).name.toLowerCase()),
      );
      const seen = new Set<string>();
      const lineSpecs: Array<{ key: string; raw: string; line: "offense" | "defense" }> = [];
      for (const player of [...point.offensePlayers, ...point.defensePlayers]) {
        const key = normalizePlayerRef(player.raw).name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        lineSpecs.push({
          key,
          raw: player.raw,
          line: offenseKeys.has(key) ? "offense" : "defense",
        });
      }

      // 5. Event actors on neither recorded line: assigned the defence side
      // with line_changed = 1. They have no line peers, so they form no
      // teammate pairs, but they faced the offense line and pair with it.
      const actorSpecs: Array<{ key: string; raw: string }> = [];
      for (const event of point.events) {
        for (const actor of [event.firstActor, event.secondActor]) {
          if (actor === null) continue;
          const key = normalizePlayerRef(actor).name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          actorSpecs.push({ key, raw: actor });
        }
      }

      // 6-8. One appearance per distinct identity, then its metrics: a
      // salary metric for every appearance (0 when nothing was earned), and
      // the ten stat metrics only for players who acted in an event.
      const offenseSide: Array<{ id: number; touches: number }> = [];
      const defenseSide: Array<{ id: number; touches: number }> = [];
      const idsByKey = new Map<string, number>();

      const writeAppearance = (
        key: string,
        raw: string,
        line: "offense" | "defense",
        lineChanged: number,
      ): void => {
        const playerId = registerPlayer(key, raw);
        idsByKey.set(key, playerId);

        const stat = statByKey.get(key);
        const touches = stat?.touches ?? 0;
        const ref = normalizePlayerRef(raw);
        insertAppearance.run(
          pointId,
          playerId,
          line,
          ref.isSubstitute ? 1 : 0,
          touches,
          lineChanged,
        );
        (line === "offense" ? offenseSide : defenseSide).push({ id: playerId, touches });

        const salary = salaryByKey.get(key);
        if (salary === undefined) {
          throw new Error(
            `parity-mcp ledger has no entry for ${raw} on point ${point.pointNumber}`,
          );
        }
        insertMetric.run(pointId, playerId, "salary", salary.total);
        if (stat !== undefined && stat.touches > 0) {
          for (const [metric, value] of Object.entries(stat.counts)) {
            insertMetric.run(pointId, playerId, metric, value);
          }
        }
      };

      for (const spec of lineSpecs) {
        writeAppearance(spec.key, spec.raw, spec.line, 0);
      }
      for (const spec of actorSpecs) {
        writeAppearance(spec.key, spec.raw, "defense", 1);
      }

      // 9-10. The salary decomposition: one row per rule holding that
      // rule's summed contribution, and one row per component so any
      // salary figure stays auditable down to the event index.
      for (const salary of salaryByKey.values()) {
        const playerId = idsByKey.get(salary.name.toLowerCase());
        if (playerId === undefined) {
          throw new Error(
            `parity-mcp ledger lists ${salary.name} on point ${point.pointNumber} with no appearance`,
          );
        }
        const ruleTotals = new Map<string, number>();
        for (const component of salary.components) {
          ruleTotals.set(
            component.ruleName,
            (ruleTotals.get(component.ruleName) ?? 0) + component.amount,
          );
        }
        for (const [ruleName, total] of ruleTotals) {
          insertRule.run(pointId, playerId, ruleName, total);
        }
        for (const component of salary.components) {
          insertComponent.run(
            pointId,
            playerId,
            component.ruleName,
            component.amount,
            component.eventIndex,
          );
        }
      }

      // 11. Opponent weights in both directions, over the appearance lines:
      // each player's distribution is across the whole opposing side and
      // sums to 1. A zero-touch opponent divides by the side's full touch
      // total and so receives weight 0; when the whole opposing side touched
      // nothing, the weight splits equally instead. Sides come from each
      // player's single appearance line, so a player recorded on both rows
      // faces only the other side and is never their own opponent.
      const addWeights = (
        from: Array<{ id: number; touches: number }>,
        against: Array<{ id: number; touches: number }>,
      ): void => {
        const total = against.reduce((sum, opponent) => sum + opponent.touches, 0);
        const weighting = total > 0 ? "involvement" : "equal";
        for (const player of from) {
          for (const opponent of against) {
            if (opponent.id === player.id) continue;
            const weight =
              total > 0 ? opponent.touches / total : 1 / against.length;
            insertWeight.run(pointId, player.id, opponent.id, weight, weighting);
          }
        }
      };
      addWeights(offenseSide, defenseSide);
      addWeights(defenseSide, offenseSide);
    }

    // 12. The ingest log, inside the same transaction as the facts.
    insertLog.run(payload.game.id, new Date().toISOString());

    // Removed players are appended after the written players: a player who
    // appears in the new version keeps its first-seen position, so a
    // byte-identical re-ingest returns the same list in the same order.
    for (const row of removed) touched.add(row.player_id);

    return [...touched];
  });

  return write();
}
