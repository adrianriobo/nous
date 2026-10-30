import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEnmaasProvider } from "./enmaas.ts";
import { registerSubagentTools } from "./subagent-tools.ts";

// Load only the provider and the tools for the requested read-only role.
// Do not register delegation, MCP tools, skills, or write tools here.
export default function (pi: ExtensionAPI) {
  registerEnmaasProvider(pi);
  registerSubagentTools(pi, process.env.PI_NOUS_SUBAGENT_ROLE ?? "");
}
