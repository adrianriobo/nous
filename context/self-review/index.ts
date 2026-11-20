// Self-review extension. An implementation run can reach the final answer
// without a review: the instruction alone is easy to skip. This extension adds
// one reminder at the last actionable boundary (`agent_before_settle`) when a
// run changed a file and no `code_review` call ran. The reminder is not a hard
// block; pi requests one continuation only.
//
// `NOUS_SELF_REVIEW=off` disables the reminder. A handler error never stops a
// run: the extension reports one line on stderr and continues.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  REMINDER_TYPE,
  REMINDER_TEXT,
  looksMutating,
  markReminded,
  needsReminder,
  readSnapshot,
  recordChange,
  recordReview,
  reviewEnabled,
  startRun,
  type RunState,
} from "./state.ts";

const CHANGE_TOOLS = new Set(["edit", "write"]);

export default function registerSelfReview(pi: ExtensionAPI) {
  // One state for each run. The `input` hook opens a new state and records the
  // baseline. The `agent_settled` hook clears it.
  let state: RunState = startRun(null);

  // A hook must not break the run. Report the error and continue.
  const guarded = (label: string, work: () => void) => {
    try {
      work();
    } catch (error) {
      console.error(`[self-review] ${label}: ${(error as Error).message}`);
    }
  };

  pi.on("session_start", async () => {
    guarded("session_start", () => {
      state = startRun(null);
    });
  });

  // A new user request opens a run and records the baseline. A run that starts
  // from an extension message keeps the current state.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const text = String(event.text ?? "").trim();
    if (!text || text.startsWith("/")) return { action: "continue" };
    guarded("input", () => {
      state = startRun(readSnapshot(ctx.cwd));
    });
    return { action: "continue" };
  });

  // Change and review signals. A failed call changes nothing.
  pi.on("tool_execution_end", async (event) => {
    if (event.isError) return;
    guarded("tool_execution_end", () => {
      if (event.toolName === "code_review") {
        state = recordReview(state);
        return;
      }
      if (CHANGE_TOOLS.has(event.toolName)) {
        state = recordChange(state);
        return;
      }
      // A shell command is a hint only. The Git snapshot stays the truth.
      if (event.toolName === "bash" && looksMutating(event.args?.command)) {
        state = recordChange(state);
      }
    });
  });

  // The last actionable boundary. Ask for one continuation when the run
  // changed a file and no review ran.
  pi.on("agent_before_settle", async (event, ctx) => {
    let remind = false;
    guarded("agent_before_settle", () => {
      if (!reviewEnabled(process.env)) return;
      const current = readSnapshot(ctx.cwd);
      if (!needsReminder(state, current)) return;
      state = markReminded(state);
      remind = true;
    });
    if (!remind) return;
    return {
      entries: [
        ...(event.entries ?? []),
        {
          type: "custom_message" as const,
          customType: REMINDER_TYPE,
          content: REMINDER_TEXT,
          display: false,
        },
      ],
      continue: true,
    };
  });

  pi.on("agent_settled", async () => {
    guarded("agent_settled", () => {
      state = startRun(null);
    });
  });
}
