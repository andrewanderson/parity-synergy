/**
 * The SVG primitives for the preview page. Every function returns a
 * fragment string that begins with `<svg`. Nothing here depends on
 * interaction, external fonts, or a network resource: the page is read
 * from a screenshot, so every value is printed as text next to its
 * colour.
 */

/** Escape the characters that would otherwise be markup. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The two palettes. The measures are in different units and must not be read against each other. */
export type Palette = "suppression" | "synergy";

/** The neutral colour at zero, shared by both palettes. */
const NEUTRAL = "#e8e8e6";

/** The warm end of each palette: positive synergy, positive suppression. */
const WARM: Record<Palette, string> = {
  synergy: "#b5451b",
  suppression: "#7a2e8f",
};

/** The cool end of each palette: negative synergy, negative suppression. */
const COOL: Record<Palette, string> = {
  synergy: "#1f5b8f",
  suppression: "#1c7a5e",
};

/** Parse a `#rrggbb` colour into its channels. */
function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Render channels as a `#rrggbb` colour. */
function hex(r: number, g: number, b: number): string {
  const part = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * A colour scale centred on zero, for a value in a known range. `hue`
 * selects the palette so the two measures on the page, which are in
 * different units, cannot be read as the same scale. Zero maps to a
 * neutral grey in both palettes; positive values interpolate towards the
 * palette's warm colour, negative towards its cool one, saturating at
 * `max`. Out-of-range values are clamped.
 */
export function divergingColor(value: number, max: number, hue: Palette): string {
  if (!Number.isFinite(value) || max <= 0) return NEUTRAL;
  const clamped = Math.max(-max, Math.min(max, value));
  const target = clamped >= 0 ? WARM[hue] : COOL[hue];
  const [nr, ng, nb] = channels(NEUTRAL);
  const [tr, tg, tb] = channels(target);
  const strength = Math.abs(clamped) / max;
  return hex(
    nr + (tr - nr) * strength,
    ng + (tg - ng) * strength,
    nb + (tb - nb) * strength,
  );
}

/** One cell of the roster-vs-roster heatmap. */
export type HeatmapCell = {
  rowLabel: string;
  columnLabel: string;
  value: number;
  /** How many player pairs back the cell. */
  pairCount: number;
};

/** Render the heatmap as an SVG string. */
export function heatmapSvg(
  cells: HeatmapCell[],
  options: { max: number; title: string },
): string {
  const rows = [...new Set(cells.map((c) => c.rowLabel))];
  const columns = [...new Set(cells.map((c) => c.columnLabel))];
  const cellWidth = 96;
  const cellHeight = 62;
  const left = 132;
  const top = 96;
  const width = left + columns.length * cellWidth + 24;
  const height = top + rows.length * cellHeight + 40;

  const parts: string[] = [];
  // No xmlns attribute: inline SVG in an HTML document is placed in the
  // SVG namespace by the parser, and the page must contain no http
  // reference at all.
  parts.push(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`);
  parts.push(`<text x="16" y="30" font-size="17" font-weight="600">${escapeXml(options.title)}</text>`);
  parts.push(
    `<text x="16" y="52" font-size="12" fill="#555">suppression, salary per weighted point. Negative means the player on the row has earned less against the player on the column than against a typical opponent.</text>`,
  );

  for (const [index, column] of columns.entries()) {
    parts.push(
      `<text x="${left + index * cellWidth + cellWidth / 2}" y="${top - 10}" font-size="12" text-anchor="middle">${escapeXml(column)}</text>`,
    );
  }

  for (const [rowIndex, row] of rows.entries()) {
    parts.push(
      `<text x="${left - 12}" y="${top + rowIndex * cellHeight + cellHeight / 2 + 4}" font-size="12" text-anchor="end">${escapeXml(row)}</text>`,
    );
  }

  for (const cell of cells) {
    const rowIndex = rows.indexOf(cell.rowLabel);
    const columnIndex = columns.indexOf(cell.columnLabel);
    if (rowIndex < 0 || columnIndex < 0) continue;
    const x = left + columnIndex * cellWidth;
    const y = top + rowIndex * cellHeight;
    const fill = divergingColor(cell.value, options.max, "suppression");
    const text = fill === NEUTRAL ? "#333" : "#ffffff";
    parts.push(
      `<rect x="${x}" y="${y}" width="${cellWidth}" height="${cellHeight}" fill="${fill}" stroke="#ffffff" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${x + cellWidth / 2}" y="${y + cellHeight / 2 - 2}" font-size="14" text-anchor="middle" fill="${text}">${escapeXml(formatNumber(cell.value))}</text>`,
    );
    parts.push(
      `<text x="${x + cellWidth / 2}" y="${y + cellHeight / 2 + 14}" font-size="10" text-anchor="middle" fill="${text}" opacity="0.85">${cell.pairCount} pairs</text>`,
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

/**
 * One team rating, drawn as a labelled bar on a shared scale. The bar
 * runs from `-max` to `+max` with a visible zero line, so a negative
 * rating reads as negative rather than as a short bar.
 */
export function ratingBarSvg(input: {
  label: string;
  value: number;
  max: number;
  percentile: number;
  pairCount: number;
}): string {
  const width = 520;
  const height = 54;
  const left = 190;
  const barWidth = 280;
  const mid = left + barWidth / 2;
  const value = Number.isFinite(input.value) ? input.value : 0;
  const max = input.max > 0 ? input.max : 1;
  const clamped = Math.max(-max, Math.min(max, value));
  const barWidthUsed = (Math.abs(clamped) / max) * (barWidth / 2);
  const fill = divergingColor(value, max, "synergy");
  const text = fill === NEUTRAL ? "#333" : "#ffffff";

  const parts: string[] = [];
  parts.push(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`);
  parts.push(
    `<text x="0" y="22" font-size="13" font-weight="600">${escapeXml(input.label)}</text>`,
  );
  parts.push(
    `<text x="0" y="40" font-size="11" fill="#555">${Math.round(input.percentile * 100)}th percentile, ${input.pairCount} pairs</text>`,
  );
  parts.push(`<rect x="${left}" y="12" width="${barWidth}" height="24" fill="#f1f1ef"/>`);
  parts.push(
    `<rect x="${clamped >= 0 ? mid : mid - barWidthUsed}" y="12" width="${barWidthUsed}" height="24" fill="${fill}"/>`,
  );
  parts.push(`<line x1="${mid}" y1="8" x2="${mid}" y2="40" stroke="#333" stroke-width="1"/>`);
  parts.push(
    `<text x="${mid + barWidthUsed + 8}" y="29" font-size="13" font-weight="600" fill="${text === "#ffffff" ? "#333" : text}">${escapeXml(formatNumber(value))}</text>`,
  );
  parts.push("</svg>");
  return parts.join("");
}

/**
 * A player's excess with each teammate, as a small labelled bar chart.
 * Each bar is zero-centred, so a negative excess reads to the left.
 */
export function playerChemistrySvg(input: {
  playerName: string;
  teammates: { name: string; excess: number; sharedPoints: number }[];
}): string {
  const rowHeight = 26;
  const width = 460;
  const labelWidth = 150;
  const barArea = 190;
  const height = 48 + input.teammates.length * rowHeight;
  const mid = labelWidth + barArea / 2;
  const max = Math.max(
    1,
    ...input.teammates.map((t) => Math.abs(Number.isFinite(t.excess) ? t.excess : 0)),
  );

  const parts: string[] = [];
  parts.push(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`);
  parts.push(`<text x="0" y="16" font-size="13" font-weight="600">${escapeXml(input.playerName)}</text>`);
  parts.push(
    `<text x="0" y="30" font-size="10" fill="#555">synergy, hold-and-break excess per shared point, shared points in brackets</text>`,
  );

  input.teammates.forEach((teammate, index) => {
    const y = 44 + index * rowHeight;
    const excess = Number.isFinite(teammate.excess) ? teammate.excess : 0;
    const barWidthUsed = (Math.abs(excess) / max) * (barArea / 2);
    const fill = divergingColor(excess, max, "synergy");
    parts.push(
      `<text x="${labelWidth - 8}" y="${y + 12}" font-size="11" text-anchor="end">${escapeXml(teammate.name)}</text>`,
    );
    parts.push(`<line x1="${mid}" y1="${y + 3}" x2="${mid}" y2="${y + 17}" stroke="#999" stroke-width="1"/>`);
    parts.push(
      `<rect x="${excess >= 0 ? mid : mid - barWidthUsed}" y="${y + 5}" width="${barWidthUsed}" height="11" fill="${fill}"/>`,
    );
    parts.push(
      `<text x="${labelWidth + barArea + 12}" y="${y + 13}" font-size="11">${escapeXml(formatNumber(excess))} (${teammate.sharedPoints})</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("");
}

/**
 * A number for the page: one decimal place, with no trailing `.0` on
 * whole numbers beyond the first decimal.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
