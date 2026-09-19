import { gzipSync } from "node:zlib";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_DOWNLOAD_SIZE_KEY } from "../../src/config/schema.js";
import { mailAttachmentFetch } from "../../src/domains/mail/attachment-fetch.js";
import type { BlobChannel } from "../../src/jmap/blob.js";
import type { GetResponse } from "../../src/jmap/types/core.js";
import type { Email, EmailBodyPart, EmailGetArguments } from "../../src/jmap/types/mail.js";
import { type BlobTraffic, fakeTransport } from "../fixtures/client.js";

function attachment(overrides: Partial<EmailBodyPart> = {}): EmailBodyPart {
  return {
    partId: null,
    blobId: "blob-1",
    type: "application/octet-stream",
    charset: null,
    size: 100,
    name: "file.bin",
    ...overrides,
  };
}

function messageWith(attachments: EmailBodyPart[]): Email {
  return {
    id: "em-300",
    threadId: "th-300",
    from: null,
    to: null,
    subject: null,
    receivedAt: "2026-01-01T00:00:00Z",
    hasAttachment: attachments.length > 0,
    size: 100,
    attachments,
  };
}

function only(email: Email): GetResponse<Email> {
  return { accountId: "acc-1", state: "email-state-1", list: [email], notFound: [] };
}

function notFound(id: string): GetResponse<Email> {
  return { accountId: "acc-1", state: "email-state-1", list: [], notFound: [id] };
}

/** Serves fixed bytes per blobId, rather than the same bytes on every download. */
function blobsServing(byBlobId: Record<string, Uint8Array>): (traffic: BlobTraffic) => BlobChannel {
  return (traffic) => ({
    upload: async () => {
      throw new Error("not used in these tests");
    },
    download: async (blobId, name, type) => {
      traffic.downloads.push({ blobId, name, type });
      const bytes = byBlobId[blobId];
      if (bytes === undefined) throw new Error(`no fixture bytes for blobId ${blobId}`);
      return bytes;
    },
  });
}

describe("mail_attachment_fetch arguments", () => {
  it("asks only for id and attachments, keyed by the one message id", async () => {
    const { context, requests } = fakeTransport([only(messageWith([attachment()]))], {
      blobs: blobsServing({ "blob-1": new TextEncoder().encode("hello") }),
    });

    await mailAttachmentFetch.run({ messageId: "em-300", blobId: "blob-1" }, context);
    const args = requests[0]?.methodCalls[0]?.[1] as EmailGetArguments;

    expect(args.ids).toEqual(["em-300"]);
    expect(args.properties).toEqual(["id", "attachments"]);
    expect(args.bodyProperties).toEqual(["partId", "blobId", "type", "charset", "size", "name"]);
  });

  it("classifies every call as a read and asks nothing extra", () => {
    expect(mailAttachmentFetch.classes).toEqual(["read"]);
    expect(mailAttachmentFetch.classify({ messageId: "em-300", blobId: "blob-1" })).toBe("read");
    expect(mailAttachmentFetch.confirmWhen).toBeUndefined();
    expect(mailAttachmentFetch.precheck).toBeUndefined();
  });
});

describe("mail_attachment_fetch refusals", () => {
  it("refuses an unknown message id, transferring nothing", async () => {
    const { context, blobs } = fakeTransport([notFound("em-404")]);

    const result = await mailAttachmentFetch.run(
      { messageId: "em-404", blobId: "blob-1" },
      context,
    );

    expect(result.text).toContain("no message has the id em-404");
    expect(blobs.downloads).toHaveLength(0);
  });

  it("refuses a blobId the message does not carry, transferring nothing", async () => {
    const { context, blobs } = fakeTransport([
      only(messageWith([attachment({ blobId: "blob-1" })])),
    ]);

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-does-not-exist" },
      context,
    );

    expect(result.text).toContain("carries no attachment with blobId blob-does-not-exist");
    expect(blobs.downloads).toHaveLength(0);
  });

  it("refuses an attachment past the download ceiling, before a byte moves", async () => {
    const { context, blobs } = fakeTransport(
      [only(messageWith([attachment({ blobId: "blob-big", size: 2048, name: "big.bin" })]))],
      { files: { maxDownloadSize: 1024 } },
    );

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-big" },
      context,
    );

    expect(result.text).toContain(MAX_DOWNLOAD_SIZE_KEY);
    expect(result.text).toContain("1024 bytes");
    expect(result.text).toContain('"big.bin"');
    expect(blobs.downloads).toHaveLength(0);
  });
});

describe("mail_attachment_fetch decoding", () => {
  it("gunzips a .gz attachment by default", async () => {
    const gzipped = gzipSync(Buffer.from("hello from a gzip attachment\n"));
    const { context } = fakeTransport(
      [
        only(
          messageWith([
            attachment({ blobId: "blob-gz", type: "application/gzip", name: "log.gz" }),
          ]),
        ),
      ],
      { blobs: blobsServing({ "blob-gz": gzipped }) },
    );

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-gz" },
      context,
    );

    expect(result.text).toContain("hello from a gzip attachment");
    expect(result.text).toContain("gunzipped");
  });

  it("unzips a single-entry .zip attachment by default", async () => {
    const zipped = zipSync({ "note.txt": new TextEncoder().encode("hello from a zip entry\n") });
    const { context } = fakeTransport(
      [
        only(
          messageWith([
            attachment({ blobId: "blob-zip", type: "application/zip", name: "bundle.zip" }),
          ]),
        ),
      ],
      { blobs: blobsServing({ "blob-zip": zipped }) },
    );

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-zip" },
      context,
    );

    expect(result.text).toContain("hello from a zip entry");
    expect(result.text).toContain("unzipped from note.txt");
  });

  it("unzips a multi-entry .zip attachment, each entry prefixed by its name", async () => {
    const zipped = zipSync({
      "a.txt": new TextEncoder().encode("content of a"),
      "b.txt": new TextEncoder().encode("content of b"),
    });
    const { context } = fakeTransport(
      [
        only(
          messageWith([
            attachment({ blobId: "blob-zip-many", type: "application/zip", name: "many.zip" }),
          ]),
        ),
      ],
      { blobs: blobsServing({ "blob-zip-many": zipped }) },
    );

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-zip-many" },
      context,
    );

    expect(result.text).toContain("== a.txt ==");
    expect(result.text).toContain("content of a");
    expect(result.text).toContain("== b.txt ==");
    expect(result.text).toContain("content of b");
    expect(result.text).toContain("unzipped, 2 entries");
  });

  it("returns a plain-text attachment as-is", async () => {
    const { context } = fakeTransport(
      [
        only(
          messageWith([attachment({ blobId: "blob-text", type: "text/plain", name: "notes.txt" })]),
        ),
      ],
      { blobs: blobsServing({ "blob-text": new TextEncoder().encode("plain notes") }) },
    );

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-text" },
      context,
    );

    expect(result.text).toContain("plain notes");
  });

  it("falls back to base64 for a binary attachment, and says so", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 254]);
    const { context } = fakeTransport(
      [
        only(
          messageWith([attachment({ blobId: "blob-bin", type: "image/png", name: "photo.png" })]),
        ),
      ],
      { blobs: blobsServing({ "blob-bin": bytes }) },
    );

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-bin" },
      context,
    );

    expect(result.text).toContain(Buffer.from(bytes).toString("base64"));
    expect(result.text).toContain("shown as base64");
  });

  it("always returns base64 with decode: raw, even for a gzip attachment", async () => {
    const gzipped = gzipSync(Buffer.from("would decode under auto"));
    const { context } = fakeTransport(
      [
        only(
          messageWith([
            attachment({ blobId: "blob-gz", type: "application/gzip", name: "log.gz" }),
          ]),
        ),
      ],
      { blobs: blobsServing({ "blob-gz": gzipped }) },
    );

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-gz", decode: "raw" },
      context,
    );

    expect(result.text).toContain(Buffer.from(gzipped).toString("base64"));
    expect(result.text).not.toContain("would decode under auto");
  });
});

describe("mail_attachment_fetch decompression bounds", () => {
  it("inflates a high-ratio gzip only up to the cut, and announces it", async () => {
    // 16 MiB of one byte compresses to about 16 KiB: a ratio of a thousand.
    const gzipped = gzipSync(Buffer.alloc(16 * 1024 * 1024, "a"));
    const { context } = fakeTransport(
      [
        only(
          messageWith([
            attachment({ blobId: "blob-bomb", type: "application/gzip", name: "bomb.gz" }),
          ]),
        ),
      ],
      { blobs: blobsServing({ "blob-bomb": gzipped }) },
    );

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-bomb", maxBytes: 300 },
      context,
    );

    expect(result.text).toContain(`${"a".repeat(300)}\n`);
    expect(result.text).not.toContain("a".repeat(301));
    expect(result.text).toContain("gunzipped");
    expect(result.text).toContain("output cut at 300 bytes");
  });

  it("skips a zip entry whose declared size passes the ceiling, and names it", async () => {
    const zipped = zipSync({
      "small.txt": new TextEncoder().encode("small entry"),
      "huge.txt": new Uint8Array(4096).fill(0x61),
    });
    const { context } = fakeTransport(
      [
        only(
          messageWith([
            attachment({
              blobId: "blob-zip",
              type: "application/zip",
              name: "mixed.zip",
              size: 200,
            }),
          ]),
        ),
      ],
      { files: { maxDownloadSize: 1024 }, blobs: blobsServing({ "blob-zip": zipped }) },
    );

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-zip" },
      context,
    );

    expect(result.text).toContain("== small.txt ==");
    expect(result.text).toContain("small entry");
    expect(result.text).not.toContain("aaaa");
    expect(result.text).toContain("1 entry skipped");
    expect(result.text).toContain("huge.txt");
  });

  it("leaves entries past the cut packed, and announces the cut", async () => {
    const zipped = zipSync({
      "first.txt": new Uint8Array(400).fill(0x61),
      "second.txt": new TextEncoder().encode("never reached"),
    });
    const { context } = fakeTransport(
      [
        only(
          messageWith([
            attachment({ blobId: "blob-zip", type: "application/zip", name: "two.zip", size: 200 }),
          ]),
        ),
      ],
      { blobs: blobsServing({ "blob-zip": zipped }) },
    );

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-zip", maxBytes: 300 },
      context,
    );

    expect(result.text).toContain("== first.txt ==");
    expect(result.text).not.toContain("never reached");
    expect(result.text).toContain("output cut at 300 bytes");
  });
});

describe("mail_attachment_fetch truncation", () => {
  it("cuts decoded output at maxBytes and announces the cut", async () => {
    // Strictly increasing 4-digit numbers, not a repeating pattern: a slice
    // past the cut cannot coincidentally reappear before it.
    const content = Array.from({ length: 75 }, (_, i) => String(i).padStart(4, "0")).join("");
    const { context } = fakeTransport(
      [
        only(
          messageWith([attachment({ blobId: "blob-text", type: "text/plain", name: "notes.txt" })]),
        ),
      ],
      { blobs: blobsServing({ "blob-text": new TextEncoder().encode(content) }) },
    );

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-text", maxBytes: 200 },
      context,
    );

    expect(result.text).toContain(content.slice(0, 200));
    expect(result.text).not.toContain(content.slice(200));
    expect(result.text).toContain("output cut at 200 bytes");
    expect(result.text).toContain("raising maxBytes");
  });

  it("does not announce a cut when the output fits", async () => {
    const { context } = fakeTransport(
      [
        only(
          messageWith([attachment({ blobId: "blob-text", type: "text/plain", name: "notes.txt" })]),
        ),
      ],
      { blobs: blobsServing({ "blob-text": new TextEncoder().encode("short") }) },
    );

    const result = await mailAttachmentFetch.run(
      { messageId: "em-300", blobId: "blob-text" },
      context,
    );

    expect(result.text).not.toContain("output cut at");
  });
});
