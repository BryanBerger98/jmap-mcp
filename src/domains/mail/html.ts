/**
 * What an HTML body says, read off its source before it is sent.
 *
 * Nothing filters the body on its way out: no tag is stripped, no attribute is
 * rewritten. The confirmation sentence is therefore the only thing left between
 * a body a model wrote and a message the user signs, and this module is what
 * that sentence shows.
 *
 * It shows two things, and the second exists because of what the first erases.
 * `htmlToText` degrades markup to readable prose, and the one thing it drops
 * that matters here is the target of a link — exactly what misleads a reader.
 * So the `href` values are listed on their own, beside the text they hide under.
 *
 * `src` attributes are not listed: an embedded image is out of scope of the
 * sending slice, from its own PRD onwards, so none can reach a body here.
 *
 * Nothing here touches the network or the tool context: it takes a string and
 * returns a string.
 */

import { htmlToText } from "../../shared/render.js";

/** How much of the degraded text the confirmation shows before it cuts. */
export const MAX_PREVIEW_CHARS = 1500;

/** How many links the confirmation lists before it says how many are left. */
export const MAX_LINKS = 20;

/**
 * Every `href` a body names, deduplicated, in the order they appear.
 *
 * The three quoting forms of HTML are accepted, unquoted included, because a
 * body written by hand is not guaranteed to be well formed and a target this
 * missed would be a target the user was never shown.
 *
 * Deliberately lexical, and deliberately over-detecting: an `href` inside a
 * comment or a `<script>` is listed too. Naming a link that never renders costs
 * one line of unwarranted caution; hiding one that does costs the whole reason
 * this list exists.
 *
 * The value is handed back as written, entities included. Decoding it would be
 * one more rewriting of a body nothing else rewrites, and the part a reader
 * arbitrates on — the host and the path — carries no entity to decode.
 */
export function htmlLinks(html: string): string[] {
  const pattern = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`=]+))/gi;
  const seen = new Set<string>();

  for (const match of html.matchAll(pattern)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (target !== "") seen.add(target);
  }

  return [...seen];
}

/**
 * The body as a person can read it: the degraded text, then its links.
 *
 * `htmlToText` is the same function `mail_read` degrades an incoming body with,
 * so both ends of the project read HTML the same way. The links block is left
 * out entirely when there is none, rather than rendered as an empty heading.
 */
export function describeHtmlBody(html: string): string {
  const blocks = [`As text, it reads:\n${previewText(html)}`];

  const links = htmlLinks(html);
  if (links.length > 0) blocks.push(`Links it carries:\n${linkList(links)}`);

  return blocks.join("\n\n");
}

/** The degraded text, cut at the cap while saying how much was left out. */
function previewText(html: string): string {
  const text = htmlToText(html);
  if (text.length <= MAX_PREVIEW_CHARS) return text;

  const omitted = new TextEncoder().encode(text.slice(MAX_PREVIEW_CHARS)).byteLength;
  return `${text.slice(0, MAX_PREVIEW_CHARS)}\n[cut here: ${omitted} more bytes of this body are not shown]`;
}

/** The targets, one per line, saying how many are not listed rather than stopping. */
function linkList(links: readonly string[]): string {
  const shown = links.slice(0, MAX_LINKS).map((link) => `- ${link}`);
  const rest = links.length - shown.length;

  return rest === 0 ? shown.join("\n") : [...shown, `- […and ${rest} more not shown]`].join("\n");
}
