import { fetchJson, HttpError } from '../http.js';
import { CliError } from '../errors.js';
// TikTok Ads, read only, through the TikTok API for Business (Marketing API) v1.3.
// v1.3 is used because it documents every call below; v2.0 so far documents only reporting.
// Two GET calls, and nothing else:
//   GET /open_api/v1.3/advertiser/info/       the account name, currency and time zone
//   https://business-api.tiktok.com/portal/docs/get-ad-account-details/v1.3
//   GET /open_api/v1.3/report/integrated/get/ a synchronous BASIC report of daily campaign totals
//   https://business-api.tiktok.com/portal/docs/run-a-synchronous-report/v1.3
// Neither call writes. No create, update, delete or status call exists in this file.
// No audiences, creatives, ad text, comments or people are read. Only campaign names and numbers.
// The access token is TikTok's long-term advertiser token, which does not expire unless the
// advertiser revokes it, so there is no refresh step and the app secret is not needed here.
// https://business-api.tiktok.com/portal/docs/obtain-a-long-term-access-token/v1.3
export const API_VERSION = 'v1.3';
const API = `https://business-api.tiktok.com/open_api/${API_VERSION}`;
// "When dimensions includes stat_time_day, the maximum time range is 30 days." Days are counted inclusively here.
export const MAX_SPAN_DAYS = 30;
const PAGE_SIZE = 1000;
// The advertiser id is the long number under the account name in TikTok Ads Manager.
export function normalizeAdvertiserId(raw) {
    const id = raw.trim();
    if (!/^\d{6,24}$/.test(id))
        throw new CliError('That is not a TikTok advertiser id.', 'Use the advertiser id under the account name in TikTok Ads Manager, such as 7123456789012345678.', 'tiktok_ads_account');
    return id;
}
const num = (v) => Number(v) || 0;
const money = (n) => Math.round(n * 100) / 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (s) => String(s ?? '').slice(0, 10);
// The metrics asked for. Conversions are website purchases (complete_payment) and the value is their
// purchase value. TikTok names that value total_complete_payment_rate, though it is a value, not a rate.
// https://business-api.tiktok.com/portal/docs/basic-reports-supported-metrics/v1.3
export const METRICS = ['campaign_name', 'spend', 'impressions', 'clicks', 'complete_payment', 'total_complete_payment_rate'];
export const DIMENSIONS = ['campaign_id', 'stat_time_day'];
// Pure, so tests can pin every rule. Rows without a campaign id or a day are dropped.
// stat_time_day reads "2026-11-01 00:00:00" in v1.3; only the date part is kept.
export function toDaily(rows) {
    return rows
        .filter((r) => r.dimensions?.campaign_id && DATE.test(day(r.dimensions?.stat_time_day)))
        .map((r) => ({
        date: day(r.dimensions.stat_time_day),
        campaignId: String(r.dimensions.campaign_id),
        campaignName: r.metrics?.campaign_name ?? '',
        spend: money(num(r.metrics?.spend)),
        impressions: num(r.metrics?.impressions),
        clicks: num(r.metrics?.clicks),
        conversions: money(num(r.metrics?.complete_payment)),
        conversionValue: money(num(r.metrics?.total_complete_payment_rate)),
    }));
}
// Splits since..until into spans of at most 30 days, inclusive, because daily reports allow no more.
export function spans(since, until, max = MAX_SPAN_DAYS) {
    if (!DATE.test(since) || !DATE.test(until))
        throw new CliError('Dates must be YYYY-MM-DD.', 'cosmic sync', 'bad_value');
    const out = [];
    const end = Date.parse(`${until}T00:00:00Z`);
    for (let start = Date.parse(`${since}T00:00:00Z`); start <= end; start += max * 86400000) {
        const stop = Math.min(start + (max - 1) * 86400000, end);
        out.push([new Date(start).toISOString().slice(0, 10), new Date(stop).toISOString().slice(0, 10)]);
    }
    return out;
}
// Return codes from https://business-api.tiktok.com/portal/docs/return-codes/v2.0
// TikTok answers HTTP 200 with a code in the body, and the code wins over the HTTP status.
const TOKEN_CODES = new Set([40102, 40104, 40105, 40106]);
const RATE_CODES = new Set([40100, 40016, 40133]);
const ACCOUNT_CODES = new Set([40300, 40301]);
function refuse(code, message) {
    const detail = message ? `: ${message}` : '.';
    if (TOKEN_CODES.has(code))
        throw new CliError(`TikTok rejected the saved TikTok Ads token${detail}`, 'Ask the advertiser to authorize the app again for a new access token, then cosmic connect tiktok-ads --account ID --app-id ID --token-env NAME', 'key_rejected');
    if (RATE_CODES.has(code))
        throw new CliError('TikTok is rate limiting this app.', 'Wait five minutes, then run cosmic sync --only tiktok-ads again. The Basic app level allows 600 requests a minute.', 'rate_limited');
    if (code === 40001 || code === 40119)
        throw new CliError(`The token cannot read that TikTok ad account${detail}`, 'Check the advertiser id, and that the advertiser authorized this app with the Reporting permission. Then cosmic connect tiktok-ads again.', 'tiktok_ads_permission');
    if (ACCOUNT_CODES.has(code))
        throw new CliError(`TikTok cannot find that advertiser${detail}`, 'Check the advertiser id in TikTok Ads Manager, then cosmic connect tiktok-ads --account ID', 'tiktok_ads_account');
    throw new CliError(`TikTok answered with code ${code}${detail}`, code === 40002 || code === 40000 ? 'Check the advertiser id: cosmic connect tiktok-ads --account ID' : 'Run the command again, then cosmic doctor.', 'tiktok_ads_error');
}
function explainHttp(e) {
    if (e instanceof HttpError) {
        let code = 0;
        let message = '';
        try {
            const b = JSON.parse(e.body);
            code = Number(b?.code) || 0;
            message = String(b?.message ?? '');
        }
        catch { }
        if (code)
            refuse(code, message);
        if (e.status === 401)
            refuse(40105, message);
        if (e.status === 429)
            refuse(40100, message);
        if (e.status === 403)
            throw new CliError('TikTok refused the request.', 'cosmic doctor', 'tiktok_ads_permission');
        throw new CliError(`TikTok answered with status ${e.status}.`, 'Run the command again, then cosmic doctor.', 'tiktok_ads_error');
    }
    throw e;
}
export class TikTokAds {
    token;
    fetcher;
    account;
    constructor(token, account, fetcher = fetchJson) {
        this.token = token;
        this.fetcher = fetcher;
        this.account = normalizeAdvertiserId(account);
    }
    // GET only. Array parameters are JSON strings, as the reference shows.
    async get(path, params, label) {
        let body;
        try {
            body = await this.fetcher(`${API}${path}?${new URLSearchParams(params)}`, { method: 'GET', headers: { 'Access-Token': this.token } }, label);
        }
        catch (e) {
            explainHttp(e);
        }
        const code = Number(body?.code ?? 0);
        if (code !== 0)
            refuse(code, String(body?.message ?? ''));
        return body?.data ?? {};
    }
    // Proves the token can read this advertiser before anything is saved.
    async check() {
        const data = await this.get('/advertiser/info/', { advertiser_ids: JSON.stringify([this.account]), fields: JSON.stringify(['advertiser_id', 'name', 'currency', 'timezone', 'display_timezone']) }, 'TikTok account check');
        const a = (data.list ?? []).find((x) => String(x?.advertiser_id) === this.account) ?? data.list?.[0];
        if (!a)
            throw new CliError('TikTok returned no advertiser for that id.', 'Check the advertiser id in TikTok Ads Manager, then cosmic connect tiktok-ads --account ID', 'tiktok_ads_account');
        return { account: this.account, name: String(a.name ?? ''), currency: String(a.currency ?? '').toUpperCase(), timezone: String(a.display_timezone || a.timezone || '') };
    }
    // Daily campaign rows for since..until in the account's time zone. Splits the range into 30-day spans,
    // and follows page_info.total_page within each.
    async report(since, until) {
        const out = [];
        for (const [start, end] of spans(since, until)) {
            for (let page = 1; page <= 1000; page++) {
                const data = await this.get('/report/integrated/get/', {
                    advertiser_id: this.account,
                    report_type: 'BASIC',
                    data_level: 'AUCTION_CAMPAIGN',
                    dimensions: JSON.stringify(DIMENSIONS),
                    metrics: JSON.stringify(METRICS),
                    start_date: start,
                    end_date: end,
                    page: String(page),
                    page_size: String(PAGE_SIZE),
                }, 'TikTok campaign report');
                out.push(...(data.list ?? []));
                const total = Number(data.page_info?.total_page) || 1;
                if (page >= total)
                    break;
                if (page === 1000)
                    throw new CliError('TikTok kept sending pages past 1,000.', 'Run cosmic sync --only tiktok-ads again. If it repeats, report it: cosmic feedback', 'tiktok_ads_error');
            }
        }
        return out;
    }
}
