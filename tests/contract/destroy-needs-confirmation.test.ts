import { isInputRequiredResult, type McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { mailOrganizingDomain } from "../../src/domains/mail/index.js";
import type { GetResponse, JmapRequest, SetResponse } from "../../src/jmap/types/core.js";
import type { Email, Mailbox } from "../../src/jmap/types/mail.js";
import { compose } from "../../src/registry/compose.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

/**
 * The invariant this file exists for: nothing is erased from the mail server
 * without the user having said so, on this call, in words.
 *
 * This is the project's first real destruction, so the contract is written on
 * the tool itself rather than on a stand-in: what has to hold is that
 * `mail_delete` with `permanent` cannot reach `Email/set` by any path except a
 * granted confirmation. A client that cannot be asked gets a refusal, never a
 * silent run.
 */

const mailboxGet = loadFixture<GetResponse<Mailbox>>("mailbox-get.json");
const subjects = loadFixture<GetResponse<Email>>("email-get-subjects.json");
const destroyed = loadFixture<SetResponse<Email>>("email-set-destroyed.json");

const IDS = ["m-1", "m-2", "m-3"];

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

function organizingSurface(responses: unknown[], capabilities: Record<string, unknown> | null) {
  const { context, requests } = fakeTransport(responses);
  const handlers = new Map<string, Handler>();

  compose({
    server: {
      registerTool(name: string, _config: unknown, cb: Handler) {
        handlers.set(name, cb);
      },
      ...(capabilities === null ? {} : { server: { getClientCapabilities: () => capabilities } }),
    } as unknown as McpServer,
    domains: [mailOrganizingDomain],
    session: context.session,
    client: context.client,
    policy: DEFAULT_POLICY,
  });

  return { handlers, requests };
}

/** Every method a call emitted, whatever the round trip it travelled in. */
function methodsOf(requests: JmapRequest[]): string[] {
  return requests.flatMap((request) => request.methodCalls.map(([name]) => name));
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? "").join("");
}

describe("a permanent deletion", () => {
  it("is put to the user, and destroys nothing while it waits", async () => {
    const { handlers, requests } = organizingSurface([subjects, destroyed], { elicitation: {} });

    const result = await handlers.get("mail_delete")?.(
      { ids: IDS, permanent: true },
      { mcpReq: {} },
    );

    expect(isInputRequiredResult(result)).toBe(true);
    expect(methodsOf(requests)).not.toContain("Email/set");
  });

  it("names the messages it is about to erase, not just how many", async () => {
    const { handlers } = organizingSurface([subjects, destroyed], { elicitation: {} });

    const result = await handlers.get("mail_delete")?.(
      { ids: IDS, permanent: true },
      { mcpReq: {} },
    );

    const asked = JSON.stringify(result);
    expect(asked).toContain("3 messages");
    expect(asked).toContain("Facture de janvier");
  });

  it("leaves the mailbox strictly unchanged when the confirmation comes back false", async () => {
    const { handlers, requests } = organizingSurface([subjects, destroyed], { elicitation: {} });

    await handlers.get("mail_delete")?.({ ids: IDS, permanent: true }, DECLINED);

    expect(methodsOf(requests)).not.toContain("Email/set");
  });

  it("is refused outright on a client that cannot be asked", async () => {
    const { handlers, requests } = organizingSurface([subjects, destroyed], { roots: {} });

    const result = await handlers.get("mail_delete")?.(
      { ids: IDS, permanent: true },
      { mcpReq: {} },
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("elicitation");
    expect(methodsOf(requests)).not.toContain("Email/set");
  });

  it("destroys only once the confirmation is granted, and only by destroy", async () => {
    const { handlers, requests } = organizingSurface([destroyed], { elicitation: {} });

    await handlers.get("mail_delete")?.({ ids: IDS, permanent: true }, CONFIRMED);

    const call = requests.at(-1)?.methodCalls[0];
    expect(call?.[0]).toBe("Email/set");
    expect(call?.[1]).toMatchObject({ destroy: IDS });
    expect(call?.[1].update).toBeUndefined();
  });
});

describe("a deletion to the trash", () => {
  it("runs without a question, because moving back undoes it", async () => {
    const { handlers, requests } = organizingSurface([mailboxGet, destroyed], { elicitation: {} });

    const result = await handlers.get("mail_delete")?.({ ids: IDS }, { mcpReq: {} });

    expect(isInputRequiredResult(result)).toBe(false);
    expect(methodsOf(requests)).toContain("Email/set");
  });

  it("never carries a destroy, whatever it was asked", async () => {
    const { handlers, requests } = organizingSurface([mailboxGet, destroyed], { elicitation: {} });

    await handlers.get("mail_delete")?.({ ids: IDS, permanent: false }, CONFIRMED);

    for (const request of requests) {
      for (const [, args] of request.methodCalls) {
        expect(args.destroy).toBeUndefined();
      }
    }
  });
});
