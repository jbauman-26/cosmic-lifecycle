import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from './errors.js';
import { appHome } from './paths.js';
import { aggregateCosts } from './sources/shopify-costs.js';
// The owner's cost inputs for contribution margin, in the file the Cosmic AI app writes:
// $LIFECYCLE_HOME/costs.json. The shape is the app's (cosmic-ai-desktop/docs/margin-contract.md,
// src/shared/margin.ts). `lifecycle costs set` writes the same file, whole, so either side can edit it.
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'MXN', 'BRL', 'SGD', 'HKD', 'KRW', 'INR', 'ZAR', 'ILS', 'TRY', 'CNY'];
export const costsPath = () => join(appHome(), 'costs.json');
const SKU = /^[\w.\-/ ]{1,64}$/;
const amount = (v, max = 1_000_000) => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').trim().replace(/,/g, ''));
    return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : null;
};
const bad = (m, next = 'lifecycle costs show') => new CliError(m, next, 'bad_value');
// The same checks the app makes before it saves. Anything else is refused with one sentence.
export function checkCosts(raw) {
    const o = (raw ?? {});
    if (o.version !== undefined && o.version !== 1)
        throw bad('costs.json is a version this CLI does not know.');
    if (!CURRENCIES.includes(o.currency))
        throw bad("Pick the currency this store's Shopify amounts are in.", 'lifecycle costs set currency USD');
    const c = o.cogs ?? {};
    let cogs;
    if (c.mode === 'shopify')
        cogs = { mode: 'shopify' };
    else if (c.mode === 'percent') {
        const p = amount(c.percent, 100);
        if (p === null)
            throw bad('Cost of goods as a percent of revenue must be a number from 0 to 100.');
        cogs = { mode: 'percent', percent: p };
    }
    else if (c.mode === 'per_product') {
        const items = Array.isArray(c.items) ? c.items : [];
        if (!items.length || items.length > 5000)
            throw bad('A cost per product needs 1 to 5,000 rows of SKU and unit cost.');
        const seen = new Set();
        const clean = items.map((i) => {
            const sku = String(i?.sku ?? '').trim();
            const unit = amount(i?.unit_cost);
            if (!SKU.test(sku) || unit === null || seen.has(sku))
                throw bad(`Row ${sku || '(no SKU)'} needs a unique SKU and a unit cost.`);
            seen.add(sku);
            return { sku, unit_cost: unit };
        });
        const f = c.fallback_percent === null || c.fallback_percent === undefined ? null : amount(c.fallback_percent, 100);
        if (c.fallback_percent !== null && c.fallback_percent !== undefined && f === null)
            throw bad('The fallback percent must be a number from 0 to 100.');
        cogs = { mode: 'per_product', items: clean, fallback_percent: f };
    }
    else
        throw bad('Cost of goods must come from Shopify, a percent, or a cost per product.', 'lifecycle costs set cogs shopify');
    const s = o.shipping ?? { mode: 'none' };
    let shipping;
    if (s.mode === 'none')
        shipping = { mode: 'none' };
    else if (s.mode === 'per_order' && amount(s.amount) !== null)
        shipping = { mode: 'per_order', amount: amount(s.amount) };
    else if (s.mode === 'percent' && amount(s.percent, 100) !== null)
        shipping = { mode: 'percent', percent: amount(s.percent, 100) };
    else
        throw bad('Shipping is none, an amount per order, or a percent of revenue from 0 to 100.', 'lifecycle costs set shipping per_order:6.50');
    const pf = o.payment_fees ?? {};
    const percent = amount(pf.percent ?? 0, 100);
    const perOrder = amount(pf.per_order ?? 0);
    if (percent === null || perOrder === null)
        throw bad('Payment fees are a percent from 0 to 100 and an amount per order.');
    const sources = Array.isArray(o.ad_spend?.sources) ? o.ad_spend.sources.filter((x) => x === 'meta') : [];
    return { version: 1, currency: o.currency, cogs, shipping, payment_fees: { percent, per_order: perOrder }, ad_spend: { sources }, updated_at: typeof o.updated_at === 'string' ? o.updated_at : new Date().toISOString() };
}
// null when there is no file, or one this CLI cannot read: no costs set.
export function readCosts() {
    if (!existsSync(costsPath()))
        return null;
    try {
        return checkCosts(JSON.parse(readFileSync(costsPath(), 'utf8')));
    }
    catch {
        return null;
    }
}
function writeCostsFile(c) {
    mkdirSync(appHome(), { recursive: true, mode: 0o700 });
    const tmp = `${costsPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...c, updated_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, costsPath());
}
const DEFAULT = { version: 1, currency: 'USD', cogs: { mode: 'shopify' }, shipping: { mode: 'none' }, payment_fees: { percent: 0, per_order: 0 }, ad_spend: { sources: [] }, updated_at: '' };
export const COST_KEYS = ['currency', 'cogs', 'shipping', 'payment_fee_percent', 'payment_fee_per_order', 'ad_spend'];
// One input at a time from the command line, into the whole file.
//   currency USD | cogs shopify | cogs percent:35 | shipping none | shipping per_order:6.50 | shipping percent:4
//   payment_fee_percent 2.9 | payment_fee_per_order 0.30 | ad_spend meta | ad_spend none
export function setCost(key, value) {
    const c = structuredClone(readCosts() ?? DEFAULT);
    const [mode, n] = value.split(':');
    if (key === 'currency')
        c.currency = value.trim().toUpperCase();
    else if (key === 'cogs')
        c.cogs = mode === 'percent' ? { mode, percent: Number(n) } : mode === 'shopify' ? { mode } : { mode: value };
    else if (key === 'shipping')
        c.shipping = mode === 'per_order' ? { mode, amount: Number(n) } : mode === 'percent' ? { mode, percent: Number(n) } : { mode: value };
    else if (key === 'payment_fee_percent')
        c.payment_fees.percent = value;
    else if (key === 'payment_fee_per_order')
        c.payment_fees.per_order = value;
    else if (key === 'ad_spend') {
        if (value !== 'meta' && value !== 'none')
            throw bad('Ad spend is meta or none.', 'lifecycle costs set ad_spend meta');
        c.ad_spend = { sources: value === 'meta' ? ['meta'] : [] };
    }
    else
        throw new CliError(`Unknown cost ${key}.`, `Costs: ${COST_KEYS.join(', ')}`, 'unknown_setting');
    const checked = checkCosts(c);
    writeCostsFile(checked);
    return checked;
}
// A cost per product from a CSV of sku,unit_cost. The fallback percent covers SKUs not listed.
export function setProductCosts(csv, fallback) {
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (/[a-z]/i.test(lines[0]?.split(',')[1] ?? ''))
        lines.shift();
    const items = lines.map((l) => {
        const [sku, cost] = l.split(',');
        return { sku: (sku ?? '').trim(), unit_cost: Number((cost ?? '').trim()) };
    });
    const c = structuredClone(readCosts() ?? DEFAULT);
    c.cogs = { mode: 'per_product', items, fallback_percent: fallback === undefined ? null : Number(fallback) };
    const checked = checkCosts(c);
    writeCostsFile(checked);
    return checked;
}
export const costsConfigured = async (db) => {
    if (readCosts())
        return true;
    if (!db)
        return false;
    try {
        return (await db.query(`SELECT 1 FROM fact_cogs_daily LIMIT 1`)).length > 0;
    }
    catch {
        return false;
    }
};
// Recomputed from the full pull in one transaction, like the order totals.
export async function writeCosts(db, orders, currency) {
    const { daily, skus, truncatedOrders } = aggregateCosts(orders);
    const at = new Date().toISOString();
    await db.transaction(async (tx) => {
        await tx.query('DELETE FROM fact_cogs_daily');
        await tx.query('DELETE FROM fact_cogs_sku_daily');
        for (const d of daily)
            await tx.query(`INSERT INTO fact_cogs_daily VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [d.date, currency.toUpperCase(), d.cogsKnown, d.uncostedRevenue, d.tax, d.lines, d.linesWithCost, d.ordersWithoutCost, at]);
        for (const s of skus)
            await tx.query(`INSERT INTO fact_cogs_sku_daily VALUES ($1,$2,$3,$4,$5)`, [s.date, s.sku, s.units, s.revenue, at]);
    });
    const lines = daily.reduce((n, d) => n + d.lines, 0);
    const costed = daily.reduce((n, d) => n + d.linesWithCost, 0);
    return { days: daily.length, lines, linesWithCost: costed, truncatedOrders, coveragePct: lines ? Math.round((costed / lines) * 10000) / 100 : null };
}
// The store's currency, for a roll-up: costs.json first (the app's choice), then the shop currency the cost sync read.
export async function storeCurrency(db) {
    const c = readCosts();
    if (c)
        return c.currency;
    try {
        const r = await db.query(`SELECT currency FROM fact_cogs_daily GROUP BY currency ORDER BY count(*) DESC LIMIT 1`);
        if (r[0])
            return String(r[0].currency).toUpperCase();
    }
    catch {
        // An older database has no cost table yet.
    }
    return null;
}
