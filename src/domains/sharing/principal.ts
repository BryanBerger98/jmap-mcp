/**
 * Turning the ids a share is written in into names a person recognises.
 *
 * The keys of `shareWith` are principal ids, and so is `changedBy/principalId`
 * on a notification. Neither says who anyone is, and a listing of shares that
 * answers `p-4207` answers nothing.
 *
 * `Principal/get` is how they become addresses, and it is the one call in this
 * domain the server may refuse on principle: an administrator who leaves
 * `allowDirectoryQueries` off and withholds the `jmap` permissions gets a method
 * error `forbidden` rather than an empty list. That refusal is not a failure of
 * the read that asked for it. The share is still there, its beneficiary is still
 * an id, and the answer says so and shows the ids.
 *
 * Every other error travels. A transport failure answered from an empty
 * directory would render "no beneficiaries" over a share that has several.
 */

import { JmapMethodError } from "../../jmap/errors.js";
import type { GetResponse, Id } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_PRINCIPALS } from "../../jmap/types/core.js";
import type { Principal, PrincipalGetArguments } from "../../jmap/types/sharing.js";
import type { ToolContext } from "../../registry/define-tool.js";

/** Enough to name a principal, and nothing about what it may reach. */
const PRINCIPAL_PROPERTIES = ["id", "type", "name", "description", "email"] as const;

export interface PrincipalDirectory {
  /**
   * Whether the server refused to answer at all.
   *
   * A closed directory is not an empty one: it means every name below is the id
   * it started as, and the rendering has to say why rather than let a column of
   * opaque strings pass for an answer.
   */
  closed: boolean;
  /** The address of a principal, or the id when the directory does not know it. */
  nameOf: (id: Id) => string;
}

/**
 * Names for a set of principal ids, read once per invocation.
 *
 * Cached on the ids themselves rather than on the call: `precheck`, `summarize`
 * and `run` ask about the same beneficiaries, and three round trips would learn
 * the same thing three times.
 */
export async function resolvePrincipals(
  ids: readonly Id[],
  context: ToolContext,
): Promise<PrincipalDirectory> {
  const wanted = [...new Set(ids)].sort();
  if (wanted.length === 0) {
    return { closed: false, nameOf: (id) => id };
  }

  return context.once(`principals:${wanted.join(",")}`, async () => {
    const args: PrincipalGetArguments = {
      accountId: context.session.accountId,
      ids: [...wanted],
      properties: [...PRINCIPAL_PROPERTIES],
    };

    let response: GetResponse<Principal>;
    try {
      response = await context.client.request<GetResponse<Principal>>(
        [CAPABILITY_CORE, CAPABILITY_PRINCIPALS],
        ["Principal/get", args, "0"],
      );
    } catch (error) {
      if (error instanceof JmapMethodError && error.type === "forbidden") {
        return { closed: true, nameOf: (id: Id) => id };
      }
      throw error;
    }

    const byId = new Map(response.list.map((principal) => [principal.id, principal]));

    return {
      closed: false,
      nameOf: (id: Id) => {
        const principal = byId.get(id);
        return principal === undefined ? id : describePrincipal(principal);
      },
    };
  });
}

/**
 * A principal in one string.
 *
 * `name` and `email` are the same value on this server — both are filled from
 * the account login (`principal/get.rs`) — so only `description` adds anything,
 * and it is shown alongside the address rather than instead of it. The address
 * is what identifies an account; a label is what makes it recognisable.
 */
export function describePrincipal(principal: Principal): string {
  const address = principal.email ?? principal.name;
  if (address === undefined) return principal.id;

  const label = principal.description ?? undefined;

  return label === null || label === undefined || label === address
    ? address
    : `${label} <${address}>`;
}

/** The one sentence a closed directory owes the reader. */
export const CLOSED_DIRECTORY_NOTE =
  "The server refused Principal/get, so beneficiaries appear as raw ids: this instance has " +
  "directory queries disabled and does not grant the account permission to read principals.";
