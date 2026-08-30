import { JmapError, JmapMethodError, type JmapProblem, problemToError } from "./errors.js";
import type { Invocation, JmapRequest, JmapResponse } from "./types/core.js";

export interface JmapClientOptions {
  apiUrl: string;
  bearerToken: string;
  fetchImpl?: typeof fetch;
}

/**
 * Hand-written JMAP client. No published TypeScript library covers Calendars,
 * Contacts or File Storage, so the transport is ours end to end.
 */
export class JmapClient {
  private readonly apiUrl: string;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JmapClientOptions) {
    this.apiUrl = options.apiUrl;
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Issues one method call and returns its arguments, unwrapped. */
  async request<T>(using: string[], call: Invocation): Promise<T> {
    const [response] = await this.requestMany<[T]>(using, [call]);
    return response;
  }

  /**
   * Issues several method calls in one round trip. Later calls may point at an
   * earlier one through a back-reference, which is why they travel together.
   */
  async requestMany<T extends unknown[]>(using: string[], calls: Invocation[]): Promise<T> {
    const body: JmapRequest = { using, methodCalls: calls };

    const response = await this.fetchImpl(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.bearerToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw await toRequestError(response);
    }

    const parsed = (await response.json()) as JmapResponse;
    return parsed.methodResponses.map(unwrap) as T;
  }
}

function unwrap([name, args, callId]: Invocation): unknown {
  if (name === "error") {
    const { type, description } = args as { type: string; description?: string };
    throw new JmapMethodError(type, callId, description);
  }
  return args;
}

async function toRequestError(response: Response): Promise<JmapError> {
  try {
    return problemToError((await response.json()) as JmapProblem);
  } catch {
    return new JmapError("about:blank", `JMAP request failed: ${response.status}`, response.status);
  }
}
