import { isInputRequiredResult, type McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { contactsWritingDomain } from "../../src/domains/contacts/index.js";
import type { JmapSession } from "../../src/jmap/session.js";
import type { AddressBook, ContactCard } from "../../src/jmap/types/contacts.js";
import type { GetResponse, JmapRequest } from "../../src/jmap/types/core.js";
import { CAPABILITY_CONTACTS } from "../../src/jmap/types/core.js";
import { compose } from "../../src/registry/compose.js";
import type { ToolDefinition } from "../../src/registry/define-tool.js";
import { MAX_IDS_PER_CALL } from "../../src/shared/batch.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

/**
 * The invariant this file exists for: nothing is written to an address book
 * that the user did not ask for on this call, and nothing is erased from one
 * without being confirmed in words.
 *
 * Written over `contactsWritingDomain.tools` rather than over a list of names,
 * so a tool added to the manifest is held to the same guarantees the day it
 * lands. The one hand-written map below is checked against the manifest for
 * exhaustiveness: adding a destroying tool without an entry fails here.
 */

const books = loadFixture<GetResponse<AddressBook>>("address-book-get.json");
const cards = loadFixture<GetResponse<ContactCard>>("contact-card-editable.json");
const cardSets = loadFixture<Record<string, unknown>>("contact-card-set.json");
const bookSets = loadFixture<Record<string, unknown>>("address-book-set.json");

/**
 * Every key that would let a call name a set of cards instead of its members.
 *
 * The singular `email` and `phone` are `ContactCard/query` conditions; the
 * plural `emails` and `phones` are what a card carries, and a writing tool is
 * expected to take those. `organization` is deliberately absent: it is a query
 * condition *and* a field of a card, so its presence proves nothing either way.
 */
const CRITERIA = ["query", "search", "text", "filter", "email", "phone", "cursor", "position"];

/**
 * What it takes to reach the destroying branch of each tool, and what the
 * server has to answer before the confirmation is due.
 *
 * Hand-written because the arguments that classify as `destroy` are the tool's
 * own business, and a generic guess would confirm nothing about the real path.
 * The exhaustiveness test below is what keeps this map honest.
 */
const DESTROYING: Record<string, { input: Record<string, unknown>; responses: unknown[] }> = {
  contacts_delete: {
    input: { ids: ["card-e1"] },
    responses: [cards, cardSets.destroyed],
  },
  contacts_book_manage: {
    input: { action: "delete", bookId: "bk-2" },
    responses: [books, bookSets.empty, bookSets.destroyed],
  },
};

type Handler = (
  args: unknown,
  ctx: { mcpReq: { inputResponses?: Record<string, unknown>; envelope?: Record<string, unknown> } },
) => Promise<unknown>;

const CONFIRMED = {
  mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: true } } } },
};
const DECLINED = {
  mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: false } } } },
};

function writingSurface(
  responses: unknown[],
  capabilities: Record<string, unknown> | null,
  bulkConfirmAbove?: number,
) {
  const { context, requests } = fakeTransport(responses, { bulkConfirmAbove });
  const handlers = new Map<string, Handler>();

  compose({
    server: {
      registerTool(name: string, _config: unknown, cb: Handler) {
        handlers.set(name, cb);
      },
      ...(capabilities === null ? {} : { server: { getClientCapabilities: () => capabilities } }),
    } as unknown as McpServer,
    domains: [contactsWritingDomain],
    session: advertisingContacts(context.session),
    client: context.client,
    policy: DEFAULT_POLICY,
    ...(bulkConfirmAbove === undefined ? {} : { bulkConfirmAbove }),
  });

  return { handlers, requests };
}

/**
 * The session fixture, plus the contacts capability it does not advertise.
 *
 * The account it stands for is a mail account; gating is `contacts-read-only`'s
 * subject, and a manifest that registered nothing here would make every
 * assertion below pass on an empty handler map.
 */
function advertisingContacts(session: JmapSession): JmapSession {
  return Object.assign(Object.create(session) as JmapSession, {
    has: (uri: string) => uri === CAPABILITY_CONTACTS || session.has(uri),
  });
}

function methodsOf(requests: JmapRequest[]): string[] {
  return requests.flatMap((request) => request.methodCalls.map(([name]) => name));
}

function writesIn(requests: JmapRequest[]): string[] {
  return methodsOf(requests).filter((method) => method.endsWith("/set"));
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? "").join("");
}

function keysOf(tool: ToolDefinition): string[] {
  return Object.keys((tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape);
}

const TOOLS = contactsWritingDomain.tools.map((tool) => [tool.name, tool] as const);

const DESTROYERS = contactsWritingDomain.tools.filter((tool) => tool.classes.includes("destroy"));

describe("the writing manifest", () => {
  it("names every destroying tool in the cases below, so none escapes them", () => {
    // The day a tool declares `destroy` without an entry here, this goes red
    // rather than letting the tool through untested.
    expect(DESTROYERS.map((tool) => tool.name).sort()).toEqual(Object.keys(DESTROYING).sort());
  });

  it.each(TOOLS)("%s carries no search criterion, only ids and fields", (_name, tool) => {
    expect(keysOf(tool).filter((key) => CRITERIA.includes(key))).toEqual([]);
  });

  it.each(TOOLS)("%s shares the contacts_ prefix", (name) => {
    expect(name.startsWith("contacts_")).toBe(true);
  });
});

describe("a destroying contacts tool", () => {
  it.each(Object.entries(DESTROYING))(
    "%s is refused outright on a client that cannot be asked",
    async (name, { input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { roots: {} });

      const result = await handlers.get(name)?.(input, { mcpReq: {} });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("elicitation");
      expect(writesIn(requests)).toEqual([]);
    },
  );

  it.each(Object.entries(DESTROYING))(
    "%s puts the call to the user, and writes nothing while it waits",
    async (name, { input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { elicitation: {} });

      const result = await handlers.get(name)?.(input, { mcpReq: {} });

      expect(isInputRequiredResult(result)).toBe(true);
      expect(writesIn(requests)).toEqual([]);
    },
  );

  it.each(Object.entries(DESTROYING))(
    "%s writes nothing when the confirmation comes back false",
    async (name, { input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { elicitation: {} });

      await handlers.get(name)?.(input, DECLINED);

      expect(writesIn(requests)).toEqual([]);
    },
  );

  it.each(Object.entries(DESTROYING))(
    "%s writes only once the confirmation is granted",
    async (name, { input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { elicitation: {} });

      await handlers.get(name)?.(input, CONFIRMED);

      expect(writesIn(requests).length).toBeGreaterThan(0);
    },
  );
});

describe("the volume of a correction", () => {
  const THRESHOLD = 3;

  function ids(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `card-${index}`);
  }

  it("is put to the user past the threshold, without the call becoming a destruction", async () => {
    const { handlers, requests } = writingSurface(
      [books, cards, cardSets.partiallyUpdated],
      { elicitation: {} },
      THRESHOLD,
    );

    const input = { cardIds: ids(THRESHOLD + 1), addressBooks: { add: ["bk-2"] } };
    const result = await handlers.get("contacts_write")?.(input, { mcpReq: {} });

    expect(isInputRequiredResult(result)).toBe(true);
    expect(writesIn(requests)).toEqual([]);
    // The question comes from the volume, never from the class: correcting a
    // card stays a draft however many cards it touches.
    const tool = contactsWritingDomain.tools.find((each) => each.name === "contacts_write");
    expect(tool?.classify(input)).toBe("draft");
  });

  it("is refused past the hard ceiling, before any question is asked", async () => {
    const { handlers, requests } = writingSurface(
      [books, cards, cardSets.partiallyUpdated],
      { elicitation: {} },
      THRESHOLD,
    );

    const result = await handlers.get("contacts_write")?.(
      { cardIds: ids(MAX_IDS_PER_CALL + 1), addressBooks: { add: ["bk-2"] } },
      CONFIRMED,
    );

    expect(isInputRequiredResult(result)).toBe(false);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain(`batches of ${MAX_IDS_PER_CALL}`);
    expect(methodsOf(requests)).toEqual([]);
  });
});

describe("a creation", () => {
  it("never travels with a destruction, on either tool that creates", async () => {
    const card = writingSurface([books, cardSets.noMatch, cardSets.created], { elicitation: {} });
    await card.handlers.get("contacts_write")?.(
      { name: "Noor Haddad", emails: { add: ["noor@example.org"] } },
      { mcpReq: {} },
    );

    const book = writingSurface([books, bookSets.created], { elicitation: {} });
    await book.handlers.get("contacts_book_manage")?.(
      { action: "create", name: "Clients" },
      { mcpReq: {} },
    );

    const created = [...card.requests, ...book.requests].flatMap((request) =>
      request.methodCalls.filter(([, args]) => args.create !== undefined),
    );

    // Vacuously true if nothing was created, so the count is asserted first.
    expect(created).toHaveLength(2);
    for (const [, args] of created) {
      expect(args.destroy).toBeUndefined();
      expect(args.onDestroyRemoveContents).not.toBe(true);
    }
  });
});
