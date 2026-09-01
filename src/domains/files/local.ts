/**
 * The boundary between the account's file storage and this machine's disk.
 *
 * Every path a tool is handed crosses this module before a byte moves. The rule
 * it enforces is one line long — nothing outside `files.localRoot` is readable or
 * writable — and the reason it takes more than one line is that a path is not the
 * file it names. `../` climbs out lexically, a symlink climbs out at resolution
 * time, and a check that only ran on the string would pass both.
 */

import { realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Config } from "../../config/schema.js";
import type { JmapSession } from "../../jmap/session.js";
import { CAPABILITY_CORE, type CoreCapability } from "../../jmap/types/core.js";

/** The configuration key a refusal names, spelled once. */
export const LOCAL_ROOT_KEY = "files.localRoot";

export type LocalPath = { ok: true; path: string } | { ok: false; refusal: string };

export type LocalStat =
  | { kind: "file"; size: number }
  | { kind: "directory" }
  | { kind: "missing" };

/**
 * The refusal to raise from a `precheck` when no root was configured.
 *
 * It names the key rather than inventing a temporary directory: a working path
 * the user did not name is a path they do not watch.
 */
export function refuseMissingRoot(files: Config["files"]): string | undefined {
  if (files.localRoot !== undefined) return undefined;

  return (
    `Refused: this server moves file bytes only inside a directory you have named, and ${LOCAL_ROOT_KEY} ` +
    "is not set. Set it to an absolute path in your configuration, then retry. Browsing, creating a " +
    "folder, organizing and deleting need no such directory and work as they are."
  );
}

/**
 * Resolves a path under the root, or refuses it.
 *
 * A relative path is taken from the root. An absolute one is accepted only if it
 * already lands inside it. Both are then resolved for real, because the string
 * `root/link` is inside the root and the file it points at need not be.
 */
export async function resolveWithinRoot(target: string, root: string): Promise<LocalPath> {
  const realRoot = await resolveDeepest(resolve(root));
  const lexical = isAbsolute(target) ? resolve(target) : resolve(realRoot, target);
  const path = await resolveDeepest(lexical);

  if (path !== realRoot && !path.startsWith(realRoot + sep)) {
    return {
      ok: false,
      refusal:
        `Refused: ${target} resolves to ${path}, which is outside ${realRoot}. This server reads and ` +
        `writes local files only under the directory named by ${LOCAL_ROOT_KEY}.`,
    };
  }
  return { ok: true, path };
}

/** Existence and size, so a transfer can be refused before it starts. */
export async function statLocalFile(path: string): Promise<LocalStat> {
  try {
    const entry = await stat(path);
    return entry.isDirectory() ? { kind: "directory" } : { kind: "file", size: entry.size };
  } catch {
    return { kind: "missing" };
  }
}

/**
 * Writes bytes, or refuses because something is already there.
 *
 * The exclusive flag does the checking, not a prior `stat`: between a check and a
 * write there is a window, and a fetch that overwrote a file the user had just
 * put there would be exactly the destruction this server never performs
 * unasked. Symmetrical with the deposit, which never overwrites either.
 */
export async function writeWithoutOverwrite(
  path: string,
  bytes: Uint8Array,
): Promise<string | undefined> {
  try {
    await writeFile(path, bytes, { flag: "wx" });
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return `Refused: ${path} already exists and this server never overwrites a local file. Pass a different name, or move the existing file aside.`;
    }
    return `Refused: writing ${path} failed — ${(error as Error).message}`;
  }
}

/**
 * The only upload ceiling the session publishes.
 *
 * Project memory long attributed a 25 MB `FileStorage.maxSize` to Stalwart; it
 * appears nowhere in `file/set.rs`. `maxSizeUpload` from the core capability is
 * real, and it is enforced at the HTTP upload point, before any `FileNode/set`.
 */
export function maxUploadSize(session: JmapSession): number | undefined {
  const core = session.raw.capabilities[CAPABILITY_CORE] as Partial<CoreCapability> | undefined;
  const stated = core?.maxSizeUpload;
  return stated !== undefined && stated > 0 ? stated : undefined;
}

/**
 * The real path of the deepest ancestor that exists, with the missing tail
 * appended.
 *
 * `realpath` fails outright on a path that does not exist yet, and a fetch names
 * a file that is not there by definition. Walking up until something resolves
 * gives the same protection: every symlink on the existing part is followed, and
 * what is left cannot hide one because it does not exist.
 */
async function resolveDeepest(path: string): Promise<string> {
  const missing: string[] = [];
  let existing = path;

  for (;;) {
    try {
      const real = await realpath(existing);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch {
      const parent = dirname(existing);
      // The filesystem root itself did not resolve: nothing above to try.
      if (parent === existing) return path;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}
