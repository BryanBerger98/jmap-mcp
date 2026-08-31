import { McpServer } from "@modelcontextprotocol/server";
import { OPEN_SCOPE, type RecipientScope, restrictTo } from "./config/recipients.js";
import type { Config, RecipientsSetting } from "./config/schema.js";
import { ALL_DOMAINS } from "./domains/index.js";
import { JmapClient } from "./jmap/client.js";
import type { JmapSession } from "./jmap/session.js";
import { discoverSession } from "./jmap/session.js";
import type {
  ContactCard,
  ContactCardGetArguments,
  ContactCardQueryArguments,
} from "./jmap/types/contacts.js";
import type { CoreCapability, GetResponse, Id, QueryResponse } from "./jmap/types/core.js";
import { CAPABILITY_CONTACTS, CAPABILITY_CORE } from "./jmap/types/core.js";
import { type ComposeReport, compose, selectTools } from "./registry/compose.js";
import { buildInstructions } from "./registry/instructions.js";

export const SERVER_NAME = "jmap-mcp";
export const SERVER_VERSION = "0.1.0";

/** How many objects to ask for at once when the session states no limit. */
const DEFAULT_PAGE = 500;

/**
 * The point past which the perimeter stops being a perimeter.
 *
 * An address book this large is being used as a directory, and holding it in
 * memory to decide every send is neither cheap nor meaningful. Past it the
 * scope is declared unreadable, which refuses rather than widens.
 */
export const MAX_SCOPE_CARDS = 5000;

/**
 * Builds a fully composed server. Discovery runs first because the registry
 * needs the session's capabilities to decide which tools exist at all.
 */
export async function buildServer(
  config: Config,
): Promise<{ server: McpServer; report: ComposeReport }> {
  const session = await discoverSession(config.sessionUrl, config.bearerToken, config.accountId);

  const client = new JmapClient({
    apiUrl: session.apiUrl,
    bearerToken: config.bearerToken,
  });

  // Resolved once, here, and never again: the address books are read at
  // startup so no send pays for them, and so the client can be told about the
  // restriction before it tries to write.
  const recipients = await resolveRecipientScope(config.recipients, session, client);

  // The crossing is resolved before the server exists: instructions ride the
  // initialization response, which is built by the constructor, and they must
  // describe the surface `compose` is about to register.
  const selection = selectTools(ALL_DOMAINS, session, config.policy);

  // Instructions ride the initialization response, so the client learns which
  // mailbox it is on without listing or calling a tool.
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions(session, selection.classes, recipients),
    },
  );

  const report = compose({
    server,
    domains: ALL_DOMAINS,
    session,
    client,
    policy: config.policy,
    recipients,
    bulkConfirmAbove: config.bulkConfirmAbove,
  });

  return { server, report };
}

/**
 * Resolves who this server may write to.
 *
 * Three outcomes, and only three: open, a perimeter that was read, or one that
 * could not be. A failure is never reported as an empty perimeter, and an empty
 * one is never reported as an open one — both refuse, and they say why
 * differently. Nothing is read at all when no restriction was configured.
 */
export async function resolveRecipientScope(
  setting: RecipientsSetting,
  session: JmapSession,
  client: JmapClient,
): Promise<RecipientScope> {
  if (setting.scope === "anyone") return OPEN_SCOPE;

  if (!session.has(CAPABILITY_CONTACTS)) {
    return {
      kind: "unreadable",
      reason: "this JMAP server advertises no contacts capability",
    };
  }

  try {
    const ids = await queryEveryCard(client, session);
    const fromContacts = await readAddresses(client, session, ids);
    return restrictTo({ fromContacts, allow: setting.allow });
  } catch (error) {
    return { kind: "unreadable", reason: (error as Error).message };
  }
}

/**
 * Every card id, page by page. The ceiling is what bounds the loop.
 *
 * The sort is not cosmetic: paging by `position` without one leaves the order
 * to the server, and a card that moves between two pages is never read at all.
 * It would then drop out of the perimeter silently. `created` is one of the two
 * properties Stalwart sorts cards on, and it does not change under our feet.
 */
async function queryEveryCard(client: JmapClient, session: JmapSession): Promise<Id[]> {
  const page = pageSize(session);
  const ids: Id[] = [];

  for (let position = 0; ; position += page) {
    const query: ContactCardQueryArguments = {
      accountId: session.accountId,
      sort: [{ property: "created", isAscending: true }],
      position,
      limit: page,
    };
    const response = await client.request<QueryResponse>(
      [CAPABILITY_CORE, CAPABILITY_CONTACTS],
      ["ContactCard/query", query, "0"],
    );

    ids.push(...response.ids);
    if (ids.length > MAX_SCOPE_CARDS) {
      throw new Error(`this account holds more than ${MAX_SCOPE_CARDS} contact cards`);
    }
    if (response.ids.length < page) return ids;
  }
}

async function readAddresses(
  client: JmapClient,
  session: JmapSession,
  ids: readonly Id[],
): Promise<string[]> {
  const page = pageSize(session);
  const addresses: string[] = [];

  for (let start = 0; start < ids.length; start += page) {
    const get: ContactCardGetArguments = {
      accountId: session.accountId,
      ids: ids.slice(start, start + page),
      properties: ["emails"],
    };
    const response = await client.request<GetResponse<ContactCard>>(
      [CAPABILITY_CORE, CAPABILITY_CONTACTS],
      ["ContactCard/get", get, "0"],
    );

    for (const card of response.list) {
      for (const entry of Object.values(card.emails ?? {})) {
        if (entry.address !== "") addresses.push(entry.address);
      }
    }
  }

  return addresses;
}

/** What the session says it will answer at once, or a conservative default. */
function pageSize(session: JmapSession): number {
  const core = session.raw.capabilities[CAPABILITY_CORE] as Partial<CoreCapability> | undefined;
  const stated = core?.maxObjectsInGet;
  return stated !== undefined && stated > 0 ? stated : DEFAULT_PAGE;
}
