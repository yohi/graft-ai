import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const TARGET_ORIGIN = "https://chatgpt.com";
const PROXY_SECRET = process.env.PROXY_SECRET?.trim();

// 安全のため、転送を許可するパスを完全一致の静的マッピングで制限
const PATH_MAP = {
  "/backend-api/wham/usage": "https://chatgpt.com/backend-api/wham/usage",
  "/backend-api/wham/reset-credits": "https://chatgpt.com/backend-api/wham/reset-credits",
};

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

  // 静的マッピングによる転送先 URL の安全な解決
  const staticTarget = PATH_MAP[url.pathname];
  if (!staticTarget) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden: Path not allowed by proxy whitelist" }));
    return;
  }

  const targetUrl = new URL(staticTarget);
  targetUrl.search = url.search;

  try {
    // Cloudflare Tunnel 等が付与する cf-*, cdn-loop, x-forwarded-* を排除し、必要なヘッダーのみ安全に転送
    const forwardHeaders = {
      "User-Agent":
        req.headers["user-agent"] ||
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      Accept: req.headers["accept"] || "application/json",
      Origin: TARGET_ORIGIN,
      Referer: `${TARGET_ORIGIN}/`,
    };

    if (req.headers["authorization"]) forwardHeaders["Authorization"] = req.headers["authorization"];
    if (req.headers["chatgpt-account-id"]) forwardHeaders["ChatGPT-Account-Id"] = req.headers["chatgpt-account-id"];
    if (req.headers["openai-beta"]) forwardHeaders["OpenAI-Beta"] = req.headers["openai-beta"];
    if (req.headers["originator"]) forwardHeaders["originator"] = req.headers["originator"];

    const upstreamResponse = await fetch(targetUrl.href, {
      method: req.method,
      headers: forwardHeaders,
    });

    const responseHeaders = Object.fromEntries(upstreamResponse.headers.entries());
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
