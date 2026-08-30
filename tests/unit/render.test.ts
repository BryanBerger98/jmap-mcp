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
});
