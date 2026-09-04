# Cloudflare AI Gateway OTel Payload Store: Cloudflare D1 移行 要件定義書

- **作成日:** 2026-09-04
- **対象リポジトリ:** `yohi/graft-ai`
- **対象コンポーネント:** `workers/src/otel/` (Cloudflare Worker: `graft-ai-aig-otel`), `terraform/`

---

## 1. 背景と課題

### 1.1 背景
`graft-ai` では、Cloudflare AI Gateway から送信される OpenTelemetry (OTLP) トレースを受信し、Grafana Cloud (Tempo / Loki / Prometheus) へ中継する専用 Worker (`graft-ai-aig-otel`) を運用している。

### 1.2 課題（障害の発生）
- **KV 無料枠の枯渇:**
  - 現在の既定バックエンド `OTEL_PAYLOAD_STORE=kv` は、Cloudflare Workers KV の無料枠上限である **1,000 writes/day** に制約されている。
  - AI Gateway 経由でのリクエスト発生に伴い、**午前 10:48 (JST) の時点で 1,000 回の書き込み枠を使い切り**、以降すべてのトレース受信が `503 Service Unavailable` (`{"error":"persistence_failed"}`) となってダッシュボード上のメトリクス・ログが途絶した。
- **R2 のカード要件:**
  - 既存設計では逃げ道として R2 (`OTEL_PAYLOAD_STORE=r2`) が実装されているが、Cloudflare R2 は無料枠内（100万回/月）であっても**有効化時にクレジットカード登録が必須**である。
  - 「クレジットカード登録なし・完全無料」での運用を維持する限り、R2 への移行は選択できない。

---

## 2. 目的

1. **クレジットカード登録不要（完全無料）の維持:**
   - 支払い情報の登録を一切行わずに利用可能な Cloudflare サービスのみで完結させる。
2. **十分な無料枠容量の確保:**
   - 日常的な LLM / AI 開発作業（コーディングエージェント等の高頻度呼び出し）に耐えられる日次書き込み枠を確保する。
3. **既存アーキテクチャの破壊最小化:**
   - 既存の `PayloadStore` 抽象インターフェースを活用し、Queue、Durable Objects (Ledger / RateLimit)、リトライ制御等の既存信頼性設計をそのまま維持する。

---

## 3. 採用方針

**Cloudflare D1 (Serverless SQLite) をペイロードストアとして追加・既定化する。**

### 各ストレージの無料枠比較

| 項目 | Workers KV (現状) | Cloudflare R2 | **Cloudflare D1 (採用)** |
| :--- | :--- | :--- | :--- |
| **クレジットカード登録** | **不要** | **必須** | **不要** |
| **書き込み上限 (Free)** | **1,000 回 / 日** | 1,000,000 回 / 月 | **100,000 行 / 日** (KVの100倍) |
| **読み取り上限 (Free)** | 100,000 回 / 日 | 10,000,000 回 / 月 | **5,000,000 行 / 日** |
| **ストレージ容量** | 1 GB | 10 GB | **5 GB** |
| **整合性** | Eventual Consistency (反映遅延あり) | Strong Consistency | **Strong Consistency** |

### 実効スループットと操作数試算

Cloudflare D1 Free の「書き込み 100,000 行/日」は、`INSERT` だけでなく `DELETE` でもそれぞれ 1 row write がカウントされる。
- **1 ペイロードあたりの操作数:**
  - 登録時: `INSERT INTO otel_payloads`（1 write）
  - 読取時: `SELECT data, sha256...`（1 read）
  - 正常完了後: `DELETE FROM otel_payloads`（1 write）
  - 通常ライフサイクル合計: **2 writes / 1 read**
- **1 リクエストあたりの総書き込み数:**
  - Ingress ペイロードのみ: 2 writes / req
  - Export ペイロード（Tempo / Loki への転送時）: Ingress (2 writes) + Tempo (2 writes) + Loki (2 writes) = **最大約 6 writes / req**
  - ※ 孤立レコードの Cron パージ（`deleteExpired`）は正常完了レコードと重複せず、未削除の異常レコードのみ 1 write / 件を消費する。
- **実効処理許容量:**
  - Ingress ペイロード換算: 最大 **50,000 payloads / 日**（約 0.58 req/sec）
  - フルパイプライン転送（全バックエンドExport）換算: 約 **16,666 requests / 日**（約 0.19 req/sec）

D1 を採用することで、クレジットカード不要のまま書き込み許容量を KV の 1,000 writes/day から **実効 16〜50 倍へと大幅に拡大** し、日常的な高頻度呼び出し（コーディングエージェント等）における書き込み枠枯渇リスクを大幅に低減する。

---

## 4. 機能要件

### 4.1 ペイロードの保存・取得・削除 (D1PayloadStore)
- `PayloadStore` インターフェース（`putBytesObject`, `readBytesObject`, `deleteObject`）を満たす `D1PayloadStore` を実装する。
- テーブル構成:
  - テーブル名: `otel_payloads`
  - カラム:
    - `object_key` (TEXT PRIMARY KEY): オブジェクト識別キー (例: `otel/ingress/...json`)
    - `sha256` (TEXT NOT NULL): ペイロードの SHA-256 チェックサム
    - `content_type` (TEXT NOT NULL): `"application/json"`
    - `kind` (TEXT NOT NULL): `"ingress"` または `"export"`
    - `data` (BLOB NOT NULL): ペイロードのバイト列
    - `created_at` (INTEGER NOT NULL): 作成エポック秒
    - `expires_at` (INTEGER NOT NULL): 有効期限エポック秒 (TTL: 7日間)
- 整合性チェック:
  - 読み取り時に SHA-256 チェックサムおよび Content-Type の検証を行い、不整合時は `PayloadStoreIntegrityError` をスローする。
- 期限切れデータのクリーンアップ:
  - 定期実行または書き込み時に `expires_at < strftime('%s', 'now')` となる古いレコードを削除可能とする。

### 4.2 バックエンドセレクタの拡張
- `PAYLOAD_STORE_BACKENDS` に `"d1"` を追加する。
  - 選択可能バックエンド: `["kv", "r2", "d1"]`
- `OTEL_PAYLOAD_STORE` 環境変数で `d1` を指定可能とし、新規デプロイの推奨既定値とする。
- `CurrentObjectPointer` の `storageBackend` に `"d1"` を対応させる。
- D1 は強整合性（Strong Consistency）を持つため、KV で必須だった **60秒の Queue 送信遅延 (`KV_PROPAGATION_DELAY_SECONDS`) は D1 ポインタでは 0 秒（即時配信）** とする。

### 4.3 既存データおよび他バックエンドとの後方互換性
- キューに残存している既存の KV ポインタ (`storageBackend: "kv"`) や R2 ポインタ (`storageBackend: "r2"`, schemaVersion: 1) は、それぞれ適切な Store 実装で読み取り・削除できる後方互換性を保持する。

---

## 5. 非機能要件

1. **信頼性とエラーハンドリング:**
   - D1 の一時的エラー（タイムアウト・ロック競合等）は適切にキャッチし、リトライ可能な `PayloadStoreTemporaryError` として分類する。
2. **パフォーマンス・レイテンシ:**
   - D1 への INSERT は単一クエリで行い、Worker の実行時間に不要なオーバーヘッドを与えない。
3. **セキュリティとデータ保護:**
   - ペイロード保存前の `redactSpan` による機密情報（API キー、トークン等）のマスク処理は既存通り厳格に維持する。
   - SQL インジェクションを防ぐため、すべての D1 クエリはプリペアドステートメント（バインドパラメータ）を使用する。

---

## 6. インフラ要件 (Terraform / Cloudflare)

### 6.1 Terraform
- `terraform/otel.tf` に D1 データベース定義を追加:
  ```hcl
  resource "cloudflare_d1_database" "otel_payloads" {
    account_id = var.cloudflare_account_id
    name       = "graft-ai-aig-otel-payloads-v1"
  }
  ```
- 初期スキーマ適用用のマイグレーションスクリプトまたは Wrangler D1 適用コマンドの整備。

### 6.2 Worker バインディング (`wrangler.otel.jsonc`)
- D1 データベースバインディングを追加:
  ```jsonc
  "d1_databases": [
    {
      "binding": "OTEL_PAYLOAD_D1",
      "database_name": "graft-ai-aig-otel-payloads-v1",
      "database_id": "<d1_database_id>"
    }
  ]
  ```

---

## 7. 変更対象ファイル一覧

| パス | 変更内容 |
| :--- | :--- |
| `workers/migrations/0001_create_otel_payloads.sql` | D1 テーブル (`otel_payloads`) および TTL インデックス作成マイグレーション |
| `workers/src/otel/contracts.ts` | `PAYLOAD_STORE_BACKENDS` に `"d1"` を追加 |
| `workers/src/otel/types.ts` | `OtelEnv` 型定義に `OTEL_PAYLOAD_D1?: D1Database` を追加 |
| `workers/src/otel/storage.ts` | `D1PayloadStore` クラスの実装、ストア解決ロジックに D1 を追加（既定化） |
| `workers/src/otel.ts` | Worker エントリポイントに `scheduled` ハンドラー（TTL 期限切れ定期削除）を追加 |
| `workers/wrangler.otel.jsonc` | D1 バインディングおよび Cron トポロジ (`triggers.crons`) の追加、ストア既定を `d1` へ更新 |
| `workers/package.json` | D1 テスト用レンダリングスクリプト (`render:otel:d1-test` 等) の追加 |
| `terraform/otel.tf` | `cloudflare_d1_database` リソースの追加 |
| `terraform/variables.tf` | `otel_d1_database_name` 変数の追加 |
| `terraform/outputs.tf` | D1 database ID の output 追加 |
| `Makefile` | `OTEL_PAYLOAD_STORE ?= d1` 既定化、D1 インフラ作成ターゲット、マイグレーション適用、レンダリング引数統合 |
| `scripts/render-otel-worker-config.mjs` | D1 バインディングのレンダリング対応、本番での `--d1-database-id` 厳格バリデーション |
| `scripts/verify-otel-worker-config.mjs` | D1 設定および Cron トリガー設定の整合性検証 |
| `workers/tests/otel/storage.test.ts` | `D1PayloadStore` の単体テスト（Put/Read/Delete/CheckSum検証/TTL削除）追加 |
| `workers/tests/otel/scheduled.test.ts` | `scheduled` 定期削除ハンドラーのエラー伝播・単体テスト追加 |
| `workers/tests/otel-worker-contracts.test.mjs` | OTel Worker 設定・バインディング契約テスト更新 |
| `tests/deployment-contracts.test.mjs` | Makefile およびデプロイパイプライン契約テスト更新 |
| `README.md` / `README.ja.md` | D1 バックエンドおよび制限値・運用の追記 |
| `SPEC.md` / `SPEC.ja.md` | D1 バックエンド、スキーマ、定期削除契約の仕様追記 |
| `docs/cloudflare-worker-ai-gateway-otel.md` | D1 前提のセットアップ・デプロイ手順更新 |

---

## 8. 受け入れ条件 (Acceptance Criteria)

1. `make test`、`make typecheck`、`make validate` がすべて正常に通過すること。
2. D1 に対する単体テスト（Put/Read/Delete/CheckSum検証/TTL削除）がパスすること。
3. `OTEL_PAYLOAD_STORE=d1` を設定した Worker に合成 OTLP トレースを送信した際、`200 OK` (または `202 Accepted`) で処理され、Prometheus / Grafana にデータが反映されること。
4. クレジットカード登録を要求されることなくデプロイ・稼働できること。
