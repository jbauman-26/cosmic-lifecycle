import { fetchJson, HttpError } from '../http.js'
import { CliError } from '../errors.js'

// Google Ads, read only. Two report shapes: daily campaign totals and daily ad group totals,
// both read with GoogleAdsService.Search, which only reads. No mutate call exists in this file.
// https://developers.google.com/google-ads/api/rest/common/search
// The access token goes in the Authorization header. Developer tokens were retired on
// 2026-09-09 (access now follows the Cloud project that owns the OAuth client), so none is sent.
// https://developers.google.com/google-ads/api/docs/api-policy/developer-token
// No audiences, keywords, search terms, people or creative are read. Only names and numbers.

export const API_VERSION = 'v26'
const API = `https://googleads.googleapis.com/${API_VERSION}`
export const SCOPE = 'https://www.googleapis.com/auth/adwords'

// REST JSON sends int64 fields (ids, micros, impressions, clicks) as strings and doubles as numbers.
type Num = string | number | undefined
export type RawCampaignRow = {
  segments?: { date?: string }
  campaign?: { id?: string; name?: string }
  metrics?: { costMicros?: Num; impressions?: Num; clicks?: Num; conversions?: Num; conversionsValue?: Num }
}
export type RawAdGroupRow = RawCampaignRow & { adGroup?: { id?: string; name?: string } }

export type GoogleAdsDaily = {
  date: string
  campaignId: string
  campaignName: string
  cost: number
  impressions: number
  clicks: number
  conversions: number
  conversionsValue: number
}
export type GoogleAdsAdGroupDaily = GoogleAdsDaily & { adGroupId: string; adGroupName: string }
export type GoogleAdsAccount = { customer: string; name: string; currency: string; timezone: string; testAccount: boolean }

// Customer ids show as 123-456-7890 in the Google Ads UI. The API wants the ten digits.
export function normalizeCustomerId(raw: string): string {
  const digits = raw.trim().replace(/-/g, '')
  if (!/^\d{10}$/.test(digits)) throw new CliError('That is not a Google Ads customer id.', 'Use the ten digit id from the top of Google Ads, such as 123-456-7890.', 'google_ads_customer')
  return digits
}

const num = (v: Num) => Number(v) || 0
const money = (n: number) => Math.round(n * 100) / 100
// Conversions can be fractional under data-driven attribution, so they keep two decimals.
const two = (n: number) => Math.round(n * 100) / 100
const DATE = /^\d{4}-\d{2}-\d{2}$/

// Pure, so tests can pin every rule. Rows without a date or campaign are dropped.
const usable = (r: RawCampaignRow) => Boolean(r.campaign?.id && r.segments?.date && DATE.test(r.segments.date))

const daily = (r: RawCampaignRow): GoogleAdsDaily => ({
  date: r.segments!.date!,
  campaignId: String(r.campaign!.id),
  campaignName: r.campaign?.name ?? '',
  cost: money(num(r.metrics?.costMicros) / 1e6),
  impressions: num(r.metrics?.impressions),
  clicks: num(r.metrics?.clicks),
  conversions: two(num(r.metrics?.conversions)),
  conversionsValue: money(num(r.metrics?.conversionsValue)),
})

export function toCampaignDaily(rows: RawCampaignRow[]): GoogleAdsDaily[] {
  return rows.filter(usable).map(daily)
}

export function toAdGroupDaily(rows: RawAdGroupRow[]): GoogleAdsAdGroupDaily[] {
  return rows
    .filter((r) => usable(r) && r.adGroup?.id)
    .map((r) => ({ ...daily(r), adGroupId: String(r.adGroup!.id), adGroupName: r.adGroup?.name ?? '' }))
}

// Only these strings ever reach the query, and dates are checked first, so nothing outside can change it.
function dateRange(since: string, until: string) {
  if (!DATE.test(since) || !DATE.test(until)) throw new CliError('Dates must be YYYY-MM-DD.', 'cosmic sync', 'bad_value')
  return `segments.date BETWEEN '${since}' AND '${until}'`
}

export const campaignQuery = (since: string, until: string) =>
  `SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${dateRange(since, until)}`
export const adGroupQuery = (since: string, until: string) =>
  `SELECT segments.date, campaign.id, campaign.name, ad_group.id, ad_group.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM ad_group WHERE ${dateRange(since, until)}`
const CUSTOMER_QUERY = 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.test_account, customer.manager FROM customer LIMIT 1'

export async function googleAdsAccessToken(clientId: string, clientSecret: string, refreshToken: string, fetcher = fetchJson): Promise<string> {
  const body = await fetcher(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
    },
    'Google token request',
  ).catch((e: unknown) => {
    // A revoked refresh token, or one from a Testing-mode app older than seven days, comes back as invalid_grant.
    if (e instanceof HttpError && (e.status === 400 || e.status === 401) && /invalid_grant|invalid_client|unauthorized_client/.test(e.body)) {
      throw new CliError('Google rejected the saved Google Ads sign-in.', 'Sign in with Google again for a new refresh token, then cosmic connect google-ads --customer ID --client-id ID --secret-env NAME --refresh-token-env NAME', 'key_rejected')
    }
    throw e
  })
  if (!body?.access_token) throw new CliError('Google returned no access token.', 'cosmic doctor', 'key_rejected')
  return String(body.access_token)
}

// Google Ads puts the reason in error.details[].errors[].errorCode, such as { authorizationError: 'USER_PERMISSION_DENIED' }.
export function errorCodes(body: string): { status: string; message: string; codes: string[] } {
  try {
    const err = JSON.parse(body)?.error ?? {}
    const codes: string[] = []
    for (const d of err.details ?? []) for (const x of d?.errors ?? []) for (const v of Object.values(x?.errorCode ?? {})) codes.push(String(v))
    const first = (err.details ?? []).flatMap((d: any) => d?.errors ?? [])[0]?.message
    return { status: String(err.status ?? ''), message: String(first ?? err.message ?? ''), codes }
  } catch {
    return { status: '', message: '', codes: [] }
  }
}

function explain(e: unknown): never {
  if (e instanceof HttpError) {
    const { status, message, codes } = errorCodes(e.body)
    const has = (c: string) => codes.includes(c)
    const detail = message ? `: ${message}` : '.'
    if (e.status === 401 || status === 'UNAUTHENTICATED') throw new CliError(`Google Ads refused the sign-in${detail}`, 'Sign in with Google again, then cosmic connect google-ads', 'key_rejected')
    if (has('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION') || has('DEVELOPER_TOKEN_NOT_APPROVED')) {
      throw new CliError('This Google Cloud project only has Test access, so it can read test accounts only.', 'Use a Google Ads test account, or apply for Explorer access on the Google Ads API Overview page of the Cloud project.', 'google_ads_access_level')
    }
    if (has('USER_PERMISSION_DENIED')) throw new CliError(`The signed-in Google account cannot read that Google Ads account${detail}`, 'If access comes through a manager account, add --login-customer MANAGER_ID. Otherwise ask for access to the account.', 'google_ads_permission')
    if (has('CUSTOMER_NOT_ENABLED')) throw new CliError('That Google Ads account is not enabled (it may be cancelled or not set up yet).', 'Pick an active account, then cosmic connect google-ads again.', 'google_ads_permission')
    if (has('REQUESTED_METRICS_FOR_MANAGER')) throw new CliError('That is a manager account. Manager accounts have no campaign numbers of their own.', 'Connect a client account under it with --customer CLIENT_ID --login-customer MANAGER_ID.', 'google_ads_manager')
    if (e.status === 429 || status === 'RESOURCE_EXHAUSTED') throw new CliError('Google Ads is rate limiting this project.', 'Wait a few minutes, then run cosmic sync --only google-ads again. Explorer access allows 2,880 operations a day on live accounts.', 'rate_limited')
    if (e.status === 403 || status === 'PERMISSION_DENIED') throw new CliError(`Google Ads refused the request${detail}`, 'cosmic doctor', 'google_ads_permission')
    if (message) throw new CliError(`Google Ads answered with status ${e.status}${detail}`, e.status === 400 ? 'Check the customer id: cosmic connect google-ads --customer ID' : 'Run the command again, then cosmic doctor.', 'google_ads_error')
  }
  throw e
}

export class GoogleAds {
  readonly customer: string
  private login?: string
  constructor(private token: string, customer: string, loginCustomer?: string, private fetcher = fetchJson) {
    this.customer = normalizeCustomerId(customer)
    if (loginCustomer) this.login = normalizeCustomerId(loginCustomer)
  }

  // Search pages are a fixed 10,000 rows. Follows nextPageToken until there is none.
  async search(query: string, label: string): Promise<any[]> {
    const out: any[] = []
    let pageToken: string | undefined
    for (let page = 0; page < 1000; page++) {
      let body: any
      try {
        body = await this.fetcher(
          `${API}/customers/${this.customer}/googleAds:search`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}`, ...(this.login ? { 'login-customer-id': this.login } : {}) },
            body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
          },
          label,
        )
      } catch (e) {
        explain(e)
      }
      out.push(...(body?.results ?? []))
      const next = body?.nextPageToken
      if (!next || next === pageToken) return out
      pageToken = next
    }
    throw new CliError('Google Ads kept sending pages past 1,000.', 'Run cosmic sync --only google-ads again. If it repeats, report it: cosmic feedback', 'google_ads_error')
  }

  // Proves the sign-in can read this account before anything is saved, and refuses manager accounts.
  async check(): Promise<GoogleAdsAccount> {
    const [row] = await this.search(CUSTOMER_QUERY, 'Google Ads account check')
    const c = row?.customer ?? {}
    if (c.manager) throw new CliError('That is a manager account. Manager accounts have no campaign numbers of their own.', 'Connect a client account under it with --customer CLIENT_ID --login-customer MANAGER_ID.', 'google_ads_manager')
    return { customer: this.customer, name: String(c.descriptiveName ?? ''), currency: String(c.currencyCode ?? '').toUpperCase(), timezone: String(c.timeZone ?? ''), testAccount: Boolean(c.testAccount) }
  }

  campaigns(since: string, until: string): Promise<RawCampaignRow[]> {
    return this.search(campaignQuery(since, until), 'Google Ads campaign report')
  }

  adGroups(since: string, until: string): Promise<RawAdGroupRow[]> {
    return this.search(adGroupQuery(since, until), 'Google Ads ad group report')
  }
}
