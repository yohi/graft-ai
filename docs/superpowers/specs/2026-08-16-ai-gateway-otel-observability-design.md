# Cloudflare AI Gateway OTel Observability Design

## 1. Purpose

Cloudflare AI Gateway の OpenTelemetry integration を、既存の Logpush mode
および Free Tier proxy mode と独立した observability 入力経路として追加する。
Cloudflare Logpush を Free Plan observability の条件にせず、Cloudflare AI
Gateway の trace spans を Grafana Cloud または self-hosted Grafana から検索・
集計できるようにする。

実装前に、Cloudflare Free Plan の実アカウントで OTel exporter の利用可否と、
実 request に対応する span が到着することを検証する。Free Plan で利用できない
場合は、Paid 機能や proxy 経由へ暗黙に切り替えず、要件を再評価する。

## 2. Decisions

- Cloudflare AI Gateway OTel integration を主要な入力元とする。
- 既存 Logpush Worker、proxy Worker、Tail Worker、および Logpush dashboard
  は変更せず維持する。
- OTel dashboard は既存 dashboard と分離して新設する。
- OTel span は Alloy で受信し、redaction 後に signal 別へ分岐する。
- Tempo は payload を除く trace metadata を14日保持する。
- Loki は redaction 済み prompt/completion payload を7日保持する。
- Prometheus は spanmetrics で導出した RED metrics を14日保持する。
- sampling は既定100%とし、運用設定で低くできるようにする。
- ローカルの実 request 検証には Cloudflare Tunnel を使う。
- payload 保護は明示 credential の redaction に限定し、包括的な PII/DLP は
  提供しない。

## 3. Architecture

```text
Client
  ├─ graft-ai proxy Worker ──┐
  └─ AI Gateway 直接         │
                             ↓
                    Cloudflare AI Gateway
                             │ OTel trace spans
                             ↓ HTTPS / OTLP-HTTP
                    Cloudflare Tunnel
                             ↓ bearer token
                       Grafana Alloy
              ┌──────────────┼──────────────┐
              ↓              ↓              ↓
       Tempo metadata   spanlogs → Loki  spanmetrics → Prometheus
          14日             payload 7日          RED metrics 14日
              └──────────────┬──────────────┘
                             ↓
                     Grafana OTel dashboard
```

Cloudflare AI Gateway の exporter endpoint、OTLP format、認証ヘッダーは設定値
として扱う。self-hosted 環境では Tunnel URL を指定し、Grafana Cloud 環境では
Alloy または互換 OTLP endpoint を指定する。backend 固有の tenant URL や認証
方式を dashboard query に埋め込まない。

Cloudflare AI Gateway が gateway で span を生成するため、request が proxy Worker
経由か直接アクセスかは OTel 経路の成立条件にしない。

### 3.1 Alloy pipeline

1. OTLP/HTTP receiver が Tunnel から trace spans を受け、bearer token を検証する。
2. 最初の processor がすべての対象 span attributes を redaction する。
3. redaction 済み span を、payload attributes を除く Tempo exporter 用の trace、
   spanlogs 用の payload、spanmetrics 用の RED metrics に分岐する。
4. redaction 済み payload を含む span を `otelcol.connector.spanlogs` で log
   record に変換し、Loki exporter へ送る。
5. spanmetrics connector は request count、error、duration、および model/provider
   などの低カーディナリティ dimensions で RED metrics を生成する。token/cost は
   spanlogs が Loki に保持する numeric fields を LogQL の `unwrap` で集計する。

### 3.2 Backend responsibilities

| Backend | 保存対象 | 検索 | 保持 |
| --- | --- | --- | --- |
| Tempo | payload を除いた trace metadata | TraceQL | 14日 |
| Loki | payload、trace ID、token、cost | LogQL | 7日 |
| Prometheus | request、error、latency の RED metrics | PromQL | 14日 |

request ID、trace ID、prompt/completion は backend の index label や metric label
にしない。model、provider、status など、必要な低カーディナリティ属性だけを
集計 dimensions とする。

## 4. Payload protection

Alloy は redaction 前の span を exporter、debug log、内部の payload dump に出さ
ない。対象は次のとおりとする。

- `gen_ai.prompt_json`
- `gen_ai.completion_json`
- `cf-aig-metadata`
- resource/span の文字列属性

JSON 構造を維持し、次の credential を `[REDACTED]` に置換する。

- `Authorization: Bearer ...`
- Basic credential
- API key 形式の値
- `secret`、`token`、`password`、`credential` 等の明示的なキーの値
- 文字列中の既知の credential パターン

通常の prompt 内容は対象にしない。JSON parse または deterministic redaction に
失敗した payload は原文を保存せず、その payload attribute を削除する。trace ID、
model/provider、token、cost、latency などの安全な metadata は可能な範囲で維持する。

Cloudflare の `cf-aig-collect-log-payload` が OTel attributes に適用されることは
公式資料で確定していないため、redaction の代替条件にしない。

OTLP receiver の bearer token、Cloudflare exporter の認証ヘッダー、Grafana
datasource credentials は secret file、environment、または Cloudflare Secrets
Store から注入する。リポジトリの Compose、Alloy、dashboard、Terraform 定義へ
秘密値を埋め込まない。

## 5. Grafana dashboard

OTel 専用 dashboard を新設し、Tempo、Loki、Prometheus の datasource UID を
provisioning で差し替えられるようにする。既存 `graft-ai-overview.json` は変更
しない。

### Overview panels

- Total Requests
- Error Rate
- p50/p95 Latency
- Input Tokens / Output Tokens
- Estimated Cost
- Request rate、latency、tokens、cost の時系列
- model/provider 別 breakdown
- Recent Traces table

Recent Traces には timestamp、trace ID、request ID、model、provider、input/output
tokens、cost、latency、status を表示する。payload 全文は overview に常時表示しない。

### Trace to payload workflow

1. Recent Traces の行から Tempo の trace detail を開く。
2. trace ID を data link の変数として Loki query に渡す。
3. Loki で同じ trace ID の redaction 済み prompt/completion を確認する。

この導線により、個別 request の payload を確認しつつ、通常の利用状況画面へ
payload を大量表示しない。

## 6. Local and self-hosted reproducibility

Docker Compose で次のコンポーネントを起動する。

- Grafana
- Grafana Alloy
- Tempo
- Loki
- Prometheus
- cloudflared

Alloy の OTLP/HTTP receiver のみを Cloudflare Tunnel から到達可能にする。Tunnel
には TLS と bearer token を要求する。各 backend は永続 volume を持ち、payload 7日、
trace metadata と metrics 14日の retention を個別に設定する。

ドキュメントの検証手順は次の順序にする。

1. ローカル secret file と環境変数を設定する。
2. Compose stack を起動する。
3. cloudflared の公開 URL と受信 token を Cloudflare AI Gateway OTel exporter
   に登録する。
4. 実際の AI Gateway request を送信する。
5. Tempo で trace が存在することを確認する。
6. Prometheus で model/provider、request、error、latency を確認する。
7. 同じ trace ID を使って Loki で input/output tokens、cost、prompt/completion を確認する。
8. proxy 経由と AI Gateway 直接アクセスの両方を検証する。

Grafana Cloud では同じ Alloy pipeline と dashboard query を使い、datasource
provisioning と endpoint/authentication だけを差し替える。

## 7. Error handling

### Ingress

- bearer token 不一致は401で破棄する。
- 壊れた OTLP payload は4xxとして破棄する。
- auth error、parse error、drop count を Alloy の内部 metrics/logs に記録する。
- Cloudflare exporter の再送や保持は公式保証に依存せず、欠損可能性を運用文書に
  明記する。

### Redaction

- credential 検出・置換に失敗した payload の原文は保存しない。
- payload attribute のみを削除し、保存可能な trace metadata と metrics は継続する。

### Backend failure

- Tempo、Loki、Prometheus exporter は bounded retry と exponential backoff を使う。
- queue が上限に達した場合は oldest または lowest-priority data を破棄し、drop
  metric を増加させる。
- 無制限メモリ queue、無期限 disk queue、Cloudflare request への同期依存は採用しない。
- backend 障害で AI Gateway request 自体を失敗させない。

## 8. Testing and acceptance

### Automated tests

- redaction unit tests: Bearer、Basic、API key、nested JSON、credential-like prompt
- OTLP receiver auth/parse tests
- spanlogs の trace-to-payload correlation tests
- spanmetrics の model/provider aggregation tests
- payload/metadata の retention configuration tests
- Compose smoke test
- dashboard JSON と query validation
- 既存 Worker の `make test`、`make typecheck`
- Terraform を変更した場合の `make validate`

### Acceptance gate

1. Cloudflare Free Plan の実アカウントで OTel exporter が利用可能であることを確認する。
2. Tunnel 経由で実 request に対応する span を受信する。
3. Tempo で request/trace を確認する。
4. Prometheus で model/provider、request、error、latency を確認する。
5. Loki で同じ trace ID の input/output tokens、cost、redaction 済み prompt/completion を確認する。
6. proxy 経由と AI Gateway 直接アクセスの両方で同じ observability 経路を確認する。
7. 明示 credential が保存・表示されないことを redaction test と実データ確認で検証する。
8. 既存 Logpush mode、Free Tier proxy mode、既存 dashboard の回帰がないことを確認する。
9. Grafana Cloud 固有機能なしで、self-hosted Compose stack の手順を再実行できることを確認する。

## 9. Scope boundaries

対象外とするものは、既存 Logpush mode の廃止、proxy を observability 必須経路に
すること、Logpush と OTel の完全な field parity、既存 dashboard の UI 互換、
包括的 PII/DLP、backend/collector 製品の固定、無関係な Worker や Terraform の
リファクタリングである。
