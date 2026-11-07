import { randomUUID } from 'node:crypto';
import { aggregateOrders } from './sources/shopify.js';
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
        await db.query(`UPDATE meta_sync_run SET finished_at = $2, status = 'failed', detail = $3 WHERE run_id = $1`, [runId, now(), detail]);
        return { source, status: 'failed', rows: 0, detail };
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
        const start = opts.since ?? new Date(Date.now() - 90 * 86400000).toISOString();
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
