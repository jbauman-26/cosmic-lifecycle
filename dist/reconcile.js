import { readRawConfig, settingValue } from './config.js';
import { readWorkspace, REFERENCE_NAME } from './workspace.js';
import { readCosts } from './costs.js';
// The defaults. Each one can be changed with lifecycle config set, see tolerances().
export const TOLERANCE = { klaviyoOrders: 3, ga4Purchases: 15, attributedShareFlag: 60, freshnessDays: 2, minDifference: 3 };
// Read on its own, not in tolerances(), so a store's tolerances read exactly as in 0.13.
const adClaimFlag = (t) => t.adClaimFlag ?? settingValue('reconcile.ad_claim_flag');
export function tolerances() {
    return {
        klaviyoOrders: settingValue('reconcile.tolerance.klaviyo_orders'),
        ga4Purchases: settingValue('reconcile.tolerance.ga4_purchases'),
        attributedShareFlag: settingValue('reconcile.attributed_share_flag'),
        freshnessDays: settingValue('reconcile.freshness_days'),
        minDifference: settingValue('reconcile.min_difference'),
        days: settingValue('metrics.default_days'),
        connected: connectedNow(),
    };
}
// The native sources config.json says are connected now. Unreadable config: unknown, so no gating.
export function connectedNow() {
    try {
        const raw = readRawConfig();
        if (!raw || typeof raw !== 'object' || !('database' in raw))
            return undefined;
        // A host that hands keys per command (Cosmic Cloud) names the store's connected sources here, so a
        // read that carries no source blocks still checks against what is connected.
        if (Array.isArray(raw.connected))
            return raw.connected.filter((s) => typeof s === 'string');
        return ['shopify', 'klaviyo', 'ga4', 'stripe', 'meta', 'google-ads', 'hubspot'].filter((s) => raw[s] !== undefined && raw[s] !== null);
    }
    catch {
        return undefined;
    }
}
const SOURCE_NAME = { shopify: 'Shopify', klaviyo: 'Klaviyo', ga4: 'GA4', stripe: 'Stripe', meta: 'Meta', 'google-ads': 'Google Ads', hubspot: 'HubSpot' };
/**
 * Whether a two-source check may run now. It may not when a source is not connected, has never
 * finished a sync since it was last connected, or is syncing right now. The reason is the skip detail,
 * worded so the app can tell "not checked yet" from "failed".
 */
async function ready(db, t, sources) {
    for (const s of sources) {
        if (t.connected && !t.connected.includes(s))
            return { ok: false, why: `${SOURCE_NAME[s] ?? s} is not connected.` };
        const last = await one(db, `SELECT status FROM meta_sync_run WHERE source = $1 ORDER BY started_at DESC LIMIT 1`, [s]);
        if (last.status === 'running')
            return { ok: false, why: `${SOURCE_NAME[s] ?? s} is still syncing.` };
        const done = await one(db, `SELECT 1 AS y FROM meta_sync_run r WHERE source = $1 AND status NOT IN ('failed', 'disconnected', 'running')
      AND started_at > coalesce((SELECT max(started_at) FROM meta_sync_run d WHERE d.source = $1 AND d.status = 'disconnected'), '-infinity'::timestamptz) LIMIT 1`, [s]);
        if (!done.y)
            return { ok: false, why: `${SOURCE_NAME[s] ?? s} has not finished a sync since it was connected.` };
    }
    return { ok: true };
}
/** Rows a source wrote before its last disconnect belong to an account that is gone, so they never count. */
async function rowsSince(db, source) {
    const d = await one(db, `SELECT max(started_at) AS at FROM meta_sync_run WHERE source = $1 AND status = 'disconnected'`, [source]);
    return d.at ? new Date(d.at).toISOString() : '1970-01-01T00:00:00.000Z';
}
/**
 * Like compare, for two order counts. A gap of minDifference orders or fewer passes whatever the
 * percent, so a store with a handful of orders does not fail on one late event.
 */
export function compareCounts(name, expected, actual, tolerancePct, minDifference, label) {
    const c = compare(name, expected, actual, tolerancePct, label);
    if (c.status === 'fail' && Math.abs(expected - actual) <= minDifference) {
        return { ...c, status: 'pass', detail: `${label}: ${actual} against ${expected}, within ${minDifference} order${minDifference === 1 ? '' : 's'}.` };
    }
    return c;
}
const pct = (expected, actual) => (expected === 0 ? (actual === 0 ? 0 : 100) : (Math.abs(expected - actual) / expected) * 100);
const round = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
export function compare(name, expected, actual, tolerancePct, label) {
    const diffPct = round(pct(expected, actual));
    const status = diffPct <= tolerancePct ? 'pass' : 'fail';
    const detail = status === 'pass'
        ? `${label}: ${actual} against ${expected}, within ${tolerancePct}%.`
        : `${label}: ${actual} against ${expected}, off by ${diffPct}%. Do not trust reports built on this until it is fixed.`;
    return { name, status, expected, actual, diffPct, detail };
}
const skip = (name, detail) => ({ name, status: 'skipped', expected: null, actual: null, diffPct: null, detail });
const one = async (db, sql, params = []) => (await db.query(sql, params))[0] ?? {};
// A source whose latest entry is a disconnect is left out, so removing a source never turns
// into a stale warning two days later. Shared by every workspace type.
// A source whose latest entry is a disconnect is left out, so removing a source never turns into a stale
// warning two days later. A Shopify run that only waited on an order export brought nothing new, so it does not count as fresh.
async function freshness(db, t) {
    const last = await db.query(`SELECT source, max(finished_at) AS at FROM meta_sync_run r WHERE status NOT IN ('failed', 'disconnected', 'running') AND coalesce(code, '') <> 'export_running'
       AND NOT EXISTS (SELECT 1 FROM meta_sync_run d WHERE d.source = r.source AND d.status = 'disconnected'
         AND d.started_at >= (SELECT max(x.started_at) FROM meta_sync_run x WHERE x.source = r.source))
     GROUP BY source`);
    if (!last.length)
        return skip('freshness', 'Nothing has synced yet.');
    const ages = last.map((r) => ({ source: String(r.source), days: (Date.now() - new Date(r.at).getTime()) / 86400000 }));
    const stale = ages.filter((a) => a.days > t.freshnessDays);
    return {
        name: 'freshness', status: stale.length ? 'fail' : 'pass', expected: t.freshnessDays, actual: round(Math.max(...ages.map((a) => a.days))), diffPct: null,
        detail: stale.length ? `Stale: ${stale.map((s) => s.source).join(', ')}.` : `All connected sources synced within ${t.freshnessDays} day${t.freshnessDays === 1 ? '' : 's'}.`,
    };
}
export async function runChecks(db, t = tolerances()) {
    const checks = [];
    const days = t.days;
    const today = t.today ?? new Date().toISOString().slice(0, 10);
    const dayOf = (offset) => new Date(Date.parse(today + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
    const sinceDay = dayOf(-days);
    const lastDay = dayOf(-1);
    // 1. Did the pull get everything Shopify says exists? This is the check that
    // would have caught a silent gap in a page table like the one we once measured.
    const totals = await db.query(`SELECT metric, value FROM meta_source_total WHERE source = 'shopify'`);
    const total = totals.find((t) => t.metric === 'orders_reported');
    const pulled = totals.find((t) => t.metric === 'orders_pulled');
    checks.push(total && pulled ? compare('orders_complete', num(total.value), num(pulled.value), 0, 'Orders pulled against Shopify’s own count') : skip('orders_complete', 'Shopify has not been synced, or gave no exact count.'));
    // 2. Do the two tables built from those orders agree with each other?
    const d = await one(db, `SELECT sum(new_orders + returning_orders) AS orders, sum(net_revenue) AS net, sum(guest_orders) AS guest FROM fact_orders_daily`);
    const c = await one(db, `SELECT sum(orders) AS orders FROM fact_cohort_monthly`);
    checks.push(d.orders === null || d.orders === undefined
        ? skip('orders_vs_cohorts', 'No Shopify orders stored.')
        : compare('orders_vs_cohorts', num(d.orders), num(c.orders), 0, 'Customer orders in daily totals against cohorts'));
    // 3. Is Klaviyo seeing the same orders as Shopify?
    // Both count by UTC day (Shopify's processedAt, Klaviyo's report timezone), so the days line up.
    // Only complete days count: today is still filling in, and Klaviyo events arrive minutes late.
    const so = await one(db, `SELECT sum(orders) AS orders, sum(net_revenue) AS net FROM fact_orders_daily WHERE date >= $1 AND date <= $2`, [sinceDay, lastDay]);
    const kReady = await ready(db, t, ['shopify', 'klaviyo']);
    if (!kReady.ok)
        checks.push(skip('klaviyo_orders', `Not checked yet: ${kReady.why}`));
    else {
        // Compare only the days Klaviyo was actually pulled for. Otherwise a partial
        // sync reads as missing orders, and the check cries wolf.
        const kw = await one(db, `SELECT window_start::text AS s, window_end::text AS e FROM meta_source_window WHERE source = 'klaviyo' AND metric = 'placed_orders'`);
        const kFrom = kw.s && String(kw.s).slice(0, 10) > sinceDay ? String(kw.s).slice(0, 10) : sinceDay;
        const kTo = kw.e && String(kw.e).slice(0, 10) < lastDay ? String(kw.e).slice(0, 10) : lastDay;
        const period = kFrom === sinceDay && kTo === lastDay ? `the last ${days} complete days` : `${kFrom} to ${kTo}, the complete days Klaviyo was synced for`;
        const kSince = await rowsSince(db, 'klaviyo');
        const sk = await one(db, `SELECT sum(orders) AS orders FROM fact_orders_daily WHERE date >= $1 AND date <= $2`, [kFrom, kTo]);
        const ko = await one(db, `SELECT sum(placed_orders) AS orders FROM fact_klaviyo_orders_daily WHERE date >= $1 AND date <= $2 AND source_synced_at >= $3`, [kFrom, kTo, kSince]);
        if (!kw.e)
            checks.push(skip('klaviyo_orders', 'Not checked yet: Klaviyo has no Placed Order data. Its Shopify integration may be off.'));
        else if (kFrom > kTo)
            checks.push(skip('klaviyo_orders', 'Not checked yet: Klaviyo has no complete day synced.'));
        else if (!num(sk.orders) && !num(ko.orders))
            checks.push(skip('klaviyo_orders', `Neither source has orders in ${period}.`));
        else if (num(ko.orders) === 0 && num(sk.orders) <= t.minDifference)
            checks.push(skip('klaviyo_orders', `Too few orders to compare yet: Shopify has ${num(sk.orders)} in ${period}.`));
        else if (num(ko.orders) === 0) {
            checks.push({ name: 'klaviyo_orders', status: 'fail', expected: num(sk.orders), actual: 0, diffPct: 100, detail: `Shopify has ${num(sk.orders)} orders in ${period}, and Klaviyo has none. The store may not be connected to this Klaviyo account.` });
        }
        else
            checks.push(compareCounts('klaviyo_orders', num(sk.orders), num(ko.orders), t.klaviyoOrders, t.minDifference, `Klaviyo Placed Order against Shopify orders, ${period}`));
    }
    // 4. Is GA4 seeing the same purchases? GA4 counts by its property's day, Shopify by UTC day.
    // Over complete days the edges move a few hours of orders at most, which the tolerance covers.
    const gReady = await ready(db, t, ['shopify', 'ga4']);
    if (!gReady.ok)
        checks.push(skip('ga4_purchases', `Not checked yet: ${gReady.why}`));
    else {
        const ga = await one(db, `SELECT sum(purchases) AS purchases FROM fact_ga4_daily WHERE date >= $1 AND date <= $2 AND source_synced_at >= $3`, [sinceDay, lastDay, await rowsSince(db, 'ga4')]);
        checks.push(ga.purchases === null || ga.purchases === undefined || so.orders === null || so.orders === undefined
            ? skip('ga4_purchases', 'Not checked yet: GA4 or Shopify has no complete day synced.')
            : compareCounts('ga4_purchases', num(so.orders), num(ga.purchases), t.ga4Purchases, t.minDifference, `GA4 purchases against Shopify orders, the last ${days} complete days`));
    }
    // 5. Does the attributed revenue look believable?
    const fl = kReady.ok ? await one(db, `SELECT sum(revenue) AS revenue FROM fact_flow_daily WHERE date >= $1 AND date <= $2 AND source_synced_at >= $3`, [sinceDay, lastDay, await rowsSince(db, 'klaviyo')]) : {};
    if (!kReady.ok)
        checks.push(skip('attributed_share', `Not checked yet: ${kReady.why}`));
    else if (fl.revenue === null || fl.revenue === undefined || !num(so.net))
        checks.push(skip('attributed_share', 'Needs Klaviyo flow revenue and Shopify revenue.'));
    else {
        const share = round((num(fl.revenue) / num(so.net)) * 100);
        checks.push({
            name: 'attributed_share', status: share > t.attributedShareFlag ? 'warn' : 'pass', expected: num(so.net), actual: num(fl.revenue), diffPct: share,
            detail: `Klaviyo attributes ${share}% of Shopify net revenue to flows. This is Klaviyo's attribution, not proof of causation.`,
        });
    }
    // 6. Do the daily flow rows add up to Klaviyo's own totals?
    const w = kReady.ok ? await one(db, `SELECT min(window_start) AS s, max(window_end) AS e, sum(recipients) AS recipients FROM fact_flow_window WHERE source_synced_at >= $1`, [await rowsSince(db, 'klaviyo')]) : {};
    if (!kReady.ok)
        checks.push(skip('flow_totals', `Not checked yet: ${kReady.why}`));
    else if (w.recipients === null || w.recipients === undefined)
        checks.push(skip('flow_totals', 'No flow totals from Klaviyo yet.'));
    else {
        const f = await one(db, `SELECT sum(recipients) AS recipients FROM fact_flow_daily WHERE date >= $1 AND date <= $2`, [w.s, w.e]);
        checks.push(compare('flow_totals', num(w.recipients), num(f.recipients), 0.5, 'Daily flow recipients against Klaviyo’s flow totals'));
    }
    // 7. Is anything stale?
    checks.push(await freshness(db, t));
    return checks;
}
export async function reconcile(db, t = tolerances(), ws = readWorkspace()) {
    const checks = ws.type === 'shopify' && ws.reference === 'shopify' ? await runChecks(db, t) : await runReferenceChecks(db, t, ws);
    // Only a store that synced its costs gets this one, after the others, so a store without costs reads as in 0.13.
    const cost = await costCheck(db);
    if (cost)
        checks.push(cost);
    const at = new Date().toISOString();
    await db.transaction(async (tx) => {
        // A check this workspace no longer runs (the type or the reference changed) would otherwise
        // keep its old result and colour the trust line forever.
        await tx.query(`DELETE FROM meta_reconcile_result WHERE NOT (check_name = ANY($1))`, [checks.map((c) => c.name)]);
        for (const c of checks) {
            await tx.query(`INSERT INTO meta_reconcile_result VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (check_name) DO UPDATE SET status = EXCLUDED.status, expected = EXCLUDED.expected, actual = EXCLUDED.actual, diff_pct = EXCLUDED.diff_pct, detail = EXCLUDED.detail, checked_at = EXCLUDED.checked_at`, [c.name, c.status, c.expected, c.actual, c.diffPct, c.detail, at]);
        }
    });
    return { passed: !checks.some((c) => c.status === 'fail'), checks };
}
// Every report calls this, so a number can never appear without its status.
// A Shopify workspace never writes a `reference` row, so its line reads exactly as before 0.14.0.
// Every other workspace writes one, and its line names the source the numbers were checked against,
// or says plainly that there was none: status `unreferenced`, never a failure.
export async function trustLine(db) {
    const rows = await db.query(`SELECT check_name, status, detail FROM meta_reconcile_result`);
    if (!rows.length)
        return { status: 'unchecked', line: 'Numbers not checked yet. Run lifecycle reconcile.' };
    const failed = rows.filter((r) => r.status === 'fail').map((r) => String(r.check_name));
    if (failed.length)
        return { status: 'failed', line: `DO NOT TRUST THESE NUMBERS YET. Failed checks: ${failed.join(', ')}.` };
    const ref = rows.find((r) => r.check_name === REFERENCE_CHECK);
    const others = rows.filter((r) => r.check_name !== REFERENCE_CHECK);
    const skipped = others.filter((r) => r.status === 'skipped').length;
    if (!ref)
        return { status: 'passed', line: `Numbers passed reconciliation${skipped ? `, with ${skipped} checks skipped` : ''}.` };
    if (ref.status !== 'pass')
        return { status: 'unreferenced', line: String(ref.detail) };
    return { status: 'passed', line: `${String(ref.detail)}${skipped ? ` ${skipped} check${skipped === 1 ? ' was' : 's were'} skipped.` : ''}` };
}
// The row that names what a workspace's numbers were checked against.
export const REFERENCE_CHECK = 'reference';
const synced = async (db, source) => (await db.query(`SELECT 1 FROM meta_sync_run WHERE source = $1 AND status IN ('ok', 'warning') LIMIT 1`, [source])).length > 0;
const total = async (db, source, metric) => {
    const r = (await db.query(`SELECT value FROM meta_source_total WHERE source = $1 AND metric = $2`, [source, metric]))[0];
    return r ? num(r.value) : null;
};
// Checks for every workspace that is not a Shopify store checked against Shopify. Each one compares
// a number against the workspace's reference source, or the reference against its own count.
export async function runReferenceChecks(db, t, ws) {
    const checks = [];
    const days = t.days;
    const today = t.today ?? new Date().toISOString().slice(0, 10);
    const dayOf = (offset) => new Date(Date.parse(today + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
    const sinceDay = dayOf(-days);
    const lastDay = dayOf(-1);
    const since = sinceDay;
    const name = REFERENCE_NAME[ws.reference];
    const has = ws.reference === 'none' ? false : await synced(db, ws.reference);
    // The reference itself: is there one, and has it synced?
    if (ws.reference === 'none') {
        checks.push({ name: REFERENCE_CHECK, status: 'skipped', expected: null, actual: null, diffPct: null, detail: 'Not checked against a source of truth: this workspace has no reference source set, so each number is its own tool\'s count. Set one with lifecycle config set workspace.reference stripe, hubspot, shopify or ga4.' });
    }
    else if (!has) {
        checks.push({ name: REFERENCE_CHECK, status: 'skipped', expected: null, actual: null, diffPct: null, detail: `Not checked against a source of truth yet: ${name} is this workspace's reference and has not synced. Each number is its own tool's count until it does. Connect ${ws.reference}, then lifecycle sync.` });
    }
    else if (ws.reference === 'ga4') {
        checks.push({ name: REFERENCE_CHECK, status: 'warn', expected: null, actual: null, diffPct: null, detail: 'Checked against GA4 only. GA4 is a tracking tool, not a record of sales or pipeline, so treat these numbers as estimates.' });
    }
    else {
        checks.push({ name: REFERENCE_CHECK, status: 'pass', expected: null, actual: null, diffPct: null, detail: `Numbers passed reconciliation against ${name}.` });
    }
    if (ws.reference === 'shopify') {
        // A non-store workspace that still keeps its truth in Shopify (an agency client, say) gets the store checks.
        for (const c of await runChecks(db, t))
            if (c.name !== 'freshness')
                checks.push(c);
    }
    if (ws.reference === 'stripe' && has) {
        // Do Stripe's daily rows add up to every charge the pull saw?
        const counted = await total(db, 'stripe', 'charges_counted');
        const d = await one(db, `SELECT sum(charges + failed_charges) AS n FROM fact_stripe_daily`);
        checks.push(counted === null ? skip('stripe_daily_complete', 'Synced before 0.14.0. The next lifecycle sync records the count this check needs.') : compare('stripe_daily_complete', counted, num(d.n), 0, 'Charges in the daily table against every charge pulled from Stripe'));
        // Do subscription starts minus ends match what is open in Stripe right now? Churn is built on these.
        const open = await total(db, 'stripe', 'subscriptions_open');
        const se = await one(db, `SELECT sum(started) AS started, sum(ended) AS ended FROM fact_stripe_subscriptions_daily`);
        if (open === null || se.started === null || se.started === undefined)
            checks.push(skip('subscriptions_balance', 'No subscriptions synced, or the key cannot read them.'));
        else
            checks.push(compare('subscriptions_balance', open, num(se.started) - num(se.ended), 0, 'Subscriptions started minus ended against subscriptions open in Stripe'));
        // Does GA4 see the payments? Only where GA4 records purchases at all.
        const ga = await one(db, `SELECT sum(purchases) AS purchases FROM fact_ga4_daily WHERE date >= $1`, [since]);
        const sc = await one(db, `SELECT sum(charges) AS charges FROM fact_stripe_daily WHERE date >= $1`, [since]);
        if (ga.purchases === null || ga.purchases === undefined)
            checks.push(skip('ga4_vs_reference', 'Needs GA4 synced.'));
        else if (!num(ga.purchases))
            checks.push(skip('ga4_vs_reference', 'GA4 records no purchase events, so there is nothing to compare with Stripe.'));
        else
            checks.push(compare('ga4_vs_reference', num(sc.charges), num(ga.purchases), t.ga4Purchases, `GA4 purchases against Stripe successful charges, last ${days} days`));
    }
    if (ws.reference === 'hubspot' && has) {
        for (const object of ['deals', 'contacts']) {
            const reported = await total(db, 'hubspot', `${object}_reported`);
            const pulled = await total(db, 'hubspot', `${object}_pulled`);
            checks.push(reported === null || pulled === null ? skip(`${object}_complete`, `HubSpot gave no count of its ${object}.`) : compare(`${object}_complete`, reported, pulled, 0, `${object === 'deals' ? 'Deals' : 'Contacts'} pulled against HubSpot's own count`));
        }
        const pulled = await total(db, 'hubspot', 'deals_pulled');
        const d = await one(db, `SELECT sum(deals_created) AS n FROM fact_crm_deals_daily`);
        // A deal with no create date is counted as pulled but has no day, so allow a sliver.
        checks.push(pulled === null ? skip('deals_daily_vs_pulled', 'No HubSpot deals synced.') : compare('deals_daily_vs_pulled', pulled, num(d.n), 0.5, 'Deals in the daily table against deals pulled'));
    }
    // Do the ad platforms claim more than the reference recorded? A claim is never a failure:
    // Meta counts its own attribution window and view-throughs. A large gap is worth a look.
    const meta = await one(db, `SELECT sum(purchases) AS purchases, min(date)::text AS first FROM fact_meta_ads_daily WHERE date >= $1`, [since]);
    if (meta.purchases === null || meta.purchases === undefined)
        checks.push(skip('ad_claims', 'Needs Meta Ads synced.'));
    else {
        const from = meta.first && String(meta.first) > since ? String(meta.first) : since;
        let truth = null;
        let what = '';
        if (ws.reference === 'stripe' && has) {
            const r = await one(db, ws.type === 'ecommerce' ? `SELECT sum(charges) AS n FROM fact_stripe_daily WHERE date >= $1` : `SELECT sum(new_customers) AS n FROM fact_stripe_daily WHERE date >= $1`, [from]);
            truth = num(r.n);
            what = ws.type === 'ecommerce' ? 'successful charges' : 'new paying customers';
        }
        else if (ws.reference === 'shopify' && has) {
            truth = num((await one(db, `SELECT sum(orders) AS n FROM fact_orders_daily WHERE date >= $1`, [from])).n);
            what = 'orders';
        }
        else if (ws.reference === 'ga4' && has) {
            truth = num((await one(db, `SELECT sum(purchases) AS n FROM fact_ga4_daily WHERE date >= $1`, [from])).n);
            what = 'purchases';
        }
        if (truth === null)
            checks.push(skip('ad_claims', ws.reference === 'hubspot' ? 'Meta reports purchases, not leads, so there is nothing in HubSpot to hold them against.' : 'Needs a reference source with purchases to compare against.'));
        else {
            const claimed = num(meta.purchases);
            const share = truth === 0 ? (claimed === 0 ? 0 : 100000) : round((claimed / truth) * 100);
            const flag = adClaimFlag(t);
            const times = truth ? Math.round((claimed / truth) * 10) / 10 : null;
            const ref = REFERENCE_NAME[ws.reference];
            checks.push({
                name: 'ad_claims', status: share > flag ? 'warn' : 'pass', expected: truth, actual: claimed, diffPct: share,
                detail: `Meta claims ${claimed} purchases since ${from}. ${ref} shows ${truth} ${what} on the same days${times !== null ? `, so Meta claims ${times} times as many` : ', so every one of them is a claim with nothing behind it in ' + ref}. A claim is Meta's own attribution, not a sale.`,
            });
        }
    }
    checks.push(await freshness(db, t));
    return checks;
}
// Do enough line items carry a Shopify unit cost for the margin to stand on? A warning, never a failure:
// lines with no cost use the owner's cogs_percent, and the margin says so.
export async function costCheck(db) {
    let r = {};
    try {
        r = (await db.query(`SELECT coalesce(sum(lines), 0) AS lines, coalesce(sum(lines_with_cost), 0) AS costed, count(*) AS days FROM fact_cogs_daily`))[0] ?? {};
    }
    catch {
        return null;
    }
    if (!num(r.days))
        return null;
    const lines = num(r.lines);
    const share = lines ? round((num(r.costed) / lines) * 100) : 100;
    // Only Shopify product costs depend on coverage. A percent or a cost per product does not.
    const mode = readCosts()?.cogs.mode ?? 'shopify';
    const status = share >= 90 || mode !== 'shopify' ? 'pass' : 'warn';
    return {
        name: 'cost_coverage', status, expected: lines, actual: num(r.costed), diffPct: share,
        detail: `${share}% of line items have a product cost in Shopify.${share < 100 ? (mode === 'shopify' ? ' The rest count as zero cost: add costs to those products in Shopify, or use a percent or a cost per product.' : ` Cost of goods comes from your ${mode === 'percent' ? 'percent' : 'cost per product'}, so this does not change the margin.`) : ''}`,
    };
}
