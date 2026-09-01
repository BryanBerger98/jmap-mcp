import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LOCAL_ROOT_KEY,
  maxUploadSize,
  refuseMissingRoot,
  resolveWithinRoot,
  statLocalFile,
  writeWithoutOverwrite,
} from "../../src/domains/files/local.js";
import { fixtureSession } from "../fixtures/client.js";

/**
 * Two directories, neither inside the other: one stands in for the configured
 * root, the other for everything the server must never reach.
 */
let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "jmap-mcp-root-"));
  outside = await mkdtemp(join(tmpdir(), "jmap-mcp-outside-"));

  await writeFile(join(root, "present.txt"), "twelve bytes");
  await mkdir(join(root, "sub"));
  await writeFile(join(outside, "secret.txt"), "not yours");
  await symlink(outside, join(root, "escape"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("refuseMissingRoot", () => {
  it("names the configuration key to set", () => {
    const refusal = refuseMissingRoot({});

    expect(refusal).toBeDefined();
    expect(refusal).toContain(LOCAL_ROOT_KEY);
  });

  it("says which tools keep working without it", () => {
    expect(refuseMissingRoot({})).toMatch(/Browsing, creating a folder, organizing and deleting/);
  });

  it("lets the call through once a root is configured", () => {
    expect(refuseMissingRoot({ localRoot: "/somewhere" })).toBeUndefined();
  });
});

describe("resolveWithinRoot", () => {
  it("resolves a relative path against the root", async () => {
    const result = await resolveWithinRoot("sub/new.txt", root);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path.endsWith(join("sub", "new.txt"))).toBe(true);
  });

  it("accepts an absolute path that already lands inside the root", async () => {
    const result = await resolveWithinRoot(join(root, "present.txt"), root);

    expect(result.ok).toBe(true);
  });

  it("refuses a path climbing out with two dots, naming the root", async () => {
    const result = await resolveWithinRoot("../../etc/passwd", root);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toMatch(/outside/);
      expect(result.refusal).toContain(LOCAL_ROOT_KEY);
    }
  });

  it("refuses an absolute path outside the root", async () => {
    const result = await resolveWithinRoot(join(outside, "secret.txt"), root);

    expect(result.ok).toBe(false);
  });

  it("refuses a symlink pointing out of the root, after resolving it for real", async () => {
    // Lexically `root/escape/secret.txt` is inside the root; it is not.
    const result = await resolveWithinRoot("escape/secret.txt", root);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toMatch(/resolves to/);
  });

  it("resolves a target that does not exist yet, its parent being enough", async () => {
    const result = await resolveWithinRoot("sub/not-there-yet/deeper.txt", root);

    expect(result.ok).toBe(true);
  });

  // Root traverses a directory whatever its mode, so the case cannot be staged.
  it.skipIf(process.getuid?.() === 0)(
    "refuses a path it could not resolve rather than treating it as not there yet",
    async () => {
      const locked = join(root, "locked-resolve");
      await mkdir(locked);
      await symlink(outside, join(locked, "escape"));
      await chmod(locked, 0o000);

      try {
        // The link leaves the root, and the mode hides it. Walking up to the
        // last readable ancestor would hand back a name that is lexically
        // inside the root and really points at `outside`.
        const result = await resolveWithinRoot("locked-resolve/escape/secret.txt", root);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.refusal).toMatch(/could not be resolved/);
          expect(result.refusal).toContain("EACCES");
        }
      } finally {
        await chmod(locked, 0o700);
        await rm(locked, { recursive: true, force: true });
      }
    },
  );
});

describe("statLocalFile", () => {
  it("reads the size of a regular file", async () => {
    expect(await statLocalFile(join(root, "present.txt"))).toEqual({ kind: "file", size: 12 });
  });

  it("tells a directory apart from a file", async () => {
    expect(await statLocalFile(join(root, "sub"))).toEqual({ kind: "directory" });
  });

  it("reports a missing path rather than throwing", async () => {
    expect(await statLocalFile(join(root, "nowhere.txt"))).toEqual({ kind: "missing" });
  });

  // Root traverses a directory whatever its mode, so the case cannot be staged.
  it.skipIf(process.getuid?.() === 0)(
    "tells a path it may not read apart from one that is not there",
    async () => {
      const locked = join(root, "locked-stat");
      await mkdir(locked);
      await writeFile(join(locked, "inside.txt"), "present");
      await chmod(locked, 0o000);

      try {
        const entry = await statLocalFile(join(locked, "inside.txt"));

        // The file exists. Calling it missing would send the caller looking for
        // it somewhere else instead of at the permission that hides it.
        expect(entry.kind).toBe("unreadable");
        if (entry.kind === "unreadable") expect(entry.reason).toContain("EACCES");
      } finally {
        await chmod(locked, 0o700);
        await rm(locked, { recursive: true, force: true });
      }
    },
  );
});

describe("writeWithoutOverwrite", () => {
  it("writes bytes to a free path", async () => {
    const path = join(root, "written.txt");

    expect(await writeWithoutOverwrite(path, new TextEncoder().encode("hello"))).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("hello");
  });

  it("refuses an occupied path and leaves the existing file untouched", async () => {
    const path = join(root, "present.txt");

    const refusal = await writeWithoutOverwrite(path, new TextEncoder().encode("clobbered"));

    expect(refusal).toMatch(/already exists/);
    expect(await readFile(path, "utf8")).toBe("twelve bytes");
  });
});

describe("maxUploadSize", () => {
  it("reads maxSizeUpload off the core capability", () => {
    expect(maxUploadSize(fixtureSession())).toBe(52428800);
  });

  it("returns undefined when the session states no ceiling", () => {
    const session = fixtureSession();
    const bare = Object.create(Object.getPrototypeOf(session), {
      raw: { value: { ...session.raw, capabilities: {} } },
      accountId: { value: session.accountId },
    });

    expect(maxUploadSize(bare)).toBeUndefined();
  });
});
