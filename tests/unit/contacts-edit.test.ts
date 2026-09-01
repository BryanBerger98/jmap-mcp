import { describe, expect, it } from "vitest";
import { restrictTo } from "../../src/config/recipients.js";
import {
  buildCreation,
  buildPatch,
  type CardEdit,
  defaultBook,
  describeCardOutcome,
  outsidePerimeterNote,
  resultingBooks,
} from "../../src/domains/contacts/edit.js";
import type { AddressBook, ContactCard } from "../../src/jmap/types/contacts.js";
import type { GetResponse, SetResponse } from "../../src/jmap/types/core.js";
import { loadFixture } from "../fixtures/client.js";

const cards = loadFixture<GetResponse<ContactCard>>("contact-card-editable.json");

/** Ten properties, two address books, two email addresses, one phone. */
const complete = cards.list[0] as ContactCard;
/** A name and one address book, nothing else: no emails, no phones, no notes. */
const bare = cards.list[1] as ContactCard;

const OPEN = { kind: "anyone" } as const;

describe("buildPatch — what nobody names stays untouched", () => {
  it("corrects a name with one leaf pointer and nothing else", () => {
    const patch = buildPatch(complete, { name: "Camille Roy-Martin" });

    expect(Object.keys(patch)).toEqual(["name/full"]);
    expect(patch["name/full"]).toBe("Camille Roy-Martin");
  });

  it("leaves the nine other properties of the card out of the patch", () => {
    const patch = buildPatch(complete, { name: "Camille Roy-Martin" });
    const keys = Object.keys(patch).join(" ");

    for (const untouched of ["emails", "phones", "organizations", "titles", "nicknames", "notes"]) {
      expect(keys).not.toContain(untouched);
    }
  });

  it("points into the existing entry when the parent map is there", () => {
    const patch = buildPatch(complete, { organization: "Stalwart", note: "Reviewed the draft." });

    expect(patch).toEqual({
      "organizations/o1/name": "Stalwart",
      "notes/no1/note": "Reviewed the draft.",
    });
  });
});

describe("buildPatch — coordinates", () => {
  it("adds an address under a free key, leaving the taken ones alone", () => {
    const patch = buildPatch(complete, { emails: { add: ["camille@example.com"] } });

    expect(Object.keys(patch)).toHaveLength(1);
    const [key] = Object.keys(patch);
    expect(key).toMatch(/^emails\/e\d+$/);
    // The card holds `personal` and `work`; neither may be written over.
    expect(key).not.toBe("emails/personal");
    expect(key).not.toBe("emails/work");
    expect(patch[key as string]).toEqual({ address: "camille@example.com" });
  });

  it("removes an address by its value, nulling the key that carried it", () => {
    const patch = buildPatch(complete, { emails: { remove: ["CAMILLE.PRO@example.NET"] } });

    expect(patch).toEqual({ "emails/work": null });
  });

  it("writes the whole map when the parent is absent, never a pointer inside it", () => {
    const patch = buildPatch(bare, { phones: { add: ["+33 6 00 00 00 00"] } });

    expect(Object.keys(patch)).toEqual(["phones"]);
    expect(patch.phones).toEqual({ p1: { number: "+33 6 00 00 00 00" } });
  });

  it("emits nothing for a family the card does not carry when asked to remove", () => {
    const patch = buildPatch(bare, { emails: { remove: ["noor@example.org"] } });

    expect(patch).toEqual({});
  });
});

describe("buildPatch — membership", () => {
  it("files the card in another book without disturbing the ones it sits in", () => {
    const patch = buildPatch(complete, { addressBooks: { add: ["bk-2"] } });

    expect(patch).toEqual({ "addressBookIds/bk-2": true });
    expect(Object.keys(patch)).not.toContain("addressBookIds");
  });

  it("nulls the pointer of a book the card leaves", () => {
    const patch = buildPatch(complete, { addressBooks: { remove: ["bk-3"] } });

    expect(patch).toEqual({ "addressBookIds/bk-3": null });
  });

  it("keys members by uid, as RFC 9553 requires", () => {
    const patch = buildPatch(bare, { members: { add: ["urn:uuid:8f3a1c2e-1001"] } });

    expect(patch).toEqual({ members: { "urn:uuid:8f3a1c2e-1001": true } });
  });

  it("refuses to replace and amend the same family in one call", () => {
    const contradictory: CardEdit = { addressBooks: { set: ["bk-2"], add: ["bk-3"] } };

    expect(() => buildPatch(complete, contradictory)).toThrow(/prefix of another/);
  });

  it("never emits two patches where one is the prefix of the other", () => {
    const patch = buildPatch(complete, {
      name: "Camille Roy-Martin",
      emails: { add: ["c@example.com"], remove: ["camille@example.org"] },
      addressBooks: { add: ["bk-2"] },
    });

    const keys = Object.keys(patch);
    for (const key of keys) {
      expect(keys.some((other) => other.startsWith(`${key}/`))).toBe(false);
    }
  });
});

describe("resultingBooks", () => {
  it("reads the books the card ends up in after an addition", () => {
    expect([...resultingBooks(complete, { addressBooks: { add: ["bk-2"] } })].sort()).toEqual([
      "bk-1",
      "bk-2",
      "bk-3",
    ]);
  });

  it("reads a replacement as the whole membership, not as an addition", () => {
    expect([...resultingBooks(complete, { addressBooks: { set: ["bk-9"] } })]).toEqual(["bk-9"]);
  });

  it("comes out empty when the card's last book is removed, so a refusal can see it", () => {
    const emptied = resultingBooks(bare, { addressBooks: { remove: ["bk-2"] } });

    expect(emptied.size).toBe(0);
  });
});

describe("buildCreation", () => {
  it("always files the new card in a book", () => {
    const created = buildCreation({ name: "Noor Haddad" }, ["bk-1"]);

    expect(created.addressBookIds).toEqual({ "bk-1": true });
  });

  it("writes each named field once and leaves the rest out of the object", () => {
    const edit: CardEdit = { name: "Noor Haddad", emails: { add: ["noor@example.org"] } };
    const created = buildCreation(edit, ["bk-1"]);

    expect(created.name).toEqual({ full: "Noor Haddad" });
    expect(Object.values(created.emails ?? {})).toEqual([{ address: "noor@example.org" }]);
    expect(created.phones).toBeUndefined();
    expect(created.notes).toBeUndefined();
  });
});

describe("defaultBook", () => {
  const personal: AddressBook = { id: "bk-1", name: "Personal", isDefault: true };
  const work: AddressBook = { id: "bk-2", name: "Work" };

  it("takes the book the server marked", () => {
    expect(defaultBook([work, personal])?.id).toBe("bk-1");
  });

  it("takes the only book of an account that has one", () => {
    expect(defaultBook([work])?.id).toBe("bk-2");
  });

  it("returns nothing rather than picking among several unmarked books", () => {
    expect(defaultBook([work, { id: "bk-3", name: "Family" }])).toBeUndefined();
  });
});

describe("describeCardOutcome", () => {
  it("never claims a success the server did not grant", () => {
    const response = {
      accountId: "acc-1",
      newState: "s2",
      notUpdated: { "card-e2": { type: "forbidden", description: "read-only book" } },
    } as unknown as SetResponse<unknown>;

    const rendered = describeCardOutcome(response, ["card-e1", "card-e2"], "updated");

    expect(rendered).toContain("1 of 2 contact cards updated");
    expect(rendered).toContain("read-only book");
  });

  it("reads the destroy half when asked for it", () => {
    const response = {
      accountId: "acc-1",
      newState: "s2",
      notDestroyed: { "card-e1": { type: "notFound" } },
    } as unknown as SetResponse<unknown>;

    const rendered = describeCardOutcome(response, ["card-e1"], "destroyed", "destroyed");

    expect(rendered).toContain("No contact card was destroyed");
    expect(rendered).toContain("notFound");
  });
});

describe("outsidePerimeterNote", () => {
  it("says nothing when the perimeter holds everyone", () => {
    expect(outsidePerimeterNote(["anyone@example.org"], OPEN)).toBeUndefined();
  });

  it("says nothing when every address written is already inside", () => {
    const scope = restrictTo({ fromContacts: ["camille@example.org"], allow: [] });

    expect(outsidePerimeterNote(["camille@example.org"], scope)).toBeUndefined();
  });

  it("warns that a send stays refused until the next start", () => {
    const scope = restrictTo({ fromContacts: ["camille@example.org"], allow: [] });
    const note = outsidePerimeterNote(["noor@example.org"], scope);

    expect(note).toContain("noor@example.org");
    expect(note).toContain("restart");
  });
});
