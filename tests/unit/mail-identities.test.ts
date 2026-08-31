import { describe, expect, it } from "vitest";
import { mailIdentities } from "../../src/domains/mail/identities.js";
import type { GetResponse } from "../../src/jmap/types/core.js";
import type { Identity } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const identityGet = loadFixture<GetResponse<Identity>>("identity-get.json");

function rowsOf(text: string): string[] {
  // Drop the header and its underline; what is left is one identity per line.
  return text.split("\n").slice(2);
}

describe("mail_identities", () => {
  it("asks for every identity under the submission capability", async () => {
    const { context, requests } = fakeTransport([identityGet]);

    await mailIdentities.run({}, context);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.using).toContain("urn:ietf:params:jmap:submission");
    expect(requests[0]?.methodCalls[0]).toMatchObject([
      "Identity/get",
      { accountId: "acc-1", ids: null },
      "0",
    ]);
  });

  it("names the properties it renders instead of pulling the signatures", async () => {
    const { context, requests } = fakeTransport([identityGet]);

    await mailIdentities.run({}, context);

    const properties = requests[0]?.methodCalls[0]?.[1].properties as string[];
    expect(properties).toEqual(["id", "name", "email"]);
    expect(properties).not.toContain("htmlSignature");
  });

  it("renders one row per identity, address and id included", async () => {
    const { context } = fakeTransport([identityGet]);

    const { text } = await mailIdentities.run({}, context);

    expect(rowsOf(text)).toHaveLength(2);
    expect(text).toContain("bryan@example.com");
    expect(text).toContain("billing@example.com");
    expect(text).toContain("id-2");
  });

  it("tells the identity matching the session login apart from the others", async () => {
    const { context } = fakeTransport([identityGet]);

    const { text } = await mailIdentities.run({}, context);
    const rows = rowsOf(text);

    // The fixture session is opened as bryan@example.com.
    expect(rows.find((row) => row.startsWith("bryan@"))).toMatch(/\byes\b/);
    expect(rows.find((row) => row.startsWith("billing@"))).not.toMatch(/\byes\b/);
  });

  it("says an account has no identity rather than rendering an empty table", async () => {
    const empty: GetResponse<Identity> = { ...identityGet, list: [] };
    const { context } = fakeTransport([empty]);

    const { text } = await mailIdentities.run({}, context);

    expect(text).toContain("no sending identity");
    expect(text).not.toContain("(no results)");
  });

  it("classifies any call as a read", () => {
    expect(mailIdentities.classes).toEqual(["read"]);
    expect(mailIdentities.classify({})).toBe("read");
  });
});
