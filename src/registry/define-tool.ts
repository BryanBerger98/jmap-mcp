import type { ZodType, z } from "zod";
import type { OperationClass } from "../config/policy.js";
import type { JmapClient } from "../jmap/client.js";
import type { JmapSession } from "../jmap/session.js";

export interface ToolContext {
  client: JmapClient;
  session: JmapSession;
}

export interface ToolResult {
  /** Compact text rendering; the client sees this, never a raw JMAP payload. */
  text: string;
  /** Opaque cursor when the result was truncated by the pagination budget. */
  nextCursor?: string;
}

export interface ToolDefinition<TInput extends ZodType = ZodType> {
  name: string;
  title: string;
  description: string;
  inputSchema: TInput;
  /**
   * Every operation class this tool can reach, whatever its arguments.
   *
   * Declared so the registry can drop a tool whose classes are all denied,
   * without executing it. `classify` must return a member of this set.
   */
  classes: readonly [OperationClass, ...OperationClass[]];
  /**
   * Classifies one call from its arguments.
   *
   * The class cannot be read off the method name: in all six domains a single
   * argument flips a write into a destroy or a send. The tool decides; the
   * registry decides what that class is allowed to do.
   */
  classify: (input: z.infer<TInput>) => OperationClass;
  /**
   * One line describing the effect, shown to the user at confirmation time.
   *
   * It is handed the context because a confirmation is only worth reading when
   * it names what the arguments merely point at: `mail_send` receives a message
   * id, and echoing that id back tells nobody what is about to leave the
   * account. Reading here is expected; writing here never is.
   */
  summarize: (input: z.infer<TInput>, context: ToolContext) => string | Promise<string>;
  run: (input: z.infer<TInput>, context: ToolContext) => Promise<ToolResult>;
}

/** Identity helper: it exists so `classify` and `run` infer from `inputSchema`. */
export function defineTool<TInput extends ZodType>(
  definition: ToolDefinition<TInput>,
): ToolDefinition<TInput> {
  return definition;
}
