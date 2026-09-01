import { JmapError } from "./errors.js";
import type { JmapSession } from "./session.js";
import type { Id } from "./types/core.js";

export interface BlobUploadResult {
  accountId: Id;
  blobId: Id;
  type: string;
  size: number;
}

/**
 * The only way a tool moves bytes.
 *
 * Blobs travel over plain HTTP against the session's upload and download URLs,
 * not over the JMAP endpoint, so a tool that needed to reach them itself would
 * need the bearer token and both URL templates in hand. The channel closes over
 * all three: what reaches a tool is two methods, and nothing it could leak.
 */
export interface BlobChannel {
  upload: (body: Uint8Array, contentType: string) => Promise<BlobUploadResult>;
  /** `name` and `type` fill the URL template; the server may echo them back. */
  download: (blobId: Id, name: string, type: string) => Promise<Uint8Array>;
}

/**
 * Binds a channel to one session and one token.
 *
 * Built in `src/server.ts`, where the configuration still exists, and handed to
 * `compose()`. Nothing downstream ever sees the token again.
 */
export function blobChannel(
  session: JmapSession,
  bearerToken: string,
  fetchImpl: typeof fetch = fetch,
): BlobChannel {
  return {
    upload: (body, contentType) =>
      uploadBlob(
        session.raw.uploadUrl,
        session.accountId,
        bearerToken,
        body,
        contentType,
        fetchImpl,
      ),
    download: (blobId, name, type) =>
      downloadBlob(
        session.raw.downloadUrl,
        bearerToken,
        { accountId: session.accountId, blobId, name, type },
        fetchImpl,
      ),
  };
}

/**
 * The channel a composition falls back on when none was wired.
 *
 * It throws rather than returning empty bytes: a composition without a channel
 * is a wiring mistake, and a tool that quietly uploaded nothing would report a
 * success the account does not hold.
 */
export const UNWIRED_BLOBS: BlobChannel = {
  upload: () => {
    throw new JmapError("about:blank", "No blob channel was wired into this server");
  },
  download: () => {
    throw new JmapError("about:blank", "No blob channel was wired into this server");
  },
};

/** Uploads bytes and returns the blobId a later Set call can reference. */
export async function uploadBlob(
  uploadUrl: string,
  accountId: Id,
  bearerToken: string,
  body: Uint8Array,
  contentType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BlobUploadResult> {
  const response = await fetchImpl(expand(uploadUrl, { accountId }), {
    method: "POST",
    headers: { "Content-Type": contentType, Authorization: `Bearer ${bearerToken}` },
    body,
  });

  if (!response.ok) {
    throw new JmapError("about:blank", `Blob upload failed: ${response.status}`, response.status);
  }
  return (await response.json()) as BlobUploadResult;
}

export async function downloadBlob(
  downloadUrl: string,
  bearerToken: string,
  variables: { accountId: Id; blobId: Id; type: string; name: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(expand(downloadUrl, variables), {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });

  if (!response.ok) {
    throw new JmapError("about:blank", `Blob download failed: ${response.status}`, response.status);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Fills the `{name}` placeholders of a session URL template (RFC 8620 §6). */
function expand(template: string, variables: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = variables[key];
    return value === undefined ? match : encodeURIComponent(value);
  });
}
