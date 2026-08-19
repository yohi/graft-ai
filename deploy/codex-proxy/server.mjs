import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const TARGET_ORIGIN = "https://chatgpt.com";
const PROXY_SECRET = process.env.PROXY_SECRET?.trim();

// 安全のため、転送を許可するパスのプレフィックスを制限
const ALLOWED_PATH_PREFIXES = ["/backend-api/wham/"];

const server = http.createServer(async (req, res) => {
  // CORS ヘッダー
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // ヘルスチェック
  if (url.pathname === "/healthz" || url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "graft-ai-codex-proxy" }));
    return;
  }

  // 共有シークレットによる簡易認証（設定されている場合）
  if (PROXY_SECRET) {
    const providedSecret = req.headers["x-proxy-secret"] || url.searchParams.get("secret");
    if (providedSecret !== PROXY_SECRET) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing X-Proxy-Secret" }));
      return;
    }
  }

  // パス制限のチェック
  const isAllowed = ALLOWED_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
  if (!isAllowed) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden: Path not allowed by proxy whitelist" }));
    return;
  }

  const targetUrl = `${TARGET_ORIGIN}${url.pathname}${url.search}`;

  try {
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders.host;
    delete forwardHeaders.connection;
    delete forwardHeaders["x-proxy-secret"];
    delete forwardHeaders["content-length"];

    // 転送元ブラウザ/クライアントのヘッダーを保持しつつ、Origin/Referer を設定
    forwardHeaders["Origin"] = TARGET_ORIGIN;
    forwardHeaders["Referer"] = `${TARGET_ORIGIN}/`;

    const upstreamResponse = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
    });

    const responseHeaders = Object.fromEntries(upstreamResponse.headers.entries());
    // 不要な転送エンコーディングヘッダーを削除
    delete responseHeaders["content-encoding"];
    delete responseHeaders["transfer-encoding"];

    res.writeHead(upstreamResponse.status, responseHeaders);
    const body = await upstreamResponse.arrayBuffer();
    res.end(Buffer.from(body));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Proxy Error] ${req.method} ${targetUrl}: ${message}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad Gateway", detail: message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 Codex Proxy listening on http://${HOST}:${PORT}`);
  console.log(`🎯 Forwarding whitelisted paths to ${TARGET_ORIGIN}`);
  if (PROXY_SECRET) {
    console.log(`🔒 Proxy Secret authentication enabled`);
  }
});
