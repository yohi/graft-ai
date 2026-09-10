# graft-ai

[English](README.md)

[![CI](https://github.com/yohi/graft-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/yohi/graft-ai/actions/workflows/ci.yml)

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

setup script が Worker dependency の install、proxy Worker の deploy、proxy secret の設定を行います。

### 動作確認

deploy 済み proxy へ `X-Proxy-Secret` header 付きで1リクエスト送信します。AI Gateway の正常な応答が返れば最小経路は成功です。

具体的なリクエスト例、local observability stack、troubleshooting は [Free Tier AI Gateway + OTel](docs/free-tier-ai-gateway-otel.md) を参照してください。

## Features

- Cloudflare AI Gateway 向け Free Tier proxy
- 任意の Logpush telemetry ingestion
- 任意の dedicated OTel Worker ingestion
- redaction と payload 保護
- OpenTelemetry traces / logs / metrics
- Tempo / Loki / Prometheus / Grafana の local・self-hosted workflow
- Terraform / Wrangler deployment

## How It Works

主な経路は3つです。

1. **Free Tier proxy-only** — 標準の onboarding 経路。リクエストを proxy Worker 経由で Cloudflare AI Gateway へ送ります。
2. **Logpush** — AI Gateway logs を observability pipeline へ export する任意の Cloudflare 経路です。
3. **Dedicated OTel Worker** — payload storage、queue processing、OTLP export を備えた任意の ingestion 経路です。

技術的 invariant、storage semantics、failure behavior、redaction requirement、protocol contract の英語正本は [SPEC.md](SPEC.md) です。

## Usage

proxy Worker を AI requests の upstream endpoint として利用し、`X-Proxy-Secret` で認証します。

具体的な手順:

- [Free Tier AI Gateway + OTel](docs/free-tier-ai-gateway-otel.md)
- [Logpush Deployment](docs/logpush.md)
- [Dedicated Cloudflare Worker OTel path](docs/cloudflare-worker-ai-gateway-otel.md)
- [Provider metrics](docs/provider-metrics.md)
- [Ollama Cloud reset metrics](docs/ollama-cloud.md)

## Configuration

proxy で最も重要な設定は `workers/wrangler.proxy.jsonc` の `CF_ACCOUNT_ID` と `AI_GATEWAY_ID` です。secret は repository へ commit せず、Wrangler または提供されている setup workflow で設定してください。

完全な人間向け reference は [Configuration](docs/configuration.md) を参照してください。具体的な変拰名と shape については machine-usable example を正本とします。

## Documentation

- [SPEC.md](SPEC.md) — normative technical contract / invariant の英語正本
- [AGENTS.md](AGENTS.md) — AI coding agent 向け指示
- [Configuration](docs/configuration.md) — 完全な configuration reference
- [Deployment](docs/deployment.md) — deployment 経路の入口
- [Operations](docs/operations.md) — monitoring / recovery / quota
- [Migration](docs/migration.md) — payload-store / deployment migration
- [Free Tier AI Gateway + OTel](docs/free-tier-ai-gateway-otel.md) — Free Tier walkthrough
- [Logpush Deployment](docs/logpush.md) — Logpush setup / deployment runbook
- [Dedicated Cloudflare Worker OTel path](docs/cloudflare-worker-ai-gateway-otel.md) — dedicated OTel Worker runbook
- [Provider metrics](docs/provider-metrics.md) — provider metrics integration
- [Ollama Cloud reset metrics](docs/ollama-cloud.md) — scheduled reset-window metrics

## Development

Worker dependency を install し、repository root から test を実行します。

```bash
make install
make test
```

その他の development command は `Makefile` と `workers/` 配下の package scripts を参照してください。

## License

[LICENSE](LICENSE) を参照してください。
