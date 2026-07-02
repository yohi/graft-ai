# graft-ai

Cloudflare AI Gateway, OpenAI, and Ollama Cloud telemetry (metrics/logs) aggregator for Grafana Cloud.

---

## 📌 Overview

`graft-ai` is an integrated telemetry pipeline designed to graft costs, token usages, and access logs from multiple AI provider endpoints into a unified **Grafana Cloud** dashboard.

This project is fully optimized to run within the constraints of the **Grafana Cloud Free Tier** (14-day retention, 10k active series, 50GB logs).

## 🏗️ Architecture

- **Cloudflare AI Gateway:** Streams proxy logs and latency directly to Grafana Loki via Workers Logpush.
- **OpenAI GPT Usage:** Scrapes token consumption and dollar-based costs via Management API to Grafana Prometheus.
- **Ollama Cloud:** Tracks GPU execution duration metrics and account limitations to Grafana Prometheus.
