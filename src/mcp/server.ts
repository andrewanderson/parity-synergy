import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../store/db.js";
import { MIN_SHARED_POINTS, pairDetail, pairLeaderboard } from "../query/pairs.js";
import { opponentEffects, playerProfile } from "../query/opponents.js";
import { evaluateTeam } from "../query/teams.js";

/** Everything the server needs from its caller: one open store handle. */
export type SynergyServerOptions = { db: Db };

/** JSON text content wrapping one value. */
function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** A tool error result carrying a stable code and the failure message. */
function errorResult(cause: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: "INTERNAL", message }) }],
    isError: true,
  };
}

/**
 * The sample floor for a listing report: the caller's `minPoints` when it
 * is given, raised to `MIN_SHARED_POINTS` either way, so pairs below the
 * 5-point floor are excluded from reports whatever the caller asks for.
 * This mirrors the CLI's `reportMinPoints` clamp.
 */
function reportMinPoints(minPoints: number | undefined): number {
  return Math.max(minPoints ?? MIN_SHARED_POINTS, MIN_SHARED_POINTS);
}

/**
 * Create the local synergy MCP server with exactly the six `synergy_*`
 * tools. Every tool reads only the SQLite store through the same query
 * functions the CLI uses: no Parity API source is imported or called here,
 * and every effect row carries its sample size (`points_together`,
 * `points_against`, or the baseline `points`).
 */
export function createSynergyServer(options: SynergyServerOptions): McpServer {
  const { db } = options;
  const server = new McpServer({
    name: "parity-synergy",
    version: "0.1.0",
  });

  server.registerTool(
    "synergy_list_leagues",
    {
      description: "List the leagues held in the local store with their game counts.",
      inputSchema: {},
    },
    async (): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> => {
      try {
        const leagues = db
          .prepare(
            "SELECT g.league_id, COUNT(*) AS games FROM games g GROUP BY g.league_id ORDER BY g.league_id",
          )
          .all() as Array<{ league_id: number; games: number }>;
        return textResult({ leagues });
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "synergy_pair_leaderboard",
    {
      description:
        "List teammate pairs ordered by a metric's effect, with points_together beside every effect; pairs below 5 shared points are excluded.",
      inputSchema: {
        metric: z.string().optional(),
        minPoints: z.number().int().optional(),
        limit: z.number().int().min(1).optional(),
        order: z.enum(["asc", "desc"]).optional(),
      },
    },
    async (args): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> => {
      try {
        const pairs = pairLeaderboard(db, {
          metric: args.metric,
          minPoints: reportMinPoints(args.minPoints),
          limit: args.limit,
          order: args.order,
        });
        return textResult({ pairs });
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "synergy_pair_detail",
    {
      description:
        "Get the full teammate-pair row for two players, or { pair: null } when they never shared a point.",
      inputSchema: {
        playerA: z.string(),
        playerB: z.string(),
      },
    },
    async (args): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> => {
      try {
        const pair = pairDetail(db, args.playerA, args.playerB);
        // A pair that never shared a point is a result, not a failure, so
        // the caller can tell "no effect" from "failed".
        return textResult({ pair: pair ?? null });
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "synergy_opponent_effects",
    {
      description:
        "List the opponents that most suppressed one player, most suppressing first, with points_against beside every effect.",
      inputSchema: {
        player: z.string(),
        minPoints: z.number().int().optional(),
        limit: z.number().int().min(1).optional(),
      },
    },
    async (args): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> => {
      try {
        const opponents = opponentEffects(db, args.player, {
          minPoints: reportMinPoints(args.minPoints),
          limit: args.limit,
        });
        return textResult({ player: args.player, opponents });
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "synergy_team_evaluation",
    {
      description:
        "Evaluate a proposed team: resolved players, unknown names, teammate pairs, risky pairs, and the rough team total.",
      inputSchema: {
        team: z.array(z.string()),
      },
    },
    async (args): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> => {
      try {
        const evaluation = evaluateTeam(db, args.team);
        return textResult(evaluation);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  server.registerTool(
    "synergy_player_profile",
    {
      description:
        "Get one player's stored baselines, teammate pairs, and opponent suppression rows, each with its sample size.",
      inputSchema: {
        player: z.string(),
      },
    },
    async (args): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> => {
      try {
        const profile = playerProfile(db, args.player);
        return textResult({ player: args.player, ...profile });
      } catch (cause) {
        return errorResult(cause);
      }
    },
  );

  return server;
}
