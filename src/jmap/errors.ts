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

export function problemToError(problem: JmapProblem): JmapError {
  return new JmapError(problem.type, problem.detail ?? problem.type, problem.status);
}
