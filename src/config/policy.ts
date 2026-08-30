/**
 * The write policy: what the server is allowed to do without asking.
 *
 * An operation class is a property of a *call*, not of a tool. The same tool may
 * read on one set of arguments and destroy on another, so the class is computed
 * from the arguments at call time — see `classify` on a tool definition.
 */

export const OPERATION_CLASSES = ["read", "draft", "send", "destroy"] as const;

export type OperationClass = (typeof OPERATION_CLASSES)[number];

export const POLICY_LEVELS = ["allow", "confirm", "deny"] as const;

export type PolicyLevel = (typeof POLICY_LEVELS)[number];

export type WritePolicy = Readonly<Record<OperationClass, PolicyLevel>>;

/** Irreversible classes ask before acting; reversible ones do not. */
export const DEFAULT_POLICY: WritePolicy = {
  read: "allow",
  draft: "allow",
  send: "confirm",
  destroy: "confirm",
};

export function levelFor(policy: WritePolicy, operation: OperationClass): PolicyLevel {
  return policy[operation];
}
