# CommandCode Dashboard Format Design

## Goal

Align CommandCode's quota and reset visualizations with the gauge-based
presentation used by the other provider sections in the
`graft-ai — AI Provider Usage & Rate Limits` Grafana dashboard.

## Design

Add Gauge panels for CommandCode session and weekly usage ratios, and their
corresponding quota reset countdowns. Use `commandcode_usage_ratio` and
`commandcode_reset_timestamp_seconds` with their `period` labels, the 0–1 range
and percentage unit for usage, and duration units with reset-time thresholds
matching neighboring Codex quota gauges. Clamp reset countdowns at zero.

Keep credits, cost, plan, request, token, and subscription billing-period reset
panels as Stat panels. Reflow the existing Stat panels below the new gauges.
Keep CommandCode metrics, data collection, and dashboard section scope
unchanged.

## Verification

Parse the dashboard JSON and check that the four new quota panels are gauges
with the intended queries and field formatting, while existing Stat panels
remain Stat. Run the repository's dashboard validation target if available.
