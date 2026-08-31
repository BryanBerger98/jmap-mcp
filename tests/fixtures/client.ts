import { readFileSync } from "node:fs";
import { OPEN_SCOPE, type RecipientScope } from "../../src/config/recipients.js";
import { JmapClient } from "../../src/jmap/client.js";
import { JmapSession } from "../../src/jmap/session.js";
import type { Invocation, JmapRequest, JmapResponse, Session } from "../../src/jmap/types/core.js";
import { perInvocationCache, type ToolContext } from "../../src/registry/define-tool.js";

/**
 * A JMAP transport backed by the fixtures on disk.
 *
 * No test opens a socket, and every emitted request is kept so a test can
 * assert on the arguments a tool sent, not only on what it rendered.
 */

const API_URL = "https://mail.example.com/jmap/";

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")) as T;
}

export function fixtureSession(accountId = "acc-1"): JmapSession {
  return new JmapSession(loadFixture<Session>("session.json"), accountId);
}

export interface FakeTransport {
  context: ToolContext;
  /** Every JMAP request body sent, in order. Its length is the round-trip count. */
  requests: JmapRequest[];
}

/**
 * Builds a tool context whose client answers with `results`, one per method
 * call, in the order the calls were made.
 *
 * The queue spans requests rather than restarting at each one: a tool that
 * reads before it writes spends several round trips, and its later calls need
 * answers of their own.
 */
export function fakeTransport(
  results: unknown[],
  recipients: RecipientScope = OPEN_SCOPE,
): FakeTransport {
  const requests: JmapRequest[] = [];
  let served = 0;

  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as JmapRequest;
    requests.push(request);

    const body: JmapResponse = {
      methodResponses: request.methodCalls.flatMap((call) =>
        [call[0], ...implicitResponses(call)].map(
          (name): Invocation => [
            name,
            (results[served++] ?? {}) as Record<string, unknown>,
            call[2],
          ],
        ),
      ),
      sessionState: "session-state-1",
    };

    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new JmapClient({ apiUrl: API_URL, bearerToken: "a-token", fetchImpl });

  // One cache per context, as the registry builds one per handler invocation:
  // a test calling a hook directly stands in for exactly one such invocation.
  return {
    context: { client, session: fixtureSession(), recipients, once: perInvocationCache() },
    requests,
  };
}

/**
 * The responses a call produces on top of its own.
 *
 * A submission carrying `onSuccessUpdateEmail` makes the server run an implicit
 * `Email/set`, and append its response to the request (RFC 8621 §7.5). A fake
 * that ignored it would hand every later call the wrong response.
 */
function implicitResponses([name, args]: Invocation): string[] {
  return name === "EmailSubmission/set" && args.onSuccessUpdateEmail !== undefined
    ? ["Email/set"]
    : [];
}
