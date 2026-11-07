export const TOLERANCE = { klaviyoOrders: 3, ga4Purchases: 15, attributedShareFlag: 60, freshnessDays: 2 };
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
export async function runChecks(db) {
    const checks = [];
    const days = 90;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    // 1. Did the pull get everything Shopify says exists? This is the check that
    // would have caught the silent gap we measured in Graphed's page table.
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
    const so = await one(db, `SELECT sum(orders) AS orders, sum(net_revenue) AS net FROM fact_orders_daily WHERE date >= $1`, [since]);
    const ko = await one(db, `SELECT sum(placed_orders) AS orders FROM fact_klaviyo_orders_daily WHERE date >= $1`, [since]);
    const klaviyoSynced = (await db.query(`SELECT 1 FROM meta_sync_run WHERE source = 'klaviyo' AND status <> 'failed' LIMIT 1`)).length > 0;
    if (so.orders === null || so.orders === undefined || !klaviyoSynced)
        checks.push(skip('klaviyo_orders', 'Needs both Shopify and Klaviyo synced.'));
    else if (num(ko.orders) === 0) {
        checks.push({ name: 'klaviyo_orders', status: 'fail', expected: num(so.orders), actual: 0, diffPct: 100, detail: `Shopify has ${num(so.orders)} orders in the last ${days} days, and Klaviyo has none. The store may not be connected to this Klaviyo account.` });
    }
    else
        checks.push(compare('klaviyo_orders', num(so.orders), num(ko.orders), TOLERANCE.klaviyoOrders, `Klaviyo Placed Order against Shopify orders, last ${days} days`));
    // 4. Is GA4 seeing the same purchases?
    const ga = await one(db, `SELECT sum(purchases) AS purchases FROM fact_ga4_daily WHERE date >= $1`, [since]);
    checks.push(ga.purchases === null || ga.purchases === undefined || so.orders === null || so.orders === undefined
        ? skip('ga4_purchases', 'Needs both GA4 and Shopify synced.')
        : compare('ga4_purchases', num(so.orders), num(ga.purchases), TOLERANCE.ga4Purchases, `GA4 purchases against Shopify orders, last ${days} days`));
    // 5. Does the attributed revenue look believable?
    const fl = await one(db, `SELECT sum(revenue) AS revenue FROM fact_flow_daily WHERE date >= $1`, [since]);
    if (fl.revenue === null || fl.revenue === undefined || !num(so.net))
        checks.push(skip('attributed_share', 'Needs Klaviyo flow revenue and Shopify revenue.'));
    else {
        const share = round((num(fl.revenue) / num(so.net)) * 100);
        checks.push({
            name: 'attributed_share', status: share > TOLERANCE.attributedShareFlag ? 'warn' : 'pass', expected: num(so.net), actual: num(fl.revenue), diffPct: share,
            detail: `Klaviyo attributes ${share}% of Shopify net revenue to flows. This is Klaviyo's attribution, not proof of causation.`,
        });
    }
    // 6. Do the daily flow rows add up to Klaviyo's own totals?
    const w = await one(db, `SELECT min(window_start) AS s, max(window_end) AS e, sum(recipients) AS recipients FROM fact_flow_window`);
    if (w.recipients === null || w.recipients === undefined)
        checks.push(skip('flow_totals', 'No flow totals from Klaviyo yet.'));
    else {
        const f = await one(db, `SELECT sum(recipients) AS recipients FROM fact_flow_daily WHERE date >= $1 AND date <= $2`, [w.s, w.e]);
        checks.push(compare('flow_totals', num(w.recipients), num(f.recipients), 0.5, 'Daily flow recipients against Klaviyo’s flow totals'));
    }
    // 7. Is anything stale?
    const last = await db.query(`SELECT source, max(finished_at) AS at FROM meta_sync_run WHERE status <> 'failed' GROUP BY source`);
    if (!last.length)
        checks.push(skip('freshness', 'Nothing has synced yet.'));
    else {
        const ages = last.map((r) => ({ source: String(r.source), days: (Date.now() - new Date(r.at).getTime()) / 86400000 }));
        const stale = ages.filter((a) => a.days > TOLERANCE.freshnessDays);
        checks.push({
            name: 'freshness', status: stale.length ? 'fail' : 'pass', expected: TOLERANCE.freshnessDays, actual: round(Math.max(...ages.map((a) => a.days))), diffPct: null,
            detail: stale.length ? `Stale: ${stale.map((s) => s.source).join(', ')}.` : 'All connected sources synced within 2 days.',
        });
    }
    return checks;
}
export async function reconcile(db) {
    const checks = await runChecks(db);
    const at = new Date().toISOString();
    await db.transaction(async (tx) => {
        for (const c of checks) {
            await tx.query(`INSERT INTO meta_reconcile_result VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (check_name) DO UPDATE SET status = EXCLUDED.status, expected = EXCLUDED.expected, actual = EXCLUDED.actual, diff_pct = EXCLUDED.diff_pct, detail = EXCLUDED.detail, checked_at = EXCLUDED.checked_at`, [c.name, c.status, c.expected, c.actual, c.diffPct, c.detail, at]);
        }
    });
    return { passed: !checks.some((c) => c.status === 'fail'), checks };
}
// Every report calls this, so a number can never appear without its status.
export async function trustLine(db) {
    const rows = await db.query(`SELECT check_name, status FROM meta_reconcile_result`);
    if (!rows.length)
        return { status: 'unchecked', line: 'Numbers not checked yet. Run lifecycle reconcile.' };
    const failed = rows.filter((r) => r.status === 'fail').map((r) => String(r.check_name));
    if (failed.length)
        return { status: 'failed', line: `DO NOT TRUST THESE NUMBERS YET. Failed checks: ${failed.join(', ')}.` };
    const skipped = rows.filter((r) => r.status === 'skipped').length;
    return { status: 'passed', line: `Numbers passed reconciliation${skipped ? `, with ${skipped} checks skipped` : ''}.` };
}
