const https = require("https") as typeof import("https");
const http  = require("http")  as typeof import("http");

export function discoverToolsSSE(sseUrl: string, extraHeaders: Record<string, string>): Promise<DiscoveryResult> {
  return new Promise((resolve, reject) => {
    const u    = new URL(sseUrl);
    const mod  = u.protocol === "https:" ? https : http;
    const base = `${u.protocol}//${u.host}`;
    let sseAcc = "";
    let sseRes: any;
    let sessionUrl = "";
    let initDone = false;
    let settled  = false;

    function settle(result: DiscoveryResult | null, err?: Error) {
      if (settled) return;
      settled = true;
      try { sseRes?.destroy(); } catch {}
      err ? reject(err) : resolve(result!);
    }

    function post(relOrAbsUrl: string, body: any) {
      const eu  = new URL(relOrAbsUrl.startsWith("http") ? relOrAbsUrl : base + relOrAbsUrl);
      const buf = Buffer.from(JSON.stringify(body));
      const req = mod.request({
        hostname: eu.hostname,
        port:     Number(eu.port) || (u.protocol === "https:" ? 443 : 80),
        path:     eu.pathname + eu.search,
        method:   "POST",
        headers:  { "Content-Type": "application/json", "Content-Length": buf.length, ...extraHeaders },
      } as any, (res: any) => res.resume());
      req.on("error", () => {});
      req.write(buf);
      req.end();
    }

    function onData(chunk: Buffer) {
      sseAcc += chunk.toString();
      let idx: number;
      while ((idx = sseAcc.indexOf("\n\n")) !== -1) {
        const block = sseAcc.slice(0, idx);
        sseAcc = sseAcc.slice(idx + 2);
        let type = "message", data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          if (line.startsWith("data:"))  data = line.slice(5).trim();
        }
        if (!data) continue;
        if (type === "endpoint") {
          sessionUrl = data;
          process.stderr.write(`[nous] SSE endpoint: ${sessionUrl}\n`);
          post(sessionUrl, { jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "nous", version: "1.0.0" } } });
        } else if (type === "message") {
          try {
            const msg = JSON.parse(data);
            if (!initDone && msg.id === 1) {
              process.stderr.write(`[nous] initialize ok, sending tools/list\n`);
              initDone = true;
              post(sessionUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
            } else if (msg.id === 2) {
              process.stderr.write(`[nous] tools/list raw: ${data}\n`);
              if (msg.error) { settle(null, new Error(msg.error.message ?? "tools/list error")); }
              else { settle({ tools: msg.result?.tools ?? [], instructions: "" }); }
            }
          } catch {}
        }
      }
    }

    process.stderr.write(`[nous] SSE GET ${sseUrl}\n`);
    const req = mod.request({
      hostname: u.hostname,
      port:     Number(u.port) || (u.protocol === "https:" ? 443 : 80),
      path:     u.pathname + u.search,
      method:   "GET",
      headers:  { "Accept": "text/event-stream", ...extraHeaders },
    } as any, (res: any) => {
      process.stderr.write(`[nous] SSE response status: ${res.statusCode}\n`);
      sseRes = res;
      res.on("data",  onData);
      res.on("end",   () => settle(null, new Error("SSE closed before response")));
      res.on("error", (e: Error) => { process.stderr.write(`[nous] SSE res error: ${e.message}\n`); settle(null, e); });
    });
    req.on("error", (e: Error) => { process.stderr.write(`[nous] SSE req error: ${e.message}\n`); settle(null, e); });
    (req as any).setTimeout(20000, () => { process.stderr.write(`[nous] SSE timeout\n`); (req as any).destroy(); settle(null, new Error("SSE timeout")); });
    req.end();
  });
}

export function discoverToolsStreamable(serverUrl: string, extraHeaders: Record<string, string>): Promise<DiscoveryResult> {
  return new Promise((resolve, reject) => {
    const u   = new URL(serverUrl);
    const mod = u.protocol === "https:" ? https : http;

    // Returns { body, sessionId } — captures Mcp-Session-Id from response headers.
    function post(body: any, sessionId?: string): Promise<{ body: any; sessionId: string | null }> {
      return new Promise((res, rej) => {
        const buf = Buffer.from(JSON.stringify(body));
        let acc = "", done = false;
        const hdrs: Record<string, string> = {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Content-Length": String(buf.length),
          ...extraHeaders,
        };
        if (sessionId) hdrs["Mcp-Session-Id"] = sessionId;
        const req = mod.request({
          hostname: u.hostname,
          port:     Number(u.port) || (u.protocol === "https:" ? 443 : 80),
          path:     u.pathname + u.search,
          method:   "POST",
          headers:  hdrs,
        } as any, (r: any) => {
          const sid: string | null = r.headers["mcp-session-id"] ?? null;
          r.on("data", (c: Buffer) => {
            acc += c.toString();
            for (const line of acc.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try { const p = JSON.parse(line.slice(5)); if (p.result !== undefined || p.error !== undefined) { if (!done) { done = true; r.destroy(); res({ body: p, sessionId: sid }); } return; } } catch {}
            }
            try { const p = JSON.parse(acc.trim()); if (p.result !== undefined || p.error !== undefined) { if (!done) { done = true; res({ body: p, sessionId: sid }); } } } catch {}
          });
          r.on("end",   () => { if (!done) { done = true; try { res({ body: JSON.parse(acc), sessionId: sid }); } catch { rej(new Error("empty")); } } });
          r.on("error", (e: Error) => { if (!done) { done = true; rej(e); } });
        });
        req.on("error", (e: Error) => { if (!done) { done = true; rej(e); } });
        (req as any).setTimeout(15000, () => { if (!done) { done = true; (req as any).destroy(); rej(new Error("timeout")); } });
        req.write(buf);
        req.end();
      });
    }

    (async () => {
      process.stderr.write(`[nous] streamable POST initialize → ${serverUrl}\n`);
      const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "nous", version: "1.0.0" } } })
        .catch((e: Error) => { process.stderr.write(`[nous] streamable initialize error: ${e.message}\n`); return null; });
      const sessionId = init?.sessionId ?? null;
      process.stderr.write(`[nous] streamable initialize resp: ${JSON.stringify(init?.body)}, session: ${sessionId}\n`);
      const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId ?? undefined);
      process.stderr.write(`[nous] streamable tools/list resp: ${JSON.stringify(list.body)}\n`);
      if (list.body?.error) throw new Error(list.body.error.message ?? "tools/list error");
      resolve({ tools: list.body?.result?.tools ?? [], instructions: init?.body?.result?.instructions ?? "" });
    })().catch(reject);
  });
}

export type DiscoveryResult = { tools: any[]; instructions: string };

export async function discoverTools(url: string, headers: Record<string, string>): Promise<DiscoveryResult> {
  try {
    return await discoverToolsSSE(url, headers);
  } catch (e: any) {
    process.stderr.write(`[nous] SSE failed (${e.message}), trying streamable HTTP\n`);
    return await discoverToolsStreamable(url, headers);
  }
}

export async function callMcpToolSSE(sseUrl: string, headers: Record<string, string>, toolName: string, args: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const u    = new URL(sseUrl);
    const mod  = u.protocol === "https:" ? https : http;
    const base = `${u.protocol}//${u.host}`;
    let sseAcc = "";
    let sseRes: any;
    let sessionUrl = "";
    let initDone = false;
    let settled  = false;

    function settle(text: string | null, err?: Error) {
      if (settled) return;
      settled = true;
      try { sseRes?.destroy(); } catch {}
      err ? reject(err) : resolve(text!);
    }

    function extractText(msg: any): string {
      const ct = msg.result?.content;
      if (Array.isArray(ct)) return ct.map((b: any) => b.text ?? "").join("");
      return JSON.stringify(msg.result ?? msg);
    }

    function post(relOrAbsUrl: string, body: any) {
      const eu  = new URL(relOrAbsUrl.startsWith("http") ? relOrAbsUrl : base + relOrAbsUrl);
      const buf = Buffer.from(JSON.stringify(body));
      const req = mod.request({
        hostname: eu.hostname, port: Number(eu.port) || (u.protocol === "https:" ? 443 : 80),
        path: eu.pathname + eu.search, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": buf.length, ...headers },
      } as any, (res: any) => res.resume());
      req.on("error", () => {});
      req.write(buf); req.end();
    }

    function onData(chunk: Buffer) {
      sseAcc += chunk.toString();
      let idx: number;
      while ((idx = sseAcc.indexOf("\n\n")) !== -1) {
        const block = sseAcc.slice(0, idx);
        sseAcc = sseAcc.slice(idx + 2);
        let type = "message", data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          if (line.startsWith("data:"))  data = line.slice(5).trim();
        }
        if (!data) continue;
        if (type === "endpoint") {
          sessionUrl = data;
          post(sessionUrl, { jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "nous", version: "1.0.0" } } });
        } else if (type === "message") {
          try {
            const msg = JSON.parse(data);
            if (!initDone && msg.id === 1) {
              initDone = true;
              post(sessionUrl, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: args } });
            } else if (msg.id === 2) { settle(extractText(msg)); }
          } catch {}
        }
      }
    }

    const req = mod.request({
      hostname: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, method: "GET",
      headers: { "Accept": "text/event-stream", ...headers },
    } as any, (res: any) => {
      sseRes = res;
      res.on("data", onData);
      res.on("end",  () => settle(null, new Error("SSE closed")));
      res.on("error", (e: Error) => settle(null, e));
    });
    req.on("error", (e: Error) => settle(null, e));
    (req as any).setTimeout(120000, () => { (req as any).destroy(); settle(null, new Error("timeout")); });
    req.end();
  });
}

export async function callMcpToolStreamable(serverUrl: string, extraHeaders: Record<string, string>, toolName: string, args: any): Promise<string> {
  const u   = new URL(serverUrl);
  const mod = u.protocol === "https:" ? https : http;

  function post(body: any, sessionId?: string): Promise<{ body: any; sessionId: string | null }> {
    return new Promise((res, rej) => {
      const buf = Buffer.from(JSON.stringify(body));
      let acc = "", done = false;
      const hdrs: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Content-Length": String(buf.length),
        ...extraHeaders,
      };
      if (sessionId) hdrs["Mcp-Session-Id"] = sessionId;
      const req = mod.request({
        hostname: u.hostname,
        port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: hdrs,
      } as any, (r: any) => {
        const sid: string | null = r.headers["mcp-session-id"] ?? null;
        r.on("data", (c: Buffer) => {
          acc += c.toString();
          for (const line of acc.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try { const p = JSON.parse(line.slice(5)); if (p.result !== undefined || p.error !== undefined) { if (!done) { done = true; r.destroy(); res({ body: p, sessionId: sid }); } return; } } catch {}
          }
          try { const p = JSON.parse(acc.trim()); if (p.result !== undefined || p.error !== undefined) { if (!done) { done = true; res({ body: p, sessionId: sid }); } } } catch {}
        });
        r.on("end",   () => { if (!done) { done = true; try { res({ body: JSON.parse(acc), sessionId: sid }); } catch { rej(new Error("empty")); } } });
        r.on("error", (e: Error) => { if (!done) { done = true; rej(e); } });
      });
      req.on("error", (e: Error) => { if (!done) { done = true; rej(e); } });
      (req as any).setTimeout(120000, () => { if (!done) { done = true; (req as any).destroy(); rej(new Error("timeout")); } });
      req.write(buf);
      req.end();
    });
  }

  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "nous", version: "1.0.0" } } })
    .catch(() => null);
  const sessionId = init?.sessionId ?? null;
  const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: args } }, sessionId ?? undefined);
  const content = call.body?.result?.content;
  return Array.isArray(content) ? content.map((b: any) => b.text ?? "").join("") : JSON.stringify(call.body?.result ?? call.body);
}
