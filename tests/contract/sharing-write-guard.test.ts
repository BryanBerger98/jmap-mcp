import { isInputRequiredResult, type McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { sharingWritingDomain } from "../../src/domains/sharing/index.js";
import { rightsOf } from "../../src/domains/sharing/rights.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import type { Id, JmapRequest } from "../../src/jmap/types/core.js";
import { CAPABILITY_MAIL, CAPABILITY_PRINCIPALS } from "../../src/jmap/types/core.js";
import type { ShareableType } from "../../src/jmap/types/sharing.js";
import { SHAREABLE_TYPES } from "../../src/jmap/types/sharing.js";
import { compose } from "../../src/registry/compose.js";
import type { ToolDefinition } from "../../src/registry/define-tool.js";
import { MAX_IDS_PER_CALL } from "../../src/shared/batch.js";
import {
  allRights,
  fullySharingSession,
  methodsOf,
  objectGet,
  PRINCIPAL_IDS,
  type Script,
  SHARED_BOOK,
  SHARED_MAILBOX,
  scriptedSharing,
  sharingScript,
  UNSHAREABLE_MAILBOX,
} from "../fixtures/sharing.js";

/**
 * The invariant this file exists for: a share is written for the beneficiary the
 * call named, and for nobody else.
 *
 * Sharing is the one surface here that writes into objects of four other
 * domains, and the property it writes is a map of every account that reaches
 * one. Writing that map whole would take a read as the truth — a partial one,
 * or one taken before someone else granted an access in parallel — and remove
 * every beneficiary the call never mentioned, under a confirmation that spoke
 * about one. The assertion below is therefore on the emitted patch itself: no
 * key names a principal other than the beneficiary, and no key is the map.
 *
 * Written over `sharingWritingDomain.tools`, so a tool added to the manifest is
 * held to the same guarantees the day it lands.
 */

/** An address book this account may share on, unlike the read fixture's. */
const SHAREABLE_BOOK = {
  ...SHARED_BOOK,
  myRights: allRights("AddressBook", [...rightsOf("AddressBook")]),
};

/** A `/set` answer that refuses nothing: what the server made of it is another file's business. */
function setDone(): Record<string, unknown> {
  return { accountId: "acc-1", oldState: "s-1", newState: "s-2", updated: {}, destroyed: [] };
}

/** Every method the writing surface can send, answered. */
function writingScript(overrides: Script = {}): Script {
  return sharingScript({
    "AddressBook/get": ["AddressBook/get", objectGet([SHAREABLE_BOOK]) as never],
    "Mailbox/set": ["Mailbox/set", setDone()],
    "Calendar/set": ["Calendar/set", setDone()],
    "AddressBook/set": ["AddressBook/set", setDone()],
    "FileNode/set": ["FileNode/set", setDone()],
    "ShareNotification/set": ["ShareNotification/set", setDone()],
    ...overrides,
  });
}

type Handler = (
  args: unknown,
  ctx: { mcpReq: { inputResponses?: Record<string, unknown>; envelope?: Record<string, unknown> } },
) => Promise<unknown>;

const CONFIRMED = {
  mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: true } } } },
};
const DECLINED = {
  mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: false } } } },
};
const UNANSWERED = { mcpReq: {} };

function writingSurface(
  script: Script = writingScript(),
  capabilities: Record<string, unknown> | null = { elicitation: {} },
) {
  const { context, requests } = scriptedSharing(script, fullySharingSession());
  const handlers = new Map<string, Handler>();

  compose({
    server: {
      registerTool(name: string, _config: unknown, cb: Handler) {
        handlers.set(name, cb);
      },
      ...(capabilities === null ? {} : { server: { getClientCapabilities: () => capabilities } }),
    } as unknown as McpServer,
    domains: [sharingWritingDomain],
    session: context.session,
    client: context.client,
    policy: DEFAULT_POLICY,
  });

  return { handlers, requests, manage: handlers.get("sharing_manage") as Handler };
}

function fakeServer(registered: string[]): McpServer {
  return {
    registerTool(name: string) {
      registered.push(name);
    },
  } as unknown as McpServer;
}

function sessionWith(capabilities: readonly string[]): JmapSession {
  return { has: (uri: string) => capabilities.includes(uri) } as unknown as JmapSession;
}

/** Every `/set` a run put on the wire, with the arguments it carried. */
function setsIn(requests: JmapRequest[]): { method: string; args: Record<string, unknown> }[] {
  return requests.flatMap((request) =>
    request.methodCalls
      .filter(([name]) => name.endsWith("/set"))
      .map(([method, args]) => ({ method, args: args as Record<string, unknown> })),
  );
}

/** Every patch key of every id an object `/set` updated. */
function patchKeysIn(requests: JmapRequest[]): string[] {
  return setsIn(requests).flatMap(({ args }) =>
    Object.values((args.update ?? {}) as Record<Id, Record<string, unknown>>).flatMap((patch) =>
      Object.keys(patch),
    ),
  );
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? "").join("");
}

function keysOf(tool: ToolDefinition): string[] {
  return Object.keys((tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape);
}

/**
 * One shareable object of each type, the right the case grants, and the
 * non-cascade flag its `/set` owes.
 *
 * Four rows rather than one tested type: the map is written per type, and a
 * guarantee proven on a folder says nothing about a calendar.
 */
const CASES: Record<ShareableType, { id: Id; right: string; flag: string }> = {
  Mailbox: { id: "mb-1", right: "mayReadItems", flag: "onDestroyRemoveEmails" },
  Calendar: { id: "cal-1", right: "mayReadItems", flag: "onDestroyRemoveEvents" },
  AddressBook: { id: "ab-1", right: "mayRead", flag: "onDestroyRemoveContents" },
  FileNode: { id: "fn-1", right: "mayRead", flag: "onDestroyRemoveChildren" },
};

/**
 * Every path this surface takes to an object `/set`: both directions on each of
 * the four types.
 *
 * Validated by mutation: making the revoke branch write the whole `shareWith`
 * map turns `names the beneficiary of the call and no other account` red.
 */
const PATHS: { name: string; type: ShareableType; input: Record<string, unknown> }[] =
  SHAREABLE_TYPES.flatMap((type) => {
    const { id, right } = CASES[type];
    const common = { objectType: type, ids: [id], beneficiary: PRINCIPAL_IDS.bob };

    return [
      {
        name: `granting on a ${type}`,
        type,
        input: { action: "grant", ...common, rights: [right] },
      },
      {
        name: `taking a right back on a ${type}`,
        type,
        input: { action: "revoke", ...common, rights: [right] },
      },
      {
        name: `removing a beneficiary from a ${type}`,
        type,
        input: { action: "revoke", ...common },
      },
    ];
  });

/**
 * What it takes to reach the destroying branch, and there is more than one.
 *
 * Hand-written on the `files_write_guard` pattern: the arguments that classify
 * as `destroy` are the tool's own business, and a guess derived from the schema
 * would confirm nothing about the real path. The exhaustiveness test below keeps
 * this map honest.
 */
const DESTROYING: Record<string, Record<string, unknown>> = {
  sharing_manage: {
    action: "revoke",
    objectType: "Mailbox",
    ids: [SHARED_MAILBOX.id],
    beneficiary: PRINCIPAL_IDS.bob,
  },
};

/** The three actions, so a guarantee is never proven on one of them alone. */
const ACTIONS: { name: string; input: Record<string, unknown> }[] = [
  {
    name: "grant",
    input: {
      action: "grant",
      objectType: "Mailbox",
      ids: [SHARED_MAILBOX.id],
      beneficiary: PRINCIPAL_IDS.bob,
      rights: ["mayReadItems"],
    },
  },
  { name: "revoke", input: DESTROYING.sharing_manage as Record<string, unknown> },
  { name: "dismiss", input: { action: "dismiss", notificationIds: ["sn-1"] } },
];

const TOOLS = sharingWritingDomain.tools.map((tool) => [tool.name, tool] as const);

const DESTROYERS = sharingWritingDomain.tools.filter((tool) => tool.classes.includes("destroy"));

/** Every key that would let a call name a set of objects instead of listing them. */
const CRITERIA = ["query", "search", "text", "filter", "cursor", "position", "limit", "nameMatch"];

describe("the writing manifest", () => {
  it("names every destroying tool in the cases below, so none escapes them", () => {
    expect(DESTROYERS.map((tool) => tool.name).sort()).toEqual(Object.keys(DESTROYING).sort());
  });

  it.each(TOOLS)("%s carries no search criterion, only ids and a beneficiary", (_name, tool) => {
    expect(keysOf(tool).filter((key) => CRITERIA.includes(key))).toEqual([]);
  });

  it.each(TOOLS)("%s shares the sharing_ prefix", (name) => {
    expect(name.startsWith("sharing_")).toBe(true);
  });

  it("reads its class off the action, opening being a send and closing a destroy", () => {
    const tool = sharingWritingDomain.tools.find((each) => each.name === "sharing_manage");

    expect(tool?.classes).toEqual(["send", "destroy"]);
    expect(tool?.classify({ action: "grant" } as never)).toBe("send");
    expect(tool?.classify({ action: "revoke" } as never)).toBe("destroy");
    expect(tool?.classify({ action: "dismiss" } as never)).toBe("destroy");
  });
});

describe("gating", () => {
  it("registers the writing tools on a session advertising the principals", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [sharingWritingDomain],
      session: sessionWith([CAPABILITY_PRINCIPALS]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual(sharingWritingDomain.tools.map((tool) => tool.name));
    expect(report.skipped).toEqual([]);
  });

  it("registers nothing without the capability, and names the one that is missing", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [sharingWritingDomain],
      session: sessionWith([CAPABILITY_MAIL]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual([]);
    // Named `sharing-writing`, so the report says which of the two surfaces fell silent.
    expect(report.skipped).toEqual([
      { domain: "sharing-writing", missing: [CAPABILITY_PRINCIPALS] },
    ]);
  });
});

describe("an emitted share write", () => {
  it.each(PATHS)(
    "$name names the beneficiary of the call and no other account",
    async ({ input }) => {
      const { manage, requests } = writingSurface();

      await manage(input, CONFIRMED);

      const keys = patchKeysIn(requests);
      // Vacuously true if nothing was written, so the count is asserted first.
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key.startsWith(`shareWith/${PRINCIPAL_IDS.bob}`)).toBe(true);
      }
      for (const stranger of [PRINCIPAL_IDS.alice, PRINCIPAL_IDS.team]) {
        expect(keys.some((key) => key.includes(stranger))).toBe(false);
      }
    },
  );

  it.each(PATHS)("$name never writes the sharing map whole", async ({ input }) => {
    const { manage, requests } = writingSurface();

    await manage(input, CONFIRMED);

    const keys = patchKeysIn(requests);
    expect(keys.length).toBeGreaterThan(0);
    // A bare `shareWith` key would replace every beneficiary at once.
    expect(keys).not.toContain("shareWith");
  });

  it.each(PATHS)(
    "$name carries an update alone, plus its type's cascade flag",
    async ({ type, input }) => {
      const { manage, requests } = writingSurface();

      await manage(input, CONFIRMED);

      const emitted = setsIn(requests);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.method).toBe(`${type}/set`);
      expect(emitted[0]?.args).not.toHaveProperty("create");
      expect(emitted[0]?.args).not.toHaveProperty("destroy");
      // Written on every call, including the ones that could destroy nothing: a
      // server default is not a guarantee, and an absent argument is invisible.
      expect(Object.hasOwn(emitted[0]?.args as object, CASES[type].flag)).toBe(true);
      expect(emitted[0]?.args[CASES[type].flag]).toBe(false);
    },
  );

  it.each(PATHS)("$name writes no path that is the prefix of another", async ({ input }) => {
    const { manage, requests } = writingSurface();

    await manage(input, CONFIRMED);

    const keys = patchKeysIn(requests);
    expect(keys.length).toBeGreaterThan(0);
    // RFC 8620 §5.3 makes such a patch invalid; the server answers `invalidPatch`.
    for (const key of keys) {
      expect(keys.some((other) => other.startsWith(`${key}/`))).toBe(false);
    }
  });

  it("discards a notification with a destroy alone, and no object write at all", async () => {
    const { manage, requests } = writingSurface();

    await manage({ action: "dismiss", notificationIds: ["sn-1", "sn-2"] }, CONFIRMED);

    const emitted = setsIn(requests);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.method).toBe("ShareNotification/set");
    expect(emitted[0]?.args.destroy).toEqual(["sn-1", "sn-2"]);
    expect(emitted[0]?.args).not.toHaveProperty("update");
    expect(emitted[0]?.args).not.toHaveProperty("create");
  });
});

describe("a call that changes who reaches what", () => {
  it.each(ACTIONS)(
    "$name is refused outright on a client that cannot be asked",
    async ({ input }) => {
      const { manage, requests } = writingSurface(writingScript(), { roots: {} });

      const result = await manage(input, UNANSWERED);

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("elicitation");
      expect(setsIn(requests)).toEqual([]);
    },
  );

  it.each(ACTIONS)(
    "$name is put to the user, and writes nothing while it waits",
    async ({ input }) => {
      const { manage, requests } = writingSurface();

      const result = await manage(input, UNANSWERED);

      expect(isInputRequiredResult(result)).toBe(true);
      expect(setsIn(requests)).toEqual([]);
    },
  );

  it.each(ACTIONS)(
    "$name emits reads at most when the confirmation comes back false",
    async ({ input }) => {
      const { manage, requests } = writingSurface();

      await manage(input, DECLINED);

      // A read may precede the question — `precheck` and `summarize` both run
      // before it by design, so a doomed call is never put to the user and the
      // question can name what it is about. The assertion is on every method
      // emitted, not only on the `/set` that would have written.
      for (const method of methodsOf(requests)) {
        expect(method.endsWith("/get") || method.endsWith("/query")).toBe(true);
      }
    },
  );

  it("says in the question that closing an access recalls nothing", async () => {
    const { manage } = writingSurface();

    const result = await manage(DESTROYING.sharing_manage, UNANSWERED);

    expect(JSON.stringify(result)).toContain("does not recall what was read through it");
  });
});

describe("the refusals that precede the question", () => {
  it("refuses a batch past the hard ceiling, before a single method leaves", async () => {
    const { manage, requests } = writingSurface();

    const ids = Array.from({ length: MAX_IDS_PER_CALL + 1 }, (_, index) => `mb-${index}`);
    const result = await manage(
      { action: "revoke", objectType: "Mailbox", ids, beneficiary: PRINCIPAL_IDS.bob },
      CONFIRMED,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain(`batches of ${MAX_IDS_PER_CALL}`);
    expect(methodsOf(requests)).toEqual([]);
  });

  it("refuses an object this account may not share, before the question is asked", async () => {
    const { manage, requests } = writingSurface(
      writingScript({
        "Mailbox/get": ["Mailbox/get", objectGet([UNSHAREABLE_MAILBOX]) as never],
      }),
    );

    const result = await manage(
      {
        action: "grant",
        objectType: "Mailbox",
        ids: [UNSHAREABLE_MAILBOX.id],
        beneficiary: PRINCIPAL_IDS.bob,
        rights: ["mayReadItems"],
      },
      UNANSWERED,
    );

    // Refused rather than asked: the user is never made to arbitrate a call the
    // server would turn down whatever they answered.
    expect(isInputRequiredResult(result)).toBe(false);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("mayShare is not granted");
    expect(setsIn(requests)).toEqual([]);
  });

  it("refuses a right the type does not know, before a single method leaves", async () => {
    const { manage, requests } = writingSurface();

    const result = await manage(
      {
        action: "grant",
        objectType: "AddressBook",
        ids: ["ab-1"],
        beneficiary: PRINCIPAL_IDS.bob,
        rights: ["mayWriteAll"],
      },
      CONFIRMED,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("AddressBook has no right named mayWriteAll");
    expect(methodsOf(requests)).toEqual([]);
  });
});
