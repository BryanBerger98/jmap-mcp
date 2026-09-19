/**
 * The boundary between the account's file storage and this machine's disk.
 *
 * Every path a tool is handed crosses this module before a byte moves. The rule
 * it enforces is one line long — nothing outside `files.localRoot` is readable or
 * writable — and the reason it takes more than one line is that a path is not the
 * file it names. `../` climbs out lexically, a symlink climbs out at resolution
 * time, and a check that only ran on the string would pass both.
 */

import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Config } from "../../config/schema.js";
import type { JmapSession } from "../../jmap/session.js";
import { CAPABILITY_CORE, type CoreCapability } from "../../jmap/types/core.js";

/** The configuration key a refusal names, spelled once. */
export const LOCAL_ROOT_KEY = "files.localRoot";

export type LocalPath = { ok: true; path: string } | { ok: false; refusal: string };

export type LocalBytes = { ok: true; bytes: Uint8Array } | { ok: false; refusal: string };

export type LocalStat =
  | { kind: "file"; size: number }
  | { kind: "directory" }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

/**
 * Whether an error from the filesystem says "not there" or "will not say".
 *
 * Only `ENOENT` and `ENOTDIR` describe a path that does not exist. `EACCES` on a
 * directory refusing a traverse, `ELOOP` on a symlink cycle, `EIO` on a failing
 * disk all describe a path this process cannot resolve — a different answer,
 * which must never be reported as an absence. Sending someone to look elsewhere
 * for a file that is right there is the one mistake this boundary can make while
 * still sounding certain.
 */
export function isAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** An errno as one clause, code included: `EACCES: permission denied, stat '/x'`. */
function describeErrno(error: unknown): string {
  return (error as Error).message;
}

/**
 * The refusal, spelled as a constant rather than built inside the check.
 *
 * A `run` that reaches the option again cannot narrow it from the `precheck`
 * that already refused, and it needs the same sentence without asking a function
 * that may hand back `undefined`.
 */
export const MISSING_ROOT_REFUSAL =
  `Refused: this server moves file bytes only inside a directory you have named, and ${LOCAL_ROOT_KEY} ` +
  "is not set. Set it to an absolute path in your configuration, then retry. Browsing, creating a " +
  "folder, organizing and deleting need no such directory and work as they are.";

/**
 * The refusal to raise from a `precheck` when no root was configured.
 *
 * It names the key rather than inventing a temporary directory: a working path
 * the user did not name is a path they do not watch.
 */
export function refuseMissingRoot(files: Config["files"]): string | undefined {
  return files.localRoot === undefined ? MISSING_ROOT_REFUSAL : undefined;
}

/**
 * The refusal to raise when the configured root is not a directory on this disk.
 *
 * Every other check compares a path to the root and never asks whether the root
 * is there. A directory that was renamed, deleted or left unmounted therefore
 * passes containment and fails at the last step: a deposit blames the file it
 * was told to read, and a fetch downloads the whole blob before `open` answers
 * `ENOENT` about a path nobody typed. Asked once, up front, the answer names the
 * setting that is wrong.
 *
 * Absence and permission are kept apart for the reason `statLocalFile` keeps
 * them apart: a root that exists but cannot be traversed is a mode to fix, not a
 * directory to create.
 */
export async function refuseUnusableRoot(root: string | undefined): Promise<string | undefined> {
  if (root === undefined) return MISSING_ROOT_REFUSAL;

  const entry = await statLocalFile(root);
  switch (entry.kind) {
    case "directory":
      return undefined;
    case "missing":
      return (
        `Refused: ${LOCAL_ROOT_KEY} names ${root}, and there is no such directory on this machine. ` +
        "Create it, or point the setting at a directory that exists, then retry. Nothing was transferred."
      );
    case "unreadable":
      return (
        `Refused: ${LOCAL_ROOT_KEY} names ${root}, which this server could not examine — ` +
        `${entry.reason}. Check the permissions on it and on the directories above it. ` +
        "Nothing was transferred."
      );
    default:
      return (
        `Refused: ${LOCAL_ROOT_KEY} names ${root}, which is a file, not a directory. Point the ` +
        "setting at a directory this server may read and write in. Nothing was transferred."
      );
  }
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
  if (!realRoot.ok)
    return { ok: false, refusal: unresolvable(`${LOCAL_ROOT_KEY} ${root}`, realRoot.reason) };

  const lexical = isAbsolute(target) ? resolve(target) : resolve(realRoot.path, target);
  const resolved = await resolveDeepest(lexical);
  if (!resolved.ok) return { ok: false, refusal: unresolvable(target, resolved.reason) };

  const path = resolved.path;
  if (path !== realRoot.path && !path.startsWith(realRoot.path + sep)) {
    return {
      ok: false,
      refusal:
        `Refused: ${target} resolves to ${path}, which is outside ${realRoot.path}. This server reads and ` +
        `writes local files only under the directory named by ${LOCAL_ROOT_KEY}.`,
    };
  }
  return { ok: true, path };
}

/**
 * The refusal for a path whose real target this process could not learn.
 *
 * Refusing is the only honest answer left: the containment check compares real
 * paths, and a name whose symlinks were never followed says nothing about where
 * the bytes would land. Passing it through would be a check in name only.
 */
function unresolvable(what: string, reason: string): string {
  return (
    `Refused: ${what} could not be resolved — ${reason}. This server follows every symlink before ` +
    `it decides whether a path is inside ${LOCAL_ROOT_KEY}, and it does not let through a path it ` +
    "could not check."
  );
}

/**
 * Existence and size, so a transfer can be refused before it starts.
 *
 * A failed `stat` is not automatically an absence. A path under a directory this
 * process may not traverse exists, and reporting it as missing would send the
 * caller looking for a file that is exactly where they said it was.
 */
export async function statLocalFile(path: string): Promise<LocalStat> {
  try {
    const entry = await stat(path);
    return entry.isDirectory() ? { kind: "directory" } : { kind: "file", size: entry.size };
  } catch (error) {
    return isAbsence(error)
      ? { kind: "missing" }
      : { kind: "unreadable", reason: describeErrno(error) };
  }
}

/**
 * Reads a local file, or refuses because it could not be read.
 *
 * The counterpart of the write below, and here for the same reason: every byte
 * that crosses between this machine and the account goes through this module,
 * so the path it touches has been through `resolveWithinRoot` first. A read that
 * fails between the check and here is answered with a sentence rather than a
 * stack trace — the file may have moved in between, and that is not a bug to
 * report but a call to run again.
 */
export async function readLocalFile(path: string): Promise<LocalBytes> {
  try {
    return { ok: true, bytes: new Uint8Array(await readFile(path)) };
  } catch (error) {
    return {
      ok: false,
      refusal: `Refused: reading ${path} failed — ${(error as Error).message}`,
    };
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

/** A real path, or the reason this process could not work one out. */
type DeepestPath = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The real path of the deepest ancestor that exists, with the missing tail
 * appended.
 *
 * `realpath` fails outright on a path that does not exist yet, and a fetch names
 * a file that is not there by definition. Walking up until something resolves
 * gives the same protection: every symlink on the existing part is followed, and
 * what is left cannot hide one because it does not exist.
 *
 * Only an absence justifies that walk. Any other errno means the symlinks at
 * that level were never followed, so climbing past it and gluing the tail back
 * on would produce a path that looks resolved and is not — the one output this
 * boundary must never produce.
 */
async function resolveDeepest(path: string): Promise<DeepestPath> {
  const missing: string[] = [];
  let existing = path;

  for (;;) {
    try {
      const real = await realpath(existing);
      return { ok: true, path: missing.length === 0 ? real : join(real, ...missing.reverse()) };
    } catch (error) {
      if (!isAbsence(error)) return { ok: false, reason: describeErrno(error) };

      const parent = dirname(existing);
      // The filesystem root itself did not resolve: nothing above to try, and
      // no answer to give but the failure.
      if (parent === existing) return { ok: false, reason: describeErrno(error) };
      missing.push(basename(existing));
      existing = parent;
    }
  }
}
