import {
  acceptedContent,
  inputRequired,
  type McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { OperationClass, WritePolicy } from "../config/policy.js";
import { OPEN_SCOPE, type RecipientScope } from "../config/recipients.js";
import { type Config, DEFAULT_BULK_CONFIRM_ABOVE } from "../config/schema.js";
import { type BlobChannel, UNWIRED_BLOBS } from "../jmap/blob.js";
import type { JmapClient } from "../jmap/client.js";
import type { JmapSession } from "../jmap/session.js";
import { perInvocationCache, type ToolContext, type ToolDefinition } from "./define-tool.js";
import { clientCanElicit } from "./elicitation.js";
import type { DomainManifest } from "./manifest.js";

export interface CompositionInput {
  server: McpServer;
  domains: readonly DomainManifest[];
  session: JmapSession;
  client: JmapClient;
  policy: WritePolicy;
  /** Who the tools may write to. Absent means no restriction was configured. */
  recipients?: RecipientScope;
  /** Volume past which a reversible bulk call asks. Absent means the default. */
  bulkConfirmAbove?: number;
  /** How bytes move. Absent leaves a channel that refuses rather than one that lies. */
  blobs?: BlobChannel;
  /** Where bytes may touch the disk. Absent means no local directory was named. */
  files?: Config["files"];
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
export function compose(input: CompositionInput): ComposeReport {
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

function register(input: CompositionInput, tool: ToolDefinition): void {
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
      const context: ToolContext = {
        client: input.client,
        session: input.session,
        blobs: input.blobs ?? UNWIRED_BLOBS,
        files: input.files ?? {},
        recipients: input.recipients ?? OPEN_SCOPE,
        policy: input.policy,
        bulkConfirmAbove: input.bulkConfirmAbove ?? DEFAULT_BULK_CONFIRM_ABOVE,
        // Built here and nowhere else: the invocation that asks the question
        // and the one that carries the answer must not share a cached read.
        once: perInvocationCache(),
      };
      const operation = tool.classify(args);
      let level = input.policy[operation];

      if (level === "deny") {
        return errorResult(
          `Refused: ${tool.name} is a ${operation} operation and the policy denies that class.`,
        );
      }

      // Before the confirmation, not after: a call that is going to be refused
      // whatever the answer must never be put to the user as a question.
      const refusal = await tool.precheck?.(args, context);
      if (refusal !== undefined) return errorResult(refusal);

      // The second path to a confirmation, opened by the tool rather than by the
      // policy: an allowed class can still carry a call worth asking about.
      // Consulted after `precheck` and never before, for the same reason the
      // perimeter comes first — a doomed call is not made into a question by
      // being bulky. A class already at `confirm` is going to ask anyway, and a
      // denied one has long returned.
      const escalation = level === "allow" ? await tool.confirmWhen?.(args, context) : undefined;
      if (escalation !== undefined) level = "confirm";

      if (level === "confirm") {
        // Decided before the request is built, never after: a refusal that comes
        // once the call is out is not a refusal.
        if (!clientCanElicit(input.server, ctx.mcpReq)) {
          return errorResult(
            escalation === undefined
              ? `Refused: ${tool.name} is a ${operation} operation, which this server only runs after you confirm it. ` +
                  "Your MCP client did not declare the elicitation capability, so it cannot be asked for that confirmation and the operation is refused."
              : `Refused: ${escalation} This server only runs that after you confirm it, and your MCP client did not ` +
                  "declare the elicitation capability, so it cannot be asked for that confirmation and the operation is refused.",
          );
        }

        const answer = acceptedContent(ctx.mcpReq.inputResponses, "confirm", confirmationSchema);
        if (answer?.confirm !== true) {
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                // The reason the tool gave, when it gave one: telling someone
                // "this is a draft operation" says nothing about the volume
                // they are being asked to arbitrate.
                message: `${await tool.summarize(args, context)}\n\n${escalation ?? `This is a ${operation} operation.`} Proceed?`,
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
