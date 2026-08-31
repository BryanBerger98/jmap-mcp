import { z } from "zod";
import type { GetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_SUBMISSION } from "../../jmap/types/core.js";
import type { Identity, IdentityGetArguments } from "../../jmap/types/mail.js";
import { defineTool } from "../../registry/define-tool.js";
import { renderTable } from "../../shared/render.js";
import { IDENTITY_PROPERTIES } from "./submission.js";

/**
 * RFC 8621 gives `Identity` no default flag, so the primary one is derived: it
 * is the identity whose address is the login the session was opened with. An
 * account may declare aliases the user never writes from, and that column tells
 * them apart. It is informational — `mail_compose` still refuses to pick one.
 */
const PRIMARY_MARK = "yes";

const inputSchema = z.object({});

export const mailIdentities = defineTool({
  name: "mail_identities",
  title: "List sending identities",
  description:
    "Lists the addresses this account may send from, with the display name attached to each. " +
    "The `id` column is what `mail_compose` and `mail_send` take as `identityId` to pick the sender. " +
    "Call this first when the account has more than one address: neither tool chooses one for you. " +
    "The `primary` column marks the identity matching the login this session was opened with.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: () => "List the sending identities of the account.",
  run: async (_input, { client, session }) => {
    const args: IdentityGetArguments = {
      accountId: session.accountId,
      ids: null,
      properties: [...IDENTITY_PROPERTIES],
    };

    const response = await client.request<GetResponse<Identity>>(
      [CAPABILITY_CORE, CAPABILITY_SUBMISSION],
      ["Identity/get", args, "0"],
    );

    if (response.list.length === 0) {
      return {
        text: "This account declares no sending identity, so nothing can be sent from it. Add one on the mail server first.",
      };
    }

    const login = session.username.toLowerCase();
    const rows = response.list.map((identity) => ({
      email: identity.email,
      name: identity.name,
      primary: identity.email.toLowerCase() === login ? PRIMARY_MARK : "",
      id: identity.id,
    }));

    return { text: renderTable(rows, ["email", "name", "primary", "id"]) };
  },
});
