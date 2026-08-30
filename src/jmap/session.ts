import { JmapError } from "./errors.js";
import { CAPABILITY_CORE, type Id, type Session } from "./types/core.js";

/**
 * The discovered session. It answers two questions the registry needs before
 * composing: which capabilities this server advertises, and which account to act on.
 */
export class JmapSession {
  constructor(
    readonly raw: Session,
    readonly accountId: Id,
  ) {}

  /** Whether the server advertises a capability at the session level. */
  has(capability: string): boolean {
    return capability in this.raw.capabilities;
  }

  /** Whether the selected account exposes a capability. Session support is not enough. */
  accountHas(capability: string): boolean {
    const account = this.raw.accounts[this.accountId];
    return account !== undefined && capability in account.accountCapabilities;
  }

  get apiUrl(): string {
    return this.raw.apiUrl;
  }
}

export async function discoverSession(
  sessionUrl: string,
  bearerToken: string,
  preferredAccountId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JmapSession> {
  const response = await fetchImpl(sessionUrl, {
    headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json" },
  });

  if (!response.ok) {
    throw new JmapError(
      "about:blank",
      `JMAP session discovery failed: ${response.status}`,
      response.status,
    );
  }

  const session = (await response.json()) as Session;
  return new JmapSession(session, resolveAccountId(session, preferredAccountId));
}

function resolveAccountId(session: Session, preferred?: string): Id {
  if (preferred !== undefined) {
    if (!(preferred in session.accounts)) {
      throw new JmapError("about:blank", `Account ${preferred} is not in this JMAP session`);
    }
    return preferred;
  }

  const primary = session.primaryAccounts[CAPABILITY_CORE];
  if (primary !== undefined) return primary;

  const [first] = Object.keys(session.accounts);
  if (first === undefined) {
    throw new JmapError("about:blank", "JMAP session exposes no account");
  }
  return first;
}
