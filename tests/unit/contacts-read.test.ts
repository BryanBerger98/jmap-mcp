import { describe, expect, it } from "vitest";
import { restrictTo } from "../../src/config/recipients.js";
import { contactsRead, MAX_CARDS } from "../../src/domains/contacts/read.js";
import type { AddressBook, ContactCard } from "../../src/jmap/types/contacts.js";
import type { GetResponse } from "../../src/jmap/types/core.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const cards = loadFixture<GetResponse<ContactCard>>("contact-cards-detail.json");
const books = loadFixture<GetResponse<AddressBook>>("address-book-get.json");

/** The pair of responses a read consumes, in call order. */
const answers = (over: Partial<GetResponse<ContactCard>> = {}) => [{ ...cards, ...over }, books];

describe("contacts_read", () => {
  it("refuses more ids than the ceiling, naming it in the schema", () => {
    const tooMany = Array.from({ length: MAX_CARDS + 1 }, (_, index) => `cc-${index}`);

    expect(contactsRead.inputSchema.safeParse({ ids: tooMany }).success).toBe(false);
    expect(contactsRead.inputSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(contactsRead.description).toContain(String(MAX_CARDS));
  });

  it("takes ids and nothing else: no criterion reaches the schema", () => {
    const parsed = contactsRead.inputSchema.parse({ ids: ["card-1"], name: "camille" });

    expect(Object.hasOwn(parsed, "name")).toBe(false);
  });

  it("spends exactly one round trip, on two independent calls", async () => {
    const { context, requests } = fakeTransport(answers());

    await contactsRead.run({ ids: ["card-1", "card-2", "card-3"] }, context);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.methodCalls.map(([name]) => name)).toEqual([
      "ContactCard/get",
      "AddressBook/get",
    ]);
    // Independent calls: nothing here is fed by a back-reference.
    expect(requests[0]?.methodCalls[1]?.[1]?.["#ids"]).toBeUndefined();
  });

  it("asks for the detail properties, and for every address book", async () => {
    const { context, requests } = fakeTransport(answers());

    await contactsRead.run({ ids: ["card-1"] }, context);
    const getArguments = requests[0]?.methodCalls[0]?.[1];

    expect(getArguments?.ids).toEqual(["card-1"]);
    expect(getArguments?.properties).toContain("phones");
    expect(getArguments?.properties).toContain("notes");
    expect(getArguments?.properties).toContain("members");
    expect(requests[0]?.methodCalls[1]?.[1]).toMatchObject({ ids: null });
  });

  it("renders every family of field a card carries, books included", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await contactsRead.run({ ids: ["card-1"] }, context);

    expect(text).toContain("Camille Roy");
    expect(text).toContain("camille@example.org");
    expect(text).toContain("+33 1 23 45 67 89");
    expect(text).toContain("Stalwart Labs");
    expect(text).toContain("Head of Infrastructure");
    expect(text).toContain("75011 Paris");
    expect(text).toContain("JMAP working group");
    expect(text).toContain("Personal");
  });

  it("hands the blocks back in the order they were asked for, separated", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await contactsRead.run({ ids: ["card-3", "card-1"] }, context);

    expect(text.indexOf("card-3")).toBeLessThan(text.indexOf("card-1"));
    expect(text).toContain("-".repeat(60));
  });

  it("names an id the account does not hold, in the same answer as the cards", async () => {
    const { context } = fakeTransport(answers({ notFound: ["card-404"] }));

    const { text } = await contactsRead.run({ ids: ["card-1", "card-404"] }, context);

    expect(text).toContain("Camille Roy");
    expect(text).toContain("Not found: card-404");
  });

  it("answers the missing ids alone when not one was found, with no empty block", async () => {
    const { context } = fakeTransport(answers({ list: [], notFound: ["card-404"] }));

    const { text } = await contactsRead.run({ ids: ["card-404"] }, context);

    expect(text).toBe("Not found: card-404");
  });

  it("renders a group as its member uids, reading no member card", async () => {
    const { context, requests } = fakeTransport(answers());

    const { text } = await contactsRead.run({ ids: ["card-2"] }, context);

    expect(text).toContain("kind: group");
    expect(text).toContain("members: 2");
    expect(text).toContain("urn:uuid:8f3a1c2e-0001");
    expect(requests).toHaveLength(1);
  });

  it("marks each address under a restricted perimeter, and dates the freeze", async () => {
    const { context } = fakeTransport(answers());
    context.recipients = restrictTo({ fromContacts: ["camille@example.org"], allow: [] });

    const { text } = await contactsRead.run({ ids: ["card-1"] }, context);

    expect(text).toContain("camille@example.org [in perimeter]");
    expect(text).toContain("camille.pro@example.net [outside perimeter]");
    expect(text).toContain("frozen at startup");
  });

  it("states the freeze once for the whole answer, whatever the card count", async () => {
    const { context } = fakeTransport(answers());
    context.recipients = restrictTo({ fromContacts: ["camille@example.org"], allow: [] });

    const { text } = await contactsRead.run({ ids: ["card-1", "card-2", "card-3"] }, context);

    expect(text.match(/frozen at startup/g)).toHaveLength(1);
  });

  it("says nothing about a freeze when nothing is restricted", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await contactsRead.run({ ids: ["card-1"] }, context);

    expect(text).not.toContain("frozen at startup");
  });

  it("classifies any call as a read, and counts what it is about to read", () => {
    const { context } = fakeTransport([]);

    // Arbitrary arguments, write-shaped keys included: none flips it.
    expect(contactsRead.classify({ ids: ["card-1"], destroy: true } as never)).toBe("read");
    expect(contactsRead.classes).toEqual(["read"]);
    expect(contactsRead.summarize({ ids: ["card-1", "card-2"] }, context)).toContain("2");
  });
});
