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
    `CREATE TABLE IF NOT EXISTS meta_source_window (
    source TEXT NOT NULL, metric TEXT NOT NULL, window_start DATE NOT NULL, window_end DATE NOT NULL, recorded_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (source, metric))`,
    `CREATE TABLE IF NOT EXISTS meta_reconcile_result (
    check_name TEXT PRIMARY KEY, status TEXT NOT NULL, expected NUMERIC, actual NUMERIC, diff_pct NUMERIC, detail TEXT NOT NULL, checked_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS fact_stripe_daily (
    date DATE NOT NULL, currency TEXT NOT NULL, charges BIGINT NOT NULL, gross NUMERIC NOT NULL, refunded NUMERIC NOT NULL, net NUMERIC NOT NULL,
    failed_charges BIGINT NOT NULL, new_customers BIGINT NOT NULL, returning_charges BIGINT NOT NULL, guest_charges BIGINT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, currency))`,
    `CREATE TABLE IF NOT EXISTS fact_stripe_subscriptions_daily (
    date DATE NOT NULL, currency TEXT NOT NULL, started BIGINT NOT NULL, ended BIGINT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, currency))`,
    // One row per sync day, so MRR history builds up from the first sync on.
    `CREATE TABLE IF NOT EXISTS fact_stripe_mrr (
    date DATE NOT NULL, currency TEXT NOT NULL, active_subscriptions BIGINT NOT NULL, mrr NUMERIC NOT NULL, unpriced_items BIGINT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, currency))`,
    // Meta's own numbers for its own ads. Purchases and their value are what Meta attributes to itself, not orders.
    `CREATE TABLE IF NOT EXISTS fact_meta_ads_daily (
    date DATE NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, spend NUMERIC NOT NULL, impressions BIGINT NOT NULL, clicks BIGINT NOT NULL,
    purchases NUMERIC NOT NULL, purchase_value NUMERIC NOT NULL, currency TEXT NOT NULL, account_id TEXT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, campaign_id))`,
    // The error code of a failed run, such as key_rejected or rate_limited, so the app can say what went wrong without the raw reply.
    `ALTER TABLE meta_sync_run ADD COLUMN IF NOT EXISTS code TEXT`,
    // Custom SQL that agents ran because no verified metric fit. Repeated ones become new metrics.
    `CREATE TABLE IF NOT EXISTS meta_custom_query (
    sql_hash TEXT PRIMARY KEY, sql TEXT NOT NULL, runs BIGINT NOT NULL DEFAULT 1, first_seen TIMESTAMPTZ NOT NULL, last_seen TIMESTAMPTZ NOT NULL)`,
    // Numbers the owner saved by hand: a metric id, a label and one SELECT. SQL text only, never results.
    `CREATE TABLE IF NOT EXISTS meta_saved_metric (
    metric TEXT PRIMARY KEY, title TEXT NOT NULL, unit TEXT NOT NULL, sql TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    // 0.14.0: a CRM as the source of truth. Counts and amounts by day, pipeline and original source.
    // No contact, company or deal record is stored: ids are counted in memory and dropped.
    `CREATE TABLE IF NOT EXISTS fact_crm_deals_daily (
    date DATE NOT NULL, currency TEXT NOT NULL, pipeline TEXT NOT NULL, source TEXT NOT NULL,
    deals_created BIGINT NOT NULL, amount_created NUMERIC NOT NULL, deals_won BIGINT NOT NULL, deals_lost BIGINT NOT NULL, won_amount NUMERIC NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, currency, pipeline, source))`,
    // Open deals by stage as of each sync day, so pipeline history builds up from the first sync on.
    `CREATE TABLE IF NOT EXISTS fact_crm_pipeline_open (
    date DATE NOT NULL, currency TEXT NOT NULL, pipeline TEXT NOT NULL, stage TEXT NOT NULL, open_deals BIGINT NOT NULL, open_amount NUMERIC NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, currency, pipeline, stage))`,
    // Contacts by the day they were created, their original source and their lifecycle stage today.
    `CREATE TABLE IF NOT EXISTS fact_crm_contacts_daily (
    date DATE NOT NULL, source TEXT NOT NULL, lifecycle_stage TEXT NOT NULL, contacts BIGINT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, source, lifecycle_stage))`,
    // 0.14.0: cost of goods by day from Shopify unit costs. Lines with no cost keep their revenue apart,
    // so the owner's cogs_percent can cover them.
    `CREATE TABLE IF NOT EXISTS fact_cogs_daily (
    date DATE PRIMARY KEY, currency TEXT NOT NULL, cogs_known NUMERIC NOT NULL, uncosted_revenue NUMERIC NOT NULL, tax NUMERIC NOT NULL,
    lines BIGINT NOT NULL, lines_with_cost BIGINT NOT NULL, orders_without_cost BIGINT NOT NULL, source_synced_at TIMESTAMPTZ NOT NULL)`,
    // Units and revenue by SKU and day, for a cost per product the owner keeps outside Shopify. A SKU is a product code, not a person.
    `CREATE TABLE IF NOT EXISTS fact_cogs_sku_daily (
    date DATE NOT NULL, sku TEXT NOT NULL, units BIGINT NOT NULL, revenue NUMERIC NOT NULL, source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, sku))`,
];
export const PUBLIC_TABLES = [
    'dim_flow', 'dim_campaign', 'dim_segment', 'fact_flow_daily',
    'fact_orders_daily', 'fact_cohort_monthly', 'fact_klaviyo_orders_daily', 'fact_flow_window', 'fact_ga4_daily',
    'fact_stripe_daily', 'fact_stripe_subscriptions_daily', 'fact_stripe_mrr', 'fact_meta_ads_daily',
    'fact_crm_deals_daily', 'fact_crm_pipeline_open', 'fact_crm_contacts_daily', 'fact_cogs_daily', 'fact_cogs_sku_daily',
    'meta_sync_run', 'meta_source_total', 'meta_source_window', 'meta_reconcile_result',
];
