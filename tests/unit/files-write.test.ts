import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_ROOT_KEY } from "../../src/domains/files/local.js";
import { filesWrite } from "../../src/domains/files/write.js";
import { JmapSession } from "../../src/jmap/session.js";
import { CAPABILITY_CORE, type Invocation, type Session } from "../../src/jmap/types/core.js";
import type { ToolContext } from "../../src/registry/define-tool.js";
import { MAX_IDS_PER_CALL } from "../../src/shared/batch.js";
import {
  type FakeTransport,
  fakeTransport,
  loadFixture,
  UPLOADED_BLOB_ID,
} from "../fixtures/client.js";

/** A fresh directory per test: an upload reads from it, and each test owns its own. */
let root: string;

const DEPOSITED = "the bytes of a report\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jmap-mcp-write-"));
  await writeFile(join(root, "report.pdf"), DEPOSITED);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function transport(results: unknown[] = [], localRoot: string | undefined = root): FakeTransport {
  return fakeTransport(results, { files: { localRoot } });
}

function created(id: string, name: string) {
  return {
    accountId: "acc-1",
    oldState: "file-state-1",
    newState: "file-state-2",
    created: { new: { id, name } },
  };
}

function refusedCreation(type: string, description?: string) {
  return {
    accountId: "acc-1",
    oldState: "file-state-1",
    newState: "file-state-1",
    notCreated: { new: { type, description } },
  };
}

function updated(ids: readonly string[]) {
  return {
    accountId: "acc-1",
    oldState: "file-state-1",
    newState: "file-state-2",
    updated: Object.fromEntries(ids.map((id) => [id, null])),
  };
}

function calls(sent: FakeTransport["requests"]): Invocation[] {
  return sent.flatMap((request) => request.methodCalls);
}

/** The session's ceiling, lowered, so no test has to write fifty megabytes. */
function withUploadCeiling(context: ToolContext, ceiling: number): ToolContext {
  const raw = loadFixture<Session>("session.json");
  (raw.capabilities[CAPABILITY_CORE] as Record<string, unknown>).maxSizeUpload = ceiling;

  return { ...context, session: new JmapSession(raw, "acc-1") };
}

/**
 * Records how many JMAP calls had been sent when the upload started.
 *
 * The two logs are separate arrays, so the order between them is not readable
 * from either one. This is the only way to state it as an assertion.
 */
function watchOrder(sent: FakeTransport) {
  const sentBeforeUpload: number[] = [];
  const { upload } = sent.context.blobs;

  const context: ToolContext = {
    ...sent.context,
    blobs: {
      ...sent.context.blobs,
      upload: (body, contentType) => {
        sentBeforeUpload.push(sent.requests.length);
        return upload(body, contentType);
      },
    },
  };

  return { context, sentBeforeUpload };
}

describe("files_write, depositing a file", () => {
  it("uploads the bytes, then creates the node that points at them", async () => {
    const sent = transport([created("fn-9", "report.pdf")]);
    const { context, sentBeforeUpload } = watchOrder(sent);

    const result = await filesWrite.run({ action: "upload", path: "report.pdf" }, context);

    expect(sent.blobs.uploads).toEqual([
      { body: new TextEncoder().encode(DEPOSITED), contentType: "application/pdf" },
    ]);
    // Nothing had been sent when the upload began, and the create names the blob
    // the upload handed back: the two together fix the order.
    expect(sentBeforeUpload).toEqual([0]);
    expect(calls(sent.requests)[0]?.[1]).toMatchObject({
      create: {
        new: {
          nodeType: "file",
          name: "report.pdf",
          blobId: UPLOADED_BLOB_ID,
          type: "application/pdf",
        },
      },
    });
    expect(result.text).toContain("fn-9");
    expect(result.text).toContain("the top level");
  });

  it("names the node after the local file, unless the call says otherwise", async () => {
    const sent = transport([created("fn-9", "renamed.txt")]);

    await filesWrite.run(
      { action: "upload", path: "report.pdf", name: "renamed.txt" },
      sent.context,
    );

    expect(calls(sent.requests)[0]?.[1]).toMatchObject({
      create: { new: { name: "renamed.txt", type: "text/plain" } },
    });
  });

  it("refuses a file past the upload ceiling before a byte moves, and says the figure", async () => {
    const sent = transport();
    const context = withUploadCeiling(sent.context, 4);

    const refusal = await filesWrite.precheck?.({ action: "upload", path: "report.pdf" }, context);

    expect(refusal).toContain("4 B");
    expect(refusal).toContain("Nothing was transferred");
    expect(sent.blobs.uploads).toHaveLength(0);
    expect(sent.requests).toHaveLength(0);
  });

  it("refuses when no local directory is configured", async () => {
    const sent = fakeTransport([]);

    const refusal = await filesWrite.precheck?.(
      { action: "upload", path: "report.pdf" },
      sent.context,
    );

    expect(refusal).toContain(LOCAL_ROOT_KEY);
    expect(sent.blobs.uploads).toHaveLength(0);
  });

  it("refuses a path climbing out of the configured directory", async () => {
    const sent = transport();

    const refusal = await filesWrite.precheck?.(
      { action: "upload", path: "../elsewhere.pdf" },
      sent.context,
    );

    expect(refusal).toContain(LOCAL_ROOT_KEY);
    expect(sent.blobs.uploads).toHaveLength(0);
  });

  it("refuses a path that names nothing, and a directory", async () => {
    const sent = transport();
    await mkdir(join(root, "folder"));

    expect(
      await filesWrite.precheck?.({ action: "upload", path: "absent.pdf" }, sent.context),
    ).toContain("there is no file at");
    expect(
      await filesWrite.precheck?.({ action: "upload", path: "folder" }, sent.context),
    ).toContain("is a directory");
    expect(sent.blobs.uploads).toHaveLength(0);
  });

  it("sends a name conflict to files_delete, having replaced nothing", async () => {
    const sent = transport([refusedCreation("alreadyExists")]);

    const result = await filesWrite.run({ action: "upload", path: "report.pdf" }, sent.context);

    expect(result.text).toContain("files_delete");
    expect(await readFile(join(root, "report.pdf"), "utf8")).toBe(DEPOSITED);
  });

  it("says the bytes went up when the node they belong to is refused", async () => {
    const sent = transport([refusedCreation("alreadyExists")]);

    const result = await filesWrite.run({ action: "upload", path: "report.pdf" }, sent.context);

    // The upload cannot be undone from here, so the answer names it rather than
    // leaving an unreferenced blob to be discovered from a quota.
    expect(sent.blobs.uploads).toHaveLength(1);
    expect(result.text).toContain("The bytes were already transferred before this refusal");
  });

  it("says nothing about stray bytes when no upload happened", async () => {
    const sent = transport([refusedCreation("alreadyExists")]);

    const result = await filesWrite.run({ action: "create-folder", name: "reports" }, sent.context);

    expect(sent.blobs.uploads).toHaveLength(0);
    expect(result.text).not.toContain("already transferred");
  });

  it("refuses an unknown parent folder by reading it first", async () => {
    const sent = transport([{ accountId: "acc-1", state: "file-state-1", list: [], notFound: [] }]);

    const refusal = await filesWrite.precheck?.(
      { action: "upload", path: "report.pdf", parentId: "fn-404" },
      sent.context,
    );

    expect(refusal).toContain("no file node has the id fn-404");
    expect(sent.blobs.uploads).toHaveLength(0);
  });

  it("refuses a parent that is a file, not a folder", async () => {
    const sent = transport([
      {
        accountId: "acc-1",
        state: "file-state-1",
        list: [{ id: "fn-3", nodeType: "file", name: "report.pdf" }],
        notFound: [],
      },
    ]);

    const refusal = await filesWrite.precheck?.(
      { action: "create-folder", name: "Invoices", parentId: "fn-3" },
      sent.context,
    );

    expect(refusal).toContain("is a file, not a folder");
  });
});

describe("files_write, creating a folder", () => {
  it("creates a directory carrying neither bytes nor a MIME type", async () => {
    const sent = transport([created("fn-8", "Invoices")]);

    const result = await filesWrite.run(
      { action: "create-folder", name: "Invoices" },
      sent.context,
    );

    const args = calls(sent.requests)[0]?.[1] as { create: { new: Record<string, unknown> } };
    expect(args.create.new).toEqual({ nodeType: "directory", name: "Invoices" });
    expect(sent.blobs.uploads).toHaveLength(0);
    expect(result.text).toContain("fn-8");
  });

  it("refuses an invalid name before any request, naming what is wrong with it", async () => {
    const sent = transport();

    const refusal = await filesWrite.precheck?.(
      { action: "create-folder", name: "in:voices" },
      sent.context,
    );

    expect(refusal).toContain(":");
    expect(refusal).toContain("does not allow in a name");
    expect(sent.requests).toHaveLength(0);
  });
});

describe("files_write, organizing what is already there", () => {
  it("renames one node with a patch bounded to the name", async () => {
    const sent = transport([updated(["fn-3"])]);

    const result = await filesWrite.run(
      { action: "organize", ids: ["fn-3"], name: "final.pdf" },
      sent.context,
    );

    const args = calls(sent.requests)[0]?.[1] as { update: Record<string, object> };
    // The whole patch, not a subset: a rename that also carried a parent would
    // move the node somewhere nobody asked for.
    expect(args.update).toEqual({ "fn-3": { name: "final.pdf" } });
    expect(result.text).toContain("1 file node renamed.");
  });

  it("moves several nodes without moving a byte", async () => {
    const ids = ["fn-3", "fn-4", "fn-5"];
    const sent = transport([
      updated(ids),
      { accountId: "acc-1", state: "s", list: [], notFound: [] },
    ]);

    const result = await filesWrite.run(
      { action: "organize", ids, parentId: "fn-2" },
      sent.context,
    );

    expect(calls(sent.requests)[0]?.[1]).toMatchObject({
      update: {
        "fn-3": { parentId: "fn-2" },
        "fn-4": { parentId: "fn-2" },
        "fn-5": { parentId: "fn-2" },
      },
    });
    expect(sent.blobs.uploads).toHaveLength(0);
    expect(result.text).toContain("3 file nodes moved.");
  });

  it("moves a node to the top level with an explicit null", async () => {
    const sent = transport([updated(["fn-3"])]);

    await filesWrite.run({ action: "organize", ids: ["fn-3"], parentId: null }, sent.context);

    expect(calls(sent.requests)[0]?.[1]).toMatchObject({ update: { "fn-3": { parentId: null } } });
  });

  it("counts a repeated id once, as the update it builds already did", async () => {
    const sent = transport([updated(["fn-3"])]);

    const result = await filesWrite.run(
      { action: "organize", ids: ["fn-3", "fn-3"], parentId: "fn-2" },
      sent.context,
    );

    // The update map was always keyed by id, so it held one entry either way.
    // What used to disagree with it was the report, built over the raw list.
    const args = calls(sent.requests)[0]?.[1] as { update: Record<string, object> };
    expect(args.update).toEqual({ "fn-3": { parentId: "fn-2" } });
    expect(result.text).toContain("1 file node moved.");
  });

  it("refuses one name given for several nodes, before any request", async () => {
    const sent = transport();

    const refusal = await filesWrite.precheck?.(
      { action: "organize", ids: ["fn-3", "fn-4", "fn-5"], name: "same.pdf" },
      sent.context,
    );

    expect(refusal).toContain("cannot be shared");
    expect(sent.requests).toHaveLength(0);
  });

  it("refuses a call that would change nothing", async () => {
    const sent = transport();

    expect(
      await filesWrite.precheck?.({ action: "organize", ids: ["fn-3"] }, sent.context),
    ).toContain("nothing to change");
    expect(sent.requests).toHaveLength(0);
  });

  it("refuses more identifiers than one call may carry, before any question", async () => {
    const sent = transport();
    const ids = Array.from({ length: MAX_IDS_PER_CALL + 1 }, (_, index) => `fn-${index}`);

    const refusal = await filesWrite.precheck?.(
      { action: "organize", ids, parentId: "fn-2" },
      sent.context,
    );

    expect(refusal).toContain("file node ids");
    expect(refusal).toContain(String(MAX_IDS_PER_CALL));
    expect(sent.requests).toHaveLength(0);
  });

  it("asks past the volume threshold, while staying a draft", async () => {
    const sent = transport();
    const ids = Array.from({ length: 30 }, (_, index) => `fn-${index}`);
    const input = { action: "organize" as const, ids, parentId: "fn-2" };

    const reason = await filesWrite.confirmWhen?.(input, sent.context);

    expect(reason).toContain("30");
    expect(reason).toContain(String(sent.context.bulkConfirmAbove));
    expect(filesWrite.classify(input)).toBe("draft");
    expect(sent.requests).toHaveLength(0);
  });

  it("asks nothing at or below the threshold, nor on the two single-node actions", async () => {
    const { context } = transport();
    const ids = Array.from({ length: context.bulkConfirmAbove }, (_, index) => `fn-${index}`);

    expect(
      await filesWrite.confirmWhen?.({ action: "organize", ids, parentId: "fn-2" }, context),
    ).toBeUndefined();
    expect(
      await filesWrite.confirmWhen?.({ action: "upload", path: "report.pdf" }, context),
    ).toBeUndefined();
    expect(
      await filesWrite.confirmWhen?.({ action: "create-folder", name: "Invoices" }, context),
    ).toBeUndefined();
  });
});

describe("files_write destroys nothing, on any branch", () => {
  it("declares and classifies every action as a draft", () => {
    expect(filesWrite.classes).toEqual(["draft"]);
    expect(filesWrite.classify({ action: "upload", path: "report.pdf" })).toBe("draft");
    expect(filesWrite.classify({ action: "create-folder", name: "Invoices" })).toBe("draft");
    expect(filesWrite.classify({ action: "organize", ids: ["fn-3"], parentId: null })).toBe(
      "draft",
    );
  });

  it("carries no destruction and no replacement on any call it emits", async () => {
    const branches = [
      { action: "upload" as const, path: "report.pdf" },
      { action: "create-folder" as const, name: "Invoices" },
      { action: "organize" as const, ids: ["fn-3"], parentId: null },
    ];

    for (const input of branches) {
      const sent = transport([created("fn-9", "x"), updated(["fn-3"])]);
      await filesWrite.run(input, sent.context);

      for (const [name, args] of calls(sent.requests)) {
        expect(name).toBe("FileNode/set");
        expect(args).not.toHaveProperty("destroy");
        expect(args.onExists).toBeNull();
        expect(args.onDestroyRemoveChildren).toBe(false);
      }
    }
  });

  it("strips a destructive argument at the parse, so it never reaches the request", () => {
    const parsed = filesWrite.inputSchema.parse({
      action: "create-folder",
      name: "Invoices",
      onExists: "replace",
      onDestroyRemoveChildren: true,
    });

    expect(parsed).not.toHaveProperty("onExists");
    expect(parsed).not.toHaveProperty("onDestroyRemoveChildren");
  });

  it("refuses a call whose action lacks what that action needs", () => {
    expect(filesWrite.inputSchema.safeParse({ action: "upload" }).success).toBe(false);
    expect(filesWrite.inputSchema.safeParse({ action: "create-folder" }).success).toBe(false);
    expect(filesWrite.inputSchema.safeParse({ action: "organize" }).success).toBe(false);
  });
});
