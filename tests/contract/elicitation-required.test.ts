import {
  CLIENT_CAPABILITIES_META_KEY,
  isInputRequiredResult,
  type McpServer,
} from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import { compose } from "../../src/registry/compose.js";
import { defineTool, type ToolDefinition } from "../../src/registry/define-tool.js";
import { defineDomain } from "../../src/registry/manifest.js";

/**
 * The invariant this file exists for: when the client cannot be asked to
 * confirm, a `confirm` call emits no JMAP request at all. The counter is the
 * proof — a refusal that still ran the tool is not a refusal.
 */

type Handler = (
  args: unknown,
  ctx: { mcpReq: { inputResponses?: Record<string, unknown>; envelope?: Record<string, unknown> } },
) => Promise<unknown>;

/** `capabilities: null` stands for a server that cannot answer the question. */
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

function sendingTool(run: () => Promise<{ text: string }>): ToolDefinition {
  return defineTool({
    name: "mail_send",
    title: "Send mail",
    description: "Sends a draft.",
    inputSchema: z.object({ emailId: z.string() }),
    classes: ["send"],
    classify: () => "send",
    summarize: (input) => `Send message ${input.emailId}.`,
    run,
  }) as unknown as ToolDefinition;
}

/**
 * A reversible bulk write. Its class is allowed, so the only thing that can
 * make it ask is its own `confirmWhen` — and the same incapacity must close
 * that second path as closes the first.
 */
function bulkTool(run: () => Promise<{ text: string }>): ToolDefinition {
  return defineTool({
    name: "mail_move",
    title: "Move messages",
    description: "Moves messages to a folder.",
    inputSchema: z.object({ ids: z.array(z.string()) }),
    classes: ["draft"],
    classify: () => "draft",
    summarize: (input) => `Move ${input.ids.length} messages.`,
    confirmWhen: (input, context) =>
      input.ids.length > context.bulkConfirmAbove
        ? `This moves ${input.ids.length} messages at once.`
        : undefined,
    run,
  }) as unknown as ToolDefinition;
}

function composeWith(capabilities: Record<string, unknown> | null, tool: ToolDefinition) {
  const { server, handlers } = fakeServer(capabilities);
  compose({
    server,
    domains: [defineDomain({ name: "mail", requires: [], tools: [tool] })],
    session: { has: () => true } as unknown as JmapSession,
    client: {} as JmapClient,
    policy: DEFAULT_POLICY,
    bulkConfirmAbove: 2,
  });
  return handlers;
}

describe("elicitation required", () => {
  it("emits no JMAP call when the client declares no elicitation capability", async () => {
    const run = vi.fn(async () => ({ text: "sent" }));
    const handlers = composeWith({ roots: {} }, sendingTool(run));

    const result = await handlers.get("mail_send")?.({ emailId: "m1" }, { mcpReq: {} });

    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
    expect(isInputRequiredResult(result)).toBe(false);
  });

  it("emits no JMAP call when the capability is undecidable", async () => {
    const run = vi.fn(async () => ({ text: "sent" }));
    const handlers = composeWith(null, sendingTool(run));

    const result = await handlers.get("mail_send")?.({ emailId: "m1" }, { mcpReq: {} });

    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
  });

  it("names the operation class and the cause in the refusal", async () => {
    const handlers = composeWith(
      null,
      sendingTool(async () => ({ text: "sent" })),
    );

    const result = (await handlers.get("mail_send")?.({ emailId: "m1" }, { mcpReq: {} })) as {
      content: { text: string }[];
    };

    const message = result.content[0]?.text ?? "";
    expect(message).toContain("send operation");
    expect(message).toContain("elicitation");
  });

  it("reads the per-request envelope before the deprecated accessor", async () => {
    const run = vi.fn(async () => ({ text: "sent" }));
    // The accessor would refuse; the envelope is the recommended source and wins.
    const handlers = composeWith({ roots: {} }, sendingTool(run));

    const result = await handlers.get("mail_send")?.(
      { emailId: "m1" },
      { mcpReq: { envelope: { [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} } } } },
    );

    expect(run).not.toHaveBeenCalled();
    expect(isInputRequiredResult(result)).toBe(true);
  });

  it("treats a cancelled confirmation as a refusal to confirm, not as an incapacity", async () => {
    const run = vi.fn(async () => ({ text: "sent" }));
    const handlers = composeWith({ elicitation: {} }, sendingTool(run));

    const result = await handlers.get("mail_send")?.(
      { emailId: "m1" },
      { mcpReq: { inputResponses: { confirm: { action: "cancel" } } } },
    );

    expect(run).not.toHaveBeenCalled();
    // Asking again is the right answer to a cancel: the client can still confirm.
    expect(isInputRequiredResult(result)).toBe(true);
  });

  it("emits no JMAP call when a call escalated by its volume cannot be confirmed", async () => {
    const run = vi.fn(async () => ({ text: "moved" }));
    const handlers = composeWith({ roots: {} }, bulkTool(run));

    const result = (await handlers.get("mail_move")?.(
      { ids: ["m1", "m2", "m3"] },
      { mcpReq: {} },
    )) as { content: { text: string }[] };

    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
    expect(isInputRequiredResult(result)).toBe(false);
    expect(result.content[0]?.text).toContain("elicitation");
  });

  it("runs a call the escalation left alone, even on a client that cannot be asked", async () => {
    const run = vi.fn(async () => ({ text: "moved" }));
    const handlers = composeWith({ roots: {} }, bulkTool(run));

    await handlers.get("mail_move")?.({ ids: ["m1"] }, { mcpReq: {} });

    expect(run).toHaveBeenCalledOnce();
  });

  it("consults no client capability on an allowed class", async () => {
    const run = vi.fn(async () => ({ text: "listed" }));
    const readingTool = defineTool({
      name: "mail_folders",
      title: "List folders",
      description: "Lists folders.",
      inputSchema: z.object({}),
      classes: ["read"],
      classify: () => "read",
      summarize: () => "List folders.",
      run,
    }) as unknown as ToolDefinition;

    // No `server` member at all: touching it would throw rather than refuse.
    const handlers = composeWith(null, readingTool);
    await handlers.get("mail_folders")?.({}, { mcpReq: {} });

    expect(run).toHaveBeenCalledOnce();
  });
});
