#!/usr/bin/env bash
set -uo pipefail

# ==============================================================================
# graft-ai Codex Residential Proxy - Quick One-Liner Runner
# ==============================================================================

PORT="${PORT:-8080}"
TMP_DIR=$(mktemp -d)
PROXY_PID=""
CLOUDFLARED_PID=""

# 空いているポートを検索
find_free_port() {
  local p=$1
  while command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$p" 2>/dev/null; do
    p=$((p + 1))
  done
  echo "$p"
}

PORT=$(find_free_port "$PORT")

cleanup() {
  local exit_code=$?
  echo ""
  echo "🧹 シャットダウン中..."
  if [[ -n "$PROXY_PID" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
  fi
  if [[ -n "$CLOUDFLARED_PID" ]] && kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    kill "$CLOUDFLARED_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
  echo "✨ 停止しました。"
  exit "$exit_code"
}

trap cleanup INT TERM EXIT

echo "🚀 [1/3] Codex Proxy サーバーを準備中 (ポート: ${PORT})..."

if ! command -v node >/dev/null 2>&1; then
  echo "❌ エラー: Node.js (v18以上) がインストールされていません。"
  echo "   Node.js をインストールしてから再実行してください。"
  exit 1
fi

# プロキシスクリプトを生成
cat > "$TMP_DIR/server.mjs" << 'EOF'
import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const HOST = "127.0.0.1";
const TARGET_ORIGIN = "https://chatgpt.com";
const ALLOWED_PATH_PREFIXES = ["/backend-api/wham/"];

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/healthz" || url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "graft-ai-codex-proxy" }));
    return;
  }

  const isAllowed = ALLOWED_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
  if (!isAllowed) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden: Path not allowed" }));
    return;
  }

  const targetUrl = `${TARGET_ORIGIN}${url.pathname}${url.search}`;
  try {
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders.host;
    delete forwardHeaders.connection;
    delete forwardHeaders["content-length"];

    forwardHeaders["Origin"] = TARGET_ORIGIN;
    forwardHeaders["Referer"] = `${TARGET_ORIGIN}/`;

    const upstreamResponse = await fetch(targetUrl, {
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
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad Gateway", detail: message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[Proxy] Listening on http://${HOST}:${PORT}`);
});
EOF

# バックグラウンドプロセスに stdin を奪われないよう < /dev/null を付与
PORT="$PORT" node "$TMP_DIR/server.mjs" < /dev/null > "$TMP_DIR/proxy.log" 2>&1 &
PROXY_PID=$!

sleep 0.5
if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "❌ プロキシサーバーの起動に失敗しました。"
  cat "$TMP_DIR/proxy.log"
  exit 1
fi

echo "🌐 [2/3] Cloudflare Tunnel (cloudflared) を確認中..."

CLOUDFLARED_BIN="cloudflared"
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "ℹ️  cloudflared が見つからないため、一時バイナリをダウンロードします..."
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  
  case "$ARCH" in
    x86_64|amd64) CF_ARCH="amd64" ;;
    arm64|aarch64) CF_ARCH="arm64" ;;
    *) echo "❌ 未対応のアーキテクチャです: $ARCH"; exit 1 ;;
  esac

  DOWNLOAD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${OS}-${CF_ARCH}"
  if [[ "$OS" == "darwin" ]]; then
    DOWNLOAD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CF_ARCH}.tgz"
    curl -fsSL "$DOWNLOAD_URL" -o "$TMP_DIR/cf.tgz" < /dev/null
    tar -xzf "$TMP_DIR/cf.tgz" -C "$TMP_DIR"
    CLOUDFLARED_BIN="$TMP_DIR/cloudflared"
  else
    curl -fsSL "$DOWNLOAD_URL" -o "$TMP_DIR/cloudflared" < /dev/null
    chmod +x "$TMP_DIR/cloudflared"
    CLOUDFLARED_BIN="$TMP_DIR/cloudflared"
  fi
fi

echo "🚇 [3/3] トンネルを接続中..."
# バックグラウンドプロセスに stdin を奪われないよう < /dev/null を付与
"$CLOUDFLARED_BIN" tunnel --url "http://127.0.0.1:${PORT}" < /dev/null > "$TMP_DIR/cloudflared.log" 2>&1 &
CLOUDFLARED_PID=$!

TUNNEL_URL=""
for i in {1..30}; do
  if ! kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    echo "❌ cloudflared プロセスが異常終了しました。"
    cat "$TMP_DIR/cloudflared.log"
    exit 1
  fi

  if [[ -f "$TMP_DIR/cloudflared.log" ]]; then
    FOUND_URL=$(grep -o 'https://[-a-zA-Z0-9.]*\.trycloudflare\.com' "$TMP_DIR/cloudflared.log" | head -n 1 || true)
    if [[ -n "$FOUND_URL" ]]; then
      TUNNEL_URL="$FOUND_URL"
      break
    fi
  fi
  sleep 1
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo "❌ トンネル URL の取得がタイムアウトしました。"
  cat "$TMP_DIR/cloudflared.log"
  exit 1
fi

echo ""
echo "=========================================================================="
echo "🎉 Codex プロキシが正常に起動しました！"
echo "=========================================================================="
echo ""
echo "🔗 プロキシ URL:"
echo "   $TUNNEL_URL"
echo ""
echo "📋 次のコマンドで graft-ai に登録してください:"
echo "   cd workers"
echo "   npx wrangler secret put CODEX_PROXY_URL --config wrangler.provider-metrics.jsonc"
echo "   (プロンプトに上記 URL を入力)"
echo ""
echo "=========================================================================="
echo "※ このプロセスを実行している間、プロキシが有効になります (Ctrl+C で終了)。"
echo "=========================================================================="
echo ""

# トンネルプロセスを監視待機（curl | bash でも標準入力 EOF で終了しないように sleep ループ）
while kill -0 "$CLOUDFLARED_PID" 2>/dev/null; do
  sleep 2
done

echo "⚠️  cloudflared が終了しました。"
cat "$TMP_DIR/cloudflared.log"
