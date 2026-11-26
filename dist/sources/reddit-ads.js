import { fetchJson, HttpError } from '../http.js';
import { CliError } from '../errors.js';
import { VERSION } from '../version.js';
// Reddit Ads, read only. Reddit Ads API v3, the latest Stable version: v4 is in Preview for Q4 2026,
// and v3 stays supported to the end of Q3 2027 (https://ads-api.reddit.com/docs/v3/guides/versioning).
// Only these calls are made, and none of them writes:
//   POST https://www.reddit.com/api/v1/access_token          trade the refresh token for an access token
//   GET  /api/v3/ad_accounts/{id}                             the account name, currency and time zone
//   GET  /api/v3/ad_accounts/{id}/campaigns                   campaign names, paged by pagination.next_url
//   POST /api/v3/ad_accounts/{id}/reports                     daily totals by campaign. POST only because the
//                                                             report request goes in the body; it creates nothing.
// https://ads-api.reddit.com/docs/v3/api/get-a-report
// The token carries the adsread scope only. No audiences, communities, keywords, posts, people or creative.
export const API_VERSION = 'v3';
const API = `https://ads-api.reddit.com/api/${API_VERSION}`;
const HOST = 'https://ads-api.reddit.com/';
export const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
export const SCOPE = 'adsread';
// Reddit asks every client to send its own User-Agent.
export const USER_AGENT = `node:cosmic-lifecycle:${VERSION} (read-only reporting)`;
// Ad account ids look like t2_123456 or a2_bzv32cgqp. Anything else never reaches a URL.
export function normalizeRedditAccountId(raw) {
    const id = raw.trim();
    if (!/^[a-z][0-9]_[a-z0-9]+$/i.test(id))
        throw new CliError('That is not a Reddit ad account id.', 'Use the id from Accounts in Reddit Ads Manager, such as a2_abc123 or t2_123456.', 'reddit_ads_account');
    return id;
}
const num = (v) => Number(v) || 0;
const money = (n) => Math.round(n * 100) / 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Pure, so tests can pin every rule. Reddit sends SPEND in millionths of the account currency and
// CONVERSION_PURCHASE_TOTAL_VALUE in hundredths, as its report docs say. Purchases are click-through
// plus view-through. Rows outside since..until are dropped, so a stray day at either edge never lands.
export function toRedditDaily(rows, names, since, until) {
    return rows
        .filter((r) => r.campaign_id && r.date && DATE.test(String(r.date).slice(0, 10)))
        .map((r) => ({ ...r, date: String(r.date).slice(0, 10) }))
        .filter((r) => r.date >= since && r.date <= until)
        .map((r) => ({
        date: r.date,
        campaignId: String(r.campaign_id),
        campaignName: names.get(String(r.campaign_id)) ?? '',
        spend: money(num(r.spend) / 1e6),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        conversions: num(r.conversion_purchase_clicks) + num(r.conversion_purchase_views),
        conversionValue: money(num(r.conversion_purchase_total_value) / 100),
    }));
}
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
// The report body. Dates are checked first, so nothing outside can change it.
export function reportBody(since, until, timezone) {
    if (!DATE.test(since) || !DATE.test(until))
        throw new CliError('Dates must be YYYY-MM-DD.', 'cosmic sync', 'bad_value');
    return {
        data: {
            breakdowns: ['CAMPAIGN_ID', 'DATE'],
            fields: ['SPEND', 'IMPRESSIONS', 'CLICKS', 'CONVERSION_PURCHASE_CLICKS', 'CONVERSION_PURCHASE_VIEWS', 'CONVERSION_PURCHASE_TOTAL_VALUE'],
            starts_at: `${since}T00:00:00Z`,
            ends_at: `${nextDay(until)}T00:00:00Z`,
            // Days follow the ad account's own time zone, the same days Ads Manager shows.
            ...(timezone ? { time_zone_id: timezone } : {}),
        },
    };
}
const basic = (clientId, secret) => `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
export async function redditAccessToken(clientId, clientSecret, refreshToken, fetcher = fetchJson) {
    const rejected = () => new CliError('Reddit rejected the saved Reddit Ads sign-in.', 'Sign in with Reddit again for a new refresh token, then cosmic connect reddit-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME', 'key_rejected');
    const body = await fetcher(TOKEN_URL, {
        method: 'POST',
        // Reddit wants the client id and secret as HTTP Basic auth, not in the form.
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(clientId, clientSecret), 'user-agent': USER_AGENT },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    }, 'Reddit token request').catch((e) => {
        if (e instanceof HttpError && (e.status === 400 || e.status === 401))
            throw rejected();
        throw e;
    });
    // Reddit can answer 200 with { "error": "invalid_grant" } for a revoked token.
    if (body?.error || !body?.access_token)
        throw rejected();
    return String(body.access_token);
}
// Reddit errors look like { "error": { "code": 403, "message": "...", "fields": [...] } }.
export function redditError(body) {
    try {
        const err = JSON.parse(body)?.error;
        const msg = typeof err === 'string' ? err : err?.message;
        return { message: msg ? String(msg) : '' };
    }
    catch {
        return { message: '' };
    }
}
function explain(e) {
    if (e instanceof HttpError) {
        const { message } = redditError(e.body);
        const detail = message ? `: ${message}` : '.';
        if (e.status === 401)
            throw new CliError(`Reddit Ads refused the sign-in${detail}`, 'Sign in with Reddit again, then cosmic connect reddit-ads', 'key_rejected');
        if (e.status === 403)
            throw new CliError(`The signed-in Reddit account cannot read that ad account${detail}`, 'Ask a business admin for at least reporting access to the ad account, or sign in as a member who has it.', 'reddit_ads_permission');
        if (e.status === 404)
            throw new CliError(`Reddit Ads has no ad account with that id${detail}`, 'Check the id under Accounts in Reddit Ads Manager, then cosmic connect reddit-ads --account ID', 'reddit_ads_account');
        if (e.status === 429)
            throw new CliError('Reddit Ads is rate limiting this app.', 'Wait a minute, then run cosmic sync --only reddit-ads again. Reports allow 60 requests a minute.', 'rate_limited');
        if (e.status === 410)
            throw new CliError('Reddit Ads API v3 has reached end of support.', 'Update the CLI: npm install -g cosmic-lifecycle', 'reddit_ads_error');
        throw new CliError(`Reddit Ads answered with status ${e.status}${detail}`, 'Run the command again, then cosmic doctor.', 'reddit_ads_error');
    }
    throw e;
}
export class RedditAds {
    token;
    fetcher;
    account;
    constructor(token, account, fetcher = fetchJson) {
        this.token = token;
        this.fetcher = fetcher;
        this.account = normalizeRedditAccountId(account);
    }
    headers(json = false) {
        return { authorization: `Bearer ${this.token}`, accept: 'application/json', 'user-agent': USER_AGENT, ...(json ? { 'content-type': 'application/json' } : {}) };
    }
    async call(url, init, label) {
        try {
            return await this.fetcher(url, init, label);
        }
        catch (e) {
            explain(e);
        }
    }
    // Follows pagination.next_url as Reddit says to, but only on Reddit's own API host, so a token never leaves it.
    async pages(first, init, label, rows) {
        const out = [];
        let url = first;
        const seen = new Set();
        for (let page = 0; page < 1000; page++) {
            seen.add(url);
            const body = await this.call(url, init, label);
            out.push(...rows(body));
            const next = body?.pagination?.next_url;
            if (!next || typeof next !== 'string' || seen.has(next))
                return out;
            if (!next.startsWith(HOST))
                throw new CliError('Reddit Ads sent a next page on another host.', 'Run cosmic sync --only reddit-ads again. If it repeats, report it: cosmic feedback', 'reddit_ads_error');
            url = next;
        }
        throw new CliError('Reddit Ads kept sending pages past 1,000.', 'Run cosmic sync --only reddit-ads again. If it repeats, report it: cosmic feedback', 'reddit_ads_error');
    }
    // Proves the sign-in can read this account before anything is saved.
    async check() {
        const body = await this.call(`${API}/ad_accounts/${this.account}`, { method: 'GET', headers: this.headers() }, 'Reddit Ads account check');
        const a = body?.data ?? {};
        return { account: this.account, name: String(a.name ?? ''), currency: String(a.currency ?? '').toUpperCase(), timezone: String(a.time_zone_id ?? '') };
    }
    async campaignNames() {
        const rows = await this.pages(`${API}/ad_accounts/${this.account}/campaigns?page.size=1000`, { method: 'GET', headers: this.headers() }, 'Reddit Ads campaign list', (b) => b?.data ?? []);
        return new Map(rows.filter((c) => c?.id).map((c) => [String(c.id), String(c.name ?? '')]));
    }
    report(since, until, timezone) {
        const body = JSON.stringify(reportBody(since, until, timezone));
        return this.pages(`${API}/ad_accounts/${this.account}/reports?page.size=1000`, { method: 'POST', headers: this.headers(true), body }, 'Reddit Ads report', (b) => b?.data?.metrics ?? []);
    }
}
