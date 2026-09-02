import { z } from "zod";
import { JmapMethodError } from "../../jmap/errors.js";
import type { GetResponse, Id, QueryResponse, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_PRINCIPALS } from "../../jmap/types/core.js";
import type { PrincipalQueryArguments, ShareableType } from "../../jmap/types/sharing.js";
import { SHAREABLE_TYPES } from "../../jmap/types/sharing.js";
import type { ToolContext } from "../../registry/define-tool.js";
import { defineTool } from "../../registry/define-tool.js";
import { refuseOversizedBatch } from "../../shared/batch.js";
import { inRequestedOrder } from "../../shared/pagination.js";
import {
  buildSharePatch,
  describeShareOutcome,
  refuseOverlappingPaths,
  SHARE_NOTIFICATIONS,
  SHARED_OBJECTS,
  shareSetArguments,
  shareSetMethod,
} from "./edit.js";
import type { SharedObject } from "./grant.js";
import { resolvePrincipals } from "./principal.js";
import { linkedRightsNote, refuseUnknownRights, rightLabel } from "./rights.js";
import { displayNameOf, requireCapability, shareTarget } from "./target.js";

/**
 * Opening an access, taking one back, and discarding the record of someone
 * else's.
 *
 * This is the one write in the project whose undoing does not restore the state
 * before it. A message moved back to its folder is where it was; a revoked access
 * is not: whatever was read while it was open has been read, and nothing here
 * recalls it. That sentence goes in the confirmation, because it is the fact the
 * person arbitrating is missing.
 *
 * The class is read off the action and never off the name. `grant` is a `send`:
 * it hands something to another account, and the server may raise a notification
 * in theirs. `revoke` and `dismiss` are `destroy` — one takes an access away, the
 * other takes away the only record that an access ever moved.
 *
 * `precheck` refuses before it asks, in that order: the batch ceiling, the
 * capability, the rights vocabulary, the beneficiary, then `myRights.mayShare` on
 * the objects themselves. A call the server would refuse whatever the answer is
 * must not be put to the user as a question.
 */

const inputSchema = z
  .strictObject({
    action: z
      .enum(["grant", "revoke", "dismiss"])
      .describe(
        "What to do: `grant` opens rights on objects to another account, `revoke` takes rights " +
          "back, `dismiss` discards notifications about shares other accounts changed.",
      ),
    objectType: z
      .enum([...SHAREABLE_TYPES])
      .optional()
      .describe(
        "On grant and revoke, which kind of object the ids name. Rights are type-specific and " +
          "never translated between types. Required on grant and revoke.",
      ),
    ids: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        "On grant and revoke, the object ids to change, exactly as sharing_access returned them. " +
          "Required on grant and revoke.",
      ),
    beneficiary: z
      .string()
      .optional()
      .describe(
        "On grant and revoke, who the access is for: an account address, or a principal id as " +
          "sharing_access renders it. An address is looked up whole, never as a fragment. " +
          "Required on grant and revoke.",
      ),
    rights: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        "The rights to open or close, in the vocabulary of `objectType`. Required on grant. On " +
          "revoke it is optional: left out, the beneficiary is removed from the object entirely.",
      ),
    notificationIds: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        "On dismiss, the notification ids to discard, as sharing_access `received` returned them. " +
          "Required on dismiss, and the only field dismiss accepts.",
      ),
  })
  .refine((input) => input.action === "dismiss" || input.objectType !== undefined, {
    message: "Name the kind of object with `objectType`.",
    path: ["objectType"],
  })
  .refine((input) => input.action === "dismiss" || input.ids !== undefined, {
    message: "Name the objects to change with `ids`.",
    path: ["ids"],
  })
  .refine((input) => input.action === "dismiss" || input.beneficiary !== undefined, {
    message: "Name who the access is for with `beneficiary`.",
    path: ["beneficiary"],
  })
  // Required on a grant and optional on a revoke, and the asymmetry is the whole
  // design: a grant with no right named would open nothing, while a revoke with
  // none named closes everything, which is a decision rather than a mistake.
  .refine((input) => input.action !== "grant" || input.rights !== undefined, {
    message: "Name the rights to open with `rights`.",
    path: ["rights"],
  })
  .refine((input) => input.action !== "dismiss" || input.notificationIds !== undefined, {
    message: "Name the notifications to discard with `notificationIds`.",
    path: ["notificationIds"],
  })
  .refine(
    (input) =>
      input.action !== "dismiss" ||
      (input.objectType === undefined &&
        input.ids === undefined &&
        input.beneficiary === undefined &&
        input.rights === undefined),
    {
      message: "Dismissing a notification takes `notificationIds` alone: it touches no object.",
      path: ["notificationIds"],
    },
  );

export const sharingManage = defineTool({
  name: "sharing_manage",
  title: "Change sharing",
  description:
    "Opens or closes another account's access to a folder, calendar, address book or file node, " +
    "and discards the notifications that report someone else's changes. " +
    "Rights belong to the kind of object: a calendar has none of a folder's, and a name the type " +
    "does not know is refused here rather than silently ignored by the server. " +
    "It never writes the sharing map whole, so accounts this call does not name keep the access " +
    "they have. Revoking does not recall what has already been read. " +
    "It acts on ids only — run sharing_access and pass the ids it returned.",
  inputSchema,
  classes: ["send", "destroy"],
  // On the action, never on the name: opening an access hands something to
  // another account, closing one takes it away, and discarding a notification
  // erases the only trace that either happened.
  classify: (input) => (input.action === "grant" ? "send" : "destroy"),
  summarize: async (input, context) => {
    if (input.action === "dismiss") {
      const count = input.notificationIds?.length ?? 0;

      return (
        `Discard ${count} sharing notification(s). What disappears is the record that another ` +
        "account changed what this one may reach, not the access itself: nothing is opened or " +
        "closed by this, and the notification cannot be listed again afterwards."
      );
    }

    const { objectType, beneficiary } = input;
    const ids = input.ids ?? [];
    if (objectType === undefined || beneficiary === undefined) {
      return "Change the sharing of an object.";
    }

    const who = await describeBeneficiary(beneficiary, context);
    const what = await describeObjects(objectType, ids, context);
    const rights = input.rights ?? [];
    const labelled = rights.map((right) => rightLabel(objectType, right));

    const headline =
      input.action === "grant"
        ? `Give ${who} access to ${what}: ${labelled.join("; ")}.`
        : rights.length === 0
          ? `Remove ${who} from ${what} entirely: every right they hold there goes at once.`
          : `Take back from ${who} on ${what}: ${labelled.join("; ")}.`;

    const lines = [headline, linkedRightsNote(objectType, rights)];

    if (input.action === "revoke") {
      // The one sentence this tool exists to say. Every other write in this
      // project can be undone into the state it found; this one cannot.
      lines.push(
        "Closing an access does not recall what was read through it: anything they opened while " +
          "it was granted, they still have.",
      );
    }

    return lines.filter((line) => line !== undefined).join(" ");
  },
  precheck: async (input, context) => {
    if (input.action === "dismiss") {
      // Nothing else to check: the server opposes no condition to discarding a
      // notification, and there are no rights to read on one.
      return refuseOversizedBatch(input.notificationIds ?? [], SHARE_NOTIFICATIONS);
    }

    // The ceiling first, before any read: fifty-one ids are refused whatever
    // they point at, and reading them would spend a round trip to say so.
    const oversized = refuseOversizedBatch(input.ids ?? [], SHARED_OBJECTS);
    if (oversized !== undefined) return oversized;

    const { objectType, beneficiary } = input;
    const ids = input.ids ?? [];
    if (objectType === undefined || beneficiary === undefined) {
      return "Refused: name both `objectType` and `beneficiary` to change a share.";
    }

    const missing = requireCapability(objectType, context.session);
    if (missing !== undefined) return `Refused: ${missing}`;

    const rights = input.rights ?? [];
    const unknown = refuseUnknownRights(objectType, rights);
    if (unknown !== undefined) return `Refused: ${unknown}`;

    const resolved = await resolveBeneficiary(beneficiary, context);
    if (!resolved.ok) return resolved.refusal;

    const overlapping = refuseOverlappingPaths(
      buildSharePatch(input.action, resolved.principalId, rights),
    );
    if (overlapping !== undefined) return overlapping;

    return refuseUnshareable(objectType, ids, context);
  },
  run: async (input, context) => {
    if (input.action === "dismiss") {
      const ids = input.notificationIds ?? [];

      const response = await context.client.request<SetResponse<unknown>>(
        [CAPABILITY_CORE, CAPABILITY_PRINCIPALS],
        // `destroy` alone. An `update` riding along would change a notification
        // under a confirmation that spoke about discarding one, and a `create`
        // would invent a change nobody made.
        ["ShareNotification/set", { accountId: context.session.accountId, destroy: [...ids] }, "0"],
      );

      return {
        text: describeShareOutcome(response, ids, "sharing notification", "discarded", "destroyed"),
      };
    }

    const { objectType, beneficiary } = input;
    const ids = input.ids ?? [];
    if (objectType === undefined || beneficiary === undefined) {
      return { text: "Refused: name both `objectType` and `beneficiary` to change a share." };
    }

    const resolved = await resolveBeneficiary(beneficiary, context);
    if (!resolved.ok) return { text: resolved.refusal };

    const patch = buildSharePatch(input.action, resolved.principalId, input.rights ?? []);
    const overlapping = refuseOverlappingPaths(patch);
    if (overlapping !== undefined) return { text: overlapping };

    // The same patch on each id, and the patch names one beneficiary: the
    // accounts this call never mentioned are not in the request at all.
    const update = Object.fromEntries(ids.map((id) => [id, patch]));
    const target = shareTarget(objectType);

    const response = await context.client.request<SetResponse<unknown>>(
      [CAPABILITY_CORE, CAPABILITY_PRINCIPALS, target.capability],
      [
        shareSetMethod(objectType),
        shareSetArguments(objectType, context.session.accountId, update),
        "0",
      ],
    );

    return {
      text: describeShareOutcome(
        response,
        ids,
        target.noun,
        input.action === "grant" ? "granted" : "revoked",
      ),
    };
  },
});

/** Who a call names, once the directory has had its say. */
type Beneficiary = { ok: true; principalId: Id; label: string } | { ok: false; refusal: string };

/**
 * The principal a `beneficiary` argument means, read once per invocation.
 *
 * Two forms, told apart by the `@`. An id goes through untouched: it is what the
 * patch is written in, and `sharing_access` hands them out, so a caller passing
 * one has already read it off this server. An address has to be looked up, and
 * the lookup is exact — the server matches a whole login, so a fragment finds
 * nothing rather than a shortlist.
 *
 * A closed directory refuses the address form and only that one. Guessing an id
 * from an address is not something a refusal entitles anyone to do, and the way
 * out is the id itself, which the refusal says.
 */
function resolveBeneficiary(input: string, context: ToolContext): Promise<Beneficiary> {
  return context.once(`sharing:beneficiary:${input}`, async () => {
    if (!input.includes("@")) {
      // Named for the sentence, not for the patch: a directory that will not
      // answer leaves the id, which is still exactly what gets written.
      const directory = await resolvePrincipals([input], context);
      return { ok: true, principalId: input, label: directory.nameOf(input) };
    }

    const args: PrincipalQueryArguments = {
      accountId: context.session.accountId,
      filter: { email: input },
      // Two, so "several" is distinguishable from "one": the server answers a
      // list, and a limit of one would hide an ambiguity rather than raise it.
      limit: 2,
      calculateTotal: false,
    };

    let response: QueryResponse;
    try {
      response = await context.client.request<QueryResponse>(
        [CAPABILITY_CORE, CAPABILITY_PRINCIPALS],
        ["Principal/query", args, "0"],
      );
    } catch (error) {
      if (error instanceof JmapMethodError && error.type === "forbidden") {
        return {
          ok: false,
          refusal:
            `Refused: the server will not look ${input} up. This instance has directory queries ` +
            "disabled and does not grant the account permission to search principals, so an " +
            "address cannot become an id here. Pass the principal id instead, as sharing_access " +
            "renders it.",
        };
      }
      throw error;
    }

    const [principalId, second] = response.ids;
    if (principalId === undefined) {
      return {
        ok: false,
        refusal:
          `Refused: no account on this server is called ${input}. The lookup matches a whole ` +
          "login, never part of one, so check the address or pass the principal id.",
      };
    }
    if (second !== undefined) {
      return {
        ok: false,
        refusal:
          `Refused: ${input} matches more than one account on this server, and picking one would ` +
          "be picking for you. Pass the principal id of the account you mean.",
      };
    }

    const directory = await resolvePrincipals([principalId], context);
    return { ok: true, principalId, label: directory.nameOf(principalId) };
  });
}

/** The beneficiary as a sentence names them: an address when known, the id otherwise. */
async function describeBeneficiary(input: string, context: ToolContext): Promise<string> {
  const resolved = await resolveBeneficiary(input, context);
  return resolved.ok ? resolved.label : input;
}

/** What a set of ids holds, read once per invocation and used by two hooks. */
interface Targets {
  objects: SharedObject[];
  notFound: Id[];
  /** Set by anything that stopped the read: a refusal, not an empty result. */
  unreadable: boolean;
}

function readTargets(
  type: ShareableType,
  ids: readonly Id[],
  context: ToolContext,
): Promise<Targets> {
  return context.once(`sharing:targets:${type}:${[...ids].sort().join(",")}`, async () => {
    const target = shareTarget(type);

    try {
      const response = await context.client.request<GetResponse<SharedObject>>(
        [CAPABILITY_CORE, CAPABILITY_PRINCIPALS, target.capability],
        [
          target.getMethod,
          {
            accountId: context.session.accountId,
            ids: [...ids],
            properties: [...target.properties],
          },
          "0",
        ],
      );

      return {
        objects: inRequestedOrder([...ids], response.list),
        notFound: response.notFound,
        unreadable: false,
      };
    } catch {
      return { objects: [], notFound: [], unreadable: true };
    }
  });
}

/**
 * The refusal the objects themselves earn, or nothing.
 *
 * `mayShare` is the right to change who reaches an object, and an account that
 * lacks it gets its call refused by the server. Reading it first turns that into
 * a refusal naming the object, before the question is put to anyone: confirming a
 * share that cannot land wastes a decision, not a round trip.
 *
 * A read that failed refuses too, and so does a `myRights` the response did not
 * carry. Absence is not permission.
 */
async function refuseUnshareable(
  type: ShareableType,
  ids: readonly Id[],
  context: ToolContext,
): Promise<string | undefined> {
  const { noun } = shareTarget(type);
  const targets = await readTargets(type, ids, context);

  if (targets.unreadable) {
    return (
      `Refused: the sharing of these ${noun}(s) could not be read, so whether this account may ` +
      "change it is unknown. Run sharing_access to check, then call again. Nothing was written."
    );
  }

  if (targets.notFound.length > 0) {
    return (
      `Refused: this account holds no ${noun} with id ${targets.notFound.join(", ")}. ` +
      "Run sharing_access to get the ids, then call again. Nothing was written."
    );
  }

  const blocked = targets.objects.filter((object) => object.myRights?.mayShare !== true);
  if (blocked.length === 0) return undefined;

  const named = blocked.map((object) => {
    const name = displayNameOf(type, object as unknown as Readonly<Record<string, unknown>>);
    return name === undefined ? object.id : `"${name}" (${object.id})`;
  });

  return (
    `Refused: mayShare is not granted to this account on ${named.join(", ")}, so the server would ` +
    `refuse a change to the sharing of ${blocked.length === 1 ? "it" : "them"}. The account can ` +
    "read who reaches them, and not decide it."
  );
}

/** The objects as the confirmation names them: display names when the read carried any. */
async function describeObjects(
  type: ShareableType,
  ids: readonly Id[],
  context: ToolContext,
): Promise<string> {
  const { noun } = shareTarget(type);
  const targets = await readTargets(type, ids, context);

  const named = targets.objects.map((object) => {
    const name = displayNameOf(type, object as unknown as Readonly<Record<string, unknown>>);
    return name === undefined ? object.id : `"${name}" (${object.id})`;
  });

  // The ids themselves when the read carried no name: a count on its own would
  // let a confirmation cover objects the reader never identified.
  const list = named.length === 0 ? [...ids].join(", ") : named.join(", ");

  return `${ids.length} ${noun}(s): ${list}`;
}
