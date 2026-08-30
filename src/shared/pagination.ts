/**
 * Cursors and the token budget.
 *
 * A JMAP query happily returns thousands of ids. The client's context is the
 * scarce resource, so a page is capped by rendered size, not only by count.
 */

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface Cursor {
  position: number;
  queryState: string;
}

export const DEFAULT_PAGE_SIZE = 25;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(encoded: string): Cursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Cursor;
    return typeof parsed.position === "number" && typeof parsed.queryState === "string"
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
