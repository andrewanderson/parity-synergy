import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ParityApiSource } from "parity-mcp/data/api";
import type { DataSource } from "parity-mcp/data/source";
import {
  MIN_SHARED_POINTS,
  PAIR_METRICS,
  isSupportedMetric,
  nameKeyFor,
  pairDetail,
  pairLeaderboard,
} from "./query/pairs.js";
import { opponentEffects } from "./query/opponents.js";
import { evaluateTeam } from "./query/teams.js";
import { playerIdFor } from "./store/baselines.js";
import { openDb, type Db } from "./store/db.js";
import { ingestLeagues } from "./store/ingest.js";

/** Everything `run` needs from its caller: an open store and, for `ingest`, a source. */
export type CliDeps = {
  db: Db;
  source?: DataSource;
};

/** The collected result of one invocation. `run` never writes to the console itself. */
export type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/** One table row as the query layer returns it: column name to cell value. */
type Row = { [column: string]: string | number | null };

/** The parsed remainder of the argument list: `--flag value`/`--flag=value` plus positionals. */
export type ParsedArgs = {
  flags: Map<string, string | true>;
  positionals: string[];
};

/** A usage error: the message is shown to the user as-is and reported with exit code 1. */
class CliError extends Error {}

/** The subcommand synopsis, shown for a missing or unknown subcommand. */
const USAGE = [
  "Usage:",
  "  parity-synergy ingest --leagues 20,21,22,23,24 [--db <path>] [--base-url <url>]",
  "  parity-synergy leaderboard [--metric salary] [--min-points 8] [--limit 50] [--db <path>]",
  "  parity-synergy pair <player-a> <player-b> [--db <path>]",
  "  parity-synergy opponents <player> [--min-points 5] [--db <path>]",
  '  parity-synergy evaluate --team "A,B,C,D,E,F" [--db <path>]',
  "  parity-synergy export-csv --table pair_effects --out pairs.csv [--db <path>]",
];

const COMMANDS = ["ingest", "leaderboard", "pair", "opponents", "evaluate", "export-csv"];

/**
 * The tables `export-csv` may name. This name is the one value in the CLI
 * that reaches SQL as text, so it is checked against this allowlist
 * before any statement is built.
 */
const EXPORTABLE_TABLES = ["pair_effects", "opponent_effects", "player_baselines"];

/**
 * The `opponents` table: identity, both sample sizes and the credit they
 * divide, then the headline and all eleven per-rule deltas. Every delta is
 * credit per weighted point, so the rule columns add up to `affected_delta`
 * and a reader can reconcile a printed row by hand; the CSV export carries
 * the unrounded figures.
 */
const OPPONENT_COLUMNS = [
  "opponent_name",
  "points_against",
  "total_credit",
  "weighted_points",
  "affected_delta",
  "goal_delta",
  "assist_delta",
  "second_assist_delta",
  "defense_delta",
  "hold_delta",
  "break_delta",
  "throw_away_delta",
  "completion_delta",
  "catch_delta",
  "drop_delta",
  "threw_drop_delta",
];

/** The `evaluate` pair table: both members, the shared-point sample, and the salary effect. */
const PAIR_COLUMNS = ["player_a", "player_b", "points_together", "a_shrunk_delta", "b_shrunk_delta"];

/**
 * The leaderboard's default minimum shared points: the shrinkage
 * half-weight threshold (k = 8), where a pair's measured delta reaches
 * half its raw value. The 5-point floor still applies below it, so the
 * effective default is `max(8, MIN_SHARED_POINTS)`.
 */
const LEADERBOARD_MIN_POINTS_DEFAULT = 8;

/** The flags each subcommand accepts. `--db` is accepted by all of them. */
const ALLOWED_FLAGS: Record<string, string[]> = {
  ingest: ["leagues", "base-url", "db"],
  leaderboard: ["metric", "min-points", "limit", "db"],
  pair: ["db"],
  opponents: ["min-points", "db"],
  evaluate: ["team", "db"],
  "export-csv": ["table", "out", "db"],
};

/**
 * Split the tokens after the subcommand: `--flag value` and `--flag=value`
 * become flags, everything else becomes a positional. A flag with no value
 * records `true`, which the typed readers below reject as a missing value.
 * Flags live in a Map so a hostile name such as `__proto__` cannot reach
 * an object prototype.
 */
export function parseArgs(tokens: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      i += 1;
    } else {
      flags.set(body, true);
    }
  }
  return { flags, positionals };
}

/** The positional argument at `index`, or undefined when it was not given. */
function positional(parsed: ParsedArgs, index: number): string | undefined {
  return parsed.positionals[index];
}

/** The string value of `name`, or undefined when the flag is absent. */
function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new CliError(`--${name} needs a value`);
  return value;
}

/** The integer value of `name`, or `fallback` when the flag is absent. */
function flagInteger(parsed: ParsedArgs, name: string, fallback: number): number {
  const raw = flagString(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new CliError(`--${name} must be an integer, got "${raw}"`);
  return value;
}

/**
 * The sample floor for a report: `defaultMinPoints` when the flag is
 * absent, clamped up to `MIN_SHARED_POINTS` either way. Pairs below the
 * 5-point floor are excluded from reports whatever the caller asks for,
 * so the clamp can raise the value but never lower it.
 */
function reportMinPoints(parsed: ParsedArgs, name: string, defaultMinPoints: number): number {
  return Math.max(flagInteger(parsed, name, defaultMinPoints), MIN_SHARED_POINTS);
}

/**
 * Reject a flag the subcommand does not know. A typo such as `--limt 10`
 * would otherwise silently fall back to a default and report a number
 * the user never asked for, so an unknown flag is an error, not a
 * warning.
 */
function validateFlags(command: string, parsed: ParsedArgs): void {
  const allowed = ALLOWED_FLAGS[command]!;
  for (const name of parsed.flags.keys()) {
    if (!allowed.includes(name)) {
      throw new CliError(`Unknown flag: --${name} for ${command}`);
    }
  }
}

/** One cell as the tables show it: null and undefined are empty, floats carry two decimals. */
function formatCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return value;
}

/**
 * One value of the `pair` detail: full precision, so a reader working by
 * hand can reconcile `a_delta = a_salary_with_b - a_baseline * n` from
 * the printed figures alone. The tables round for readability; the CSV
 * export and this view carry the exact numbers.
 */
function formatDetail(value: string | number | null): string {
  if (value === null) return "";
  return typeof value === "number" ? String(value) : value;
}

/**
 * Render a plain-text table: one header line, one line per row, columns
 * padded to the widest cell and separated by two spaces. A column holding
 * only numbers is right-aligned so magnitudes line up. Every column,
 * including the last, is aligned to its width; trailing whitespace is
 * then trimmed so lines end at the value rather than at padding.
 */
function renderTable(columns: string[], rows: Row[]): string[] {
  const cells = rows.map((row) => columns.map((column) => formatCell(row[column])));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((cellsRow) => cellsRow[index]!.length)),
  );
  const rightAligned = columns.map(
    (column) => rows.length > 0 && rows.every((row) => typeof row[column] === "number"),
  );
  const line = (values: string[]): string =>
    values
      .map((value, index) =>
        rightAligned[index] ? value.padStart(widths[index]!) : value.padEnd(widths[index]!),
      )
      .join("  ")
      .trimEnd();
  return [line(columns), ...cells.map(line)];
}

/**
 * The `a_` and `b_` effect columns for a leaderboard metric: `salary`
 * reports the shrunk delta, every other supported metric its own delta.
 * The caller validates the metric against the supported set first, so
 * this only ever names columns the view exposes, and it does not consult
 * the row: an empty result must still label its columns with the metric
 * that was asked for.
 */
function effectColumns(metric: string): [string, string] {
  const suffix = metric === "salary" ? "shrunk_delta" : `${metric}_delta`;
  return [`a_${suffix}`, `b_${suffix}`];
}

/** One CSV field: quoted only when it holds a comma, a double quote, or a newline. */
function formatCsvField(value: string | number | null): string {
  if (value === null) return "";
  const text = typeof value === "number" ? String(value) : value;
  if (!/[\n\r,"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** One CSV record: fields joined by commas, null written as an empty field. */
export function formatCsvRow(values: Array<string | number | null>): string {
  return values.map(formatCsvField).join(",");
}

/**
 * The ingest source's base URL: `--base-url` wins over the
 * `PARITY_API_BASE_URL` environment variable, which wins over the local
 * default. Pure so the precedence can be pinned without a network.
 */
export function resolveBaseUrl(
  parsed: ParsedArgs,
  env: Record<string, string | undefined>,
): string {
  return flagString(parsed, "base-url") ?? env.PARITY_API_BASE_URL ?? "http://localhost:8000";
}

/**
 * The `--db` path carried by raw argv, for the entry point: a `--db
 * <path>` token pair or a `--db=<path>` token, last one wins the way the
 * flag parser keeps it. A `--db` with no usable value yields undefined,
 * so the entry falls back to the default store and `run` reports the
 * missing value itself.
 */
export function dbPathFromArgv(argv: string[]): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--db=")) {
      found = token.slice("--db=".length);
      continue;
    }
    if (token === "--db") {
      const next = argv[i + 1];
      found = next !== undefined && !next.startsWith("--") ? next : undefined;
    }
  }
  return found;
}

/**
 * `ingest --leagues <ids>`: fetch, verify, and store every listed game,
 * one line per game and a summary line. The caller-supplied source wins
 * over `--base-url`, so tests never touch the network; otherwise the
 * source is a `ParityApiSource` built from `resolveBaseUrl`'s
 * precedence: `--base-url`, then `PARITY_API_BASE_URL`, then the local
 * default.
 */
async function cmdIngest(parsed: ParsedArgs, deps: CliDeps, out: string[]): Promise<number> {
  const rawLeagues = flagString(parsed, "leagues");
  if (rawLeagues === undefined) {
    throw new CliError("ingest requires --leagues <comma-separated ids>");
  }
  const tokens = rawLeagues
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  for (const token of tokens) {
    // The registry resolves ids with a strict numeric comparison, so the
    // ids must be numbers rather than the strings the flag carries.
    if (!/^\d+$/.test(token)) throw new CliError(`Invalid league id: ${token}`);
  }
  if (tokens.length === 0) throw new CliError("ingest requires --leagues <comma-separated ids>");
  const leagues = tokens.map(Number);

  const source = deps.source ?? new ParityApiSource({ baseUrl: resolveBaseUrl(parsed, process.env) });

  const outcomes = await ingestLeagues({
    leagues,
    db: deps.db,
    source,
    onProgress: (outcome) => {
      out.push(
        outcome.status === "ok"
          ? `ok ${outcome.gameId}`
          : `rejected ${outcome.gameId}: ${outcome.reason ?? "unknown reason"}`,
      );
    },
  });
  const ingested = outcomes.filter((outcome) => outcome.status === "ok").length;
  out.push(`ingested ${ingested} games, rejected ${outcomes.length - ingested}`);
  return 0;
}

/**
 * `leaderboard`: the teammate pairs at or above the sample floor
 * (default 8, the shrinkage half-weight point, never below the 5-point
 * floor), ordered by the requested metric and capped by `--limit`. Every
 * row shows `points_together` beside its effect, so no effect appears
 * without the sample it came from. A metric outside the supported set is
 * an error naming that set, never a silent ordering by some other
 * metric.
 */
function cmdLeaderboard(parsed: ParsedArgs, deps: CliDeps, out: string[]): number {
  const metric = flagString(parsed, "metric") ?? "salary";
  if (!isSupportedMetric(metric)) {
    throw new CliError(`Unknown metric: ${metric}; supported: ${PAIR_METRICS.join(", ")}`);
  }
  const minPoints = reportMinPoints(parsed, "min-points", LEADERBOARD_MIN_POINTS_DEFAULT);
  const limit = flagInteger(parsed, "limit", 50);
  // A limit below one would print a "no pairs" line for a store that has
  // pairs, so it is refused rather than silently misreported.
  if (limit < 1) throw new CliError("--limit must be at least 1");
  const rows = pairLeaderboard(deps.db, { metric, minPoints, limit });
  const [aColumn, bColumn] = effectColumns(metric);
  out.push(...renderTable(["player_a", "player_b", "points_together", aColumn, bColumn], rows));
  if (rows.length === 0) {
    out.push(`No pairs with at least ${minPoints} shared points`);
  }
  return 0;
}

/** `pair <player-a> <player-b>`: the full `pair_effects` row, or a not-found exit. */
function cmdPair(parsed: ParsedArgs, deps: CliDeps, out: string[], err: string[]): number {
  const playerA = positional(parsed, 0);
  const playerB = positional(parsed, 1);
  if (playerA === undefined || playerB === undefined) {
    throw new CliError("pair requires <player-a> <player-b>");
  }
  const row = pairDetail(deps.db, playerA, playerB);
  if (row === undefined) {
    err.push(`No pair found for ${playerA} and ${playerB}`);
    return 1;
  }
  for (const [column, value] of Object.entries(row)) {
    out.push(`${column}: ${formatDetail(value)}`);
  }
  return 0;
}

/**
 * `opponents <player>`: the suppression rows for one player. Each delta is
 * credit per weighted point, so the eleven rule columns sum to
 * `affected_delta`, and `total_credit` / `weighted_points` is printed
 * beside them for a hand check. The lookup in `players` happens first,
 * because a player who is not in the store and a player with no
 * qualifying opponents are different facts: the first is an error, the
 * second an empty report.
 */
function cmdOpponents(parsed: ParsedArgs, deps: CliDeps, out: string[], err: string[]): number {
  const player = positional(parsed, 0);
  if (player === undefined) throw new CliError("opponents requires <player>");
  const minPoints = reportMinPoints(parsed, "min-points", MIN_SHARED_POINTS);
  if (playerIdFor(deps.db, nameKeyFor(player)) === undefined) {
    err.push(`Player not found: ${player}`);
    return 1;
  }
  const rows = opponentEffects(deps.db, player, { minPoints });
  out.push(...renderTable(OPPONENT_COLUMNS, rows));
  if (rows.length === 0) {
    out.push(`No opponents with at least ${minPoints} points`);
  }
  return 0;
}

/**
 * `evaluate --team "A,B,C,D,E,F"`: the pairs among the resolved players,
 * the risky subset, and the team total with its pair count. Names that
 * are not in the store are reported to stderr rather than dropped
 * silently; the evaluation of the resolved players still succeeds.
 */
function cmdEvaluate(parsed: ParsedArgs, deps: CliDeps, out: string[], err: string[]): number {
  const teamFlag = flagString(parsed, "team");
  if (teamFlag === undefined) {
    throw new CliError('evaluate requires --team "A,B,C,D,E,F"');
  }
  const names = teamFlag
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const evaluation = evaluateTeam(deps.db, names);

  out.push(
    evaluation.players.length > 0 ? `team: ${evaluation.players.join(", ")}` : "team: none resolved",
  );
  out.push("pairs:");
  if (evaluation.pairs.length > 0) {
    out.push(...renderTable(PAIR_COLUMNS, evaluation.pairs));
  } else {
    out.push(`none with at least ${MIN_SHARED_POINTS} shared points`);
  }
  out.push("risky pairs:");
  if (evaluation.riskyPairs.length > 0) {
    out.push(...renderTable(PAIR_COLUMNS, evaluation.riskyPairs));
  } else {
    out.push("none");
  }
  out.push(
    `team total shrunk delta: ${formatCell(evaluation.teamTotalShrunkDelta)} across ${evaluation.pairs.length} pairs`,
  );

  for (const unknown of evaluation.unknownPlayers) {
    err.push(`Unknown player: ${unknown}`);
  }
  return 0;
}

/**
 * `export-csv --table <name> --out <path>`: every column of an allowlisted
 * view as CSV with a header row. The table name is the one value that
 * reaches SQL as text, so the allowlist check runs before the statement
 * is built and rejects everything else.
 */
async function cmdExportCsv(parsed: ParsedArgs, deps: CliDeps, out: string[]): Promise<number> {
  const table = flagString(parsed, "table");
  if (table === undefined) throw new CliError("export-csv requires --table <name>");
  if (!EXPORTABLE_TABLES.includes(table)) {
    throw new CliError(`Invalid table: ${table}; allowed: ${EXPORTABLE_TABLES.join(", ")}`);
  }
  const outPath = flagString(parsed, "out");
  if (outPath === undefined) throw new CliError("export-csv requires --out <path>");

  const columns = (
    deps.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
  const rows = deps.db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  const lines = [
    columns.join(","),
    ...rows.map((row) => formatCsvRow(columns.map((column) => row[column] ?? null))),
  ];
  await writeFile(outPath, `${lines.join("\n")}\n`, "utf8");
  out.push(`wrote ${rows.length} rows to ${outPath}`);
  return 0;
}

/** Run one validated subcommand against the resolved store. */
async function dispatch(
  command: string,
  parsed: ParsedArgs,
  deps: CliDeps,
  out: string[],
  err: string[],
): Promise<number> {
  switch (command) {
    case "ingest":
      return cmdIngest(parsed, deps, out);
    case "leaderboard":
      return cmdLeaderboard(parsed, deps, out);
    case "pair":
      return cmdPair(parsed, deps, out, err);
    case "opponents":
      return cmdOpponents(parsed, deps, out, err);
    case "evaluate":
      return cmdEvaluate(parsed, deps, out, err);
    case "export-csv":
      return cmdExportCsv(parsed, deps, out);
    default:
      // Unreachable: `run` validates the subcommand before dispatching.
      throw new CliError(`Unknown subcommand: ${command}`);
  }
}

/**
 * Run one CLI invocation. Output is collected into the returned strings
 * and never written to the console, so tests can assert on it and the
 * entry point decides how to print it. Usage errors and command failures
 * become exit code 1 with the message on stderr; `--db` opens its own
 * store for the invocation and closes it before returning, overriding the
 * injected one.
 */
export async function run(args: string[], deps: CliDeps): Promise<CliResult> {
  const parsed = parseArgs(args.slice(1));
  const subcommand = args[0];

  if (subcommand === undefined) {
    return { code: 1, stdout: "", stderr: USAGE.join("\n") };
  }
  if (!COMMANDS.includes(subcommand)) {
    return {
      code: 1,
      stdout: "",
      stderr: [`Unknown subcommand: ${subcommand}`, "", ...USAGE].join("\n"),
    };
  }

  const out: string[] = [];
  const err: string[] = [];
  let owned: Db | undefined;
  let code = 0;
  try {
    validateFlags(subcommand, parsed);
    const dbPath = flagString(parsed, "db");
    const db = dbPath === undefined ? deps.db : (owned = openDb(dbPath));
    code = await dispatch(subcommand, parsed, { db, source: deps.source }, out, err);
  } catch (error) {
    err.push(error instanceof Error ? error.message : String(error));
    code = 1;
  } finally {
    owned?.close();
  }
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

// Entry point: open the store, run the invocation, print what it collected,
// and exit with its code. The `--db` path is read straight from argv here,
// because `run` receives an already-open store: without the pre-scan the
// entry would create and migrate the default store even when `--db` points
// elsewhere. The guard keeps importing this module (by the tests) free of
// side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const db = openDb(dbPathFromArgv(args));
  const result = await run(args, { db });
  if (result.stdout !== "") console.log(result.stdout);
  if (result.stderr !== "") console.error(result.stderr);
  db.close();
  process.exit(result.code);
}
