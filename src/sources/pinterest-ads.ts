import { fetchJson, HttpError } from '../http.js'
import { CliError } from '../errors.js'

// Pinterest Ads, read only, through the Pinterest REST API v5 (OpenAPI spec 5.32.0).
// https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml
// Calls made, and nothing else:
//   POST /v5/oauth/token                                   trades the refresh token for an access token
//   GET  /v5/ad_accounts/{id}                              the account name, currency and time zone
//   GET  /v5/ad_accounts/{id}/campaigns                    campaign ids and names
//   GET  /v5/ad_accounts/{id}/campaigns/analytics          daily campaign totals
// The token call is the only POST, and it changes nothing in the ad account. No create, update,
// delete or report job call exists in this file. The scope is ads:read, which only reads.
// No audiences, pins, creatives, keywords or people are read. Only campaign names and numbers.

const API = 'https://api.pinterest.com/v5'
export const SCOPE = 'ads:read'
// The synchronous analytics call reaches 90 days back from today (UTC) and takes up to 250 campaign ids.
export const MAX_DAYS_BACK = 89
const MAX_CAMPAIGNS = 250
const PAGE_SIZE = 250
// Archived campaigns still have spend in the window. Drafts never spend, so they are left out.
const STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED']
// Spend and checkout value come in micro units of the ad account's currency.
// Conversions are checkouts and the value is their checkout value: what Pinterest attributes to its ads.
export const COLUMNS = ['SPEND_IN_MICRO_DOLLAR', 'TOTAL_IMPRESSION', 'TOTAL_CLICKTHROUGH', 'TOTAL_CHECKOUT', 'TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR'] as const

type Num = string | number | undefined | null
export type RawAnalyticsRow = {
  CAMPAIGN_ID?: string
  DATE?: string
  SPEND_IN_MICRO_DOLLAR?: Num
  TOTAL_IMPRESSION?: Num
  TOTAL_CLICKTHROUGH?: Num
  TOTAL_CHECKOUT?: Num
  TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR?: Num
}
export type PinterestDaily = {
  date: string
  campaignId: string
  campaignName: string
  spend: number
  impressions: number
  clicks: number
  conversions: number
  conversionValue: number
}
export type PinterestAccount = { account: string; name: string; currency: string; timezone: string }
export type PinterestToken = { accessToken: string; refreshToken: string | null }

// The ad account id is the number in the Ads Manager address, such as 549755885175.
export function normalizeAdAccountId(raw: string): string {
  const id = raw.trim()
  if (!/^\d{1,18}$/.test(id)) throw new CliError('That is not a Pinterest ad account id.', 'Use the number in the Pinterest Ads Manager address, such as 549755885175.', 'pinterest_ads_account')
  return id
}

const num = (v: Num) => Number(v) || 0
const money = (n: number) => Math.round(n * 100) / 100
const DATE = /^\d{4}-\d{2}-\d{2}$/

// Pure, so tests can pin every rule. Rows without a date or campaign are dropped.
// "If a column has no value, it may not be returned", so a missing column counts as 0.
export function toDaily(rows: RawAnalyticsRow[], names: Map<string, string> = new Map()): PinterestDaily[] {
  return rows
    .filter((r) => r.CAMPAIGN_ID && DATE.test(String(r.DATE ?? '').slice(0, 10)))
    .map((r) => ({
      date: String(r.DATE).slice(0, 10),
      campaignId: String(r.CAMPAIGN_ID),
      campaignName: names.get(String(r.CAMPAIGN_ID)) ?? '',
      spend: money(num(r.SPEND_IN_MICRO_DOLLAR) / 1e6),
      impressions: num(r.TOTAL_IMPRESSION),
      clicks: num(r.TOTAL_CLICKTHROUGH),
      conversions: money(num(r.TOTAL_CHECKOUT)),
      conversionValue: money(num(r.TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR) / 1e6),
    }))
}

// The earliest start date the analytics call accepts, one day inside its 90-day limit.
export function clampSince(since: string, today: string): string {
  if (!DATE.test(since) || !DATE.test(today)) throw new CliError('Dates must be YYYY-MM-DD.', 'cosmic sync', 'bad_value')
  const floor = new Date(Date.parse(`${today}T00:00:00Z`) - MAX_DAYS_BACK * 86400000).toISOString().slice(0, 10)
  return since < floor ? floor : since
}

// Pinterest only issues continuous refresh tokens now: 60 days, and every refresh returns a new one.
// https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/
// The caller saves the new refresh token, or the saved one runs out 60 days after it was issued.
export async function pinterestAccessToken(clientId: string, clientSecret: string, refreshToken: string, fetcher = fetchJson): Promise<PinterestToken> {
  const body = await fetcher(
    `${API}/oauth/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPE }),
    },
    'Pinterest token request',
  ).catch((e: unknown) => {
    if (e instanceof HttpError && (e.status === 400 || e.status === 401 || e.status === 403)) {
      throw new CliError('Pinterest rejected the saved Pinterest Ads sign-in.', 'Sign in with Pinterest again for a new refresh token, then cosmic connect pinterest-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME', 'key_rejected')
    }
    throw e
  })
  if (!body?.access_token) throw new CliError('Pinterest returned no access token.', 'cosmic doctor', 'key_rejected')
  return { accessToken: String(body.access_token), refreshToken: body.refresh_token ? String(body.refresh_token) : null }
}

function explain(e: unknown): never {
  if (e instanceof HttpError) {
    let message = ''
    try {
      message = String(JSON.parse(e.body)?.message ?? '')
    } catch {}
    const detail = message ? `: ${message}` : '.'
    if (e.status === 401) throw new CliError(`Pinterest refused the sign-in${detail}`, 'Sign in with Pinterest again, then cosmic connect pinterest-ads', 'key_rejected')
    if (e.status === 403) throw new CliError(`The signed-in Pinterest user cannot read that ad account${detail}`, 'The user needs Owner, Admin, Analyst or Campaign Manager access to the ad account. Then cosmic connect pinterest-ads again.', 'pinterest_ads_permission')
    if (e.status === 404) throw new CliError(`Pinterest cannot find that ad account${detail}`, 'Check the ad account id in the Pinterest Ads Manager address, then cosmic connect pinterest-ads --account ID', 'pinterest_ads_account')
    if (e.status === 429) throw new CliError('Pinterest is rate limiting this app.', 'Wait a few minutes, then run cosmic sync --only pinterest-ads again. Trial access allows 1,000 analytics calls a day.', 'rate_limited')
    throw new CliError(`Pinterest answered with status ${e.status}${detail}`, e.status === 400 ? 'Check the ad account id: cosmic connect pinterest-ads --account ID' : 'Run the command again, then cosmic doctor.', 'pinterest_ads_error')
  }
  throw e
}

export class PinterestAds {
  readonly account: string
  constructor(private token: string, account: string, private fetcher = fetchJson) {
    this.account = normalizeAdAccountId(account)
  }

  // GET only. Array parameters repeat the name (campaign_ids, entity_statuses); columns is one comma list, as the spec says.
  private async get(path: string, params: [string, string][], label: string): Promise<any> {
    const qs = params.length ? `?${new URLSearchParams(params)}` : ''
    try {
      return await this.fetcher(`${API}/ad_accounts/${this.account}${path}${qs}`, { method: 'GET', headers: { authorization: `Bearer ${this.token}` } }, label)
    } catch (e) {
      explain(e)
    }
  }

  // Proves the sign-in can read this ad account before anything is saved.
  async check(): Promise<PinterestAccount> {
    const a = (await this.get('', [], 'Pinterest account check')) ?? {}
    return { account: this.account, name: String(a.name ?? ''), currency: String(a.currency ?? '').toUpperCase(), timezone: String(a.time_zone ?? '') }
  }

  // Every campaign that could have spend: active, paused and archived. Follows the bookmark until there is none.
  async campaigns(): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    let bookmark: string | undefined
    for (let page = 0; page < 1000; page++) {
      const body = await this.get('/campaigns', [['page_size', String(PAGE_SIZE)], ...STATUSES.map((s) => ['entity_statuses', s] as [string, string]), ...(bookmark ? [['bookmark', bookmark] as [string, string]] : [])], 'Pinterest campaign list')
      for (const c of body?.items ?? []) if (c?.id) names.set(String(c.id), String(c.name ?? ''))
      const next = body?.bookmark
      if (!next || next === bookmark) return names
      bookmark = next
    }
    throw new CliError('Pinterest kept sending pages past 1,000.', 'Run cosmic sync --only pinterest-ads again. If it repeats, report it: cosmic feedback', 'pinterest_ads_error')
  }

  // Daily campaign totals, 250 campaigns a call. timezone set means the account's own days, as Meta and Google use.
  async analytics(ids: string[], since: string, until: string, timezone = ''): Promise<RawAnalyticsRow[]> {
    if (!DATE.test(since) || !DATE.test(until)) throw new CliError('Dates must be YYYY-MM-DD.', 'cosmic sync', 'bad_value')
    const out: RawAnalyticsRow[] = []
    for (let i = 0; i < ids.length; i += MAX_CAMPAIGNS) {
      const params: [string, string][] = [
        ['start_date', since],
        ['end_date', until],
        ...ids.slice(i, i + MAX_CAMPAIGNS).map((id) => ['campaign_ids', id] as [string, string]),
        ['columns', COLUMNS.join(',')],
        ['granularity', 'DAY'],
        ...(timezone ? [['reporting_timezone', 'AD_ACCOUNT_TIME_ZONE'] as [string, string]] : []),
      ]
      const rows = await this.get('/campaigns/analytics', params, 'Pinterest campaign report')
      out.push(...(Array.isArray(rows) ? rows : []))
    }
    return out
  }

  // Campaign names and daily rows for since..until.
  async report(since: string, until: string, timezone = ''): Promise<{ rows: RawAnalyticsRow[]; names: Map<string, string> }> {
    const names = await this.campaigns()
    const rows = names.size ? await this.analytics([...names.keys()], since, until, timezone) : []
    return { rows, names }
  }
}
