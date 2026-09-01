import { isAbsolute } from "node:path";
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

/** Who a message may be addressed to. `contacts` reads the address books once. */
export const RECIPIENT_SCOPES = ["anyone", "contacts"] as const;

export type RecipientScopeSetting = (typeof RECIPIENT_SCOPES)[number];

export interface RecipientsSetting {
  scope: RecipientScopeSetting;
  /** Addresses, or `@domain` entries, allowed on top of the address books. */
  allow: string[];
}

/** Open unless asked otherwise: a restriction nobody configured costs a read. */
export const OPEN_RECIPIENTS: RecipientsSetting = { scope: "anyone", allow: [] };

/**
 * One entry of the allow list: a whole address, or a domain written `@example.com`.
 *
 * A bare `example.com` is refused rather than guessed at: read as an address it
 * matches nothing, read as a domain it opens every mailbox behind it, and the
 * two readings are too far apart to pick one silently.
 */
const allowEntrySchema = z.string().refine(
  (entry) => {
    const at = entry.indexOf("@");
    if (at === -1) return false;
    // `@domain` (at index 0) or `local@domain`: either way something follows.
    return at === entry.lastIndexOf("@") && entry.length > at + 1;
  },
  {
    message:
      "Each recipients.allow entry must be an address (user@example.com) or a domain (@example.com)",
  },
);

const recipientsSchema = z
  .object({
    scope: z.enum(RECIPIENT_SCOPES).optional(),
    allow: z.array(allowEntrySchema).optional(),
  })
  .transform(
    (partial): RecipientsSetting => ({
      scope: partial.scope ?? OPEN_RECIPIENTS.scope,
      allow: partial.allow ?? [],
    }),
  );

/**
 * How many objects a reversible bulk write may touch before it is confirmed.
 *
 * Twenty is roughly what a person can still picture: past it, "archive those"
 * stops naming a set they have in mind and starts naming one they have not seen.
 */
export const DEFAULT_BULK_CONFIRM_ABOVE = 20;

/**
 * The one directory this server may read from and write to on the local disk.
 *
 * No default, deliberately. A temporary directory the user never named is a
 * directory they never watch, and the two tools that move bytes refuse by naming
 * this key rather than inventing a destination. Everything else — browsing,
 * creating a folder, organizing, deleting — works without it.
 */
const filesSchema = z
  .object({
    localRoot: z
      .string()
      .refine(isAbsolute, { message: "files.localRoot must be an absolute path" })
      .optional(),
  })
  .default({});

export const configSchema = z.object({
  /** The JMAP session resource, e.g. https://mail.example.com/.well-known/jmap */
  sessionUrl: z.url(),
  /** Never accepted on the command line: it would land in the process table. */
  bearerToken: z.string().min(1),
  /** Restricts the server to one account when the session exposes several. */
  accountId: z.string().min(1).optional(),
  policy: writePolicySchema.default(DEFAULT_POLICY),
  recipients: recipientsSchema.default(OPEN_RECIPIENTS),
  files: filesSchema,
  bulkConfirmAbove: z
    .int()
    .min(1)
    .default(DEFAULT_BULK_CONFIRM_ABOVE)
    .describe(
      "Above this many objects, a reversible bulk operation asks before it runs. It weighs volume " +
        "and nothing else: an irreversible operation is confirmed by its class whatever its size.",
    ),
});

export type Config = z.infer<typeof configSchema>;
