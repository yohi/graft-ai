# OTLP Metrics Temporality and Aggregation Window Notes

## 背景

レビュー指摘で `deploy/otel/alloy/internal/wire/metrics.go` に対し、以下が挙げられました：

- イベント単位の Sum / Histogram の temporality を `CUMULATIVE` から `DELTA` に変更する。
- 各 `EncodeMetrics` 呼び出しの報告区間内で series ごとに集計してからデータポイントを出力する。
- `Normalize` が span ごとに生成する Value / Count を累積状態として扱わず、span の開始・終了時刻を共有区間として使用しないようにする。
- 各報告区間の共通 timestamp を設定する。

## 対応内容

### 1. DELTA + 集計済みの維持

`EncodeMetrics` は `aggregateSamples` で name + labels ごとにサンプルを集計し、Sum / Histogram ともに `AGGREGATION_TEMPORALITY_DELTA` を使用しています。`CUMULATIVE` 指定は存在しません。

### 2. 二重加算バグの修正

`aggregateSamples` で新規 group の `Value` を `sample.Value` で初期化した後、同じ sample を再度加算していたため、1 sample 目が 2 倍になっていました。これを修正し、新規 group の `Value` は `0` で初期化してから全 sample を統一的に加算するようにしました。

### 3. processLoop 側への accumulator 導入

`processLoop` 内に `metrics.Accumulator` を追加し、30 秒ごとの `metricsTicker` で flush して `wire.EncodeMetrics` を呼び出すようにしました。

- `dispatchTrace` は各 trace の `result.Metrics.Samples` を accumulator に追加するのみ。
- `flushAccumulator` は accumulator を flush し、flush 開始時刻を `startTime`、現在時刻を `endTime` として `EncodeMetrics` に渡す。
- これにより、同一 series の複数 trace が共通の報告区間（30 秒間隔）で集計されます。
- shutdown 時（`queue.Items()` が close された場合）にも最後の accumulator を flush します。

### 4. StartTimeUnixNano / TimeUnixNano の導出

`EncodeMetrics` のシグネチャを `EncodeMetrics(normalized, startTime, endTime)` に変更しました。`startTime` と `endTime` は accumulator の報告区間を表し、これまでの「サンプル群の最小・最大 timestamp」ではなく、accumulator が導出する値になります。

## 残る考慮事項

- 現状の accumulator 間隔は `metricsTicker` と同じ 30 秒固定です。必要に応じて設定可能にするか、または cron 区間に合わせて調整できます。
- `Normalize` は引き続き span ごとの raw sample を生成します。集計は accumulator / `EncodeMetrics` 側で完結します。
- `_total` 系は monotonic counter（Sum）、duration は histogram として維持します。gauge 化は行いません。

## 関連ファイル

- `deploy/otel/alloy/internal/metrics/accumulator.go` — 新規追加
- `deploy/otel/alloy/internal/metrics/canonical.go` — `MetricSample` に `Count` / `BucketCounts` を追加
- `deploy/otel/alloy/internal/wire/metrics.go` — `EncodeMetrics` シグネチャ変更、二重加算修正
- `deploy/otel/alloy/cmd/alloy-otel/pipeline.go` — accumulator 導入
- `deploy/otel/alloy/internal/wire/metrics_test.go` — テスト追加・更新
