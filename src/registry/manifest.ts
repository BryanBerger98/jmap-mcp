import type { ToolDefinition } from "./define-tool.js";

export interface DomainManifest {
  /** Prefix of every tool name in the domain, e.g. `mail`. */
  name: string;
  /**
   * JMAP capability URIs the domain needs. When the session does not advertise
   * all of them, the domain contributes no tool: gating by capability is what
   * keeps the exposed surface near twenty-six tools instead of drifting past thirty.
   */
  requires: readonly string[];
  tools: readonly ToolDefinition[];
}

export function defineDomain(manifest: DomainManifest): DomainManifest {
  return manifest;
}
