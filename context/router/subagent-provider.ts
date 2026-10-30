import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEnmaasProvider } from "./enmaas.ts";

// Load only the provider in child processes. Do not register delegation or MCP tools.
export default function (pi: ExtensionAPI) {
  registerEnmaasProvider(pi);
}
