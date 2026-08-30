import { JmapError } from "./errors.js";
import type { Id } from "./types/core.js";

export interface BlobUploadResult {
  accountId: Id;
  blobId: Id;
  type: string;
  size: number;
}

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
