import { readFileSync } from "node:fs";
import { DEFAULT_POLICY, type WritePolicy } from "../../src/config/policy.js";
import { OPEN_SCOPE, type RecipientScope } from "../../src/config/recipients.js";
import { type Config, DEFAULT_BULK_CONFIRM_ABOVE } from "../../src/config/schema.js";
import type { BlobChannel } from "../../src/jmap/blob.js";
import { JmapClient } from "../../src/jmap/client.js";
import { JmapSession } from "../../src/jmap/session.js";
import type {
  Id,
  Invocation,
  JmapRequest,
  JmapResponse,
  Session,
} from "../../src/jmap/types/core.js";
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
  /** Every byte transfer, so a test can assert on order against `requests`. */
  blobs: BlobTraffic;
}

export interface BlobTraffic {
  uploads: { body: Uint8Array; contentType: string }[];
  downloads: { blobId: Id; name: string; type: string }[];
}

/** The bytes the fake channel serves on every download. */
export const FIXTURE_BYTES = new TextEncoder().encode("fixture-bytes\n");

/** The blobId the fake channel hands back on every upload. */
export const UPLOADED_BLOB_ID = "blob-uploaded";

/**
 * A channel that moves nothing and remembers everything.
 *
 * It records rather than asserts: a test on the order of a deposit needs to see
 * that the upload happened before the `FileNode/set`, and only a shared log of
 * both can show that.
 */
export function fakeBlobs(traffic: BlobTraffic): BlobChannel {
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
      return FIXTURE_BYTES;
    },
  };
}

/**
 * Builds a tool context whose client answers with `results`, one per method
 * call, in the order the calls were made.
 *
 * The queue spans requests rather than restarting at each one: a tool that
 * reads before it writes spends several round trips, and its later calls need
 * answers of their own.
 */
/**
 * What a test may say about the context beyond the responses it queues.
 *
 * Every key admits `undefined` so a caller forwarding its own optional field
 * lands on the default instead of failing under `exactOptionalPropertyTypes`.
 */
export interface FakeTransportOptions {
  recipients?: RecipientScope | undefined;
  bulkConfirmAbove?: number | undefined;
  policy?: WritePolicy | undefined;
  files?: Config["files"] | undefined;
  /**
   * A blob channel of the test's own, built over the same traffic log.
   *
   * The default one answers every download with the same bytes, which is exactly
   * what a test about what a downloaded body says cannot use: two Sieve scripts
   * would read alike, and a detection running over their text would prove
   * nothing. Given here rather than swapped in afterwards, so the context a tool
   * receives is the one the test meant.
   */
  blobs?: ((traffic: BlobTraffic) => BlobChannel) | undefined;
}

export function fakeTransport(
  results: unknown[],
  {
    recipients = OPEN_SCOPE,
    bulkConfirmAbove = DEFAULT_BULK_CONFIRM_ABOVE,
    // The default the server ships with, so a test that says nothing about the
    // policy is testing the configuration almost everybody runs.
    policy = DEFAULT_POLICY,
    // No local directory unless the test names one, as in a fresh configuration.
    files = {},
    blobs: buildBlobs = fakeBlobs,
  }: FakeTransportOptions = {},
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
  const blobs: BlobTraffic = { uploads: [], downloads: [] };

  // One cache per context, as the registry builds one per handler invocation:
  // a test calling a hook directly stands in for exactly one such invocation.
  return {
    context: {
      client,
      session: fixtureSession(),
      blobs: buildBlobs(blobs),
      files,
      recipients,
      policy,
      bulkConfirmAbove,
      once: perInvocationCache(),
    },
    requests,
    blobs,
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
