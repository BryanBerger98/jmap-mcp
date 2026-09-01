import { describe, expect, it } from "vitest";
import { contactsDelete } from "../../src/domains/contacts/delete.js";
import { JmapClient } from "../../src/jmap/client.js";
import type { ContactCard } from "../../src/jmap/types/contacts.js";
import type { GetResponse, Invocation, JmapRequest } from "../../src/jmap/types/core.js";
import type { ToolContext } from "../../src/registry/define-tool.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

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

function calls(requests: JmapRequest[]): Invocation[] {
  return requests.flatMap((request) => request.methodCalls);
}

/** A context whose every round trip fails, to watch the summary degrade. */
function brokenTransport(): ToolContext {
  const { context } = fakeTransport([]);
  const fetchImpl = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;

  return {
    ...context,
    client: new JmapClient({
      apiUrl: "https://mail.example.com/jmap/",
      bearerToken: "a-token",
      fetchImpl,
    }),
  };
}

describe("contacts_delete — destroying", () => {
  it("destroys three cards in one call, accounting for each of them", async () => {
    const { context, requests } = fakeTransport([sets.partiallyDestroyed]);
    const ids = ["card-e1", "card-e2", "card-e3"];

    const result = await contactsDelete.run({ ids }, context);

    const written = calls(requests).filter((call) => call[0] === "ContactCard/set");
    expect(written).toHaveLength(1);
    const [, args] = written[0] as Invocation;
    expect(Object.keys(args).sort()).toEqual(["accountId", "destroy"]);
    for (const id of ids) expect(result.text).toContain(id);
    expect(result.text).toContain("read-only");
  });

  it("names the refusal the server gave, without claiming the card is gone", async () => {
    const { context } = fakeTransport([sets.notDestroyed]);

    const result = await contactsDelete.run({ ids: ["card-e1"] }, context);

    expect(result.text).toContain("No contact card was destroyed");
    expect(result.text).toContain("read-only");
  });

  it("sends the ids under destroy, and nothing else", async () => {
    const { context, requests } = fakeTransport([sets.destroyed]);

    await contactsDelete.run({ ids: ["card-e1"] }, context);

    const [, args] = calls(requests)[0] as Invocation;
    expect(args.destroy).toEqual(["card-e1"]);
    expect(Object.keys(args).sort()).toEqual(["accountId", "destroy"]);
  });
});

describe("contacts_delete — what it asks before destroying", () => {
  it("names the cards and their addresses, since a count cannot be arbitrated", async () => {
    const { context } = fakeTransport([cardsResponse(["card-e1"])]);

    const summary = await contactsDelete.summarize?.({ ids: ["card-e1"] }, context);

    expect(summary).toContain("Camille Roy");
    expect(summary).toContain("camille.pro@example.net");
    expect(summary).toContain("no trash");
  });

  it("falls back to the count when the read fails, rather than refusing the call", async () => {
    const context = brokenTransport();

    const summary = await contactsDelete.summarize?.({ ids: ["card-e1", "card-e2"] }, context);

    expect(summary).toContain("2 contact cards");
    expect(summary).toContain("no trash");
  });
});

describe("contacts_delete — refusals", () => {
  it("refuses an empty list, pointing at the search that finds ids", async () => {
    const { context, requests } = fakeTransport([]);

    const refusal = await contactsDelete.precheck?.({ ids: [] }, context);

    expect(refusal).toContain("contacts_search");
    expect(requests).toHaveLength(0);
  });

  it("refuses a batch past the shared ceiling, naming the batch size", async () => {
    const { context, requests } = fakeTransport([]);
    const many = Array.from({ length: 51 }, (_, index) => `card-${index}`);

    const refusal = await contactsDelete.precheck?.({ ids: many }, context);

    expect(refusal).toContain("contact card");
    expect(refusal).toContain("50");
    expect(requests).toHaveLength(0);
  });
});

describe("contacts_delete — class", () => {
  it("destroys whatever the arguments, and says a destroyed card never comes back", () => {
    expect(contactsDelete.classes).toEqual(["destroy"]);
    expect(contactsDelete.classify({ ids: ["a"] })).toBe("destroy");
    expect(contactsDelete.classify({ ids: ["a", "b", "c"] })).toBe("destroy");
    expect(contactsDelete.description).toContain("no trash");
  });
});

describe("contacts_delete — never writes", () => {
  it("emits no create and no update, on any branch", async () => {
    const destroying = fakeTransport([sets.destroyed]);
    await contactsDelete.run({ ids: ["card-e1"] }, destroying.context);

    const refused = fakeTransport([sets.notDestroyed]);
    await contactsDelete.run({ ids: ["card-e1"] }, refused.context);

    const summarizing = fakeTransport([cardsResponse(["card-e1"])]);
    await contactsDelete.summarize?.({ ids: ["card-e1"] }, summarizing.context);

    for (const [, args] of [
      ...calls(destroying.requests),
      ...calls(refused.requests),
      ...calls(summarizing.requests),
    ]) {
      expect(args.create).toBeUndefined();
      expect(args.update).toBeUndefined();
    }
  });
});
