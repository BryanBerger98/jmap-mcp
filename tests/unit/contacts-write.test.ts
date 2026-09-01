import { describe, expect, it } from "vitest";
import { OPEN_SCOPE, restrictTo } from "../../src/config/recipients.js";
import { contactsWrite } from "../../src/domains/contacts/write.js";
import type { AddressBook, ContactCard } from "../../src/jmap/types/contacts.js";
import type { GetResponse, Invocation, JmapRequest } from "../../src/jmap/types/core.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const books = loadFixture<GetResponse<AddressBook>>("address-book-get.json");
const editable = loadFixture<GetResponse<ContactCard>>("contact-card-editable.json");
const detailed = loadFixture<GetResponse<ContactCard>>("contact-cards-detail.json");
const sets = loadFixture<Record<string, unknown>>("contact-card-set.json");

/** Every card the two fixtures hold, so a `get` can answer exactly what it was asked. */
const pool = [...editable.list, ...detailed.list];

/** A `ContactCard/get` answer holding the cards asked for, and only those. */
function cardsResponse(ids: string[]): GetResponse<ContactCard> {
  return {
    accountId: "acc-1",
    state: "contact-state-4",
    list: pool.filter((card) => ids.includes(card.id)),
    notFound: ids.filter((id) => !pool.some((card) => card.id === id)),
  };
}

/** An account whose books carry no default mark, and holds more than one. */
const undecidedBooks: GetResponse<AddressBook> = {
  accountId: "acc-1",
  state: "book-state-1",
  list: [
    { id: "bk-4", name: "Friends" },
    { id: "bk-5", name: "Clients" },
  ],
  notFound: [],
};

function calls(requests: JmapRequest[]): Invocation[] {
  return requests.flatMap((request) => request.methodCalls);
}

function named(requests: JmapRequest[], method: string): Invocation[] {
  return calls(requests).filter((call) => call[0] === method);
}

describe("contacts_write — creating", () => {
  it("names the id it created and the book it landed in", async () => {
    const { context, requests } = fakeTransport([books, sets.noMatch, sets.created]);

    const result = await contactsWrite.run(
      { name: "Noor Haddad", emails: { add: ["noor@example.org"] } },
      context,
    );

    expect(result.text).toContain("card-new");
    expect(result.text).toContain("Personal");
    // Read the books, then write alongside the duplicate lookup: two, never three.
    expect(requests).toHaveLength(2);
  });

  it("files the new card in the default book, since a card always belongs to one", async () => {
    const { context, requests } = fakeTransport([books, sets.noMatch, sets.created]);

    await contactsWrite.run({ name: "Noor Haddad" }, context);

    const [, args] = named(requests, "ContactCard/set")[0] as Invocation;
    const created = (args.create as Record<string, ContactCard>).new as ContactCard;
    expect(created.addressBookIds).toEqual({ "bk-1": true });
  });
});

describe("contacts_write — correcting", () => {
  it("sends one update carrying a single patched path", async () => {
    const { context, requests } = fakeTransport([
      cardsResponse(["card-e1"]),
      sets.noMatch,
      sets.updated,
    ]);

    await contactsWrite.run(
      { cardIds: ["card-e1"], emails: { add: ["camille@example.com"] } },
      context,
    );

    const written = named(requests, "ContactCard/set");
    expect(written).toHaveLength(1);

    const [, args] = written[0] as Invocation;
    const patch = (args.update as Record<string, object>)["card-e1"] as object;
    expect(Object.keys(patch)).toHaveLength(1);
    expect(Object.keys(patch)[0]).toMatch(/^emails\/e\d+$/);
  });

  it("corrects a name without naming a single other property of the card", async () => {
    const { context, requests } = fakeTransport([cardsResponse(["card-e1"]), sets.updated]);

    await contactsWrite.run({ cardIds: ["card-e1"], name: "Camille Roy-Martin" }, context);

    const [, args] = named(requests, "ContactCard/set")[0] as Invocation;
    const patch = (args.update as Record<string, object>)["card-e1"] as object;
    expect(Object.keys(patch)).toEqual(["name/full"]);
    // The read and the write, and nothing in between.
    expect(requests).toHaveLength(2);
  });

  it("files three cards in two round trips, one line accounting for each", async () => {
    const { context, requests } = fakeTransport([
      books,
      cardsResponse(["card-e1", "card-e2", "card-e3"]),
      sets.partiallyUpdated,
    ]);

    const result = await contactsWrite.run(
      { cardIds: ["card-e1", "card-e2", "card-e3"], addressBooks: { add: ["bk-2"] } },
      context,
    );

    expect(requests).toHaveLength(2);
    for (const id of ["card-e1", "card-e2", "card-e3"]) expect(result.text).toContain(id);
    expect(result.text).toContain("read-only");

    const [, args] = named(requests, "ContactCard/set")[0] as Invocation;
    for (const patch of Object.values(args.update as Record<string, object>)) {
      expect(Object.keys(patch)).toEqual(["addressBookIds/bk-2"]);
    }
  });

  it("resolves a member's card id into the uid the group is keyed by", async () => {
    const { context, requests } = fakeTransport([
      cardsResponse(["card-2"]),
      cardsResponse(["card-1"]),
      sets.updated,
    ]);

    await contactsWrite.run({ cardIds: ["card-2"], members: { add: ["card-1"] } }, context);

    const [, args] = named(requests, "ContactCard/set")[0] as Invocation;
    const patch = (args.update as Record<string, Record<string, unknown>>)["card-2"] as Record<
      string,
      unknown
    >;

    expect(patch).toEqual({ "members/urn:uuid:8f3a1c2e-0001": true });
    expect(Object.keys(patch)[0]).not.toContain("card-1");
  });
});

describe("contacts_write — refusals", () => {
  it("refuses a content field spread over several cards, naming the field", async () => {
    const { context, requests } = fakeTransport([]);

    const refusal = await contactsWrite.precheck?.(
      { cardIds: ["card-e1", "card-e2"], name: "Camille Roy" },
      context,
    );

    expect(refusal).toContain("name");
    expect(refusal).toContain("call once per card");
    expect(requests).toHaveLength(0);
  });

  it("refuses a creation with neither a name nor an address", async () => {
    const { context, requests } = fakeTransport([]);

    const refusal = await contactsWrite.precheck?.({ note: "Met at a conference." }, context);

    expect(refusal).toContain("at least a name or an email address");
    expect(requests).toHaveLength(0);
  });

  it("refuses an address book the account does not hold, and writes nothing", async () => {
    const { context, requests } = fakeTransport([books, cardsResponse(["card-e1"])]);

    const refusal = await contactsWrite.precheck?.(
      { cardIds: ["card-e1"], addressBooks: { add: ["bk-404"] } },
      context,
    );

    expect(refusal).toContain("bk-404");
    expect(refusal).toContain("contacts_search");
    expect(named(requests, "ContactCard/set")).toHaveLength(0);
  });

  it("refuses a creation with no book to put it in, listing the books to choose from", async () => {
    const { context, requests } = fakeTransport([undecidedBooks]);

    const refusal = await contactsWrite.precheck?.({ name: "Noor Haddad" }, context);

    expect(refusal).toContain("Friends (bk-4)");
    expect(refusal).toContain("Clients (bk-5)");
    expect(named(requests, "ContactCard/set")).toHaveLength(0);
  });

  it("refuses to take a card out of its last address book", async () => {
    const { context, requests } = fakeTransport([books, cardsResponse(["card-e2"])]);

    const refusal = await contactsWrite.precheck?.(
      { cardIds: ["card-e2"], addressBooks: { remove: ["bk-2"] } },
      context,
    );

    expect(refusal).toContain("card-e2");
    expect(refusal).toContain("contacts_delete");
    expect(named(requests, "ContactCard/set")).toHaveLength(0);
  });

  it("refuses members on a card that is not a group, pointing at kind", async () => {
    const { context, requests } = fakeTransport([cardsResponse(["card-e1"])]);

    const refusal = await contactsWrite.precheck?.(
      { cardIds: ["card-e1"], members: { add: ["card-1"] } },
      context,
    );

    expect(refusal).toContain("card-e1");
    expect(refusal).toContain("kind");
    expect(named(requests, "ContactCard/set")).toHaveLength(0);
  });

  it("refuses a batch past the shared ceiling", async () => {
    const { context, requests } = fakeTransport([]);
    const many = Array.from({ length: 51 }, (_, index) => `card-${index}`);

    const refusal = await contactsWrite.precheck?.({ cardIds: many }, context);

    expect(refusal).toContain("contact card");
    expect(requests).toHaveLength(0);
  });
});

describe("contacts_write — what it says after writing", () => {
  it("writes an address outside the perimeter and says the send stays refused", async () => {
    const scope = restrictTo({ fromContacts: ["camille@example.org"], allow: [] });
    const { context } = fakeTransport([books, sets.noMatch, sets.created], scope);

    const result = await contactsWrite.run(
      { name: "Noor Haddad", emails: { add: ["noor@example.org"] } },
      context,
    );

    expect(result.text).toContain("card-new");
    expect(result.text).toContain("outside the recipient perimeter");
    expect(result.text).toContain("restart");
  });

  it("flags an address another card already carries without blocking the write", async () => {
    const { context } = fakeTransport([books, sets.oneMatch, sets.created]);

    const result = await contactsWrite.run(
      { name: "Camille Roy", emails: { add: ["camille@example.org"] } },
      context,
    );

    expect(result.text).toContain("Created contact card card-new");
    expect(result.text).toContain("already on another card");
  });

  it("looks for duplicates in the same request as the write, so it sees the state before it", async () => {
    const { context, requests } = fakeTransport([books, sets.noMatch, sets.created]);

    await contactsWrite.run({ name: "Noor", emails: { add: ["noor@example.org"] } }, context);

    const write = requests[1] as JmapRequest;
    expect(write.methodCalls.map((call) => call[0])).toEqual([
      "ContactCard/query",
      "ContactCard/set",
    ]);
  });
});

describe("contacts_write — class and volume", () => {
  it("stays a draft whatever the arguments, because nothing here destroys or sends", () => {
    expect(contactsWrite.classes).toEqual(["draft"]);
    expect(contactsWrite.classify({ cardIds: ["a", "b", "c"] })).toBe("draft");
    expect(contactsWrite.classify({ name: "Noor" })).toBe("draft");
  });

  it("asks past the bulk threshold, naming the count and the threshold", async () => {
    const { context } = fakeTransport([], OPEN_SCOPE, 2);

    const reason = await contactsWrite.confirmWhen?.(
      { cardIds: ["a", "b", "c"], addressBooks: { add: ["bk-1"] } },
      context,
    );

    expect(reason).toContain("3 contact cards");
    expect(reason).toContain("2");
  });

  it("stays silent below the threshold", async () => {
    const { context } = fakeTransport([], OPEN_SCOPE, 5);

    const reason = await contactsWrite.confirmWhen?.({ cardIds: ["a", "b"] }, context);

    expect(reason).toBeUndefined();
  });
});

describe("contacts_write — never destroys", () => {
  it("emits no destroy, whichever branch it takes", async () => {
    const creating = fakeTransport([books, sets.noMatch, sets.created]);
    await contactsWrite.run(
      { name: "Noor", emails: { add: ["noor@example.org"] } },
      creating.context,
    );

    const correcting = fakeTransport([books, cardsResponse(["card-e1"]), sets.updated]);
    await contactsWrite.run(
      { cardIds: ["card-e1"], addressBooks: { add: ["bk-2"] } },
      correcting.context,
    );

    for (const [, args] of [...calls(creating.requests), ...calls(correcting.requests)]) {
      expect(args.destroy).toBeUndefined();
      expect(args.onDestroyRemoveContents).toBeUndefined();
    }
  });
});
