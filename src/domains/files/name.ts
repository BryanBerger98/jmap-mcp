/**
 * What Stalwart will refuse a node to be called, checked before the request.
 *
 * The server would refuse these itself, in `invalidProperties` with no
 * description. Refusing here instead costs nothing and says which of the three
 * rules was broken — which is the difference between a user who fixes the name
 * and one who tries the same call again.
 *
 * The three lists are transcribed from `file/set.rs:40-45` and have no other
 * source: they are Stalwart's, not the draft's.
 */

/** `file/set.rs:40`. Windows reserves most of these; Stalwart refuses them all. */
const FORBIDDEN_CHARS = ["/", "<", ">", ":", '"', "\\", "|", "?", "*"];

/** `file/set.rs:41-45`. Compared without regard to case, as the server does. */
const RESERVED_NAMES = [
  ".",
  "..",
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 10 }, (_, digit) => `COM${digit}`),
  ...Array.from({ length: 10 }, (_, digit) => `LPT${digit}`),
];

/** Counted in bytes, not code points: an emoji name is shorter than it looks. */
export const MAX_NAME_BYTES = 255;

/** What a file whose extension says nothing is uploaded as. */
export const FALLBACK_MIME = "application/octet-stream";

/**
 * Deliberately short, and deliberately dependency-free.
 *
 * A full media-type table belongs to a library, not to this file. What is here
 * is the handful of extensions a person actually deposits from a desktop, and
 * everything else is honestly declared unknown rather than guessed at.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  xml: "application/xml",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * The media type a name suggests, or the fallback.
 *
 * Read off the name and nothing else: the bytes are not sniffed, so a file named
 * `.pdf` that holds something else is uploaded as a PDF. That is the caller's
 * statement about their own file, and this server has no better source for it.
 */
export function mimeTypeFor(name: string): string {
  const extension = name.includes(".") ? name.split(".").pop() : undefined;
  if (extension === undefined) return FALLBACK_MIME;

  return MIME_BY_EXTENSION[extension.toLowerCase()] ?? FALLBACK_MIME;
}

/**
 * A refusal sentence, or `undefined` when the name is acceptable.
 *
 * Shaped for a `precheck`, which returns exactly that.
 */
export function refuseInvalidName(name: string): string | undefined {
  const bytes = new TextEncoder().encode(name).byteLength;
  if (bytes === 0) {
    return "Refused: a file or folder name cannot be empty.";
  }
  if (bytes > MAX_NAME_BYTES) {
    return (
      `Refused: "${name}" is ${bytes} bytes long and a name may hold at most ${MAX_NAME_BYTES}. ` +
      "The limit counts bytes, not characters, so an accented or emoji name reaches it sooner than its length suggests."
    );
  }

  const offending = FORBIDDEN_CHARS.find((char) => name.includes(char));
  if (offending !== undefined) {
    return `Refused: "${name}" contains ${offending}, which this file storage does not allow in a name. The forbidden characters are ${FORBIDDEN_CHARS.join(" ")}`;
  }

  if (RESERVED_NAMES.some((reserved) => reserved.toLowerCase() === name.toLowerCase())) {
    return `Refused: "${name}" is a reserved name and cannot be used, in any case. The reserved names are ${RESERVED_NAMES.join(", ")}`;
  }

  return undefined;
}
