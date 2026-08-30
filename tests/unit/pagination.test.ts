import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, takeWithinBudget } from "../../src/shared/pagination.js";

describe("cursors", () => {
  it("round-trips a cursor", () => {
    const cursor = { position: 50, queryState: "abc123" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("returns undefined on a cursor that is not ours", () => {
    expect(decodeCursor("not-a-cursor")).toBeUndefined();
    expect(decodeCursor(Buffer.from('{"position":"x"}').toString("base64url"))).toBeUndefined();
  });
});

describe("takeWithinBudget", () => {
  const render = (item: string) => item;

  it("stops before the item that would blow the budget", () => {
    const { taken, remaining } = takeWithinBudget(["aaaa", "bbbb", "cccc"], render, 6);
    expect(taken).toEqual(["aaaa"]);
    expect(remaining).toBe(2);
  });

  it("always takes at least one item, even oversized", () => {
    const { taken, remaining } = takeWithinBudget(["aaaaaaaaaa"], render, 2);
    expect(taken).toEqual(["aaaaaaaaaa"]);
    expect(remaining).toBe(0);
  });

  it("takes everything when the budget allows", () => {
    const { taken, remaining } = takeWithinBudget(["a", "b"], render, 100);
    expect(taken).toEqual(["a", "b"]);
    expect(remaining).toBe(0);
  });
});
