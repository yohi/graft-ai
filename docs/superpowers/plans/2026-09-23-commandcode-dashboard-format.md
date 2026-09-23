# CommandCode Dashboard Format Implementation Plan

> **For agentic workers:** Execute this plan inline, task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CommandCode session and weekly quota usage/reset visuals consistent with other provider gauges.

**Architecture:** Update only the CommandCode panel definitions in the existing Grafana dashboard JSON. Preserve all metric names, queries, and unrelated Stat panels; validate JSON and relevant dashboard checks.

**Tech Stack:** Grafana dashboard JSON, Prometheus queries, repository Make targets.

## Global Constraints

- Keep the existing CommandCode metric names and data collection unchanged.
- Use the existing Codex gauge units, ranges, thresholds, and duration formatting.
- Keep non-quota CommandCode panels as Stat panels.

---

### Task 1: Add CommandCode quota usage and reset gauges

**Files:**
- Modify: `grafana/dashboards/graft-ai-provider-metrics.json`

- [ ] Add Gauge panels for `commandcode_usage_ratio` with `period="session"` and `period="weekly"`; use 0–1 bounds, `percentunit`, `noValue: "-"`, and the Codex green/yellow/red usage thresholds.
- [ ] Add Gauge panels for `commandcode_reset_timestamp_seconds` with session and weekly periods; query remaining seconds with `clamp_min(... - time(), 0)`, use the `dtdhms` unit, and match Codex reset ranges and thresholds (18,000 seconds for session; 604,800 seconds for weekly).
- [ ] Reflow existing CommandCode Stat panels below the gauges, preserving credits, usage cost, plan, requests, tokens, and billing-period reset as Stat panels.
- [ ] Parse the dashboard JSON with `jq empty grafana/dashboards/graft-ai-provider-metrics.json` and run the repository dashboard validation target (inspect `Makefile` to select the exact target).

**Expected result:** CommandCode quota usage and reset countdown use Gauge panels consistent with other provider quota displays; all other CommandCode panels remain unchanged in type and metric behavior.
