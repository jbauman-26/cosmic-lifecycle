import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';
import { settingValue } from './config.js';
import { aggregateOrders } from './sources/shopify.js';
import { CompactOrders, isDone, pollExport, readExport, startOrdersExport, waitForExport } from './sources/shopify-bulk.js';
import { applyChanges, changedSince, clearState, readSyncState, replaceState, StateBuffer, stateRow, writeSyncState } from './shopify-state.js';
import { toDaily } from './sources/meta.js';
import { toAdGroupDaily, toCampaignDaily } from './sources/google-ads.js';
import { countStatuses, toPerformanceDaily } from './sources/google-merchant-center.js';
import { toDaily as toMicrosoftDaily } from './sources/microsoft-ads.js';
import { toDaily as toLinkedinDaily } from './sources/linkedin-ads.js';
import { toRedditDaily } from './sources/reddit-ads.js';
import { localDate, toSnapDaily } from './sources/snapchat-ads.js';
import { toDaily as toTiktokDaily } from './sources/tiktok-ads.js';
import { clampSince as clampPinterestSince, toDaily as toPinterestDaily } from './sources/pinterest-ads.js';
import { aggregateCharges, aggregateSubscriptions } from './sources/stripe.js';
import { aggregateContacts, aggregateDeals, uniqueCount } from './sources/hubspot.js';
import { isNoReportData, reportsVerified } from './sources/klaviyo.js';
export async function exportProgress(db) {
    const r = (await db.query(`SELECT status, started_at, checked_at, consumed_at, objects, expected, error_code FROM meta_shopify_bulk ORDER BY started_at DESC LIMIT 1`).catch(() => []))[0];
    if (!r)
        return null;
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    const status = String(r.status);
    const state = status === 'COMPLETED' && r.consumed_at && !r.error_code ? 'done' : r.consumed_at ? 'failed' : 'running';
    return { state, startedAt: iso(r.started_at), checkedAt: iso(r.checked_at), ordersExported: Number(r.objects ?? 0), ordersExpected: r.expected === null || r.expected === undefined ? null : Number(r.expected), code: state === 'failed' ? (r.error_code ? String(r.error_code).toLowerCase() : status === 'MISSING' ? 'export_missing' : 'export_failed') : null };
}
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
// 0.20.0: remember which days a trailing sync pulled, so a period verdict can tell a day with no rows from a
// day that was never pulled. A window that touches the stored one extends it; one that does not replaces it,
// because the days between were never pulled. `replace` always replaces (a sync that deletes older rows).
export async function recordWindow(tx, source, metric, start, end, at, replace = false) {
    await tx.query(replace
        ? `INSERT INTO meta_source_window VALUES ($1, $2, $3, $4, $5) ON CONFLICT (source, metric) DO UPDATE SET window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end, recorded_at = EXCLUDED.recorded_at`
        : `INSERT INTO meta_source_window VALUES ($1, $2, $3, $4, $5) ON CONFLICT (source, metric) DO UPDATE SET
         window_start = CASE WHEN EXCLUDED.window_start <= meta_source_window.window_end + 1 AND EXCLUDED.window_end + 1 >= meta_source_window.window_start
           THEN LEAST(meta_source_window.window_start, EXCLUDED.window_start) ELSE EXCLUDED.window_start END,
         window_end = CASE WHEN EXCLUDED.window_start <= meta_source_window.window_end + 1 AND EXCLUDED.window_end + 1 >= meta_source_window.window_start
           THEN GREATEST(meta_source_window.window_end, EXCLUDED.window_end) ELSE EXCLUDED.window_end END,
         recorded_at = EXCLUDED.recorded_at`, [source, metric, start.slice(0, 10), end.slice(0, 10), at]);
}
// Recomputes from the full order history inside one transaction, so a re-run
// cannot double count and a failed run leaves yesterday's numbers in place.
export async function writeShopify(db, orders) {
    return writeShopifyTotals(db, aggregateOrders(orders));
}
export async function writeShopifyTotals(db, totals) {
    return db.transaction((tx) => writeTotalsTx(tx, totals, now()));
}
async function writeTotalsTx(tx, { daily, cohorts }, at) {
    await tx.query('DELETE FROM fact_orders_daily');
    await tx.query('DELETE FROM fact_cohort_monthly');
    for (const d of daily) {
        await tx.query(`INSERT INTO fact_orders_daily (date, orders, gross_revenue, net_revenue, discounts, new_orders, returning_orders, guest_orders, source_synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [d.date, d.orders, d.gross, d.net, d.discounts, d.newOrders, d.returningOrders, d.guestOrders, at]);
    }
    for (const c of cohorts) {
        await tx.query(`INSERT INTO fact_cohort_monthly (cohort_month, months_since, customers, orders, revenue, source_synced_at) VALUES ($1,$2,$3,$4,$5,$6)`, [c.cohortMonth, c.monthsSince, c.customers, c.orders, c.revenue, at]);
    }
    return daily.length + cohorts.length;
}
// Days whose stored totals differ from a full pull's, so the weekly check can say what the daily syncs missed
// (an order deleted in Shopify, for one, which a search by updated_at never returns).
async function driftDays(tx, daily) {
    const had = new Map((await tx.query(`SELECT date::text AS date, orders, net_revenue, new_orders, returning_orders, guest_orders FROM fact_orders_daily`)).map((r) => [String(r.date), r]));
    let n = 0;
    for (const d of daily) {
        const h = had.get(d.date);
        had.delete(d.date);
        if (!h || Number(h.orders) !== d.orders || Number(h.net_revenue) !== d.net || Number(h.new_orders) !== d.newOrders || Number(h.returning_orders) !== d.returningOrders || Number(h.guest_orders) !== d.guestOrders)
            n++;
    }
    return n + had.size;
}
// A full pull with a store key also replaces every order's state and moves the cursor, in the same transaction
// as the totals. Without a key the state is cleared, because it could no longer be kept in step.
async function writeFull(db, totals, state) {
    const at = now();
    let drift = null;
    const rows = await db.transaction(async (tx) => {
        if (state) {
            const prior = await readSyncState(tx);
            if (prior?.keyCheck === state.keyer.check && prior.lastFullAt)
                drift = await driftDays(tx, totals.daily);
        }
        const n = await writeTotalsTx(tx, totals, at);
        if (state) {
            await replaceState(tx, state.buf);
            await writeSyncState(tx, { cursor: state.cursor, keyCheck: state.keyer.check, full: { at, windowLimited: state.windowLimited } });
        }
        else {
            await clearState(tx);
        }
        return n;
    });
    return { rows, drift };
}
const sixtyOneDaysBefore = (today) => new Date(Date.parse(`${today}T00:00:00Z`) - 61 * 86400000).toISOString().slice(0, 10);
const driftNote = (drift) => (drift ? ` The weekly full check corrected ${drift} day${drift === 1 ? '' : 's'} the daily syncs had differently.` : '');
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
export async function syncShopify(db, loadOrders, reportedCount, opts = {}) {
    return recordRun(db, 'shopify', async () => {
        const started = now();
        const orders = await loadOrders();
        const totals = aggregateOrders(orders);
        let state = null;
        if (opts.keyer) {
            const buf = new StateBuffer(opts.keyer);
            let earliest = null;
            for (const o of orders) {
                buf.add(o);
                if (!o.cancelledAt && (earliest === null || o.processedAt.slice(0, 10) < earliest))
                    earliest = o.processedAt.slice(0, 10);
            }
            const today = opts.today ?? started.slice(0, 10);
            state = { buf, keyer: opts.keyer, cursor: started, windowLimited: earliest === null || earliest >= sixtyOneDaysBefore(today) };
        }
        const { rows, drift } = await writeFull(db, totals, state);
        await setTotal(db, 'shopify', 'orders_pulled', orders.length);
        await setTotal(db, 'shopify', 'orders_kept', orders.filter((o) => !o.cancelledAt).length);
        const reported = reportedCount ? await reportedCount() : null;
        if (reported === null)
            await db.query(`DELETE FROM meta_source_total WHERE source = 'shopify' AND metric = 'orders_reported'`);
        else
            await setTotal(db, 'shopify', 'orders_reported', reported);
        return { status: 'ok', rows, mode: 'full', ...(drift ? { detail: driftNote(drift).trim() } : {}) };
    });
}
// Only what changed since the last sync, from the cursor minus the overlap. The changed orders are upserted, and
// only the days and cohorts they touch are rebuilt. Everything in one transaction, so a failure changes nothing.
async function incremental(db, deps) {
    const state = await readSyncState(db);
    if (!state?.cursor || state.keyCheck !== deps.keyer.check)
        throw new CliError('The stored Shopify sync state was made with another key.', 'lifecycle sync --only shopify --full', 'state_mismatch');
    const orders = await deps.changed(changedSince(state.cursor, deps.overlapDays ?? 3));
    const rows = orders.map((o) => stateRow(o, deps.keyer));
    const at = now();
    const maxSeen = rows.reduce((m, r) => (r.updatedAt && (!m || Date.parse(r.updatedAt) > Date.parse(m)) ? new Date(r.updatedAt).toISOString() : m), null);
    const touched = await db.transaction(async (tx) => {
        const t = await applyChanges(tx, rows, at);
        if (maxSeen)
            await writeSyncState(tx, { cursor: maxSeen, keyCheck: deps.keyer.check });
        const pulled = await tx.query(`SELECT count(*)::int AS n FROM shopify_order_state`);
        await setTotal(tx, 'shopify', 'orders_pulled', Number(pulled[0].n));
        const kept = await tx.query(`SELECT count(*)::int AS n FROM shopify_order_state WHERE NOT cancelled`);
        await setTotal(tx, 'shopify', 'orders_kept', Number(kept[0].n));
        return t;
    });
    const reported = deps.reportedCount ? await deps.reportedCount() : null;
    if (reported === null)
        await db.query(`DELETE FROM meta_source_total WHERE source = 'shopify' AND metric = 'orders_reported'`);
    else
        await setTotal(db, 'shopify', 'orders_reported', reported);
    return { rows: touched.days + touched.cohorts, detail: `${touched.orders} changed order${touched.orders === 1 ? '' : 's'}; rebuilt ${touched.days} day${touched.days === 1 ? '' : 's'} and ${touched.cohorts} cohort month${touched.cohorts === 1 ? '' : 's'}.` };
}
export async function syncShopifyChanges(db, deps) {
    return recordRun(db, 'shopify', async () => ({ status: 'ok', mode: 'incremental', ...(await incremental(db, deps)) }));
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
            await db.query(`INSERT INTO meta_shopify_bulk (op_id, status, started_at, expected) VALUES ($1, $2, $3, $4) ON CONFLICT (op_id) DO NOTHING`, [op.id, op.status, at, deps.expected ?? null]);
        }
        else if (deps.expected != null) {
            await db.query(`UPDATE meta_shopify_bulk SET expected = coalesce(expected, $2) WHERE op_id = $1`, [op.id, deps.expected]);
        }
        if (!isDone(op.status))
            op = (await waitForExport(deps.gql, op.id, deps.waitMs, { sleep: deps.sleep })) ?? op;
        await mark(op, false);
        if (!isDone(op.status)) {
            if (deps.incremental) {
                const r = await incremental(db, deps.incremental);
                return { status: 'ok', mode: 'incremental', rows: r.rows, detail: `${r.detail} Shopify is still building this week's full check export; the next sync reads it.`, progress: (await exportProgress(db)) ?? undefined };
            }
            return { status: 'warning', rows: 0, detail: RUNNING_DETAIL, code: 'export_running', progress: (await exportProgress(db)) ?? undefined };
        }
        if (op.status !== 'COMPLETED') {
            await mark(op, true);
            throw new CliError(`Shopify's order export ended as ${op.status.toLowerCase()}${op.errorCode ? ` (${op.errorCode})` : ''}.`, 'Run lifecycle sync again to start a new export.', 'export_failed');
        }
        const cutoff = op.createdAt ? Date.parse(op.createdAt) : Infinity;
        const buf = new CompactOrders(cutoff, deps.keyer ? new StateBuffer(deps.keyer) : undefined);
        if (op.url) {
            try {
                await readExport(op.url, buf, deps.download);
            }
            catch (e) {
                // An expired file cannot be read again, so the next sync starts a new export. Any other failure keeps it.
                if (e instanceof CliError && e.code === 'export_expired')
                    await mark({ ...op, errorCode: 'FILE_EXPIRED' }, true);
                throw e;
            }
        }
        if (buf.pulled !== op.objectCount) {
            throw new CliError(`The Shopify export file had ${buf.pulled} orders, and Shopify says it holds ${op.objectCount}.`, 'Run lifecycle sync again. It reads the same file again.', 'export_incomplete');
        }
        // Without read_all_orders Shopify hands over only the last 60 days, and every older customer looks new.
        const today = deps.today ?? at.slice(0, 10);
        const limited = buf.earliest !== null && buf.earliest >= sixtyOneDaysBefore(today);
        // The cursor is the moment the export started: anything changed after it is asked for again by the next sync.
        const { rows, drift } = await writeFull(db, buf.aggregate(), deps.keyer && buf.state ? { buf: buf.state, keyer: deps.keyer, cursor: op.createdAt ?? at, windowLimited: limited || buf.earliest === null } : null);
        // Orders keep arriving while Shopify builds the file, so both sides of the completeness check stop at the
        // moment the export started.
        await setTotal(db, 'shopify', 'orders_pulled', op.createdAt ? buf.pulledBefore : buf.pulled);
        // Every order in the file that was not cancelled lands in a day, whatever the cutoff.
        await setTotal(db, 'shopify', 'orders_kept', buf.pulled - buf.cancelled);
        const reported = deps.reportedCount ? await deps.reportedCount(op.createdAt) : null;
        if (reported === null)
            await db.query(`DELETE FROM meta_source_total WHERE source = 'shopify' AND metric = 'orders_reported'`);
        else
            await setTotal(db, 'shopify', 'orders_reported', reported);
        await mark(op, true);
        if (limited) {
            return { status: 'warning', rows, mode: 'full', detail: `The oldest order Shopify returned is from ${buf.earliest}. Without the read_all_orders scope Shopify hands over only the last 60 days, so if the store is older, add that scope, or older customers count as new.${driftNote(drift)}` };
        }
        return { status: 'ok', rows, mode: 'full', ...(drift ? { detail: driftNote(drift).trim() } : {}) };
    });
}
export async function syncGa4(db, load, window) {
    return recordRun(db, 'ga4', async () => {
        const rows = await load();
        const at = now();
        await db.transaction(async (tx) => {
            if (window)
                await recordWindow(tx, 'ga4', 'daily', window.start, window.end, at);
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
                // The account's answer for these days replaces whatever was stored for them, so rows from
                // another account (a copied warehouse, a reconnect) never mix with this one's.
                await tx.query(`DELETE FROM fact_klaviyo_orders_daily WHERE date >= $1 AND date <= $2`, [start.slice(0, 10), end.slice(0, 10)]);
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
        if (!metricId) {
            // This account has no orders at all, so any stored ones came from somewhere else.
            await db.transaction(async (tx) => {
                await tx.query(`DELETE FROM fact_klaviyo_orders_daily`);
                await tx.query(`DELETE FROM meta_source_window WHERE source = 'klaviyo' AND metric = 'placed_orders'`);
            });
            return { status: 'warning', rows: base, detail: 'No Placed Order metric in Klaviyo, so flow revenue was skipped.' };
        }
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
export async function syncStripe(db, load, opts = {}) {
    return recordRun(db, 'stripe', async () => {
        const charges = await load.charges();
        const subs = await load.subscriptions();
        const { rows, unpriced } = await writeStripe(db, charges, subs);
        await setTotal(db, 'stripe', 'charges_pulled', charges.length);
        // 0.14.0: what the daily rows must add up to, and how many subscriptions are open right now,
        // so the trust gate can check Stripe's daily tables against the pull itself.
        await setTotal(db, 'stripe', 'charges_counted', charges.filter((c) => (c.status === 'succeeded' && c.captured !== false) || c.status === 'failed').length);
        if (subs)
            await setTotal(db, 'stripe', 'subscriptions_pulled', subs.length);
        if (subs)
            await setTotal(db, 'stripe', 'subscriptions_open', subs.filter((x) => x.status !== 'incomplete_expired' && !x.ended_at).length);
        // 0.20.1: whether this sync read subscriptions, so an as-of MRR never rests on an older pull.
        await setTotal(db, 'stripe', 'subscriptions_read', subs ? 1 : 0);
        const notes = [
            subs ? null : opts.via ? `${opts.via} Subscriptions are not read in pipeline mode yet, so MRR and churn are skipped.` : 'This key cannot read subscriptions, so MRR and churn were skipped.',
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
        // writeMeta deletes rows from another account, so the window is replaced, never extended.
        await recordWindow(db, 'meta', 'daily', since, until, now(), true);
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
const windowStart = (until, days) => new Date(Date.parse(`${until}T00:00:00Z`) - (days ?? settingValue('metrics.default_days')) * 86400000).toISOString().slice(0, 10);
async function writeAdDaily(db, table, rows, since, account, currency) {
    const at = now();
    await db.transaction(async (tx) => {
        await tx.query(`DELETE FROM ${table} WHERE date >= $1 OR account_id <> $2`, [since, account]);
        for (const d of rows) {
            await tx.query(`INSERT INTO ${table} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (date, account_id, campaign_id) DO NOTHING`, [d.date, account, d.campaignId, d.campaignName, d.spend, d.impressions, d.clicks, d.conversions, d.conversionValue, d.currency || currency, at]);
        }
    });
    return rows.length;
}
export async function writeMicrosoftAds(db, raw, since, currency, account) {
    return writeAdDaily(db, 'fact_microsoft_ads_daily', toMicrosoftDaily(raw, account, currency), since, account, currency);
}
export async function syncMicrosoftAds(db, load, opts) {
    return recordRun(db, 'microsoft-ads', async () => {
        const until = opts.today ?? now().slice(0, 10);
        const since = windowStart(until, opts.days ?? settingValue('metrics.default_days'));
        const raw = await load(since, until);
        const rows = await writeMicrosoftAds(db, raw, since, opts.currency ?? '', opts.account);
        await setTotal(db, 'microsoft-ads', 'rows_pulled', raw.length);
        return rows ? { status: 'ok', rows } : { status: 'warning', rows, detail: `Microsoft Advertising returned no campaign activity from ${since} to ${until}.` };
    });
}
export async function writeLinkedinAds(db, raw, names, since, currency, account) {
    return writeAdDaily(db, 'fact_linkedin_ads_daily', toLinkedinDaily(raw, names), since, account, currency);
}
export async function syncLinkedinAds(db, load, opts) {
    return recordRun(db, 'linkedin-ads', async () => {
        const until = opts.today ?? now().slice(0, 10);
        const since = windowStart(until, opts.days ?? settingValue('metrics.default_days'));
        const raw = await load.analytics(since, until);
        const names = raw.length ? await load.campaignNames() : new Map();
        const rows = await writeLinkedinAds(db, raw, names, since, opts.currency ?? '', opts.account);
        await setTotal(db, 'linkedin-ads', 'rows_pulled', raw.length);
        if (rows)
            return { status: 'ok', rows };
        // LinkedIn serves no ads, and so reports nothing, for a test ad account.
        return { status: 'warning', rows, detail: opts.test ? 'This is a LinkedIn test ad account. LinkedIn reports no numbers for test accounts.' : `LinkedIn returned no campaign activity from ${since} to ${until}.` };
    });
}
// Merchant Center restates recent days too, so every sync replaces the whole performance window in one
// transaction, like Google Ads. The product counts are a snapshot: one row for the day of the sync, replaced if
// the same day syncs again, and earlier days kept. Rows from any other account are removed from both tables.
export async function writeMerchantCenter(db, data, since, today, account) {
    const daily = toPerformanceDaily(data.performance);
    const counts = countStatuses(data.products);
    const at = now();
    await db.transaction(async (tx) => {
        await tx.query(`DELETE FROM fact_merchant_performance_daily WHERE date >= $1 OR account_id <> $2`, [since, account]);
        await tx.query(`DELETE FROM fact_merchant_products_daily WHERE date = $1 OR account_id <> $2`, [today, account]);
        for (const d of daily) {
            await tx.query(`INSERT INTO fact_merchant_performance_daily VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (date, account_id, marketing_method) DO NOTHING`, [d.date, account, d.marketingMethod, d.clicks, d.impressions, d.conversions, d.conversionValue, d.currency, at]);
        }
        await tx.query(`INSERT INTO fact_merchant_products_daily VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [today, account, counts.products, counts.eligible, counts.eligibleLimited, counts.pending, counts.disapproved, at]);
    });
    return { performanceRows: daily.length, counts };
}
export async function syncMerchantCenter(db, load, opts) {
    return recordRun(db, 'google-merchant-center', async () => {
        const until = opts.today ?? now().slice(0, 10);
        const since = new Date(Date.parse(`${until}T00:00:00Z`) - (opts.days ?? settingValue('metrics.default_days')) * 86400000).toISOString().slice(0, 10);
        const performance = await load.performance(since, until);
        const products = await load.products();
        const { performanceRows, counts } = await writeMerchantCenter(db, { performance, products }, since, until, opts.account);
        await setTotal(db, 'google-merchant-center', 'rows_pulled', performance.length);
        await setTotal(db, 'google-merchant-center', 'products', counts.products);
        const rows = performanceRows + 1;
        if (!counts.products)
            return { status: 'warning', rows, detail: 'Merchant Center lists no products for this account.' };
        if (!performanceRows)
            return { status: 'warning', rows, detail: `Merchant Center reported no clicks or impressions from ${since} to ${until}.` };
        return { status: 'ok', rows };
    });
}
// Reddit Ads, Snapchat Ads, TikTok Ads and Pinterest Ads restate recent days as late conversions arrive, like Google,
// so every sync replaces the whole window in one transaction and older days keep what the last sync that covered them
// saw. Rows from any other ad account are removed, so switching accounts never mixes two accounts' history. Reddit and
// Snapchat days follow the account's time zone.
export async function writeAdsDaily(db, table, rows, since, currency, account) {
    const at = now();
    await db.transaction(async (tx) => {
        await tx.query(`DELETE FROM ${table} WHERE date >= $1 OR account_id <> $2`, [since, account]);
        for (const d of rows) {
            await tx.query(`INSERT INTO ${table} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (date, account_id, campaign_id) DO NOTHING`, [d.date, account, d.campaignId, d.campaignName, d.spend, d.impressions, d.clicks, d.conversions, d.conversionValue, currency, at]);
        }
    });
    return rows.length;
}
function adsWindow(opts) {
    const until = opts.today ?? localDate(Date.now(), opts.timezone ?? '');
    const since = new Date(Date.parse(`${until}T00:00:00Z`) - (opts.days ?? settingValue('metrics.default_days')) * 86400000).toISOString().slice(0, 10);
    return { since, until };
}
export async function syncRedditAds(db, load, opts) {
    return recordRun(db, 'reddit-ads', async () => {
        const { since, until } = adsWindow(opts);
        const raw = await load.report(since, until);
        const names = await load.names();
        const rows = await writeAdsDaily(db, 'fact_reddit_ads_daily', toRedditDaily(raw, names, since, until), since, opts.currency ?? '', opts.account);
        await setTotal(db, 'reddit-ads', 'rows_pulled', raw.length);
        return rows ? { status: 'ok', rows } : { status: 'warning', rows, detail: `Reddit Ads returned no campaign activity from ${since} to ${until}.` };
    });
}
export async function syncSnapchatAds(db, load, opts) {
    return recordRun(db, 'snapchat-ads', async () => {
        const { since, until } = adsWindow(opts);
        const raw = await load.stats(since, until);
        const names = await load.names();
        const daily = toSnapDaily(raw, names, opts.timezone ?? '', since, until);
        const rows = await writeAdsDaily(db, 'fact_snapchat_ads_daily', daily, since, opts.currency ?? '', opts.account);
        await setTotal(db, 'snapchat-ads', 'rows_pulled', daily.length);
        return rows ? { status: 'ok', rows } : { status: 'warning', rows, detail: `Snapchat Ads returned no campaign activity from ${since} to ${until}.` };
    });
}
export async function writeTiktokAds(db, raw, since, currency, account) {
    return writeAdsDaily(db, 'fact_tiktok_ads_daily', toTiktokDaily(raw), since, currency, account);
}
export async function syncTiktokAds(db, load, opts) {
    return recordRun(db, 'tiktok-ads', async () => {
        const until = opts.today ?? now().slice(0, 10);
        const since = windowStart(until, opts.days);
        const raw = await load(since, until);
        const rows = await writeTiktokAds(db, raw, since, opts.currency ?? '', opts.account);
        await setTotal(db, 'tiktok-ads', 'rows_pulled', raw.length);
        return rows ? { status: 'ok', rows } : { status: 'warning', rows, detail: `TikTok returned no campaign activity from ${since} to ${until}.` };
    });
}
export async function writePinterestAds(db, data, since, currency, account) {
    return writeAdsDaily(db, 'fact_pinterest_ads_daily', toPinterestDaily(data.rows, data.names), since, currency, account);
}
// Pinterest's daily report reaches only 90 days back, so the window never starts earlier than that.
export async function syncPinterestAds(db, load, opts) {
    return recordRun(db, 'pinterest-ads', async () => {
        const until = opts.today ?? now().slice(0, 10);
        const since = clampPinterestSince(windowStart(until, opts.days), until);
        const data = await load(since, until);
        const rows = await writePinterestAds(db, data, since, opts.currency ?? '', opts.account);
        await setTotal(db, 'pinterest-ads', 'rows_pulled', data.rows.length);
        return rows ? { status: 'ok', rows } : { status: 'warning', rows, detail: `Pinterest returned no campaign activity from ${since} to ${until}.` };
    });
}
