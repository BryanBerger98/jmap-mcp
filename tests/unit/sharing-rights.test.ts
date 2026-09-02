import { describe, expect, it } from "vitest";
import {
  ADDRESS_BOOK_RIGHTS,
  CALENDAR_RIGHTS,
  describeRights,
  FILE_NODE_RIGHTS,
  isKnownRight,
  linkedRightsNote,
  MAILBOX_RIGHTS,
  refuseUnknownRights,
  rightLabel,
  rightsOf,
} from "../../src/domains/sharing/rights.js";
import { SHAREABLE_TYPES } from "../../src/jmap/types/sharing.js";

describe("the four vocabularies", () => {
  it("carries exactly what the server declares, in its order", () => {
    // The counts are the assertion: ten, eight, four and six. A right added to
    // one of these lists without the server knowing it would be written true and
    // refused as invalidProperties, and one removed would be silently unwritable.
    expect(MAILBOX_RIGHTS).toEqual([
      "mayReadItems",
      "mayAddItems",
      "mayRemoveItems",
      "maySetSeen",
      "maySetKeywords",
      "mayCreateChild",
      "mayRename",
      "maySubmit",
      "mayDelete",
      "mayShare",
    ]);
    expect(CALENDAR_RIGHTS).toEqual([
      "mayReadFreeBusy",
      "mayReadItems",
      "mayWriteAll",
      "mayWriteOwn",
      "mayUpdatePrivate",
      "mayRSVP",
      "mayShare",
      "mayDelete",
    ]);
    expect(ADDRESS_BOOK_RIGHTS).toEqual(["mayRead", "mayWrite", "mayShare", "mayDelete"]);
    expect(FILE_NODE_RIGHTS).toEqual([
      "mayRead",
      "mayAddChildren",
      "mayRename",
      "mayDelete",
      "mayModifyContent",
      "mayShare",
    ]);
  });

  it("gives every shareable type a vocabulary", () => {
    for (const type of SHAREABLE_TYPES) {
      expect(rightsOf(type).length).toBeGreaterThan(0);
    }
  });

  it("shares only mayDelete and mayShare across all four", () => {
    const common = MAILBOX_RIGHTS.filter(
      (right) =>
        (CALENDAR_RIGHTS as readonly string[]).includes(right) &&
        (ADDRESS_BOOK_RIGHTS as readonly string[]).includes(right) &&
        (FILE_NODE_RIGHTS as readonly string[]).includes(right),
    );

    // Two names, and they mean the same thing everywhere: delete the container
    // itself, and hand the sharing on. Every other right is type-specific, which
    // is why no unified vocabulary is invented.
    expect(common).toEqual(["mayDelete", "mayShare"]);
  });
});

describe("isKnownRight", () => {
  it("accepts a right of the type", () => {
    expect(isKnownRight("Mailbox", "maySubmit")).toBe(true);
    expect(isKnownRight("AddressBook", "mayWrite")).toBe(true);
  });

  it("refuses a right that belongs to another type", () => {
    // mayWriteAll is a real right, just not one an address book has: the server
    // would ignore it written false and only complain written true.
    expect(isKnownRight("AddressBook", "mayWriteAll")).toBe(false);
    expect(isKnownRight("Mailbox", "mayAddChildren")).toBe(false);
  });
});

describe("refuseUnknownRights", () => {
  it("says nothing when every name belongs to the type", () => {
    expect(refuseUnknownRights("Calendar", ["mayReadItems", "mayRSVP"])).toBeUndefined();
  });

  it("names the right and the type", () => {
    const refusal = refuseUnknownRights("AddressBook", ["mayRead", "mayWriteAll"]);

    expect(refusal).toContain("mayWriteAll");
    expect(refusal).toContain("AddressBook");
    // The one that was fine is not reported as a problem.
    expect(refusal).not.toContain("no right named mayRead,");
  });

  it("lists what the type does know", () => {
    const refusal = refuseUnknownRights("AddressBook", ["mayCreateChild"]);

    for (const right of ADDRESS_BOOK_RIGHTS) {
      expect(refusal).toContain(right);
    }
  });
});

describe("describeRights", () => {
  it("renders granted rights with plain wording, never a bare property name", () => {
    const described = describeRights("Mailbox", { mayReadItems: true, mayAddItems: false });

    expect(described).toHaveLength(1);
    expect(described[0]).toContain("mayReadItems");
    // The name alone would be the whole line if no wording were attached.
    expect(described[0]).not.toBe("mayReadItems");
    expect(described[0]).toContain("read the messages it holds");
  });

  it("keeps the server's order rather than the order of the map", () => {
    const described = describeRights("Mailbox", { mayShare: true, mayReadItems: true });

    expect(described[0]).toContain("mayReadItems");
    expect(described[1]).toContain("mayShare");
  });

  it("leaves out what is not granted, and survives an absent map", () => {
    expect(describeRights("Calendar", { mayRSVP: false })).toEqual([]);
    expect(describeRights("Calendar", undefined)).toEqual([]);
  });

  it("never renders a right in another type's wording", () => {
    const book = describeRights("AddressBook", { mayRead: true });
    const node = describeRights("FileNode", { mayRead: true });

    expect(book[0]).toContain("cards");
    expect(node[0]).toContain("download");
    expect(book[0]).not.toBe(node[0]);
  });

  it("gives every right of every type its own wording", () => {
    for (const type of SHAREABLE_TYPES) {
      for (const right of rightsOf(type)) {
        expect(rightLabel(type, right)).not.toBe(right);
      }
    }
  });

  it("renders a name the server invented rather than losing the response", () => {
    expect(rightLabel("Mailbox", "mayTeleport")).toBe("mayTeleport");
  });
});

describe("linkedRightsNote", () => {
  it("says maySetKeywords follows maySetSeen on a folder", () => {
    const note = linkedRightsNote("Mailbox", ["maySetSeen"]);

    expect(note).toContain("maySetKeywords");
    expect(linkedRightsNote("Mailbox", ["maySetKeywords"])).toBe(note);
  });

  it("says mayWriteAll falls back when mayDelete moves on a calendar", () => {
    const note = linkedRightsNote("Calendar", ["mayDelete"]);

    expect(note).toContain("mayWriteAll");
    expect(note).toContain("mayDelete");
  });

  it("says nothing when no alias overlaps", () => {
    expect(linkedRightsNote("Mailbox", ["mayReadItems"])).toBeUndefined();
    expect(linkedRightsNote("AddressBook", ["mayDelete"])).toBeUndefined();
    expect(linkedRightsNote("FileNode", ["mayDelete"])).toBeUndefined();
  });

  it("does not carry a note from one type to another", () => {
    // mayDelete only overlaps on a calendar: a folder and a node delete cleanly.
    expect(linkedRightsNote("Mailbox", ["mayDelete"])).toBeUndefined();
  });
});
