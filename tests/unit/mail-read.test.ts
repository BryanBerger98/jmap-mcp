import { describe, expect, it } from "vitest";
import { mailDomain } from "../../src/domains/mail/index.js";
import { MAX_BODY_VALUE_BYTES, mailRead } from "../../src/domains/mail/read.js";
import type { GetResponse } from "../../src/jmap/types/core.js";
import type { Email, EmailGetArguments } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const withText = loadFixture<GetResponse<Email>>("email-get-body.json");
const withoutText = loadFixture<GetResponse<Email>>("email-get-html.json");

/** Keeps only the message block carrying that id. */
function blockOf(text: string, id: string): string {
  return text.split(/\n-{10,}\n/).find((block) => block.includes(`id: ${id}`)) ?? "";
}

describe("mail_read arguments", () => {
  it("names the properties and the byte ceiling on the wire", async () => {
    const { context, requests } = fakeTransport([withText]);

    await mailRead.run({ ids: ["em-100"] }, context);
    const args = requests[0]?.methodCalls[0]?.[1] as EmailGetArguments;

    expect(args.properties).toContain("bodyValues");
    expect(args.properties).not.toContain("bodyStructure");
    expect(args.maxBodyValueBytes).toBe(MAX_BODY_VALUE_BYTES);
    expect(args.fetchTextBodyValues).toBe(true);
    expect(args.fetchHTMLBodyValues).toBe(true);
    expect(args.bodyProperties).toEqual(["partId", "blobId", "type", "charset", "size", "name"]);
  });

  it("lowers the ceiling on request but never raises it", async () => {
    const { context, requests } = fakeTransport([withText, withText]);

    await mailRead.run({ ids: ["em-100"], maxBodyBytes: 500 }, context);
    const args = requests[0]?.methodCalls[0]?.[1] as EmailGetArguments | undefined;

    expect(args?.maxBodyValueBytes).toBe(500);
    expect(mailRead.inputSchema.safeParse({ ids: ["a"], maxBodyBytes: 99999 }).success).toBe(false);
  });

  it("refuses more than five ids at the schema, before any request", async () => {
    const { context, requests } = fakeTransport([withText]);
    const parsed = mailRead.inputSchema.safeParse({
      ids: ["a", "b", "c", "d", "e", "f"],
    });

    expect(parsed.success).toBe(false);
    expect(mailRead.inputSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(mailRead.inputSchema.safeParse({ ids: ["a"] }).success).toBe(true);
    // The refusal happened at validation: `run` was never reached.
    expect(requests).toHaveLength(0);
    expect(context.session.accountId).toBe("acc-1");
  });

  it("takes no filter: reading consumes ids that were seen", () => {
    const parsed = mailRead.inputSchema.safeParse({ ids: ["a"], from: "boss@example.com" });

    expect(parsed.success && "from" in parsed.data).toBe(false);
  });
});

describe("mail_read rendering", () => {
  it("renders headers then the plain-text body", async () => {
    const { context } = fakeTransport([withText]);

    const { text } = await mailRead.run({ ids: ["em-100"] }, context);
    const block = blockOf(text, "em-100");

    expect(block).toContain("from: Julie Marchand <julie.marchand@example.org>");
    expect(block).toContain("cc: equipe@example.org");
    expect(block).toContain("subject: Retour sur le second entretien");
    expect(block).toContain("Merci pour votre disponibilité hier.");
  });

  it("announces the cut when the server truncated the body", async () => {
    const { context } = fakeTransport([withText]);

    const { text } = await mailRead.run({ ids: ["em-100", "em-101"] }, context);

    expect(blockOf(text, "em-101")).toContain(`body cut at ${MAX_BODY_VALUE_BYTES} bytes`);
    expect(blockOf(text, "em-100")).not.toContain("body cut at");
  });

  it("calls the ceiling fixed when the cut happened at the maximum", async () => {
    const { context } = fakeTransport([withText]);

    const { text } = await mailRead.run({ ids: ["em-101"] }, context);
    const block = blockOf(text, "em-101");

    expect(block).toContain("that ceiling is fixed");
    expect(block).not.toContain("raising maxBodyBytes");
  });

  it("invites raising maxBodyBytes only when the cut happened below the maximum", async () => {
    const { context } = fakeTransport([withText]);

    const { text } = await mailRead.run({ ids: ["em-101"], maxBodyBytes: 500 }, context);
    const block = blockOf(text, "em-101");

    expect(block).toContain("body cut at 500 bytes");
    expect(block).toContain(`raising maxBodyBytes, up to ${MAX_BODY_VALUE_BYTES}`);
  });

  it("separates messages by a visible rule, each under its id", async () => {
    const { context } = fakeTransport([withText]);

    const { text } = await mailRead.run({ ids: ["em-100", "em-101"] }, context);

    expect(text).toMatch(/\n-{10,}\n/);
    expect(text.indexOf("id: em-100")).toBeLessThan(text.indexOf("id: em-101"));
  });

  it("degrades an HTML-only message to readable text, never to markup", async () => {
    const { context } = fakeTransport([withoutText]);

    const { text } = await mailRead.run({ ids: ["em-200"] }, context);
    const block = blockOf(text, "em-200");

    expect(block).toContain("Release v0.16.19");
    expect(block).toContain("JMAP & JMAP over WebSocket");
    expect(block).toContain("- Mailbox/query ordering");
    expect(block).not.toContain("<p>");
    expect(block).not.toContain("color:#333");
    expect(block).toContain("rendered from HTML");
  });

  it("falls back to the preview when no body part came back", async () => {
    const { context } = fakeTransport([withoutText]);

    const { text } = await mailRead.run({ ids: ["em-201"] }, context);
    const block = blockOf(text, "em-201");

    expect(block).toContain("Your invoice for August 2026 is available in your account.");
    expect(block).toContain("this is the server preview");
  });

  it("says which ids the server did not find", async () => {
    const { context } = fakeTransport([withoutText]);

    const { text } = await mailRead.run({ ids: ["em-200", "em-999"] }, context);

    expect(text).toContain("Not found: em-999");
  });
});

describe("mail domain surface", () => {
  it("exposes exactly the three read tools", () => {
    expect(mailDomain.tools.map((tool) => tool.name).sort()).toEqual([
      "mail_folders",
      "mail_read",
      "mail_search",
    ]);
  });
});
