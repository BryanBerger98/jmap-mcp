/** Maps JMAP failures onto errors an MCP client can act on. */

/** A problem-details document returned at the request level (RFC 8620 §3.6.1). */
export interface JmapProblem {
  type: string;
  status?: number;
  detail?: string;
  limit?: string;
}

export class JmapError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JmapError";
  }
}

/** A method-level error returned in place of a method response. */
export class JmapMethodError extends JmapError {
  constructor(
    type: string,
    readonly methodCallId: string,
    description?: string,
  ) {
    super(
      type,
      `JMAP method ${methodCallId} failed: ${type}${description ? ` — ${description}` : ""}`,
    );
    this.name = "JmapMethodError";
  }
}

/** The policy refused the call outright, or the client cannot confirm it. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/**
 * What a refused submission means, in words the caller can act on.
 *
 * Only the types a send can hit are listed. The rest keep their raw name: a
 * wrong explanation reads as authoritative, an unexplained type reads as a code
 * to look up.
 */
const SUBMISSION_SET_ERRORS: Record<string, string> = {
  forbiddenFrom: "this account may not send from that address",
  forbiddenToSend: "this account is not allowed to send right now",
  tooManyRecipients: "the message has more recipients than the server accepts",
};

export function explainSetError(type: string): string | undefined {
  return SUBMISSION_SET_ERRORS[type];
}

export function problemToError(problem: JmapProblem): JmapError {
  return new JmapError(problem.type, problem.detail ?? problem.type, problem.status);
}

/**
 * Turns a failed startup into a line naming what to fix.
 *
 * The server dies on stderr before any client ever sees it, so the message has
 * to point at the setting to correct — never at a stack trace.
 */
export function describeStartupFailure(error: unknown): string {
  if (error instanceof JmapError && (error.status === 401 || error.status === 403)) {
    return "The JMAP server refused the credentials. Check `bearerToken`: it may be expired, mistyped, or without access to this account.";
  }

  // `fetch` reports every transport failure as a TypeError: DNS, TLS, refused
  // connection. None of them are worth surfacing verbatim. The `cause` is what
  // tells them apart from a plain programming TypeError raised further down the
  // startup, which `describeStartupFailure` also wraps: undici always attaches
  // one, the language never does.
  if (error instanceof TypeError && error.cause !== undefined) {
    return "The JMAP server could not be reached. Check `sessionUrl` and that the host answers from this machine.";
  }

  return error instanceof Error ? error.message : String(error);
}
