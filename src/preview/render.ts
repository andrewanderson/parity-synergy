import {
  escapeXml,
  formatMoney,
  formatNumber,
  heatmapSvg,
  playerChemistrySvg,
  ratingBarSvg,
  signColour,
} from "./charts.js";
import type { ResolvedTeam } from "./rosters.js";
import type { RatingStats } from "./stats.js";

/** Everything the page shows about one team. */
export type TeamSection = {
  team: ResolvedTeam;
  /** Each player's excess with each teammate, for the chemistry grid. */
  chemistry: {
    playerName: string;
    teammates: { name: string; excess: number; sharedPoints: number }[];
  }[];
  /** The team's best and worst pairing. */
  bestPair?: { a: string; b: string; sharedPoints: number; excess: number };
  worstPair?: { a: string; b: string; sharedPoints: number; excess: number };
  /** The team's top earners by baseline salary per point. */
  topEarners: { name: string; salaryPerPoint: number }[];
};

/** The whole page. */
export type PageData = {
  leagueId: number;
  teams: TeamSection[];
  /** The 8x8 heatmap cells, row-major. */
  heatmap: { rowLabel: string; columnLabel: string; value: number; pairCount: number }[];
  /** The maximum absolute cell value, for the colour scale. */
  heatmapMax: number;
  /** The method section's numbers, measured from the store. */
  method: RatingStats;
};

/** The page's styles. No external font, no import, no network. */
const STYLE = `
:root {
  --ink: #1b1b1a;
  --muted: #5d5d59;
  --line: #d9d9d4;
  --paper: #ffffff;
  --wash: #f6f6f3;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px 20px 56px;
  background: var(--wash);
  color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.45;
}
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 20px; margin: 40px 0 12px; padding-top: 14px; border-top: 2px solid var(--ink); }
h3 { font-size: 16px; margin: 0 0 8px; }
p { margin: 8px 0; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.tabular { font-variant-numeric: tabular-nums; }
.wrap { max-width: 1180px; margin: 0 auto; }
/* The lede is the section's opening paragraph. It is given a wider
   measure than a body paragraph, so that a paragraph which nearly fits
   does not wrap, and its lines are balanced, so that the ones which
   must wrap do not end on a stub. */
.lede { max-width: 900px; text-wrap: balance; }
.cards {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}
@media (min-width: 900px) {
  .cards { grid-template-columns: 1fr 1fr; }
}
.card {
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px 16px 12px;
  break-inside: avoid;
}
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.card-head h3 { margin: 0; flex: 1 1 auto; min-width: 0; }
/* The rating block takes only the width its own content needs, so the
   number sits against the card's right edge with no gap. It does not
   shrink: a comparison note that wrapped to two lines under the number
   read worse than a team name that wrapped, so the name takes the
   squeeze instead. */
.card-head > div { flex: 0 0 auto; text-align: right; }
.rating { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
.rating-note { font-size: 12px; color: var(--muted); margin: 2px 0 6px; }
/* The warning notes are amber, well away from the red that now means
   negative synergy, so a warning is never mistaken for a value. */
.thin-note { font-size: 12px; color: #7a5c00; margin: 2px 0 6px; }
.roster-note { font-size: 12px; color: #7a5c00; margin: 0 0 6px; }
@media (max-width: 560px) {
  /* On a narrow card the name needs the full width, so the rating sits
     above it rather than squeezing it. */
  .card-head { flex-wrap: wrap; }
  .card-head > div { order: -1; }
}
.stat-row { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 8px 0 4px; }
.stat { font-size: 13px; }
.stat b { font-variant-numeric: tabular-nums; }
/* The two player counts read as one pair, so they are kept on one line
   together: the group wraps to the next row as a unit rather than
   leaving "contributing" stranded on a line of its own. */
.stat-group { display: inline-flex; gap: 18px; }
.stat-group .stat { white-space: nowrap; }
.pair-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
.pair-box { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.pair-box h4 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.pair-box p { margin: 0; font-size: 13px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.chip { border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; font-size: 12px; background: var(--wash); }
.chip.unknown { border-style: dashed; color: var(--muted); }
.roster h4 { margin: 10px 0 2px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.card-chemistry { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 8px; }
.card-chemistry h4 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.chem-team { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; }
.chem-team h3 { margin: 0 0 2px; }
.chem-players { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 10px; }
@media (min-width: 900px) { .chem-players { grid-template-columns: 1fr 1fr; } }
.chem-player h4 { margin: 0 0 2px; font-size: 13px; }
.chart { overflow-x: auto; }
/* The card charts scale to their container: a fixed-width SVG would
   overflow the card on a narrow screen. */
.chart svg { width: 100%; height: auto; max-width: 100%; }
/* The heatmap keeps its natural size and scrolls sideways when it does
   not fit, because scaling it down would make the numbers unreadable. */
.heatmap-chart svg { width: auto; height: auto; max-width: none; }
.legend {
  display: inline-block;
  font-size: 12px;
  color: var(--muted);
  margin: 2px 0 8px;
}
.method-grid { display: grid; grid-template-columns: 1fr; gap: 6px 24px; }
@media (min-width: 760px) { .method-grid { grid-template-columns: 1fr 1fr; } }
.method-grid div { font-size: 14px; margin-bottom: 4px; }
.method-grid + h3 { margin-top: 22px; }
.note {
  background: var(--paper);
  border: 1px solid var(--line);
  border-left: 4px solid var(--ink);
  border-radius: 6px;
  padding: 10px 14px;
  margin: 12px 0;
}
`;

/** The page's title, naming the league and the data window. */
function header(data: PageData): string {
  return `
    <header>
      <h1>Parity team preview: league ${data.leagueId}</h1>
      <p class="lede muted">A synergy rating for each roster, built from every game in our store and
      the people on these rosters. This is a live report: it is regenerated as games are played and as
      rosters change.</p>
      <p class="small muted">Players are rated on their own store history, not on their current
      roster alone. A team's roster can change from game to game, so every number here is about
      the people on the roster and the history they carry, never about a team as an entity.</p>
    </header>`;
}

/** One team card. */
function teamCard(section: TeamSection, data: PageData): string {
  const { team } = section;
  const returning = team.rosterNames.filter((name) => !team.unknownNames.includes(name));
  const pairCount = team.rating.pairCount;
  const sharedPoints = team.rating.sharedPointCount;
  const sharedGames = team.sharedGames;
  const hasRating = team.rating.contributingPlayers > 0;

  const best = section.bestPair
    ? `<div class="pair-box"><h4>Best pairing</h4><p><b>${escapeXml(section.bestPair.a)}</b> with
       <b>${escapeXml(section.bestPair.b)}</b><br><span class="tabular">${formatMoney(section.bestPair.excess)}</span>
       excess per shared point over <span class="tabular">${section.bestPair.sharedPoints}</span> shared points</p></div>`
    : "";
  const worst = section.worstPair
    ? `<div class="pair-box"><h4>Weakest pairing</h4><p><b>${escapeXml(section.worstPair.a)}</b> with
       <b>${escapeXml(section.worstPair.b)}</b><br><span class="tabular">${formatMoney(section.worstPair.excess)}</span>
       excess per shared point over <span class="tabular">${section.worstPair.sharedPoints}</span> shared points</p></div>`
    : "";

  const earners = section.topEarners
    .map(
      (earner) =>
        `<span class="chip tabular">${escapeXml(earner.name)}: ${formatMoney(Math.round(earner.salaryPerPoint))}/point</span>`,
    )
    .join("");

  // A roster with no shared history has no rating to report. Showing a
  // zero would read as a mid-pack result rather than as missing data.
  // The comparison note sits under the number in the corner, so the
  // corner block always carries the headline stat and its caption
  // together. The number takes the palette's full colour for its sign,
  // so a small positive rating still reads as positive rather than as
  // the near-neutral grey a faded bar would give.
  const ratingColour = signColour(team.rating.rating, "synergy");
  const ratingBlock = hasRating
    ? `<div class="rating tabular"${
        ratingColour === undefined ? "" : ` style="color: ${ratingColour}"`
      }>${team.rating.rating >= 0 ? "+" : ""}${formatNumber(team.rating.rating)}</div>
       <p class="rating-note tabular">${changeNote(team)}</p>`
    : `<div class="rating muted tabular">no rating</div>
       <p class="rating-note">no shared history on this roster yet</p>`;

  // A roster change is its own news: the two figures then describe
  // different groups of people, so the card says so beside the number.
  const rosterNote = team.rosterChanged
    ? `<p class="roster-note">The roster changed since the last report, so this figure is for a different group of people than the one it is compared against.</p>`
    : "";

  // A rating on very few pairings is thin evidence, and the card has to
  // say so next to the number rather than in a footnote.
  const thinNote =
    hasRating && pairCount < 8
      ? `<p class="thin-note">Only ${pairCount} pairings behind this number, so it rests on little history.</p>`
      : "";

  return `
    <article class="card">
      <div class="card-head">
        <h3>${escapeXml(team.name)}</h3>
        <div>
          ${ratingBlock}
        </div>
      </div>
      ${rosterNote}
      ${thinNote}
      <div class="stat-row small">
        <span class="stat tabular"><b>${pairCount}</b> pairings</span>
        <span class="stat tabular"><b>${sharedPoints}</b> shared points</span>
        <span class="stat tabular"><b>${sharedGames}</b> shared games</span>
        <span class="stat-group">
          <span class="stat tabular"><b>${team.storePlayerIds.length}</b> of ${team.rosterNames.length} players in our data</span>
          <span class="stat tabular"><b>${team.rating.contributingPlayers}</b> contributing</span>
        </span>
      </div>
      ${
        hasRating
          ? `<div class="chart">${ratingBarSvg({
              label: "Current synergy",
              value: team.rating.rating,
              max: ratingScaleMax(data),
              note: `${pairCount} pairings, ${sharedGames} shared games`,
              pairCount,
            })}</div>`
          : ""
      }
      <div class="pair-grid">${best}${worst}</div>
      <div class="roster">
        <h4>Top earners by salary per point</h4>
        <div class="chips">${earners}</div>
        <h4>Roster with history in our data (${returning.length})</h4>
        <div class="chips">${returning.map((name) => `<span class="chip">${escapeXml(name)}</span>`).join("")}</div>
        <h4>No history in our data (${team.unknownNames.length})</h4>
        <div class="chips">${
          team.unknownNames.length > 0
            ? team.unknownNames.map((name) => `<span class="chip unknown">${escapeXml(name)}</span>`).join("")
            : '<span class="small muted">None</span>'
        }</div>
      </div>
    </article>`;
}

/**
 * The line under the rating: the change since the last ingested game.
 * A roster change is reported on its own line, because it is a
 * different kind of news and the two together do not fit beside the
 * number.
 */
function changeNote(team: ResolvedTeam): string {
  if (!team.hasComparison) return "first report for this roster";
  if (team.changeSinceLastGame === undefined) return "no change since the last report";
  const change = team.changeSinceLastGame;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${formatNumber(change)} since last game`;
}

/** The shared scale the rating bars are drawn on. */
function ratingScaleMax(data: PageData): number {
  const highest = Math.max(
    ...data.teams.map((section) => Math.abs(section.team.rating.rating)),
    1,
  );
  return Math.ceil(highest / 10) * 10;
}

/** The league-wide map: the roster-vs-roster heatmap. */
function heatmapSection(data: PageData): string {
  const svg = heatmapSvg(data.heatmap, {
    max: data.heatmapMax,
    title: "Roster against roster",
  });
  return `
    <section>
      <h2>The league-wide map</h2>
      <p class="lede muted">Each cell is the points-weighted mean suppression between the people on
      one roster and the people on another, from the store's opponent effects. Every cell carries the
      number of player pairs behind it.</p>
      <p class="legend">Suppression: salary per weighted point. Negative means the people on the row
      have earned less against the people on the column than against a typical opponent. This scale is
      its own; it is not the synergy scale above.</p>
      <div class="chart heatmap-chart">${svg}</div>
    </section>`;
}

/** The per-player chemistry view. */
function chemistrySection(data: PageData): string {
  const blocks = data.teams
    .map((section) => {
      const rows = section.chemistry
        .map(
          (player) => `
          <div class="chem-player">
            <div class="chart">${playerChemistrySvg({
              playerName: player.playerName,
              teammates: player.teammates,
            })}</div>
          </div>`,
        )
        .join("");
      return `
        <div class="chem-team">
          <h3>${escapeXml(section.team.name)}</h3>
          <p class="small muted">each player's excess per shared point with each teammate</p>
          <div class="chem-players">${rows}</div>
        </div>`;
    })
    .join("");
  return `
    <section>
      <h2>Roster synergy ratings</h2>
      <p class="lede muted">Each player's own excess with each teammate, so you can see who carries
      the chemistry and who is dragged down by it.</p>
      <p class="legend">Synergy: hold-and-break excess per shared point. Zero means the player earned
      what they would have earned alone. Green is above zero, red is below.</p>
      ${blocks}
    </section>`;
}

/** The method section: how the numbers were made and what they mean. */
function methodSection(data: PageData): string {
  const method = data.method;
  const sharedGameCounts = data.teams.map((section) => section.team.sharedGames);
  const leagueMin = sharedGameCounts.length > 0 ? Math.min(...sharedGameCounts) : 0;
  const leagueMax = sharedGameCounts.length > 0 ? Math.max(...sharedGameCounts) : 0;
  return `
    <section>
      <h2>How this was made</h2>
      <div class="note">
        <p><b>The rating</b> measures how much a roster's players earn from line-shared bonuses when
        they are on a line together, compared with what the same players earn on their own. Hold and
        break are the salary bonuses every player on a line receives when that line scores or forces a
        turnover, so they are the part of salary that depends on who else is on your line.</p>
        <p>Each player's excess with each teammate is averaged over their teammates, weighted by how
        much history each pairing has. The team rating is the mean over its players, so a player counts
        once no matter how many teammates they have, and thin pairings count for less. A pair needs at
        least 5 shared points to count.</p>
        <p>A positive rating means the roster earns more from line-shared bonuses with each other than
        the same players would alone. A rating near zero means the players neither lift each other nor
        drag each other down, which is a real result and not a lack of one: a roster can have a lot of
        shared history and still be flat.</p>
        <p><b>This is a live report.</b> Each rating covers every game in our store, so it moves as the
        season is played. The change since the last game is the difference from the previous report's
        figure. When a roster has changed, that comparison spans two different groups of people, and
        the card says so.</p>
      </div>
      <div class="method-grid">
        <div>Correlation with point differential: <b class="tabular">${method.correlationWithPointDiff.toFixed(3)}</b></div>
        <div>Correlation with amount of shared history: <b class="tabular">${method.correlationWithSharedPoints.toFixed(3)}</b></div>
        <div>The median game margin was <b class="tabular">${method.medianGameMargin}</b> points</div>
        <div>Games decided by 3 points or fewer: <b class="tabular">${method.gamesDecidedByThreeOrFewer}</b> of ${method.gamesInStore}</div>
        <div>Shared games behind these rosters' ratings: <b class="tabular">${leagueMin}</b> to <b class="tabular">${leagueMax}</b></div>
        <div>Store: <b class="tabular">${method.gamesInStore}</b> games, <b class="tabular">${method.pointsInStore}</b> points, <b class="tabular">${method.playersInStore}</b> players</div>
      </div>
      <h3>What these numbers do not say</h3>
      <ul class="small muted">
        <li>A player's team is a property of a game, not of a person. Teams trade, and players change
        teams mid-season, so no number here is a team's record or a head-to-head history between two
        teams as entities.</li>
        <li>Players with no history in our data may well have played in leagues our store does not
        cover. We report that gap rather than guessing at a player's background.</li>
        <li>Pairings and shared games are sample sizes. A rating on few pairings rests on less
        evidence than a rating on many, and every card says which it is.</li>
        <li>Goals and assists are excluded. They measure who is better individually, not who plays
        well together.</li>
      </ul>
    </section>`;
}

/** Build the complete HTML document. */
export function renderPage(data: PageData): string {
  const cards = data.teams.map((section) => teamCard(section, data)).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${header(data)}
<section>
<h2>The teams</h2>
<p class="lede muted">One card per roster, ordered by rating. Each card carries the sample size behind
the number: pairings, shared points, and shared games.</p>
<div class="cards">${cards}</div>
</section>
${heatmapSection(data)}
${chemistrySection(data)}
${methodSection(data)}
</div>
</body>
</html>
`;
}
