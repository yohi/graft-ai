<!-- markdownlint-disable MD013 -->

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
- self-hosted の baseline retention は、Tempo の trace metadata を14日、Loki の
  redaction 済み prompt/completion payload を7日、Prometheus の spanmetrics を14日
  とする。これは Compose の明示的な設定値であり、Grafana Cloud の retention を
  変更する前提にはしない。
- Grafana Cloud の retention は tenant、契約プラン、stack 設定から決まる実効値を
  使用する。設計では7日または30日を既定値として仮定せず、デプロイ時に Logs、
  Traces、Metrics の実効 retention を記録して受入確認する。
- sampling は既定100%とし、運用設定で低くできるようにする。sampling decision は
  lowercase 32桁 hex の trace_id と固定 seed `graft-ai-otel-v1` を UTF-8 連結し、
  SHA-256 の先頭8 bytesをbig-endian unsigned integerとして `hash / 2^64 < rate` で
  決める。rate の精度は `0.000001`、sampling priority override は受け付けず、同じ
  trace_id/rate/seed は常に同じ decision とする。Tempo trace と Loki payload に同じ
  decision を適用し、spanmetrics は sampling 前の request spans から生成する。
  RED metrics は全量、Tempo と Loki は sampled trace のみとする。
- sampling fixture は rate=`0.5`、seed=`graft-ai-otel-v1` とし、入力文字列を
  `trace_id + seed` とする。trace ID `00000000000000000000000000000001` は SHA-256
  prefix `f75a2b34049e94d6` なので sampled out、`ffffffffffffffffffffffffffffffff` は
  prefix `1d4e75600b429028` なので sampled in、`11111111111111111111111111111111` は
  prefix `db81a30e59fe0b64` なので sampled out とする。これを acceptance fixture に固定する。
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
                             ↓ HTTPS / OTLP-HTTP /v1/traces
                    Cloudflare Tunnel
                             ↓ bearer token
                       Grafana Alloy
              ┌──────────────┼──────────────┐
              ↓              ↓              ↓
       Tempo metadata   spanlogs → Loki  spanmetrics → Prometheus
       self-hosted 14日  self-hosted 7日   self-hosted 14日
              └──────────────┬──────────────┘
                             ↓
                     Grafana OTel dashboard
```

### 3.0 OTLP/HTTP connection contract

Cloudflare AI Gateway exporter から Alloy までの公開 endpoint は環境ごとに次の
形式に固定する。`<tunnel-host>`、`<otlp-gateway-host>`、tenant ID は配置時に
注入する値であり、秘密値ではないが dashboard JSON に埋め込まない。

| 経路 | 完全な URL 形式 | path の扱い |
| --- | --- | --- |
| self-hosted ingress | `https://<tunnel-host>/v1/traces` | cloudflared は `/v1/traces` を Alloy の `http://alloy:4318/v1/traces` へそのまま転送する |
| Grafana Cloud ingress | `https://<tunnel-host>/v1/traces` | Grafana Cloud でも Cloudflare exporter は同じ公開 Alloy/Tunnel endpoint を使用する |
| self-hosted Tempo exporter | `http://tempo:4318/v1/traces` | Alloy から内部 network の Tempo へ送る。外部公開しない |
| Grafana Cloud Tempo exporter | `https://<otlp-gateway-host>/otlp/v1/traces` | region/tenant 固有の host を secret-free な設定値として注入する |
| self-hosted Prometheus exporter | `http://prometheus:9090/api/v1/otlp/v1/metrics` | Prometheus の OTLP receiver を有効化し、内部 network だけで到達可能にする |
| Grafana Cloud Prometheus exporter | `https://<otlp-gateway-host>/otlp/v1/metrics` | tenant/region 固有の host と認証を注入する |
| self-hosted/Grafana Cloud Loki exporter | `http://loki:3100/loki/api/v1/push` / `https://<loki-host>/loki/api/v1/push` | spanlogs を Loki JSON stream に変換して送る。`trace_id` は log field であり label ではない |

Cloudflare exporter と Alloy receiver の ingress contract は OTLP/HTTP とし、
`application/x-protobuf`（protobuf）と `application/json`（OTLP JSON）の双方を
明示的に受け付ける。Cloudflare exporter が実際に送る形式は環境設定で一つに固定し、
Content-Type と一致しない payload は `415` とする。receiver の contract test は
両形式を検証し、実アカウントの acceptance test は採用した形式を検証する。baseline の
`Content-Encoding` は `identity` とし、gzip などの圧縮は `415` で拒否する。圧縮を許可する
場合は展開後の上限を8 MiB、圧縮率を20倍以下に固定し、圧縮爆弾を受け入れない。

Cloudflare exporter から Tunnel までの認証は、常に
`Authorization: Bearer ${OTEL_INGEST_TOKEN}` とする。token は secret file、環境変数、
または Cloudflare Secrets Store から注入し、query string、dashboard、ログには出さない。
Alloy から Tempo への Content-Type は `application/x-protobuf` とする。self-hosted Tempo
は内部 network で認証なし、Grafana Cloud Tempo は
`Authorization: Basic base64(<tempo-tenant-id>:<tempo-access-token>)` を使う。Alloy から
Prometheus も baseline は `application/x-protobuf`、Grafana Cloud は
`Authorization: Basic base64(<prometheus-user>:<metrics-access-token>)` とする。Loki は
self-hosted では内部 network、Grafana Cloud では `logs:write` scope の credentials を
secret として注入し、Loki push JSON は `application/json` とする。その他の credentials
方式を暗黙に選ばない。
どの経路でも Tunnel は `/v1/traces` を rewrite せず、`/` や未知の path は `404` とする。

Cloudflare AI Gateway が gateway で span を生成するため、request が proxy Worker
経由か直接アクセスかは OTel 経路の成立条件にしない。

### 3.1 Alloy pipeline and fan-out ownership

Alloy が唯一の fan-out owner であり、processor の破壊的な attribute 除去を
exporter 間で共有しない。処理順序と branch ownership は次のとおりとする。

1. OTLP/HTTP receiver が Tunnel から trace spans を受け、bearer token、path、
   Content-Type、有限の request limit/timeout を検証する。trace_id がない span、
   不正な OTLP、認証不一致は後段へ渡さない。
2. 最初の processor が対象 span attributes と payload を deterministic redaction
   する。redaction 前のオブジェクトを後段の exporter、debug log、queue に渡さない。
3. redaction 済みの入力から branch-local copy を作成する。redaction failure、line-size
   preflight、numeric invalid の payload status fields はこの時点で確定する。copy は同じ trace_id、
   request_id、model、provider、token、cost、latency、redaction 済み payload を
   初期状態として持ち、以後の branch が他 branch の attribute mutation を見ない。
4. Alloy の stateful request-span selector が trace_id ごとに最大 `10,000` trace、
   最大 `64 MiB` を保持し、last span 受信から `1s` の idle timeout で trace state を
   flush する。`is_request_span` predicate（`span.kind=server` かつ root span、または
   `request_id` を持つ最初の server span）で候補を選び、同じ trace に複数候補がある場合は
   start time、次に span_id 昇順で一つに決める。timeout 前に state limit に達した場合は
   最も古い trace state を同じ eviction tuple で破棄し、`trace_state_evicted` を記録する。
   選択した span に `graft_ai.request_span=true` を付け、他の span には false を付ける。
   選択後の request spans だけを spanmetrics branch に送り、sampling より前に request
   count、error、duration を集計する。child spans は RED metrics に二重計上しない。
5. 別の sampler が trace_id を hash して一つの deterministic sampling decision を
   作る。sampled branch の Tempo trace と spanlogs payload は同じ decision を使い、
   payload だけを追加で sampling しない。sampling で除外された trace は Tempo と Loki
   のどちらにも存在せず、Recent Traces に行を作らない。dashboard は sampling rate と
   sampled-only payload aggregate の注記を表示する。
6. Tempo branch では branch-local copy から、trace_id、span_id、request_id、
   `graft_ai.request_span`、model、provider、status、status_code、input_tokens、
   output_tokens、total_tokens、cost_usd、duration_ms、payload_truncated、
   payload_dropped、payload_drop_reason だけを metadata allowlist として残す。
   `gen_ai.prompt_json`、
   `gen_ai.completion_json`、`cf-aig-metadata` と、allowlist 外の全 resource/span
   attributes は除去してから exporter に渡す。Loki branch は同じ redaction 済み payload
   を保持する。
7. Loki branch の span を `otelcol.connector.spanlogs` で log record に変換し、
   Loki exporter へ送る。spanmetrics branch は payload を保持せず、選択済み request span
   を二重計上しない。

sampling=100% かつ backend drop がない場合、選択済み request span の trace ID 集合が
Tempo と Loki で一致する。sampling<100% では Tempo/Loki は同一 trace 単位で一致し、
spanmetrics は選択済み request spans 全量を数える。sampled out の trace は両 backend
に存在しないため、行単位の欠損表示ではなく dashboard の sampling 注記で扱う。
この前後関係を固定し、sampling processor を spanmetrics より前へ移動する変更は
禁止する。hash seed、sampling precision、sampling priority override の扱いも固定し、
acceptance test で同じ trace ID が同じ decision になることを確認する。

### 3.2 Spanlogs output contract

`otelcol.connector.spanlogs` は `spans=true` とし、request span だけを OTLP Logs の
`LogRecord` に変換する。標準 connector が作る文字列 body は後段の transform processor
で JSON object body へ変換してから `otelcol.exporter.loki` に渡す。一つの record を
一つの JSON log line に変換し、span attributes から持ち出せる allowlist は次のとおり
で、それ以外の属性は body にコピーしない。

| 分類 | allowlist |
| --- | --- |
| 相関 | `trace_id`, `span_id`, `request_id` |
| 対象 | `model`, `provider`, `status`, `status_code`, `gateway`, `env` |
| 数値 | `input_tokens`, `output_tokens`, `total_tokens`, `cost_usd`, `duration_ms` |
| payload | redaction 済みの `prompt`, `completion` |
| payload status | `payload_truncated`, `payload_dropped`, `payload_drop_reason` |

body は JSON object とし、RFC 8259 の JSON escaping を使う。改行は `\\n`、引用符は
`\\"` として保存し、prompt/completion 内の whitespace は値として保持する。token と
cost は引用符を付けない有限の decimal JSON number とし、NaN、Infinity、数値変換不能値は
field を欠損扱いにして `numeric_field_invalid` drop reason を記録する。field 名はそれぞれ
`input_tokens`、`output_tokens`、`total_tokens`、`cost_usd`、`duration_ms` に固定する。
Loki の parser は `| json` とし、集計は例えば次で行う。

```logql
sum(
  sum_over_time(
    {env=~"$env", gateway=~"$gateway"} | json | unwrap input_tokens | __error__="" [$__range]
  )
)
```

```logql
sum(
  sum_over_time(
    {env=~"$env", gateway=~"$gateway"} | json | unwrap cost_usd | __error__="" [$__range]
  )
)
```

```logql
sum(
  sum_over_time(
    {env=~"$env", gateway=~"$gateway"} | json | unwrap output_tokens | __error__="" [$__range]
  )
)
```

Loki labels は既存制約どおり `model`、`status_code`、`env`、`gateway` の4つだけとし、
`trace_id`、`request_id`、`provider`、prompt、completion、credential-like value は
label にしない。

serialized UTF-8 log line の上限は self-hosted baseline で `262144` bytes（256 KiB）と
する。redaction を先に行い、サイズ判定は JSON escaping 後に行う。上限を超える場合は
split せず、まず payload fields を除いた metadata/control JSON の serialized bytes を
計測し、残りの budget を prompt と completion に存在する field 数に応じて両方なら50:50、
片方だけなら100:0で割り当てる。各 field は UTF-8 code point 境界で切り詰め、suffix
`[TRUNCATED]` を budget 内に収め、numeric/identity fields と `payload_truncated=true` を
保持する。metadata だけでも上限を超える場合は payload fields を全て
削除し、`payload_dropped=true` と `payload_drop_reason="line_size"` を記録する。
この処理は credential redaction の後に行い、無効な JSON、部分的な secret、分割された
payload を Loki に保存しない。payload fields を削除した後にも serialized line が上限を
超える場合は record 全体を破棄し、`otel_spanlogs_dropped_total{reason="line_size_metadata"}`
だけを増加させる。drop log には trace_id、request_id、URL、payload、credential を含めない。
Grafana Cloud の実際の line limit が異なる場合は tenant 制約を採用し、Compose の
baseline をその値に合わせて変更する。

### 3.3 Backend responsibilities and ingestion contract

各 backend への送信は Alloy が所有し、endpoint、Content-Type、認証、retention を
環境設定から明示的に注入する。Grafana Cloud の URL は region/tenant により異なる
ため、以下の `<...>` を実値へ置換してから smoke test を実行する。

| Backend | Alloy output/exporter | self-hosted endpoint | Grafana Cloud endpoint | 認証 |
| --- | --- | --- | --- | --- |
| Tempo | `otelcol.exporter.otlphttp` | `http://tempo:4318/v1/traces` | `https://<otlp-gateway-host>/otlp/v1/traces` | self-hosted は内部 network、Cloud は tenant credentials |
| Loki | `otelcol.exporter.loki` | `http://loki:3100/loki/api/v1/push` | `https://<loki-host>/loki/api/v1/push` | self-hosted は内部 network、Cloud は logs write credentials |
| Prometheus | `otelcol.exporter.otlphttp` | `http://prometheus:9090/api/v1/otlp/v1/metrics` | `https://<otlp-gateway-host>/otlp/v1/metrics` | self-hosted は内部 network、Cloud は Basic Auth (`username:metrics token`) |

Tempo exporter の payload projection は `gen_ai.prompt_json`、
`gen_ai.completion_json`、`cf-aig-metadata` を含めない。Loki exporter は spanlogs
contract の JSON body と、labels `model`、`status_code`、`env`、`gateway` だけを送る。
Prometheus exporter は OTLP metrics を `application/x-protobuf` で送ることを baseline
とし、Grafana Cloud が JSON のみを受ける環境では `application/json` とし、その選択を
configuration と contract test に記録する。

Prometheus に公開する canonical metric names と labels は次のとおりとする。Alloy の
spanmetrics connector が生成する vendor/default name は dashboard へ出す前にこの名前へ
normalize する。spanmetrics 前の transform が `request=true` と
`error=(span.status=ERROR または status_code >= 400)` を正規化し、request predicate
で選択された span だけを connector に渡す。`ai_gateway_requests_total` と duration は
connector の calls/duration から、`ai_gateway_errors_total` は `error=true` の filtered
calls から recording rule または明示的な metric transform で生成する。connector の
default metric name をそのまま dashboard contract とみなさない。

| Metric | 種別 | 意味 | 許可する labels |
| --- | --- | --- | --- |
| `ai_gateway_requests_total` | counter | 選択済み request span の request 数 | `model`, `provider`, `status_code`, `env`, `gateway` |
| `ai_gateway_errors_total` | counter | span status error または HTTP status 400 以上の request 数 | `model`, `provider`, `status_code`, `env`, `gateway` |
| `ai_gateway_request_duration_seconds` | histogram | request latency の秒数 | `model`, `provider`, `status_code`, `env`, `gateway` |

`trace_id`、`request_id`、prompt、completion、credential、raw URL は index label や
metric label にしない。`ai_gateway_errors_total` と latency は sampling 前の選択済み
request spans から生成し、payload の sampling によって値を減らさない。duration histogram
の bucket は秒単位で `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, +Inf]`
に固定する。PromQL の dashboard query は次の canonical names だけを使用する。

```promql
sum by (model, provider) (rate(ai_gateway_requests_total[$__rate_interval]))
```

```promql
sum by (model, provider) (rate(ai_gateway_errors_total[$__rate_interval]))
```

```promql
histogram_quantile(
  0.95,
  sum by (le, model, provider) (
    rate(ai_gateway_request_duration_seconds_bucket[$__rate_interval])
  )
)
```

Total Requests、Error Rate、p50/p95 Latency は次の query contract を使う。

```promql
sum(increase(ai_gateway_requests_total[$__range]))
```

```promql
100 * sum(increase(ai_gateway_errors_total[$__range]))
  / clamp_min(sum(increase(ai_gateway_requests_total[$__range])), 1)
```

```promql
histogram_quantile(
  0.50,
  sum by (le) (rate(ai_gateway_request_duration_seconds_bucket[$__rate_interval]))
)
```

token/cost の Loki aggregate panel は sampling<100% では sampled payload の値であることを
panel title と注記に表示する。query は選択範囲全体の range aggregation と JSON parse
error filter を含め、input と output の両方を提供する。

```logql
sum(
  sum_over_time(
    {env=~"$env", gateway=~"$gateway"} | json | unwrap input_tokens | __error__="" [$__range]
  )
)
```

```logql
sum(
  sum_over_time(
    {env=~"$env", gateway=~"$gateway"} | json | unwrap cost_usd | __error__="" [$__range]
  )
)
```

```logql
sum(
  sum_over_time(
    {env=~"$env", gateway=~"$gateway"} | json | unwrap output_tokens | __error__="" [$__range]
  )
)
```

retention は self-hosted では Tempo `14d`、Loki `7d`、Prometheus `14d` を
Compose の persistent storage 設定に固定する。Grafana Cloud では Alloy が retention
を設定しないため、tenant の実効 retention（Logs、Traces、Metrics）を Cloud UI/API
から取得して検証記録に残す。Cloud 側を7日に変更したり、全 tenant の既定値を30日と
仮定したりしない。既存 payload protection policy の上限に合わせ、Grafana Cloud Logs の
payload retention が `14d` を超える tenant は acceptance を失敗させ、payload export を
有効化しない。Traces/Metrics は tenant の実効値を記録する。

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
失敗した payload は原文を保存せず、その payload attribute を削除し、
`payload_dropped=true`、`payload_drop_reason="redaction_failure"` を生成する。trace ID、
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

Recent Traces のデータ契約は次の表に固定する。`normalized.*` は Alloy が span
attributes から作る field 名であり、raw attribute の優先順位も表に含める。Recent
Traces の行は Tempo の request span metadata を唯一の source とし、Prometheus は
aggregate panel、Loki は payload data link にだけ使う。Prometheus に trace_id を付けて
Tempo 行へ join することは禁止する。

| 列 | producer / source signal | attribute または log field | datasource / Grafana query | 欠損時の表示 |
| --- | --- | --- | --- | --- |
| timestamp | Cloudflare span / trace signal | `start_time_unix_nano` → `timestamp` | Tempo TraceQL の span start time | `—` |
| trace ID | Cloudflare span / trace signal | OTLP `trace_id` → `trace_id` | Tempo: `trace:id = "<trace_id>"` | `—`（欠損 span は ingest reject） |
| request ID | Cloudflare span / trace signal | `request_id` または `cf-aig-request-id` → `request_id` | Tempo TraceQL request span | `—` |
| model | Cloudflare span / trace signal | `gen_ai.request.model` → `model` | Tempo TraceQL request span | `unknown` |
| provider | Cloudflare span / trace signal | `gen_ai.provider.name` → `gen_ai.system` → `provider` | Tempo TraceQL request span | `unknown` |
| input tokens | Cloudflare span / trace signal | `gen_ai.usage.input_tokens` → `input_tokens` | Tempo TraceQL request span metadata | `—` |
| output tokens | Cloudflare span / trace signal | `gen_ai.usage.output_tokens` → `output_tokens` | Tempo TraceQL request span metadata | `—` |
| cost | Cloudflare span / trace signal | `gen_ai.usage.cost` → `cost_usd` | Tempo TraceQL request span metadata | `—` |
| latency | Cloudflare span / trace signal | span end - start → `duration_ms` | Tempo TraceQL request span duration | `—` |
| status | span status / HTTP response | `http.response.status_code` → `status_code`; span ERROR → error | Tempo TraceQL request span | `unknown` |
| payload availability | Alloy status projection | `payload_truncated`, `payload_dropped`, `payload_drop_reason` | Tempo TraceQL request span metadata | `available` |

`trace_id` は Cloudflare AI Gateway が生成・伝播した OTLP trace context を Alloy が
保持する。Alloy は新しい trace ID を生成したり置換したりしない。`request_id` は
Cloudflare が提供した値を Alloy が正規化するだけで、値がなければ生成しない。したがって
request ID が欠損しても trace ID による相関は維持し、request ID 列は `—` とする。

### Trace to payload workflow

1. Recent Traces の行から Tempo の trace detail を開く。
2. Tempo datasource の `tracesToLogsV2` が trace ID、datasource UID、time shift を含む
   Grafana-generated Explore URL を生成し、Loki Explore を開く。
3. Loki で同じ trace ID の redaction 済み prompt/completion を確認する。

```text
https://<grafana-host>/explore?orgId=<org-id>&left=<urlencoded-json>

urlencoded-json = {
  "datasourceUid": "<LOKI_UID>",
  "filterByTraceID": true,
  "spanStartTimeShift": "-5m",
  "spanEndTimeShift": "5m"
}
```

`<grafana-host>`、`<org-id>`、`<LOKI_UID>` は dashboard provisioning で注入し、URL
に token や credential を含めない。Grafana の built-in filter が Tempo trace と Loki
query に同じ `trace_id` を渡し、Loki record の prompt/completion が redaction 済み
であることを dashboard validation で確認する。line-size drop、redaction failure の場合は
Tempo metadata の `payload_drop_reason` を使って `payload unavailable (<reason>)` と表示し、
空の payload と区別する。backend queue drop など Tempo に reason がない場合は
`payload unavailable (not retained or backend drop)` と表示する。
sampled out は行自体が存在しないため、行単位の unavailable 表示にはしない。

Tempo datasource provisioning は Grafana の `tracesToLogsV2` を使い、
`datasourceUid=<LOKI_UID>`、`filterByTraceID=true`、
`spanStartTimeShift=-5m`、`spanEndTimeShift=5m` を設定する。これにより上記 URL template
は trace 時刻周辺の LogQL query として生成され、手書き URL の time range 仕様に依存しない。

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
- bounded export dispatcher（Alloy deployment が queue owner として起動）

Compose は Alloy、Tempo、Loki、Prometheus、cloudflared、dispatcher の image を immutable
digest で pin し、`latest` や floating tag を使わない。digest は実装開始時に固定し、
receiver の `http` block と exporter の queue/retry fields をその version で contract test
する。

Alloy の OTLP/HTTP receiver のみを Cloudflare Tunnel から到達可能にする。Tunnel
には TLS と bearer token を要求する。receiver の `http` block は §7.1 の有限な
request limit/timeout を使用する。各 backend は永続 volume を持ち、self-hosted
baseline として payload 7日、trace metadata と metrics 14日の retention を個別に
設定する。Prometheus は OTLP receiver を有効化し、Compose smoke test が
`http://prometheus:9090/api/v1/query` で canonical metrics を読める状態にする。

ドキュメントの検証手順は次の順序にする。

1. ローカル secret file と環境変数を設定する。
2. Compose stack を起動する。
3. cloudflared の公開 URL と受信 token を Cloudflare AI Gateway OTel exporter
   に登録する。
4. 実際の AI Gateway request を送信する。
5. Tempo で trace が存在することを確認する。
6. Prometheus の `/api/v1/query` で `ai_gateway_requests_total`、
   `ai_gateway_errors_total`、`ai_gateway_request_duration_seconds` を query し、
   model/provider labels と request/error/latency の値を確認する。
7. 同じ trace ID を使って Loki の `/loki/api/v1/query_range` で input/output tokens、
   cost、prompt/completion を確認する。
8. Recent Traces の data link が同じ trace ID の redaction 済み payload を返すことを
   確認する。
9. proxy 経由と AI Gateway 直接アクセスの両方を検証する。

Grafana Cloud では同じ Alloy pipeline と dashboard query を使い、datasource
provisioning、backend endpoint、authentication、tenant の実効 retention だけを
差し替える。Grafana Cloud の Logs retention を7日に固定したり、全 tenant の既定値を
30日とみなしたりせず、Cloud UI/API で確認した実値を受入記録に残す。

## 7. Error handling

### 7.1 Receiver limits and rate limiting

`otelcol.receiver.otlp` の `http` block は、Alloy の pinned version が提供する同名の
有限値を設定する。baseline は `max_request_body_size=8388608` bytes（8 MiB）、
`read_header_timeout=5s`、`read_timeout=30s`、`write_timeout=10s` とする。pinned version
でこれらを receiver に設定できない場合は reference stack の preflight を失敗させ、
未記載の reverse proxy へ暗黙に置き換えない。Cloudflare WAF/Tunnel の rate limit は
receiver timeout の代替ではない。

Alloy receiver の同時 request 上限は `100`、dispatcher ingress queue は `1,000 items`
とする。Cloudflare WAF/Tunnel が検証して上書きした source metadata の source IP を
source identity とし、client が指定した `X-Forwarded-For`、`CF-Connecting-IP`、その他の
header を直接信用しない。IPv4 は dotted decimal、IPv6 は小文字 RFC 5952 表記へ正規化し、
zone ID を除去する。各 source
ごとに token bucket の `120 requests/minute`、burst `20`、refill `2 tokens/sec` の rate
limit を適用する。source IP を取得できない場合は `unknown` の共有 bucket に送る。source identity は
metric label にせず、秘密鍵 `OTEL_RATE_LIMIT_HMAC_KEY` と canonical source IP から
`HMAC-SHA-256(key, "otel-ingress-source-v1\\0" + canonical_ip)` を計算した full hex の
`source_id_hash` として rate-limit log の structured field にのみ記録する。鍵は secret file、
環境変数、または Secrets Store から注入し、ログ・dashboard・Compose・設定ファイルには
保存しない。rate limit は
Cloudflare AI Gateway request を制限するものではなく、telemetry ingress の送信量だけを
制限する。

dispatcher ingress queue の1 item は、redaction と JSON serialization が完了した1つの
認証済み OTLP HTTP request envelope（受信時刻、monotonic ingress sequence、trace batch、
byte size を含む）とする。queue capacity はこの envelope 数で数え、満杯時は新しい item を
常に破棄する（既存 item は退避しない）。破棄判定は enqueue の atomic operation として行い、
`otel_ingress_queue_dropped_total{reason="capacity"}` を破棄直後に1回だけ増加させる。
破棄された valid OTLP request も Cloudflare-facing response は `200` とし、
`otel_ingress_requests_total{status="accepted"}` を増加させる。queue から取り出した1 item は
同じ ingress sequence を保持したまま Tempo、Loki、Prometheus の独立した backend queue
entry へ fan-out し、backend queue の容量は ingress item を3倍に数えない。したがって
capacity+1 の fixture は、最初の1,000 itemをFIFOで保持し、1,001 itemだけを
`capacity` reason で破棄し、ingress queue の最大値を1,000に固定する。

| 条件 | 応答 | 必須 metric/log |
| --- | --- | --- |
| bearer token 不一致・欠落 | `401` | `otel_ingress_rejections_total{reason="auth"}` と token 非表示の auth log |
| `/v1/traces` 以外の path | `404` | `otel_ingress_rejections_total{reason="path"}` |
| 不正な OTLP payload | `400` | `otel_ingress_rejections_total{reason="parse"}` |
| 未対応または Content-Type 不一致 | `415` | `otel_ingress_rejections_total{reason="content_type"}` |
| `Content-Encoding` が `identity` 以外 | `415` | `otel_ingress_rejections_total{reason="compression"}` |
| request body が8 MiB超 | `413` | `otel_ingress_rejections_total{reason="body_size"}` と受信 bytes log |
| header/body timeout | `408` | `otel_ingress_rejections_total{reason="timeout"}` |
| source rate limit 超過 | `429` と `Retry-After` | `otel_ingress_rate_limited_total` と source-scoped rate-limit log |
| 認証済みで受理した OTLP | `200`（受理後は非同期送信） | `otel_ingress_requests_total{status="accepted"}` |

共通で `otel_ingress_active_requests`、`otel_ingress_request_bytes`、
`otel_ingress_queue_items{queue="dispatcher",unit="items"}`、
`otel_ingress_queue_capacity{queue="dispatcher",unit="items"}` を記録する。source IP、token、prompt、completion は metric
label にしない。backend queue が満杯でも、認証済みで構文が正しい request は `200` を
返して Cloudflare AI Gateway request を待たせず、drop metric を増やす。backend status
を Cloudflare exporter へ返して再送を誘発しない。

oversized body、slow header、slow body の test は、request を同時に10件以上流した後、
timeout/response 完了から1分間、`otel_ingress_active_requests` が設定上限を超えず、
queue item 数が capacity 以下で、各1分窓の最大値が単調増加しないことを確認する。
allocator/GC に依存する process RSS の baseline 復帰は acceptance 条件にしない。

### 7.2 Redaction

- credential 検出・置換に失敗した payload の原文は保存しない。
- payload attribute のみを削除し、保存可能な trace metadata と metrics は継続する。

### 7.3 Backend failure, retry, and queue contract

retryable は network failure、`408`、`429`、`5xx` とし、その他の `4xx` は再試行しない。
attempt は初回を含む total attempt 数で、backoff は exponential に `±20%` の randomization
を加え、`delay = min(base * 2^retry_index * uniform(0.8, 1.2), 5s)` とする。全 backend
の queue は bounded in-memory queue とし、無制限 memory、無期限 disk queue、Cloudflare
request への同期依存は採用しない。process restart 時に未送信 queue が失われることは
許容するが、クラッシュ後に失われた個数を遡及して記録できるとは仮定しない。graceful
shutdown の場合だけ pending item 数を allowlist log に記録する。

queue の owner は Alloy deployment の bounded export dispatcher とする。stock exporter
の `sending_queue` は、単一 item sizer、FIFO、retry elapsed time など、その component
が提供する範囲でのみ使用する。以下の per-backend eviction、byte/item の二重上限、
request span の priority を満たせない場合は、同じ contract を実装する pinned dispatcher
を reference stack に追加し、unbounded queue や同期送信へ退避しない。redaction・JSON
serialization 後の handoff は `accepted` または `dropped(reason)` を返し、dispatcher が
backend retry、queue、drop metric の唯一の owner になる。handoff が `dropped` でも ingress
は認証済み valid OTLP に `200` を返し、stock exporter の retryable overflow response を
Cloudflare exporter へ返さない。

| Backend | total attempts | per-attempt timeout / backoff | queue type・容量 | overflow / eviction |
| --- | --- | --- | --- | --- |
| Tempo | 3（retry 2回） | `10s` / `1s`, `2s` | memory、最大 `64 MiB` または `2,000 spans` | 先に到達した上限で満杯。trace 単位で最も古い complete trace を破棄。complete trace がない場合は最古の item を `received_at`、`trace_id` 昇順で破棄 |
| Loki | 3（retry 2回） | `10s` / `500ms`, `1s` | memory、最大 `64 MiB` または `500 records` | 先に到達した上限で満杯。payload priority `1` の lowest-priority record を破棄。同 priority は `received_at`、`trace_id` 昇順 |
| Prometheus | 3（retry 2回） | `10s` / `500ms`, `1s` | memory、最大 `16 MiB` または `100 batches` | 先に到達した上限で満杯。最も古い batch を `received_at`、batch sequence 昇順で破棄 |

eviction は queue ごとに独立し、byte size は redaction・serialization 後の UTF-8 bytes、
item size は span、record、batch の個数で測る。request-span selector の complete trace は
idle timeout `1s` を経過して flush された trace state と定義し、Prometheus batch は最大
`200 data points` または `1s` flush の先着で形成する。priority は metrics `3`、trace metadata
`2`、payload `1` とする。同じ priority と timestamp の場合は `trace_id`、それでも同じ
場合は monotonic sequence の昇順で対象を決める。したがって oldest と lowest-priority
の選択が実装ごとに揺れず、retry exhaustion と overflow の結果を再現できる。

次の logical metric names を全 backend に適用し、実装では Alloy の component metric
と recording rule または metric transform からこの contract へ map する。backend failure
log は `backend`、`status_class`、`attempt`、`reason`、`queue_items`、`queue_capacity`
だけを許可し、headers、request/response body、完全 URL、token、prompt、completion、
credential を記録しない。

- `otel_backend_export_retries_total{backend}`
- `otel_backend_export_failures_total{backend,status_class}`
- `otel_backend_export_exhausted_total{backend}`
- `otel_backend_queue_dropped_total{backend,signal,reason}`
- `otel_backend_queue_utilization_ratio{backend}`
- `otel_backend_queue_oldest_age_seconds{backend}`

`reason` は `queue_capacity`、`retry_exhausted`、`line_size_metadata`、
`numeric_field_invalid`、`shutdown_loss`、`trace_state_evicted` の固定 enum とする。
retry metric は retry 着手直前、failure metric は各 failed attempt の直後、exhausted
metric は最後の failed attempt の直後、drop metric は item を queue から破棄した直後に
一度だけ増加させる。queue utilization と oldest age は1秒間隔で観測する。

alert threshold は backend ごとに次を共通適用する。

- `OtelBackendExportExhausted`: `increase(otel_backend_export_exhausted_total[5m]) >= 1`
  が5分継続したら critical。
- `OtelBackendDrops`: `increase(otel_backend_queue_dropped_total[5m]) >= 1` が5分継続
  したら critical。
- `OtelBackendQueueSaturation`: queue utilization `> 0.80` が5分継続したら warning。
- `OtelIngressRateLimited`: rate-limited request が5分間に1件以上あれば warning。

Tempo、Loki、Prometheus のいずれかが停止しても、受理済み telemetry の送信処理は
backend ごとに独立する。retry、queue、drop、alerting は AI Gateway request の latency、
status、成功可否に影響させない。

## 8. Testing and acceptance

### Automated tests

- redaction unit tests: Bearer、Basic、API key、nested JSON、credential-like prompt
  （newline、quote、whitespace を含む）
- OTLP receiver tests: JSON/protobuf の Content-Type、`/v1/traces` path preservation、
  unknown path/404、auth 成功/401、parse error/400、unsupported type/415、非identity
  compression/415、8 MiB超/413
- receiver resource tests: slow header/body の408、rate limit の429/Retry-After、
  同時100 request上限、dispatcher 1,000 item capacity、timeout 後の active request、
  連続する2つの1分窓で queue item 最大値が増加しないこと、capacity+1 の valid OTLP
  envelope で最初の1,000件だけが保持され、1,001件目が `200` と `capacity` drop metric
  になること
- rate-limit identity tests: 同一 canonical IP の HMAC が安定し、IPv4/IPv6 表記差を
  正規化し、鍵変更で hash が変わり、raw IP と client-supplied spoof header が保存・bucket
  key に使われず、source IP 未取得時だけ `unknown` bucket になること
- sampling matrix tests: sampling=100% と sampling<100% の trace/payload 同一 decision、
  固定 hash seed、SHA-256 prefix fixture の expected decision、request span predicate、
  spanmetrics 全量、sampled out の trace が両 backend に存在しないこと、dashboard に
  sampling 注記が出ること
- fan-out test: 一つの input trace に root/request span と child span を含め、Tempo には
  payload なし、Loki には同じ redaction 済み payload、各 canonical metric には request
  span が一度だけ寄与すること
- spanlogs tests: `| json | unwrap` が token/cost を抽出し、newline、quote、whitespace、
  credential-like value、JSON escaping を保持すること
- spanlogs size tests: 256 KiB超で valid JSON の field-level truncate、metadata-only overflow
  の record drop、`payload_truncated`/`payload_dropped`、credential 非保存、numeric fields
  保持、prompt/completion の50:50 byte budget、UTF-8境界、最終 serialized bytes が上限
  以下であることを確認
- retry exhaustion tests: backend ごとの status/network failure で total 3 attempts、
  指定 backoff、`±20%` randomization の範囲、exhausted metric、Cloudflare-facing `200` を確認
- queue overflow tests: backend ごとの capacity+1 を投入し、byte/item の先着上限、complete
  trace がない場合の fallback、指定された eviction 順、drop metric 名、drop reason、queue
  上限を確認する。crash 後の drop 数を遡及して数えない。
- alert tests: threshold 未満では発火せず、各 threshold を超えた場合だけ指定 alert が
  発火することを backend ごとに確認
- spanmetrics tests: canonical metric names、request span predicate、multi-span trace の
  非重複、model/provider/status labels、request、error、latency の値を PromQL で確認すること
- payload/metadata の self-hosted retention configuration と Grafana Cloud の実効
  retention verification tests。Cloud Logs payload が14日超なら export を有効化しない。
- Compose smoke test: synthetic OTLP spans を実際に Alloy へ送信し、Prometheus の
  `/api/v1/query`、Loki の `/loki/api/v1/query_range`、Tempo の trace detail で同じ
  request の model/provider、RED、numeric payload、redaction 結果を確認すること
- dashboard JSON、PromQL、LogQL、Tempo `tracesToLogsV2` provisioning、trace 時刻の
  ±5分 shift、payload status 欠損表示の validation
- 既存 Worker の `make test`、`make typecheck`
- Terraform を変更した場合の `make validate`

### Acceptance gate

1. Cloudflare Free Plan の実アカウントで OTel exporter が利用可能であることを確認する。
2. `/v1/traces` を維持した Tunnel 経由で実 request に対応する span を受信し、選択した
   Content-Type と Bearer token 認証の成功/失敗を確認する。未知 path は404、invalid
   payload は400、unsupported Content-Type は415であることを確認する。
3. Tempo で payload を含まない request/trace を確認する。
4. Prometheus で canonical metric names、model/provider、request、error、latency を
   query し、request span predicate 適用後の spanmetrics が全量であることを確認する。
5. Loki で同じ trace ID の input/output tokens、cost、redaction 済み prompt/completion
   を確認し、LogQL `unwrap` が数値を抽出できることを確認する。
6. Recent Traces の `tracesToLogsV2` data link（trace 時刻の±5分 shift）から、同じ
   request の redaction 済み payload を取得する。
7. sampling=100% と sampling<100% で Tempo trace と Loki payload の decision が一致し、
   sampled out の trace が両 backend に存在せず、dashboard に sampling 注記が表示される
   ことを確認する。
8. backend retry exhaustion、queue overflow、drop metric、alert threshold を各 backend
   で確認する。
9. backend を停止しても receiver が valid telemetry に `200` を返し、同一 payload を
   backend healthy/unhealthy 各30回送信して、telemetry ingress の p95 latency 差が10%
   以内、status が全て200であることを確認する。AI Gateway request の成功可否も変えない。
10. oversized payload、slow header/body、rate limit で指定 status、metric/log、queue capacity
    内の安定性、1分窓の最大値が継続増加しないことを確認する。
11. proxy 経由と AI Gateway 直接アクセスの両方で同じ observability 経路を確認する。
12. 明示 credential が保存・表示されないことを redaction test と実データ確認で検証する。
13. self-hosted の Tempo 14日、Loki 7日、Prometheus 14日の設定と、Grafana Cloud の
    Logs/Traces/Metrics の実効 retention を環境ごとに確認する。
14. `make test`、`make typecheck` を実行し、既存 Logpush/proxy の fixture と
    `grafana/dashboards/graft-ai-overview.json` の既存 panel/query が変わらないことを確認する。
15. `docker compose -f deploy/otel/docker-compose.yml up -d`、health check、synthetic
    OTLP smoke test、`docker compose -f deploy/otel/docker-compose.yml down` を実行し、
    immutable image digest を使う self-hosted Compose stack を空の環境から再実行できる
    ことを確認する。

## 9. Scope boundaries

対象外とするものは、既存 Logpush mode の廃止、proxy を observability 必須経路に
すること、Logpush と OTel の完全な field parity、既存 dashboard の UI 互換、
包括的 PII/DLP、reference stack 以外の backend/collector への展開、無関係な Worker
や Terraform のリファクタリングである。本文の Alloy、Tempo、Loki、Prometheus、
bounded export dispatcher、Compose は、この設計と acceptance test が対象とする
reference stack として固定する。
