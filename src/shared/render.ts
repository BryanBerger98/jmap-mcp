/**
 * JMAP objects to compact text.
 *
 * The client never sees a raw JMAP payload: it is verbose, deeply nested, and
 * most of it is noise for the question being asked.
 */

/** Renders a record as `key: value` lines, dropping empty values. */
export function renderFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${stringify(value)}`)
    .join("\n");
}

/** Renders a list of records as a plain-text table with aligned columns. */
export function renderTable(rows: Record<string, unknown>[], columns: string[]): string {
  if (rows.length === 0) return "(no results)";

  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => stringify(row[column]).length)),
  );

  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();

  return [
    line(columns),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) => line(columns.map((column) => stringify(row[column])))),
  ].join("\n");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Degrades an HTML body to readable text.
 *
 * Deliberately naive, and deliberately dependency-free: the goal is a message
 * a reader can follow, not a faithful rendering. Blocks that carry no prose are
 * dropped whole, block-level tags become line breaks, the rest is stripped.
 */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|ul|ol)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      // Ampersands last: decoding them first would re-interpret `&amp;lt;`.
      .replace(/&amp;/gi, "&")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringify).join(", ");
  return JSON.stringify(value);
}
