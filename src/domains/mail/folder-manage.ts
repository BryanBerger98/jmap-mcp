import { z } from "zod";
import type { Id, SetError, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL } from "../../jmap/types/core.js";
import type { Mailbox, MailboxSetArguments } from "../../jmap/types/mail.js";
import { defineTool, type ToolContext } from "../../registry/define-tool.js";
import { resolveMailboxes, unknownMailbox } from "./organize.js";

/** The key a creation is filed under: JMAP hands back the real id in `created`. */
const CREATION_KEY = "new";

const inputSchema = z
  .object({
    action: z
      .enum(["create", "rename", "move", "delete"])
      .describe("What to do: create a folder, rename one, move one under another, or delete one."),
    mailboxId: z
      .string()
      .optional()
      .describe("The folder to act on, as returned by mail_folders. Required except on create."),
    name: z.string().optional().describe("The folder name. Required on create and rename."),
    parentId: z
      .string()
      .nullable()
      .optional()
      .describe("The parent folder id, or null for the root of the tree. Used by create and move."),
  })
  .refine((input) => input.action === "create" || input.mailboxId !== undefined, {
    message: "Name the folder to act on with `mailboxId`.",
    path: ["mailboxId"],
  })
  .refine((input) => !NAMING_ACTIONS.has(input.action) || input.name !== undefined, {
    message: "Give the folder a `name`.",
    path: ["name"],
  });

const NAMING_ACTIONS = new Set(["create", "rename"]);

/** What a folder the account does not hold costs, action by action. */
const MISSING_TARGET: Record<Input["action"], string> = {
  create: "there is nothing there to act on",
  rename: "there is nothing to rename",
  move: "there is no such folder to move",
  delete: "there is nothing to delete",
};

export const mailFolderManage = defineTool({
  name: "mail_folder_manage",
  title: "Create, rename, move or delete a mail folder",
  description:
    "Manages the folder tree: creates a folder, renames one, moves one under another parent, or " +
    "deletes one. Deleting never takes the messages with it — a folder holding messages, or " +
    "holding another folder, is refused instead. Folders the mail client relies on (inbox, " +
    "drafts, sent, trash and the like) can be neither renamed nor deleted. " +
    "Run mail_folders first: every id this takes comes from there.",
  inputSchema,
  // Only `delete` can lose anything, and only that action classifies as one.
  classes: ["draft", "destroy"],
  classify: (input) => (input.action === "delete" ? "destroy" : "draft"),
  summarize: async (input, context) => {
    const target = input.mailboxId === undefined ? undefined : await find(input.mailboxId, context);
    const named = target?.name ?? input.mailboxId ?? input.name ?? "a folder";

    switch (input.action) {
      case "create":
        return `Create the folder ${input.name} under ${await parentName(input.parentId, context)}.`;
      case "rename":
        return `Rename the folder ${named} to ${input.name}.`;
      case "move":
        return `Move the folder ${named} under ${await parentName(input.parentId, context)}.`;
      default:
        return `Delete the folder ${named}, which holds no message and no sub-folder. Its messages are not at stake; the folder itself does not come back.`;
    }
  },
  precheck: async (input, context) => {
    const mailboxes = await resolveMailboxes(context);
    const target =
      input.mailboxId === undefined
        ? undefined
        : mailboxes.find((mailbox) => mailbox.id === input.mailboxId);

    if (input.mailboxId !== undefined && target === undefined) {
      return unknownMailbox(input.mailboxId, MISSING_TARGET[input.action]);
    }

    // A role is what tells the mail client which folder is which. Renaming or
    // deleting one leaves the client pointing at a folder that no longer means
    // what it meant, and no argument to this tool can put the role back.
    if (target?.role != null && (input.action === "rename" || input.action === "delete")) {
      return (
        `Refused: the folder ${target.name} carries the \`${target.role}\` role, so your mail client ` +
        `relies on it being where it is. Rename or delete it from your mail client if you really mean to.`
      );
    }

    if (input.action === "delete" && target !== undefined) {
      return refuseNonEmptyDelete(target, mailboxes);
    }

    if (input.action === "create" || input.action === "rename") {
      return refuseDuplicateName(input, target, mailboxes);
    }

    if (input.action === "move" && target !== undefined) {
      return refuseImpossibleMove(target, input.parentId ?? null, mailboxes);
    }

    return undefined;
  },
  run: async (input, context) => {
    const args = requestFor(input, context.session.accountId);

    const response = await context.client.request<SetResponse<Mailbox>>(
      [CAPABILITY_CORE, CAPABILITY_MAIL],
      ["Mailbox/set", args, "0"],
    );

    return { text: describeOutcome(input, response) };
  },
});

type Input = z.infer<typeof inputSchema>;

/** One object per call, and the cascade written out on every one of them. */
function requestFor(input: Input, accountId: Id): MailboxSetArguments {
  const base: MailboxSetArguments = {
    accountId,
    // Stated on every request, not only on the destroying one: a reader of the
    // wire sees on every folder write that no message is to be removed.
    onDestroyRemoveEmails: false,
  };

  switch (input.action) {
    case "create":
      return {
        ...base,
        create: {
          [CREATION_KEY]: {
            name: givenName(input),
            ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          },
        },
      };
    case "rename":
      // The name alone: sending `parentId` too would move a folder the caller
      // only meant to rename.
      return { ...base, update: { [targetId(input)]: { name: givenName(input) } } };
    case "move":
      return { ...base, update: { [targetId(input)]: { parentId: input.parentId ?? null } } };
    default:
      return { ...base, destroy: [targetId(input)] };
  }
}

/**
 * The field this action cannot be carried out without, or a throw.
 *
 * `inputSchema` refuses a call that omits it before the handler is reached, so
 * an absent value here means the schema and the code below it have drifted
 * apart. A fallback would answer that drift by destroying an empty id or
 * creating a folder with no name; a throw writes nothing at all.
 */
function demand<T>(value: T | undefined, field: string, action: Input["action"]): T {
  if (value === undefined) {
    throw new Error(
      `mail_folder_manage: \`${field}\` is missing on a ${action} call, which the input schema rules out.`,
    );
  }

  return value;
}

/** The folder the call acts on, which the schema requires of every action but create. */
function targetId(input: Input): Id {
  return demand(input.mailboxId, "mailboxId", input.action);
}

/** The name the call gives a folder, which the schema requires of create and rename. */
function givenName(input: Input): string {
  return demand(input.name, "name", input.action);
}

function describeOutcome(input: Input, response: SetResponse<Mailbox>): string {
  switch (input.action) {
    case "create": {
      const refused = response.notCreated?.[CREATION_KEY];
      if (refused !== undefined) return refusedBy(refused);

      const created = response.created?.[CREATION_KEY];
      return `Folder ${givenName(input)} created${created === undefined ? "" : ` (id ${created.id})`}.`;
    }
    case "rename":
    case "move": {
      const id = targetId(input);
      const refused = response.notUpdated?.[id];
      if (refused !== undefined) return refusedBy(refused);

      return input.action === "rename"
        ? `Folder ${id} renamed to ${givenName(input)}.`
        : `Folder ${id} moved under ${input.parentId ?? "the root of the tree"}.`;
    }
    default: {
      const id = targetId(input);
      const refused = response.notDestroyed?.[id];
      return refused === undefined
        ? `Folder ${id} deleted. No message was removed.`
        : refusedBy(refused);
    }
  }
}

/** The server's own words: it knows things the precheck cannot. */
function refusedBy(error: SetError): string {
  return `Refused by the mail server: ${error.type}${error.description === undefined ? "" : ` — ${error.description}`}`;
}

/**
 * Deleting a folder must never be a way of deleting what is inside it.
 *
 * `onDestroyRemoveEmails` is emitted false, so the server would refuse anyway,
 * but a refusal that names the count is worth more than a JMAP error code: it
 * tells the caller what to move out first.
 */
function refuseNonEmptyDelete(target: Mailbox, mailboxes: readonly Mailbox[]): string | undefined {
  if (target.totalEmails > 0) {
    return (
      `Refused: the folder ${target.name} holds ${target.totalEmails} ${target.totalEmails === 1 ? "message" : "messages"}, ` +
      "and deleting a folder never deletes what is in it. Move them elsewhere with mail_move, or " +
      "delete them with mail_delete, then delete the folder."
    );
  }

  const child = mailboxes.find((mailbox) => mailbox.parentId === target.id);
  return child === undefined
    ? undefined
    : `Refused: the folder ${target.name} holds the sub-folder ${child.name}, which would go with it. Deal with the sub-folder first.`;
}

/**
 * Two folders sharing a name under one parent are indistinguishable in every
 * listing, so the second one is a trap rather than a folder.
 */
function refuseDuplicateName(
  input: Input,
  target: Mailbox | undefined,
  mailboxes: readonly Mailbox[],
): string | undefined {
  // Renaming keeps the folder where it is; creating puts it where asked.
  const parentId =
    input.action === "rename" ? (target?.parentId ?? null) : (input.parentId ?? null);

  if (input.action === "create" && input.parentId != null) {
    const parent = mailboxes.find((mailbox) => mailbox.id === input.parentId);
    if (parent === undefined)
      return unknownMailbox(input.parentId, "no folder can be created under it");
  }

  const wanted = givenName(input).toLowerCase();
  const clash = mailboxes.find(
    (mailbox) =>
      mailbox.id !== target?.id &&
      (mailbox.parentId ?? null) === parentId &&
      mailbox.name.toLowerCase() === wanted,
  );

  return clash === undefined
    ? undefined
    : `Refused: a folder named ${clash.name} already sits there (id ${clash.id}). Pick another name, or another parent.`;
}

/**
 * A folder moved under its own descendant leaves the tree: it and everything
 * below it become a ring that no root reaches, and no listing shows again.
 */
function refuseImpossibleMove(
  target: Mailbox,
  parentId: Id | null,
  mailboxes: readonly Mailbox[],
): string | undefined {
  if (parentId === null) return undefined;

  if (parentId === target.id) {
    return `Refused: the folder ${target.name} cannot be its own parent.`;
  }

  const parent = mailboxes.find((mailbox) => mailbox.id === parentId);
  if (parent === undefined) {
    return unknownMailbox(parentId, `${target.name} cannot be moved under it`);
  }

  return isDescendantOf(parent, target, mailboxes)
    ? `Refused: ${parent.name} sits inside ${target.name}, so moving ${target.name} there would cut both out of the folder tree.`
    : undefined;
}

/** Walks up from `mailbox`, stopping on a cycle the account already carries. */
function isDescendantOf(
  mailbox: Mailbox,
  ancestor: Mailbox,
  mailboxes: readonly Mailbox[],
): boolean {
  const seen = new Set<Id>([mailbox.id]);
  let parentId = mailbox.parentId;

  while (parentId !== null && parentId !== undefined) {
    if (parentId === ancestor.id) return true;
    if (seen.has(parentId)) return false;

    seen.add(parentId);
    parentId = mailboxes.find((candidate) => candidate.id === parentId)?.parentId ?? null;
  }

  return false;
}

async function find(mailboxId: Id, context: ToolContext): Promise<Mailbox | undefined> {
  const mailboxes = await resolveMailboxes(context);
  return mailboxes.find((mailbox) => mailbox.id === mailboxId);
}

async function parentName(parentId: Id | null | undefined, context: ToolContext): Promise<string> {
  if (parentId === null || parentId === undefined) return "the root of the tree";
  return (await find(parentId, context))?.name ?? parentId;
}
