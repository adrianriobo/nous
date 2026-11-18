// Journal extension. It writes the interaction log without a model decision:
// every user request opens a record, every tool call and every final answer
// adds an entry. The `journal` tool lets the agent add notes and close the
// record, so a broken session resumes from the newest open record.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "fs";
import {
  appendEntry,
  findRecord,
  latestActive,
  openRecord,
  readJournal,
  recordIndex,
  redact,
  resolveJournalFile,
  resumeText,
  sanitize,
  setStatus,
} from "./journal.ts";

const CLOSE_STATUSES = ["done", "blocked", "handed-over"] as const;
const MAX_TOOL_TARGET = 120;
const MAX_ANSWER = 600;
const MAX_DIGEST = 700;

/** Short target for a tool entry: the file, command, query, or pattern. */
function toolTarget(name: string, args: any): string {
  const pick = (key: string) => (args && typeof args[key] === "string" ? args[key] : "");
  switch (name) {
    case "bash":
    case "shell":
      return pick("command");
    case "read":
    case "write":
    case "edit":
      return pick("path");
    case "grep":
    case "find":
      return pick("pattern") || pick("path");
    case "web_search":
      return pick("query");
    case "code_review": {
      const files = args?.files;
      return Array.isArray(files) ? files.join(", ") : "";
    }
    case "subagent":
      return [pick("role"), pick("task")].filter(Boolean).join(": ");
    default:
      return pick("path") || pick("command") || pick("query") || "";
  }
}

/** Text of an assistant message, without the tool-call parts. */
function answerText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

export default function registerJournal(pi: ExtensionAPI) {
  const file = resolveJournalFile();
  let lastAnswer = "";

  // A hook must not break the run. Report the error and continue.
  const guarded = (label: string, work: () => void) => {
    try {
      work();
    } catch (error) {
      console.error(`[journal] ${label}: ${(error as Error).message}`);
    }
  };

  const hasJournal = () => existsSync(file);

  pi.on("session_start", async (event) => {
    guarded("session_start", () => {
      const record = latestActive(readJournal(file));
      if (!record) return;
      appendEntry(file, "session start", [
        `- reason: ${event.reason}`,
        `- continue: ${record.id} from the last entry`,
      ]);
    });
  });

  // A new user request opens a new record.
  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" };
    const text = String(event.text ?? "").trim();
    if (!text || text.startsWith("/")) return { action: "continue" };
    guarded("input", () => {
      openRecord(file, text);
    });
    return { action: "continue" };
  });

  // Every finished tool call adds one entry. The journal tool skips itself.
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName === "journal") return;
    guarded("tool_execution_end", () => {
      if (!hasJournal()) return;
      const target = sanitize(redact(toolTarget(event.toolName, event.args)), MAX_TOOL_TARGET);
      const state = event.isError ? "error" : "ok";
      const duration = typeof event.durationMs === "number" ? `, ${Math.round(event.durationMs)}ms` : "";
      const line = target ? `- \`${target}\` — ${state}${duration}` : `- ${state}${duration}`;
      appendEntry(file, `tool ${event.toolName}`, [line]);
    });
  });

  // Keep the final answer of the run for the settle entry.
  pi.on("agent_end", async (event) => {
    const messages = event.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role !== "assistant") continue;
      lastAnswer = sanitize(answerText(messages[index]), MAX_ANSWER);
      break;
    }
  });

  pi.on("agent_settled", async (event) => {
    guarded("agent_settled", () => {
      if (!hasJournal()) return;
      const record = latestActive(readJournal(file));
      if (!record) {
        lastAnswer = "";
        return;
      }
      if (event.aborted) {
        appendEntry(file, "run stopped", ["- The user stopped the run. Continue from the last entry."]);
      } else if (lastAnswer) {
        appendEntry(file, "answer", [lastAnswer]);
      }
      lastAnswer = "";
    });
  });

  pi.on("session_shutdown", async (event) => {
    guarded("session_shutdown", () => {
      if (!latestActive(readJournal(file))) return;
      appendEntry(file, "session end", [`- reason: ${event.reason}`]);
    });
  });

  // Show the open record at the start of each run. Pi patches only the
  // sections that changed, so the prompt cache keeps its prefix.
  pi.on("before_agent_start", async (event) => {
    const record = latestActive(readJournal(file));
    if (!record) return;
    const digest = [
      `The journal file is \`${file}\`. The newest open record is \`${record.id}\`.`,
      "",
      sanitize(resumeText(record, 3), MAX_DIGEST),
      "",
      "Continue this record. Use the `journal` tool to add a note or to close the record.",
    ].join("\n");
    const options: any = event.systemPromptOptions ?? {};
    options.sections = { ...(options.sections ?? {}), "session-journal-state": digest };
  });

  pi.registerTool({
    name: "journal",
    label: "Session Journal",
    description: `Record the state of the work in the journal file (${file}).
The extension opens a record for each request and adds an entry for each tool
call. Use this tool to add a note, to close the record, to list the records, or
to read the record that a new session must continue.`,
    promptSnippet: "Add a journal note, close the record, list records, or resume the open record",
    promptGuidelines: [
      "Use the journal tool with action close before the final answer when the work is done, blocked, or handed to another person.",
      "Use the journal tool with action note to record a decision or a blocker that the next session must know.",
    ],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["note", "close", "list", "resume"],
          description: "note adds an entry. close adds a final entry and sets the status. list shows the records. resume returns the open record.",
          default: "note",
        },
        text: { type: "string", description: "Note text, or the summary for action close." },
        status: {
          type: "string",
          enum: [...CLOSE_STATUSES],
          description: "Status for action close: done, blocked, or handed-over.",
        },
        record: { type: "string", description: "Record ID, for example J-20260210-01. Default: the newest open record." },
      },
      required: [],
    } as any,
    async execute(_id: string, params: any) {
      const action = String(params?.action ?? "note");
      const content = readJournal(file);
      const record = params?.record ? findRecord(content, String(params.record)) : latestActive(content);
      const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

      if (action === "list") {
        const lines = recordIndex(readJournal(file));
        return reply(lines.length > 0 ? `${file}\n\n${lines.join("\n")}` : `The journal has no record. File: ${file}`);
      }

      if (action === "resume") {
        if (!record) return reply(`The journal has no open record. File: ${file}`);
        return reply(`Record ${record.id} [${record.status}]. File: ${file}\n\n${resumeText(record)}`);
      }

      if (action === "close") {
        if (!record) return reply(`The journal has no open record to close. File: ${file}`);
        const requested = String(params?.status ?? "done");
        const status = CLOSE_STATUSES.includes(requested as any) ? requested : "done";
        const summary = sanitize(redact(params?.text ?? ""), MAX_ANSWER);
        appendEntry(file, `close (${status})`, summary ? [summary] : ["- The work stopped here."]);
        const changed = setStatus(file, record.id, status);
        return reply(changed ? `Closed ${record.id} as ${status}.` : `Record ${record.id} was not found in ${file}.`);
      }

      const note = sanitize(redact(params?.text ?? ""), MAX_ANSWER);
      if (!note) return reply("The note is empty. Set text.");
      if (!record) return reply(`The journal has no open record. File: ${file}`);
      appendEntry(file, "note", [note]);
      return reply(`Added a note to ${record.id}.`);
    },
  } as any);
}
