/**
 * Cursors and the token budget.
 *
 * A JMAP query happily returns thousands of ids. The client's context is the
 * scarce resource, so a page is capped by rendered size, not only by count.
 */

import { createHash } from "node:crypto";

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface Cursor {
  position: number;
  queryState: string;
  /**
   * Fingerprint of the criteria the first page ran on. A position only means
   * something inside the result set that produced it, so the criteria travel
   * with it and the resume refuses when they no longer match.
   */
  criteriaFingerprint: string;
}

export const DEFAULT_PAGE_SIZE = 25;

/**
 * A stable fingerprint of any JSON-shaped value.
 *
 * Key order and absent keys must not change the answer, otherwise two runs of
 * the same search would look like two different searches to the resume check.
 */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("base64url").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  const entries = Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1));

  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${stableJson(member)}`).join(",")}}`;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * The encoded form stays opaque to the client: a cursor from an older shape is
 * simply unreadable here, which the caller already handles as a stale cursor.
 */
export function decodeCursor(encoded: string): Cursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Cursor;
    return typeof parsed.position === "number" &&
      typeof parsed.queryState === "string" &&
      typeof parsed.criteriaFingerprint === "string"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Cuts a list at the first item that would push the rendering past `budget` characters. */
export function takeWithinBudget<T>(
  items: T[],
  render: (item: T) => string,
  budget: number,
): { taken: T[]; remaining: number } {
  let used = 0;
  const taken: T[] = [];

  for (const item of items) {
    used += render(item).length;
    if (used > budget && taken.length > 0) break;
    taken.push(item);
  }

  return { taken, remaining: items.length - taken.length };
}
