/**
 * What a Sieve script can do to mail, read off its source before it runs.
 *
 * Activating a script is a decision about every message that arrives afterwards,
 * and the name of the script says nothing about what it does. This module reads
 * the source and names the actions with a wide radius — the ones whose effect
 * reaches past "put this somewhere else in my own mailbox".
 *
 * The analysis is lexical and it over-detects on purpose. A `discard` announced
 * where none runs costs one sentence of unwarranted caution; a `discard` left
 * unannounced costs mail, silently, with no copy anywhere. Every trade-off here
 * is resolved in that direction: a word inside a string counts, a word in a
 * `require` list counts, and a branch that never executes counts too.
 *
 * Nothing here touches the network or the tool context: it takes a string and
 * returns actions.
 */

/**
 * The wide-radius actions, in the order a confirmation should read them.
 *
 * The order is severity, not the alphabet and not the RFC's: `discard` first
 * because the loss is silent and there is no trash to recover from, `redirect`
 * next because the mail leaves the account entirely, then the two refusals, the
 * automatic reply, and last the one that only moves a message within the
 * mailbox it was already going to reach.
 */
export const WIDE_RADIUS_ACTIONS = [
  "discard",
  "redirect",
  "reject",
  "ereject",
  "vacation",
  "fileinto",
] as const;

export type WideRadiusAction = (typeof WIDE_RADIUS_ACTIONS)[number];

/** What each action does to a message, in the terms a person arbitrates on. */
const CONSEQUENCE: Record<WideRadiusAction, string> = {
  discard: "drop messages with no copy kept anywhere",
  redirect: "send mail on to another address, out of this account",
  reject: "bounce mail back to whoever sent it",
  ereject: "refuse mail during the SMTP session, before it is ever accepted",
  vacation: "reply automatically to whoever wrote",
  fileinto: "file mail into a folder other than the inbox",
};

/**
 * The wide-radius actions a script names, in severity order.
 *
 * Word boundaries, so `ereject` is not read as a `reject` and a folder named
 * "Discarded" is not read as a `discard`. That is the one place the detection is
 * made narrower rather than wider, because those two would fire on every script
 * carrying the longer word and a warning that is always on warns about nothing.
 */
export function wideRadiusActions(text: string): WideRadiusAction[] {
  const code = stripComments(text);

  return WIDE_RADIUS_ACTIONS.filter((action) => new RegExp(`\\b${action}\\b`, "i").test(code));
}

/**
 * The actions spelled out for a confirmation, or a line saying there are none.
 *
 * The consequence is spelled beside every action rather than the keyword alone:
 * `ereject` is a word only somebody who has read RFC 5429 can arbitrate on, and
 * the person answering the question is not necessarily that person.
 */
export function describeRadius(actions: readonly WideRadiusAction[]): string {
  if (actions.length === 0) {
    return "It carries none of the actions that lose or forward mail, as far as reading it shows.";
  }

  const spelled = actions.map((action) => `${action} — ${CONSEQUENCE[action]}`);
  return `It can ${spelled.join("; ")}.`;
}

/**
 * The source with its comments removed, and its strings left alone.
 *
 * Written as a scanner rather than a pair of regular expressions because of one
 * case that runs the wrong way: `if header :is "subject" "#" { discard; }` has a
 * `#` inside a string, and a regular expression that cut the line at it would
 * drop the `discard` behind it. Strings are copied through untouched, so a
 * keyword inside one still counts — the harmless direction.
 */
function stripComments(text: string): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === '"') {
      const end = endOfString(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }

    if (char === "#") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      // A space, not nothing: two words either side of a comment must not fuse
      // into a third that neither of them is.
      out += " ";
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      out += " ";
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/** Where the string opening at `start` ends, past any escaped quote inside it. */
function endOfString(text: string, start: number): number {
  let index = start + 1;

  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }

  // Unterminated: the rest of the source is inside it. Returning the end keeps
  // the scanner from looping, and a script in this state does not compile.
  return text.length;
}
