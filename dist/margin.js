import { readCosts } from './costs.js';
import { trustLine } from './reconcile.js';
// Contribution margin by day for a store, in the shape the Cosmic AI app reads
// (cosmic-ai-desktop/docs/margin-contract.md, readMargin in src/shared/margin.ts):
//   cm1 = revenue - cogs, cm2 = cm1 - shipping - payment_fees, cm3 = cm2 - ad_spend
// Revenue is Shopify net revenue (fact_orders_daily.net_revenue) in the store currency. The cost
// inputs are the owner's costs.json. One fixed SQL reads the daily facts; the arithmetic is below.
export const MARGIN_SQL = `SELECT o.date::text AS day, o.orders, o.net_revenue AS revenue,
  c.cogs_known, c.orders_without_cost, c.tax, c.lines, c.lines_with_cost,
  (SELECT coalesce(sum(spend), 0) FROM fact_meta_ads_daily m WHERE m.date = o.date) AS meta_spend
FROM fact_orders_daily o LEFT JOIN fact_cogs_daily c ON c.date = o.date
WHERE o.date >= $1 ORDER BY o.date`;
export const MARGIN_SKU_SQL = `SELECT date::text AS day, sku, units, revenue FROM fact_cogs_sku_daily WHERE date >= $1`;
const c2 = (n) => Math.round(n * 100) / 100;
const n = (v) => (v === null || v === undefined ? 0 : Number(v));
const fmt = (x, ccy) => `${x.toFixed(2)} ${ccy}`;
export async function computeMargin(db, since, days) {
    const costs = readCosts();
    const trust = await trustLine(db);
    if (!costs) {
        return { metric: 'contribution_margin', days, status: 'no_costs', detail: 'No costs are set for this store. Set them in the app under Settings, Costs, or with lifecycle costs set.', trust, costs: null };
    }
    const rows = await db.query(MARGIN_SQL, [since]);
    const skuRows = costs.cogs.mode === 'per_product' ? await db.query(MARGIN_SKU_SQL, [since]) : [];
    const metaCcy = (await db.query(`SELECT DISTINCT upper(currency) AS c FROM fact_meta_ads_daily WHERE date >= $1`, [since])).map((r) => String(r.c));
    const metaSynced = (await db.query(`SELECT 1 FROM fact_meta_ads_daily LIMIT 1`)).length > 0;
    const costSynced = rows.some((r) => r.lines !== null && r.lines !== undefined);
    const included = [];
    const missing = [];
    const unit = new Map(costs.cogs.mode === 'per_product' ? costs.cogs.items.map((i) => [i.sku, i.unit_cost]) : []);
    let unlistedSkus = 0;
    const skuCost = new Map();
    for (const s of skuRows) {
        const cost = unit.get(String(s.sku));
        const fb = costs.cogs.mode === 'per_product' ? costs.cogs.fallback_percent : null;
        const v = cost !== undefined ? cost * n(s.units) : fb !== null ? (n(s.revenue) * fb) / 100 : 0;
        if (cost === undefined)
            unlistedSkus++;
        skuCost.set(String(s.day), (skuCost.get(String(s.day)) ?? 0) + v);
    }
    if (costs.cogs.mode === 'shopify') {
        if (costSynced)
            included.push('Cost of goods from Shopify product costs');
        else
            missing.push('Cost of goods: Shopify product costs not synced yet (lifecycle costs sync)');
    }
    else if (costs.cogs.mode === 'percent')
        included.push(`Cost of goods at ${costs.cogs.percent}% of revenue`);
    else {
        if (skuRows.length)
            included.push(`Cost of goods from your cost per product (${costs.cogs.items.length} SKUs)`);
        else
            missing.push('Cost of goods: sales by SKU not synced yet (lifecycle costs sync)');
        if (unlistedSkus && costs.cogs.fallback_percent === null)
            missing.push('Cost of goods for SKUs not on your list');
        else if (unlistedSkus)
            included.push(`SKUs not on your list at ${costs.cogs.fallback_percent}% of their revenue`);
    }
    if (costs.shipping.mode === 'per_order')
        included.push(`Shipping at ${fmt(costs.shipping.amount, costs.currency)} per order`);
    else if (costs.shipping.mode === 'percent')
        included.push(`Shipping at ${costs.shipping.percent}% of revenue`);
    else
        missing.push('Shipping');
    if (costs.payment_fees.percent || costs.payment_fees.per_order)
        included.push(`Payment fees at ${costs.payment_fees.percent}% plus ${fmt(costs.payment_fees.per_order, costs.currency)} per order`);
    else
        missing.push('Payment fees');
    // Ad spend in another currency than the store's is not converted: it is left out and named.
    const wantsMeta = costs.ad_spend.sources.includes('meta');
    const metaOther = metaCcy.filter((c) => c !== costs.currency);
    const countMeta = wantsMeta && metaSynced && !metaOther.length;
    if (!wantsMeta)
        missing.push('Ad spend: no ad source chosen');
    else if (!metaSynced)
        missing.push('Meta Ads spend: not synced');
    else if (metaOther.length)
        missing.push(`Meta Ads spend: the ad account is in ${metaOther.join(', ')}, not ${costs.currency}, and is not converted yet`);
    else
        included.push('Meta Ads spend');
    // 0.17.1: only Meta spend is subtracted so far. Name every other ad platform with spend in the
    // window, so a margin is never shown as complete while it leaves their spend out.
    const OTHER_ADS = [['Google Ads', 'fact_google_ads_campaign_daily'], ['Microsoft Advertising', 'fact_microsoft_ads_daily'], ['LinkedIn Ads', 'fact_linkedin_ads_daily'], ['Reddit Ads', 'fact_reddit_ads_daily'], ['Snapchat Ads', 'fact_snapchat_ads_daily'], ['TikTok Ads', 'fact_tiktok_ads_daily'], ['Pinterest Ads', 'fact_pinterest_ads_daily']];
    for (const [label, table] of OTHER_ADS) {
        const hit = await db.query(`SELECT 1 FROM ${table} WHERE date >= $1 LIMIT 1`, [since]).catch(() => []);
        if (hit.length)
            missing.push(`${label} spend: synced but not subtracted yet, so this margin is too high by that spend`);
    }
    let withoutCost = 0;
    let tax = 0;
    const out = rows.map((r) => {
        const revenue = c2(n(r.revenue));
        const orders = n(r.orders);
        tax += n(r.tax);
        if (costs.cogs.mode === 'shopify')
            withoutCost += n(r.orders_without_cost);
        const cogs = c2(costs.cogs.mode === 'shopify' ? n(r.cogs_known) : costs.cogs.mode === 'percent' ? (revenue * costs.cogs.percent) / 100 : (skuCost.get(String(r.day)) ?? 0));
        const shipping = c2(costs.shipping.mode === 'per_order' ? orders * costs.shipping.amount : costs.shipping.mode === 'percent' ? (revenue * costs.shipping.percent) / 100 : 0);
        const payment_fees = c2((revenue * costs.payment_fees.percent) / 100 + orders * costs.payment_fees.per_order);
        const ad_spend = c2(countMeta ? n(r.meta_spend) : 0);
        const cm1 = c2(revenue - cogs);
        const cm2 = c2(cm1 - shipping - payment_fees);
        return { day: String(r.day), revenue, cogs, shipping, payment_fees, ad_spend, cm1, cm2, cm3: c2(cm2 - ad_spend) };
    });
    const sum = (k) => c2(out.reduce((a, r) => a + r[k], 0));
    const total = { revenue: sum('revenue'), cogs: sum('cogs'), shipping: sum('shipping'), payment_fees: sum('payment_fees'), ad_spend: sum('ad_spend'), cm1: sum('cm1'), cm2: sum('cm2'), cm3: sum('cm3') };
    const lines = rows.reduce((a, r) => a + n(r.lines), 0);
    const costed = rows.reduce((a, r) => a + n(r.lines_with_cost), 0);
    const notes = [
        'Revenue is Shopify net revenue: after discounts, edits and refunds, with sales tax and shipping charged to the customer still inside it.',
        ...(tax ? [`Sales tax inside revenue in this window: ${fmt(c2(tax), costs.currency)}.`] : []),
        'Refunds lower revenue. The cost of a return (shipping it back, goods written off) is not counted.',
        ...(withoutCost ? [`${withoutCost} orders have products with no cost in Shopify, so cost of goods is low by that much.`] : []),
    ];
    return {
        metric: 'contribution_margin', days, status: out.length ? 'ok' : 'no_data', detail: out.length ? '' : 'No Shopify orders in this window.',
        currency: costs.currency, total, rows: out.slice(-731), included: included.slice(0, 12), missing: missing.slice(0, 12), orders_without_cost: withoutCost,
        coverage: lines ? c2((costed / lines) * 100) : null, notes, trust, costs: costs,
    };
}
