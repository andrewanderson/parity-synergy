import type { Db } from "./db.js";

export const SCHEMA_VERSION = 1;

/**
 * The `pair_effects` view: one row per unordered teammate pair, with the
 * salary, statistic, and salary-rule deltas of each member on the points
 * they shared, shrunk by n / (n + 8). SQLite has no `CREATE OR REPLACE
 * VIEW`, so the statement drops and recreates the view on every migrate.
 */
export const PAIR_EFFECTS_VIEW_SQL = `
DROP VIEW IF EXISTS pair_effects;
CREATE VIEW pair_effects AS
WITH shared AS (
  -- One row per (teammate pair, shared point). Same point and same line is
  -- what makes the pair a teammate pair; the id guard makes each unordered
  -- pair appear once. An actor recorded on neither line (line_changed = 1)
  -- has no line peers, so they form no teammate pairs.
  SELECT a.player_id AS id_a, b.player_id AS id_b, a.point_id, g.game_id
  FROM appearances a
  JOIN appearances b
    ON b.point_id = a.point_id AND b.line = a.line AND b.player_id > a.player_id
  JOIN points p ON p.point_id = a.point_id
  JOIN games g ON g.game_id = p.game_id
  WHERE a.line_changed = 0 AND b.line_changed = 0
),
pairs AS (
  SELECT id_a, id_b, COUNT(*) AS points_together,
         MIN(game_id) AS first_game_id, MAX(game_id) AS last_game_id
  FROM shared
  GROUP BY id_a, id_b
),
metrics AS (
  -- Each member's metric rows over the shared points, kept apart by
  -- member_id so one member's aggregate can never be reported as the
  -- other's. The UNION ALL appends the per-rule salary amounts under the
  -- same 'salary:<RULE>' names the baseline table uses, so one pivot
  -- serves both the statistic columns and the rule columns.
  SELECT s.id_a, s.id_b, am.player_id AS member_id, am.metric, am.value
  FROM shared s
  JOIN appearance_metric am ON am.point_id = s.point_id
  WHERE am.player_id IN (s.id_a, s.id_b)
  UNION ALL
  SELECT s.id_a, s.id_b, sr.player_id AS member_id,
         'salary:' || sr.rule_name AS metric, sr.amount AS value
  FROM shared s
  JOIN salary_rule sr ON sr.point_id = s.point_id
  WHERE sr.player_id IN (s.id_a, s.id_b)
),
member_totals AS (
  SELECT id_a, id_b, member_id, metric, SUM(value) AS actual
  FROM metrics
  GROUP BY id_a, id_b, member_id, metric
),
pivoted AS (
  -- One row per pair with both members' sums as separate columns, by
  -- conditional aggregation rather than a join per metric.
  SELECT
    p.id_a, p.id_b, p.points_together, p.first_game_id, p.last_game_id,
    pa.name_key AS key_a, pb.name_key AS key_b,
    pa.name AS name_a, pb.name AS name_b,
    SUM(CASE WHEN m.member_id = p.id_a AND m.metric = 'salary' THEN m.actual ELSE 0 END) AS val_a_salary,
    SUM(CASE WHEN m.member_id = p.id_b AND m.metric = 'salary' THEN m.actual ELSE 0 END) AS val_b_salary,
    SUM(CASE WHEN m.member_id = p.id_a AND m.metric = 'goals' THEN m.actual ELSE 0 END) AS val_a_goals,
    SUM(CASE WHEN m.member_id = p.id_b AND m.metric = 'goals' THEN m.actual ELSE 0 END) AS val_b_goals,
    SUM(CASE WHEN m.member_id = p.id_a AND m.metric = 'assists' THEN m.actual ELSE 0 END) AS val_a_assists,
    SUM(CASE WHEN m.member_id = p.id_b AND m.metric = 'assists' THEN m.actual ELSE 0 END) AS val_b_assists,
    SUM(CASE WHEN m.member_id = p.id_a AND m.metric = 'drops' THEN m.actual ELSE 0 END) AS val_a_drops,
    SUM(CASE WHEN m.member_id = p.id_b AND m.metric = 'drops' THEN m.actual ELSE 0 END) AS val_b_drops,
    SUM(CASE WHEN m.member_id = p.id_a AND m.metric = 'throw_aways' THEN m.actual ELSE 0 END) AS val_a_throw_aways,
    SUM(CASE WHEN m.member_id = p.id_b AND m.metric = 'throw_aways' THEN m.actual ELSE 0 END) AS val_b_throw_aways,
    SUM(CASE WHEN m.member_id = p.id_a AND m.metric = 'threw_drops' THEN m.actual ELSE 0 END) AS val_a_threw_drops,
    SUM(CASE WHEN m.member_id = p.id_b AND m.metric = 'threw_drops' THEN m.actual ELSE 0 END) AS val_b_threw_drops,
    SUM(CASE WHEN m.member_id = p.id_a AND m.metric = 'salary:HOLD' THEN m.actual ELSE 0 END) AS val_a_hold,
    SUM(CASE WHEN m.member_id = p.id_b AND m.metric = 'salary:HOLD' THEN m.actual ELSE 0 END) AS val_b_hold,
    SUM(CASE WHEN m.member_id = p.id_a AND m.metric = 'salary:BREAK' THEN m.actual ELSE 0 END) AS val_a_break,
    SUM(CASE WHEN m.member_id = p.id_b AND m.metric = 'salary:BREAK' THEN m.actual ELSE 0 END) AS val_b_break,
    SUM(CASE WHEN m.member_id = p.id_a AND m.metric = 'salary:GOAL' THEN m.actual ELSE 0 END) AS val_a_goal_rule,
    SUM(CASE WHEN m.member_id = p.id_b AND m.metric = 'salary:GOAL' THEN m.actual ELSE 0 END) AS val_b_goal_rule,
    SUM(CASE WHEN m.member_id = p.id_a AND m.metric = 'salary:DEFENSE' THEN m.actual ELSE 0 END) AS val_a_defense_rule,
    SUM(CASE WHEN m.member_id = p.id_b AND m.metric = 'salary:DEFENSE' THEN m.actual ELSE 0 END) AS val_b_defense_rule
  FROM pairs p
  JOIN players pa ON pa.player_id = p.id_a
  JOIN players pb ON pb.player_id = p.id_b
  LEFT JOIN member_totals m ON m.id_a = p.id_a AND m.id_b = p.id_b
  GROUP BY p.id_a, p.id_b, p.points_together, p.first_game_id, p.last_game_id,
           pa.name_key, pb.name_key, pa.name, pb.name
),
baseline_pivot AS (
  -- One row per player with every baseline the view needs: the means the
  -- deltas subtract, the negative-event totals the baseline rate divides,
  -- and the appearance count as its denominator. A metric the player has
  -- no facts for reads 0, which is what its delta means. All baseline rows
  -- of a player share one point count, so MAX(points) is that count.
  SELECT player_id,
         MAX(points) AS appearance_points,
         COALESCE(MAX(CASE WHEN metric = 'salary' THEN mean END), 0) AS salary_mean,
         COALESCE(MAX(CASE WHEN metric = 'goals' THEN mean END), 0) AS goals_mean,
         COALESCE(MAX(CASE WHEN metric = 'assists' THEN mean END), 0) AS assists_mean,
         COALESCE(MAX(CASE WHEN metric = 'drops' THEN mean END), 0) AS drops_mean,
         COALESCE(MAX(CASE WHEN metric = 'throw_aways' THEN mean END), 0) AS throw_aways_mean,
         COALESCE(MAX(CASE WHEN metric = 'threw_drops' THEN mean END), 0) AS threw_drops_mean,
         COALESCE(MAX(CASE WHEN metric = 'salary:HOLD' THEN mean END), 0) AS hold_mean,
         COALESCE(MAX(CASE WHEN metric = 'salary:BREAK' THEN mean END), 0) AS break_mean,
         COALESCE(MAX(CASE WHEN metric = 'salary:GOAL' THEN mean END), 0) AS goal_mean,
         COALESCE(MAX(CASE WHEN metric = 'salary:DEFENSE' THEN mean END), 0) AS defense_mean,
         COALESCE(MAX(CASE WHEN metric = 'drops' THEN total END), 0) AS drops_total,
         COALESCE(MAX(CASE WHEN metric = 'throw_aways' THEN total END), 0) AS throw_aways_total,
         COALESCE(MAX(CASE WHEN metric = 'threw_drops' THEN total END), 0) AS threw_drops_total
  FROM player_baselines
  GROUP BY player_id
),
swapped AS (
  -- The pair is unordered but the columns are per-member: player_a is
  -- always the lower name_key, and every a_/b_ value follows the one
  -- comparison key_a < key_b. SQLite cannot reference a column alias from
  -- the same SELECT list, so the swap happens here, before the final
  -- SELECT computes the deltas. The baseline joins belong here rather
  -- than in pivoted, where they would multiply the grouped rows.
  SELECT
    p.*,
    CASE WHEN p.key_a < p.key_b THEN p.key_a ELSE p.key_b END AS player_a,
    CASE WHEN p.key_a < p.key_b THEN p.key_b ELSE p.key_a END AS player_b,
    CASE WHEN p.key_a < p.key_b THEN p.name_a ELSE p.name_b END AS player_a_name,
    CASE WHEN p.key_a < p.key_b THEN p.name_b ELSE p.name_a END AS player_b_name,
    CASE WHEN p.key_a < p.key_b THEN p.val_a_salary ELSE p.val_b_salary END AS a_salary_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_b_salary ELSE p.val_a_salary END AS b_salary_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_a_goals ELSE p.val_b_goals END AS a_goals_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_b_goals ELSE p.val_a_goals END AS b_goals_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_a_assists ELSE p.val_b_assists END AS a_assists_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_b_assists ELSE p.val_a_assists END AS b_assists_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_a_drops ELSE p.val_b_drops END AS a_drops_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_b_drops ELSE p.val_a_drops END AS b_drops_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_a_throw_aways ELSE p.val_b_throw_aways END AS a_throw_aways_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_b_throw_aways ELSE p.val_a_throw_aways END AS b_throw_aways_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_a_threw_drops ELSE p.val_b_threw_drops END AS a_threw_drops_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_b_threw_drops ELSE p.val_a_threw_drops END AS b_threw_drops_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_a_hold ELSE p.val_b_hold END AS a_hold_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_b_hold ELSE p.val_a_hold END AS b_hold_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_a_break ELSE p.val_b_break END AS a_break_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_b_break ELSE p.val_a_break END AS b_break_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_a_goal_rule ELSE p.val_b_goal_rule END AS a_goal_rule_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_b_goal_rule ELSE p.val_a_goal_rule END AS b_goal_rule_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_a_defense_rule ELSE p.val_b_defense_rule END AS a_defense_rule_with_b,
    CASE WHEN p.key_a < p.key_b THEN p.val_b_defense_rule ELSE p.val_a_defense_rule END AS b_defense_rule_with_b,
    CASE WHEN p.key_a < p.key_b THEN ba.salary_mean ELSE bb.salary_mean END AS a_baseline,
    CASE WHEN p.key_a < p.key_b THEN bb.salary_mean ELSE ba.salary_mean END AS b_baseline,
    CASE WHEN p.key_a < p.key_b THEN ba.goals_mean ELSE bb.goals_mean END AS a_goals_baseline,
    CASE WHEN p.key_a < p.key_b THEN bb.goals_mean ELSE ba.goals_mean END AS b_goals_baseline,
    CASE WHEN p.key_a < p.key_b THEN ba.assists_mean ELSE bb.assists_mean END AS a_assists_baseline,
    CASE WHEN p.key_a < p.key_b THEN bb.assists_mean ELSE ba.assists_mean END AS b_assists_baseline,
    CASE WHEN p.key_a < p.key_b THEN ba.drops_mean ELSE bb.drops_mean END AS a_drops_baseline,
    CASE WHEN p.key_a < p.key_b THEN bb.drops_mean ELSE ba.drops_mean END AS b_drops_baseline,
    CASE WHEN p.key_a < p.key_b THEN ba.throw_aways_mean ELSE bb.throw_aways_mean END AS a_throw_aways_baseline,
    CASE WHEN p.key_a < p.key_b THEN bb.throw_aways_mean ELSE ba.throw_aways_mean END AS b_throw_aways_baseline,
    CASE WHEN p.key_a < p.key_b THEN ba.threw_drops_mean ELSE bb.threw_drops_mean END AS a_threw_drops_baseline,
    CASE WHEN p.key_a < p.key_b THEN bb.threw_drops_mean ELSE ba.threw_drops_mean END AS b_threw_drops_baseline,
    CASE WHEN p.key_a < p.key_b THEN ba.hold_mean ELSE bb.hold_mean END AS a_hold_baseline,
    CASE WHEN p.key_a < p.key_b THEN bb.hold_mean ELSE ba.hold_mean END AS b_hold_baseline,
    CASE WHEN p.key_a < p.key_b THEN ba.break_mean ELSE bb.break_mean END AS a_break_baseline,
    CASE WHEN p.key_a < p.key_b THEN bb.break_mean ELSE ba.break_mean END AS b_break_baseline,
    CASE WHEN p.key_a < p.key_b THEN ba.goal_mean ELSE bb.goal_mean END AS a_goal_rule_baseline,
    CASE WHEN p.key_a < p.key_b THEN bb.goal_mean ELSE ba.goal_mean END AS b_goal_rule_baseline,
    CASE WHEN p.key_a < p.key_b THEN ba.defense_mean ELSE bb.defense_mean END AS a_defense_rule_baseline,
    CASE WHEN p.key_a < p.key_b THEN bb.defense_mean ELSE ba.defense_mean END AS b_defense_rule_baseline,
    CASE WHEN p.key_a < p.key_b THEN ba.drops_total ELSE bb.drops_total END AS a_drops_total,
    CASE WHEN p.key_a < p.key_b THEN bb.drops_total ELSE ba.drops_total END AS b_drops_total,
    CASE WHEN p.key_a < p.key_b THEN ba.throw_aways_total ELSE bb.throw_aways_total END AS a_throw_aways_total,
    CASE WHEN p.key_a < p.key_b THEN bb.throw_aways_total ELSE ba.throw_aways_total END AS b_throw_aways_total,
    CASE WHEN p.key_a < p.key_b THEN ba.threw_drops_total ELSE bb.threw_drops_total END AS a_threw_drops_total,
    CASE WHEN p.key_a < p.key_b THEN bb.threw_drops_total ELSE ba.threw_drops_total END AS b_threw_drops_total,
    CASE WHEN p.key_a < p.key_b THEN ba.appearance_points ELSE bb.appearance_points END AS a_points,
    CASE WHEN p.key_a < p.key_b THEN bb.appearance_points ELSE ba.appearance_points END AS b_points
  FROM pivoted p
  LEFT JOIN baseline_pivot ba ON ba.player_id = p.id_a
  LEFT JOIN baseline_pivot bb ON bb.player_id = p.id_b
)
SELECT
  player_a, player_b, player_a_name, player_b_name,
  points_together,
  a_salary_with_b, a_baseline,
  a_salary_with_b - a_baseline * points_together AS a_delta,
  b_salary_with_b, b_baseline,
  b_salary_with_b - b_baseline * points_together AS b_delta,
  (a_salary_with_b - a_baseline * points_together) * points_together / (points_together + 8.0) AS a_shrunk_delta,
  (b_salary_with_b - b_baseline * points_together) * points_together / (points_together + 8.0) AS b_shrunk_delta,
  (a_drops_with_b + a_throw_aways_with_b + a_threw_drops_with_b) / points_together AS a_negative_rate_with_b,
  (a_drops_total + a_throw_aways_total + a_threw_drops_total) / a_points AS a_negative_rate_baseline,
  (b_drops_with_b + b_throw_aways_with_b + b_threw_drops_with_b) / points_together AS b_negative_rate_with_b,
  (b_drops_total + b_throw_aways_total + b_threw_drops_total) / b_points AS b_negative_rate_baseline,
  a_goals_with_b - a_goals_baseline * points_together AS a_goals_delta,
  b_goals_with_b - b_goals_baseline * points_together AS b_goals_delta,
  a_assists_with_b - a_assists_baseline * points_together AS a_assists_delta,
  b_assists_with_b - b_assists_baseline * points_together AS b_assists_delta,
  a_drops_with_b - a_drops_baseline * points_together AS a_drops_delta,
  b_drops_with_b - b_drops_baseline * points_together AS b_drops_delta,
  a_throw_aways_with_b - a_throw_aways_baseline * points_together AS a_throw_aways_delta,
  b_throw_aways_with_b - b_throw_aways_baseline * points_together AS b_throw_aways_delta,
  a_threw_drops_with_b - a_threw_drops_baseline * points_together AS a_threw_drops_delta,
  b_threw_drops_with_b - b_threw_drops_baseline * points_together AS b_threw_drops_delta,
  a_hold_with_b - a_hold_baseline * points_together AS a_hold_delta,
  b_hold_with_b - b_hold_baseline * points_together AS b_hold_delta,
  a_break_with_b - a_break_baseline * points_together AS a_break_delta,
  b_break_with_b - b_break_baseline * points_together AS b_break_delta,
  a_goal_rule_with_b - a_goal_rule_baseline * points_together AS a_goal_delta,
  b_goal_rule_with_b - b_goal_rule_baseline * points_together AS b_goal_delta,
  a_defense_rule_with_b - a_defense_rule_baseline * points_together AS a_defense_delta,
  b_defense_rule_with_b - b_defense_rule_baseline * points_together AS b_defense_delta,
  first_game_id, last_game_id
FROM swapped;
`;

/**
 * The `opponent_effects` view: one row per directed opponent pair, with the
 * weighted mean credit on salary and its per-rule breakdown. The residual
 * reads `player_baselines.mean` at query time, so a newly ingested game
 * changes every historical residual for its players without any stored
 * value being rewritten. SQLite has no `CREATE OR REPLACE VIEW`, so the
 * statement drops and recreates the view on every migrate.
 */
export const OPPONENT_EFFECTS_VIEW_SQL = `
DROP VIEW IF EXISTS opponent_effects;
CREATE VIEW opponent_effects AS
WITH opp AS (
  -- One row per (affected player, opponent, point): the two appearances on
  -- opposite lines with the weight stored for exactly that direction.
  -- Outside-line actors are included here: they were playing against the
  -- other line. The weight join keeps only pairs the ingest recorded as
  -- opponents, which are exactly the cross-line pairs.
  SELECT a.player_id AS id_a, b.player_id AS id_b, a.point_id,
         ow.weight, ow.weighting
  FROM appearances a
  JOIN appearances b
    ON b.point_id = a.point_id AND b.line <> a.line
  JOIN opponent_weight ow
    ON ow.point_id = a.point_id AND ow.player_id = a.player_id AND ow.opponent_id = b.player_id
),
credits AS (
  -- residual = actual - baseline, credit = residual * weight, and the two
  -- sums affected_delta divides. COUNT(DISTINCT point_id) keeps a
  -- malformed duplicate line entry from inflating the sample size. Every
  -- appearance carries a salary metric row, so no point drops out here.
  SELECT o.id_a, o.id_b,
         SUM((am.value - bl.mean) * o.weight) AS total_credit,
         SUM(o.weight) AS weighted_points,
         COUNT(DISTINCT o.point_id) AS points_against
  FROM opp o
  JOIN appearance_metric am
    ON am.point_id = o.point_id AND am.player_id = o.id_a AND am.metric = 'salary'
  JOIN player_baselines bl
    ON bl.player_id = o.id_a AND bl.metric = 'salary'
  GROUP BY o.id_a, o.id_b
),
rule_weighted AS (
  -- Per-rule weighted amounts. The rule's baseline mean is charged on every
  -- weighted point in the final SELECT (mean * weighted_points), so a point
  -- where the player earned nothing of that rule still contributes
  -- -mean * weight, exactly as the salary credit charges the salary mean
  -- on every point. Summing the breakdown over all rules therefore
  -- reproduces total_credit.
  SELECT o.id_a, o.id_b,
         SUM(CASE WHEN sr.rule_name = 'GOAL' THEN sr.amount * o.weight ELSE 0 END) AS goal_weighted,
         SUM(CASE WHEN sr.rule_name = 'ASSIST' THEN sr.amount * o.weight ELSE 0 END) AS assist_weighted,
         SUM(CASE WHEN sr.rule_name = 'DEFENSE' THEN sr.amount * o.weight ELSE 0 END) AS defense_weighted,
         SUM(CASE WHEN sr.rule_name = 'HOLD' THEN sr.amount * o.weight ELSE 0 END) AS hold_weighted,
         SUM(CASE WHEN sr.rule_name = 'BREAK' THEN sr.amount * o.weight ELSE 0 END) AS break_weighted,
         SUM(CASE WHEN sr.rule_name = 'THROWAWAY' THEN sr.amount * o.weight ELSE 0 END) AS throw_away_weighted,
         SUM(CASE WHEN sr.rule_name = 'DROP' THEN sr.amount * o.weight ELSE 0 END) AS drop_weighted
  FROM opp o
  LEFT JOIN salary_rule sr ON sr.point_id = o.point_id AND sr.player_id = o.id_a
  GROUP BY o.id_a, o.id_b
),
baseline_pivot AS (
  -- One row per player with the per-rule means the breakdown subtracts. A
  -- rule the player has no facts for reads 0, which is what its delta
  -- means.
  SELECT player_id,
         COALESCE(MAX(CASE WHEN metric = 'salary:GOAL' THEN mean END), 0) AS goal_mean,
         COALESCE(MAX(CASE WHEN metric = 'salary:ASSIST' THEN mean END), 0) AS assist_mean,
         COALESCE(MAX(CASE WHEN metric = 'salary:DEFENSE' THEN mean END), 0) AS defense_mean,
         COALESCE(MAX(CASE WHEN metric = 'salary:HOLD' THEN mean END), 0) AS hold_mean,
         COALESCE(MAX(CASE WHEN metric = 'salary:BREAK' THEN mean END), 0) AS break_mean,
         COALESCE(MAX(CASE WHEN metric = 'salary:THROWAWAY' THEN mean END), 0) AS throw_away_mean,
         COALESCE(MAX(CASE WHEN metric = 'salary:DROP' THEN mean END), 0) AS drop_mean
  FROM player_baselines
  GROUP BY player_id
)
SELECT
  c.id_a AS player_id, c.id_b AS opponent_id,
  pa.name AS player_name, pb.name AS opponent_name,
  c.points_against,
  CASE WHEN c.weighted_points = 0 THEN 0 ELSE c.total_credit / c.weighted_points END AS affected_delta,
  c.total_credit,
  c.weighted_points,
  rw.goal_weighted - bl.goal_mean * c.weighted_points AS goal_delta,
  rw.assist_weighted - bl.assist_mean * c.weighted_points AS assist_delta,
  rw.defense_weighted - bl.defense_mean * c.weighted_points AS defense_delta,
  rw.hold_weighted - bl.hold_mean * c.weighted_points AS hold_delta,
  rw.break_weighted - bl.break_mean * c.weighted_points AS break_delta,
  rw.throw_away_weighted - bl.throw_away_mean * c.weighted_points AS throw_away_delta,
  rw.drop_weighted - bl.drop_mean * c.weighted_points AS drop_delta
FROM credits c
JOIN rule_weighted rw ON rw.id_a = c.id_a AND rw.id_b = c.id_b
JOIN baseline_pivot bl ON bl.player_id = c.id_a
JOIN players pa ON pa.player_id = c.id_a
JOIN players pb ON pb.player_id = c.id_b;
`;

/**
 * The full DDL for schema version 1. Every table and index statement uses
 * `IF NOT EXISTS`, so re-running is safe; the two effect views drop and
 * recreate themselves, which is SQLite's equivalent of `CREATE OR REPLACE
 * VIEW`. `PRAGMA foreign_keys` is intentionally absent: `openDb` sets it
 * with `db.pragma("foreign_keys = ON")` on the connection.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  game_id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL,
  week INTEGER NOT NULL,
  date TEXT,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  salary_rules_version INTEGER NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  player_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  is_substitute INTEGER NOT NULL DEFAULT 0,
  division TEXT
);

CREATE TABLE IF NOT EXISTS points (
  point_id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
  point_number INTEGER NOT NULL,
  offense_team TEXT,
  defense_team TEXT,
  duration_sec REAL,
  UNIQUE (game_id, point_number)
);

CREATE TABLE IF NOT EXISTS appearances (
  point_id INTEGER NOT NULL REFERENCES points(point_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  line TEXT NOT NULL CHECK (line IN ('offense','defense')),
  is_substitute INTEGER NOT NULL DEFAULT 0,
  touches INTEGER NOT NULL DEFAULT 0,
  line_changed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (point_id, player_id)
);

CREATE TABLE IF NOT EXISTS appearance_metric (
  point_id INTEGER NOT NULL REFERENCES points(point_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (point_id, player_id, metric)
);

CREATE TABLE IF NOT EXISTS salary_rule (
  point_id INTEGER NOT NULL REFERENCES points(point_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  rule_name TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (point_id, player_id, rule_name)
);

CREATE TABLE IF NOT EXISTS salary_components (
  point_id INTEGER NOT NULL REFERENCES points(point_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  rule_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  event_index INTEGER
);

CREATE TABLE IF NOT EXISTS opponent_weight (
  point_id INTEGER NOT NULL REFERENCES points(point_id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  opponent_id INTEGER NOT NULL REFERENCES players(player_id),
  weight REAL NOT NULL,
  weighting TEXT NOT NULL CHECK (weighting IN ('involvement','equal')),
  PRIMARY KEY (point_id, player_id, opponent_id)
);

CREATE TABLE IF NOT EXISTS player_baselines (
  player_id INTEGER NOT NULL REFERENCES players(player_id),
  metric TEXT NOT NULL,
  points INTEGER NOT NULL,
  total REAL NOT NULL,
  mean REAL NOT NULL,
  PRIMARY KEY (player_id, metric)
);

CREATE TABLE IF NOT EXISTS ingest_log (
  game_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','rejected')),
  reason TEXT,
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appearances_player ON appearances(player_id);
CREATE INDEX IF NOT EXISTS idx_appearance_metric_player ON appearance_metric(player_id, metric);
CREATE INDEX IF NOT EXISTS idx_opponent_weight_opponent ON opponent_weight(opponent_id);
CREATE INDEX IF NOT EXISTS idx_points_game ON points(game_id);
CREATE INDEX IF NOT EXISTS idx_salary_rule_player ON salary_rule(player_id, rule_name);

${PAIR_EFFECTS_VIEW_SQL}
${OPPONENT_EFFECTS_VIEW_SQL}
`;

/**
 * Apply the schema to `db` and record the schema version, atomically: the
 * DDL and the version upsert share one transaction, so a mid-exec failure
 * cannot leave partial DDL applied with no version row. Safe to run
 * repeatedly: the DDL uses `IF NOT EXISTS` and the version row upserts.
 */
export function migrate(db: Db): void {
  const apply = db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SCHEMA_VERSION));
  });
  apply();
}
