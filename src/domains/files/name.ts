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
