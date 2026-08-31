import {
  acceptedContent,
  inputRequired,
  type McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { OperationClass, WritePolicy } from "../config/policy.js";
import type { JmapClient } from "../jmap/client.js";
import type { JmapSession } from "../jmap/session.js";
import type { ToolDefinition } from "./define-tool.js";
import { clientCanElicit } from "./elicitation.js";
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

export interface ToolSelection {
  /** The tools that survive the crossing, in registration order. */
  exposed: ToolDefinition[];
  /** Every class those tools can still reach: what the surface actually does. */
  classes: Set<OperationClass>;
  skipped: { domain: string; missing: string[] }[];
  denied: string[];
}

const confirmationSchema = z.object({ confirm: z.boolean() });

/**
 * Crosses the session's capabilities with the configured policy.
 *
 * Exported so the initialization instructions can describe the very surface
 * `compose` registers instead of asserting one: two independent traversals
 * would drift the day a write domain lands. Pure, and cheap enough to run twice.
 */
export function selectTools(
  domains: readonly DomainManifest[],
  session: JmapSession,
  policy: WritePolicy,
): ToolSelection {
  const selection: ToolSelection = {
    exposed: [],
    classes: new Set<OperationClass>(),
    skipped: [],
    denied: [],
  };

  for (const domain of domains) {
    const missing = domain.requires.filter((capability) => !session.has(capability));
    if (missing.length > 0) {
      selection.skipped.push({ domain: domain.name, missing });
      continue;
    }

    for (const tool of domain.tools) {
      // Every class the tool can reach is denied: registering it would only ever fail.
      if (isFullyDenied(policy, tool)) {
        selection.denied.push(tool.name);
        continue;
      }

      selection.exposed.push(tool);
      for (const operation of tool.classes) {
        // A denied class stays out of reach: the per-call guard refuses it.
        if (policy[operation] !== "deny") selection.classes.add(operation);
      }
    }
  }

  return selection;
}

/**
 * Registers the surviving tools. Runs once, before `connect()`: the
 * specification forbids a tool list that varies during a session.
 */
export function compose(input: ComposeInput): ComposeReport {
  const selection = selectTools(input.domains, input.session, input.policy);

  for (const tool of selection.exposed) {
    register(input, tool);
  }

  return {
    registered: selection.exposed.map((tool) => tool.name),
    skipped: selection.skipped,
    denied: selection.denied,
  };
}

function register(input: ComposeInput, tool: ToolDefinition): void {
  input.server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      // The definition owns the schema; the SDK wants it as a Standard Schema.
      inputSchema: tool.inputSchema as unknown as StandardSchemaWithJSON<unknown, unknown>,
    },
    async (
      args: unknown,
      ctx: {
        mcpReq: {
          inputResponses?: Record<string, unknown>;
          envelope?: Record<string, unknown>;
        };
      },
    ) => {
      const context = { client: input.client, session: input.session };
      const operation = tool.classify(args);
      const level = input.policy[operation];

      if (level === "deny") {
        return errorResult(
          `Refused: ${tool.name} is a ${operation} operation and the policy denies that class.`,
        );
      }

      if (level === "confirm") {
        // Decided before the request is built, never after: a refusal that comes
        // once the call is out is not a refusal.
        if (!clientCanElicit(input.server, ctx.mcpReq)) {
          return errorResult(
            `Refused: ${tool.name} is a ${operation} operation, which this server only runs after you confirm it. ` +
              "Your MCP client did not declare the elicitation capability, so it cannot be asked for that confirmation and the operation is refused.",
          );
        }

        const answer = acceptedContent(ctx.mcpReq.inputResponses, "confirm", confirmationSchema);
        if (answer?.confirm !== true) {
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `${await tool.summarize(args, context)}\n\nThis is a ${operation} operation. Proceed?`,
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

      const result = await tool.run(args, context);
      return { content: [{ type: "text" as const, text: renderResult(result) }] };
    },
  );
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
