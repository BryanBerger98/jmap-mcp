import { describe, expect, it } from "vitest";
import { restrictTo } from "../../src/config/recipients.js";
import { contactsSearch } from "../../src/domains/contacts/search.js";
import type {
  AddressBook,
  ContactCard,
  ContactCardQueryArguments,
} from "../../src/jmap/types/contacts.js";
import type { GetResponse, QueryResponse } from "../../src/jmap/types/core.js";
import { decodeCursor, encodeCursor, fingerprint } from "../../src/shared/pagination.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const query = loadFixture<QueryResponse>("contact-card-query.json");
const summaries = loadFixture<GetResponse<ContactCard>>("contact-cards-summary.json");
const books = loadFixture<GetResponse<AddressBook>>("address-book-get.json");

/** The three responses a full search consumes, in call order. */
const answers = (over: Partial<QueryResponse> = {}) => [{ ...query, ...over }, summaries, books];

/** What `contacts_search` seals into a cursor issued for `{ name: "silva" }`. */
const SILVA_CRITERIA = fingerprint({ name: "silva" });

const queryArgumentsOf = (requests: { methodCalls: [string, unknown, string][] }[]) =>
  requests[0]?.methodCalls[0]?.[1] as ContactCardQueryArguments;

describe("contacts_search", () => {
  it("spends exactly one round trip, on three calls", async () => {
    const { context, requests } = fakeTransport(answers());

    await contactsSearch.run({ name: "silva" }, context);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.methodCalls.map(([name]) => name)).toEqual([
      "ContactCard/query",
      "ContactCard/get",
      "AddressBook/get",
    ]);
  });

  it("maps each criterion onto its RFC 9610 condition", async () => {
    const { context, requests } = fakeTransport(answers());

    await contactsSearch.run(
      { name: "silva", email: "@example.org", organization: "Nephos", addressBookId: "bk-2" },
      context,
    );

    expect(queryArgumentsOf(requests).filter).toEqual({
      name: "silva",
      email: "@example.org",
      organization: "Nephos",
      inAddressBook: "bk-2",
    });
  });

  it("walks the whole book when no criterion is given, sending no filter at all", async () => {
    const { context, requests } = fakeTransport(answers());

    const { text } = await contactsSearch.run({}, context);

    expect(text).not.toMatch(/^Refused:/);
    expect(text).toContain("cc-01");
    expect(Object.hasOwn(queryArgumentsOf(requests), "filter")).toBe(false);
  });

  it("always sends a limit, a total request, and the creation-date sort", async () => {
    const { context, requests } = fakeTransport(answers());

    await contactsSearch.run({ text: "silva" }, context);
    const args = queryArgumentsOf(requests);

    expect(args.limit).toBe(25);
    expect(args.calculateTotal).toBe(true);
    expect(args.sort).toEqual([{ property: "created", isAscending: true }]);
  });

  it("feeds ContactCard/get through a back-reference, asking only for the row properties", async () => {
    const { context, requests } = fakeTransport(answers());

    await contactsSearch.run({ text: "silva" }, context);
    const getArguments = requests[0]?.methodCalls[1]?.[1];

    expect(getArguments?.["#ids"]).toEqual({
      resultOf: "0",
      name: "ContactCard/query",
      path: "/ids",
    });
    expect(getArguments?.properties).toEqual([
      "id",
      "kind",
      "name",
      "emails",
      "organizations",
      "addressBookIds",
    ]);
    expect(getArguments?.properties).not.toContain("notes");
  });

  it("asks for every address book of the account, unfiltered", async () => {
    const { context, requests } = fakeTransport(answers());

    await contactsSearch.run({ text: "silva" }, context);

    expect(requests[0]?.methodCalls[2]?.[1]).toMatchObject({ ids: null });
  });

  it("renders name, main address, organization and id, and counts the matches", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await contactsSearch.run({ name: "silva" }, context);

    expect(text).toContain("84 card(s) match");
    expect(text).toContain("Ana Silva");
    expect(text).toContain("ana.silva0@example.org");
    expect(text).toContain("Stalwart Labs");
    expect(text).toContain("cc-01");
  });

  it("announces the sort order and lists the address books in its header", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await contactsSearch.run({ organization: "Nephos" }, context);

    expect(text).toContain("creation date");
    expect(text).toContain("Personal (bk-1, default)");
    expect(text).toContain("Work (bk-2)");
  });

  it("warns that the name index is shared, and only when name was used", async () => {
    const { context } = fakeTransport(answers());
    const withName = await contactsSearch.run({ name: "silva" }, context);

    const other = fakeTransport(answers());
    const withoutName = await contactsSearch.run({ email: "silva" }, other.context);

    expect(withName.text).toContain("surname");
    expect(withoutName.text).not.toContain("surname");
  });

  it("hands back a cursor when the budget cuts the page short", async () => {
    const { context } = fakeTransport(answers());

    const result = await contactsSearch.run({ name: "silva", limit: 100 }, context);

    expect(result.nextCursor).toBeDefined();
    const cursor = decodeCursor(result.nextCursor ?? "");
    expect(cursor?.queryState).toBe("card-query-state-1");
    expect(cursor?.criteriaFingerprint).toBe(SILVA_CRITERIA);
    expect(cursor?.position).toBeGreaterThan(0);
    expect(cursor?.position).toBeLessThan(60);
  });

  it("refuses a cursor replayed under other criteria, before touching the network", async () => {
    const { context, requests } = fakeTransport(answers());
    const cursor = encodeCursor({
      position: 25,
      queryState: "card-query-state-1",
      criteriaFingerprint: SILVA_CRITERIA,
    });

    const result = await contactsSearch.run({ name: "roy", cursor }, context);

    expect(result.text).toMatch(/^Refused:/);
    expect(result.text).toContain("other criteria");
    expect(result.nextCursor).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("refuses an unreadable cursor before touching the network", async () => {
    const { context, requests } = fakeTransport(answers());

    const { text } = await contactsSearch.run({ cursor: "not-a-cursor" }, context);

    expect(text).toContain("unreadable");
    expect(requests).toHaveLength(0);
  });

  it("refuses to page on when the books changed under the cursor", async () => {
    const { context } = fakeTransport(answers({ queryState: "card-query-state-2" }));
    const cursor = encodeCursor({
      position: 25,
      queryState: "card-query-state-1",
      criteriaFingerprint: SILVA_CRITERIA,
    });

    const result = await contactsSearch.run({ name: "silva", cursor }, context);

    expect(result.text).toMatch(/^Refused:/);
    expect(result.text).toContain("from the start");
    expect(result.text).not.toContain("cc-01");
    expect(result.nextCursor).toBeUndefined();
  });

  it("resumes at the position the cursor carries", async () => {
    const { context, requests } = fakeTransport(answers());
    const cursor = encodeCursor({
      position: 25,
      queryState: "card-query-state-1",
      criteriaFingerprint: SILVA_CRITERIA,
    });

    await contactsSearch.run({ name: "silva", cursor }, context);

    expect(queryArgumentsOf(requests).position).toBe(25);
  });

  it("says an empty result is empty, rather than rendering a mute table", async () => {
    const empty: GetResponse<ContactCard> = { ...summaries, list: [] };
    const { context } = fakeTransport([{ ...query, ids: [], total: 0 }, empty, books]);

    const result = await contactsSearch.run({ name: "nobody" }, context);

    expect(result.text).toContain("0 card(s) match");
    expect(result.text).toContain("(no results)");
    expect(result.nextCursor).toBeUndefined();
  });

  it("stops offering a cursor once the page exhausts the result set", async () => {
    const short = { ...query, ids: query.ids.slice(0, 3), total: 3 };
    const { context } = fakeTransport([short, summaries, books]);

    const result = await contactsSearch.run({ name: "silva" }, context);

    expect(result.nextCursor).toBeUndefined();
    expect(result.text).toContain("3 card(s) match, 3 shown");
  });

  it("tells each row apart under a restricted perimeter", async () => {
    const scope = restrictTo({ fromContacts: ["ana.silva0@example.org"], allow: [] });
    const { context } = fakeTransport([{ ...query, ids: query.ids.slice(0, 3) }, summaries, books]);
    context.recipients = scope;

    const { text } = await contactsSearch.run({ name: "silva" }, context);

    expect(text).toContain("perimeter");
    expect(text).toContain("in perimeter");
    expect(text).toContain("outside perimeter");
  });

  it("dates the freeze in its header, once, wherever it renders a mark", async () => {
    const scope = restrictTo({ fromContacts: ["ana.silva0@example.org"], allow: [] });
    const { context } = fakeTransport([{ ...query, ids: query.ids.slice(0, 3) }, summaries, books]);
    context.recipients = scope;

    const { text } = await contactsSearch.run({ name: "silva" }, context);

    expect(text.match(/frozen at startup/g)).toHaveLength(1);
  });

  it("renders no perimeter column at all when nothing is restricted", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await contactsSearch.run({ name: "silva" }, context);

    expect(text).not.toContain("perimeter");
  });
});
