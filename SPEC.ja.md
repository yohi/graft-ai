<!-- markdownlint-disable MD013 -->

# graft-ai 仕様

English version: [SPEC.md](./SPEC.md)

## 1. 目的

Cloudflare AI Gateway、OpenAI、Ollama Cloud からのテレメトリを統一された Grafana
Cloud dashboard に集約します。同時に、Grafana Cloud Free
Tier の制限（14日間保持、10k active series、50GB logs）内に収めます。

## 2. サブシステム

### Subsystem 1 — Cloudflare AI Gateway → Grafana Cloud Loki

#### 2.1 目標

Cloudflare Logpush から暗号化された AI Gateway access
logs をほぼリアルタイムで受信し、Loki JSON streams に変換して Grafana Cloud
Loki に push します。

#### 2.2 アーキテクチャ

```text
[Client/App]
    ↓
[Cloudflare AI Gateway] ── logs ──→ [Cloudflare Logpush]
                                       ↓ encrypted, gzip-compressed NDJSON
[Cloudflare Workers (receive/decrypt/decompress)]
                                       ↓ NDJSON
[Cloudflare Workers (transform)]
                                       ↓ JSON streams
[Grafana Cloud Loki]
                                       ↓
[Grafana Cloud Dashboard]
```

#### 2.3 構成要素

| Component        | Managed By                             | Responsibility                                               |
| ---------------- | -------------------------------------- | ------------------------------------------------------------ |
| AI Gateway       | 既存サービス                           | AI requests を proxy し、access logs を生成します。          |
| Logpush Job      | Terraform (`cloudflare_logpush_job`)   | Gateway logs を取得し、Worker に NDJSON を POST します。     |
| Transform Worker | Wrangler (`workers/src/index.ts`)      | 入口検証、解凍、復号、変換、Loki への push を実行します。    |
| Credentials      | Wrangler secrets + `TF_VAR_*` env vars | Grafana token、origin secret、RSA private key を保持します。 |
| Loki             | Grafana Cloud managed                  | 変換後 logs を14日間保存します。                             |

#### 2.4 データ変換ルール

1. **Timestamp and Encryption**
   - Incoming payload は gzip-compressed NDJSON です。各 encrypted
     field は hybrid encryption を使用します。AES-GCM
     key は RSA-OAEP-SHA256 で wrap され、payload は AES-GCM で暗号化されます。Worker は PKCS#8
     RSA private
     key（`env.RSA_PRIVATE_KEY_PEM`）を import し、unwrap と decrypt を行います。
   - `RequestTime` は10桁以下なら秒、11〜13桁ならミリ秒です。
   - Loki 用に nanoseconds へ変換します。
   - 14桁以上の値は precision-lost として扱い、該当 log line を skip します。
2. **Labels**
   - 厳密に `model`、`status_code`、`env`、`gateway` の4つです。
   - `model` は `@cf/<scope>/` prefix を取り除いて正規化します。
3. **Log Line Fields**
   - 常に含める field は
     `request_id`、`cache_status`、`prompt_tokens`、`completion_tokens`、`total_tokens`、`duration_ms`、`path`、`method`
     です。
   - `env.INCLUDE_REQUEST_BODY`、`env.INCLUDE_RESPONSE_BODY`、`env.INCLUDE_METADATA`
     で明示的に有効化された場合のみ、復号済みの
     `request_body`、`response_body`、`metadata`
     を含めます。これらは prompts、response bodies、その他 sensitive
     data を含む可能性があるため opt-in です。
   - Headers、user IPs、auth tokens、raw prompts/response
     bodies はデフォルトで除外します。

#### 2.5 信頼性とエラー処理

| Failure Point                   | Behavior                                                                    |
| ------------------------------- | --------------------------------------------------------------------------- |
| Missing/wrong `X-Origin-Secret` | `401` を返します。Logpush retry は発生しません。                            |
| Malformed gzip body             | `400` を返します。Logpush retry は発生しません。                            |
| Invalid RSA private key         | `400` を返します。Logpush retry は発生しません。                            |
| Unparseable NDJSON line         | 該当行を skip し、他の行の処理を継続します。                                |
| Loki 429                        | Exponential backoff で最大3回 retry します。最終失敗時は `503` を返します。 |
| Loki 5xx or network failure     | `503` を返します。Logpush が batch を retry します。                        |
| Loki 4xx (non-429)              | `400` を返します。Logpush retry は発生しません。                            |

#### 2.6 セキュリティ

- Logpush → Worker と Worker → Loki は HTTPS のみです。
- Loki push は HTTP Basic Auth を使用します。username は Grafana Cloud Loki
  tenant ID、password は `logs:write` scope を持つ Access Policy Token です。
- Secrets は commit せず、`*.tfvars` にも保存しません。環境変数または Wrangler
  secrets を使用します。
- Terraform state は encrypted remote backend を使用するべきです。

#### 2.7 テストと検証

- Crypto、transform、Loki modules の unit
  tests（`@cloudflare/vitest-pool-workers`）。
- Worker fetch handler 全体の integration test。
- CI checks: `terraform fmt`、`terraform validate`、TypeScript type
  check、Vitest run。
- Test fixtures は `tests/fixtures/sample_aigateway_log.json`
  にあり、200/400/500 status codes、cache hit/miss、2つの model
  names をカバーします。

## 3. 全体制約

- Workers implementation language: TypeScript。
- Terraform provider: `cloudflare/cloudflare` v5.x。
- Worker deployment は Wrangler で行い、Terraform は Logpush
  job のみを管理します。
- Grafana Cloud Free Tier limits が適用されます。

## 4. 運用メモ

- Terraform 適用前に Cloudflare API で Logpush dataset name と field
  names を確認します。
- RSA public key を AI Gateway Logpush settings に upload します。private
  key は Worker が使用します。
- 本番利用前に encrypted remote Terraform backend を設定します。
- **Monitoring checklist:** Workers Analytics の exceptions と subrequest
  errors、Terraform output または Cloudflare dashboard の Logpush
  `last_delivery` status、Grafana Cloud **Logs Usage** dashboard、実際の log
  volume と設計見積もり（変換後 request あたり約 0.5〜1.5 KB）の週次比較。
- **Quota estimate:** 変換後 logs は 1 request あたり約 0.5〜1.5
  KB、raw は約 3〜8 KB です。100k requests/day の場合、月間約 1.5〜4.5
  GB となり、Grafana Cloud Free Tier の 50 GB/month logs
  allowance 内に収まります。
