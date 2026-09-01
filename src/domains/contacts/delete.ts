import { z } from "zod";
import type {
  ContactCard,
  ContactCardGetArguments,
  ContactCardSetArguments,
} from "../../jmap/types/contacts.js";
import type { GetResponse, Id, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CONTACTS, CAPABILITY_CORE } from "../../jmap/types/core.js";
import { defineTool, type ToolContext } from "../../registry/define-tool.js";
import { refuseOversizedBatch } from "../../shared/batch.js";
import { displayName, primaryEmail } from "./card.js";
import { CONTACT_CARDS, describeCardOutcome } from "./edit.js";

/** How many cards a confirmation spells out before it counts the rest. */
const CARDS_NAMED = 5;

const inputSchema = z.object({
  ids: z
    .array(z.string())
    .describe("The card ids to destroy, as returned by contacts_search or contacts_read."),
});

export const contactsDelete = defineTool({
  name: "contacts_delete",
  title: "Destroy contact cards",
  description:
    "Destroys the named contact cards. This is permanent: contacts have no trash, so nothing " +
    "holds a destroyed card and no later call brings it back. A group that counted the card " +
    "among its members keeps the uid it stored, now pointing at no card at all. " +
    "It acts on card ids only — run contacts_search first and pass the ids it returns, " +
    "because a search rerun here could match cards you never saw.",
  inputSchema,
  // One class and one branch: with no trash to file a card into, there is no
  // reversible gesture to offer and every call goes through the question.
  classes: ["destroy"],
  classify: () => "destroy",
  summarize: async (input, context) =>
    `Permanently destroy ${await describeCards(input.ids, context)}. Contacts have no trash: ` +
    "nothing recovers them afterwards.",
  precheck: (input) => refuseOversizedBatch(input.ids, CONTACT_CARDS),
  run: async (input, context) => {
    // `destroy` alone: an `update` riding along would change cards under a
    // confirmation the user read as a destruction, and a `create` would add one.
    const args: ContactCardSetArguments = {
      accountId: context.session.accountId,
      destroy: [...input.ids],
    };

    const response = await context.client.request<SetResponse<ContactCard>>(
      [CAPABILITY_CORE, CAPABILITY_CONTACTS],
      ["ContactCard/set", args, "0"],
    );

    return { text: describeCardOutcome(response, input.ids, "destroyed", "destroyed") };
  },
});

/**
 * "3 contact cards: Camille Roy <camille@example.org> and 1 more".
 *
 * A count alone is not something anyone can arbitrate: confirming the erasure of
 * "3 contact cards" is confirming a number. A failed read degrades to that count
 * rather than to a refusal, because a transport hiccup must not turn into a
 * verdict on the call.
 */
async function describeCards(ids: readonly Id[], context: ToolContext): Promise<string> {
  const count = `${ids.length} contact ${ids.length === 1 ? "card" : "cards"}`;
  const cards = await readCards(ids, context);
  if (cards.length === 0) return count;

  const named = cards.slice(0, CARDS_NAMED).map((card) => {
    const address = primaryEmail(card);
    return address === undefined ? displayName(card) : `${displayName(card)} <${address}>`;
  });

  const rest = ids.length - named.length;
  return `${count}: ${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/** The name and the address, and nothing else: this read is for one sentence. */
async function readCards(ids: readonly Id[], context: ToolContext): Promise<ContactCard[]> {
  const args: ContactCardGetArguments = {
    accountId: context.session.accountId,
    ids: [...ids],
    properties: ["id", "name", "emails"],
  };

  try {
    const response = await context.once(`contacts:delete:${[...ids].sort().join(",")}`, () =>
      context.client.request<GetResponse<ContactCard>>(
        [CAPABILITY_CORE, CAPABILITY_CONTACTS],
        ["ContactCard/get", args, "0"],
      ),
    );

    return response.list;
  } catch {
    // The summary is a courtesy, not a check: a read that fails leaves the
    // confirmation naming a count, and the call itself still goes to the user.
    return [];
  }
}
