import { describe, expect, it } from "vitest";
import {
  checkRecipients,
  describeScope,
  OPEN_SCOPE,
  partitionAllowList,
  type RecipientScope,
  restrictTo,
} from "../../src/config/recipients.js";
import { configSchema } from "../../src/config/schema.js";
import { JmapClient } from "../../src/jmap/client.js";
import { JmapSession } from "../../src/jmap/session.js";
import type { ContactCard } from "../../src/jmap/types/contacts.js";
import type { GetResponse, QueryResponse, Session } from "../../src/jmap/types/core.js";
import { CAPABILITY_CONTACTS } from "../../src/jmap/types/core.js";
import { resolveRecipientScope } from "../../src/server.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const contactCards = loadFixture<GetResponse<ContactCard>>("contact-cards.json");

/** Every card id the fixture holds, as `ContactCard/query` would answer. */
const cardQuery: QueryResponse = {
  accountId: "acc-1",
  queryState: "contact-query-state-1",
  canCalculateChanges: false,
  position: 0,
  ids: ["card-1", "card-2"],
  total: 2,
};

/** The three addresses the two cards carry, folded as the perimeter holds them. */
const fromContacts = ["camille@example.org", "camille.pro@example.net", "ana@example.org"];

const books: RecipientScope = restrictTo({ fromContacts, allow: [] });

/** A session that advertises contacts, which the mail fixture does not. */
function sessionWithContacts(): JmapSession {
  const raw = loadFixture<Session>("session.json");
  return new JmapSession(
    { ...raw, capabilities: { ...raw.capabilities, [CAPABILITY_CONTACTS]: {} } },
    "acc-1",
  );
}

describe("checkRecipients", () => {
  it("lets anything through when no perimeter was configured", () => {
    expect(checkRecipients(["stranger@elsewhere.test"], OPEN_SCOPE).ok).toBe(true);
  });

  it("allows an address a contact card carries", () => {
    expect(checkRecipients(["camille@example.org"], books).ok).toBe(true);
  });

  it("ignores the casing on both sides", () => {
    expect(checkRecipients(["CAMILLE@Example.ORG"], books).ok).toBe(true);
  });

  it("allows an address listed explicitly, outside any address book", () => {
    const scope = restrictTo({ fromContacts: [], allow: ["ops@example.net"] });

    expect(checkRecipients(["ops@example.net"], scope).ok).toBe(true);
    expect(checkRecipients(["someone.else@example.net"], scope).ok).toBe(false);
  });

  it("allows every mailbox behind an allowed domain", () => {
    const scope = restrictTo({ fromContacts: [], allow: ["@example.net"] });

    expect(checkRecipients(["anyone@example.net"], scope).ok).toBe(true);
    expect(checkRecipients(["anyone@example.org"], scope).ok).toBe(false);
  });

  it("refuses the whole call, naming the address that is outside", () => {
    const verdict = checkRecipients(["camille@example.org", "stranger@elsewhere.test"], books);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.refusal).toContain("stranger@elsewhere.test");
    // The address that was fine is not paraded as if it were the problem.
    expect(verdict.ok === false && verdict.refusal).not.toContain("camille@example.org");
  });

  it("refuses everything when the perimeter is empty", () => {
    const verdict = checkRecipients(["camille@example.org"], { kind: "empty" });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.refusal).toContain("empty");
  });

  it("refuses everything when the perimeter could not be read, and says why", () => {
    const verdict = checkRecipients(["camille@example.org"], {
      kind: "unreadable",
      reason: "JMAP request failed: 503",
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.refusal).toContain("503");
  });
});

describe("building a perimeter", () => {
  it("unions the address books with the explicit list", () => {
    const scope = restrictTo({ fromContacts, allow: ["ops@example.net", "@partner.test"] });

    expect(scope.kind).toBe("restricted");
    expect(checkRecipients(["ana@example.org"], scope).ok).toBe(true);
    expect(checkRecipients(["ops@example.net"], scope).ok).toBe(true);
    expect(checkRecipients(["whoever@partner.test"], scope).ok).toBe(true);
  });

  it("is empty, not open, when nothing was found anywhere", () => {
    expect(restrictTo({ fromContacts: [], allow: [] })).toEqual({ kind: "empty" });
  });

  it("tells an address from a domain by the leading at sign", () => {
    expect(partitionAllowList(["a@b.test", "@c.test"])).toEqual({
      addresses: ["a@b.test"],
      domains: ["c.test"],
    });
  });
});

describe("the sentence the client is given", () => {
  it("says nothing at all about an open perimeter", () => {
    expect(describeScope(OPEN_SCOPE)).toBeUndefined();
  });

  it("announces an empty perimeter at once, rather than at the first send", () => {
    expect(describeScope({ kind: "empty" })).toContain("empty");
  });

  it("announces an unreadable one with its reason", () => {
    expect(describeScope({ kind: "unreadable", reason: "no contacts capability" })).toContain(
      "no contacts capability",
    );
  });

  it("counts what a restricted perimeter holds", () => {
    expect(describeScope(restrictTo({ fromContacts, allow: ["@partner.test"] }))).toContain("3");
  });
});

describe("resolving the perimeter at startup", () => {
  it("reads no contact at all when the perimeter is open", async () => {
    const { context, requests } = fakeTransport([]);

    const scope = await resolveRecipientScope(
      { scope: "anyone", allow: [] },
      context.session,
      context.client,
    );

    expect(scope).toEqual(OPEN_SCOPE);
    expect(requests).toEqual([]);
  });

  it("collects the addresses of every card", async () => {
    const { context, requests } = fakeTransport([cardQuery, contactCards]);

    const scope = await resolveRecipientScope(
      { scope: "contacts", allow: [] },
      sessionWithContacts(),
      context.client,
    );

    expect(requests.map((request) => request.methodCalls[0]?.[0])).toEqual([
      "ContactCard/query",
      "ContactCard/get",
    ]);
    expect(scope.kind).toBe("restricted");
    for (const address of ["camille@example.org", "camille.pro@example.net", "ana@example.org"]) {
      expect(checkRecipients([address], scope).ok).toBe(true);
    }
  });

  it("orders the query, so paging never skips a card", async () => {
    const { context, requests } = fakeTransport([cardQuery, contactCards]);

    await resolveRecipientScope(
      { scope: "contacts", allow: [] },
      sessionWithContacts(),
      context.client,
    );

    // Without a sort the page order is the server's business, and a card that
    // shifts between two pages leaves the perimeter without a word.
    expect(requests[0]?.methodCalls[0]?.[1]).toMatchObject({
      sort: [{ property: "created", isAscending: true }],
      position: 0,
    });
  });

  it("asks only for the property it reads", async () => {
    const { context, requests } = fakeTransport([cardQuery, contactCards]);

    await resolveRecipientScope(
      { scope: "contacts", allow: [] },
      sessionWithContacts(),
      context.client,
    );

    expect(requests[1]?.methodCalls[0]?.[1]).toMatchObject({ properties: ["emails"] });
  });

  it("reports an unreadable perimeter, never an empty one, when the server errors", async () => {
    const failing = new JmapClient({
      apiUrl: "https://mail.example.com/jmap/",
      bearerToken: "a-token",
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });

    const scope = await resolveRecipientScope(
      { scope: "contacts", allow: ["ops@example.net"] },
      sessionWithContacts(),
      failing,
    );

    expect(scope.kind).toBe("unreadable");
    // The explicit allow list does not become the perimeter on its own: a
    // failure that fell back to it would silently narrow, then authorise.
    expect(checkRecipients(["ops@example.net"], scope).ok).toBe(false);
  });

  it("refuses rather than opens when the server advertises no contacts", async () => {
    const { context, requests } = fakeTransport([]);

    const scope = await resolveRecipientScope(
      { scope: "contacts", allow: [] },
      context.session,
      context.client,
    );

    expect(scope.kind).toBe("unreadable");
    expect(requests).toEqual([]);
  });

  it("is empty, and stays restricted, when the account holds no card", async () => {
    const empty: QueryResponse = { ...cardQuery, ids: [], total: 0 };
    const { context } = fakeTransport([empty]);

    const scope = await resolveRecipientScope(
      { scope: "contacts", allow: [] },
      sessionWithContacts(),
      context.client,
    );

    expect(scope).toEqual({ kind: "empty" });
  });
});

describe("the configuration that turns it on", () => {
  const base = { sessionUrl: "https://mail.example.com/jmap", bearerToken: "a-token" };

  it("leaves the perimeter open when no key mentions it", () => {
    const parsed = configSchema.parse(base);

    expect(parsed.recipients).toEqual({ scope: "anyone", allow: [] });
  });

  it("accepts an address and a domain", () => {
    const parsed = configSchema.parse({
      ...base,
      recipients: { scope: "contacts", allow: ["ops@example.net", "@partner.test"] },
    });

    expect(parsed.recipients.allow).toEqual(["ops@example.net", "@partner.test"]);
  });

  it("refuses a bare domain, which could be read two ways", () => {
    const parsed = configSchema.safeParse({ ...base, recipients: { allow: ["partner.test"] } });

    expect(parsed.success).toBe(false);
  });

  it("refuses a scope it does not know", () => {
    const parsed = configSchema.safeParse({ ...base, recipients: { scope: "everyone" } });

    expect(parsed.success).toBe(false);
  });
});
