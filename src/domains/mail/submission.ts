import { checkRecipients, type RecipientScope } from "../../config/recipients.js";
import { explainSetError } from "../../jmap/errors.js";
import type { Id, SetResponse } from "../../jmap/types/core.js";
import type {
  Email,
  EmailAddress,
  EmailSubmission,
  EmailSubmissionSetArguments,
  Envelope,
  Identity,
} from "../../jmap/types/mail.js";
import { renderFields } from "../../shared/render.js";

/*
 * What putting a message on the wire takes, shared by the two tools that do it.
 *
 * `mail_compose` writes and may send in one request, `mail_send` sends a draft
 * written earlier. Both pick a sender, both weigh the recipients against the
 * perimeter, and both read the same answers back — so those pieces live here
 * rather than in whichever tool happened to need them first.
 */

/**
 * The creation id the draft is filed under.
 *
 * Stable rather than generated: one draft is created per call, and a fixed id is
 * what a later call in the same request points at with `#draft`.
 */
export const DRAFT_CREATION_ID = "draft";

/** The creation id the submission is filed under, so a patch can point at it. */
export const SUBMISSION_CREATION_ID = "submission";

/**
 * Only what picking a sender takes. Declared once because `mail_compose`,
 * `mail_send` and `mail_identities` read the same identities: a field dropped
 * here must disappear from every one of them at the same time, or one tool
 * starts rendering a property the server no longer returns.
 */
export const IDENTITY_PROPERTIES = ["id", "name", "email"] as const;

/** Only what locating the drafts and sent folders, and naming them, takes. */
export const MAILBOX_PROPERTIES = ["id", "name", "role"] as const;

/**
 * Refused before the submission, never after: a message sent with nowhere to
 * file it leaves the account with no trace of what went out.
 */
export const MISSING_SENT_FOLDER =
  "Refused: this account has no folder with the `sent` role, so a sent message would leave no " +
  "trace of having been sent. Create one on the mail server, or give an existing folder that role.";

/**
 * Picks the sender.
 *
 * With several identities and no designation, it refuses: sending as the wrong
 * address is the kind of mistake that cannot be taken back, and the account
 * owner is the only one who knows which of their addresses this message is from.
 */
export function pickIdentity(
  identities: Identity[],
  requested: string | undefined,
): Identity | { refusal: string } {
  if (requested !== undefined) {
    const found = identities.find((identity) => identity.id === requested);
    if (found === undefined) {
      return {
        refusal: `Refused: identity ${requested} is not one of this account's identities. Run mail_identities to list them.`,
      };
    }
    return found;
  }

  const [first, second] = identities;
  if (first === undefined) {
    return {
      refusal:
        "Refused: this account declares no sending identity, so a message has no address to come from.",
    };
  }
  if (second !== undefined) {
    return {
      refusal:
        `Refused: this account has ${identities.length} sending identities and none was designated. ` +
        "Pass identityId — run mail_identities to see them.",
    };
  }

  return first;
}

/**
 * The refusal the recipient perimeter raises, or `undefined` to go ahead.
 *
 * A list with no address passes: there is nobody to place inside or outside the
 * perimeter, and the missing recipient is refused on its own terms further on.
 */
export function outsidePerimeter(
  addresses: readonly string[],
  scope: RecipientScope,
): string | undefined {
  if (addresses.length === 0) return undefined;

  const verdict = checkRecipients(addresses, scope);
  return verdict.ok ? undefined : verdict.refusal;
}

/**
 * Who the message is actually delivered to, in order and without repeats.
 *
 * A recipient named twice, in `to` and in `cc`, is one delivery. Addresses are
 * compared verbatim: the local part is case-sensitive per RFC 5321, so folding
 * it here would merge two mailboxes that the server tells apart.
 */
export function uniqueRecipients(message: {
  to?: EmailAddress[] | null;
  cc?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
}): string[] {
  const addresses = [...(message.to ?? []), ...(message.cc ?? []), ...(message.bcc ?? [])];
  return [...new Set(addresses.map((address) => address.email))];
}

/**
 * Builds the submission and the move that follows it.
 *
 * The envelope is stated rather than derived: letting the server read the
 * headers means not knowing who receives the message. `onSuccessDestroyEmail`
 * is never emitted — the copy left in the sent folder is the only record of
 * what went out.
 */
export function buildSubmission(input: {
  accountId: Id;
  identityId: Id;
  mailFrom: string;
  /** The draft's id, or `#<creationId>` when it is created in the same request. */
  emailId: Id;
  recipients: string[];
  draftsId: Id;
  sentId: Id;
}): EmailSubmissionSetArguments {
  const envelope: Envelope = {
    mailFrom: { email: input.mailFrom },
    rcptTo: input.recipients.map((email) => ({ email })),
  };

  return {
    accountId: input.accountId,
    create: {
      [SUBMISSION_CREATION_ID]: {
        identityId: input.identityId,
        emailId: input.emailId,
        envelope,
      },
    },
    // Neither `sendAt` nor `undoStatus`: RFC 8621 reserves both to the server.
    onSuccessUpdateEmail: {
      [`#${SUBMISSION_CREATION_ID}`]: {
        [`mailboxIds/${input.draftsId}`]: null,
        [`mailboxIds/${input.sentId}`]: true,
        "keywords/$draft": null,
      },
    },
  };
}

/** A `SetError` is the server's own words: quoting it beats guessing at it. */
export function describeNotCreated(
  response: SetResponse<unknown>,
  creationId: Id = DRAFT_CREATION_ID,
): string | undefined {
  const error = response.notCreated?.[creationId];
  if (error === undefined) return undefined;

  const meaning = explainSetError(error.type);
  const detail = error.description === undefined ? "" : ` — ${error.description}`;
  const properties =
    error.properties === undefined || error.properties.length === 0
      ? ""
      : ` (properties: ${error.properties.join(", ")})`;
  const gloss = meaning === undefined ? "" : `\n\nThat error means ${meaning}.`;

  return `Refused by the mail server: ${error.type}${detail}${properties}${gloss}`;
}

/**
 * Reads the outcome of a submission.
 *
 * A move the server declined is reported rather than assumed away: the message
 * did leave, and a caller told otherwise would send it a second time.
 */
export function describeSubmission(
  submitted: SetResponse<EmailSubmission>,
  moved: SetResponse<Email> | undefined,
  details: { from: string; recipients: string[]; subject: string },
): string {
  const failure = describeNotCreated(submitted, SUBMISSION_CREATION_ID);
  if (failure !== undefined) return failure;

  const created = submitted.created?.[SUBMISSION_CREATION_ID];
  const [moveError] = Object.values(moved?.notUpdated ?? {});

  return renderFields({
    submissionId: created?.id ?? "(unknown)",
    emailId: created?.emailId ?? "",
    from: details.from,
    to: details.recipients.join(", "),
    subject: details.subject,
    status:
      moveError === undefined
        ? "sent, and moved to the sent folder"
        : `sent, but it could not be moved out of drafts: ${moveError.type}`,
  });
}
