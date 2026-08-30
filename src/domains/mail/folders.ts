import { z } from "zod";
import type { GetResponse, Id } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL } from "../../jmap/types/core.js";
import type { Mailbox, MailboxGetArguments } from "../../jmap/types/mail.js";
import { defineTool } from "../../registry/define-tool.js";
import { renderTable } from "../../shared/render.js";

/** Explicit, so the server does not hand back properties nothing renders. */
const PROPERTIES = ["id", "name", "parentId", "role", "totalEmails", "unreadEmails"] as const;

const inputSchema = z.object({
  includeEmpty: z
    .boolean()
    .optional()
    .describe("Keep folders holding no message. Defaults to true."),
});

export const mailFolders = defineTool({
  name: "mail_folders",
  title: "List mail folders",
  description:
    "Lists the folders of the mailbox with their full path, role, and unread count. " +
    "The `id` column is what `mail_search` takes as `mailboxId` to restrict a search to one folder. " +
    "A folder whose parent is not in the account is listed under its own name, with no path.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: () => "List the mail folders of the account.",
  run: async (input, { client, session }) => {
    const args: MailboxGetArguments = {
      accountId: session.accountId,
      ids: null,
      properties: [...PROPERTIES],
    };

    const response = await client.request<GetResponse<Mailbox>>(
      [CAPABILITY_CORE, CAPABILITY_MAIL],
      ["Mailbox/get", args, "0"],
    );

    const byId = new Map(response.list.map((mailbox) => [mailbox.id, mailbox]));
    const keepEmpty = input.includeEmpty ?? true;

    const rows = response.list
      .filter((mailbox) => keepEmpty || mailbox.totalEmails > 0)
      .map((mailbox) => ({
        path: pathOf(mailbox, byId),
        role: mailbox.role,
        unreadEmails: mailbox.unreadEmails,
        totalEmails: mailbox.totalEmails,
        id: mailbox.id,
      }))
      // Sorting on the path is what makes the tree readable: a child follows its parent.
      .sort((a, b) => a.path.localeCompare(b.path));

    return { text: renderTable(rows, ["path", "role", "unreadEmails", "totalEmails", "id"]) };
  },
});

/**
 * Walks the `parentId` chain up to the root.
 *
 * A missing parent yields the bare name rather than a partial path: half a path
 * reads like a real one and would send a search at the wrong folder.
 */
function pathOf(mailbox: Mailbox, byId: Map<Id, Mailbox>): string {
  const segments = [mailbox.name];
  const seen = new Set<Id>([mailbox.id]);

  let parentId = mailbox.parentId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (parent === undefined || seen.has(parent.id)) return mailbox.name;

    segments.unshift(parent.name);
    seen.add(parent.id);
    parentId = parent.parentId;
  }

  return segments.join("/");
}
