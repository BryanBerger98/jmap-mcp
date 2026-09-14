import { describe, expect, it } from "vitest";
import { renderFields, renderTable, truncate } from "../../src/shared/render.js";

describe("renderFields", () => {
  it("drops empty values instead of printing blank lines", () => {
    expect(renderFields({ from: "a@b.c", subject: "", cc: undefined, unread: true })).toBe(
      "from: a@b.c\nunread: true",
    );
  });

  it("joins arrays on one line", () => {
    expect(renderFields({ to: ["a@b.c", "d@e.f"] })).toBe("to: a@b.c, d@e.f");
  });
});

describe("renderTable", () => {
  it("says so when there is nothing to show", () => {
    expect(renderTable([], ["id"])).toBe("(no results)");
  });

  it("aligns columns on the widest cell", () => {
    const table = renderTable(
      [
        { id: "1", subject: "Hello" },
        { id: "22", subject: "Hi" },
      ],
      ["id", "subject"],
    );
    expect(table.split("\n")).toEqual(["id  subject", "--  -------", "1   Hello", "22  Hi"]);
  });
});

describe("truncate", () => {
  it("leaves a short string alone", () => {
    expect(truncate("abc", 5)).toBe("abc");
  });

  it("marks a cut with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
  });

  it("keeps an emoji fully inside the cut intact", () => {
    // "🎯" is a surrogate pair; well within max, it is not touched by the cut.
    const result = truncate("a🎯bcdef", 6);

    expect(result.isWellFormed()).toBe(true);
    expect(result).toContain("🎯");
  });

  it("cuts before an emoji straddling the boundary, rather than splitting it", () => {
    // "a🎯" is 3 UTF-16 units (1 + surrogate pair): a naive slice(0, 2) would
    // keep only the emoji's lone high surrogate.
    const result = truncate("a🎯bcdef", 3);

    expect(result.isWellFormed()).toBe(true);
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result).toBe("a…");
  });
});
