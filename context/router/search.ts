export interface SearchResult { url: string; title: string; snippet: string }

export async function ddgSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const body = new URLSearchParams({ q: query, kl: "us-en" });
  const res = await (globalThis as any).fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; pi-search/1.0)",
    },
    body: body.toString(),
  });
  const html: string = await res.text();
  const results: SearchResult[] = [];
  const linkRe = /href="([^"]+)"\s+class='result-link'>([\s\S]*?)<\/a>/g;
  const snippetRe = /class='result-snippet'>([\s\S]*?)<\/td>/g;
  const links = [...html.matchAll(linkRe)];
  const snippets = [...html.matchAll(snippetRe)];
  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const url = links[i][1];
    const title = links[i][2].replace(/<[^>]+>/g, "").trim();
    const snippet = snippets[i] ? snippets[i][1].replace(/<[^>]+>/g, "").trim() : "";
    if (url && title) results.push({ url, title, snippet });
  }
  return results;
}
