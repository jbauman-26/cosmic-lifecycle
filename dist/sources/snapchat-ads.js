import { fetchJson, HttpError } from '../http.js';
import { CliError } from '../errors.js';
// Snapchat Ads, read only. Snapchat Marketing API v1, the only version Snap publishes.
// Only these calls are made, and none of them writes:
//   POST https://accounts.snapchat.com/login/oauth2/access_token   trade the refresh token for an access token
//   GET  /v1/adaccounts/{id}                                       the account name, currency and time zone
//   GET  /v1/adaccounts/{id}/campaigns                             campaign names, paged by paging.next_link
//   GET  /v1/adaccounts/{id}/stats?granularity=DAY&breakdown=campaign   daily totals by campaign
// https://developers.snap.com/marketing-api/Ads-API/measurement
// Snap has no read-only scope: snapchat-marketing-api covers read and write, so the code only reads.
// No audiences, creatives, media, people or Snap Pixel events are read. Only names and numbers.
const API = 'https://adsapi.snapchat.com/v1';
const HOST = 'https://adsapi.snapchat.com/';
export const TOKEN_URL = 'https://accounts.snapchat.com/login/oauth2/access_token';
export const SCOPE = 'snapchat-marketing-api';
// DAY stats must start and end on the account's own midnight, at most 31 days per request.
export const MAX_DAYS = 31;
export const FIELDS = 'spend,impressions,swipes,conversion_purchases,conversion_purchases_value';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function normalizeSnapAccountId(raw) {
    const id = raw.trim().toLowerCase();
    if (!UUID.test(id))
        throw new CliError('That is not a Snapchat ad account id.', 'Use the ad account id from Snapchat Ads Manager, such as 22335ba6-7558-4100-9663-baca7adff5f2.', 'snapchat_ads_account');
    return id;
}
const num = (v) => Number(v) || 0;
const money = (n) => Math.round(n * 100) / 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// The calendar day an instant falls on in a time zone.
export function localDate(instant, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
    const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
}
function offsetMs(at, timezone) {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'UTC', timeZoneName: 'longOffset' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000 : 0;
}
// Midnight of a day in the account's time zone, as a UTC instant. Daylight saving is handled by asking
// the offset again at the answer, so the hour is right on the days the clocks change.
export function midnight(date, timezone) {
    const guess = Date.parse(`${date}T00:00:00Z`);
    let t = guess - offsetMs(guess, timezone);
    t = guess - offsetMs(t, timezone);
    return new Date(t).toISOString();
}
// Splits since..until (both included) into windows of at most 31 days, each [start, end) at local midnights.
export function windows(since, until, timezone) {
    if (!DATE.test(since) || !DATE.test(until))
        throw new CliError('Dates must be YYYY-MM-DD.', 'lifecycle sync', 'bad_value');
    const out = [];
    for (let from = since; from <= until; from = addDays(from, MAX_DAYS)) {
        const last = addDays(from, MAX_DAYS - 1) < until ? addDays(from, MAX_DAYS - 1) : until;
        out.push({ start: midnight(from, timezone), end: midnight(addDays(last, 1), timezone) });
    }
    return out;
}
// Pure, so tests can pin every rule. Snap sends spend and purchase value in micro-currency
// (millionths of the account currency). Swipes are Snap's clicks. Days outside since..until are dropped.
export function toSnapDaily(campaigns, names, timezone, since, until) {
    const out = [];
    for (const c of campaigns) {
        if (!c?.id)
            continue;
        for (const d of c.timeseries ?? []) {
            if (!d?.start_time || Number.isNaN(Date.parse(d.start_time)))
                continue;
            const date = localDate(d.start_time, timezone);
            if (date < since || date > until)
                continue;
            const s = d.stats ?? {};
            out.push({
                date,
                campaignId: String(c.id),
                campaignName: names.get(String(c.id)) ?? '',
                spend: money(num(s.spend) / 1e6),
                impressions: num(s.impressions),
                clicks: num(s.swipes),
                conversions: num(s.conversion_purchases),
                conversionValue: money(num(s.conversion_purchases_value) / 1e6),
            });
        }
    }
    return out;
}
export async function snapAccessToken(clientId, clientSecret, refreshToken, fetcher = fetchJson) {
    const rejected = () => new CliError('Snapchat rejected the saved Snapchat Ads sign-in.', 'Sign in with Snapchat again for a new refresh token, then lifecycle connect snapchat-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME', 'key_rejected');
    const body = await fetcher(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
    }, 'Snapchat token request').catch((e) => {
        if (e instanceof HttpError && (e.status === 400 || e.status === 401))
            throw rejected();
        throw e;
    });
    if (body?.error || !body?.access_token)
        throw rejected();
    return String(body.access_token);
}
// Snap errors look like { "request_status": "ERROR", "error_code": "E3002", "display_message": "...", "debug_message": "..." }.
export function snapError(body) {
    try {
        const b = JSON.parse(body) ?? {};
        return { code: String(b.error_code ?? ''), message: String(b.display_message ?? b.debug_message ?? '') };
    }
    catch {
        return { code: '', message: '' };
    }
}
function explain(e) {
    if (e instanceof HttpError) {
        const { code, message } = snapError(e.body);
        const detail = message ? `: ${message}` : '.';
        if (e.status === 401)
            throw new CliError(`Snapchat Ads refused the sign-in${detail}`, 'Sign in with Snapchat again, then lifecycle connect snapchat-ads', 'key_rejected');
        if (e.status === 403 || code === 'E3002')
            throw new CliError(`The signed-in Snapchat account cannot read that ad account${detail}`, 'Ask an organization admin for a role on the ad account that can see reports, or sign in as a member who has one.', 'snapchat_ads_permission');
        if (e.status === 404 || code === 'E3003')
            throw new CliError(`Snapchat Ads has no ad account with that id${detail}`, 'Check the id in Snapchat Ads Manager, then lifecycle connect snapchat-ads --account ID', 'snapchat_ads_account');
        if (e.status === 429)
            throw new CliError('Snapchat Ads is rate limiting this app.', 'Wait a minute, then run lifecycle sync --only snapchat-ads again.', 'rate_limited');
        if (code === 'E9001')
            throw new CliError('Snapchat said the report was too large to send in one answer.', 'Lower metrics.default_days, then run lifecycle sync --only snapchat-ads again. If it repeats, report it: lifecycle feedback', 'snapchat_ads_error');
        throw new CliError(`Snapchat Ads answered with status ${e.status}${detail}`, 'Run the command again, then lifecycle doctor.', 'snapchat_ads_error');
    }
    throw e;
}
export class SnapchatAds {
    token;
    fetcher;
    account;
    constructor(token, account, fetcher = fetchJson) {
        this.token = token;
        this.fetcher = fetcher;
        this.account = normalizeSnapAccountId(account);
    }
    async get(url, label) {
        try {
            return await this.fetcher(url, { method: 'GET', headers: { authorization: `Bearer ${this.token}` } }, label);
        }
        catch (e) {
            explain(e);
        }
    }
    // Follows paging.next_link, only on Snap's own API host, so a token never leaves it.
    async pages(first, label, rows) {
        const out = [];
        let url = first;
        const seen = new Set();
        for (let page = 0; page < 1000; page++) {
            seen.add(url);
            const body = await this.get(url, label);
            if (String(body?.request_status ?? '').toUpperCase() === 'ERROR')
                explain(new HttpError(label, 400, JSON.stringify(body)));
            out.push(...rows(body));
            const next = body?.paging?.next_link;
            if (!next || typeof next !== 'string' || seen.has(next))
                return out;
            if (!next.startsWith(HOST))
                throw new CliError('Snapchat Ads sent a next page on another host.', 'Run lifecycle sync --only snapchat-ads again. If it repeats, report it: lifecycle feedback', 'snapchat_ads_error');
            url = next;
        }
        throw new CliError('Snapchat Ads kept sending pages past 1,000.', 'Run lifecycle sync --only snapchat-ads again. If it repeats, report it: lifecycle feedback', 'snapchat_ads_error');
    }
    // Proves the sign-in can read this account before anything is saved.
    async check() {
        const body = await this.get(`${API}/adaccounts/${this.account}`, 'Snapchat Ads account check');
        const a = body?.adaccounts?.[0]?.adaccount;
        if (!a)
            throw new CliError('Snapchat Ads has no ad account with that id.', 'Check the id in Snapchat Ads Manager, then lifecycle connect snapchat-ads --account ID', 'snapchat_ads_account');
        return { account: this.account, name: String(a.name ?? ''), currency: String(a.currency ?? '').toUpperCase(), timezone: String(a.timezone ?? ''), organizationId: String(a.organization_id ?? '') };
    }
    async campaignNames() {
        const rows = await this.pages(`${API}/adaccounts/${this.account}/campaigns?limit=1000`, 'Snapchat Ads campaign list', (b) => (b?.campaigns ?? []).map((x) => x?.campaign));
        return new Map(rows.filter((c) => c?.id).map((c) => [String(c.id), String(c.name ?? '')]));
    }
    // One request per window of up to 31 days, each paged by campaign. Empty days are left out by Snap.
    async stats(since, until, timezone) {
        const out = [];
        for (const w of windows(since, until, timezone)) {
            const q = new URLSearchParams({ granularity: 'DAY', breakdown: 'campaign', fields: FIELDS, start_time: w.start, end_time: w.end, omit_empty: 'true', limit: '200' });
            out.push(...(await this.pages(`${API}/adaccounts/${this.account}/stats?${q}`, 'Snapchat Ads stats', (b) => (b?.timeseries_stats ?? []).flatMap((t) => t?.timeseries_stat?.breakdown_stats?.campaign ?? []))));
        }
        return out;
    }
}
