import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { OPEN_SCOPE } from "../../src/config/recipients.js";
import { DEFAULT_BULK_CONFIRM_ABOVE } from "../../src/config/schema.js";
import { rightsOf } from "../../src/domains/sharing/rights.js";
import { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import type {
  GetResponse,
  Id,
  Invocation,
  JmapRequest,
  JmapResponse,
  QueryResponse,
} from "../../src/jmap/types/core.js";
import type { Principal, ShareableType, ShareNotification } from "../../src/jmap/types/sharing.js";
import { perInvocationCache, type ToolContext } from "../../src/registry/define-tool.js";
import { fakeBlobs, fixtureSession } from "./client.js";

/**
 * Shares of one account, and the directory that names their beneficiaries.
 *
 * Written in TypeScript rather than as JSON files, like the Sieve fixtures: a
 * rights map is a complete set of booleans built from the vocabulary of its own
 * type, and a hand-written JSON copy of the four vocabularies would go stale the
 * day one of them changes.
 *
 * The transport here is scripted by method name rather than queued, because the
 * one case this domain exists to handle cannot be queued: `Principal/get`
 * answering with an `error` invocation instead of with its own name.
 */

export const PRINCIPAL_IDS = {
  alice: "p-alice",
  bob: "p-bob",
  team: "p-team",
} as const;

export const PRINCIPALS: Principal[] = [
  {
    id: PRINCIPAL_IDS.alice,
    type: "individual",
    name: "alice@example.com",
    email: "alice@example.com",
    description: "Alice Martin",
  },
  // No description: the address is the only name there is, and both properties
  // carry it, which is what this server does for an account without a label.
  {
    id: PRINCIPAL_IDS.bob,
    type: "individual",
    name: "bob@example.com",
    email: "bob@example.com",
    description: null,
  },
  {
    id: PRINCIPAL_IDS.team,
    type: "group",
    name: "team@example.com",
    email: "team@example.com",
    description: "Support team",
  },
];

/**
 * A complete rights map for a type, granting exactly the names given.
 *
 * Complete on purpose: the server writes every right of the type, granted or
 * not, so a fixture holding only the granted ones would test a shape the wire
 * never produces.
 */
export function allRights(
  type: ShareableType,
  granted: readonly string[],
): Record<string, boolean> {
  return Object.fromEntries(rightsOf(type).map((name) => [name, granted.includes(name)]));
}

/** A folder shared with two accounts, one of them read-only. */
export const SHARED_MAILBOX = {
  id: "mb-1",
  name: "Invoices",
  shareWith: {
    [PRINCIPAL_IDS.alice]: allRights("Mailbox", ["mayReadItems", "mayAddItems", "maySetSeen"]),
    [PRINCIPAL_IDS.bob]: allRights("Mailbox", ["mayReadItems"]),
  },
  myRights: allRights("Mailbox", [...rightsOf("Mailbox")]),
};

/**
 * A folder nobody reaches.
 *
 * A `Mailbox` rather than an object of another type because the fixture session
 * advertises mail: the empty-share wording has to be reachable through the tool,
 * not only through the renderer.
 */
export const LONELY_MAILBOX = {
  id: "mb-2",
  name: "Drafts",
  shareWith: {},
  myRights: allRights("Mailbox", [...rightsOf("Mailbox")]),
};

/** A folder this account may read the sharing of, and not change. */
export const UNSHAREABLE_MAILBOX = {
  id: "mb-3",
  name: "Received",
  shareWith: {
    [PRINCIPAL_IDS.bob]: allRights("Mailbox", ["mayReadItems"]),
  },
  myRights: allRights("Mailbox", ["mayReadItems", "mayAddItems"]),
};

/** A calendar shared with one group, on rights only a calendar has. */
export const SHARED_CALENDAR = {
  id: "cal-1",
  name: "Team",
  shareWith: {
    [PRINCIPAL_IDS.team]: allRights("Calendar", ["mayReadFreeBusy", "mayReadItems", "mayRSVP"]),
  },
  myRights: allRights("Calendar", [...rightsOf("Calendar")]),
};

/** An address book nobody reaches, and which this account may not share on. */
export const SHARED_BOOK = {
  id: "ab-1",
  name: "Personal",
  shareWith: {},
  myRights: allRights("AddressBook", ["mayRead", "mayWrite"]),
};

/** A file node shared with one account. */
export const SHARED_NODE = {
  id: "fn-1",
  name: "Contracts",
  shareWith: {
    [PRINCIPAL_IDS.alice]: allRights("FileNode", ["mayRead", "mayAddChildren"]),
  },
  myRights: allRights("FileNode", [...rightsOf("FileNode")]),
};

export const SHARED_OBJECTS: Record<ShareableType, { id: Id }> = {
  Mailbox: SHARED_MAILBOX,
  Calendar: SHARED_CALENDAR,
  AddressBook: SHARED_BOOK,
  FileNode: SHARED_NODE,
};

/** Three changes other accounts made towards this one, most recent first. */
export const NOTIFICATIONS: ShareNotification[] = [
  {
    id: "sn-1",
    created: "2026-09-01T09:00:00Z",
    changedBy: {
      principalId: PRINCIPAL_IDS.alice,
      name: "Alice Martin",
      email: "alice@example.com",
    },
    objectType: "Mailbox",
    objectAccountId: "acc-alice",
    objectId: "mb-9",
    oldRights: allRights("Mailbox", []),
    newRights: allRights("Mailbox", ["mayReadItems"]),
  },
  {
    id: "sn-2",
    created: "2026-08-30T17:30:00Z",
    changedBy: {
      principalId: PRINCIPAL_IDS.team,
      name: "Support team",
      email: "team@example.com",
    },
    objectType: "Calendar",
    objectAccountId: "acc-team",
    objectId: "cal-9",
    oldRights: allRights("Calendar", ["mayReadItems", "mayRSVP"]),
    newRights: allRights("Calendar", ["mayReadItems"]),
  },
  {
    id: "sn-3",
    created: "2026-08-28T08:15:00Z",
    changedBy: {
      principalId: PRINCIPAL_IDS.bob,
      name: "bob@example.com",
      email: "bob@example.com",
    },
    objectType: "AddressBook",
    objectAccountId: "acc-bob",
    objectId: "ab-9",
    oldRights: allRights("AddressBook", []),
    newRights: allRights("AddressBook", ["mayRead"]),
  },
];

export function principalGet(list: readonly Principal[] = PRINCIPALS): GetResponse<Principal> {
  return {
    accountId: "acc-1",
    state: "principal-state-1",
    list: [...list],
    notFound: [],
  };
}

/** An `X/get` answer holding the shared objects given, and naming the rest missing. */
export function objectGet(
  list: readonly { id: Id }[],
  notFound: readonly Id[] = [],
): GetResponse<{ id: Id }> {
  return {
    accountId: "acc-1",
    state: "object-state-1",
    list: [...list],
    notFound: [...notFound],
  };
}

export function notificationGet(
  list: readonly ShareNotification[] = NOTIFICATIONS,
): GetResponse<ShareNotification> {
  return {
    accountId: "acc-1",
    state: "sn-state-1",
    list: [...list],
    notFound: [],
  };
}

/** A `ShareNotification/query` answer, in the descending order the server scans in. */
export function notificationQuery(
  list: readonly ShareNotification[] = NOTIFICATIONS,
  total = list.length,
): QueryResponse {
  return {
    accountId: "acc-1",
    queryState: "sn-query-state-1",
    canCalculateChanges: false,
    position: 0,
    ids: list.map((notification) => notification.id),
    total,
  };
}

/** What a scripted transport answers, keyed by the method that was called. */
export type Script = Record<string, [string, Record<string, unknown>]>;

/** The happy path: every method this domain sends, answered with its own name. */
export function sharingScript(overrides: Script = {}): Script {
  return {
    "Principal/get": ["Principal/get", principalGet() as unknown as Record<string, unknown>],
    "ShareNotification/query": [
      "ShareNotification/query",
      notificationQuery() as unknown as Record<string, unknown>,
    ],
    "ShareNotification/get": [
      "ShareNotification/get",
      notificationGet() as unknown as Record<string, unknown>,
    ],
    "Mailbox/get": [
      "Mailbox/get",
      objectGet([SHARED_MAILBOX]) as unknown as Record<string, unknown>,
    ],
    "Calendar/get": [
      "Calendar/get",
      objectGet([SHARED_CALENDAR]) as unknown as Record<string, unknown>,
    ],
    "AddressBook/get": [
      "AddressBook/get",
      objectGet([SHARED_BOOK]) as unknown as Record<string, unknown>,
    ],
    "FileNode/get": [
      "FileNode/get",
      objectGet([SHARED_NODE]) as unknown as Record<string, unknown>,
    ],
    ...overrides,
  };
}

/**
 * The same script with the directory closed.
 *
 * `error` rather than an empty list: an administrator who leaves directory
 * queries off makes the method itself fail, and answering that with no
 * beneficiary would render "shared with nobody" over a populated share.
 */
export function closedDirectory(type = "forbidden"): Script {
  return sharingScript({ "Principal/get": ["error", { type }] });
}

/**
 * A session advertising every capability the four shareable types need.
 *
 * The session fixture carries mail, calendars and principals and neither
 * contacts nor filenode, which is what makes the missing-capability refusal
 * testable. A contract proving all four types stay on reads needs the opposite,
 * and gets it here rather than by widening the shared fixture.
 */
export function fullySharingSession(): JmapSession {
  return { has: () => true, accountId: "acc-1" } as unknown as JmapSession;
}

/** A transport that answers per method name, so a method can fail on its own. */
export function scriptedSharing(
  script: Script = sharingScript(),
  session: JmapSession = fixtureSession(),
): {
  context: ToolContext;
  requests: JmapRequest[];
} {
  const requests: JmapRequest[] = [];

  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as JmapRequest;
    requests.push(request);

    const body: JmapResponse = {
      methodResponses: request.methodCalls.map(([name, , callId]): Invocation => {
        const [answered, args] = script[name] ?? [name, {}];
        return [answered, args, callId];
      }),
      sessionState: "session-state-1",
    };

    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  return {
    context: {
      client: new JmapClient({
        apiUrl: "https://mail.example.com/jmap/",
        bearerToken: "a-token",
        fetchImpl,
      }),
      session,
      blobs: fakeBlobs({ uploads: [], downloads: [] }),
      files: {},
      recipients: OPEN_SCOPE,
      policy: DEFAULT_POLICY,
      bulkConfirmAbove: DEFAULT_BULK_CONFIRM_ABOVE,
      once: perInvocationCache(),
    },
    requests,
  };
}

/** Every method name a run put on the wire, in order. */
export function methodsOf(requests: readonly JmapRequest[]): string[] {
  return requests.flatMap((request) => request.methodCalls.map(([name]) => name));
}
