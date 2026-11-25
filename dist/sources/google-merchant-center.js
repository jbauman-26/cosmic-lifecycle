import { fetchJson, HttpError } from '../http.js';
import { CliError } from '../errors.js';
// Google Merchant Center, read only. Two reports, both read with the Merchant API Reports
// method accounts.reports.search, which only reads:
// https://developers.google.com/merchant/api/reference/rest/reports_v1/accounts.reports/search
// The account name comes from accounts.get, also a read:
// https://developers.google.com/merchant/api/reference/rest/accounts_v1/accounts/get
// The Content API for Shopping was sunset on 2026-08-18, so it is not used.
// Google offers no read-only Merchant scope. The sign-in has the content scope, which allows
// changes, but this file only ever calls the two read methods above. Nothing inserts, updates,
// deletes or registers anything.
// Only counts and money are kept: no product ids, offer ids, titles, prices or customer data.
const API = 'https://merchantapi.googleapis.com';
export const SCOPE = 'https://www.googleapis.com/auth/content';
const PAGE_SIZE = 10000;
// The Merchant Center id is the number at the top of Merchant Center. accounts/123 works too.
export function normalizeMerchantId(raw) {
    const id = raw.trim().replace(/^accounts\//, '');
    if (!/^\d{1,20}$/.test(id))
        throw new CliError('That is not a Merchant Center account id.', 'Use the number at the top of Merchant Center, such as 123456789.', 'merchant_center_account');
    return id;
}
const num = (v) => Number(v) || 0;
const money = (n) => Math.round(n * 100) / 100;
// Conversions can be fractional, so they keep two decimals.
const two = (n) => Math.round(n * 100) / 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n, w = 2) => String(n).padStart(w, '0');
// The reference types date as a google.type.Date ({ year, month, day }). A YYYY-MM-DD string is accepted too.
export function reportDate(d) {
    if (typeof d === 'string')
        return DATE.test(d) ? d : null;
    if (!d?.year || !d.month || !d.day)
        return null;
    const s = `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
    return DATE.test(s) ? s : null;
}
// Pure, so tests can pin every rule. Rows without a date are dropped. Rows that share a date and marketing
// method are added together, so the primary key holds whatever Google sends. Conversion value is only reported
// for free listings, so ADS rows usually have no value and no currency; their currency stays empty.
export function toPerformanceDaily(rows) {
    const out = new Map();
    for (const r of rows) {
        const v = r.productPerformanceView;
        const date = reportDate(v?.date);
        if (!v || !date)
            continue;
        const method = String(v.marketingMethod || 'MARKETING_METHOD_ENUM_UNSPECIFIED');
        const key = `${date}|${method}`;
        const d = out.get(key) ?? { date, marketingMethod: method, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0, currency: '' };
        d.clicks += num(v.clicks);
        d.impressions += num(v.impressions);
        d.conversions = two(d.conversions + num(v.conversions));
        d.conversionValue = money(d.conversionValue + num(v.conversionValue?.amountMicros) / 1e6);
        if (!d.currency && v.conversionValue?.currencyCode)
            d.currency = String(v.conversionValue.currencyCode).toUpperCase();
        out.set(key, d);
    }
    return [...out.values()].sort((a, b) => (a.date + a.marketingMethod).localeCompare(b.date + b.marketingMethod));
}
// Counts products by their status across all reporting contexts. Ids are read only to count each product once,
// then dropped: nothing about a product leaves this function except the totals.
export function countStatuses(rows) {
    const seen = new Set();
    const c = { products: 0, eligible: 0, eligibleLimited: 0, pending: 0, disapproved: 0 };
    for (const r of rows) {
        const v = r.productView;
        if (!v)
            continue;
        if (v.id) {
            if (seen.has(v.id))
                continue;
            seen.add(v.id);
        }
        c.products++;
        const s = v.aggregatedReportingContextStatus;
        if (s === 'ELIGIBLE')
            c.eligible++;
        else if (s === 'ELIGIBLE_LIMITED')
            c.eligibleLimited++;
        else if (s === 'PENDING')
            c.pending++;
        else if (s === 'NOT_ELIGIBLE_OR_DISAPPROVED')
            c.disapproved++;
    }
    return c;
}
// Only these strings ever reach the query, and dates are checked first, so nothing outside can change it.
function dateRange(since, until) {
    if (!DATE.test(since) || !DATE.test(until))
        throw new CliError('Dates must be YYYY-MM-DD.', 'lifecycle sync', 'bad_value');
    return `date BETWEEN '${since}' AND '${until}'`;
}
export const performanceQuery = (since, until) => `SELECT date, marketing_method, clicks, impressions, conversions, conversion_value FROM product_performance_view WHERE ${dateRange(since, until)}`;
export const PRODUCTS_QUERY = 'SELECT id, aggregated_reporting_context_status FROM product_view';
export async function merchantAccessToken(clientId, clientSecret, refreshToken, fetcher = fetchJson) {
    const body = await fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
    }, 'Google token request').catch((e) => {
        // A revoked refresh token, or one from a Testing-mode app older than seven days, comes back as invalid_grant.
        if (e instanceof HttpError && (e.status === 400 || e.status === 401) && /invalid_grant|invalid_client|unauthorized_client/.test(e.body)) {
            throw new CliError('Google rejected the saved Merchant Center sign-in.', 'Sign in with Google again for a new refresh token, then lifecycle connect google-merchant-center --account ID --client-id ID --secret-env NAME --refresh-token-env NAME', 'key_rejected');
        }
        throw e;
    });
    if (!body?.access_token)
        throw new CliError('Google returned no access token.', 'lifecycle doctor', 'key_rejected');
    return String(body.access_token);
}
// Google APIs put the reason in error.status and error.message, sometimes with an ErrorInfo reason in details.
export function errorInfo(body) {
    try {
        const err = JSON.parse(body)?.error ?? {};
        const reasons = (err.details ?? []).map((d) => d?.reason).filter(Boolean).map(String);
        return { status: String(err.status ?? ''), message: String(err.message ?? ''), reasons };
    }
    catch {
        return { status: '', message: '', reasons: [] };
    }
}
function explain(e) {
    if (e instanceof HttpError) {
        const { status, message, reasons } = errorInfo(e.body);
        const detail = message ? `: ${message}` : '.';
        if (e.status === 401 || status === 'UNAUTHENTICATED')
            throw new CliError(`Merchant Center refused the sign-in${detail}`, 'Sign in with Google again, then lifecycle connect google-merchant-center', 'key_rejected');
        if (e.status === 429 || status === 'RESOURCE_EXHAUSTED')
            throw new CliError('Merchant Center is rate limiting this project.', 'Wait a few minutes, then run lifecycle sync --only google-merchant-center again.', 'rate_limited');
        if (e.status === 403 || status === 'PERMISSION_DENIED') {
            if (reasons.includes('SERVICE_DISABLED') || /has not been used|is disabled/i.test(message)) {
                throw new CliError(`The Merchant API is not turned on for this Google Cloud project${detail}`, 'Turn on the Merchant API in the Cloud project, wait a few minutes, then connect again.', 'merchant_center_permission');
            }
            if (/regist/i.test(message)) {
                throw new CliError(`This Google Cloud project is not registered with the Merchant Center account${detail}`, 'The account owner registers the project once in the Cosmic AI app (developer registration), then connect again.', 'merchant_center_permission');
            }
            throw new CliError(`The signed-in Google account cannot read that Merchant Center account${detail}`, 'Check the account id, and that the Google user has Performance and insights or Admin access in Merchant Center.', 'merchant_center_permission');
        }
        if (e.status === 404 || status === 'NOT_FOUND')
            throw new CliError(`Merchant Center has no account with that id${detail}`, 'Check the id at the top of Merchant Center, then lifecycle connect google-merchant-center --account ID', 'merchant_center_account');
        if (message)
            throw new CliError(`Merchant Center answered with status ${e.status}${detail}`, e.status === 400 ? 'Check the account id: lifecycle connect google-merchant-center --account ID' : 'Run the command again, then lifecycle doctor.', 'merchant_center_error');
    }
    throw e;
}
export class MerchantCenter {
    token;
    fetcher;
    account;
    constructor(token, account, fetcher = fetchJson) {
        this.token = token;
        this.fetcher = fetcher;
        this.account = normalizeMerchantId(account);
    }
    headers(json) {
        return { ...(json ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${this.token}` };
    }
    // Follows nextPageToken until there is none. accounts.reports.search only reads.
    async search(query, label) {
        const out = [];
        let pageToken;
        for (let page = 0; page < 1000; page++) {
            let body;
            try {
                body = await this.fetcher(`${API}/reports/v1/accounts/${this.account}/reports:search`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(pageToken ? { query, pageSize: PAGE_SIZE, pageToken } : { query, pageSize: PAGE_SIZE }) }, label);
            }
            catch (e) {
                explain(e);
            }
            out.push(...(body?.results ?? []));
            const next = body?.nextPageToken;
            if (!next || next === pageToken)
                return out;
            pageToken = next;
        }
        throw new CliError('Merchant Center kept sending pages past 1,000.', 'Run lifecycle sync --only google-merchant-center again. If it repeats, report it: lifecycle feedback', 'merchant_center_error');
    }
    // Proves the sign-in can read reports for this account before anything is saved: a one-day performance
    // report, the smallest query a performance report allows. Then the account name, if Google gives it.
    async check(today = new Date().toISOString().slice(0, 10)) {
        await this.search(performanceQuery(today, today), 'Merchant Center report check');
        return { account: this.account, name: await this.name() };
    }
    // accounts.get, a read. The name is a nicety: a refusal other than a bad sign-in leaves it empty.
    async name() {
        try {
            const body = await this.fetcher(`${API}/accounts/v1/accounts/${this.account}`, { method: 'GET', headers: this.headers(false) }, 'Merchant Center account');
            return String(body?.accountName ?? '');
        }
        catch (e) {
            if (e instanceof HttpError && e.status === 401)
                explain(e);
            return '';
        }
    }
    performance(since, until) {
        return this.search(performanceQuery(since, until), 'Merchant Center performance report');
    }
    products() {
        return this.search(PRODUCTS_QUERY, 'Merchant Center product status report');
    }
}
