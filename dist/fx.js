import { fetchJson, HttpError } from './http.js';
import { CliError } from './errors.js';
import { apiBase } from './sources/api-base.js';
// Exchange rates for one total across stores. The same source and the same rule as the Cosmic AI
// app (cosmic-ai-desktop/src/shared/margin.ts), so both print the same total for the same day:
// Frankfurter's v1 API, which republishes the European Central Bank's daily reference rates. Free,
// no key, free for commercial use per its FAQ (https://frankfurter.dev).
//
// A rate is "1 reporting currency = rate store currency", and a store's amount is divided by it.
// The date kept is the day the source published, which can be earlier than the day asked for.
export const FX_SOURCE = 'European Central Bank reference rates, via Frankfurter';
const API = 'https://api.frankfurter.dev';
export const assertCurrency = (c) => {
    const v = c.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(v))
        throw new CliError(`${c} is not a three letter currency code.`, 'Use a code such as USD, EUR or GBP.', 'bad_value');
    return v;
};
export async function fetchRates(base, day, symbols, fetcher = fetchJson) {
    const qs = new URLSearchParams({ base, ...(symbols.length ? { symbols: symbols.join(',') } : {}) });
    let b;
    try {
        b = await fetcher(`${apiBase('fx', API)}/v1/${day ?? 'latest'}?${qs}`, {}, 'Exchange rate request', { retries: 2 });
    }
    catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 422))
            return { base, date: day ?? '', rates: { [base]: 1 }, source: FX_SOURCE };
        throw new CliError(`Could not get exchange rates: ${e instanceof Error ? e.message : String(e)}`, 'Try again, or give the rate by hand: --rate EUR=0.91', 'no_rate');
    }
    if (b?.base !== base || typeof b?.date !== 'string' || typeof b?.rates !== 'object')
        throw new CliError('The exchange rate source sent an answer this CLI cannot read.', 'Try again, or give the rate by hand: --rate EUR=0.91', 'no_rate');
    const rates = { [base]: 1 };
    for (const [k, v] of Object.entries(b.rates))
        if (typeof v === 'number' && v > 0)
            rates[k] = v;
    return { base, date: b.date, rates, source: FX_SOURCE };
}
// --rate EUR=0.9099 means 1 of the reporting currency is 0.9099 EUR, the way the source writes it.
export function parseRates(values) {
    const out = {};
    for (const v of values ?? []) {
        const m = /^([A-Za-z]{3})=([0-9]*\.?[0-9]+)$/.exec(v.trim());
        if (!m || !(Number(m[2]) > 0))
            throw new CliError(`${v} is not a rate.`, 'Write it as CODE=RATE, how many CODE one unit of the reporting currency buys: --rate EUR=0.9099', 'bad_value');
        out[assertCurrency(m[1])] = Number(m[2]);
    }
    return out;
}
// "In USD at European Central Bank reference rates, via Frankfurter for Nov 24, 2026."
export function rateLine(r, manual) {
    if (manual)
        return `In ${r.base} at rates set by the owner.`;
    const day = r.date ? new Date(`${r.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'the latest day';
    return `In ${r.base} at ${r.source} for ${day}.`;
}
