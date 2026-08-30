import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  fingerprint,
  takeWithinBudget,
} from "../../src/shared/pagination.js";

describe("cursors", () => {
  it("round-trips a cursor", () => {
    const cursor = { position: 50, queryState: "abc123", criteriaFingerprint: "deadbeef" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("returns undefined on a cursor that is not ours", () => {
    expect(decodeCursor("not-a-cursor")).toBeUndefined();
    expect(decodeCursor(Buffer.from('{"position":"x"}').toString("base64url"))).toBeUndefined();
  });

  it("rejects a cursor from the older shape rather than resuming without criteria", () => {
    const older = Buffer.from(JSON.stringify({ position: 50, queryState: "abc123" })).toString(
      "base64url",
    );

    expect(decodeCursor(older)).toBeUndefined();
  });
});

describe("fingerprint", () => {
  it("ignores key order, so the same criteria fingerprint the same", () => {
    expect(fingerprint({ from: "a", subject: "b" })).toBe(fingerprint({ subject: "b", from: "a" }));
  });

  it("separates criteria that differ, including one that was dropped", () => {
    expect(fingerprint({ from: "a", subject: "b" })).not.toBe(fingerprint({ from: "a" }));
    expect(fingerprint({ from: "a" })).not.toBe(fingerprint({ from: "b" }));
    expect(fingerprint(undefined)).not.toBe(fingerprint({ from: "a" }));
  });

  it("looks through arrays, where a header condition lives", () => {
    expect(fingerprint({ header: ["Delivered-To", "a@example.com"] })).not.toBe(
      fingerprint({ header: ["Delivered-To", "b@example.com"] }),
    );
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
