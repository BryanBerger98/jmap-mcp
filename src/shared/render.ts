/**
 * JMAP objects to compact text.
 *
 * The client never sees a raw JMAP payload: it is verbose, deeply nested, and
 * most of it is noise for the question being asked.
 */

import type { SetError } from "../jmap/types/core.js";

/**
 * A `SetError` in one line, wherever a refusal has to be read rather than parsed.
 *
 * Nothing is mapped here on purpose: the server's own words beat any guess at
 * what it meant. Four domains rendered this exact line before it was hoisted,
 * and four copies would have drifted at the first correction.
 */
export function describeSetError(error: SetError): string {
  return error.description === undefined ? error.type : `${error.type} — ${error.description}`;
}

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

/**
 * The last index at or before `max` that does not fall inside a surrogate
 * pair.
 *
 * `String#slice` counts UTF-16 code units, not characters: a boundary chosen
 * without this check can land between the two halves of an emoji or another
 * character outside the Basic Multilingual Plane. A lone surrogate breaks
 * strict JSON clients; see `wellFormed` in `registry/compose.ts`.
 *
 * Exported because every cut of server- or model-provided text in this
 * codebase needs the same boundary, not only `truncate` below.
 */
export function surrogateSafeCut(text: string, max: number): number {
  const code = max > 0 ? text.charCodeAt(max - 1) : Number.NaN;
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = surrogateSafeCut(text, max - 1);
  return `${text.slice(0, cut)}…`;
}

/**
 * Degrades an HTML body to readable text.
 *
 * Deliberately naive, and deliberately dependency-free: the goal is a message
 * a reader can follow, not a faithful rendering. Blocks that carry no prose are
 * dropped whole, block-level tags become line breaks, the rest is stripped.
 */
/** Binary units, spelled as such: 180 KiB is 184320 bytes and says so. */
const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/**
 * A size a human reads, not a byte count they have to divide.
 *
 * Kept exact below a kibibyte, and given one decimal only where it carries
 * information: "180 KiB" is as precise as anybody needs, "180.0 KiB" is noise.
 *
 * Hoisted out of the files domain the day mail needed the same rendering for
 * an attachment's size: a second copy would have drifted at the first
 * correction, exactly as `describeSetError` above.
 */
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const shown = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${shown} ${UNITS[unit]}`;
}

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
