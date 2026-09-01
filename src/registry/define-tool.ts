import type { ZodType, z } from "zod";
import type { OperationClass, WritePolicy } from "../config/policy.js";
import type { RecipientScope } from "../config/recipients.js";
import type { JmapClient } from "../jmap/client.js";
import type { JmapSession } from "../jmap/session.js";

export interface ToolContext {
  client: JmapClient;
  session: JmapSession;
  /** Who this server may write to, resolved once at startup. */
  recipients: RecipientScope;
  /**
   * The configured policy, for the one hook that has to read it rather than be
   * governed by it.
   *
   * The registry guards a call on the class `classify` returns, and that is one
   * class per call. A destruction whose side effect is a send reaches the guard
   * as a `destroy` alone, so a configuration refusing `send` would let the
   * cancellation leave anyway: `precheck` is where that gap is closed, and it
   * needs the policy in hand to close it. Read here, never written.
   */
  policy: WritePolicy;
  /**
   * Above how many objects a reversible bulk write should ask before running.
   *
   * Handed to the tool rather than read by the registry: only the tool knows
   * what its arguments count — a list of ids, a folder, a single message.
   */
  bulkConfirmAbove: number;
  /**
   * Runs a read once per handler invocation and hands every later caller the
   * same answer.
   *
   * `summarize`, `precheck` and `run` each need the message the call points at,
   * and asking the server three times spends three round trips to learn the
   * same thing. The cache lives for one invocation and not a moment longer: a
   * confirmation pauses between two invocations, and a verdict carried across
   * that pause would judge a draft that may since have been rewritten.
   */
  once: <T>(key: string, read: () => Promise<T>) => Promise<T>;
}

/**
 * Builds one cache. Called per handler invocation, never hoisted out of it —
 * the lifetime is the whole point of the thing.
 */
export function perInvocationCache(): ToolContext["once"] {
  const started = new Map<string, Promise<unknown>>();

  return <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const pending = started.get(key);
    if (pending !== undefined) return pending as Promise<T>;

    // Stored before it settles, so two callers racing share the one request.
    const fresh = read();
    started.set(key, fresh);
    return fresh;
  };
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
  /**
   * A refusal the registry raises before it asks anything of the user, or
   * `undefined` to let the call proceed.
   *
   * It exists for the checks that must not be confirmable: asking someone to
   * confirm a send that the recipient perimeter will refuse anyway teaches them
   * that confirmations are noise. Reading is allowed here; writing never is.
   */
  precheck?: (
    input: z.infer<TInput>,
    context: ToolContext,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * Why this particular call deserves a confirmation its class does not
   * require, or `undefined` to run it straight away.
   *
   * It never replaces `classify`, which keeps telling the truth about what the
   * call does: moving two hundred messages is still a move, and calling it a
   * destroy to force the question would misinform the user at the very moment
   * they arbitrate. The reason it returns is shown in place of the operation
   * class, because "this is a draft operation" explains nothing about volume.
   *
   * Reading is allowed here, as in `precheck`; writing never is.
   */
  confirmWhen?: (
    input: z.infer<TInput>,
    context: ToolContext,
  ) => string | undefined | Promise<string | undefined>;
  run: (input: z.infer<TInput>, context: ToolContext) => Promise<ToolResult>;
}

/** Identity helper: it exists so `classify` and `run` infer from `inputSchema`. */
export function defineTool<TInput extends ZodType>(
  definition: ToolDefinition<TInput>,
): ToolDefinition<TInput> {
  return definition;
}
