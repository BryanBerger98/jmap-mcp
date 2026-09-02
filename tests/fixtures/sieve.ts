import type { BlobChannel } from "../../src/jmap/blob.js";
import type { GetResponse, Id, QueryResponse, SetResponse } from "../../src/jmap/types/core.js";
import type {
  SieveScript,
  SieveScriptValidateResponse,
  VacationResponse,
} from "../../src/jmap/types/sieve.js";
import { VACATION_SINGLETON_ID } from "../../src/jmap/types/sieve.js";
import { type BlobTraffic, UPLOADED_BLOB_ID } from "./client.js";

/**
 * The Sieve scripts of one account, and the text behind each of their blobs.
 *
 * Written in TypeScript rather than as a JSON file, unlike the other fixtures:
 * the bodies are what the module reasons about, and a script full of `\n` inside
 * a JSON string is unreadable to whoever has to check the assertion.
 *
 * Four scripts, chosen so every branch of the module has a target: one active,
 * one carrying wide-radius actions, one neutral, and the `vacation` script the
 * vacation response owns.
 */

export const SIEVE_SCRIPT_IDS = {
  neutral: "sc-1",
  wide: "sc-2",
  active: "sc-3",
  vacation: "sc-vac",
} as const;

/** A neutral script: it files mail away, and loses none. */
const NEUTRAL_TEXT = `require ["fileinto"];

# Nothing here should ever discard a message.
if header :contains "list-id" "newsletters.example.com" {
    fileinto "Newsletters";
}
`;

/** Every wide-radius action Sieve offers, so the severity order has a target. */
const WIDE_TEXT = `require ["fileinto", "reject", "ereject", "vacation"];

if header :contains "subject" "unsubscribe" {
    discard;
}
if address :is "from" "boss@example.com" {
    redirect "phone@example.net";
}
if header :contains "subject" "invoice" {
    reject "Send invoices to accounts@example.com";
}
if header :contains "subject" "spam" {
    ereject "Not accepted";
}
if header :contains "subject" "holiday" {
    vacation "Away until Monday";
}
fileinto "Inbox";
`;

/** The active script: it sorts, and does nothing irreversible. */
const ACTIVE_TEXT = `require ["fileinto"];

if header :contains "from" "billing@example.com" {
    fileinto "Invoices";
}
`;

/** What Stalwart generates behind a vacation response. */
const VACATION_TEXT = `require ["vacation", "date"];

if currentdate :value "ge" "iso8601" "2026-09-10T00:00:00Z" {
    vacation :days 7 :subject "Out of office" "Back on the 20th.";
}
`;

/** The text each blob serves, keyed the way the blob channel is asked for it. */
export const SCRIPT_TEXTS: Record<Id, string> = {
  "blob-sc-1": NEUTRAL_TEXT,
  "blob-sc-2": WIDE_TEXT,
  "blob-sc-3": ACTIVE_TEXT,
  "blob-sc-vac": VACATION_TEXT,
};

export const SIEVE_SCRIPTS: SieveScript[] = [
  { id: SIEVE_SCRIPT_IDS.neutral, name: "newsletters", blobId: "blob-sc-1", isActive: false },
  { id: SIEVE_SCRIPT_IDS.wide, name: "aggressive", blobId: "blob-sc-2", isActive: false },
  { id: SIEVE_SCRIPT_IDS.active, name: "invoices", blobId: "blob-sc-3", isActive: true },
  { id: SIEVE_SCRIPT_IDS.vacation, name: "vacation", blobId: "blob-sc-vac", isActive: false },
];

/** A `SieveScript/get` answer holding every script, in query order. */
export function sieveGet(
  scripts: readonly SieveScript[] = SIEVE_SCRIPTS,
): GetResponse<SieveScript> {
  return { accountId: "acc-1", state: "sieve-state-1", list: [...scripts], notFound: [] };
}

/** A `SieveScript/query` answer naming the same scripts, sorted by name. */
export function sieveQuery(scripts: readonly SieveScript[] = SIEVE_SCRIPTS): QueryResponse {
  const ids = [...scripts]
    .sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""))
    .map((script) => script.id);

  return {
    accountId: "acc-1",
    queryState: "sieve-query-state-1",
    canCalculateChanges: false,
    position: 0,
    ids,
    total: ids.length,
  };
}

/** The compiler accepting the uploaded text: nothing is wrong with it. */
export function sieveValid(): SieveScriptValidateResponse {
  return { accountId: "acc-1", error: null };
}

/**
 * The compiler refusing it, with the kind of message it really returns.
 *
 * The line number is part of the fixture on purpose: a refusal that drops it
 * leaves the caller rereading a script the server already pointed at.
 */
export function sieveInvalid(
  description = 'Syntax error at line 3: unknown command "fileintoo"',
): SieveScriptValidateResponse {
  return { accountId: "acc-1", error: { type: "invalidScript", description } };
}

/** A `SieveScript/set` answer creating one script under the creation key. */
export function sieveCreated(id: Id = "sc-new"): SetResponse<SieveScript> {
  return {
    accountId: "acc-1",
    oldState: "sieve-state-1",
    newState: "sieve-state-2",
    created: { new: { id } },
  };
}

/** A `SieveScript/set` answer updating one script. A `null` value is a success. */
export function sieveUpdated(id: Id): SetResponse<SieveScript> {
  return {
    accountId: "acc-1",
    oldState: "sieve-state-1",
    newState: "sieve-state-2",
    updated: { [id]: null },
  };
}

/**
 * The window the vacation fixtures are dated around.
 *
 * Fixed dates rather than dates relative to today: whether the reply is
 * answering is read off an instant the test names, and a fixture that moved with
 * the clock would make that assertion pass for a different reason every day.
 */
export const VACATION_WINDOW = { from: "2026-09-10T00:00:00Z", to: "2026-09-20T00:00:00Z" };

/** The vacation response as an account that has written one but left it off. */
export const VACATION_RESPONSE: VacationResponse = {
  id: VACATION_SINGLETON_ID,
  isEnabled: false,
  fromDate: VACATION_WINDOW.from,
  toDate: VACATION_WINDOW.to,
  subject: "Out of office",
  textBody: "Back on the 20th.",
  htmlBody: "<p>Back on the 20th.</p>",
};

/** The same object with the properties a test cares about moved. */
export function vacationWith(overrides: Partial<VacationResponse> = {}): VacationResponse {
  return { ...VACATION_RESPONSE, ...overrides };
}

/** A `VacationResponse/get` answer holding the singleton, and only it. */
export function vacationGet(
  response: VacationResponse = VACATION_RESPONSE,
): GetResponse<VacationResponse> {
  return {
    accountId: "acc-1",
    state: "vacation-state-1",
    list: [response],
    notFound: [],
  };
}

/** A `VacationResponse/set` answer accepting the update. Null is a success. */
export function vacationUpdated(): SetResponse<VacationResponse> {
  return {
    accountId: "acc-1",
    oldState: "vacation-state-1",
    newState: "vacation-state-2",
    updated: { [VACATION_SINGLETON_ID]: null },
  };
}

/**
 * A blob channel serving the text of each script, by blobId.
 *
 * The shared fake answers every download with the same constant bytes, which
 * would make two scripts read alike; a module whose whole job is to say what a
 * given script does cannot be tested against that.
 */
export function scriptBlobs(traffic: BlobTraffic): BlobChannel {
  return {
    upload: async (body, contentType) => {
      traffic.uploads.push({ body, contentType });
      return {
        accountId: "acc-1",
        blobId: UPLOADED_BLOB_ID,
        type: contentType,
        size: body.byteLength,
      };
    },
    download: async (blobId, name, type) => {
      traffic.downloads.push({ blobId, name, type });

      const text = SCRIPT_TEXTS[blobId];
      if (text === undefined) throw new Error(`No fixture text for blob ${blobId}`);

      return new TextEncoder().encode(text);
    },
  };
}
