#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# graft-ai Codex Proxy - systemd サービス自動セットアップスクリプト
# ==============================================================================
# Usage:
#   sudo ./setup-systemd.sh [TUNNEL_TOKEN]
# ==============================================================================

if [[ $EUID -ne 0 ]]; then
   echo "❌ このスクリプトは sudo (root 権限) で実行してください。"
   exit 1
fi

INSTALL_DIR="/opt/graft-ai-codex-proxy"
SERVICE_FILE="/etc/systemd/system/graft-ai-codex-proxy.service"
CURRENT_USER="${SUDO_USER:-$(whoami)}"

echo "📦 [1/4] プロキシファイルを ${INSTALL_DIR} に配置中..."
mkdir -p "${INSTALL_DIR}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "${SCRIPT_DIR}/server.mjs" "${INSTALL_DIR}/server.mjs"
chown -R "${CURRENT_USER}:${CURRENT_USER}" "${INSTALL_DIR}"

echo "⚙️  [2/4] systemd サービスを登録中..."
cat << EOF > "${SERVICE_FILE}"
[Unit]
Description=graft-ai Codex Residential Proxy
After=network.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node || echo "/usr/bin/node") ${INSTALL_DIR}/server.mjs
Restart=always
RestartSec=5
Environment=PORT=8080
Environment=HOST=127.0.0.1
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now graft-ai-codex-proxy

echo "✅ プロキシサービス (ポート 8080) が常駐起動しました。"

TUNNEL_TOKEN="${1:-}"

if [[ -z "${TUNNEL_TOKEN}" ]]; then
  echo ""
  echo "🌐 [3/4] Cloudflare Tunnel の設定:"
  echo "   固定ドメインで運用するには、Cloudflare Zero Trust ダッシュボードで Tunnel を作成し、"
  echo "   表示された Token を指定して以下を実行してください:"
  echo "   sudo cloudflared service install <TUNNEL_TOKEN>"
else
  echo "🚇 [3/4] cloudflared サービスをインストール中..."
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared をインストール中..."
    curl --proto '=https' --tlsv1.2 -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared jammy main' | tee /etc/apt/sources.list.d/cloudflared.list
    apt-get update && apt-get install -y cloudflared || true
  fi

  cloudflared service install "${TUNNEL_TOKEN}" || true
  systemctl restart cloudflared || true
  echo "✅ cloudflared サービスが常駐起動しました。"
fi

echo ""
echo "=========================================================================="
echo "🎉 永続化セットアップが完了しました！"
echo "=========================================================================="
echo "ステータス確認コマンド:"
echo "  sudo systemctl status graft-ai-codex-proxy"
if [[ -n "${TUNNEL_TOKEN}" ]]; then
  echo "  sudo systemctl status cloudflared"
fi
echo "=========================================================================="
