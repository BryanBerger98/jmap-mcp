import { describe, expect, it } from "vitest";
import { contactsBookManage } from "../../src/domains/contacts/book-manage.js";
import type { AddressBook } from "../../src/jmap/types/contacts.js";
import type { GetResponse, Invocation, JmapRequest } from "../../src/jmap/types/core.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const books = loadFixture<GetResponse<AddressBook>>("address-book-get.json");
const sets = loadFixture<Record<string, unknown>>("address-book-set.json");

/** An account down to its single book, which happens to be the default one. */
const soleBook: GetResponse<AddressBook> = {
  accountId: "acc-1",
  state: "book-state-1",
  list: [{ id: "bk-2", name: "Work", isDefault: false }],
  notFound: [],
};

function calls(requests: JmapRequest[]): Invocation[] {
  return requests.flatMap((request) => request.methodCalls);
}

function named(requests: JmapRequest[], method: string): Invocation[] {
  return calls(requests).filter((call) => call[0] === method);
}

describe("contacts_book_manage — the three actions", () => {
  it("creates a book, naming the id the server handed back", async () => {
    const { context, requests } = fakeTransport([sets.created]);

    const result = await contactsBookManage.run({ action: "create", name: "Clients" }, context);

    expect(result.text).toContain("Clients");
    expect(result.text).toContain("bk-9");

    const [, args] = named(requests, "AddressBook/set")[0] as Invocation;
    const created = (args.create as Record<string, AddressBook>).new as AddressBook;
    expect(created).toEqual({ name: "Clients" });
  });

  it("renames a book on its name alone, never touching isDefault", async () => {
    const { context, requests } = fakeTransport([sets.updated]);

    const result = await contactsBookManage.run(
      { action: "rename", bookId: "bk-2", name: "Clients" },
      context,
    );

    expect(result.text).toContain("Clients");

    const [, args] = named(requests, "AddressBook/set")[0] as Invocation;
    const patch = (args.update as Record<string, object>)["bk-2"] as object;
    expect(patch).toEqual({ name: "Clients" });
  });

  it("deletes an empty book, and says no card went with it", async () => {
    const { context, requests } = fakeTransport([sets.destroyed]);

    const result = await contactsBookManage.run({ action: "delete", bookId: "bk-2" }, context);

    expect(result.text).toContain("No contact card was destroyed");

    const [, args] = named(requests, "AddressBook/set")[0] as Invocation;
    expect(args.destroy).toEqual(["bk-2"]);
    expect(args.onDestroyRemoveContents).toBe(false);
  });
});

describe("contacts_book_manage — refusals", () => {
  it("refuses to delete a book still holding cards, naming how many", async () => {
    const { context, requests } = fakeTransport([books, sets.populated]);

    const refusal = await contactsBookManage.precheck?.(
      { action: "delete", bookId: "bk-2" },
      context,
    );

    expect(refusal).toContain("12 contact cards");
    expect(refusal).toContain("contacts_write");
    expect(named(requests, "AddressBook/set")).toHaveLength(0);
  });

  it("refuses to delete the default book, since a creation would lose its destination", async () => {
    const { context, requests } = fakeTransport([books]);

    const refusal = await contactsBookManage.precheck?.(
      { action: "delete", bookId: "bk-1" },
      context,
    );

    expect(refusal).toContain("default address book");
    expect(named(requests, "AddressBook/set")).toHaveLength(0);
  });

  it("refuses to delete the last book, since a card always belongs to one", async () => {
    const { context, requests } = fakeTransport([soleBook]);

    const refusal = await contactsBookManage.precheck?.(
      { action: "delete", bookId: "bk-2" },
      context,
    );

    expect(refusal).toContain("only address book");
    expect(named(requests, "AddressBook/set")).toHaveLength(0);
  });

  it("refuses a name another book already carries, naming that book", async () => {
    const { context, requests } = fakeTransport([books]);

    const refusal = await contactsBookManage.precheck?.(
      { action: "create", name: "work" },
      context,
    );

    expect(refusal).toContain("Work");
    expect(refusal).toContain("bk-2");
    expect(named(requests, "AddressBook/set")).toHaveLength(0);
  });

  it("refuses a book the account does not hold, and emits no set", async () => {
    const { context, requests } = fakeTransport([books]);

    const refusal = await contactsBookManage.precheck?.(
      { action: "rename", bookId: "bk-404", name: "Clients" },
      context,
    );

    expect(refusal).toContain("bk-404");
    expect(refusal).toContain("contacts_search");
    expect(named(requests, "AddressBook/set")).toHaveLength(0);
  });
});

describe("contacts_book_manage — the non-cascade", () => {
  it("states onDestroyRemoveContents false on all three actions, not only the delete", async () => {
    const creating = fakeTransport([sets.created]);
    await contactsBookManage.run({ action: "create", name: "Clients" }, creating.context);

    const renaming = fakeTransport([sets.updated]);
    await contactsBookManage.run(
      { action: "rename", bookId: "bk-2", name: "Clients" },
      renaming.context,
    );

    const deleting = fakeTransport([sets.destroyed]);
    await contactsBookManage.run({ action: "delete", bookId: "bk-2" }, deleting.context);

    const written = [
      ...named(creating.requests, "AddressBook/set"),
      ...named(renaming.requests, "AddressBook/set"),
      ...named(deleting.requests, "AddressBook/set"),
    ];

    expect(written).toHaveLength(3);
    for (const [, args] of written) expect(args.onDestroyRemoveContents).toBe(false);
  });
});

describe("contacts_book_manage — class", () => {
  it("destroys only on delete, and declares no move at all", () => {
    expect(contactsBookManage.classes).toEqual(["draft", "destroy"]);
    expect(contactsBookManage.classify({ action: "delete", bookId: "bk-2" })).toBe("destroy");
    expect(contactsBookManage.classify({ action: "create", name: "Clients" })).toBe("draft");
    expect(contactsBookManage.classify({ action: "rename", bookId: "bk-2", name: "C" })).toBe(
      "draft",
    );

    const parsed = contactsBookManage.inputSchema.safeParse({ action: "move", bookId: "bk-2" });
    expect(parsed.success).toBe(false);
  });
});
