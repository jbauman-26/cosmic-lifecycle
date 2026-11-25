import { fetchJson, HttpError } from './http.js';
import { CliError } from './errors.js';
import { apiBase } from './sources/api-base.js';
// Exchange rates for a roll-up across stores in different currencies. The source is Frankfurter
// (https://frankfurter.dev), free, keyless, and free for commercial use per its FAQ. The European
// Central Bank's reference rate is asked for first; a currency the ECB does not publish falls back
// to Frankfurter's blended rate. Every rate is returned with the date it is for and where it came
// from, so a converted total always says which rate made it. An owner can also give a rate by hand.
export const FX_SOURCE = 'Frankfurter (frankfurter.dev)';
const API = 'https://api.frankfurter.dev';
export const assertCurrency = (c) => {
    const v = c.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(v))
        throw new CliError(`${c} is not a three letter currency code.`, 'Use a code such as USD, EUR or GBP.', 'bad_value');
    return v;
};
// --rate EUR=1.0955 means one EUR is 1.0955 of the reporting currency.
export function parseRates(values, to, date) {
    const out = new Map();
    for (const v of values ?? []) {
        const m = /^([A-Za-z]{3})=([0-9]*\.?[0-9]+)$/.exec(v.trim());
        if (!m || !(Number(m[2]) > 0))
            throw new CliError(`${v} is not a rate.`, `Write it as CODE=RATE, one CODE in ${to}: --rate EUR=1.0955`, 'bad_value');
        const from = assertCurrency(m[1]);
        out.set(from, { from, to, rate: Number(m[2]), date, source: 'set by the owner' });
    }
    return out;
}
export async function fetchRate(from, to, date, fetcher = fetchJson) {
    if (from === to)
        return { from, to, rate: 1, date: date ?? new Date().toISOString().slice(0, 10), source: 'same currency' };
    const base = apiBase('fx', API);
    const q = date ? `?date=${date}` : '';
    const read = async (path, source) => {
        const b = await fetcher(`${base}${path}${q}`, {}, 'Exchange rate request', { retries: 2 });
        const rate = Number(b?.rate);
        if (!(rate > 0) || typeof b?.date !== 'string')
            throw new CliError(`The exchange rate source sent no rate for ${from} to ${to}.`, `Give it by hand: --rate ${from}=RATE`, 'no_rate');
        return { from, to, rate, date: b.date, source };
    };
    try {
        return await read(`/v2/providers/ecb/rate/${from.toLowerCase()}/${to.toLowerCase()}`, `${FX_SOURCE}, European Central Bank reference rate`);
    }
    catch (e) {
        if (!(e instanceof HttpError && (e.status === 404 || e.status === 422)))
            throw wrap(e, from);
    }
    try {
        return await read(`/v2/rate/${from.toLowerCase()}/${to.toLowerCase()}`, `${FX_SOURCE}, blended rate`);
    }
    catch (e) {
        throw wrap(e, from);
    }
}
const wrap = (e, from) => e instanceof CliError && e.code === 'no_rate'
    ? e
    : new CliError(`Could not get an exchange rate for ${from}: ${e instanceof Error ? e.message : String(e)}`, `Try again, or give it by hand: --rate ${from}=RATE`, 'no_rate');
