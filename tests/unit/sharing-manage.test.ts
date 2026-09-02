import { describe, expect, it } from "vitest";
import {
  buildSharePatch,
  describeShareOutcome,
  refuseOverlappingPaths,
  shareSetArguments,
} from "../../src/domains/sharing/edit.js";
import { sharingManage } from "../../src/domains/sharing/manage.js";
import type { Id, SetError, SetResponse } from "../../src/jmap/types/core.js";
import { MAX_IDS_PER_CALL } from "../../src/shared/batch.js";
import {
  fullySharingSession,
  methodsOf,
  objectGet,
  PRINCIPAL_IDS,
  SHARED_BOOK,
  SHARED_CALENDAR,
  SHARED_MAILBOX,
  scriptedSharing,
  sharingScript,
  UNSHAREABLE_MAILBOX,
} from "../fixtures/sharing.js";

/**
 * The pure halves of `sharing_manage`: the patch it builds, the sentence it puts
 * to the user, and what it makes of the server's per-id answer.
 *
 * The guarantees that need a registry around them — no write before a
 * confirmation, no execution without elicitation — are held by
 * `tests/contract/sharing-write-guard.test.ts`. What is here runs the hooks
 * directly, which is the only way to read a refusal string rather than an
 * error result wrapping it.
 */

/** The tool's own parse, so no test runs on arguments the schema refuses. */
function parse(input: Record<string, unknown>) {
  return sharingManage.inputSchema.parse(input) as Parameters<typeof sharingManage.run>[0];
}

/** A context whose session advertises all four types, on the happy-path script. */
function surface(script = sharingScript()) {
  return scriptedSharing(script, fullySharingSession());
}

async function summarize(input: Record<string, unknown>, script = sharingScript()) {
  const { context, requests } = surface(script);
  return { text: await sharingManage.summarize(parse(input), context), requests };
}

async function precheck(input: Record<string, unknown>, script = sharingScript()) {
  const { context, requests } = surface(script);
  return { refusal: await sharingManage.precheck?.(parse(input), context), requests };
}

describe("the schema and the class", () => {
  it("classifies on the action and never on the name", () => {
    expect(sharingManage.classes).toEqual(["send", "destroy"]);
    expect(
      sharingManage.classify(
        parse({
          action: "grant",
          objectType: "Mailbox",
          ids: ["mb-1"],
          beneficiary: PRINCIPAL_IDS.bob,
          rights: ["mayReadItems"],
        }),
      ),
    ).toBe("send");
    expect(
      sharingManage.classify(
        parse({
          action: "revoke",
          objectType: "Mailbox",
          ids: ["mb-1"],
          beneficiary: PRINCIPAL_IDS.bob,
        }),
      ),
    ).toBe("destroy");
    expect(sharingManage.classify(parse({ action: "dismiss", notificationIds: ["sn-1"] }))).toBe(
      "destroy",
    );
  });

  it("takes no search criterion: a filter is not a field it has", () => {
    for (const criterion of ["filter", "query", "text", "search", "position", "cursor"]) {
      const refused = sharingManage.inputSchema.safeParse({
        action: "revoke",
        objectType: "Mailbox",
        ids: ["mb-1"],
        beneficiary: PRINCIPAL_IDS.bob,
        [criterion]: "anything",
      });

      expect(refused.success).toBe(false);
    }
  });

  it("asks for rights on a grant, and leaves them optional on a revoke", () => {
    const grant = {
      action: "grant",
      objectType: "Mailbox",
      ids: ["mb-1"],
      beneficiary: PRINCIPAL_IDS.bob,
    };

    expect(sharingManage.inputSchema.safeParse(grant).success).toBe(false);
    expect(
      sharingManage.inputSchema.safeParse({ ...grant, rights: ["mayReadItems"] }).success,
    ).toBe(true);
    expect(sharingManage.inputSchema.safeParse({ ...grant, action: "revoke" }).success).toBe(true);
  });

  it("lets dismiss carry notifications and nothing else", () => {
    expect(sharingManage.inputSchema.safeParse({ action: "dismiss" }).success).toBe(false);
    expect(
      sharingManage.inputSchema.safeParse({ action: "dismiss", notificationIds: ["sn-1"] }).success,
    ).toBe(true);
    expect(
      sharingManage.inputSchema.safeParse({
        action: "dismiss",
        notificationIds: ["sn-1"],
        objectType: "Mailbox",
      }).success,
    ).toBe(false);
  });
});

describe("the patch a call builds", () => {
  it("opens one path per named right, and touches no other beneficiary", () => {
    const patch = buildSharePatch("grant", PRINCIPAL_IDS.bob, ["mayReadItems", "mayAddItems"]);

    expect(patch).toEqual({
      [`shareWith/${PRINCIPAL_IDS.bob}/mayReadItems`]: true,
      [`shareWith/${PRINCIPAL_IDS.bob}/mayAddItems`]: true,
    });
    expect(Object.keys(patch).some((key) => key.includes(PRINCIPAL_IDS.alice))).toBe(false);
  });

  it("closes one path per named right, leaving the rest of the entry alone", () => {
    expect(buildSharePatch("revoke", PRINCIPAL_IDS.alice, ["maySetSeen"])).toEqual({
      [`shareWith/${PRINCIPAL_IDS.alice}/maySetSeen`]: false,
    });
  });

  it("drops the whole entry when a revoke names no right", () => {
    // Not an empty revocation: naming nothing is the decision to close the door.
    expect(buildSharePatch("revoke", PRINCIPAL_IDS.alice, [])).toEqual({
      [`shareWith/${PRINCIPAL_IDS.alice}`]: null,
    });
  });

  it("never writes the sharing map itself, in either direction", () => {
    for (const action of ["grant", "revoke"] as const) {
      const patch = buildSharePatch(action, PRINCIPAL_IDS.bob, ["mayReadItems"]);
      expect(Object.keys(patch)).not.toContain("shareWith");
    }
  });

  it("refuses a path and its own prefix in one call", () => {
    const refusal = refuseOverlappingPaths({
      [`shareWith/${PRINCIPAL_IDS.bob}`]: null,
      [`shareWith/${PRINCIPAL_IDS.bob}/mayReadItems`]: true,
    });

    expect(refusal).toContain("§5.3");
    // Neither builder can produce one, which is exactly what this asserts.
    expect(
      refuseOverlappingPaths(buildSharePatch("grant", PRINCIPAL_IDS.bob, ["mayReadItems"])),
    ).toBeUndefined();
    expect(
      refuseOverlappingPaths(buildSharePatch("revoke", PRINCIPAL_IDS.bob, [])),
    ).toBeUndefined();
  });
});

describe("the arguments of an emitted set", () => {
  const update = { "mb-1": { [`shareWith/${PRINCIPAL_IDS.bob}/mayReadItems`]: true } };

  it("carries an update and the type's own cascade flag, false", () => {
    expect(shareSetArguments("Mailbox", "acc-1", update)).toEqual({
      accountId: "acc-1",
      update,
      onDestroyRemoveEmails: false,
    });
    expect(shareSetArguments("Calendar", "acc-1", update)).toEqual({
      accountId: "acc-1",
      update,
      onDestroyRemoveEvents: false,
    });
    expect(shareSetArguments("AddressBook", "acc-1", update)).toEqual({
      accountId: "acc-1",
      update,
      onDestroyRemoveContents: false,
    });
    expect(shareSetArguments("FileNode", "acc-1", update)).toEqual({
      accountId: "acc-1",
      update,
      onDestroyRemoveChildren: false,
      onExists: null,
    });
  });

  it("brings nothing into being and takes nothing away, on all four types", () => {
    for (const type of ["Mailbox", "Calendar", "AddressBook", "FileNode"] as const) {
      const args = shareSetArguments(type, "acc-1", update);
      expect(args).not.toHaveProperty("create");
      expect(args).not.toHaveProperty("destroy");
    }
  });
});

describe("the sentence put to the user", () => {
  it("names the beneficiary, the object and the rights in clear words", async () => {
    const { text } = await summarize({
      action: "grant",
      objectType: "Calendar",
      ids: [SHARED_CALENDAR.id],
      beneficiary: PRINCIPAL_IDS.team,
      rights: ["mayReadItems"],
    });

    expect(text).toContain("team@example.com");
    expect(text).toContain(`"Team" (${SHARED_CALENDAR.id})`);
    // The property name never stands alone in a sentence someone arbitrates on.
    expect(text).toContain("mayReadItems — read its events in full");
  });

  it("speaks each type in its own noun and its own vocabulary", async () => {
    const folder = await summarize({
      action: "grant",
      objectType: "Mailbox",
      ids: [SHARED_MAILBOX.id],
      beneficiary: PRINCIPAL_IDS.bob,
      rights: ["mayReadItems"],
    });
    const book = await summarize({
      action: "grant",
      objectType: "AddressBook",
      ids: [SHARED_BOOK.id],
      beneficiary: PRINCIPAL_IDS.bob,
      rights: ["mayRead"],
    });

    expect(folder.text).toContain("read the messages it holds");
    expect(book.text).toContain("read the cards it holds");
    expect(book.text).not.toContain("read the messages it holds");
  });

  it("says a whole removal is whole, and a right taken back is only that", async () => {
    const whole = await summarize({
      action: "revoke",
      objectType: "Mailbox",
      ids: [SHARED_MAILBOX.id],
      beneficiary: PRINCIPAL_IDS.alice,
    });
    const single = await summarize({
      action: "revoke",
      objectType: "Mailbox",
      ids: [SHARED_MAILBOX.id],
      beneficiary: PRINCIPAL_IDS.alice,
      rights: ["mayAddItems"],
    });

    expect(whole.text).toContain("entirely");
    expect(single.text).not.toContain("entirely");
    expect(single.text).toContain("mayAddItems — put messages into it");
  });

  it("says that closing an access recalls nothing, and says it on revokes alone", async () => {
    const revoke = await summarize({
      action: "revoke",
      objectType: "Mailbox",
      ids: [SHARED_MAILBOX.id],
      beneficiary: PRINCIPAL_IDS.alice,
      rights: ["mayReadItems"],
    });
    const grant = await summarize({
      action: "grant",
      objectType: "Mailbox",
      ids: [SHARED_MAILBOX.id],
      beneficiary: PRINCIPAL_IDS.bob,
      rights: ["mayReadItems"],
    });

    expect(revoke.text).toContain("does not recall what was read through it");
    expect(grant.text).not.toContain("does not recall");
  });

  it("raises the two linked-right notes, and raises them on nothing else", async () => {
    const seen = await summarize({
      action: "grant",
      objectType: "Mailbox",
      ids: [SHARED_MAILBOX.id],
      beneficiary: PRINCIPAL_IDS.bob,
      rights: ["maySetSeen"],
    });
    const calendarDelete = await summarize({
      action: "revoke",
      objectType: "Calendar",
      ids: [SHARED_CALENDAR.id],
      beneficiary: PRINCIPAL_IDS.team,
      rights: ["mayDelete"],
    });
    const plain = await summarize({
      action: "grant",
      objectType: "Mailbox",
      ids: [SHARED_MAILBOX.id],
      beneficiary: PRINCIPAL_IDS.bob,
      rights: ["mayReadItems"],
    });

    expect(seen.text).toContain("same permission on this server");
    expect(calendarDelete.text).toContain("mayWriteAll covers the permission behind mayDelete");
    expect(plain.text).not.toContain("same permission on this server");
    expect(plain.text).not.toContain("mayWriteAll covers");
  });

  it("says a dismissal touches the record and not the access", async () => {
    const { text, requests } = await summarize({
      action: "dismiss",
      notificationIds: ["sn-1", "sn-2"],
    });

    expect(text).toContain("2 sharing notification(s)");
    expect(text).toContain("not the access itself");
    // Nothing to read: a notification opposes no condition to being discarded.
    expect(methodsOf(requests)).toEqual([]);
  });

  it("falls back to the id when the directory will not name the beneficiary", async () => {
    const { text } = await summarize(
      {
        action: "grant",
        objectType: "Mailbox",
        ids: [SHARED_MAILBOX.id],
        beneficiary: PRINCIPAL_IDS.bob,
        rights: ["mayReadItems"],
      },
      sharingScript({ "Principal/get": ["error", { type: "forbidden" }] }),
    );

    expect(text).toContain(PRINCIPAL_IDS.bob);
  });
});

describe("what precheck refuses before it asks", () => {
  it("refuses one id past the ceiling, before any read", async () => {
    const ids = Array.from({ length: MAX_IDS_PER_CALL + 1 }, (_, index) => `mb-${index}`);
    const { refusal, requests } = await precheck({
      action: "revoke",
      objectType: "Mailbox",
      ids,
      beneficiary: PRINCIPAL_IDS.bob,
    });

    expect(refusal).toContain(`batches of ${MAX_IDS_PER_CALL}`);
    expect(requests).toEqual([]);
  });

  it("refuses a notification batch past the same ceiling", async () => {
    const notificationIds = Array.from({ length: MAX_IDS_PER_CALL + 1 }, (_, i) => `sn-${i}`);
    const { refusal, requests } = await precheck({ action: "dismiss", notificationIds });

    expect(refusal).toContain(`batches of ${MAX_IDS_PER_CALL}`);
    expect(requests).toEqual([]);
  });

  it("refuses a right the type does not know, before any call", async () => {
    // A real right, just not one an address book has: the server would ignore it
    // written false, and a typo would look exactly like a grant that worked.
    const { refusal, requests } = await precheck({
      action: "grant",
      objectType: "AddressBook",
      ids: [SHARED_BOOK.id],
      beneficiary: PRINCIPAL_IDS.bob,
      rights: ["mayWriteAll"],
    });

    expect(refusal).toContain("AddressBook has no right named mayWriteAll");
    expect(requests).toEqual([]);
  });

  it("refuses a type the server does not advertise, naming the capability", async () => {
    const { context, requests } = scriptedSharing();
    const refusal = await sharingManage.precheck?.(
      parse({
        action: "grant",
        objectType: "FileNode",
        ids: ["fn-1"],
        beneficiary: PRINCIPAL_IDS.bob,
        rights: ["mayRead"],
      }),
      context,
    );

    expect(refusal).toContain("urn:ietf:params:jmap:filenode");
    expect(requests).toEqual([]);
  });

  it("refuses when mayShare is not granted, naming the object", async () => {
    const { refusal } = await precheck(
      {
        action: "grant",
        objectType: "Mailbox",
        ids: [UNSHAREABLE_MAILBOX.id],
        beneficiary: PRINCIPAL_IDS.bob,
        rights: ["mayReadItems"],
      },
      sharingScript({ "Mailbox/get": ["Mailbox/get", objectGet([UNSHAREABLE_MAILBOX]) as never] }),
    );

    expect(refusal).toContain("mayShare is not granted");
    expect(refusal).toContain(`"Received" (${UNSHAREABLE_MAILBOX.id})`);
  });

  it("refuses a read that failed rather than letting the call through", async () => {
    // Absence is not permission: a share that cannot be read is a share whose
    // permission to change is unknown, and confirming it costs more than a trip.
    const { refusal } = await precheck(
      {
        action: "grant",
        objectType: "Mailbox",
        ids: [SHARED_MAILBOX.id],
        beneficiary: PRINCIPAL_IDS.bob,
        rights: ["mayReadItems"],
      },
      sharingScript({ "Mailbox/get": ["error", { type: "serverFail" }] }),
    );

    expect(refusal).toContain("could not be read");
    expect(refusal).toContain("Nothing was written");
  });

  it("refuses an id this account does not hold", async () => {
    const { refusal } = await precheck(
      {
        action: "grant",
        objectType: "Mailbox",
        ids: ["mb-nope"],
        beneficiary: PRINCIPAL_IDS.bob,
        rights: ["mayReadItems"],
      },
      sharingScript({ "Mailbox/get": ["Mailbox/get", objectGet([], ["mb-nope"]) as never] }),
    );

    expect(refusal).toContain("mb-nope");
    expect(refusal).toContain("sharing_access");
  });

  it("lets a whole address resolve, and refuses one that names nobody", async () => {
    const found = await precheck(
      {
        action: "grant",
        objectType: "Mailbox",
        ids: [SHARED_MAILBOX.id],
        beneficiary: "bob@example.com",
        rights: ["mayReadItems"],
      },
      sharingScript({
        "Principal/query": [
          "Principal/query",
          {
            accountId: "acc-1",
            queryState: "p-query-1",
            canCalculateChanges: false,
            position: 0,
            ids: [PRINCIPAL_IDS.bob],
          },
        ],
      }),
    );

    expect(found.refusal).toBeUndefined();
    expect(methodsOf(found.requests)).toContain("Principal/query");

    const missing = await precheck(
      {
        action: "grant",
        objectType: "Mailbox",
        ids: [SHARED_MAILBOX.id],
        beneficiary: "nobody@example.com",
        rights: ["mayReadItems"],
      },
      sharingScript({
        "Principal/query": [
          "Principal/query",
          {
            accountId: "acc-1",
            queryState: "p-query-1",
            canCalculateChanges: false,
            position: 0,
            ids: [],
          },
        ],
      }),
    );

    expect(missing.refusal).toContain("no account on this server is called nobody@example.com");
  });

  it("refuses an address that matches two accounts rather than picking one", async () => {
    const { refusal } = await precheck(
      {
        action: "grant",
        objectType: "Mailbox",
        ids: [SHARED_MAILBOX.id],
        beneficiary: "shared@example.com",
        rights: ["mayReadItems"],
      },
      sharingScript({
        "Principal/query": [
          "Principal/query",
          {
            accountId: "acc-1",
            queryState: "p-query-1",
            canCalculateChanges: false,
            position: 0,
            ids: [PRINCIPAL_IDS.bob, PRINCIPAL_IDS.team],
          },
        ],
      }),
    );

    expect(refusal).toContain("more than one account");
  });

  it("refuses a closed directory on an address, and points at the id instead", async () => {
    const { refusal } = await precheck(
      {
        action: "grant",
        objectType: "Mailbox",
        ids: [SHARED_MAILBOX.id],
        beneficiary: "bob@example.com",
        rights: ["mayReadItems"],
      },
      sharingScript({ "Principal/query": ["error", { type: "forbidden" }] }),
    );

    expect(refusal).toContain("directory queries disabled");
    expect(refusal).toContain("principal id");
  });

  it("reads nothing at all on a dismissal", async () => {
    const { refusal, requests } = await precheck({
      action: "dismiss",
      notificationIds: ["sn-1"],
    });

    expect(refusal).toBeUndefined();
    expect(requests).toEqual([]);
  });
});

describe("what the server made of each id", () => {
  const response = (notUpdated: Record<Id, SetError>): SetResponse<unknown> => ({
    accountId: "acc-1",
    oldState: "s-1",
    newState: "s-2",
    updated: {},
    notUpdated,
  });

  it("passes forbidden through in the server's own words", () => {
    const text = describeShareOutcome(
      response({ "mb-2": { type: "forbidden", description: "mayShare is required" } }),
      ["mb-1", "mb-2"],
      "folder",
      "granted",
    );

    expect(text).toContain("1 of 2 folder(s) granted, 1 refused by the server");
    expect(text).toContain("forbidden — mayShare is required");
  });

  it("passes invalidProperties through, the other ids still landing", () => {
    const text = describeShareOutcome(
      response({ "mb-1": { type: "invalidProperties", description: "shareWith/p-nope" } }),
      ["mb-1", "mb-2"],
      "folder",
      "revoked",
    );

    expect(text).toContain("invalidProperties — shareWith/p-nope");
    expect(text).toContain("revoked");
  });

  it("says plainly when the server refused every one", () => {
    const text = describeShareOutcome(
      response({ "mb-1": { type: "forbidden" } }),
      ["mb-1"],
      "folder",
      "granted",
    );

    expect(text).toContain("No folder was granted");
  });

  it("reads the destroyed half on a dismissal", () => {
    const text = describeShareOutcome(
      {
        accountId: "acc-1",
        oldState: "s-1",
        newState: "s-2",
        destroyed: ["sn-1"],
        notDestroyed: { "sn-2": { type: "notFound" } },
      } as SetResponse<unknown>,
      ["sn-1", "sn-2"],
      "sharing notification",
      "discarded",
      "destroyed",
    );

    expect(text).toContain("1 of 2 sharing notification(s) discarded");
    expect(text).toContain("notFound");
  });
});
