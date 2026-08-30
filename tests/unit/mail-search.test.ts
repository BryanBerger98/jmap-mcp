import { describe, expect, it } from "vitest";
import { mailSearch } from "../../src/domains/mail/search.js";
import type { GetResponse, QueryResponse } from "../../src/jmap/types/core.js";
import type { Email, EmailQueryArguments } from "../../src/jmap/types/mail.js";
import { decodeCursor, encodeCursor, fingerprint } from "../../src/shared/pagination.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const query = loadFixture<QueryResponse>("email-query.json");
const envelopes = loadFixture<GetResponse<Email>>("email-get-envelope.json");

/** The pair of responses a full search consumes, in call order. */
const answers = (over: Partial<QueryResponse> = {}) => [{ ...query, ...over }, envelopes];

/** What `mail_search` seals into a cursor issued for `{ text: "invoice" }`. */
const INVOICE_CRITERIA = fingerprint({ text: "invoice" });

describe("mail_search", () => {
  it("refuses an empty input before touching the network", async () => {
    const { context, requests } = fakeTransport(answers());

    const { text } = await mailSearch.run({}, context);

    expect(text).toMatch(/^Refused:/);
    expect(requests).toHaveLength(0);
  });

  it("refuses an unreadable cursor before touching the network", async () => {
    const { context, requests } = fakeTransport(answers());

    const { text } = await mailSearch.run({ cursor: "not-a-cursor" }, context);

    expect(text).toMatch(/^Refused:/);
    expect(requests).toHaveLength(0);
  });

  it("spends exactly one round trip whatever the result count", async () => {
    const { context, requests } = fakeTransport(answers());

    await mailSearch.run({ from: "stalw.art" }, context);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.methodCalls.map(([name]) => name)).toEqual(["Email/query", "Email/get"]);
  });

  it("feeds Email/get from the query through a back-reference, with explicit properties", async () => {
    const { context, requests } = fakeTransport(answers());

    await mailSearch.run({ from: "stalw.art" }, context);
    const getArguments = requests[0]?.methodCalls[1]?.[1];

    expect(getArguments?.["#ids"]).toEqual({
      resultOf: "0",
      name: "Email/query",
      path: "/ids",
    });
    expect(getArguments?.properties).toContain("receivedAt");
    expect(getArguments?.properties).not.toContain("bodyStructure");
  });

  it("always sends a limit, a total request, and the newest-first sort", async () => {
    const { context, requests } = fakeTransport(answers());

    await mailSearch.run({ from: "stalw.art" }, context);
    const args = requests[0]?.methodCalls[0]?.[1] as EmailQueryArguments;

    expect(args.limit).toBe(25);
    expect(args.calculateTotal).toBe(true);
    expect(args.sort).toEqual([{ property: "receivedAt", isAscending: false }]);
  });

  it("turns deliveredTo into a Delivered-To header condition, never into `to`", async () => {
    const { context, requests } = fakeTransport(answers());

    await mailSearch.run({ deliveredTo: "shop@example.com" }, context);
    const args = requests[0]?.methodCalls[0]?.[1] as EmailQueryArguments;

    expect(args.filter).toEqual({ header: ["Delivered-To", "shop@example.com"] });
    expect(args.filter?.to).toBeUndefined();
  });

  it("renders date, sender and subject, and says how many of the total are shown", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await mailSearch.run({ text: "invoice", limit: 100 }, context);

    expect(text).toContain("137 message(s) match");
    expect(text).toContain("2026-08-28 00:15");
    expect(text).toContain("Stalwart Labs");
    expect(text).toContain("em-001");
  });

  it("hands back a cursor when the budget cuts the page short", async () => {
    const { context } = fakeTransport(answers());

    const result = await mailSearch.run({ text: "invoice", limit: 100 }, context);

    expect(result.nextCursor).toBeDefined();
    const cursor = decodeCursor(result.nextCursor ?? "");
    expect(cursor?.queryState).toBe("query-state-1");
    expect(cursor?.criteriaFingerprint).toBe(INVOICE_CRITERIA);
    expect(cursor?.position).toBeGreaterThan(0);
    expect(cursor?.position).toBeLessThan(40);
  });

  it("resumes at the position the cursor carries", async () => {
    const { context, requests } = fakeTransport(answers());
    const cursor = encodeCursor({
      position: 25,
      queryState: "query-state-1",
      criteriaFingerprint: INVOICE_CRITERIA,
    });

    await mailSearch.run({ text: "invoice", cursor }, context);
    const args = requests[0]?.methodCalls[0]?.[1] as EmailQueryArguments;

    expect(args.position).toBe(25);
  });

  it("refuses to page on when the query state moved, rather than serving a false page", async () => {
    const { context } = fakeTransport(answers({ queryState: "query-state-2" }));
    const cursor = encodeCursor({
      position: 25,
      queryState: "query-state-1",
      criteriaFingerprint: INVOICE_CRITERIA,
    });

    const result = await mailSearch.run({ text: "invoice", cursor }, context);

    expect(result.text).toMatch(/^Refused:/);
    expect(result.text).not.toContain("em-001");
    expect(result.nextCursor).toBeUndefined();
  });

  it("refuses a cursor replayed under other criteria, before touching the network", async () => {
    const { context, requests } = fakeTransport(answers());
    const cursor = encodeCursor({
      position: 25,
      queryState: "query-state-1",
      criteriaFingerprint: INVOICE_CRITERIA,
    });

    const result = await mailSearch.run({ text: "payslip", cursor }, context);

    expect(result.text).toMatch(/^Refused:/);
    expect(result.text).toContain("other criteria");
    expect(result.nextCursor).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("refuses a cursor sent alone, rather than paging through the whole mailbox", async () => {
    const { context, requests } = fakeTransport(answers());
    const cursor = encodeCursor({
      position: 25,
      queryState: "query-state-1",
      criteriaFingerprint: INVOICE_CRITERIA,
    });

    const result = await mailSearch.run({ cursor }, context);

    expect(result.text).toMatch(/^Refused:/);
    expect(result.nextCursor).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("refuses a cursor from the older shape as unreadable, not as a fresh search", async () => {
    const { context, requests } = fakeTransport(answers());
    const older = Buffer.from(
      JSON.stringify({ position: 25, queryState: "query-state-1" }),
    ).toString("base64url");

    const result = await mailSearch.run({ text: "invoice", cursor: older }, context);

    expect(result.text).toContain("unreadable");
    expect(result.nextCursor).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("stops offering a cursor once the server returns a short page", async () => {
    const short = { ...query, ids: query.ids.slice(0, 3), total: 3 };
    const { context } = fakeTransport([short, envelopes]);

    const result = await mailSearch.run({ text: "invoice" }, context);

    expect(result.nextCursor).toBeUndefined();
    expect(result.text).toContain("3 message(s) match, 3 shown");
  });

  it("stops on a full page that lands exactly on the total, rather than paging into nothing", async () => {
    const full = { ...query, ids: query.ids.slice(0, 3), total: 3 };
    const { context } = fakeTransport([full, envelopes]);

    const result = await mailSearch.run({ text: "invoice", limit: 3 }, context);

    expect(result.nextCursor).toBeUndefined();
    expect(result.text).toContain("3 message(s) match, 3 shown");
  });
});
