// Aggregates only, with one exception for Shopify (0.15.0). There is no column for a name, email, phone or
// address anywhere. Customers exist as counts, except in shopify_order_state and shopify_customer_first,
// which hold a scrambled customer id: HMAC-SHA256 of Shopify's customer id with a random key per store that
// is kept outside the database (keychain or Cloud's encrypted secrets). The raw Shopify id and the key never
// land here. The ids let a daily sync rebuild only the days an edited order touches and still count new
// versus returning customers right. test/sync.test.ts asserts exactly this: the hash is present, the raw id
// and the key are absent, and no other table has a per-customer column. Adding one breaks it on purpose.
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
    // Google's own numbers for its own ads, read only. Conversions and their value are what Google attributes to itself, not orders.
    `CREATE TABLE IF NOT EXISTS fact_google_ads_campaign_daily (
    date DATE NOT NULL, account_id TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, cost NUMERIC NOT NULL, impressions BIGINT NOT NULL, clicks BIGINT NOT NULL,
    conversions NUMERIC NOT NULL, conversions_value NUMERIC NOT NULL, currency TEXT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, account_id, campaign_id))`,
    `CREATE TABLE IF NOT EXISTS fact_google_ads_ad_group_daily (
    date DATE NOT NULL, account_id TEXT NOT NULL, campaign_id TEXT NOT NULL, ad_group_id TEXT NOT NULL, ad_group_name TEXT NOT NULL, cost NUMERIC NOT NULL, impressions BIGINT NOT NULL, clicks BIGINT NOT NULL,
    conversions NUMERIC NOT NULL, conversions_value NUMERIC NOT NULL, currency TEXT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, account_id, ad_group_id))`,
    // Google Merchant Center, read only. Clicks and impressions on Google for the account's products by day and by
    // marketing method (ORGANIC for free listings, ADS for Shopping ads). Conversions and their value are what Google
    // attributes to free listings only; Google does not report them for ads here, and they are a claim, not orders.
    `CREATE TABLE IF NOT EXISTS fact_merchant_performance_daily (
    date DATE NOT NULL, account_id TEXT NOT NULL, marketing_method TEXT NOT NULL, clicks BIGINT NOT NULL, impressions BIGINT NOT NULL,
    conversions NUMERIC NOT NULL, conversion_value NUMERIC NOT NULL, currency TEXT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, account_id, marketing_method))`,
    // How many products Merchant Center holds and their status, one snapshot per sync day. Counts only: no product ids or titles.
    `CREATE TABLE IF NOT EXISTS fact_merchant_products_daily (
    date DATE NOT NULL, account_id TEXT NOT NULL, products BIGINT NOT NULL, eligible BIGINT NOT NULL, eligible_limited BIGINT NOT NULL,
    pending BIGINT NOT NULL, disapproved BIGINT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, account_id))`,
    // Microsoft Advertising's and LinkedIn's own numbers for their own ads, read only, daily campaign totals.
    // Conversions and conversion_value are what each network attributes to itself, not orders.
    `CREATE TABLE IF NOT EXISTS fact_microsoft_ads_daily (
    date DATE NOT NULL, account_id TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, spend NUMERIC NOT NULL, impressions BIGINT NOT NULL, clicks BIGINT NOT NULL,
    conversions NUMERIC NOT NULL, conversion_value NUMERIC NOT NULL, currency TEXT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, account_id, campaign_id))`,
    `CREATE TABLE IF NOT EXISTS fact_linkedin_ads_daily (
    date DATE NOT NULL, account_id TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, spend NUMERIC NOT NULL, impressions BIGINT NOT NULL, clicks BIGINT NOT NULL,
    conversions NUMERIC NOT NULL, conversion_value NUMERIC NOT NULL, currency TEXT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, account_id, campaign_id))`,
    // Reddit's and Snapchat's own numbers for their own ads, read only. Conversions and their value are purchases each
    // network attributes to itself, not orders. Snapchat's clicks are swipe-ups. Days follow each ad account's time zone.
    `CREATE TABLE IF NOT EXISTS fact_reddit_ads_daily (
    date DATE NOT NULL, account_id TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, spend NUMERIC NOT NULL, impressions BIGINT NOT NULL, clicks BIGINT NOT NULL,
    conversions NUMERIC NOT NULL, conversion_value NUMERIC NOT NULL, currency TEXT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, account_id, campaign_id))`,
    `CREATE TABLE IF NOT EXISTS fact_snapchat_ads_daily (
    date DATE NOT NULL, account_id TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, spend NUMERIC NOT NULL, impressions BIGINT NOT NULL, clicks BIGINT NOT NULL,
    conversions NUMERIC NOT NULL, conversion_value NUMERIC NOT NULL, currency TEXT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, account_id, campaign_id))`,
    // TikTok's own numbers for its own ads, read only. Conversions are website purchases and their value, as TikTok attributes them, not orders.
    `CREATE TABLE IF NOT EXISTS fact_tiktok_ads_daily (
    date DATE NOT NULL, account_id TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, spend NUMERIC NOT NULL, impressions BIGINT NOT NULL, clicks BIGINT NOT NULL,
    conversions NUMERIC NOT NULL, conversion_value NUMERIC NOT NULL, currency TEXT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, account_id, campaign_id))`,
    // Pinterest's own numbers for its own ads, read only. Conversions are checkouts and their value, as Pinterest attributes them, not orders.
    `CREATE TABLE IF NOT EXISTS fact_pinterest_ads_daily (
    date DATE NOT NULL, account_id TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL, spend NUMERIC NOT NULL, impressions BIGINT NOT NULL, clicks BIGINT NOT NULL,
    conversions NUMERIC NOT NULL, conversion_value NUMERIC NOT NULL, currency TEXT NOT NULL,
    source_synced_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (date, account_id, campaign_id))`,
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
    // Shopify order exports (bulk operations) a sync started, so a later sync can read one that finished after it stopped.
    // The operation id and its state only. The file it points to is never stored.
    `CREATE TABLE IF NOT EXISTS meta_shopify_bulk (
    op_id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, checked_at TIMESTAMPTZ, consumed_at TIMESTAMPTZ,
    objects BIGINT, error_code TEXT, expected BIGINT)`,
    // 0.15.0: incremental Shopify sync. One row per order: a keyed hash of its id, a keyed hash of its customer's id
    // (null for a guest), its day and amounts, and when it last changed. See the rule at the top of this file.
    `CREATE TABLE IF NOT EXISTS shopify_order_state (
    order_key TEXT PRIMARY KEY, customer_key TEXT, processed_at TIMESTAMPTZ NOT NULL, processed_day DATE NOT NULL,
    net NUMERIC NOT NULL, discounts NUMERIC NOT NULL, cancelled BOOLEAN NOT NULL, updated_at TIMESTAMPTZ)`,
    `CREATE INDEX IF NOT EXISTS shopify_order_state_customer ON shopify_order_state (customer_key)`,
    `CREATE INDEX IF NOT EXISTS shopify_order_state_day ON shopify_order_state (processed_day)`,
    // Each customer's first order that was not cancelled, by the same keyed hash, and its day and month.
    `CREATE TABLE IF NOT EXISTS shopify_customer_first (
    customer_key TEXT PRIMARY KEY, first_order_key TEXT NOT NULL, first_day DATE NOT NULL, first_month TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS shopify_customer_first_month ON shopify_customer_first (first_month)`,
    // Where the next incremental sync starts, when the last full pull ran, and a check value that says whether the
    // key in hand made the stored ids. The check is an HMAC of a fixed text, not the key.
    `CREATE TABLE IF NOT EXISTS meta_shopify_sync (
    id INT PRIMARY KEY, cursor_at TIMESTAMPTZ, last_full_at TIMESTAMPTZ, key_check TEXT, window_limited BOOLEAN NOT NULL DEFAULT false)`,
    // 0.20.1: Stripe's own totals for each finished month, from its Reports API (itemized balance activity), by the
    // day each charge was created: charges, gross and the refunds against them up to through_at. Totals only.
    `CREATE TABLE IF NOT EXISTS meta_stripe_report_month (
    month TEXT NOT NULL, currency TEXT NOT NULL, charges BIGINT NOT NULL, gross NUMERIC NOT NULL, refunds NUMERIC NOT NULL,
    through_at TIMESTAMPTZ NOT NULL, fetched_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (month, currency))`,
    // Rows Stripe's report could not place in a month; any makes that month's check fail toward withholding.
    `ALTER TABLE meta_stripe_report_month ADD COLUMN IF NOT EXISTS unplaced BIGINT NOT NULL DEFAULT 0`,
    // A report run Stripe is still preparing, picked up by the next sync.
    `CREATE TABLE IF NOT EXISTS meta_stripe_report_run (
    run_id TEXT PRIMARY KEY, interval_start BIGINT NOT NULL, interval_end BIGINT NOT NULL, started_at TIMESTAMPTZ NOT NULL)`,
];
// The only columns that hold a per-customer (or per-order) value. They are scrambled ids, and a query is
// refused if it would return one (src/query.ts marks them personal for the SQL guard).
export const SCRAMBLED_ID_COLUMNS = [
    { table: 'shopify_order_state', column: 'order_key' },
    { table: 'shopify_order_state', column: 'customer_key' },
    { table: 'shopify_customer_first', column: 'customer_key' },
    { table: 'shopify_customer_first', column: 'first_order_key' },
];
export const STATE_TABLES = ['shopify_order_state', 'shopify_customer_first', 'meta_shopify_sync'];
export const PUBLIC_TABLES = [
    'dim_flow', 'dim_campaign', 'dim_segment', 'fact_flow_daily',
    'fact_orders_daily', 'fact_cohort_monthly', 'fact_klaviyo_orders_daily', 'fact_flow_window', 'fact_ga4_daily',
    'fact_stripe_daily', 'fact_stripe_subscriptions_daily', 'fact_stripe_mrr', 'fact_meta_ads_daily',
    'fact_crm_deals_daily', 'fact_crm_pipeline_open', 'fact_crm_contacts_daily', 'fact_cogs_daily', 'fact_cogs_sku_daily', 'fact_google_ads_campaign_daily', 'fact_google_ads_ad_group_daily',
    'fact_merchant_performance_daily', 'fact_merchant_products_daily',
    'fact_microsoft_ads_daily', 'fact_linkedin_ads_daily',
    'fact_reddit_ads_daily', 'fact_snapchat_ads_daily',
    'fact_tiktok_ads_daily', 'fact_pinterest_ads_daily',
    'meta_sync_run', 'meta_source_total', 'meta_source_window', 'meta_reconcile_result',
];
