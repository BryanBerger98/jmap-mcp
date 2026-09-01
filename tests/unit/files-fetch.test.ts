import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesFetch } from "../../src/domains/files/fetch.js";
import { LOCAL_ROOT_KEY } from "../../src/domains/files/local.js";
import type { GetResponse } from "../../src/jmap/types/core.js";
import type { FileNode } from "../../src/jmap/types/filenode.js";
import { FIXTURE_BYTES, fakeTransport, loadFixture } from "../fixtures/client.js";

const NODES = loadFixture<GetResponse<FileNode>>("file-node-get.json");

/** A fresh directory per test: a fetch writes, and the next test must not see it. */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jmap-mcp-fetch-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function only(id: string): GetResponse<FileNode> {
  return {
    accountId: "acc-1",
    state: "file-state-1",
    list: NODES.list.filter((node) => node.id === id),
    notFound: [],
  };
}

function transport(id: string, localRoot: string | undefined = root) {
  return fakeTransport([only(id)], undefined, undefined, undefined, { localRoot });
}

describe("files_fetch guards", () => {
  it("refuses before any read when no local directory is configured", async () => {
    const { context, requests } = fakeTransport([]);

    const refusal = await filesFetch.precheck?.({ id: "fn-3" }, context);

    expect(refusal).toContain(LOCAL_ROOT_KEY);
    expect(requests).toHaveLength(0);
  });

  it("lets the call through once a directory is configured", async () => {
    const { context } = transport("fn-3");

    expect(await filesFetch.precheck?.({ id: "fn-3" }, context)).toBeUndefined();
  });

  it("classifies every call as a read and asks nothing extra", () => {
    expect(filesFetch.classes).toEqual(["read"]);
    expect(filesFetch.classify({ id: "fn-3" })).toBe("read");
    expect(filesFetch.confirmWhen).toBeUndefined();
  });
});

describe("files_fetch", () => {
  it("writes the bytes to the local directory and answers with the path", async () => {
    const { context, blobs } = transport("fn-3");

    const result = await filesFetch.run({ id: "fn-3" }, context);

    expect(blobs.downloads).toEqual([
      { blobId: "blob-report", name: "report.pdf", type: "application/pdf" },
    ]);
    expect(await readFile(join(root, "report.pdf"))).toEqual(Buffer.from(FIXTURE_BYTES));
    expect(result.text).toContain(join(root, "report.pdf"));
    expect(result.text).toContain(`${FIXTURE_BYTES.byteLength} bytes`);
    expect(result.text).toContain("mime: application/pdf");
  });

  it("hands back no byte of the file, raw or encoded", async () => {
    const { context } = transport("fn-3");

    const result = await filesFetch.run({ id: "fn-3" }, context);

    expect(result.text).not.toContain("fixture-bytes");
    expect(result.text).not.toContain(Buffer.from(FIXTURE_BYTES).toString("base64"));
  });

  it("honours saveAs, relative to the configured directory", async () => {
    const { context } = transport("fn-3");

    const result = await filesFetch.run({ id: "fn-3", saveAs: "renamed.pdf" }, context);

    expect(result.text).toContain(join(root, "renamed.pdf"));
  });

  it("refuses a folder by name, transferring nothing", async () => {
    const { context, blobs } = transport("fn-1");

    const result = await filesFetch.run({ id: "fn-1" }, context);

    expect(result.text).toContain("Documents (fn-1)");
    expect(result.text).toContain("is a folder");
    expect(blobs.downloads).toHaveLength(0);
  });

  it("refuses a node carrying no blobId, naming it", async () => {
    const { context, blobs } = fakeTransport(
      [
        {
          accountId: "acc-1",
          state: "file-state-1",
          list: [{ id: "fn-9", nodeType: "file", name: "empty.bin", blobId: null }],
          notFound: [],
        },
      ],
      undefined,
      undefined,
      undefined,
      { localRoot: root },
    );

    const result = await filesFetch.run({ id: "fn-9" }, context);

    expect(result.text).toContain("empty.bin (fn-9)");
    expect(result.text).toContain("no blobId");
    expect(blobs.downloads).toHaveLength(0);
  });

  it("refuses an unknown id", async () => {
    const { context } = fakeTransport(
      [{ accountId: "acc-1", state: "file-state-1", list: [], notFound: ["fn-404"] }],
      undefined,
      undefined,
      undefined,
      { localRoot: root },
    );

    expect((await filesFetch.run({ id: "fn-404" }, context)).text).toContain(
      "no file node has the id fn-404",
    );
  });

  it("refuses an occupied target and leaves the existing file intact", async () => {
    await writeFile(join(root, "report.pdf"), "mine");
    const { context, blobs } = transport("fn-3");

    const result = await filesFetch.run({ id: "fn-3" }, context);

    expect(result.text).toContain("already exists");
    expect(await readFile(join(root, "report.pdf"), "utf8")).toBe("mine");
    // Refused before the transfer, not after it: the bytes never left the server.
    expect(blobs.downloads).toHaveLength(0);
  });

  it("refuses a saveAs climbing out of the configured directory", async () => {
    const { context, blobs } = transport("fn-3");

    const result = await filesFetch.run({ id: "fn-3", saveAs: "../escaped.pdf" }, context);

    expect(result.text).toContain(LOCAL_ROOT_KEY);
    expect(blobs.downloads).toHaveLength(0);
  });

  it("moves bytes through the blob channel and never through a JMAP call", async () => {
    const { context, requests } = transport("fn-3");

    await filesFetch.run({ id: "fn-3" }, context);

    const methods = requests.flatMap((request) => request.methodCalls.map(([name]) => name));
    expect(methods).toEqual(["FileNode/get"]);
  });
});
