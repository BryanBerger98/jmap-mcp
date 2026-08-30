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

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringify).join(", ");
  return JSON.stringify(value);
}
