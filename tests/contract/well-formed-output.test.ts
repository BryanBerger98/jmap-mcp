import {
  isInputRequiredResult,
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import { compose } from "../../src/registry/compose.js";
import { defineTool, type ToolDefinition } from "../../src/registry/define-tool.js";
import { defineDomain } from "../../src/registry/manifest.js";

/**
 * The invariant this file exists for: no text the registry hands the client
 * ever carries a lone UTF-16 surrogate, whatever a tool or the JMAP server
 * behind it wrote into the string that got there — see `wellFormed` in
 * `registry/compose.ts` for why that matters to a strict JSON-RPC client.
 *
 * Three shapes of text cross the registry — a run result, a refusal, an
 * elicitation message — and a fourth, a thrown error's message, escapes the
 * first three's own handling if nothing catches it. A stub tool exercises
 * all four without depending on the source of the cut being fixed: this
 * guard has to hold even if it never happens again.
 *
 * A fifth case sits beside these four: a thrown `ProtocolError` carrying
 * `UrlElicitationRequired` must escape this guard untouched rather than be
 * converted, since the SDK's own `tools/call` handler rethrows it
 * deliberately to serve a legacy elicitation flow.
 */

/** Lone high surrogate at the end, the shape a truncation mid-emoji leaves. */
const SURROGATE = "cut \ud83d";

type Handler = (
  args: unknown,
  ctx: { mcpReq: { inputResponses?: Record<string, unknown>; envelope?: Record<string, unknown> } },
) => Promise<unknown>;

/** Declares elicitation, so a `confirm`-level stub reaches its own message build. */
function fakeServer(): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, cb: Handler) {
      handlers.set(name, cb);
    },
    server: { getClientCapabilities: () => ({ elicitation: {} }) },
  };
  return { server: server as unknown as McpServer, handlers };
}

const fakeSession = { has: () => true } as unknown as JmapSession;
const fakeClient = {} as JmapClient;

function composeWith(tool: ToolDefinition) {
  const { server, handlers } = fakeServer();
  compose({
    server,
    domains: [defineDomain({ name: "stub", requires: [], tools: [tool] })],
    session: fakeSession,
    client: fakeClient,
    policy: DEFAULT_POLICY,
  });
  return handlers;
}

/** Every string value reachable from a JSON-shaped result, run's text and errors alike. */
function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  }
  return [];
}

const runTool: ToolDefinition = defineTool({
  name: "stub_run",
  title: "Stub run",
  description: "Succeeds with a result text ending on a lone surrogate.",
  inputSchema: z.object({}),
  classes: ["read"],
  classify: () => "read",
  summarize: () => "Stub run.",
  run: async () => ({ text: SURROGATE }),
}) as unknown as ToolDefinition;

const precheckTool: ToolDefinition = defineTool({
  name: "stub_precheck",
  title: "Stub precheck",
  description: "Refuses before running, on a message ending on a lone surrogate.",
  inputSchema: z.object({}),
  classes: ["read"],
  classify: () => "read",
  summarize: () => "Stub precheck.",
  precheck: async () => `Refused: ${SURROGATE}`,
  run: async () => ({ text: "unreachable" }),
}) as unknown as ToolDefinition;

const confirmTool: ToolDefinition = defineTool({
  name: "stub_confirm",
  title: "Stub confirm",
  description: "Asks for confirmation on a summary ending on a lone surrogate.",
  inputSchema: z.object({}),
  classes: ["destroy"],
  classify: () => "destroy",
  summarize: async () => `Delete subject ${SURROGATE}`,
  run: async () => ({ text: "destroyed" }),
}) as unknown as ToolDefinition;

const throwTool: ToolDefinition = defineTool({
  name: "stub_throw",
  title: "Stub throw",
  description: "Throws before returning, on a message ending on a lone surrogate.",
  inputSchema: z.object({}),
  classes: ["read"],
  classify: () => "read",
  summarize: () => "Stub throw.",
  run: async () => {
    // Stands in for a JmapError wrapping a JMAP problem-details `detail`
    // straight from a server response: the message is server text, not
    // something the registry composed itself.
    throw new Error(`JMAP request failed: ${SURROGATE}`);
  },
}) as unknown as ToolDefinition;

const urlElicitationTool: ToolDefinition = defineTool({
  name: "stub_url_elicitation",
  title: "Stub URL elicitation",
  description: "Throws the protocol error a legacy-era tool signals a URL elicitation with.",
  inputSchema: z.object({}),
  classes: ["read"],
  classify: () => "read",
  summarize: () => "Stub URL elicitation.",
  run: async () => {
    throw new ProtocolError(ProtocolErrorCode.UrlElicitationRequired, "Needs a URL elicitation");
  },
}) as unknown as ToolDefinition;

describe("well-formed output", () => {
  it("the fixture text is not itself well-formed", () => {
    // Guards the guard: if this ever turns true, the four cases below would
    // pass whether or not the registry sanitizes anything.
    expect(SURROGATE.isWellFormed()).toBe(false);
  });

  it("a run result is well-formed even when the tool's text is not", async () => {
    const handlers = composeWith(runTool);

    const result = await handlers.get("stub_run")?.({}, { mcpReq: {} });

    const strings = collectStrings(result);
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.every((text) => text.isWellFormed())).toBe(true);
  });

  it("a precheck refusal is well-formed even when the tool's message is not", async () => {
    const handlers = composeWith(precheckTool);

    const result = await handlers.get("stub_precheck")?.({}, { mcpReq: {} });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const strings = collectStrings(result);
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.every((text) => text.isWellFormed())).toBe(true);
  });

  it("an elicitation message is well-formed even when the tool's summary is not", async () => {
    const handlers = composeWith(confirmTool);

    const result = await handlers.get("stub_confirm")?.({}, { mcpReq: {} });

    expect(isInputRequiredResult(result)).toBe(true);
    const strings = collectStrings(result);
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.every((text) => text.isWellFormed())).toBe(true);
  });

  it("a thrown error's message is well-formed even when it carries server text", async () => {
    const handlers = composeWith(throwTool);

    const result = await handlers.get("stub_throw")?.({}, { mcpReq: {} });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const strings = collectStrings(result);
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.every((text) => text.isWellFormed())).toBe(true);
  });

  it("a thrown UrlElicitationRequired protocol error is not converted into an error result", async () => {
    const handlers = composeWith(urlElicitationTool);

    await expect(handlers.get("stub_url_elicitation")?.({}, { mcpReq: {} })).rejects.toMatchObject({
      code: ProtocolErrorCode.UrlElicitationRequired,
    });
  });
});
