# graft-ai

[English](README.md)

Cloudflare AI Gateway 向けのルーティングと可観測性を提供する補助プロジェクトです。Free Tier の proxy 経路を最短の導入経路とし、必要に応じて OpenTelemetry パイプラインを追加できます。

## 概要

`graft-ai` は Cloudflare AI Gateway 用の Worker proxy と、AI リクエストのテレメトリを OpenTelemetry 互換バックエンドへ送るための任意の可観測性経路を提供します。

最初に試す場合は **Free Tier proxy-only** を使用してください。Logpush と dedicated OTel Worker は、より広い可観測性や production 規模の ingestion が必要な場合の追加経路です。

## Quick Start

### 必要条件

- Node.js 22
- `npm` / `npx`
- `jq`
- Cloudflare アカウント
- 作成済みの Cloudflare AI Gateway

### 設定

`workers/wrangler.proxy.jsonc` を編集し、次を設定します。

- `CF_ACCOUNT_ID`
- `AI_GATEWAY_ID`

Provider API key はファイルへ保存しないでください。Provider credential はリクエスト時に渡し、proxy secret で保護します。

### デプロイ

```bash
make setup-free-tier
```

setup script が Worker dependency のinstall、proxy Worker のdeploy、proxy secret の設定を行います。

### 動作確認

deploy 済みproxyへ `X-Proxy-Secret` header付きで1リクエスト送信します。AI Gateway の正常な応答が返れば最小経路は成功です。

具体的なリクエスト例、local observability stack、troubleshooting は [Free Tier AI Gateway + OTel](docs/free-tier-ai-gateway-otel.md) を参照してください。

## Features

- Cloudflare AI Gateway 向けFree Tier proxy
- 任意のLogpush telemetry ingestion
- 任意のdedicated OTel Worker ingestion
- redaction とpayload保護
- OpenTelemetry traces / logs / metrics
- Tempo / Loki / Prometheus / Grafana のlocal・self-hosted workflow
- Terraform / Wrangler deployment

## How It Works

主な経路は3つです。

1. **Free Tier proxy-only** — 標準のonboarding経路。リクエストをproxy Worker経由でCloudflare AI Gatewayへ送ります。
2. **Logpush** — AI Gateway logsをobservability pipelineへexportする任意のCloudflare経路です。
3. **Dedicated OTel Worker** — payload storage、queue processing、OTLP exportを備えた任意のingestion経路です。

技術的invariant、storage semantics、failure behavior、redaction requirement、protocol contractの英語正本は [SPEC.md](SPEC.md) です。

## Usage

proxy WorkerをAI requestのupstream endpointとして利用し、`X-Proxy-Secret` で認証します。

具体的な手順:

- [Free Tier AI Gateway + OTel](docs/free-tier-ai-gateway-otel.md)
- [Dedicated Cloudflare Worker OTel path](docs/cloudflare-worker-ai-gateway-otel.md)
- [Provider metrics](docs/provider-metrics.md)

## Configuration

proxyで最も重要な設定は `workers/wrangler.proxy.jsonc` の `CF_ACCOUNT_ID` と `AI_GATEWAY_ID` です。secretはrepositoryへcommitせず、Wranglerまたは提供されているsetup workflowで設定してください。

完全な人間向けreferenceは [Configuration](docs/configuration.md) を参照してください。具体的な変数名とshapeについてはmachine-usable exampleを正本とします。

## Documentation

- [SPEC.md](SPEC.md) — normative technical contract / invariant の英語正本
- [AGENTS.md](AGENTS.md) — AI coding agent 向け指示
- [Configuration](docs/configuration.md) — 完全なconfiguration reference
- [Deployment](docs/deployment.md) — deployment経路の入口
- [Operations](docs/operations.md) — monitoring / recovery / quota
- [Migration](docs/migration.md) — payload-store / deployment migration
- [Free Tier AI Gateway + OTel](docs/free-tier-ai-gateway-otel.md) — Free Tier walkthrough
- [Dedicated Cloudflare Worker OTel path](docs/cloudflare-worker-ai-gateway-otel.md) — dedicated OTel Worker runbook
- [Provider metrics](docs/provider-metrics.md) — provider metrics integration

## Development

Worker dependencyをinstallし、repository rootからcheckを実行します。

```bash
make test
```

その他のdevelopment commandは `Makefile` と `workers/` 配下のpackage scriptsを参照してください。

## License

[LICENSE](LICENSE) を参照してください。
