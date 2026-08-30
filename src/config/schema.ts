import { z } from "zod";
import { DEFAULT_POLICY, POLICY_LEVELS, type WritePolicy } from "./policy.js";

const policyLevelSchema = z.enum(POLICY_LEVELS);

/** Every class is optional; an absent one falls back to its default level. */
const writePolicySchema = z
  .object({
    read: policyLevelSchema.optional(),
    draft: policyLevelSchema.optional(),
    send: policyLevelSchema.optional(),
    destroy: policyLevelSchema.optional(),
  })
  .transform(
    (partial): WritePolicy => ({
      read: partial.read ?? DEFAULT_POLICY.read,
      draft: partial.draft ?? DEFAULT_POLICY.draft,
      send: partial.send ?? DEFAULT_POLICY.send,
      destroy: partial.destroy ?? DEFAULT_POLICY.destroy,
    }),
  );

export const configSchema = z.object({
  /** The JMAP session resource, e.g. https://mail.example.com/.well-known/jmap */
  sessionUrl: z.url(),
  /** Never accepted on the command line: it would land in the process table. */
  bearerToken: z.string().min(1),
  /** Restricts the server to one account when the session exposes several. */
  accountId: z.string().min(1).optional(),
  policy: writePolicySchema.default(DEFAULT_POLICY),
});

export type Config = z.infer<typeof configSchema>;
