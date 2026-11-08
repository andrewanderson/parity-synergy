import { describe, expect, it } from "vitest";
import {
  divergingColor,
  formatMoney,
  heatmapSvg,
  playerChemistrySvg,
  readableTextColour,
  ratingBarSvg,
  signColour,
  signedMoney,
} from "../src/preview/charts.js";

/** The channels of a `#rrggbb` colour. */
function channels(colour: string): [number, number, number] {
  return [
    parseInt(colour.slice(1, 3), 16),
    parseInt(colour.slice(3, 5), 16),
    parseInt(colour.slice(5, 7), 16),
  ];
}

describe("divergingColor", () => {
  it("is neutral at zero and stronger at the extremes", () => {
    const mid = divergingColor(0, 100, "synergy");
    expect(divergingColor(100, 100, "synergy")).not.toBe(mid);
    expect(divergingColor(-100, 100, "synergy")).not.toBe(mid);
    expect(divergingColor(50, 100, "synergy")).not.toBe(divergingColor(100, 100, "synergy"));
  });

  it("always returns a hex colour", () => {
    for (const v of [-100, -1, 0, 1, 100]) {
      expect(divergingColor(v, 100, "synergy")).toMatch(/^#[0-9a-f]{6}$/);
      expect(divergingColor(v, 100, "suppression")).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("uses a different palette for the two measures so they cannot be compared", () => {
    expect(divergingColor(50, 100, "synergy")).not.toBe(divergingColor(50, 100, "suppression"));
    expect(divergingColor(0, 100, "synergy")).toBe(divergingColor(0, 100, "suppression"));
  });

  it("clamps an out-of-range value instead of producing an invalid colour", () => {
    expect(divergingColor(500, 100, "synergy")).toBe(divergingColor(100, 100, "synergy"));
    expect(divergingColor(-500, 100, "synergy")).toBe(divergingColor(-100, 100, "synergy"));
  });

  it("shows positive synergy in green and negative synergy in red", () => {
    const [pr, pg, pb] = channels(divergingColor(100, 100, "synergy"));
    expect(pg).toBeGreaterThan(pr);
    expect(pg).toBeGreaterThan(pb);
    const [nr, ng, nb] = channels(divergingColor(-100, 100, "synergy"));
    expect(nr).toBeGreaterThan(ng);
    expect(nr).toBeGreaterThan(nb);
  });
});

describe("signColour", () => {
  it("gives the palette's full colour for the sign", () => {
    expect(signColour(65.4, "synergy")).toBe(divergingColor(100, 100, "synergy"));
    expect(signColour(-46.5, "synergy")).toBe(divergingColor(-100, 100, "synergy"));
  });

  it("gives no colour to a value with no sign", () => {
    expect(signColour(0, "synergy")).toBeUndefined();
    expect(signColour(Number.NaN, "synergy")).toBeUndefined();
  });
});

describe("signedMoney", () => {
  it("puts the sign in front of the amount", () => {
    expect(signedMoney(949)).toBe("+$949");
    expect(signedMoney(-3172)).toBe("-$3,172");
  });

  it("leaves a zero without a sign", () => {
    expect(signedMoney(0)).toBe("$0");
  });

  it("copes with a value that is not a number", () => {
    expect(signedMoney(Number.NaN)).toBe("$0");
    expect(signedMoney(Number.POSITIVE_INFINITY)).toBe("$0");
  });
});

describe("heatmapSvg", () => {
  it("draws one cell per pair of row and column, labelled with the value and count", () => {
    const cells = [
      { rowLabel: "A", columnLabel: "B", value: 120, pairCount: 22 },
      { rowLabel: "B", columnLabel: "A", value: -80, pairCount: 22 },
    ];
    const svg = heatmapSvg(cells, { max: 150, title: "Suppression" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Suppression");
    expect(svg).toContain("120");
    expect(svg).toContain("-80");
    expect(svg).toContain("22");
    expect(svg).not.toContain("http://");
    expect(svg).not.toContain("https://");
  });

  it("keeps the value legible on a light cell", () => {
    // A small value lands on a fill only slightly off the neutral grey,
    // so the text must be dark, not white.
    const svg = heatmapSvg([{ rowLabel: "A", columnLabel: "B", value: 1, pairCount: 3 }], {
      max: 760,
      title: "Suppression",
    });
    const fill = /<rect[^>]*fill="(#[0-9a-f]{6})"/.exec(svg)?.[1];
    expect(fill).toBeDefined();
    expect(readableTextColour(fill!)).toBe("#333333");
  });

  it("keeps the value legible on a dark cell", () => {
    const svg = heatmapSvg([{ rowLabel: "A", columnLabel: "B", value: 760, pairCount: 30 }], {
      max: 760,
      title: "Suppression",
    });
    const fill = /<rect[^>]*fill="(#[0-9a-f]{6})"/.exec(svg)?.[1];
    expect(fill).toBeDefined();
    expect(readableTextColour(fill!)).toBe("#ffffff");
  });

  it("escapes markup in labels", () => {
    const svg = heatmapSvg([{ rowLabel: "A & B", columnLabel: "<script>", value: 1, pairCount: 1 }], {
      max: 150,
      title: "Suppression",
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&amp;");
  });
});

describe("readableTextColour", () => {
  it("picks dark text on a light fill and light text on a dark fill", () => {
    expect(readableTextColour("#ffffff")).toBe("#333333");
    expect(readableTextColour("#000000")).toBe("#ffffff");
  });

  it("switches at the point where white text stops being readable", () => {
    // Mid-lightness greys must not get white text.
    expect(readableTextColour("#999999")).toBe("#333333");
    expect(readableTextColour("#444444")).toBe("#ffffff");
  });
});

describe("ratingBarSvg", () => {
  it("prints the value, the note and the pair count", () => {
    const svg = ratingBarSvg({
      label: "Set Phasers to Huck",
      value: 65,
      max: 100,
      note: "24 pairings, +3.1 since last game",
      pairCount: 24,
    });
    expect(svg).toContain("Set Phasers to Huck");
    expect(svg).toContain("65");
    expect(svg).toContain("24");
    expect(svg).toContain("since last game");
    expect(svg).not.toContain("http");
  });
});

describe("playerChemistrySvg", () => {
  it("prints each teammate, their excess and their shared points", () => {
    const svg = playerChemistrySvg({
      playerName: "Kendall Carmichael",
      teammates: [
        { name: "Bryan Mendez", excess: 1129, sharedPoints: 31 },
        { name: "Sarah Thompson", excess: -180, sharedPoints: 12 },
      ],
    });
    expect(svg).toContain("Kendall Carmichael");
    expect(svg).toContain("Bryan Mendez");
    expect(svg).toContain("31");
    expect(svg).toContain("Sarah Thompson");
    expect(svg).toContain("-$180");
  });
});

describe("formatMoney", () => {
  it("puts a dollar sign and thousands separators on the amount", () => {
    expect(formatMoney(5802)).toBe("$5,802");
    expect(formatMoney(1234567)).toBe("$1,234,567");
    expect(formatMoney(0)).toBe("$0");
  });

  it("shows cents on an amount that is not whole dollars", () => {
    expect(formatMoney(-233.4)).toBe("-$233.40");
    expect(formatMoney(374.1)).toBe("$374.10");
    expect(formatMoney(0.5)).toBe("$0.50");
  });

  it("puts the minus sign outside the dollar sign", () => {
    expect(formatMoney(-1)).toBe("-$1");
    expect(formatMoney(-1234.5)).toBe("-$1,234.50");
  });

  it("rounds to the cent", () => {
    expect(formatMoney(1.005)).toBe("$1.01");
    expect(formatMoney(2.344)).toBe("$2.34");
  });

  it("copes with a value that is not a number", () => {
    expect(formatMoney(Number.NaN)).toBe("$0");
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe("$0");
  });
});
