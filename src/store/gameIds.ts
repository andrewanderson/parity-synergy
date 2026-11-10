import type { Db } from "./db.js";

/**
 * A game id as the API reports it. Newer leagues identify their games by
 * UUID, so an id is a string as often as a number.
 */
export type ExternalGameId = number | string;

/**
 * Normalize an id from the API. The API reports the older numeric ids as
 * JSON strings, so a plain run of digits becomes a number and everything else
 * stays the string it is.
 */
export function normalizeExternalGameId(raw: number | string): ExternalGameId {
  if (typeof raw === "number") return raw;
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/**
 * The internal id a game is stored under.
 *
 * The store keeps its own integer ids and records the API's id in
 * `games.external_id`. The internal id has to stay chronological, because
 * the rating windows read `MIN`/`MAX(game_id)` as their boundary, so a new
 * game is given the next id after the highest one stored.
 *
 * The lookup order is:
 *
 * 1. The game is already stored: its internal id is reused, which is what
 *    makes a re-ingest replace the game's rows instead of duplicating them.
 * 2. The API's id is numeric and that number is free: it becomes the
 *    internal id, so the games of the older leagues keep the ids they have
 *    always had and their order in the store stays the order the API gave
 *    them.
 * 3. Otherwise the next free id after the highest one stored.
 *
 * The external id is normalised the same way here and in `writeGameFacts`,
 * so the id a game is looked up by and the id it is written under are always
 * the same string.
 */
export function resolveGameId(
  db: Db,
  leagueId: number,
  externalId: ExternalGameId,
): number {
  const external = String(normalizeExternalGameId(externalId));

  const stored = db
    .prepare("SELECT game_id FROM games WHERE league_id = ? AND external_id = ?")
    .get(leagueId, external) as { game_id: number } | undefined;
  if (stored !== undefined) return stored.game_id;

  if (/^\d+$/.test(external)) {
    const candidate = Number(external);
    const taken = db
      .prepare("SELECT COUNT(*) AS n FROM games WHERE game_id = ?")
      .get(candidate) as { n: number };
    // A numeric id that is already spoken for belongs to another game, so
    // this one takes the next free id instead.
    if (taken.n === 0) return candidate;
  }

  const next = db
    .prepare("SELECT COALESCE(MAX(game_id), 0) + 1 AS g FROM games")
    .get() as { g: number };
  return next.g;
}
