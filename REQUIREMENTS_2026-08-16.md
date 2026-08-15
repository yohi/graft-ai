# Cloudflare AI Gateway Free Plan Observability 対応 — 要件ブリーフ

## 1. 対象リポジトリ

* Repository: `yohi/graft-ai`
* 対象: Cloudflare AI Gateway observability / Grafana integration
* 既存の Cloudflare AI Gateway Logpush mode および Free Tier proxy mode との互換性を考慮する。

## 2. 背景・課題

現在 `graft-ai` では、Cloudflare AI Gateway の observability について主に以下の経路が存在する。

```text
Cloudflare AI Gateway
  → Cloudflare Logpush
  → graft-ai Worker
  → Loki
  → Grafana
```

Logpush から取得した AI Gateway access log を Loki に保存し、Grafana の LogQL で token usage、latency、cache status、HTTP status 等を集計している。

一方、Cloudflare Logpush は Cloudflare Workers Paid Plan を必要とするため、Free Plan ではこの observability 経路を利用できない。

既存の Free Tier proxy mode では、

```text
Client
  → graft-ai proxy Worker
  → Cloudflare AI Gateway
```

という経路で AI Gateway を利用できるが、現状は Logpush mode と同等の Grafana observability を提供できない。

そのため、Cloudflare Free Plan のユーザーが AI Gateway の利用状況や個別リクエストを Grafana で十分に観測できないことが今回解決したい問題である。

## 3. 目的

Cloudflare Workers / AI Gateway の Free Plan の範囲で、Cloudflare AI Gateway の observability data を Grafana から確認可能にする。

Cloudflare AI Gateway が提供する OpenTelemetry integration を主要な observability source とし、Logpush を必須としない。

また、Grafana Cloud に限定せず、OTLP-compatible な self-hosted observability backend を使用したローカル Grafana 環境でも利用・検証可能にする。

## 4. 現状挙動

### Logpush mode

既存実装では Cloudflare AI Gateway の access log を Logpush 経由で Worker が受信する。

主な既存関連コード:

* `workers/src/index.ts`
* `workers/src/transform.ts`
* `workers/src/types.ts`
* `grafana/dashboards/graft-ai-overview.json`

`AIGatewayLog` では、少なくとも以下の情報を扱っている。

* `RequestID`
* `RequestTime`
* `CacheStatus`
* `StatusCode`
* `Model`
* `PromptTokens`
* `CompletionTokens`
* `TotalTokens`
* `RequestDuration`
* `Path`
* `Method`
* `RequestBody`（optional）
* `ResponseBody`（optional）
* `Metadata`（optional）

Loki では token usage や latency 等を JSON log field として保存し、Grafana 側で `unwrap`、`sum_over_time`、`avg_over_time`、`quantile_over_time`、`count_over_time` 等により集計している。

### Free Tier proxy mode

Free Tier では proxy Worker を経由して Cloudflare AI Gateway にリクエストできる。

既存 `workers/src/proxy.ts` では、リクエストから telemetry event を生成しているが、現在の Free Plan 経路では Logpush と同等の Grafana observability は成立していない。

また、proxy Worker を observability のための必須経路とすることは今回の要件ではない。

## 5. 期待する挙動

Cloudflare AI Gateway の OpenTelemetry integration を有効にした環境では、Cloudflare Logpush を利用しなくても AI Gateway の observability data を Grafana 側から確認できること。

AI Gateway へのアクセスが `graft-ai` proxy Worker 経由か直接アクセスかによって、基本的な observability の可否が決まらないこと。

Free Plan + OTel 経路でも、既存 Logpush mode で提供している主要な観測情報に可能な範囲で近い情報を確認できること。

個別の AI request について prompt / completion payload を追跡・閲覧できること。

## 6. 機能要件

### 6.1 OpenTelemetry integration

Cloudflare AI Gateway の OpenTelemetry integration を Free Plan observability の主要な入力元として利用可能であること。

Logpush を利用できない環境でも observability が成立すること。

Cloudflare AI Gateway が OTel integration で提供する情報を利用し、少なくとも以下を Grafana から確認可能にすること。

* request / trace
* model
* provider
* input tokens
* output tokens
* cost
* latency
* prompt
* completion

Cloudflare OTel integration が追加で提供する既存 dashboard 相当情報については、可能な範囲で利用可能にすること。

### 6.2 Payload observability

AI request の prompt と completion を Grafana 上で追跡・閲覧可能であること。

payload を単に常時 dashboard 上へ全文表示することは必須ではない。

対象 request / trace を特定した上で、その prompt / completion を確認できれば要件を満たす。

### 6.3 Payload protection

prompt / completion は観測対象とする一方、credential 類が無条件に observability backend に永続保存・表示されないこと。

最低限、以下のような情報を保護対象とする。

* API keys
* Authorization credentials
* その他、明示的な secret / credential

一般的な PII や業務機密を自動判定する包括的な DLP 機能は今回の必須要件には含めない。

具体的な secret 検出・masking・redaction の方式は設計フェーズで判断する。

### 6.4 Grafana dashboard

Free Plan + OTel で取得した主要な AI Gateway observability 情報を Grafana dashboard から確認可能であること。

Grafana Explore 等で telemetry が存在することを確認できるだけではなく、主要な利用状況について dashboard から確認可能であること。

既存 Logpush dashboard と画面・panel・query・data source を完全に同一にすることは要求しない。

UI の完全互換ではなく、観測できる情報の互換性を重視する。

### 6.5 Grafana Cloud 非依存

Grafana Cloud 固有の機能に observability 要件を依存させないこと。

OTLP-compatible な self-hosted observability backend と Grafana を組み合わせた環境でも利用可能であること。

具体的な backend、collector、storage 製品や配置方法は要件として固定しない。

### 6.6 ローカル/self-hosted 環境での再現性

開発者がリポジトリに記載された手順に従うことで、self-hosted / ローカル Grafana 環境において Cloudflare AI Gateway observability を再現可能に検証できること。

Cloudflare AI Gateway に実際の request を送信した後、ローカル Grafana 環境で最低限以下を確認できること。

* request / trace の存在
* model / provider
* input / output tokens
* cost
* latency
* prompt
* completion

具体的なローカル observability stack の構成は設計フェーズで判断する。

## 7. 後方互換性

### 既存 Logpush mode

既存の Paid Plan 向け Logpush mode は削除しない。

既存の、

```text
Cloudflare AI Gateway
  → Logpush
  → graft-ai Worker
  → Loki
  → Grafana
```

の経路について、今回の Free Plan 対応を理由に既存利用者の動作を破壊しないこと。

OTel 対応を理由とした Logpush mode の廃止・全面置換は今回のスコープ外とする。

### Free Tier proxy mode

既存 Free Tier proxy mode も維持する。

ただし、Grafana observability を成立させるための必須経路とはしない。

以下の双方について、Cloudflare AI Gateway OTel integration の対象となる request は observability 対象となることを期待する。

```text
Client → graft-ai proxy → Cloudflare AI Gateway
```

```text
Client → Cloudflare AI Gateway
```

## 8. Free Plan 制約

Cloudflare 側については、追加の Paid 機能なしで今回の observability が成立することを必須とする。

特に Cloudflare Logpush を Free Plan observability の必須条件にしてはならない。

Cloudflare Workers / AI Gateway の Free Plan で利用可能な機能の範囲で成立させる。

Grafana 側については Free Tier 内での動作までは保証対象としない。

Grafana Cloud または self-hosted observability backend の運用・保存容量等に伴う費用は今回の Cloudflare Free Plan 要件とは分離する。

## 9. 既存 Logpush との情報互換性

Free Plan + OTel と既存 Logpush mode で、データ構造や取得方式が完全に一致することは要求しない。

Cloudflare AI Gateway の OTel integration が提供する範囲で、既存 Logpush dashboard が提供している observability に最大限近づける。

OTel integration から取得できない Logpush 固有情報について、Free Plan で完全な互換性を実現することは必須ではない。

特に以下のような既存 Logpush field については、Cloudflare OTel integration で取得可能な範囲を利用する。

* `cache_status`
* `status_code`
* その他 Logpush 固有 field

取得不能な field のためだけに Cloudflare Paid 機能を要求してはならない。

## 10. 非機能要件

### Portability

Grafana Cloud から self-hosted Grafana 環境へ移行可能な observability 要件とする。

特定の Grafana Cloud 固有 ingestion mechanism に強く結合しない。

### Security

prompt / completion を含むため、credential の意図しない保存・表示を防止できること。

### Reproducibility

self-hosted 環境について、開発者がリポジトリのドキュメントから再現可能に検証できること。

### Backward compatibility

既存 Logpush mode および Free Tier proxy mode を破壊しないこと。

## 11. 対象外

今回の要件には以下を含めない。

* 既存 Logpush mode の廃止
* Free Tier proxy mode の廃止
* proxy Worker を observability の必須経路にすること
* Logpush と OTel の完全な field-level parity
* 既存 Grafana dashboard の UI / panel 構成の完全互換
* Grafana Cloud Free Tier 内への利用量保証
* 包括的な PII/DLP 検出
* observability backend 製品の固定
* collector 製品の固定
* telemetry storage architecture の決定
* 無関係な既存コードのリファクタリング
* 将来用途を想定した汎用 observability framework の構築

## 12. 受け入れ条件

以下を満たした場合、本改修の要件を満たしたものとする。

1. Cloudflare Logpush を使用せず、Cloudflare Free Plan で AI Gateway observability が成立する。
2. Cloudflare AI Gateway の実 request に対応する telemetry を Grafana から確認できる。
3. 少なくとも以下を確認できる。

   * request / trace
   * model
   * provider
   * input tokens
   * output tokens
   * cost
   * latency
   * prompt
   * completion
4. 主要な利用状況を Grafana dashboard から確認できる。
5. 個別 request を追跡し、その prompt / completion を Grafana 上で確認できる。
6. API key、Authorization credential 等の明示的 secret が無条件に保存・表示されない。
7. 既存 Logpush mode が引き続き利用可能である。
8. 既存 Free Tier proxy mode が引き続き利用可能である。
9. `graft-ai` proxy を経由しない AI Gateway request も、Cloudflare OTel integration の対象であれば観測可能である。
10. Grafana Cloud 固有機能を必須としない。
11. self-hosted / ローカル Grafana 環境で実際に動作確認できる。
12. 開発者がリポジトリの手順に従って self-hosted 環境で検証を再現できる。
13. Cloudflare 側で Logpush その他の追加 Paid 機能を必須としない。

## 13. 既決事項

* Cloudflare AI Gateway OTel integration を Free Plan observability の主要な入力元とする。
* Logpush を Free Plan の必須条件にしない。
* prompt / completion payload を観測対象とする。
* credential 類の保護を必須とする。
* 包括的 PII/DLP は今回の必須要件にしない。
* 既存 Logpush mode を維持する。
* 既存 Free Tier proxy mode を維持する。
* proxy Worker を observability の必須経路にしない。
* 既存 dashboard との UI 完全互換は要求しない。
* 観測可能な情報の互換性を重視する。
* Grafana Cloud に限定しない。
* self-hosted / ローカル Grafana での動作確認を必須とする。
* ローカル環境の再現手順を必須とする。
* Cloudflare 側は追加 Paid 機能なしで成立させる。
* Grafana 側が Free Tier 内に収まることまでは保証しない。

## 14. 設計フェーズへ委ねる事項

以下は本要件ブリーフでは決定せず、`superpowers` の `brainstorming` および後続設計フェーズで判断する。

* OTel telemetry の具体的な受信経路
* self-hosted observability stack の具体的構成
* tracing backend の選択
* metrics の生成・保存方式
* Loki / Tempo / Prometheus 等の具体的な役割分担
* OpenTelemetry Collector / Grafana Alloy 等の採否
* dashboard の具体的な panel 構成
* OTel trace と既存 Logpush/Loki データの統合方法
* secret detection / redaction の具体的実装方式
* payload の保存期間
* telemetry retention policy
* sampling 方針
* エラー処理方式
* テスト実装方式

これらを本要件から実装方式として先に固定しないこと。

## 15. `brainstorming` で特に検討してほしい論点

本要件を満たすため、後続の `brainstorming` では特に以下の制約を踏まえて設計を検討すること。

* Cloudflare Free Plan で成立すること。
* Logpush を必要としないこと。
* Cloudflare AI Gateway OTel integration を活用すること。
* Grafana Cloud と self-hosted Grafana の双方を考慮すること。
* prompt / completion を観測できること。
* credential を保護すること。
* 既存 Logpush mode を破壊しないこと。
* 既存 Free Tier proxy mode を破壊しないこと。
* YAGNI を優先し、今回の observability 対応と無関係な再設計・リファクタリングを行わないこと。

