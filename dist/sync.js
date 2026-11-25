import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';
import { settingValue } from './config.js';
import { aggregateOrders } from './sources/shopify.js';
import { toDaily } from './sources/meta.js';
import { toAdGroupDaily, toCampaignDaily } from './sources/google-ads.js';
import { aggregateCharges, aggregateSubscriptions } from './sources/stripe.js';
import { aggregateContacts, aggregateDeals, uniqueCount } from './sources/hubspot.js';
import { isNoReportData, reportsVerified } from './sources/klaviyo.js';
const now = () => new Date().toISOString();
async function recordRun(db, source, fn) {
    const runId = randomUUID();
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, status) VALUES ($1, $2, $3, 'running')`, [runId, source, now()]);
    try {
        const r = await fn();
        await db.query(`UPDATE meta_sync_run SET finished_at = $2, status = $3, rows_written = $4, detail = $5 WHERE run_id = $1`, [runId, now(), r.status, r.rows, r.detail ?? null]);
        return { source, ...r };
    }
    catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        const code = e instanceof CliError ? e.code : 'error';
        await db.query(`UPDATE meta_sync_run SET finished_at = $2, status = 'failed', detail = $3, code = $4 WHERE run_id = $1`, [runId, now(), detail, code]);
        return { source, status: 'failed', rows: 0, detail, code };
    }
}
// Recomputes from the full order history inside one transaction, so a re-run
// cannot double count and a failed run leaves yesterday's numbers in place.
export async function writeShopify(db, orders) {
    const { daily, cohorts } = aggregateOrders(orders);
    const at = now();
    await db.transaction(async (tx) => {
        await tx.query('DELETE FROM fact_orders_daily');
        await tx.query('DELETE FROM fact_cohort_monthly');
        for (const d of daily) {
            await tx.query(`INSERT INTO fact_orders_daily (date, orders, gross_revenue, net_revenue, discounts, new_orders, returning_orders, guest_orders, source_synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [d.date, d.orders, d.gross, d.net, d.discounts, d.newOrders, d.returningOrders, d.guestOrders, at]);
        }
        for (const c of cohorts) {
            await tx.query(`INSERT INTO fact_cohort_monthly (cohort_month, months_since, customers, orders, revenue, source_synced_at) VALUES ($1,$2,$3,$4,$5,$6)`, [c.cohortMonth, c.monthsSince, c.customers, c.orders, c.revenue, at]);
        }
    });
    return daily.length + cohorts.length;
}
export async function writeFlowDaily(tx, rows, at) {
    for (const r of rows) {
        await tx.query(`INSERT INTO fact_flow_daily (flow_id, flow_message_id, channel, date, recipients, opens_unique, clicks_unique, conversions, revenue, unsubscribes, spam_complaints, bounces, source_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (flow_id, flow_message_id, channel, date) DO UPDATE SET recipients = EXCLUDED.recipients, opens_unique = EXCLUDED.opens_unique,
         clicks_unique = EXCLUDED.clicks_unique, conversions = EXCLUDED.conversions, revenue = EXCLUDED.revenue, unsubscribes = EXCLUDED.unsubscribes,
         spam_complaints = EXCLUDED.spam_complaints, bounces = EXCLUDED.bounces, source_synced_at = EXCLUDED.source_synced_at`, [r.flowId, r.flowMessageId, r.channel, r.date, r.recipients, r.opensUnique, r.clicksUnique, r.conversions, r.revenue, r.unsubscribes, r.spamComplaints, r.bounces, at]);
    }
}
async function setTotal(db, source, metric, value) {
    await db.query(`INSERT INTO meta_source_total VALUES ($1,$2,$3,$4) ON CONFLICT (source, metric) DO UPDATE SET value = EXCLUDED.value, recorded_at = EXCLUDED.recorded_at`, [source, metric, value, now()]);
}
export async function syncShopify(db, loadOrders, reportedCount) {
    return recordRun(db, 'shopify', async () => {
        const orders = await loadOrders();
        const rows = await writeShopify(db, orders);
        await setTotal(db, 'shopify', 'orders_pulled', orders.length);
        const reported = reportedCount ? await reportedCount() : null;
        if (reported === null)
            await db.query(`DELETE FROM meta_source_total WHERE source = 'shopify' AND metric = 'orders_reported'`);
        else
            await setTotal(db, 'shopify', 'orders_reported', reported);
        return { status: 'ok', rows };
    });
}
export async function syncGa4(db, load) {
    return recordRun(db, 'ga4', async () => {
        const rows = await load();
        const at = now();
        await db.transaction(async (tx) => {
            for (const r of rows) {
                await tx.query(`INSERT INTO fact_ga4_daily VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (date, channel) DO UPDATE SET sessions = EXCLUDED.sessions, purchases = EXCLUDED.purchases, revenue = EXCLUDED.revenue, source_synced_at = EXCLUDED.source_synced_at`, [r.date, r.channel, r.sessions, r.purchases, r.revenue, at]);
            }
        });
        return { status: 'ok', rows: rows.length };
    });
}
export async function syncKlaviyo(db, k, opts = {}) {
    return recordRun(db, 'klaviyo', async () => {
        const at = now();
        const [flows, campaigns, segments, metricId] = [await k.flows(), await k.campaigns(), await k.segments(), await k.placedOrderMetricId()];
        await db.transaction(async (tx) => {
            for (const f of flows) {
                await tx.query(`INSERT INTO dim_flow VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (flow_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, trigger_type = EXCLUDED.trigger_type, archived = EXCLUDED.archived, updated_at = EXCLUDED.updated_at, source_synced_at = EXCLUDED.source_synced_at`, [f.flowId, f.name, f.status, f.triggerType, f.archived, f.createdAt, f.updatedAt, at]);
            }
            for (const c of campaigns) {
                await tx.query(`INSERT INTO dim_campaign VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (campaign_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, send_time = EXCLUDED.send_time, archived = EXCLUDED.archived, source_synced_at = EXCLUDED.source_synced_at`, [c.campaignId, c.name, c.status, c.sendTime, c.archived, at]);
            }
            for (const s of segments) {
                await tx.query(`INSERT INTO dim_segment VALUES ($1,$2,$3,$4,$5) ON CONFLICT (segment_id) DO UPDATE SET name = EXCLUDED.name, is_active = EXCLUDED.is_active, source_synced_at = EXCLUDED.source_synced_at`, [s.segmentId, s.name, s.isActive, s.createdAt, at]);
            }
        });
        const end = opts.until ?? new Date().toISOString();
        const start = opts.since ?? new Date(Date.now() - settingValue('metrics.default_days') * 86400000).toISOString();
        let base = flows.length + campaigns.length + segments.length;
        if (metricId) {
            const placed = await k.placedOrdersDaily(metricId, start, end);
            await db.transaction(async (tx) => {
                for (const p of placed) {
                    await tx.query(`INSERT INTO fact_klaviyo_orders_daily VALUES ($1,$2,$3,$4) ON CONFLICT (date) DO UPDATE SET placed_orders = EXCLUDED.placed_orders, placed_value = EXCLUDED.placed_value, source_synced_at = EXCLUDED.source_synced_at`, [p.date, p.orders, p.value, at]);
                }
                // Remember which days this covers. Reconcile needs it, because a day with
                // no rows could mean no orders or could mean it was never pulled.
                await tx.query(`INSERT INTO meta_source_window VALUES ('klaviyo', 'placed_orders', $1, $2, $3) ON CONFLICT (source, metric) DO UPDATE SET
             window_start = CASE WHEN EXCLUDED.window_start <= meta_source_window.window_end AND EXCLUDED.window_end >= meta_source_window.window_start
               THEN LEAST(meta_source_window.window_start, EXCLUDED.window_start) ELSE EXCLUDED.window_start END,
             window_end = CASE WHEN EXCLUDED.window_start <= meta_source_window.window_end AND EXCLUDED.window_end >= meta_source_window.window_start
               THEN GREATEST(meta_source_window.window_end, EXCLUDED.window_end) ELSE EXCLUDED.window_end END,
             recorded_at = EXCLUDED.recorded_at`, [start.slice(0, 10), end.slice(0, 10), at]);
            });
            base += placed.length;
        }
        if (!metricId)
            return { status: 'warning', rows: base, detail: 'No Placed Order metric in Klaviyo, so flow revenue was skipped.' };
        if (flows.length === 0)
            return { status: 'warning', rows: base, detail: 'This Klaviyo account has no flows, so there is no flow report yet.' };
        try {
            const rows = await k.flowSeries(metricId, start, end);
            const totals = await k.flowTotals(metricId, start, end);
            await db.transaction(async (tx) => {
                await writeFlowDaily(tx, rows, at);
                await tx.query('DELETE FROM fact_flow_window');
                for (const t of totals) {
                    await tx.query(`INSERT INTO fact_flow_window VALUES ($1,$2,$3,$4,$5,$6)`, [t.flowId, start.slice(0, 10), end.slice(0, 10), t.recipients, t.revenue, at]);
                }
            });
            return {
                status: reportsVerified ? 'ok' : 'warning',
                rows: base + rows.length,
                detail: reportsVerified ? undefined : 'Flow report parsing is untested on real sends.',
            };
        }
        catch (e) {
            if (isNoReportData(e))
                return { status: 'warning', rows: base, detail: 'Klaviyo has no report data for this metric yet.' };
            throw e;
        }
    });
}
// Recomputes charges and subscription starts from full history in one
// transaction, like Shopify, because "new customer" needs every earlier charge.
// MRR is a snapshot, kept per day so its history builds up.
export async function writeStripe(db, charges, subs, today = now().slice(0, 10)) {
    const daily = aggregateCharges(charges);
    const s = subs ? aggregateSubscriptions(subs) : null;
    const at = now();
    await db.transaction(async (tx) => {
        await tx.query('DELETE FROM fact_stripe_daily');
        for (const d of daily) {
            await tx.query(`INSERT INTO fact_stripe_daily VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [d.date, d.currency, d.charges, d.gross, d.refunded, d.net, d.failed, d.newCustomers, d.returningCharges, d.guestCharges, at]);
        }
        if (!s)
            return;
        await tx.query('DELETE FROM fact_stripe_subscriptions_daily');
        for (const d of s.daily) {
            await tx.query(`INSERT INTO fact_stripe_subscriptions_daily VALUES ($1,$2,$3,$4,$5)`, [d.date, d.currency, d.started, d.ended, at]);
        }
        await tx.query('DELETE FROM fact_stripe_mrr WHERE date = $1', [today]);
        for (const m of s.mrr) {
            await tx.query(`INSERT INTO fact_stripe_mrr VALUES ($1,$2,$3,$4,$5,$6)`, [today, m.currency, m.active, m.mrr, m.unpricedItems, at]);
        }
    });
    return { rows: daily.length + (s ? s.daily.length + s.mrr.length : 0), unpriced: s ? s.mrr.reduce((n, m) => n + m.unpricedItems, 0) : 0 };
}
export async function syncStripe(db, load) {
    return recordRun(db, 'stripe', async () => {
        const charges = await load.charges();
        const subs = await load.subscriptions();
        const { rows, unpriced } = await writeStripe(db, charges, subs);
        await setTotal(db, 'stripe', 'charges_pulled', charges.length);
        // 0.14.0: what the daily rows must add up to, and how many subscriptions are open right now,
        // so the trust gate can check Stripe's daily tables against the pull itself.
        await setTotal(db, 'stripe', 'charges_counted', charges.filter((c) => c.status === 'succeeded' || c.status === 'failed').length);
        if (subs)
            await setTotal(db, 'stripe', 'subscriptions_pulled', subs.length);
        if (subs)
            await setTotal(db, 'stripe', 'subscriptions_open', subs.filter((x) => x.status !== 'incomplete_expired' && !x.ended_at).length);
        const notes = [
            subs ? null : 'This key cannot read subscriptions, so MRR and churn were skipped.',
            unpriced ? `${unpriced} subscription items use tiered or metered prices and are left out of MRR.` : null,
        ].filter(Boolean);
        return { status: notes.length ? 'warning' : 'ok', rows, detail: notes.length ? notes.join(' ') : undefined };
    });
}
// Meta restates recent days as late conversions come in, so every sync pulls the whole window again and
// replaces it in one transaction. Days older than the window keep what the last sync that covered them saw.
// Rows from any other ad account are removed, so connecting a different account never mixes two accounts' history.
export async function writeMeta(db, rows, since, currency, account = '') {
    const daily = toDaily(rows);
    const at = now();
    await db.transaction(async (tx) => {
        await tx.query('DELETE FROM fact_meta_ads_daily WHERE date >= $1 OR account_id <> $2', [since, account]);
        for (const d of daily) {
            await tx.query(`INSERT INTO fact_meta_ads_daily VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (date, campaign_id) DO NOTHING`, [d.date, d.campaignId, d.campaignName, d.spend, d.impressions, d.clicks, d.purchases, d.purchaseValue, currency, account, at]);
        }
    });
    return { rows: daily.length, spend: Math.round(daily.reduce((n, d) => n + d.spend, 0) * 100) / 100 };
}
export async function syncMeta(db, load, opts = {}) {
    return recordRun(db, 'meta', async () => {
        const until = opts.today ?? now().slice(0, 10);
        // The same first day a 90-day metric uses, so a default window never holds a day of revenue with no spend pulled for it.
        const since = new Date(Date.parse(`${until}T00:00:00Z`) - (opts.days ?? settingValue('metrics.default_days')) * 86400000).toISOString().slice(0, 10);
        const raw = await load(since, until);
        const { rows } = await writeMeta(db, raw, since, opts.currency ?? '', opts.account ?? '');
        await setTotal(db, 'meta', 'rows_pulled', raw.length);
        return rows ? { status: 'ok', rows } : { status: 'warning', rows, detail: `Meta returned no campaign activity from ${since} to ${until}.` };
    });
}
// HubSpot, recomputed from the full pull in one transaction like Shopify and Stripe, so a re-run
// never double counts. The open pipeline is a snapshot kept per day, like MRR.
export async function writeHubspot(db, deals, contacts, currency, today = now().slice(0, 10)) {
    const { daily, open } = aggregateDeals(deals, currency);
    const people = aggregateContacts(contacts);
    const at = now();
    await db.transaction(async (tx) => {
        await tx.query('DELETE FROM fact_crm_deals_daily');
        for (const d of daily) {
            await tx.query(`INSERT INTO fact_crm_deals_daily VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [d.date, d.currency, d.pipeline, d.source, d.created, d.amountCreated, d.won, d.lost, d.wonAmount, at]);
        }
        await tx.query('DELETE FROM fact_crm_pipeline_open WHERE date = $1', [today]);
        for (const o of open) {
            await tx.query(`INSERT INTO fact_crm_pipeline_open VALUES ($1,$2,$3,$4,$5,$6,$7)`, [today, o.currency, o.pipeline, o.stage, o.deals, o.amount, at]);
        }
        await tx.query('DELETE FROM fact_crm_contacts_daily');
        for (const c of people) {
            await tx.query(`INSERT INTO fact_crm_contacts_daily VALUES ($1,$2,$3,$4,$5)`, [c.date, c.source, c.stage, c.contacts, at]);
        }
    });
    return daily.length + open.length + people.length;
}
export async function syncHubspot(db, load, opts = {}) {
    return recordRun(db, 'hubspot', async () => {
        const deals = await load.deals();
        const contacts = await load.contacts();
        const rows = await writeHubspot(db, deals, contacts, opts.currency ?? 'usd');
        await setTotal(db, 'hubspot', 'deals_pulled', uniqueCount(deals));
        await setTotal(db, 'hubspot', 'contacts_pulled', uniqueCount(contacts));
        for (const object of ['deals', 'contacts']) {
            const reported = load.total ? await load.total(object) : null;
            if (reported === null)
                await db.query(`DELETE FROM meta_source_total WHERE source = 'hubspot' AND metric = $1`, [`${object}_reported`]);
            else
                await setTotal(db, 'hubspot', `${object}_reported`, reported);
        }
        if (!deals.length && !contacts.length)
            return { status: 'warning', rows, detail: 'HubSpot returned no deals and no contacts.' };
        return { status: 'ok', rows };
    });
}
// Google restates recent days as late conversions come in, the same as Meta, so every sync replaces the whole
// window in one transaction and older days keep what the last sync that covered them saw. Rows from any other
// customer id are removed, so switching accounts never mixes two accounts' history.
export async function writeGoogleAds(db, data, since, currency, customer) {
    const campaigns = toCampaignDaily(data.campaigns);
    const adGroups = toAdGroupDaily(data.adGroups);
    const at = now();
    await db.transaction(async (tx) => {
        for (const t of ['fact_google_ads_campaign_daily', 'fact_google_ads_ad_group_daily']) {
            await tx.query(`DELETE FROM ${t} WHERE date >= $1 OR account_id <> $2`, [since, customer]);
        }
        for (const d of campaigns) {
            await tx.query(`INSERT INTO fact_google_ads_campaign_daily VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (date, account_id, campaign_id) DO NOTHING`, [d.date, customer, d.campaignId, d.campaignName, d.cost, d.impressions, d.clicks, d.conversions, d.conversionsValue, currency, at]);
        }
        for (const d of adGroups) {
            await tx.query(`INSERT INTO fact_google_ads_ad_group_daily VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (date, account_id, ad_group_id) DO NOTHING`, [d.date, customer, d.campaignId, d.adGroupId, d.adGroupName, d.cost, d.impressions, d.clicks, d.conversions, d.conversionsValue, currency, at]);
        }
    });
    return { campaignRows: campaigns.length, adGroupRows: adGroups.length };
}
export async function syncGoogleAds(db, load, opts) {
    return recordRun(db, 'google-ads', async () => {
        const until = opts.today ?? now().slice(0, 10);
        const since = new Date(Date.parse(`${until}T00:00:00Z`) - (opts.days ?? settingValue('metrics.default_days')) * 86400000).toISOString().slice(0, 10);
        const campaigns = await load.campaigns(since, until);
        const adGroups = await load.adGroups(since, until);
        const { campaignRows, adGroupRows } = await writeGoogleAds(db, { campaigns, adGroups }, since, opts.currency ?? '', opts.customer);
        await setTotal(db, 'google-ads', 'rows_pulled', campaigns.length + adGroups.length);
        const rows = campaignRows + adGroupRows;
        return campaignRows ? { status: 'ok', rows } : { status: 'warning', rows, detail: `Google Ads returned no campaign activity from ${since} to ${until}.` };
    });
}
