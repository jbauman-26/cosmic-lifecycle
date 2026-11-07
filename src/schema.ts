// Aggregates only. There is no column for a name, email, phone or address, and
// customers exist only as counts. Adding such a column breaks a test on purpose.
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS dim_flow (
    flow_id TEXT PRIMARY KEY, name TEXT, status TEXT, trigger_type TEXT, archived BOOLEAN,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, source_synced_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dim_campaign (
    campaign_id TEXT PRIMARY KEY, name TEXT, status TEXT, send_time TIMESTAMPTZ, archived BOOLEAN, source_synced_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dim_segment (
    segment_id TEXT PRIMARY KEY, name TEXT, is_active BOOLEAN, created_at TIMESTAMPTZ, source_synced_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fact_flow_daily (
    flow_id TEXT NOT NULL, flow_message_id TEXT NOT NULL, channel TEXT NOT NULL, date DATE NOT NULL,
    recipients BIGINT NOT NULL DEFAULT 0, opens_unique BIGINT NOT NULL DEFAULT 0, clicks_unique BIGINT NOT NULL DEFAULT 0,
    conversions BIGINT NOT NULL DEFAULT 0, revenue NUMERIC NOT NULL DEFAULT 0, unsubscribes BIGINT NOT NULL DEFAULT 0,
    spam_complaints BIGINT NOT NULL DEFAULT 0, bounces BIGINT NOT NULL DEFAULT 0, source_synced_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (flow_id, flow_message_id, channel, date))`,
  `CREATE TABLE IF NOT EXISTS fact_orders_daily (
    date DATE PRIMARY KEY, orders BIGINT NOT NULL, gross_revenue NUMERIC NOT NULL, net_revenue NUMERIC NOT NULL,
    discounts NUMERIC NOT NULL, new_orders BIGINT NOT NULL, returning_orders BIGINT NOT NULL, source_synced_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fact_cohort_monthly (
    cohort_month TEXT NOT NULL, months_since INT NOT NULL, customers BIGINT NOT NULL, orders BIGINT NOT NULL,
    revenue NUMERIC NOT NULL, source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (cohort_month, months_since))`,
  `CREATE TABLE IF NOT EXISTS meta_sync_run (
    run_id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, finished_at TIMESTAMPTZ,
    status TEXT NOT NULL, rows_written BIGINT NOT NULL DEFAULT 0, detail TEXT)`,
  `ALTER TABLE fact_orders_daily ADD COLUMN IF NOT EXISTS guest_orders BIGINT NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS fact_klaviyo_orders_daily (
    date DATE PRIMARY KEY, placed_orders BIGINT NOT NULL, placed_value NUMERIC NOT NULL, source_synced_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fact_flow_window (
    flow_id TEXT NOT NULL, window_start DATE NOT NULL, window_end DATE NOT NULL, recipients BIGINT NOT NULL, revenue NUMERIC NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (flow_id, window_start, window_end))`,
  `CREATE TABLE IF NOT EXISTS fact_ga4_daily (
    date DATE NOT NULL, channel TEXT NOT NULL, sessions BIGINT NOT NULL, purchases BIGINT NOT NULL, revenue NUMERIC NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, channel))`,
  `CREATE TABLE IF NOT EXISTS meta_source_total (
    source TEXT NOT NULL, metric TEXT NOT NULL, value NUMERIC NOT NULL, recorded_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (source, metric))`,
  `CREATE TABLE IF NOT EXISTS meta_reconcile_result (
    check_name TEXT PRIMARY KEY, status TEXT NOT NULL, expected NUMERIC, actual NUMERIC, diff_pct NUMERIC, detail TEXT NOT NULL, checked_at TIMESTAMPTZ NOT NULL)`,
]

export const PUBLIC_TABLES = [
  'dim_flow', 'dim_campaign', 'dim_segment', 'fact_flow_daily',
  'fact_orders_daily', 'fact_cohort_monthly', 'fact_klaviyo_orders_daily', 'fact_flow_window', 'fact_ga4_daily',
  'meta_sync_run', 'meta_source_total', 'meta_reconcile_result',
] as const
