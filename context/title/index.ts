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
 *
 * Startup order in pi 1.5.2, interactive mode:
 *   1. rebindCurrentSession() emits session_start. This extension writes the
 *      custom title.
 *   2. rebindCurrentSession() calls updateTerminalTitle(). pi writes
 *      "π - <session name> - <cwd>" and overwrites the custom title.
 *
 * /reload uses the opposite order, so the custom title stays there. A timer is
 * not a reliable fix: a slow session_start handler in another extension delays
 * the pi write by an unknown time.
 *
 * The extension therefore rewrites the OSC title sequences that pi writes. The
 * custom title wins for the whole life of the process.
 */
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENV_VAR = "NOUS_TITLE";

/** Key of the single stdout wrapper. pi can load the extension again. */
const INTERCEPTOR = Symbol.for("nous.title.interceptor");

/** OSC 0 and OSC 2 set the window title. BEL or ST ends the sequence. */
const TITLE_SEQUENCE = /\u001b\][02];[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Start of every OSC title sequence. Used for the fast path. */
const TITLE_MARKER = "\u001b]";

type Interceptor = {
  /** Identifier of the extension instance that owns the wrapper. */
  owner: object;
  /** Current title. Returns undefined to pass the pi title through. */
  title: () => string | undefined;
  restore: () => void;
};

type Scope = typeof globalThis & { [INTERCEPTOR]?: Interceptor };

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

/** Replace each title sequence with the custom title. */
function rewriteTitle(text: string, title: string): string {
  return text.replace(TITLE_SEQUENCE, `\u001b]0;${title}\u0007`);
}

/**
 * Wrap process.stdout.write and rewrite the pi title writes.
 *
 * The process keeps one wrapper. A second load, for example /reload, reuses
 * it and takes ownership. The old instance can no longer remove it.
 */
function installInterceptor(owner: object, title: () => string | undefined): void {
  const scope = globalThis as Scope;
  const installed = scope[INTERCEPTOR];
  if (installed) {
    installed.owner = owner;
    installed.title = title;
    return;
  }

  const original = process.stdout.write.bind(process.stdout);
  const interceptor: Interceptor = {
    owner,
    title,
    restore: () => {
      if (scope[INTERCEPTOR] !== interceptor) return;
      process.stdout.write = original;
      delete scope[INTERCEPTOR];
    },
  };

  process.stdout.write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    const value = interceptor.title();
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (value && text.includes(TITLE_MARKER)) {
      const patched = rewriteTitle(text, value);
      if (patched !== text) {
        return (original as (c: string, ...r: unknown[]) => boolean)(patched, ...rest);
      }
    }
    return (original as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  scope[INTERCEPTOR] = interceptor;
}

export default function (pi: ExtensionAPI) {
  let override: string | undefined;
  const owner = {};

  // Apply the session title or the environment title. An empty result keeps
  // the pi default, so the extension is silent when NOUS_TITLE is not set.
  function apply(ctx: ExtensionContext) {
    const title = override ?? envTitle();
    if (title) ctx.ui.setTitle(title);
  }

  installInterceptor(owner, () => override ?? envTitle());

  // pi writes its own title at startup and after /name, /reload, and a session
  // switch. The stdout wrapper keeps the custom title in place.
  pi.on("session_start", async (_event, ctx) => {
    override = undefined;
    apply(ctx);
  });
  pi.on("session_info_changed", async (_event, ctx) => {
    apply(ctx);
  });

  // Remove the wrapper when the process exits. A reload keeps it.
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit") {
      const scope = globalThis as Scope;
      const installed = scope[INTERCEPTOR];
      if (installed?.owner === owner) installed.restore();
    }
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
