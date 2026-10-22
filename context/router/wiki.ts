import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, resolve, relative, basename, extname } from "path";

export const WIKI_PATH = process.env.WIKI_PATH || "/sandbox/wiki";

// ── Helpers ────────────────────────────────────────────────────────────────────

function safe(filePath: string): boolean {
  return resolve(filePath).startsWith(resolve(WIKI_PATH) + "/") ||
         resolve(filePath) === resolve(WIKI_PATH);
}

interface Meta { type?: string; title?: string; description?: string; tags?: string[] }

function parseFrontmatter(content: string): { meta: Meta; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const yaml = m[1];
  const body = m[2];
  const field = (key: string) => yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const tagsM = yaml.match(/^tags:\s*\[([^\]]*)\]/m);
  return {
    meta: {
      type:        field("type"),
      title:       field("title"),
      description: field("description"),
      tags:        tagsM ? tagsM[1].split(",").map(t => t.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean) : undefined,
    },
    body,
  };
}

function* walkMd(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!safe(full)) continue;
    try {
      const s = statSync(full);
      // Skip raw/ — those are source documents, not wiki pages
      if (s.isDirectory() && entry !== "raw") yield* walkMd(full);
      else if (!s.isDirectory() && entry.endsWith(".md")) yield full;
    } catch { /* skip */ }
  }
}

// ── Tool implementations ───────────────────────────────────────────────────────

export function wikiSearch(query: string, limit: number): string {
  if (!existsSync(WIKI_PATH)) return "Wiki not mounted. Add -v /path/to/vault:/sandbox/wiki:z";

  const q = query.toLowerCase();
  type Hit = { path: string; title: string; type: string; desc: string; excerpt: string; score: number };
  const hits: Hit[] = [];

  for (const fp of walkMd(WIKI_PATH)) {
    try {
      const raw = readFileSync(fp, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const bodyLc = body.toLowerCase();
      let score = 0;
      if ((meta.title  ?? "").toLowerCase().includes(q)) score += 10;
      if ((meta.description ?? "").toLowerCase().includes(q)) score += 5;
      if ((meta.tags ?? []).join(" ").toLowerCase().includes(q)) score += 3;
      if (bodyLc.includes(q)) score += 1;
      if (score === 0) continue;

      const idx = bodyLc.indexOf(q);
      let excerpt = "";
      if (idx >= 0) {
        const s = Math.max(0, idx - 100), e = Math.min(body.length, idx + 220);
        excerpt = (s > 0 ? "…" : "") + body.slice(s, e).trim() + (e < body.length ? "…" : "");
      }
      hits.push({ path: relative(WIKI_PATH, fp), title: meta.title ?? basename(fp, ".md"),
                  type: meta.type ?? "", desc: meta.description ?? "", excerpt, score });
    } catch { /* skip */ }
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, limit);
  if (top.length === 0) return `No wiki pages found matching "${query}".`;
  return top.map(h =>
    `## ${h.title}\n**path:** ${h.path}${h.type ? `  **type:** ${h.type}` : ""}\n` +
    (h.desc ? `${h.desc}\n` : "") +
    (h.excerpt ? `\n> ${h.excerpt.replace(/\n/g, "\n> ")}\n` : "")
  ).join("\n---\n");
}

export function wikiRead(pagePath: string): string {
  const full = resolve(join(WIKI_PATH, pagePath));
  if (!safe(full)) return "Error: path is outside the wiki directory.";
  if (existsSync(full)) return readFileSync(full, "utf8");
  const withMd = full.endsWith(".md") ? full : full + ".md";
  if (existsSync(withMd)) return readFileSync(withMd, "utf8");
  return `Page not found: ${pagePath}`;
}

export function wikiIngest(filename: string, content: string): string {
  if (!existsSync(WIKI_PATH)) return "Wiki not mounted.";
  const safe_name = basename(filename);
  if (!safe_name || safe_name.startsWith(".")) return "Error: invalid filename.";
  const assetsDir = join(WIKI_PATH, "raw", "assets");
  mkdirSync(assetsDir, { recursive: true });
  let dest = join(assetsDir, safe_name);
  if (existsSync(dest)) {
    const ext = extname(safe_name);
    dest = join(assetsDir, `${basename(safe_name, ext)}-${Date.now()}${ext}`);
  }
  writeFileSync(dest, content, "utf8");
  return `Saved to raw/assets/${basename(dest)}. The processor agent will include it on next ingest run.`;
}
