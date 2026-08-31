import { describe, expect, it } from "vitest";
import { restrictTo } from "../../src/config/recipients.js";
import {
  bookNames,
  displayName,
  primaryEmail,
  renderBooks,
  renderCard,
  scopeMark,
} from "../../src/domains/contacts/card.js";
import type { AddressBook, ContactCard } from "../../src/jmap/types/contacts.js";
import type { GetResponse, Id } from "../../src/jmap/types/core.js";
import { loadFixture } from "../fixtures/client.js";

const cards = loadFixture<GetResponse<ContactCard>>("contact-cards-detail.json");
const booksResponse = loadFixture<GetResponse<AddressBook>>("address-book-get.json");

const byId = new Map<Id, AddressBook>(booksResponse.list.map((book) => [book.id, book]));

/** The three cards the fixture holds, named rather than indexed. */
const complete = cards.list[0] as ContactCard;
const group = cards.list[1] as ContactCard;
const componentsOnly = cards.list[2] as ContactCard;

/** A perimeter holding one of the complete card's two addresses. */
const restricted = restrictTo({ fromContacts: ["camille@example.org"], allow: [] });

const OPEN = { kind: "anyone" } as const;

describe("displayName", () => {
  it("takes the full name when the card carries one", () => {
    expect(displayName(complete)).toBe("Camille Roy");
  });

  it("recomposes the components when no full name exists, never an empty line", () => {
    const rendered = displayName(componentsOnly);

    expect(rendered).toContain("Ana");
    expect(rendered).toContain("Silva");
    // The separator component carries punctuation, not a name part.
    expect(rendered).not.toContain("-");
  });

  it("falls back to the organization, then to the address, then says so", () => {
    expect(displayName({ id: "x", organizations: { o: { name: "Stalwart Labs" } } })).toBe(
      "Stalwart Labs",
    );
    expect(displayName({ id: "x", emails: { e: { address: "solo@example.org" } } })).toBe(
      "solo@example.org",
    );
    expect(displayName({ id: "x" })).toBe("(unnamed)");
  });
});

describe("primaryEmail", () => {
  it("prefers the strongest stated preference, which JSContact numbers lowest", () => {
    expect(primaryEmail(complete)).toBe("camille.pro@example.net");
  });

  it("keeps the declaration order when nobody stated a preference", () => {
    const card: ContactCard = {
      id: "x",
      emails: { a: { address: "first@example.org" }, b: { address: "second@example.org" } },
    };

    expect(primaryEmail(card)).toBe("first@example.org");
  });

  it("has nothing to answer on a card with no address", () => {
    expect(primaryEmail(group)).toBeUndefined();
  });
});

describe("the address book legend", () => {
  it("names every book with the id a search takes back, and flags the default", () => {
    const legend = renderBooks(booksResponse.list);

    expect(legend).toContain("Personal");
    expect(legend).toContain("bk-1");
    expect(legend).toContain("default");
    expect(legend).toContain("Work");
    expect(legend).toContain("bk-2");
  });

  it("says so plainly when the account holds no book", () => {
    expect(renderBooks([])).toContain("none");
  });

  it("renders a book id that the get did not return, rather than inventing a name", () => {
    expect(bookNames(componentsOnly, byId)).toEqual(["bk-9"]);
    expect(bookNames(complete, byId)).toEqual(["Personal"]);
  });
});

describe("the perimeter mark", () => {
  it("marks nothing at all when nothing is restricted", () => {
    expect(scopeMark("anyone@example.test", OPEN)).toBeUndefined();
    expect(renderCard(complete, byId, OPEN)).not.toContain("perimeter");
  });

  it("tells each address of a card apart under a restricted perimeter", () => {
    const rendered = renderCard(complete, byId, restricted);

    expect(rendered).toContain("camille@example.org [in perimeter]");
    expect(rendered).toContain("camille.pro@example.net [outside perimeter]");
  });

  it("leaves the freeze notice to the tool, so a block never repeats it", () => {
    expect(renderCard(complete, byId, restricted)).not.toContain("frozen at startup");
  });

  it("puts every address outside an unreadable perimeter, and names the cause", () => {
    const scope = { kind: "unreadable", reason: "JMAP request failed: 503" } as const;
    const rendered = renderCard(complete, byId, scope);

    expect(scopeMark("camille@example.org", scope)).toContain("503");
    expect(rendered).toContain(
      "camille@example.org [outside perimeter (JMAP request failed: 503)]",
    );
    expect(rendered).not.toContain("[in perimeter]");
  });

  it("puts every address outside an empty perimeter", () => {
    expect(scopeMark("camille@example.org", { kind: "empty" })).toContain("outside perimeter");
  });
});

describe("renderCard", () => {
  it("renders every family of field a complete card carries", () => {
    const rendered = renderCard(complete, byId, OPEN);

    expect(rendered).toContain("card-1");
    expect(rendered).toContain("Camille Roy");
    expect(rendered).toContain("Cam");
    expect(rendered).toContain("Stalwart Labs");
    expect(rendered).toContain("Head of Infrastructure");
    expect(rendered).toContain("camille@example.org");
    expect(rendered).toContain("+33 1 23 45 67 89");
    expect(rendered).toContain("https://social.example/@camille");
    expect(rendered).toContain("75011 Paris");
    expect(rendered).toContain("JMAP working group");
    expect(rendered).toContain("Personal");
  });

  it("drops the fields a card does not carry, rather than rendering empty lines", () => {
    const rendered = renderCard(componentsOnly, byId, OPEN);

    expect(rendered).not.toContain("phones:");
    expect(rendered).not.toContain("notes:");
    expect(rendered).not.toMatch(/^\s*\w+:\s*$/m);
  });

  it("states the kind only when the card is not a person", () => {
    expect(renderCard(complete, byId, OPEN)).not.toContain("kind:");
    expect(renderCard(group, byId, OPEN)).toContain("kind: group");
  });

  it("renders a group as its member uids, reading no member card", () => {
    const rendered = renderCard(group, byId, OPEN);

    expect(rendered).toContain("members: 2");
    expect(rendered).toContain("urn:uuid:8f3a1c2e-0001");
    expect(rendered).toContain("urn:uuid:8f3a1c2e-0003");
    // The member cards are in the same fixture; none of their detail leaks in.
    expect(rendered).not.toContain("Camille Roy");
  });
});
