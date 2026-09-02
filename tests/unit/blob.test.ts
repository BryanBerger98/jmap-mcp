import { describe, expect, it } from "vitest";
import { blobChannel } from "../../src/jmap/blob.js";
import { JmapError } from "../../src/jmap/errors.js";
import { JmapSession } from "../../src/jmap/session.js";
import type { Session } from "../../src/jmap/types/core.js";
import { loadFixture } from "../fixtures/client.js";

/**
 * The seam the module leaves open on purpose.
 *
 * `uploadBlob` and `downloadBlob` are private — anything holding one holds the
 * bearer token — so a test reaches them the only way a caller can, through the
 * channel, with `fetch` replaced. The fake context of `tests/fixtures/client.ts`
 * substitutes the whole channel and therefore never runs this code.
 */
function channel(answer: Response) {
  const session = new JmapSession(loadFixture<Session>("session.json"), "acc-1");
  return blobChannel(session, "token-1", () => Promise.resolve(answer));
}

const BYTES = new TextEncoder().encode("some bytes");

describe("the blob channel, reading what an upload answered", () => {
  it("hands back the result when the body names a blobId", async () => {
    const result = await channel(
      Response.json({ accountId: "acc-1", blobId: "blob-7", type: "text/plain", size: 10 }),
    ).upload(BYTES, "text/plain");

    expect(result.blobId).toBe("blob-7");
  });

  it("raises a named error on a body that is not JSON", async () => {
    // Otherwise a bare SyntaxError escapes this module, which every other
    // failure here reports as a JmapError.
    await expect(
      channel(new Response("<html>proxy error</html>", { status: 200 })).upload(
        BYTES,
        "text/plain",
      ),
    ).rejects.toThrow(JmapError);
    await expect(
      channel(new Response("<html>proxy error</html>", { status: 200 })).upload(
        BYTES,
        "text/plain",
      ),
    ).rejects.toThrow("not JSON");
  });

  it("raises rather than returning a result with no blobId", async () => {
    // The id is the whole point of the round trip: `FileNode/set` drops an
    // undefined blobId and creates a node holding nothing, while the tool
    // reports the size it read off the local disk.
    await expect(
      channel(Response.json({ accountId: "acc-1", type: "text/plain", size: 10 })).upload(
        BYTES,
        "text/plain",
      ),
    ).rejects.toThrow("no blobId");
  });

  it("raises on an empty blobId, which is no id at all", async () => {
    await expect(
      channel(
        Response.json({ accountId: "acc-1", blobId: "", type: "text/plain", size: 10 }),
      ).upload(BYTES, "text/plain"),
    ).rejects.toThrow("no blobId");
  });

  it("raises on a body that is not an object", async () => {
    await expect(channel(Response.json(null)).upload(BYTES, "text/plain")).rejects.toThrow(
      "no blobId",
    );
  });

  it("raises on a failing status before it reads any body", async () => {
    await expect(
      channel(new Response("", { status: 413 })).upload(BYTES, "text/plain"),
    ).rejects.toThrow("Blob upload failed: 413");
  });
});
