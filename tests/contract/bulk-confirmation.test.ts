import { isInputRequiredResult, type McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { MAX_IDS_PER_CALL } from "../../src/domains/mail/filing.js";
import { mailOrganizingDomain } from "../../src/domains/mail/index.js";
import type { GetResponse, JmapRequest, SetResponse } from "../../src/jmap/types/core.js";
import type { Email, Mailbox } from "../../src/jmap/types/mail.js";
import { compose } from "../../src/registry/compose.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

/**
 * The invariant this file exists for: a bulk move is put to the user before it
 * runs, and a bulk marking never is.
 *
 * Both are reversible and both are classed `draft`, so the policy alone would
 * run either without a word. What separates them is the cost of being wrong:
 * an unwanted move scatters messages across folders and leaves the person to
 * find them again, while an unwanted `$seen` is undone by unmarking. Volume is
 * only worth a question when undoing it is work.
 */

const THRESHOLD = 3;

const mailboxGet = loadFixture<GetResponse<Mailbox>>("mailbox-get.json");

const moved: SetResponse<Email> = {
  accountId: "acc-1",
  oldState: "email-state-1",
  newState: "email-state-2",
  updated: {},
};

type Handler = (
  args: unknown,
  ctx: { mcpReq: { inputResponses?: Record<string, unknown>; envelope?: Record<string, unknown> } },
) => Promise<unknown>;

const CONFIRMED = {
  mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: true } } } },
};

function organizingSurface(responses: unknown[]) {
  const { context, requests } = fakeTransport(responses, { bulkConfirmAbove: THRESHOLD });
  const handlers = new Map<string, Handler>();

  compose({
    server: {
      registerTool(name: string, _config: unknown, cb: Handler) {
        handlers.set(name, cb);
      },
      server: { getClientCapabilities: () => ({ elicitation: {} }) },
    } as unknown as McpServer,
    domains: [mailOrganizingDomain],
    session: context.session,
    client: context.client,
    policy: DEFAULT_POLICY,
    bulkConfirmAbove: THRESHOLD,
  });

  return { handlers, requests };
}

function methodsOf(requests: JmapRequest[]): string[] {
  return requests.flatMap((request) => request.methodCalls.map(([name]) => name));
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? "").join("");
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `m-${index}`);
}

describe("a move past the threshold", () => {
  it("is put to the user, and writes nothing until the answer comes", async () => {
    const { handlers, requests } = organizingSurface([mailboxGet, moved]);

    const result = await handlers.get("mail_organize")?.(
      { action: "move", ids: ids(THRESHOLD + 1), mailboxId: "mb-archive" },
      { mcpReq: {} },
    );

    expect(isInputRequiredResult(result)).toBe(true);
    expect(JSON.stringify(result)).toContain("Archive");
    expect(methodsOf(requests)).not.toContain("Email/set");
  });

  it("runs once the answer comes back", async () => {
    const { handlers, requests } = organizingSurface([mailboxGet, moved]);

    await handlers.get("mail_organize")?.(
      { action: "move", ids: ids(THRESHOLD + 1), mailboxId: "mb-archive" },
      CONFIRMED,
    );

    expect(methodsOf(requests)).toContain("Email/set");
  });
});

describe("a move at or under the threshold", () => {
  it("runs without a question", async () => {
    const { handlers, requests } = organizingSurface([mailboxGet, moved]);

    const result = await handlers.get("mail_organize")?.(
      { action: "move", ids: ids(THRESHOLD), mailboxId: "mb-archive" },
      { mcpReq: {} },
    );

    expect(isInputRequiredResult(result)).toBe(false);
    expect(methodsOf(requests)).toContain("Email/set");
  });
});

describe("a marking, whatever its size", () => {
  it("runs without a question at the batch ceiling itself", async () => {
    const { handlers, requests } = organizingSurface([moved]);

    const result = await handlers.get("mail_organize")?.(
      { action: "flag", ids: ids(MAX_IDS_PER_CALL), add: ["seen"] },
      { mcpReq: {} },
    );

    expect(isInputRequiredResult(result)).toBe(false);
    expect(methodsOf(requests)).toEqual(["Email/set"]);
  });
});

describe("the batch ceiling", () => {
  it("refuses past it without asking anything, and without writing", async () => {
    const { handlers, requests } = organizingSurface([mailboxGet, moved]);

    const result = await handlers.get("mail_organize")?.(
      { action: "move", ids: ids(MAX_IDS_PER_CALL + 1), mailboxId: "mb-archive" },
      CONFIRMED,
    );

    expect(isInputRequiredResult(result)).toBe(false);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain(`batches of ${MAX_IDS_PER_CALL}`);
    expect(methodsOf(requests)).toEqual([]);
  });
});
