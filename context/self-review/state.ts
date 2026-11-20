// Self-review helpers. The extension asks for one code review when a run
// changes a file. These functions hold no pi state, so the tests call them
// directly. The Git snapshot is the truth for a change. A tool call is a
// second signal, because edit and write also work outside a repository.

import { execFileSync } from "child_process";

export const MODE_VARIABLE = "NOUS_SELF_REVIEW";
export const REMINDER_TYPE = "nous-self-review";

export const REMINDER_TEXT = [
  "The run changed files and no review ran.",
  "Run the self-review now.",
  "Use repo-relative paths.",
  "Fix the blocking findings.",
  "Then answer.",
].join(" ");

/** Git state at one moment. `head` is empty in a repository with no commit. */
export interface Snapshot {
  head: string;
  status: string;
}

/** State of one run: the baseline, the change signals, and the review. */
export interface RunState {
  baseline: Snapshot | null;
  changed: boolean;
  reviewed: boolean;
  reminded: boolean;
}

/** `NOUS_SELF_REVIEW=off` disables the reminder. The default value is `auto`. */
export function reviewEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env?.[MODE_VARIABLE] ?? "").trim().toLowerCase() !== "off";
}

/** Read HEAD and the working tree. Return null outside a Git repository. */
export function readSnapshot(cwd: string): Snapshot | null {
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  try {
    const status = run(["status", "--porcelain"]);
    let head = "";
    try {
      head = run(["rev-parse", "HEAD"]);
    } catch {
      head = "";
    }
    return { head, status };
  } catch {
    return null;
  }
}

/** Start a run with the baseline that the `input` hook recorded. */
export function startRun(baseline: Snapshot | null): RunState {
  return { baseline, changed: false, reviewed: false, reminded: false };
}

export function recordChange(state: RunState): RunState {
  return state.changed ? state : { ...state, changed: true };
}

export function recordReview(state: RunState): RunState {
  return state.reviewed ? state : { ...state, reviewed: true };
}

export function markReminded(state: RunState): RunState {
  return state.reminded ? state : { ...state, reminded: true };
}

/** True when HEAD or the working tree moved since the run started. */
export function snapshotChanged(baseline: Snapshot | null, current: Snapshot | null): boolean {
  if (!baseline || !current) return false;
  return baseline.head !== current.head || baseline.status !== current.status;
}

/** True when the run stopped changing files. A dirty baseline is not a change. */
export function needsReminder(state: RunState, current: Snapshot | null): boolean {
  if (state.reminded || state.reviewed) return false;
  return state.changed || snapshotChanged(state.baseline, current);
}

// A shell command that changes a file. This is a hint only: `git status` is
// the truth inside a repository. The list stays short to limit false alarms.
const MUTATING_COMMANDS: RegExp[] = [
  /\bsed\s+-i/,
  /\bperl\s+-i/,
  /\btee\s/,
  /\btruncate\s/,
  /\bdd\s/,
  /\bpatch\s/,
  /\binstall\s/,
  /\bchmod\s/,
  /\bchown\s/,
  /\brm\s/,
  /\bmv\s/,
  /\bcp\s/,
  /\bmkdir\s/,
  /\btouch\s/,
  /\bln\s/,
  /\bgit\s+(?:apply|am|commit|checkout|restore|reset|merge|rebase|stash|cherry-pick)\b/,
];

export function looksMutating(command: unknown): boolean {
  const text = String(command ?? "");
  return MUTATING_COMMANDS.some((pattern) => pattern.test(text));
}
