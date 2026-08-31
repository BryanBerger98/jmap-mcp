import { CLIENT_CAPABILITIES_META_KEY, type McpServer } from "@modelcontextprotocol/server";

/**
 * Whether the client can be asked to confirm.
 *
 * One function knows where the answer lives, and it never guesses: a `confirm`
 * level that cannot reach the user must refuse, not execute. Closed failure is
 * the whole point — an uncertainty about the client resolving into a send is
 * exactly the accident the policy exists to prevent.
 */

/** The shape read off the envelope. Only the presence of a key is ever tested. */
type DeclaredCapabilities = Record<string, unknown>;

/** What a handler needs to expose for the capability to be readable at all. */
export interface ElicitationProbe {
  envelope?: Record<string, unknown>;
}

export function clientCanElicit(server: McpServer, mcpReq: ElicitationProbe): boolean {
  // The per-request envelope is the recommended path: on protocol revision
  // 2026-07-28 every request carries the capabilities the client declared.
  const fromEnvelope = mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY];
  if (isRecord(fromEnvelope)) return declaresElicitation(fromEnvelope);

  // Deprecated, but still fed per request from the validated envelope, and the
  // only source on a 2025-era connection. Read defensively: a handler may be
  // driven by something that is not a fully built server.
  const accessor = server.server?.getClientCapabilities;
  if (typeof accessor === "function") {
    const fromAccessor = accessor.call(server.server);
    if (isRecord(fromAccessor)) return declaresElicitation(fromAccessor);
  }

  // Neither source answered: the capability is undecidable, so it is absent.
  return false;
}

/**
 * A declined or cancelled elicitation is never read here. Refusing an answer is
 * a decision the user made; not being able to answer is a property of the client.
 */
function declaresElicitation(capabilities: DeclaredCapabilities): boolean {
  return capabilities.elicitation !== undefined;
}

function isRecord(value: unknown): value is DeclaredCapabilities {
  return typeof value === "object" && value !== null;
}
