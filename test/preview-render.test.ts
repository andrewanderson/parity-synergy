import { describe, expect, it } from "vitest";
import { renderPage, type PageData } from "../src/preview/render.js";

const data: PageData = {
  leagueId: 25,
  teams: [
    {
      team: {
        name: "Set Phasers to Huck (Nick)",
        rosterNames: ["Kyle Hunter"],
        storePlayerIds: [1],
        unknownNames: ["New Player"],
        rating: {
          rating: 65.42,
          playerRatings: [],
          pairCount: 24,
          contributingPlayers: 9,
          sharedPointCount: 1504,
        },
        sharedGames: 88,
        changeSinceLastGame: 3.1,
        rosterChanged: false,
        hasComparison: true,
        gameHighWater: 1017,
        rosterSignature: "1,2,3",
      },
      chemistry: [
        { playerName: "Kyle Hunter", teammates: [{ name: "Bryan Mendez", excess: 1129, sharedPoints: 31 }] },
      ],
      bestPair: { a: "Kyle Hunter", b: "Bryan Mendez", sharedPoints: 31, excess: 1129 },
      worstPair: { a: "Kyle Hunter", b: "Sarah Thompson", sharedPoints: 8, excess: 375 },
      topEarners: [{ name: "Kyle Hunter", salaryPerPoint: 5802 }],
    },
  ],
  heatmap: [{ rowLabel: "A", columnLabel: "B", value: 120, pairCount: 22 }],
  heatmapMax: 150,
  method: {
    gamesInStore: 154,
    pointsInStore: 5898,
    playersInStore: 198,
    correlationWithPointDiff: 0.0089,
    correlationWithSharedPoints: -0.028,
    medianGameMargin: 4,
    gamesDecidedByThreeOrFewer: 73,
    sharedGameRange: { min: 2, max: 113, count: 41 },
  },
};

describe("renderPage", () => {
  it("includes every section", () => {
    const html = renderPage(data);
    expect(html).toContain("Set Phasers to Huck (Nick)");
    expect(html).toContain("65.4");
    expect(html).toContain("24");
    expect(html).toContain("New Player");
    expect(html).toContain("Bryan Mendez");
    expect(html).toContain("1129");
  });

  it("makes no network requests and loads no external resources", () => {
    const html = renderPage(data);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link[^>]+href/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/@import/i);
  });

  it("does not frame the rating as a prediction of results", () => {
    const html = renderPage(data);
    expect(html).not.toMatch(/predict/i);
    expect(html).not.toMatch(/winner/i);
    expect(html).toContain("0.009");
  });

  it("shows the median game margin and the count of close games", () => {
    const html = renderPage(data);
    expect(html).toContain("median game margin");
    expect(html).toContain("73");
  });

  it("shows the sample-size range across the rosters", () => {
    const html = renderPage(data);
    expect(html).toContain("Shared games behind these rosters");
    expect(html).toContain("88");
  });

  it("prints every sample size so a screenshot carries it", () => {
    const html = renderPage(data);
    expect(html).toContain("24");
    expect(html).toContain("1504");
    expect(html).toContain("31");
    expect(html).toContain("88");
  });

  it("shows the change since the last game", () => {
    const html = renderPage(data);
    expect(html).toContain("since last game");
    expect(html).toContain("+3.1");
  });

  it("says the roster changed when it did", () => {
    const html = renderPage({
      ...data,
      teams: [
        {
          ...data.teams[0],
          team: { ...data.teams[0].team, rosterChanged: true },
        },
      ],
    });
    expect(html).toContain("roster changed");
  });

  it("shows no rating for a roster with no shared history", () => {
    const html = renderPage({
      ...data,
      teams: [
        {
          ...data.teams[0],
          team: {
            ...data.teams[0].team,
            rating: {
              rating: 0,
              playerRatings: [],
              pairCount: 0,
              contributingPlayers: 0,
              sharedPointCount: 0,
            },
            changeSinceLastGame: undefined,
          },
        },
      ],
    });
    expect(html).toContain("no rating");
    expect(html).toContain("no shared history");
    expect(html).not.toContain("+0");
  });

  it("says a thin rating rests on little history", () => {
    const html = renderPage({
      ...data,
      teams: [
        {
          ...data.teams[0],
          team: {
            ...data.teams[0].team,
            rating: { ...data.teams[0].team.rating, pairCount: 5, contributingPlayers: 5 },
          },
        },
      ],
    });
    expect(html).toMatch(/Only 5 pairings/);
  });

  it("does not call the rating a percentile", () => {
    const html = renderPage(data);
    expect(html).not.toMatch(/percentile/i);
    expect(html).not.toMatch(/historical team-seasons/);
  });

  it("escapes markup in names", () => {
    const html = renderPage({
      ...data,
      teams: [
        {
          ...data.teams[0],
          team: { ...data.teams[0].team, name: "A & B <script>" },
        },
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
  });

  it("depends on no interaction, so a screenshot carries everything", () => {
    const html = renderPage(data);
    expect(html).not.toMatch(/onmouseover|onclick|onmouseenter/i);
    expect(html).not.toMatch(/<title>/i);
    expect(html).not.toMatch(/aria-describedby/i);
    // No collapsed content: a screenshot must carry every value, so
    // nothing may be hidden behind a click.
    expect(html).not.toMatch(/<details/i);
    expect(html).not.toMatch(/<summary/i);
  });

  it("gives each measure its own legend with its unit", () => {
    const html = renderPage(data);
    expect(html.toLowerCase()).toContain("suppression");
    expect(html.toLowerCase()).toContain("synergy");
  });

  it("does not claim a player is new to the league", () => {
    const html = renderPage(data);
    expect(html).not.toMatch(/new to the league/i);
    expect(html).toMatch(/no history in our data/i);
  });
});
