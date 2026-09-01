/** RFC 8620 — JMAP core: session, request/response envelope, set errors. */

export type Id = string;

export const CAPABILITY_CORE = "urn:ietf:params:jmap:core";
export const CAPABILITY_MAIL = "urn:ietf:params:jmap:mail";
export const CAPABILITY_SUBMISSION = "urn:ietf:params:jmap:submission";
export const CAPABILITY_VACATION = "urn:ietf:params:jmap:vacationresponse";
export const CAPABILITY_SIEVE = "urn:ietf:params:jmap:sieve";
export const CAPABILITY_CONTACTS = "urn:ietf:params:jmap:contacts";
export const CAPABILITY_CALENDARS = "urn:ietf:params:jmap:calendars";
export const CAPABILITY_PRINCIPALS = "urn:ietf:params:jmap:principals";
/**
 * Carries `Principal/getAvailability`, and is advertised unconditionally.
 *
 * Stalwart announces it whatever `allowDirectoryQueries` says, while the
 * permission behind the method is withdrawn when that setting is off. Gating on
 * this URI therefore proves the method exists, never that it will answer.
 */
export const CAPABILITY_PRINCIPALS_AVAILABILITY = "urn:ietf:params:jmap:principals:availability";
export const CAPABILITY_FILENODE = "urn:ietf:params:jmap:filenode";

export interface CoreCapability {
  maxSizeUpload: number;
  maxConcurrentUpload: number;
  maxSizeRequest: number;
  maxConcurrentRequests: number;
  maxCallsInRequest: number;
  maxObjectsInGet: number;
  maxObjectsInSet: number;
  collationAlgorithms: string[];
}

export interface Account {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
}

export interface Session {
  capabilities: Record<string, unknown>;
  accounts: Record<Id, Account>;
  primaryAccounts: Record<string, Id>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
}

/** A single method call in a request: [name, arguments, client id]. */
export type Invocation = [string, Record<string, unknown>, string];

export interface JmapRequest {
  using: string[];
  methodCalls: Invocation[];
  createdIds?: Record<Id, Id>;
}

export interface JmapResponse {
  methodResponses: Invocation[];
  createdIds?: Record<Id, Id>;
  sessionState: string;
}

/** A back-reference: resolves against an earlier response in the same request. */
export interface ResultReference {
  resultOf: string;
  name: string;
  path: string;
}

export interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

export interface GetResponse<T> {
  accountId: Id;
  state: string;
  list: T[];
  notFound: Id[];
}

export interface QueryResponse {
  accountId: Id;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  ids: Id[];
  total?: number;
  limit?: number;
}

export interface SetResponse<T> {
  accountId: Id;
  oldState: string | null;
  newState: string;
  created?: Record<Id, T>;
  updated?: Record<Id, T | null>;
  destroyed?: Id[];
  notCreated?: Record<Id, SetError>;
  notUpdated?: Record<Id, SetError>;
  notDestroyed?: Record<Id, SetError>;
}
