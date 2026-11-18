// Journal file helpers. The caller supplies the file path, so the functions
// are easy to test. The journal is append-only: a broken session resumes from
// the newest record that is not closed.

import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export const JOURNAL_HEADER = [
  "# Session Journal",
  "",
  "Times are UTC. One record for each request. Append only.",
  "",
].join("\n");

export const JOURNAL_STATUSES = ["open", "blocked", "done", "handed-over"] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

export const CLOSED_STATUSES: readonly string[] = ["done", "handed-over"];

export interface JournalRecord {
  id: string;
  title: string;
  status: string;
  start: number;
  end: number;
  text: string;
}

const RECORD_HEADING = /^## (J-\d{8}-\d{2})(?:[ \t]+[—-][ \t]*)?(.*)$/gm;

// ── Values ───────────────────────────────────────────────────────────────────

export function isoStamp(date: Date = new Date()): string {
  return date.toISOString();
}

/** Clock time for an entry heading, for example 09:12. */
export function shortTime(date: Date = new Date()): string {
  return date.toISOString().slice(11, 16);
}

/** Date key for a record ID, for example 20260210. */
export function dayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Collapse whitespace and truncate. The journal keeps one line per value. */
export function sanitize(value: unknown, max = 400): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = Math.max(max - 3, 0);
  return `${text.slice(0, cut).trimEnd()}...`;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, "gh***"],
  [/github_pat_[A-Za-z0-9_]{16,}/g, "github_pat_***"],
  [/sk-[A-Za-z0-9_-]{16,}/g, "sk-***"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "xox***"],
  [/(Bearer[ \t]+)[A-Za-z0-9._~+/-]{12,}=*/g, "$1***"],
  [/\b((?:[A-Z0-9_]*)(?:TOKEN|KEY|SECRET|PASSWORD)(?:[A-Z0-9_]*)[ \t]*[=:][ \t]*)\S+/gi, "$1***"],
];

/** Mask the usual credential shapes before a value reaches the journal file. */
export function redact(value: unknown): string {
  let text = String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

// ── File access ──────────────────────────────────────────────────────────────

export function readJournal(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function ensureJournal(file: string): void {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JOURNAL_HEADER);
}

/**
 * Journal file for this container. NOUS_JOURNAL overrides the location.
 * Prefer /workspace: the host mount keeps the file after the container exits.
 */
export function resolveJournalFile(): string {
  const override = process.env.NOUS_JOURNAL;
  if (override) return override;
  for (const dir of ["/workspace", "/sandbox"]) {
    try {
      if (!existsSync(dir)) continue;
      accessSync(dir, constants.W_OK);
      return join(dir, "journal.md");
    } catch {
      // Directory missing or read-only: try the next one.
    }
  }
  return join("/sandbox", "journal.md");
}

// ── Records ──────────────────────────────────────────────────────────────────

export function parseRecords(content: string): JournalRecord[] {
  const marks: Array<{ id: string; title: string; start: number }> = [];
  for (const match of content.matchAll(RECORD_HEADING)) {
    marks.push({ id: match[1], title: (match[2] ?? "").trim(), start: match.index ?? 0 });
  }
  return marks.map((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].start : content.length;
    const text = content.slice(mark.start, end);
    const status = text.match(/^- status:[ \t]*(\S+)/m)?.[1] ?? "unknown";
    return { id: mark.id, title: mark.title, status, start: mark.start, end, text };
  });
}

/** Newest record that is open or blocked. This is the record to continue. */
export function latestActive(content: string): JournalRecord | undefined {
  const active = parseRecords(content).filter((r) => !CLOSED_STATUSES.includes(r.status));
  return active.length > 0 ? active[active.length - 1] : undefined;
}

export function findRecord(content: string, id: string): JournalRecord | undefined {
  return parseRecords(content).find((r) => r.id === id);
}

export function nextRecordId(content: string, date: Date = new Date()): string {
  const prefix = `J-${dayKey(date)}-`;
  let max = 0;
  for (const match of content.matchAll(new RegExp(`^## ${prefix}(\\d{2})`, "gm"))) {
    max = Math.max(max, Number(match[1]));
  }
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

export function openRecord(file: string, request: string, date: Date = new Date()): string {
  ensureJournal(file);
  const content = readJournal(file);
  const id = nextRecordId(content, date);
  const title = sanitize(redact(request), 80) || "(no text)";
  const block = [
    "",
    `## ${id} — ${title}`,
    "",
    "- status: open",
    `- started: ${isoStamp(date)}`,
    `- request: ${sanitize(redact(request), 600) || "(no text)"}`,
    "",
  ].join("\n");
  appendFileSync(file, block);
  return id;
}

/** Append one entry. `lines` hold complete lines, with or without a bullet. */
export function appendEntry(file: string, label: string, lines: string[], date: Date = new Date()): void {
  ensureJournal(file);
  const body = lines.map((line) => redact(line)).join("\n");
  const block = ["", `### ${shortTime(date)} — ${sanitize(redact(label), 120)}`, body, ""].join("\n");
  appendFileSync(file, block);
}

/** Change the status line of one record. Earlier entries stay unchanged. */
export function setStatus(file: string, id: string, status: string): boolean {
  const content = readJournal(file);
  const record = findRecord(content, id);
  if (!record) return false;
  const updated = record.text.replace(/^- status:.*$/m, `- status: ${status}`);
  writeFileSync(file, content.slice(0, record.start) + updated + content.slice(record.end));
  return true;
}

/** Record text for a resume: the request and the last entries. */
export function resumeText(record: JournalRecord, maxEntries = 8): string {
  const head: string[] = [];
  const entries: string[][] = [];
  let current: string[] | undefined;
  for (const line of record.text.trimEnd().split("\n")) {
    if (line.startsWith("### ")) {
      current = [line];
      entries.push(current);
    } else if (current) {
      current.push(line);
    } else {
      head.push(line);
    }
  }
  const kept = entries.slice(-maxEntries).map((entry) => entry.join("\n").trimEnd());
  return [...head, "", ...kept].join("\n").trim();
}

/** One line for each record, in file order. */
export function recordIndex(content: string): string[] {
  return parseRecords(content).map((record) => `${record.id} [${record.status}] ${record.title}`.trimEnd());
}
