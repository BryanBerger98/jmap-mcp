import type { McpServer } from "@modelcontextprotocol/server";
import { isInputRequiredResult } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_POLICY, type WritePolicy } from "../../src/config/policy.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import { compose } from "../../src/registry/compose.js";
import { defineTool, type ToolDefinition } from "../../src/registry/define-tool.js";
import { defineDomain } from "../../src/registry/manifest.js";

/**
 * The invariant this file exists for: a `send` or `destroy` call never reaches
 * its `run` without clearing the policy guard. A domain cannot opt out, because
 * it never registers itself — the registry does.
 */

type Handler = (
  args: unknown,
  ctx: { mcpReq: { inputResponses?: Record<string, unknown> } },
) => Promise<unknown>;

/** Captures what compose registers, standing in for a real McpServer. */
function fakeServer(): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, cb: Handler) {
      handlers.set(name, cb);
    },
  };
  return { server: server as unknown as McpServer, handlers };
}

const fakeSession = { has: () => true } as unknown as JmapSession;
const fakeClient = {} as JmapClient;

function toolThatRuns(run: () => Promise<{ text: string }>): ToolDefinition {
  return defineTool({
    name: "mail_delete",
    title: "Delete mail",
    description: "Destroys messages permanently.",
    inputSchema: z.object({ ids: z.array(z.string()) }),
    classes: ["destroy"],
    classify: () => "destroy",
    summarize: (input) => `Permanently delete ${input.ids.length} message(s).`,
    run,
  }) as unknown as ToolDefinition;
}

function composeWith(policy: WritePolicy, tool: ToolDefinition) {
  const { server, handlers } = fakeServer();
  const report = compose({
    server,
    domains: [defineDomain({ name: "mail", requires: [], tools: [tool] })],
    session: fakeSession,
    client: fakeClient,
    policy,
  });
  return { handlers, report };
}

describe("policy guard", () => {
  it("does not run a destroy call until the user confirms", async () => {
    const run = vi.fn(async () => ({ text: "deleted" }));
    const { handlers } = composeWith(DEFAULT_POLICY, toolThatRuns(run));

    const result = await handlers.get("mail_delete")?.({ ids: ["m1"] }, { mcpReq: {} });

    expect(run).not.toHaveBeenCalled();
    expect(isInputRequiredResult(result)).toBe(true);
  });

  it("runs the destroy call once the confirmation comes back accepted", async () => {
    const run = vi.fn(async () => ({ text: "deleted" }));
    const { handlers } = composeWith(DEFAULT_POLICY, toolThatRuns(run));

    const result = await handlers.get("mail_delete")?.(
      { ids: ["m1"] },
      { mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: true } } } } },
    );

    expect(run).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ content: [{ type: "text", text: "deleted" }] });
  });

  it("never runs a declined confirmation", async () => {
    const run = vi.fn(async () => ({ text: "deleted" }));
    const { handlers } = composeWith(DEFAULT_POLICY, toolThatRuns(run));

    await handlers.get("mail_delete")?.(
      { ids: ["m1"] },
      { mcpReq: { inputResponses: { confirm: { action: "decline" } } } },
    );

    expect(run).not.toHaveBeenCalled();
  });

  it("drops a tool whose every class is denied instead of registering it", () => {
    const run = vi.fn(async () => ({ text: "deleted" }));
    const { handlers, report } = composeWith(
      { ...DEFAULT_POLICY, destroy: "deny" },
      toolThatRuns(run),
    );

    expect(handlers.size).toBe(0);
    expect(report.denied).toEqual(["mail_delete"]);
  });

  it("skips a domain whose capability the session does not advertise", () => {
    const { server, handlers } = fakeServer();
    const report = compose({
      server,
      domains: [
        defineDomain({
          name: "files",
          requires: ["urn:ietf:params:jmap:filenode"],
          tools: [toolThatRuns(async () => ({ text: "" }))],
        }),
      ],
      session: { has: () => false } as unknown as JmapSession,
      client: fakeClient,
      policy: DEFAULT_POLICY,
    });

    expect(handlers.size).toBe(0);
    expect(report.skipped).toEqual([
      { domain: "files", missing: ["urn:ietf:params:jmap:filenode"] },
    ]);
  });
});
