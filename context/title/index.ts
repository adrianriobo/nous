/**
 * Window title
 *
 * Sets the terminal window title from NOUS_TITLE. The escape sequence goes
 * from the container through the pseudo-terminal to the host terminal.
 *
 * Sources, in order:
 *   1. /title <text>  — this session only
 *   2. NOUS_TITLE     — environment
 *   3. pi default     — "π - <session name> - <cwd>"
 */
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENV_VAR = "NOUS_TITLE";

/** Remove control characters. The terminal title must stay on one line. */
function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function envTitle(): string | undefined {
  const raw = process.env[ENV_VAR];
  if (!raw) return undefined;
  return clean(raw) || undefined;
}

/** Same format as the pi default title. Used by /title reset. */
function piDefaultTitle(pi: ExtensionAPI): string {
  const cwd = path.basename(process.cwd());
  const session = pi.getSessionName();
  return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

export default function (pi: ExtensionAPI) {
  let override: string | undefined;

  // Apply the session title or the environment title. An empty result keeps
  // the pi default, so the extension is silent when NOUS_TITLE is not set.
  function apply(ctx: ExtensionContext) {
    const title = override ?? envTitle();
    if (title) ctx.ui.setTitle(title);
  }

  // pi writes its own title at startup and after /name, /reload, and a session
  // switch. These handlers run after pi, so the custom title wins.
  pi.on("session_start", async (_event, ctx) => {
    override = undefined;
    apply(ctx);
  });
  pi.on("session_info_changed", async (_event, ctx) => {
    apply(ctx);
  });

  pi.registerCommand("title", {
    description: "Set the terminal window title",
    handler: async (args, ctx) => {
      const value = clean(args);
      if (!value) {
        const current = override ?? envTitle();
        ctx.ui.notify(current ? `Window title: ${current}` : "Window title: pi default", "info");
        return;
      }
      if (value === "reset") {
        override = undefined;
        ctx.ui.setTitle(envTitle() ?? piDefaultTitle(pi));
        ctx.ui.notify("Window title reset", "info");
        return;
      }
      override = value;
      ctx.ui.setTitle(value);
      ctx.ui.notify(`Window title: ${value}`, "info");
    },
  });
}
