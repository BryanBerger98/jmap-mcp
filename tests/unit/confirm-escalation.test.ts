import { isInputRequiredResult, type McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import { compose } from "../../src/registry/compose.js";
import { defineTool, type ToolDefinition } from "../../src/registry/define-tool.js";
import { defineDomain } from "../../src/registry/manifest.js";

/**
 * The escalation mechanism on its own, with no real tool behind it: what is
 * being checked is that an allowed class can still be made to ask, and that the
 * question never comes before the refusals that do not depend on the answer.
 */

const THRESHOLD = 3;

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

function fakeServer(capabilities: Record<string, unknown> | null): {
  server: McpServer;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, cb: Handler) {
      handlers.set(name, cb);
    },
    ...(capabilities === null ? {} : { server: { getClientCapabilities: () => capabilities } }),
  };
  return { server: server as unknown as McpServer, handlers };
}

/** A reversible bulk write: allowed by its class, questionable by its volume. */
function bulkTool(options: {
  run: () => Promise<{ text: string }>;
  precheck?: () => string | undefined;
}): ToolDefinition {
  return defineTool({
    name: "mail_move",
    title: "Move messages",
    description: "Moves messages to a folder.",
    inputSchema: z.object({ ids: z.array(z.string()) }),
    classes: ["draft"],
    classify: () => "draft",
    summarize: (input) => `Move ${input.ids.length} messages.`,
    ...(options.precheck === undefined ? {} : { precheck: options.precheck }),
    confirmWhen: (input, context) =>
      input.ids.length > context.bulkConfirmAbove
        ? `This moves ${input.ids.length} messages at once, past the ${context.bulkConfirmAbove} this server moves without asking.`
        : undefined,
    run: options.run,
  }) as unknown as ToolDefinition;
}

function composeWith(
  tool: ToolDefinition,
  capabilities: Record<string, unknown> | null = { elicitation: {} },
) {
  const { server, handlers } = fakeServer(capabilities);
  compose({
    server,
    domains: [defineDomain({ name: "mail", requires: [], tools: [tool] })],
    session: { has: () => true } as unknown as JmapSession,
    client: {} as JmapClient,
    policy: DEFAULT_POLICY,
    bulkConfirmAbove: THRESHOLD,
  });
  return handlers;
}

function ids(count: number): { ids: string[] } {
  return { ids: Array.from({ length: count }, (_, index) => `m${index}`) };
}

describe("confirmation escalation", () => {
  it("runs a call under the threshold without asking anything", async () => {
    const run = vi.fn(async () => ({ text: "moved" }));
    const handlers = composeWith(bulkTool({ run }));

    const result = await handlers.get("mail_move")?.(ids(THRESHOLD), { mcpReq: {} });

    expect(run).toHaveBeenCalledOnce();
    expect(isInputRequiredResult(result)).toBe(false);
  });

  it("asks before running a call past the threshold, and cites the reason", async () => {
    const run = vi.fn(async () => ({ text: "moved" }));
    const handlers = composeWith(bulkTool({ run }));

    const result = await handlers.get("mail_move")?.(ids(THRESHOLD + 1), { mcpReq: {} });

    expect(run).not.toHaveBeenCalled();
    expect(isInputRequiredResult(result)).toBe(true);
    expect(JSON.stringify(result)).toContain("This moves 4 messages at once");
    // The class would say "draft", which tells nobody why they are being asked.
    expect(JSON.stringify(result)).not.toContain("This is a draft operation");
  });

  it("runs the escalated call once it is confirmed", async () => {
    const run = vi.fn(async () => ({ text: "moved" }));
    const handlers = composeWith(bulkTool({ run }));

    await handlers.get("mail_move")?.(ids(THRESHOLD + 1), CONFIRMED);

    expect(run).toHaveBeenCalledOnce();
  });

  it("never runs the escalated call when the confirmation comes back false", async () => {
    const run = vi.fn(async () => ({ text: "moved" }));
    const handlers = composeWith(bulkTool({ run }));

    await handlers.get("mail_move")?.(ids(THRESHOLD + 1), DECLINED);

    expect(run).not.toHaveBeenCalled();
  });

  it("refuses the escalated call outright when the client cannot be asked", async () => {
    const run = vi.fn(async () => ({ text: "moved" }));
    const handlers = composeWith(bulkTool({ run }), { roots: {} });

    const result = (await handlers.get("mail_move")?.(ids(THRESHOLD + 1), { mcpReq: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };

    expect(run).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("elicitation");
  });

  it("lets a precheck refusal win, without ever putting the call to the user", async () => {
    const run = vi.fn(async () => ({ text: "moved" }));
    const precheck = () => "Refused: folder mb-nope is not in this account.";
    const handlers = composeWith(bulkTool({ run, precheck }));

    const result = (await handlers.get("mail_move")?.(ids(THRESHOLD + 1), { mcpReq: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };

    expect(run).not.toHaveBeenCalled();
    expect(isInputRequiredResult(result)).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("mb-nope");
  });

  it("leaves a tool without confirmWhen exactly as it was", async () => {
    const run = vi.fn(async () => ({ text: "listed" }));
    const plain = defineTool({
      name: "mail_folders",
      title: "List folders",
      description: "Lists folders.",
      inputSchema: z.object({}),
      classes: ["read"],
      classify: () => "read",
      summarize: () => "List folders.",
      run,
    }) as unknown as ToolDefinition;

    const handlers = composeWith(plain, null);
    const result = await handlers.get("mail_folders")?.({}, { mcpReq: {} });

    expect(run).toHaveBeenCalledOnce();
    expect(isInputRequiredResult(result)).toBe(false);
  });
});
