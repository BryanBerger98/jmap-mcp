import { readdirSync, readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { mailSendingDomain } from "../../src/domains/mail/index.js";
import type { GetResponse, JmapRequest, SetResponse } from "../../src/jmap/types/core.js";
import type { Email, EmailSubmission, Identity, Mailbox } from "../../src/jmap/types/mail.js";
import { compose } from "../../src/registry/compose.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

/**
 * The invariant this file exists for: an HTML body reaches the server exactly as
 * it was given. Nothing in the slice sanitises, escapes or reflows it, which is
 * a decision — and a decision no argument name announces. A rewriting slipped in
 * later would be invisible to every other test: the call still succeeds, the
 * message still leaves, and only the recipient sees the difference.
 *
 * The second half of the file guards what would silently void the body instead
 * of rewriting it. `bodyStructure` and `attachments` send the whole creation
 * down another branch of the server — `email/set.rs:128-129` — where neither
 * body property is read at all, so a message would leave with nothing in it.
 *
 * All four writing paths are walked, because the argument that turns
 * `mail_compose` into a send and the one that turns it into a reply compose
 * their payload through the same function but reach it differently.
 */

const identityGet = loadFixture<GetResponse<Identity>>("identity-get.json");
const mailboxGet = loadFixture<GetResponse<Mailbox>>("mailbox-get.json");
const replySource = loadFixture<GetResponse<Email>>("email-reply-source.json");
const emailSetCreated = loadFixture<SetResponse<Email>>("email-set-created.json");
const submissionSet = loadFixture<SetResponse<EmailSubmission>>("email-submission-set.json");

const soleIdentity: GetResponse<Identity> = {
  ...identityGet,
  list: identityGet.list.slice(0, 1),
};

const moved: SetResponse<Email> = {
  accountId: "acc-1",
  oldState: "email-state-2",
  newState: "email-state-3",
  updated: { "em-draft-1": null },
};

/**
 * A body holding everything a rewriting would touch: a style block, an inline
 * attribute, a raw ampersand beside an encoded one, a comment, an unclosed tag
 * and a non-ASCII character. Every one of them must come back untouched.
 */
const HTML_BODY = [
  "<!-- draft 3 -->",
  '<style>.cta { color: #b91c1c }</style>',
  '<p style="margin:0">Bonjour <strong>Camille</strong>,</p>',
  "<p>Le devis est prêt &mdash; voir",
  ' <a href="https://example.org/d?ref=a&amp;lot=2" class="cta">le document</a>.',
  "<br>À très vite,<br>Bryan",
].join("\n");

type Handler = (
  args: unknown,
  ctx: { mcpReq: { inputResponses?: Record<string, unknown> } },
) => Promise<unknown>;

/** A confirmation already granted, so a sending call reaches the transport. */
const CONFIRMED = {
  mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: true } } } },
};

const NOT_ASKED = { mcpReq: {} };

/** The sending surface, registered exactly as the server registers it. */
function sendingSurface(responses: unknown[]) {
  const { context, requests } = fakeTransport(responses);
  const handlers = new Map<string, Handler>();

  compose({
    server: {
      registerTool(name: string, _config: unknown, cb: Handler) {
        handlers.set(name, cb);
      },
      server: { getClientCapabilities: () => ({ elicitation: {} }) },
    } as unknown as McpServer,
    domains: [mailSendingDomain],
    session: context.session,
    client: context.client,
    policy: DEFAULT_POLICY,
  });

  return { handlers, requests };
}

/** Every creation payload of every `Email/set` the surface emitted. */
function creationsSent(requests: JmapRequest[]): Record<string, unknown>[] {
  return requests
    .flatMap((request) => request.methodCalls)
    .filter(([name]) => name === "Email/set")
    .flatMap(([, args]) => {
      const create = (args.create ?? {}) as Record<string, Record<string, unknown>>;
      return Object.values(create);
    });
}

/** The four ways `mail_compose` writes a message, each carrying an HTML body. */
const WRITING_PATHS = [
  {
    name: "a draft",
    args: { to: ["camille@example.org"], subject: "Devis", htmlBody: HTML_BODY },
    ctx: NOT_ASKED,
    responses: [soleIdentity, mailboxGet, emailSetCreated],
  },
  {
    name: "a message sent in one go",
    args: { to: ["camille@example.org"], subject: "Devis", htmlBody: HTML_BODY, send: true },
    ctx: CONFIRMED,
    responses: [soleIdentity, mailboxGet, emailSetCreated, submissionSet, moved],
  },
  {
    name: "a reply left in drafts",
    args: { replyToEmailId: "em-origin-1", htmlBody: HTML_BODY },
    ctx: NOT_ASKED,
    responses: [soleIdentity, mailboxGet, replySource, emailSetCreated],
  },
  {
    name: "a reply sent in one go",
    args: { replyToEmailId: "em-origin-1", htmlBody: HTML_BODY, send: true },
    ctx: CONFIRMED,
    responses: [soleIdentity, mailboxGet, replySource, emailSetCreated, submissionSet, moved],
  },
] as const;

describe("an HTML body reaches the server untouched", () => {
  for (const path of WRITING_PATHS) {
    it(`reproduces the body character for character when writing ${path.name}`, async () => {
      const { handlers, requests } = sendingSurface([...path.responses]);

      await handlers.get("mail_compose")?.(path.args, path.ctx);
      const creations = creationsSent(requests);

      expect(creations).toHaveLength(1);
      const values = creations[0]?.bodyValues as Record<string, { value: string }>;
      const part = (creations[0]?.htmlBody as { partId: string }[])[0];

      expect(part).toBeDefined();
      expect(values[part?.partId ?? ""]?.value).toBe(HTML_BODY);
    });

    it(`derives no text body from the HTML when writing ${path.name}`, async () => {
      const { handlers, requests } = sendingSurface([...path.responses]);

      await handlers.get("mail_compose")?.(path.args, path.ctx);

      for (const creation of creationsSent(requests)) {
        expect(creation).not.toHaveProperty("textBody");
      }
    });

    it(`names one part of an exact type when writing ${path.name}`, async () => {
      const { handlers, requests } = sendingSurface([...path.responses]);

      await handlers.get("mail_compose")?.(path.args, path.ctx);

      for (const creation of creationsSent(requests)) {
        for (const property of ["textBody", "htmlBody"] as const) {
          const parts = creation[property] as { partId: string; type: string }[] | undefined;
          if (parts === undefined) continue;

          // One part at most, or the server refuses — `email/set.rs:263-285`.
          expect(parts).toHaveLength(1);
          expect(parts[0]?.type).toBe(property === "textBody" ? "text/plain" : "text/html");
        }
      }
    });

    it(`carries nothing that would void the body when writing ${path.name}`, async () => {
      const { handlers, requests } = sendingSurface([...path.responses]);

      await handlers.get("mail_compose")?.(path.args, path.ctx);

      for (const creation of creationsSent(requests)) {
        expect(creation).not.toHaveProperty("bodyStructure");
        expect(creation).not.toHaveProperty("attachments");
        expect(creation).not.toHaveProperty("headers");
        expect(Object.keys(creation).some((key) => key.startsWith("header:"))).toBe(false);
      }
    });
  }

  it("keeps both bodies apart, each under its own part id", async () => {
    const { handlers, requests } = sendingSurface([soleIdentity, mailboxGet, emailSetCreated]);

    await handlers.get("mail_compose")?.(
      { to: ["camille@example.org"], body: "Bonjour Camille,", htmlBody: HTML_BODY },
      NOT_ASKED,
    );
    const creation = creationsSent(requests)[0] ?? {};
    const text = (creation.textBody as { partId: string }[])[0];
    const html = (creation.htmlBody as { partId: string }[])[0];

    expect(text?.partId).not.toBe(html?.partId);
    const values = creation.bodyValues as Record<string, { value: string }>;
    expect(values[text?.partId ?? ""]?.value).toBe("Bonjour Camille,");
    expect(values[html?.partId ?? ""]?.value).toBe(HTML_BODY);
  });
});

/**
 * The contract above walks the calls; this one walks the sources.
 *
 * A second place declaring a body part would compose a payload the four paths
 * never reach, and every assertion above would keep passing while a rewritten
 * body left the account through it.
 */
describe("one place declares a body part", () => {
  const DOMAIN = new URL("../../src/domains/mail/", import.meta.url);

  function sourcesDeclaringAPart(): string[] {
    return readdirSync(DOMAIN)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => {
        const source = readFileSync(new URL(name, DOMAIN), "utf8");
        return source.includes('type: "text/plain"') || source.includes('type: "text/html"');
      });
  }

  it("declares a body part in compose.ts and nowhere else in the mail domain", () => {
    expect(sourcesDeclaringAPart()).toEqual(["compose.ts"]);
  });
});
