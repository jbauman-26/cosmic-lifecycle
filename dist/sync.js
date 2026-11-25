import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';
import { settingValue } from './config.js';
import { aggregateOrders } from './sources/shopify.js';
import { CompactOrders, isDone, pollExport, readExport, startOrdersExport, waitForExport } from './sources/shopify-bulk.js';
import { toDaily } from './sources/meta.js';
import { aggregateCharges, aggregateSubscriptions } from './sources/stripe.js';
import { isNoReportData, reportsVerified } from './sources/klaviyo.js';
const now = () => new Date().toISOString();
async function recordRun(db, source, fn) {
    const runId = randomUUID();
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, status) VALUES ($1, $2, $3, 'running')`, [runId, source, now()]);
    try {
        const r = await fn();
        await db.query(`UPDATE meta_sync_run SET finished_at = $2, status = $3, rows_written = $4, detail = $5, code = $6 WHERE run_id = $1`, [runId, now(), r.status, r.rows, r.detail ?? null, r.code ?? null]);
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
    return writeShopifyTotals(db, aggregateOrders(orders));
}
export async function writeShopifyTotals(db, { daily, cohorts }) {
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
const RUNNING_DETAIL = 'Shopify is still building the full order export. The totals from the last finished export stay in place, and the next sync reads the new one.';
// Large stores: one Shopify bulk operation instead of thousands of pages. The operation id is saved, so a
// sync that stops (a time limit, a closed laptop, a dropped download) loses nothing: the next one polls the
// same operation, or reads the same finished file again, which Shopify keeps for a week. Totals are only
// replaced once a whole file has been read and its line count matches Shopify's own count of objects.
export async function syncShopifyBulk(db, deps) {
    return recordRun(db, 'shopify', async () => {
        const at = now();
        const mark = (op, consumed) => db.query(`UPDATE meta_shopify_bulk SET status = $2, checked_at = $3, objects = $4, error_code = $5, consumed_at = CASE WHEN $6 THEN $3::timestamptz ELSE consumed_at END WHERE op_id = $1`, [op.id, op.status, now(), op.objectCount, op.errorCode, consumed]);
        const open = (await db.query(`SELECT op_id FROM meta_shopify_bulk WHERE consumed_at IS NULL ORDER BY started_at DESC LIMIT 1`))[0];
        let op = open ? await pollExport(deps.gql, String(open.op_id)) : null;
        if (open && !op)
            await db.query(`UPDATE meta_shopify_bulk SET status = 'MISSING', consumed_at = $2 WHERE op_id = $1`, [open.op_id, at]);
        if (!op) {
            op = await startOrdersExport(deps.gql);
            await db.query(`INSERT INTO meta_shopify_bulk (op_id, status, started_at) VALUES ($1, $2, $3) ON CONFLICT (op_id) DO NOTHING`, [op.id, op.status, at]);
        }
        if (!isDone(op.status))
            op = (await waitForExport(deps.gql, op.id, deps.waitMs, { sleep: deps.sleep })) ?? op;
        await mark(op, false);
        if (!isDone(op.status))
            return { status: 'warning', rows: 0, detail: RUNNING_DETAIL, code: 'export_running' };
        if (op.status !== 'COMPLETED') {
            await mark(op, true);
            throw new CliError(`Shopify's order export ended as ${op.status.toLowerCase()}${op.errorCode ? ` (${op.errorCode})` : ''}.`, 'Run lifecycle sync again to start a new export.', 'export_failed');
        }
        const cutoff = op.createdAt ? Date.parse(op.createdAt) : Infinity;
        const buf = new CompactOrders(cutoff);
        if (op.url) {
            try {
                await readExport(op.url, buf, deps.download);
            }
            catch (e) {
                // An expired file cannot be read again, so the next sync starts a new export. Any other failure keeps it.
                if (e instanceof CliError && e.code === 'export_expired')
                    await mark(op, true);
                throw e;
            }
        }
        if (buf.pulled !== op.objectCount) {
            throw new CliError(`The Shopify export file had ${buf.pulled} orders, and Shopify says it holds ${op.objectCount}.`, 'Run lifecycle sync again. It reads the same file again.', 'export_incomplete');
        }
        const rows = await writeShopifyTotals(db, buf.aggregate());
        // Orders keep arriving while Shopify builds the file, so both sides of the completeness check stop at the
        // moment the export started.
        await setTotal(db, 'shopify', 'orders_pulled', op.createdAt ? buf.pulledBefore : buf.pulled);
        const reported = deps.reportedCount ? await deps.reportedCount(op.createdAt) : null;
        if (reported === null)
            await db.query(`DELETE FROM meta_source_total WHERE source = 'shopify' AND metric = 'orders_reported'`);
        else
            await setTotal(db, 'shopify', 'orders_reported', reported);
        await mark(op, true);
        // Without read_all_orders Shopify hands over only the last 60 days, and every older customer looks new.
        const today = deps.today ?? at.slice(0, 10);
        const sixtyOneDaysAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 61 * 86400000).toISOString().slice(0, 10);
        if (buf.earliest !== null && buf.earliest >= sixtyOneDaysAgo) {
            return { status: 'warning', rows, detail: `The oldest order Shopify returned is from ${buf.earliest}. Without the read_all_orders scope Shopify hands over only the last 60 days, so if the store is older, add that scope, or older customers count as new.` };
        }
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
        if (subs)
            await setTotal(db, 'stripe', 'subscriptions_pulled', subs.length);
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
