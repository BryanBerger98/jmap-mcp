import { describe, expect, it } from "vitest";
import { sharingAccess } from "../../src/domains/sharing/access.js";
import { renderSharedObject } from "../../src/domains/sharing/grant.js";
import { MAX_IDS_PER_CALL } from "../../src/shared/batch.js";
import {
  closedDirectory,
  LONELY_MAILBOX,
  methodsOf,
  notificationQuery,
  objectGet,
  PRINCIPAL_IDS,
  SHARED_BOOK,
  SHARED_MAILBOX,
  SHARED_NODE,
  scriptedSharing,
  sharingScript,
  UNSHAREABLE_MAILBOX,
} from "../fixtures/sharing.js";

const OPEN_DIRECTORY = { closed: false, nameOf: (id: string) => id };

/** The tool's own parse, so a test never runs on arguments the schema refuses. */
function parse(input: Record<string, unknown>) {
  return sharingAccess.inputSchema.parse(input);
}

async function run(input: Record<string, unknown>, script = sharingScript()) {
  const { context, requests } = scriptedSharing(script);
  const result = await sharingAccess.run(parse(input), context);

  return { result, requests };
}

describe("sharing_access schema", () => {
  it("refuses one id past the ceiling, before any call", () => {
    const ids = Array.from({ length: MAX_IDS_PER_CALL + 1 }, (_, index) => `mb-${index}`);
    const refused = sharingAccess.inputSchema.safeParse({
      action: "object",
      objectType: "Mailbox",
      ids,
    });

    expect(refused.success).toBe(false);
    // The ceiling itself is accepted: the refusal is about the fifty-first.
    expect(
      sharingAccess.inputSchema.safeParse({
        action: "object",
        objectType: "Mailbox",
        ids: ids.slice(0, MAX_IDS_PER_CALL),
      }).success,
    ).toBe(true);
  });

  it("asks for an object type and ids on the object action", () => {
    expect(sharingAccess.inputSchema.safeParse({ action: "object" }).success).toBe(false);
    expect(
      sharingAccess.inputSchema.safeParse({ action: "object", objectType: "Mailbox" }).success,
    ).toBe(false);
    expect(sharingAccess.inputSchema.safeParse({ action: "received" }).success).toBe(true);
  });

  it("classifies every call as a read, whatever the arguments", () => {
    expect(sharingAccess.classes).toEqual(["read"]);
    expect(sharingAccess.classify(parse({ action: "received" }))).toBe("read");
    expect(
      sharingAccess.classify(parse({ action: "object", objectType: "Mailbox", ids: ["mb-1"] })),
    ).toBe("read");
  });

  it("carries no hook of its own", () => {
    expect(sharingAccess.precheck).toBeUndefined();
    expect(sharingAccess.confirmWhen).toBeUndefined();
  });
});

describe("sharing_access object", () => {
  it("names the beneficiaries and their rights in the type's own words", async () => {
    const { result, requests } = await run({
      action: "object",
      objectType: "Mailbox",
      ids: [SHARED_MAILBOX.id],
    });

    expect(result.text).toContain("Invoices");
    expect(result.text).toContain("alice@example.com");
    expect(result.text).toContain("read the messages it holds");
    // The address is what names an account; changedBy-style labels never stand in.
    expect(result.text).toContain("Alice Martin <alice@example.com>");
    expect(methodsOf(requests)).toEqual(["Mailbox/get", "Principal/get"]);
  });

  it("reads a folder for its sharing alone, never for its contents", async () => {
    const { requests } = await run({
      action: "object",
      objectType: "Mailbox",
      ids: [SHARED_MAILBOX.id],
    });

    const args = requests[0]?.methodCalls[0]?.[1];
    expect(args?.properties).toEqual(["id", "name", "shareWith", "myRights"]);
  });

  it("says in words that nobody reaches an object", async () => {
    const { result } = await run(
      { action: "object", objectType: "Mailbox", ids: [LONELY_MAILBOX.id] },
      sharingScript({ "Mailbox/get": ["Mailbox/get", objectGet([LONELY_MAILBOX]) as never] }),
    );

    // A silent empty block would read the same as a partial answer.
    expect(result.text).toContain("Shared with nobody");
  });

  it("flags that the account may not change the sharing, without refusing the read", async () => {
    const { result } = await run(
      { action: "object", objectType: "Mailbox", ids: [UNSHAREABLE_MAILBOX.id] },
      sharingScript({
        "Mailbox/get": ["Mailbox/get", objectGet([UNSHAREABLE_MAILBOX]) as never],
      }),
    );

    expect(result.text).toContain("mayShare is not granted");
    // The read still happened: the beneficiary is there.
    expect(result.text).toContain("bob@example.com");
    expect(result.text).not.toContain("Refused");
  });

  it("renders the objects it found and names the id it did not", async () => {
    const { result } = await run(
      {
        action: "object",
        objectType: "Mailbox",
        ids: [SHARED_MAILBOX.id, LONELY_MAILBOX.id, "mb-nope"],
      },
      sharingScript({
        "Mailbox/get": [
          "Mailbox/get",
          objectGet([SHARED_MAILBOX, LONELY_MAILBOX], ["mb-nope"]) as never,
        ],
      }),
    );

    expect(result.text).toContain("Invoices");
    expect(result.text).toContain("Drafts");
    expect(result.text).toContain("Not found in this account: mb-nope");
  });

  it("refuses a type this server does not advertise, naming the capability", async () => {
    // The fixture session carries mail, calendars and principals, and no filenode.
    const { result, requests } = await run({
      action: "object",
      objectType: "FileNode",
      ids: [SHARED_NODE.id],
    });

    expect(result.text).toContain("Refused");
    expect(result.text).toContain("urn:ietf:params:jmap:filenode");
    expect(requests).toEqual([]);
  });
});

describe("sharing_access received", () => {
  it("says who changed what, and which rights moved", async () => {
    const { result, requests } = await run({ action: "received" });

    expect(result.text).toContain("alice@example.com");
    expect(result.text).toContain("Mailbox mb-9");
    expect(result.text).toContain("gained:");
    expect(result.text).toContain("read the messages it holds");
    // A revocation reads in the calendar's own vocabulary.
    expect(result.text).toContain("lost:");
    expect(result.text).toContain("answer invitations in this calendar");

    expect(methodsOf(requests)).toEqual([
      "ShareNotification/query",
      "ShareNotification/get",
      "Principal/get",
    ]);
  });

  it("asks for no order, the server honouring none", async () => {
    const { requests } = await run({ action: "received" });
    const args = requests[0]?.methodCalls[0]?.[1];

    expect(args).not.toHaveProperty("sort");
    expect(args).not.toHaveProperty("filter");
  });

  it("hands back a cursor when more remains, and refuses a foreign one", async () => {
    const truncated = sharingScript({
      "ShareNotification/query": [
        "ShareNotification/query",
        notificationQuery(undefined, 9) as never,
      ],
    });

    const { result } = await run({ action: "received", limit: 3 }, truncated);
    expect(result.nextCursor).toBeDefined();

    const resumed = await run(
      { action: "received", limit: 3, cursor: result.nextCursor as string },
      truncated,
    );
    expect(resumed.result.text).toContain("from position 3");

    const foreign = await run({ action: "received", cursor: "not-a-cursor" });
    expect(foreign.result.text).toContain("unreadable");
  });

  it("stops handing back a cursor once the set is exhausted", async () => {
    const { result } = await run({ action: "received" });

    expect(result.nextCursor).toBeUndefined();
  });
});

describe("a closed directory", () => {
  it("renders the raw ids and names the cause, on both actions", async () => {
    const object = await run(
      { action: "object", objectType: "Mailbox", ids: [SHARED_MAILBOX.id] },
      closedDirectory(),
    );

    expect(object.result.text).toContain(PRINCIPAL_IDS.alice);
    expect(object.result.text).toContain("directory queries disabled");
    // Never an empty share over a populated one.
    expect(object.result.text).not.toContain("Shared with nobody");

    const received = await run({ action: "received" }, closedDirectory());
    expect(received.result.text).toContain(PRINCIPAL_IDS.alice);
    expect(received.result.text).toContain("directory queries disabled");
  });

  it("lets any other method error travel", async () => {
    // Answering from an empty directory here would be an answer sure of itself
    // and founded on nothing, which is the availability fallback's rule too.
    await expect(run({ action: "received" }, closedDirectory("serverFail"))).rejects.toThrow(
      /serverFail/,
    );
  });
});

describe("the rendering of one object", () => {
  it("never renders a type's rights in another type's wording", () => {
    const book = renderSharedObject("AddressBook", SHARED_BOOK, OPEN_DIRECTORY);
    const folder = renderSharedObject("Mailbox", SHARED_MAILBOX, OPEN_DIRECTORY);

    expect(folder).toContain("read the messages it holds");
    expect(book).not.toContain("read the messages it holds");
    expect(book).toContain("address book");
  });

  it("names a file node in its own noun and its own rights", () => {
    const node = renderSharedObject("FileNode", SHARED_NODE, OPEN_DIRECTORY);

    expect(node).toContain("file or folder");
    expect(node).toContain("create files and folders inside it");
  });
});
