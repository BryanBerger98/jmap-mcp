import {
  acceptedContent,
  inputRequired,
  type McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { WritePolicy } from "../config/policy.js";
import type { JmapClient } from "../jmap/client.js";
import type { JmapSession } from "../jmap/session.js";
import type { ToolDefinition } from "./define-tool.js";
import type { DomainManifest } from "./manifest.js";

export interface ComposeInput {
  server: McpServer;
  domains: readonly DomainManifest[];
  session: JmapSession;
  client: JmapClient;
  policy: WritePolicy;
}

export interface ComposeReport {
  registered: string[];
  skipped: { domain: string; missing: string[] }[];
  denied: string[];
}

const confirmationSchema = z.object({ confirm: z.boolean() });

/**
 * Crosses the session's capabilities with the configured policy and registers
 * the surviving tools. Runs once, before `connect()`: the specification forbids
 * a tool list that varies during a session.
 */
export function compose(input: ComposeInput): ComposeReport {
  const report: ComposeReport = { registered: [], skipped: [], denied: [] };

  for (const domain of input.domains) {
    const missing = domain.requires.filter((capability) => !input.session.has(capability));
    if (missing.length > 0) {
      report.skipped.push({ domain: domain.name, missing });
      continue;
    }

    for (const tool of domain.tools) {
      register(input, tool, report);
    }
  }

  return report;
}

function register(input: ComposeInput, tool: ToolDefinition, report: ComposeReport): void {
  // Every class the tool can reach is denied: registering it would only ever fail.
  if (isFullyDenied(input.policy, tool)) {
    report.denied.push(tool.name);
    return;
  }

  input.server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      // The definition owns the schema; the SDK wants it as a Standard Schema.
      inputSchema: tool.inputSchema as unknown as StandardSchemaWithJSON<unknown, unknown>,
    },
    async (args: unknown, ctx: { mcpReq: { inputResponses?: Record<string, unknown> } }) => {
      const operation = tool.classify(args);
      const level = input.policy[operation];

      if (level === "deny") {
        return errorResult(
          `Refused: ${tool.name} is a ${operation} operation and the policy denies that class.`,
        );
      }

      if (level === "confirm") {
        const answer = acceptedContent(ctx.mcpReq.inputResponses, "confirm", confirmationSchema);
        if (answer?.confirm !== true) {
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `${tool.summarize(args)}\n\nThis is a ${operation} operation. Proceed?`,
                requestedSchema: {
                  type: "object",
                  properties: { confirm: { type: "boolean" } },
                  required: ["confirm"],
                },
              }),
            },
          });
        }
      }

      const result = await tool.run(args, { client: input.client, session: input.session });
      return { content: [{ type: "text" as const, text: renderResult(result) }] };
    },
  );

  report.registered.push(tool.name);
}

/**
 * A floor, not an oracle: a tool spanning `read` and `destroy` survives a denied
 * `destroy`, and the per-call guard refuses the destroying arguments at run time.
 */
function isFullyDenied(policy: WritePolicy, tool: ToolDefinition): boolean {
  return tool.classes.every((operation) => policy[operation] === "deny");
}

function renderResult(result: { text: string; nextCursor?: string }): string {
  return result.nextCursor === undefined
    ? result.text
    : `${result.text}\n\n[more results — cursor: ${result.nextCursor}]`;
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
