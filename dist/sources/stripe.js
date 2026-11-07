import { createHash } from 'node:crypto';
import { fetchJson, HttpError } from '../http.js';
import { CliError } from '../errors.js';
const API = 'https://api.stripe.com/v1';
// Stripe amounts are in the smallest unit, and not every currency has cents.
// https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);
export function toMajor(amount, currency) {
    const c = currency.toLowerCase();
    const div = ZERO_DECIMAL.has(c) ? 1 : THREE_DECIMAL.has(c) ? 1000 : 100;
    return Math.round((amount / div) * 1000) / 1000;
}
export const stripeMode = (key) => (/^(sk|rk)_test_/.test(key) ? 'test' : 'live');
export const isRestrictedKey = (key) => key.startsWith('rk_');
export class Stripe {
    key;
    fetcher;
    constructor(key, fetcher = fetchJson) {
        this.key = key;
        this.fetcher = fetcher;
    }
    async get(path, params, label) {
        const qs = new URLSearchParams(params).toString();
        return this.fetcher(`${API}${path}?${qs}`, { headers: { authorization: `Bearer ${this.key}` } }, label);
    }
    // Walks every page. Stripe lists newest first and pages with starting_after.
    async all(path, params, label) {
        const out = [];
        let after;
        for (;;) {
            const body = await this.get(path, { limit: '100', ...params, ...(after ? { starting_after: after } : {}) }, label);
            const page = body.data ?? [];
            out.push(...page);
            if (!body.has_more || !page.length)
                return out;
            after = page[page.length - 1].id;
        }
    }
    charges() {
        return this.all('/charges', {}, 'Stripe charges request');
    }
    // Returns null when the key has no permission for subscriptions, so a
    // charges-only restricted key still syncs.
    async subscriptions() {
        try {
            return await this.all('/subscriptions', { status: 'all' }, 'Stripe subscriptions request');
        }
        catch (e) {
            if (e instanceof HttpError && e.status === 403)
                return null;
            throw e;
        }
    }
    // Proves the key can read charges before anything is saved.
    async check() {
        try {
            await this.get('/charges', { limit: '1' }, 'Stripe charges check');
        }
        catch (e) {
            if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
                throw new CliError('Stripe refused this key for charges.', 'Create a restricted key with Read on Charges and Subscriptions, then connect again.', 'stripe_key');
            }
            throw e;
        }
        const subs = await this.get('/subscriptions', { limit: '1', status: 'all' }, 'Stripe subscriptions check').then(() => true, (e) => {
            if (e instanceof HttpError && e.status === 403)
                return false;
            throw e;
        });
        return { subscriptions: subs };
    }
}
const hash = (id) => createHash('sha256').update(id).digest('hex');
const day = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 10);
const money = (n) => Math.round(n * 100) / 100;
// Pure, so tests can pin every rule. Customer ids are hashed in memory and
// leave this function only as counts. Refunds count against the day of the
// charge, not the day of the refund, so a day's net only ever goes down.
export function aggregateCharges(charges) {
    const seen = new Set();
    const daily = new Map();
    for (const c of [...charges].sort((a, b) => a.created - b.created)) {
        if (c.status !== 'succeeded' && c.status !== 'failed')
            continue;
        const date = day(c.created);
        const currency = c.currency.toLowerCase();
        const id = `${date}|${currency}`;
        const d = daily.get(id) ?? { date, currency, charges: 0, gross: 0, refunded: 0, net: 0, failed: 0, newCustomers: 0, returningCharges: 0, guestCharges: 0 };
        if (c.status === 'failed') {
            d.failed++;
        }
        else {
            const gross = toMajor(c.amount, currency);
            const refunded = toMajor(c.amount_refunded, currency);
            d.charges++;
            d.gross = money(d.gross + gross);
            d.refunded = money(d.refunded + refunded);
            d.net = money(d.gross - d.refunded);
            const key = c.customer ? hash(c.customer) : null;
            if (!key)
                d.guestCharges++;
            else if (seen.has(key))
                d.returningCharges++;
            else {
                seen.add(key);
                d.newCustomers++;
            }
        }
        daily.set(id, d);
    }
    return [...daily.values()];
}
const MONTHS_PER = { day: 12 / 365, week: 12 / 52, month: 1, year: 12 };
// Monthly recurring revenue as Stripe defines the base of it: active and
// past_due subscriptions, list price times quantity, scaled to a month.
// Discounts and tiered prices are not applied; tiered items are counted in
// unpricedItems so the number never claims more than it knows.
export function aggregateSubscriptions(subs) {
    const daily = new Map();
    const bump = (date, currency, field) => {
        const id = `${date}|${currency}`;
        const d = daily.get(id) ?? { date, currency, started: 0, ended: 0 };
        d[field]++;
        daily.set(id, d);
    };
    const mrr = new Map();
    for (const s of subs) {
        const currency = s.currency.toLowerCase();
        if (s.status !== 'incomplete_expired')
            bump(day(s.created), currency, 'started');
        if (s.ended_at && s.status !== 'incomplete_expired')
            bump(day(s.ended_at), currency, 'ended');
        if (s.status !== 'active' && s.status !== 'past_due')
            continue;
        const m = mrr.get(currency) ?? { currency, active: 0, mrr: 0, unpricedItems: 0 };
        m.active++;
        for (const item of s.items.data) {
            const p = item.price;
            const per = p.recurring ? MONTHS_PER[p.recurring.interval] : undefined;
            if (p.unit_amount === null || !p.recurring || per === undefined) {
                m.unpricedItems++;
                continue;
            }
            const monthly = (toMajor(p.unit_amount, currency) * (item.quantity ?? 1)) / (per * p.recurring.interval_count);
            m.mrr = money(m.mrr + monthly);
        }
        mrr.set(currency, m);
    }
    return { daily: [...daily.values()], mrr: [...mrr.values()] };
}
