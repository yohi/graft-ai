#!/usr/bin/env bash
# scripts/setup.sh
# =============================================================================
# graft-ai — ワンコマンド完全セットアップスクリプト
#
# 実行内容:
#   1. 前提ツール確認 (npx wrangler / curl / jq / gcx)
#   2. gcx ログイン確認
#   3. Loki 接続情報を gcx API から自動取得
#   4. Cloud Access Policy トークンを Terraform で自動構築（失敗時は手動入力フォールバック）
#   5. AI Gateway ID を Cloudflare API から自動検出 → wrangler.proxy.jsonc 更新
#   6. PROXY_SECRET 自動生成
#   7. Wrangler シークレット登録
#   8. .dev.vars 書き出し (ローカル開発用)
#   9. Tail Worker / Proxy Worker デプロイ
#  10. Grafana ダッシュボード自動インポート
#
# 使い方:
#   cd <repo-root>
#   bash scripts/setup.sh
#
# 環境変数で事前に値を渡すことで対話プロンプトをスキップできます:
#   export GRAFANA_CLOUD_ACCESS_POLICY_TOKEN="glc_..."
#   export PROXY_SECRET="my-secret"
# =============================================================================
set -euo pipefail
export WRANGLER_SEND_METRICS=false

# -----------------------------------------------------------------------------
# カラーヘルパー
# -----------------------------------------------------------------------------
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
step()    { echo -e "\n${BOLD}${GREEN}▶ $*${NC}"; }

ask() {
  local var="$1" prompt="$2" secret="${3:-}" val
  if [[ -n "${!var:-}" ]]; then
    info "$var は既に設定済みです — スキップします。"
    return
  fi
  if [[ "$secret" == "secret" ]]; then
    read -r -s -p "$(echo -e "${YELLOW}[ASK]${NC}  $prompt: ")" val; echo
  else
    read -r -p "$(echo -e "${YELLOW}[ASK]${NC}  $prompt: ")" val
  fi
  [[ -z "$val" ]] && die "$var を空にすることはできません。"
  export "$var"="$val"
}

# -----------------------------------------------------------------------------
# パス解決
# -----------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKERS_DIR="${REPO_ROOT}/workers"
PROXY_WRANGLER="${WORKERS_DIR}/wrangler.proxy.jsonc"
TAIL_WRANGLER="${WORKERS_DIR}/wrangler.tail.jsonc"
DASHBOARD_JSON="${REPO_ROOT}/grafana/dashboards/graft-ai-overview.json"

echo -e """
${BOLD}${CYAN}
╔══════════════════════════════════════════╗
║      graft-ai セットアップ               ║
║  Cloudflare AI Gateway → Grafana Loki    ║
╚══════════════════════════════════════════╝${NC}
"""

# =============================================================================
# STEP 1: 前提確認
# =============================================================================
step "STEP 1/10: 前提ツール確認"

for cmd in curl jq gcx npx; do
  command -v "$cmd" &>/dev/null || die "'$cmd' が見つかりません。インストールしてください。"
  success "$cmd: $(command -v "$cmd")"
done

cd "$WORKERS_DIR"
npx wrangler --version &>/dev/null \
  || die "wrangler が見つかりません。'make install' を先に実行してください。"
success "wrangler: OK"
cd "$REPO_ROOT"

# =============================================================================
# STEP 2: gcx ログイン確認
# =============================================================================
step "STEP 2/10: Grafana gcx ログイン確認"

GCX_LOGIN=$(gcx api /api/user --json login 2>/dev/null | jq -r '.login // empty' || echo "")
if [[ -z "$GCX_LOGIN" ]]; then
  die "gcx にログインしていません。'gcx login' を実行してください。"
fi
success "gcx ログイン済み: ${GCX_LOGIN}"

# Grafana インスタンスの URL を gcx config から取得
GCX_URL=$(grep 'url:' "${HOME}/.config/gcx/config.yaml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"' || echo "")
STACK_SLUG=$(grep 'stack:' "${HOME}/.config/gcx/config.yaml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"' || echo "")
info "Grafana URL: ${GCX_URL:-不明}"
info "Stack: ${STACK_SLUG:-不明}"

# =============================================================================
# STEP 3: Loki 接続情報を自動取得
# =============================================================================
step "STEP 3/10: Loki 接続情報を自動取得"

# Loki URL
GRAFANA_LOKI_URL=$(gcx api "/api/datasources/name/grafanacloud-${STACK_SLUG}-logs" -o json 2>/dev/null \
  | jq -r '.url // empty' | sed 's|/$||' || echo "")

# Loki ユーザー名 (tenant ID)
GRAFANA_LOKI_USERNAME=$(gcx api "/api/datasources/name/grafanacloud-${STACK_SLUG}-logs" -o json 2>/dev/null \
  | jq -r '.basicAuthUser // empty' || echo "")

if [[ -n "$GRAFANA_LOKI_URL" ]]; then
  success "Loki URL: ${GRAFANA_LOKI_URL}"
else
  warn "Loki URL の自動取得に失敗しました。"
  ask GRAFANA_LOKI_URL "Grafana Loki の Push URL を入力してください (例: https://logs-prod-030.grafana.net)"
fi

if [[ -n "$GRAFANA_LOKI_USERNAME" ]]; then
  success "Loki ユーザー名: ${GRAFANA_LOKI_USERNAME}"
else
  warn "Loki ユーザー名の自動取得に失敗しました。"
  ask GRAFANA_LOKI_USERNAME "Loki のユーザー名 / テナント ID を入力してください (数値, 例: 1656713)"
fi

# =============================================================================
# STEP 4: Cloud Access Policy トークン取得
# =============================================================================
step "STEP 4/10: Grafana Cloud Access Policy トークン (logs:write)"

if [[ -z "${GRAFANA_CLOUD_ACCESS_POLICY_TOKEN:-}" ]]; then
  # ── 自動構築: Terraform (優先) ──
  TERRAFORM_AUTO=false

  if [[ -n "${TF_VAR_grafana_cloud_api_key:-}" ]]; then
    info "TF_VAR_grafana_cloud_api_key が設定されています。Terraform で自動構築を試行します..."
    TERRAFORM_AUTO=true
  else
    echo
    read -r -p "$(echo -e "${YELLOW}[ASK]${NC}  Grafana Cloud API Key (org-level, Admin role) をお持ちですか？ Terraform で自動構築できます。[y/N]: ")" HAS_API_KEY
    if [[ "$HAS_API_KEY" =~ ^[Yy]$ ]]; then
      ask TF_VAR_grafana_cloud_api_key "Grafana Cloud API Key を貼り付けてください" secret
      export TF_VAR_grafana_cloud_api_key
      TERRAFORM_AUTO=true
    fi
  fi

  if [[ "$TERRAFORM_AUTO" == true ]]; then
    if [[ -n "${STACK_SLUG:-}" ]]; then
      export TF_VAR_grafana_stack_slug="$STACK_SLUG"
    fi
    cd "${REPO_ROOT}/terraform/grafana"
    info "Terraform init を実行中..."
    TF_LOG_FILE="${REPO_ROOT}/.terraform-init.log"
    if terraform init -input=false -upgrade >"$TF_LOG_FILE" 2>&1; then
      TF_APPLY_LOG="${REPO_ROOT}/.terraform-apply.log"
      info "Terraform apply で Access Policy + Token を自動構築中..."
      if terraform apply \
        -target=grafana_cloud_access_policy.loki_write \
        -target=grafana_cloud_access_policy_token.loki_write \
        -input=false \
        -auto-approve >"$TF_APPLY_LOG" 2>&1; then

        GRAFANA_CLOUD_ACCESS_POLICY_TOKEN=$(terraform output -raw grafana_loki_write_token 2>/dev/null || echo "")
        if [[ -n "$GRAFANA_CLOUD_ACCESS_POLICY_TOKEN" ]]; then
          success "Terraform による Access Policy Token の自動構築が完了しました。"
          export GRAFANA_CLOUD_ACCESS_POLICY_TOKEN
        else
          warn "Terraform は成功しましたが、トークンを出力できませんでした。"
        fi
      else
        warn "Terraform apply に失敗しました。手動入力にフォールバックします。"
        if [[ -f "$TF_APPLY_LOG" ]]; then
          warn "詳細ログ: ${TF_APPLY_LOG}"
          tail -n 20 "$TF_APPLY_LOG" >&2
        fi
      fi
    else
      warn "terraform init に失敗しました。手動入力にフォールバックします。"
      if [[ -f "$TF_LOG_FILE" ]]; then
        warn "詳細ログ: ${TF_LOG_FILE}"
        tail -n 20 "$TF_LOG_FILE" >&2
      fi
    fi
    cd "$REPO_ROOT"
  fi

  # ── フォールバック: 手動入力 ──
  if [[ -z "${GRAFANA_CLOUD_ACCESS_POLICY_TOKEN:-}" ]]; then
    echo -e "
${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}
${BOLD}Loki への書き込みには Cloud Access Policy トークンが必要です。${NC}

以下の手順で作成してください:
  1. ${CYAN}${GCX_URL:-https://your-stack.grafana.net}/admin/access-policies${NC} を開く
     (左メニュー: Administration → Cloud access policies)
  2. 「Create access policy」をクリック
  3. Display name: graft-ai-loki-write
  4. Realms: ${STACK_SLUG:-your-stack} (Stack を選択)
  5. Scopes: logs → Write にチェック
  6. 「Create」→ 「Add token」→ トークン名を入力 → 「Create」
  7. 表示された glc_... トークンをコピー
${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}
"
    ask GRAFANA_CLOUD_ACCESS_POLICY_TOKEN "Access Policy トークン (glc_...) を貼り付けてください" secret
  fi
fi

# Loki write 疎通確認
info "Loki への書き込み疎通確認中..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -u "${GRAFANA_LOKI_USERNAME}:${GRAFANA_CLOUD_ACCESS_POLICY_TOKEN}" \
  -H "Content-Type: application/json" \
  "${GRAFANA_LOKI_URL}/loki/api/v1/push" \
  -d "{\"streams\":[{\"stream\":{\"env\":\"setup\"},\"values\":[[\"$(date +%s%N)\",\"graft-ai setup connectivity check\"]]}]}" \
  || echo "000")

if [[ "$HTTP_STATUS" == "204" ]]; then
  success "Loki 疎通確認 OK (HTTP 204)"
elif [[ "$HTTP_STATUS" == "401" ]]; then
  die "Loki 認証失敗 (HTTP 401)。トークンの logs:write スコープと Realm 設定を確認してください。"
else
  warn "Loki 疎通確認: HTTP ${HTTP_STATUS} — 続行します。"
fi

# =============================================================================
# STEP 5: AI Gateway ID を自動検出 → wrangler.proxy.jsonc を更新
# =============================================================================
step "STEP 5/10: Cloudflare AI Gateway ID の自動検出"

CF_ACCOUNT_ID_ENV="${CF_ACCOUNT_ID:-}"
CF_ACCOUNT_ID=$(jq -r '.vars.CF_ACCOUNT_ID // empty' "$PROXY_WRANGLER" || echo "")
if [[ -z "$CF_ACCOUNT_ID" || "$CF_ACCOUNT_ID" == "replace-with-cloudflare-account-id" ]]; then
  warn "wrangler.proxy.jsonc の CF_ACCOUNT_ID が未設定または初期値です。"
  if [[ -n "$CF_ACCOUNT_ID_ENV" && "$CF_ACCOUNT_ID_ENV" != "replace-with-cloudflare-account-id" ]]; then
    CF_ACCOUNT_ID="$CF_ACCOUNT_ID_ENV"
    info "環境変数 CF_ACCOUNT_ID の値を使用します: ${CF_ACCOUNT_ID}"
  else
    CF_ACCOUNT_ID=""
    ask CF_ACCOUNT_ID "Cloudflare アカウント ID を入力してください"
  fi
  if [[ ! "$CF_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]]; then
    die "CF_ACCOUNT_ID の形式が不正です（32桁の16進数文字列である必要があります）: ${CF_ACCOUNT_ID}"
  fi
  info "wrangler.proxy.jsonc の CF_ACCOUNT_ID を更新中..."
  TMP_FILE=$(mktemp)
  sed "s|\"CF_ACCOUNT_ID\": \"replace-with-cloudflare-account-id\"|\"CF_ACCOUNT_ID\": \"${CF_ACCOUNT_ID}\"|g" \
    "$PROXY_WRANGLER" > "$TMP_FILE" && mv "$TMP_FILE" "$PROXY_WRANGLER"
  success "wrangler.proxy.jsonc の CF_ACCOUNT_ID を更新しました。"
fi

info "Cloudflare アカウント: ${CF_ACCOUNT_ID}"

# wrangler ai gateway list は未サポートのため API で取得
AI_GW_LIST=$(npx wrangler ai gateway list </dev/null 2>/dev/null \
  | jq -r '.id' 2>/dev/null || echo "")

if [[ -z "$AI_GW_LIST" ]]; then
  # フォールバック: CLOUDFLARE_API_TOKEN がある場合は cURL で Cloudflare API を直接実行
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    warn "wrangler から AI Gateway 一覧を取得できません。cURL で API を直接実行します..."
    AI_GW_LIST=$(curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-gateway/gateways" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      | jq -r '.result[].id' 2>/dev/null || echo "")
  else
    warn "wrangler から AI Gateway 一覧を取得できません。かつ CLOUDFLARE_API_TOKEN も未設定のためフォールバックできません。"
  fi
fi

if [[ -z "$AI_GW_LIST" ]]; then
  warn "AI Gateway ID を自動取得できませんでした。"
  CURRENT_GW=$(jq -r '.vars.AI_GATEWAY_ID // "main"' "$PROXY_WRANGLER")
  ask AI_GATEWAY_ID "Cloudflare AI Gateway ID を入力してください (現在: ${CURRENT_GW})"
  AI_GW_LIST="$AI_GATEWAY_ID"
fi

GW_COUNT=$(echo "$AI_GW_LIST" | wc -l)
if [[ "$GW_COUNT" -gt 1 ]]; then
  warn "複数の AI Gateway が検出されました。使用する Gateway ID を選択してください:"
  awk '{print "  - " $0}' <<< "$AI_GW_LIST"
  ask AI_GATEWAY_ID "使用する AI Gateway ID を入力してください"
  DETECTED_GW="$AI_GATEWAY_ID"
else
  DETECTED_GW=$(echo "$AI_GW_LIST" | head -1)
fi
success "AI Gateway ID: ${DETECTED_GW}"

# wrangler.proxy.jsonc の AI_GATEWAY_ID を更新
CURRENT_GW_ID=$(jq -r '.vars.AI_GATEWAY_ID // ""' "$PROXY_WRANGLER")
if [[ "$CURRENT_GW_ID" != "$DETECTED_GW" ]]; then
  info "wrangler.proxy.jsonc の AI_GATEWAY_ID を '${CURRENT_GW_ID}' → '${DETECTED_GW}' に更新..."
  # jq で書き換え (tmpファイル経由)
  TMP_FILE=$(mktemp)
  # jsonc はコメントがあるため sed で置換
  sed "s|\"AI_GATEWAY_ID\": \"${CURRENT_GW_ID}\"|\"AI_GATEWAY_ID\": \"${DETECTED_GW}\"|g" \
    "$PROXY_WRANGLER" > "$TMP_FILE" && mv "$TMP_FILE" "$PROXY_WRANGLER"
  success "wrangler.proxy.jsonc 更新完了"
else
  success "AI_GATEWAY_ID は既に '${DETECTED_GW}' です — スキップ"
fi

# =============================================================================
# STEP 6: PROXY_SECRET 生成
# =============================================================================
step "STEP 6/10: PROXY_SECRET 生成"

if [[ -z "${PROXY_SECRET:-}" ]]; then
  if command -v python3 &>/dev/null; then
    PROXY_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(36))")
  else
    set +o pipefail
    PROXY_SECRET=$(LC_ALL=C tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 48)
    set -o pipefail
  fi
  success "PROXY_SECRET を自動生成しました。"
else
  success "PROXY_SECRET は既に設定済みです。"
fi

# =============================================================================
# STEP 7: Wrangler シークレット登録
# =============================================================================
step "STEP 7/10: Wrangler シークレット登録"

cd "$WORKERS_DIR"

register_secret() {
  local name="$1" value="$2" config="$3"
  local worker
  worker=$(jq -r '.name // ""' "$config" 2>/dev/null || grep '"name"' "$config" | head -1 | awk -F'"' '{print $4}')
  if ! echo "$value" | npx wrangler secret put "$name" --config "$config" ; then
    echo -e "${RED}[ERROR]${NC} Secret '$name' の登録に失敗しました。" >&2
    echo -e "${YELLOW}Cloudflare API トークン (CLOUDFLARE_API_TOKEN) の権限が不足している可能性があります。${NC}" >&2
    echo -e "以下の権限が付与されていることをご確認ください：" >&2
    echo -e "  - アカウント (Account) > Workers スクリプト (Workers Scripts) > 編集 (Edit)" >&2
    echo -e "  - アカウント (Account) > AI Gateway > 表示 (Read)" >&2
    echo -e "  - ユーザー (User) > メンバーシップ (Memberships) > 表示 (Read)" >&2
    exit 1
  fi
  success "Secret '$name' → ${worker}"
}

register_secret "GRAFANA_CLOUD_LOKI_URL"            "$GRAFANA_LOKI_URL"                       "$TAIL_WRANGLER"
register_secret "GRAFANA_CLOUD_LOKI_USERNAME"       "$GRAFANA_LOKI_USERNAME"                  "$TAIL_WRANGLER"
register_secret "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN" "$GRAFANA_CLOUD_ACCESS_POLICY_TOKEN"      "$TAIL_WRANGLER"
register_secret "PROXY_SECRET"                      "$PROXY_SECRET"                           "$PROXY_WRANGLER"

# =============================================================================
# STEP 8: .dev.vars 書き出し
# =============================================================================
step "STEP 8/10: .dev.vars 書き出し (ローカル開発用)"

DEV_VARS="${WORKERS_DIR}/.dev.vars"
cat > "$DEV_VARS" <<EOF
GRAFANA_CLOUD_LOKI_URL=${GRAFANA_LOKI_URL}
GRAFANA_CLOUD_LOKI_USERNAME=${GRAFANA_LOKI_USERNAME}
GRAFANA_CLOUD_ACCESS_POLICY_TOKEN=${GRAFANA_CLOUD_ACCESS_POLICY_TOKEN}
PROXY_SECRET=${PROXY_SECRET}
EOF
chmod 600 "$DEV_VARS"
success ".dev.vars を書き出しました: ${DEV_VARS}"

# =============================================================================
# STEP 9: Workers デプロイ
# =============================================================================
step "STEP 9/10: Workers デプロイ"

info "Tail Worker をデプロイ中..."
if ! npx wrangler deploy --config "$TAIL_WRANGLER" ; then
  echo -e "${RED}[ERROR]${NC} Tail Worker のデプロイに失敗しました。" >&2
  echo -e "${YELLOW}CLOUDFLARE_API_TOKEN の権限（Workers 編集権限等）をご確認ください。${NC}" >&2
  exit 1
fi
success "Tail Worker デプロイ完了"

info "Proxy Worker をデプロイ中..."
if ! npx wrangler deploy --config "$PROXY_WRANGLER" ; then
  echo -e "${RED}[ERROR]${NC} Proxy Worker のデプロイに失敗しました。" >&2
  echo -e "${YELLOW}CLOUDFLARE_API_TOKEN の権限（Workers 編集権限等）をご確認ください。${NC}" >&2
  exit 1
fi
success "Proxy Worker デプロイ完了"

cd "$REPO_ROOT"

# =============================================================================
# STEP 10: Grafana ダッシュボード インポート
# =============================================================================
step "STEP 10/10: Grafana ダッシュボード インポート"

if [[ ! -f "$DASHBOARD_JSON" ]]; then
  warn "ダッシュボード JSON が見つかりません: ${DASHBOARD_JSON} — スキップします。"
else
  IMPORT_RESULT=$(gcx api /api/dashboards/db -d @"$DASHBOARD_JSON" -o json 2>/dev/null \
    | jq -r '{status: .status, uid: .uid, url: .url}' || echo "")

  DASH_STATUS=$(echo "$IMPORT_RESULT" | jq -r '.status // "unknown"')
  DASH_URL=$(echo "$IMPORT_RESULT" | jq -r '.url // ""')

  if [[ "$DASH_STATUS" == "success" ]]; then
    success "ダッシュボードをインポートしました!"
    info "URL: ${GCX_URL:-https://your-stack.grafana.net}${DASH_URL}"
  else
    warn "ダッシュボードのインポートに失敗しました: ${IMPORT_RESULT}"
    warn "手動で以下を実行してください:"
    warn "  gcx api /api/dashboards/db -d @${DASHBOARD_JSON}"
  fi
fi

# =============================================================================
# 完了サマリー
# =============================================================================
PROXY_URL=$(grep -m1 'workers.dev' <<< "$(npx wrangler deployments list \
  --config "$PROXY_WRANGLER" </dev/null 2>/dev/null | grep 'workers.dev')" \
  | awk '{print $NF}' || echo "https://graft-ai-aig-proxy.<your-namespace>.workers.dev")

cat <<SUMMARY

${GREEN}╔══════════════════════════════════════════════════════╗
║        graft-ai セットアップ完了！                    ║
╚══════════════════════════════════════════════════════╝${NC}

${BOLD}Proxy Worker URL:${NC}
  ${CYAN}${PROXY_URL}${NC}

${BOLD}X-Proxy-Secret:${NC}
  ${CYAN}${PROXY_SECRET}${NC}

${BOLD}テストリクエスト:${NC}
  curl -X POST ${PROXY_URL}/workers-ai/v1/chat/completions \\
    -H 'Content-Type: application/json' \\
    -H 'Authorization: Bearer <CF_API_TOKEN>' \\
    -H 'X-Proxy-Secret: ${PROXY_SECRET}' \\
    -d '{"model":"@cf/meta/llama-3.2-1b-instruct","messages":[{"role":"user","content":"Hello!"}]}'

${BOLD}Grafana ダッシュボード:${NC}
  ${CYAN}${GCX_URL:-https://your-stack.grafana.net}/d/graft-ai-aig-overview${NC}

${BOLD}ログクエリ (Grafana Explore):${NC}
  {gateway="main"}

${GREEN}══════════════════════════════════════════════════════${NC}
SUMMARY
