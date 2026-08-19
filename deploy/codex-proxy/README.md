# Codex Residential Proxy (with Cloudflare Tunnel)

`chatgpt.com` の Cloudflare WAF による 403 Challenge（Turnstile）を回避し、`graft-ai` から Codex の利用量メトリクスを安定して取得するための住宅用ネットワーク（自宅 PC / Raspberry Pi / 自宅サーバ等）向け軽量プロキシです。

---

## 📌 概要・アーキテクチャ

`chatgpt.com` の API は、Cloudflare Workers 等のデータセンター IP からの直接アクセスに対して Bot 判定（403 WAF チャレンジ）を行います。
本プロキシを自宅等の一般家庭用インターネット回線上で起動し、**Cloudflare Tunnel** 経由で公開することで、データセンター IP 制限を受けずに安全にメトリクスを取得できます。

```
[ graft-ai (Cloudflare Workers) ]
       │ HTTPS (Cron: 毎分)
       ▼
[ Cloudflare Tunnel (無料) ]  ← https://codex-proxy.yourdomain.com
       │
       ▼
[ 自宅マシン (Raspberry Pi / Mac / PC) ]  ← 本プロキシ (deploy/codex-proxy)
       │ 一般家庭用回線 (住宅用 IP) から通信 🏠
       ▼
[ chatgpt.com /backend-api/wham/usage ]  ← 200 OK で正常取得！
```

---

## 🚀 セットアップ手順

### 方法 1: ローカルリポジトリから起動（推奨）

リポジトリをクローン後、スクリプトを実行します（Cloudflare Tunnel の開通および安全な共有シークレット生成が自動で行われます）：

```bash
cd deploy/codex-proxy
./run.sh
```

### 方法 2: ワンライナー起動（クイックスタート）

自宅の PC / Mac / Linux で以下のコマンドを実行して起動することも可能です（内容を確認した上で実行してください）：

```bash
curl -fsSL https://raw.githubusercontent.com/yohi/graft-ai/master/deploy/codex-proxy/run.sh | bash
```

---

### 方法 2: 手動 Quick Tunnel 起動

ドメイン設定やアカウント登録なしで、即座に一時的な公開 URL を取得できます。

#### 1. プロキシの起動
自宅マシンで Node.js を使って直接起動します（Node.js v18 以上、外部依存ライブラリ不要）：

```bash
cd deploy/codex-proxy
node server.mjs
# → http://0.0.0.0:8080 で起動
```

#### 2. `cloudflared` でトンネルを開通
別ターミナルで以下を実行します：

```bash
# macOS (Homebrew) の場合: brew install cloudflared
# Linux の場合: sudo apt install cloudflared または公式バイナリ

cloudflared tunnel --url http://127.0.0.1:8080
```

コンソールに以下のような一時 URL が表示されます：
```
https://xxxx-xxxx-xxxx.trycloudflare.com
```

#### 3. 動作確認
```bash
curl https://xxxx-xxxx-xxxx.trycloudflare.com/healthz
# {"status":"ok","service":"graft-ai-codex-proxy"}
```

---

### 方法 2: Cloudflare Zero Trust の固定 Tunnel（本番運用・永続化に推奨）

独自ドメインのサブドメイン（例: `codex-proxy.yourdomain.com`）に紐付けて常時起動させる方法です。

#### 1. Cloudflare ダッシュボードで Tunnel を作成
1. [Cloudflare Zero Trust ダッシュボード](https://one.dash.cloudflare.com/) にアクセス（Free プランで利用可能）。
2. **Networks** > **Tunnels** > **Create a tunnel** を選択。
3. トンネルタイプ: **Cloudflared** を選択し、適当な名前（例: `graft-ai-codex-proxy`）を入力。
4. 表示される **Tunnel Token**（`eyJh...` という長い文字列）をコピー。
5. **Public Hostnames** 設定で以下を指定：
   - **Subdomain**: `codex-proxy`（お好みのサブドメイン）
   - **Domain**: 管理しているドメインを選択
   - **Service Type**: `HTTP`
   - **URL**: `codex-proxy:8080`（Docker Compose の場合）または `localhost:8080`

#### 2. 永続起動の方法 (Docker または systemd)

**パターン A: systemd サービスとして自動起動する場合 (Linux / ThinkCentreTiny 推奨)**
ワンコマンドでプロキシと `cloudflared` の常駐サービス化（OS 起動時の自動起動）を完了できます：

```bash
cd deploy/codex-proxy
sudo ./setup-systemd.sh [Cloudflare Tunnel Token]
```

**パターン B: Docker Compose で常時起動する場合**
`deploy/codex-proxy/docker-compose.yml` を編集し、コメントアウトを解除して Tunnel Token を設定します：

```yaml
services:
  codex-proxy:
    build: .
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - HOST=0.0.0.0

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=eyJh...（取得したTunnel Token）
```

起動します：
```bash
cd deploy/codex-proxy
docker compose up -d
```

---

## ⚙️ `graft-ai` への設定

公開されたプロキシ URL および共有シークレットを `graft-ai` の Secret に登録します：

```bash
cd workers
npx wrangler secret put CODEX_PROXY_URL --config wrangler.provider-metrics.jsonc
npx wrangler secret put CODEX_PROXY_SECRET --config wrangler.provider-metrics.jsonc
```

プロンプトが表示されたら、プロキシの URL / シークレットを入力します：
```
Enter a secret value: https://codex-proxy.yourdomain.com
```

---

## 🔒 セキュリティと保護機能

- **パスホワイトリスト制限:**
  本プロキシは、オープンプロキシ化を防ぐため `/backend-api/wham/usage` および `/backend-api/wham/rate-limit-reset-credits` などの許可されたエンドポイント宛てのリクエストのみを `chatgpt.com` に転送し、それ以外のパスは `403 Forbidden` で拒否します。
- **共有シークレット保護（必須）:**
  `PROXY_SECRET` による認証が必須化されており、`X-Proxy-Secret` ヘッダーが一致しないリクエストを `401 Unauthorized` で遮断します（`graft-ai` の `CODEX_PROXY_SECRET` 設定と連携します）。`setup-systemd.sh` や `run.sh` を利用する場合は自動生成されます。
