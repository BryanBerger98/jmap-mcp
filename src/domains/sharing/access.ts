import { z } from "zod";
import type {
  GetResponse,
  Invocation,
  QueryResponse,
  ResultReference,
} from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_PRINCIPALS } from "../../jmap/types/core.js";
import type {
  ShareNotification,
  ShareNotificationQueryArguments,
} from "../../jmap/types/sharing.js";
import { SHAREABLE_TYPES } from "../../jmap/types/sharing.js";
import type { ToolContext, ToolResult } from "../../registry/define-tool.js";
import { defineTool } from "../../registry/define-tool.js";
import { MAX_IDS_PER_CALL } from "../../shared/batch.js";
import {
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  fingerprint,
  inRequestedOrder,
  takeWithinBudget,
} from "../../shared/pagination.js";
import type { SharedObject } from "./grant.js";
import { directoryNote, renderNotification, renderSharedObject } from "./grant.js";
import { resolvePrincipals } from "./principal.js";
import { requireCapability, shareTarget } from "./target.js";

/**
 * Who reaches what, in both directions.
 *
 * `object` answers what this account exposes: the beneficiaries written on a
 * folder, a calendar, an address book or a file node. `received` answers the
 * other side: what other accounts have opened to this one, as the server's own
 * notifications report it. Two questions, one surface, because neither writes.
 *
 * No hook of any kind. The ceiling on `ids` is enforced by the schema rather
 * than by a `precheck`, so this stays what the five other delivered reading
 * surfaces are: a tool that asks nothing before it answers.
 *
 * The notification listing sends no sort. The server parses a `created`
 * comparator and never applies it, answering out of a change-log scan, so asking
 * for an order would mean claiming one the response does not have.
 */

/** The properties a notification is read for, `name` excluded: it routes to `changedBy/name`. */
const NOTIFICATION_PROPERTIES = [
  "id",
  "created",
  "changedBy",
  "objectType",
  "objectAccountId",
  "objectId",
  "oldRights",
  "newRights",
] as const;

/** `queryMaxResults` defaults to 5000 and is advertised nowhere: always send a limit. */
const MAX_LIMIT = 100;

/**
 * How much rendered text one page of notifications may spend.
 *
 * A notification runs several lines — the header, then one line per direction
 * the rights moved — so the budget is the one the mail listing uses for blocks
 * rather than the one file rows get.
 */
const RESULT_BUDGET_CHARS = 4000;

/** No filter and no sort, so every page of this listing runs on the same criteria. */
const RECEIVED_CRITERIA = fingerprint({ action: "received" });

const inputSchema = z
  .strictObject({
    action: z
      .enum(["object", "received"])
      .describe(
        "What to read: `object` lists who this account has given access to a folder, calendar, " +
          "address book or file node; `received` lists the changes other accounts made to what " +
          "this account may reach in theirs.",
      ),
    objectType: z
      .enum([...SHAREABLE_TYPES])
      .optional()
      .describe("On object, which kind of object the ids name. Required on object."),
    ids: z
      .array(z.string())
      .min(1)
      .max(MAX_IDS_PER_CALL)
      .optional()
      .describe(
        `On object, the ids to read, at most ${MAX_IDS_PER_CALL} per call. Required on object.`,
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`On received, notifications to fetch, ${DEFAULT_PAGE_SIZE} by default.`),
    cursor: z.string().optional().describe("On received, the cursor a previous page returned."),
  })
  .refine((input) => input.action !== "object" || input.objectType !== undefined, {
    message: "Name the kind of object with `objectType`.",
    path: ["objectType"],
  })
  .refine((input) => input.action !== "object" || input.ids !== undefined, {
    message: "Name the objects to read with `ids`.",
    path: ["ids"],
  });

export const sharingAccess = defineTool({
  name: "sharing_access",
  title: "Read sharing",
  description:
    "Reads who has access to what. With `object`, it lists the accounts this account has shared a " +
    "folder, calendar, address book or file node with, and exactly which rights each of them " +
    "holds — the rights differ by kind of object and are never translated into a common set. " +
    "With `received`, it lists what other accounts have opened or closed towards this one, most " +
    "recent first, saying who changed it and which rights moved. " +
    "It never changes a share: sharing_manage does that. " +
    "An object nobody reaches is reported as such, in words. When the server refuses to name " +
    "accounts, beneficiaries appear as raw ids and the answer says why.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: (input) =>
    input.action === "object"
      ? `List who has access to ${input.ids?.length ?? 0} ${input.objectType ?? "object"}(s).`
      : "List the sharing changes other accounts made towards this one.",
  run: async (input, context) => {
    return input.action === "object" ? readObjects(input, context) : readReceived(input, context);
  },
});

type Input = z.infer<typeof inputSchema>;

/** What this account exposes, for the ids the call names. */
async function readObjects(input: Input, context: ToolContext): Promise<ToolResult> {
  const { client, session } = context;
  const { objectType, ids } = input;

  // Restated rather than trusted: the refinements above type the call, not the
  // fields, and this handler is reachable from a contract test that parses first.
  if (objectType === undefined || ids === undefined) {
    return { text: "Refused: name both `objectType` and `ids` to read the sharing of an object." };
  }

  const missing = requireCapability(objectType, session);
  if (missing !== undefined) return { text: `Refused: ${missing}` };

  const target = shareTarget(objectType);
  const response = await client.request<GetResponse<SharedObject>>(
    [CAPABILITY_CORE, CAPABILITY_PRINCIPALS, target.capability],
    [
      target.getMethod,
      {
        accountId: session.accountId,
        ids: [...ids],
        properties: [...target.properties],
      },
      "0",
    ],
  );

  const objects = inRequestedOrder([...ids], response.list);
  const beneficiaries = objects.flatMap((object) => Object.keys(object.shareWith ?? {}));
  const directory = await resolvePrincipals(beneficiaries, context);

  const blocks = objects.map((object) => renderSharedObject(objectType, object, directory));
  const header = `${objects.length} ${target.noun}(s) read, ${objectType} rights.`;
  // Named rather than counted: an id the account does not hold is a mistake the
  // caller can act on, and the objects that were found are rendered regardless.
  const notFound =
    response.notFound.length === 0
      ? undefined
      : `Not found in this account: ${response.notFound.join(", ")}.`;

  const lines = [header, notFound, directoryNote(directory)];
  if (blocks.length > 0) lines.push("", blocks.join("\n\n"));

  return { text: lines.filter((line) => line !== undefined).join("\n") };
}

/** What other accounts opened or closed towards this one. */
async function readReceived(input: Input, context: ToolContext): Promise<ToolResult> {
  const { client, session } = context;

  const resumed = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && resumed === undefined) {
    return {
      text: "Refused: that cursor is unreadable. List the notifications again from the start.",
    };
  }
  // This listing runs on no criteria at all, so a fingerprint that does not match
  // came from another listing entirely and its position means nothing here.
  if (resumed !== undefined && resumed.criteriaFingerprint !== RECEIVED_CRITERIA) {
    return {
      text:
        "Refused: that cursor was issued by another listing, so its position points into a " +
        "different result set. List the notifications again from the start.",
    };
  }

  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const position = resumed?.position ?? 0;

  // No `sort`: the server scans its change log in descending order whatever a
  // comparator says, so naming one would promise an order it does not honour.
  const queryArguments: ShareNotificationQueryArguments = {
    accountId: session.accountId,
    position,
    limit,
    calculateTotal: true,
  };

  const idsFromQuery: ResultReference = {
    resultOf: "0",
    name: "ShareNotification/query",
    path: "/ids",
  };

  const calls: Invocation[] = [
    ["ShareNotification/query", queryArguments, "0"],
    [
      "ShareNotification/get",
      {
        accountId: session.accountId,
        "#ids": idsFromQuery,
        properties: [...NOTIFICATION_PROPERTIES],
      },
      "1",
    ],
  ];

  const [query, fetched] = await client.requestMany<
    [QueryResponse, GetResponse<ShareNotification>]
  >([CAPABILITY_CORE, CAPABILITY_PRINCIPALS], calls);

  if (resumed !== undefined && resumed.queryState !== query.queryState) {
    return {
      text:
        "Refused: new sharing changes arrived since that cursor was issued, so the next page would " +
        "skip or repeat notifications. List them again from the start.",
    };
  }

  const notifications = inRequestedOrder(query.ids, fetched.list);
  const authors = notifications
    .map((notification) => notification.changedBy?.principalId)
    .filter((id): id is string => id !== undefined);
  const directory = await resolvePrincipals(authors, context);

  const { taken, remaining } = takeWithinBudget(
    notifications,
    (notification) => renderNotification(notification, directory),
    RESULT_BUDGET_CHARS,
  );

  const count =
    query.total === undefined
      ? `${taken.length} sharing change(s) shown.`
      : `${query.total} sharing change(s), ${taken.length} shown from position ${position}.`;

  const header = `${count} Most recent first; the server offers no other order.`;
  const blocks =
    taken.length === 0
      ? "No other account has changed what this one may reach."
      : taken.map((notification) => renderNotification(notification, directory)).join("\n\n");

  const text = [header, directoryNote(directory), "", blocks]
    .filter((line) => line !== undefined)
    .join("\n");

  const reachedTotal = query.total !== undefined && position + taken.length >= query.total;
  const exhausted = remaining === 0 && (query.ids.length < limit || reachedTotal);
  if (exhausted) return { text };

  return {
    text,
    nextCursor: encodeCursor({
      position: position + taken.length,
      queryState: query.queryState,
      criteriaFingerprint: RECEIVED_CRITERIA,
    }),
  };
}
