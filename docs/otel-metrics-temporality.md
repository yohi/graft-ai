# OTLP Metrics Temporality and Aggregation Window Notes

## 背景

レビュー指摘で `deploy/otel/alloy/internal/wire/metrics.go` に対し、以下が挙げられました：

- イベント単位の Sum / Histogram の temporality を `CUMULATIVE` から `DELTA` に変更する。
- 各 `EncodeMetrics` 呼び出しの報告区間内で series ごとに集計してからデータポイントを出力する。
- `Normalize` が span ごとに生成する Value / Count を累積状態として扱わず、span の開始・終了時刻を共有区間として使用しないようにする。
- 各報告区間の共通 timestamp を設定する。

## 現在の実装の確認結果

現時点のコードでは以下がすでに実装されています：

- `EncodeMetrics` は `aggregateSamples` で name + labels ごとにサンプルを集計しています。
- Sum / Histogram ともに `AGGREGATION_TEMPORALITY_DELTA` を使用しています。
- `CUMULATIVE` 指定は存在しません。

したがって、「DELTA に変更して集計せよ」という指摘内容は、レビュー対象バージョン（PR の過去コミット）では未適用だった可能性がありますが、**現在の HEAD ではすでに解決済み**です。

## 対応済みの軽微な改善

`EncodeMetrics` 出力する DELTA Sum / Histogram データポイントに `StartTimeUnixNano` を追加しました。これにより、OTLP の DELTA semantics における「報告区間」の始点・終点が揃います。

- `aggregateSamples` はサンプル群の最小 `TimestampUnixNano` を `startTime`、最大を `endTime` として返します。
- `metricProto` は両方を `StartTimeUnixNano` / `TimeUnixNano` に設定します。

## 残っている本質的な課題

`CanonicalMetrics.Normalize` は request span ごとに raw sample（`ai_gateway_requests_total: 1`、`ai_gateway_errors_total: 1`、`ai_gateway_request_duration_seconds` の histogram 用 duration）を生成します。`EncodeMetrics` はこれらを集計して 1 データポイントにまとめますが、以下は未解決です：

- 厳密な「報告区間」の管理（例：1 分間の集計窓、または 1 回の Alloy 呼び出し区間）。
- 現在の `startTime` はサンプルの最小時刻を使っているため、span の時刻をそのまま流用しているに等しく、真の DELTA 集計区間を表しているとは限りません。
- `Normalize` 側で span ごとに raw sample を作る設計は維持されるべきですが、集計側が時間窓を主導する設計を強化する必要があります。

## 今後の対応方針

上記の本質的な課題は、本 PR で対応するには範囲が大きいため、**follow-up issue として扱う**のが適切です。issue 案としては次のような内容です：

1. Alloy / `EncodeMetrics` 側で「報告区間」を明示的に定義する（例：直近 1 分間、または 1 回の push サイクル）。
2. 区間の `StartTimeUnixNano` / `TimeUnixNano` を、サンプルの時刻に依存せずに決定する。
3. `Normalize` は span ごとの raw sample 生成を継続し、集計は `EncodeMetrics` / Alloy 側で完結させる設計を維持する。
4. `_total` 系は monotonic counter（Sum）、duration は histogram として維持する。gauge 化は不適切。

これらは OTLP / Prometheus Remote Write の正しい semantics への改善であり、現状の「span → raw sample → 集計 → DELTA datapoint」というパイプラインを壊さない最小限の後続対応となります。
