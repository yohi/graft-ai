# Cloudflare AI Gateway ログ収集設計

- **作成日**: 2026-07-03
- **対象サブシステム**: サブシステム 1（Cloudflare AI Gateway → Grafana Cloud Loki）
- **状態**: 設計承認済み
- **採用アプローチ**: A — Cloudflare Workers 経由で変換・転送

## 1. 目的

既存の Cloudflare AI Gateway で生成されるアクセスログを、Grafana Cloud Loki にリアルタイムに集約する。これにより、後続の OpenAI / Ollama メトリクスと同一の時間軸で AI Gateway のリクエスト数、ステータスコード、レイテンシ、トークン数を可視化できるようになる。

## 2. 前提条件

- Cloudflare AI Gateway は既に運用中である。
- Grafana Cloud アカウントは存在するが、Loki エンドポイント URL および Access Policy Token は未発行である。
- インフラ管理は Terraform（IaC）で行う。

## 3. アーキテクチャと構成要素

### 3.1 全体像

```text
[クライアント/アプリ]
    ↓
[Cloudflare AI Gateway] ── ログ生成 ──→ [Cloudflare Logpush]
                                           ↓ 暗号化・gzip 圧縮済み NDJSON
[Cloudflare Workers（受信・復号・解凍層）]
                                           ↓ NDJSON
[Cloudflare Workers（変換層）]
                                           ↓ JSON streams
[Grafana Cloud Loki]
                                           ↓
[Grafana Cloud ダッシュボード]
```

### 3.2 構成要素と責務

| 構成要素 | Terraform リソース / 実装 | 責務 |
|---|---|---|
| **AI Gateway** | 既存（運用中） | プロキシとして AI リクエストを処理し、アクセスログを生成する。 |
| **Logpush Job** | `cloudflare_logpush_job` | Gateway ログをリアルタイムに取得し、Workers エンドポイントへ NDJSON で POST する。 |
| **変換 Workers** | `cloudflare_workers_script` | NDJSON をパースし、不要フィールドを除去、Loki push 形式に変換、Grafana Cloud Loki へ転送する。 |
| **認証情報** | `cloudflare_workers_secret` | Grafana Cloud Access Policy Token を Workers シークレットとして保持する。 |
| **Loki** | Grafana Cloud マネージド | 変換後のログを 14 日間保管する。 |
| **Grafana データソース** | 手動または Terraform（後続サブシステムで統合） | Loki を Grafana ダッシュボードのデータソースとして登録する。 |

### 3.3 Terraform 管理方針

- `terraform/` ディレクトリを新設し、Cloudflare リソースを IaC 管理する。
- 機密情報（Grafana token、Cloudflare API token）は環境変数または Cloudflare Workers Secret / リモートシークレットマネージャーで注入する。これらのトークンは `*.tfvars` では管理しない。
- ステートファイルはリモートバックエンド（例：Terraform Cloud、S3 等）を推奨する（別途相談）。

## 4. データフローと変換処理

### 4.1 Logpush から送られてくるログ形式

Cloudflare AI Gateway の Logpush 出力は、リクエストごとに 1 行の NDJSON（改行区切り JSON）である。ただし Workers 宛ての Workers Logpush では、Cloudflare がアップロードされた RSA 公開鍵で暗号化し、gzip で圧縮して配信する。Workers 側では復号・解凍後に NDJSON をパースする。想定される主要フィールドは以下の通り。実際のフィールド名は Cloudflare 公式ドキュメントまたは実際のログ出力で確認し、実装時に調整する。

```json
{
  "RequestID": "abc123",
  "RequestTime": 1720032000,
  "CacheStatus": "miss",
  "StatusCode": 200,
  "Model": "@cf/meta/llama-3.1-8b-instruct",
  "PromptTokens": 150,
  "CompletionTokens": 80,
  "TotalTokens": 230,
  "RequestDuration": 1250,
  "Path": "/v1/chat/completions",
  "Method": "POST",
  "ResponseHeaders": { },
  "RequestHeaders": { }
}
```

### 4.2 Workers での変換ルール

Workers は NDJSON の各行を以下のように Loki 用 JSON streams 形式に変換する。

1. **タイムスタンプ変換**
   - Logpush の `output_options.timestamp_format` は `"unix"`（秒）とする。Workers 側の `requestTimeToNanos` は、秒（10 桁以下）またはミリ秒（13 桁以下）のみを受け入れ、ナノ秒に変換する。
   - 秒の場合：`RequestTime × 1_000_000_000` でナノ秒に変換する。
   - ミリ秒の場合：`RequestTime × 1_000_000` でナノ秒に変換する。
   - 14 桁以上の値が来た場合、既にナノ秒や未知の精度である可能性があるため異常値として扱い、該当ログ行をスキップして Workers Logs に記録する。
   - 実装時に Cloudflare Logpush からのサンプルログで 10 桁（秒）を確認済み。13 桁（ミリ秒）ブランチは、異なる `timestamp_format` 設定や将来の変更に備えた防御的な対応として保持している。
   - Loki は各ログ行に `[<unix epoch in nanoseconds>, "<log line>"]` を要求する。

2. **ラベル（インデックス）の付与**
   - `model`：モデル名。Cloudflare のモデル ID（例：`@cf/meta/llama-3.1-8b-instruct`）からベンダー/スコープ部分を除去し、簡潔なモデル名（例：`llama-3.1-8b`）に正規化する。正確な正規化ルールは実装時に確定する。
   - `status_code`：HTTP ステータスコード
   - `env`：環境（prod / stg）
   - `gateway`：AI Gateway 名

3. **ログ本文に含めるフィールド**
   - 全文検索・詳細表示用に以下を JSON 文字列化する。
     - `RequestID`, `CacheStatus`, `PromptTokens`, `CompletionTokens`, `TotalTokens`, `RequestDuration`, `Path`, `Method`

4. **除外するフィールド**
   - 容量削減のため、ヘッダー全体や大きなペイロードは原則除外する。
   - 必要に応じて `RequestHeaders` から `X-Environment` など特定ヘッダーのみ抽出する。

### 4.3 Loki への push 形式

```json
{
  "streams": [
    {
      "stream": {
        "model": "llama-3.1-8b",
        "status_code": "200",
        "env": "prod",
        "gateway": "main"
      },
      "values": [
        [
          "1720032000000000000",
          "{\"request_id\":\"abc123\",\"prompt_tokens\":150,\"completion_tokens\":80,\"total_tokens\":230,\"duration_ms\":1250}"
        ]
      ]
    }
  ]
}
```

### 4.4 カーディナリティ管理

- ラベルは上記 4 つのみとし、モデル名が多くても数百〜数千程度に収まる想定。
- Loki はラベルの値の組み合わせ（= ストリーム数）が多すぎるとクエリ性能が低下するため、ラベルとその値の数を最小限に抑える。
- Grafana Cloud Free Tier のログ制限は主に「月間 50 GB」のログ転送量であり、Loki 自体のラベル数に関する上限は Prometheus の「10,000 アクティブシリーズ」とは別の概念であることに留意する。

## 5. エラー処理と信頼性

### 5.1 データフローにおける障害点と対策

| 障害点 | 対策 |
|---|---|
| **Logpush → Workers 間の到達失敗** | Workers が 5xx を返すことで、Cloudflare Logpush が自動再試行（指数関数的バックオフ）する。 |
| **Workers 内の変換エラー** | 不正な行は単独でスキップし、正常行は続行する。異常行は Workers Logs に記録する。 |
| **Workers → Loki 間の障害** | Loki から 4xx/5xx が返った場合、Workers も 5xx を返して Logpush に再試行させる。再試行により Loki への重複書き込みが生じうるが、Cloudflare Logpush の再試行は同じバッチ単位で行われるため、分析用途では重複を無視または `RequestID` による重複排除クエリで対処する。 |
| **Grafana Cloud 側のレート制限** | Loki プッシュ時に 429 を受け取ったら、Workers 内で短いバックオフ（最大数秒）後に再試行する。 |
| **タイムアウト** | Loki プッシュは Workers の subrequest タイムアウト（30 秒）内に収める。大きなバッチは Logpush 側で調整する。 |

### 5.2 再試行ポリシー

- **Cloudflare Logpush 側**
  - Workers から 200 系以外が返れば自動再試行する。
  - 再試行間隔は Cloudflare 側で管理されるため、Workers 側で複雑なキューイングは不要。

- Loki プッシュ失敗時は、即座に 5xx を返し Logpush の再試行に委ねる。
  - このとき Workers 内で Loki へ一部の行のみ送信成功していた場合、再試行により同じバッチ全体が再度 Loki に送られる可能性がある。これを許容し、必要に応じて Loki クエリ側で `RequestID` を使った重複排除を行う。
  - 将来的に重複を厳密に排除したい場合は、バッチ全体を Loki への送信成功後に 200 を返す「すべて-or-なし」の原子性を保つ。ただしこの場合も Loki 側の重複排除（例：冪等キー）が必要となる。
- ただし 429（rate limit）の場合のみ、Workers 内で短いバックオフ（最大数秒）後に最大 3 回まで再試行する。
  - それでも失敗したら 5xx を返す。

### 5.3 モニタリング

- Workers の `exceptions` と `subrequest` エラーを Cloudflare Workers Analytics で監視する。
- Logpush の `last_delivery` ステータスを Terraform output または Cloudflare ダッシュボードで確認する。
- Loki 側の取り込みエラーは、Grafana Cloud の **Logs Usage** ダッシュボードや、Loki テナントへの 429 レスポンスの監視によって間接的に確認する。

## 6. セキュリティ

### 6.1 認証情報の管理

| シークレット | 管理場所 | 注入方法 |
|---|---|---|
| **Cloudflare API Token** | Terraform 実行環境 / CI シークレット | `CLOUDFLARE_API_TOKEN` 環境変数 |
| **Grafana Cloud Access Policy Token** | Cloudflare Workers Secret | Terraform `cloudflare_workers_secret` で登録 |
| **AI Gateway 名・ID** | Terraform variables（非機密） | `terraform.tfvars` または環境変数 |

### 6.2 Workers シークレット

- Grafana Cloud Loki の URL と Access Policy Token は Workers Secret として保存する。
- コードに平文で書き込まず、Workers 実行時に `env.GRAFANA_CLOUD_LOKI_URL` などで参照する。
- Terraform で secret リソースを定義する際は、plan や output での表示を抑制するため `sensitive = true` を指定する。ただし、`sensitive = true` は CLI 出力の表示抑制であり、tfstate ファイル内に平文で値が残るのを防ぐものではない。tfstate ファイルはローカルではなく、暗号化されたリモートバックエンド（Terraform Cloud、S3 with SSE 等）で管理する。さらに、可能であれば Cloudflare 側の secrets manager や環境変数を経由して Workers Secret に注入し、Terraform 実行環境がトークンを直接保持しない運用を推奨する。

### 6.3 通信セキュリティ

- Logpush → Workers、Workers → Loki ともに HTTPS のみとする。
- インバウンドポート開放は不要（Workers は Cloudflare のエッジで受信）。
- Loki への push は HTTP Basic Auth を使用する。username には Grafana Cloud Portal の Loki 詳細画面に表示される User 値（Loki のテナント ID）、password には `logs:write` スコープを持つ Grafana Cloud Access Policy Token または API key を設定する。

### 6.4 アクセス制御

- Cloudflare API Token は最小権限で発行する。以下は参考権限であり、実際の AI Gateway Logpush に必要な正確な権限は実装前に Cloudflare ドキュメントで確認する。
  - 参考権限：`Zone:Logpush:Edit`、`Zone:Logs:Read`、`Cloudflare Gateway:Edit`（AI Gateway 設定用）
- Grafana Cloud Access Policy は「logs:write」スコープのみを許可する。
- Workers ルートは Logpush からのみ呼ばれるが、公開 URL になっているため、第三者からの POST を防ぐため Workers 入口で認証を必須とする。
  - Logpush 側でカスタム HTTP ヘッダー（例：`X-Origin-Secret`）を付与し、Workers 側でこの値が `env.ORIGIN_SECRET` と一致するか検証する。
  - ヘッダー不一致の場合は 401/403 を返し、Logpush の再試行を避けるため 4xx とする。

### 6.5 ログに含まれる機密情報

- Workers 変換時に以下を原則除外する。
  - ユーザー IP、認証ヘッダー、プロンプト全文、レスポンス本文
- 必要な場合は特定ヘッダーのみマスキングして保持する。
- これによりログ転送量の削減と、機密情報の保護を両立する。

## 7. コストとクォータ管理

### 7.1 ログ転送量の削減策

| 削減策 | 効果 | 実装箇所 |
|---|---|---|
| **Logpush フィールド制限** | 不要なフィールドを送信前に除外 | `cloudflare_logpush_job` の `output_options` |
| **Workers による前処理** | ヘッダー・ペイロード全文を落とし、必要最小限の JSON に整形 | Workers スクリプト |
| **ステータスコードフィルタ** | 成功系（200 系）だけを送信、または特定エラーのみ重点的に送信 | Logpush filter または Workers |
| **環境分離** | prod のみを監視対象にし、stg は必要に応じて別管理 | Terraform variables |

### 7.2 見積もり例

- AI Gateway 1 リクエストあたりのログサイズ
  - 生ログ：約 3〜8 KB
  - Workers 変換後：約 0.5〜1.5 KB（80% 削減見込み）
- 仮に 1 日 10 万リクエストの場合
  - 変換後：約 50〜150 MB/日
  - 14 日間で：約 0.7〜2.1 GB
  - 月間（30 日換算）：約 1.5〜4.5 GB
- Grafana Cloud Free Tier の 50 GB/月 制限内に十分収まる想定。

### 7.3 カーディナリティ管理

- Loki ラベルは `model`、`status_code`、`env`、`gateway` の 4 つのみに制限する。
- これにより Prometheus/Loki のアクティブシリーズ数を低く抑える。
- 将来ラベルを追加する場合は、カーディナリティへの影響を必ず評価する。

### 7.4 将来の移行パス

- Exporter/Logpush の宛先 URL を変更するだけで、自前の Loki へ切り替え可能。
- Terraform 変数化しておくことで、移行時の変更点を最小限にする。

## 8. テストと検証

### 8.1 段階的な検証フロー

| フェーズ | 検証内容 | 成功基準 |
|---|---|---|
| **1. Terraform 計画** | `terraform plan` でリソース変更が想定通りであることを確認 | 差分に Logpush job、Workers script、secret のみが含まれる |
| **2. Workers 変換ロジックのユニットテスト** | サンプル NDJSON を入力し、Loki 形式の JSON が出力されることを確認 | ラベル・タイムスタンプ・ログ本文が正しく変換される |
| **3. Workers ローカル動作確認** | `wrangler dev` でローカルサーバーを起動し、サンプル Logpush ペイロードを POST | 200 が返り、Loki エンドポイント（モックまたは実際）に正しい形式で到達 |
| **4. デプロイ後の疎通確認** | AI Gateway に対してテストリクエストを数回送信 | 数秒〜数分後に Grafana Cloud Loki でログが検索できる |
| **5. ダッシュボード確認** | Loki クエリで `sum by (status_code) (count_over_time(...))` などが動作 | ダッシュボードパネルにデータが表示される |

### 8.2 テストデータ

- `tests/fixtures/sample_aigateway_log.json` にテスト用 NDJSON サンプルを配置する。
- ステータスコード 200/400/500 のケースを含む。
- 複数モデル、複数環境（prod/stg）のパターンをカバーする。

### 8.3 CI チェック

- `terraform fmt`、`terraform validate`
- Workers スクリプトの型チェック（TypeScript の場合）または lint
- ユニットテストの実行

### 8.4 運用後の監視

- Workers Analytics でエラーレートと CPU 時間を確認する。
- Grafana Cloud Logs 使用量で転送量を追跡する。
- 1 週間運用後にログ転送量を見積もりと比較し、クォータに余裕があるか確認する。

## 9. 未決定事項と次のステップ

- Cloudflare AI Gateway の具体的な ID / 名前（Terraform variables として注入）
- Cloudflare AI Gateway Logpush の dataset 名と、必要な最小権限の詳細確認
- Terraform ステートのリモートバックエンド選定
- Grafana Cloud Loki Access Policy Token の発行（実装前に実施）
- Workers 実装言語の選定（TypeScript 推奨）
