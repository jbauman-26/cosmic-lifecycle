import { fetchJson, HttpError } from '../http.js'
import { CliError } from '../errors.js'

// LinkedIn Ads, read only. One report shape: daily campaign totals from the Marketing API, versioned REST.
// Every call here is a GET except the token refresh, and none of them writes:
//   POST https://www.linkedin.com/oauth/v2/accessToken                       refresh token for an access token
//   GET  https://api.linkedin.com/rest/adAccounts/{id}                         account name, currency, test flag
//   GET  https://api.linkedin.com/rest/adAccounts/{id}/adCampaigns?q=search    campaign names
//   GET  https://api.linkedin.com/rest/adAnalytics?q=analytics&pivot=CAMPAIGN  daily numbers by campaign
// https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting?view=li-lms-2026-11
// No audiences, creatives, member data or professional demographic pivots are read. Only names and numbers.

// The Marketing API wants a version on every call and keeps each one for at least a year.
// https://learn.microsoft.com/en-us/linkedin/marketing/versioning
export const API_VERSION = '202611'
const API = 'https://api.linkedin.com/rest'
export const SCOPES = ['r_ads', 'r_ads_reporting']
// adAnalytics has no paging and stops at 15,000 elements, so a window that reaches it is split in two.
export const MAX_ELEMENTS = 15_000
export const FIELDS = ['dateRange', 'pivotValues', 'costInLocalCurrency', 'impressions', 'clicks', 'externalWebsiteConversions', 'conversionValueInLocalCurrency'] as const

type Day = { year?: number; month?: number; day?: number }
// BigDecimal metrics come as strings such as "19.91833"; longs as numbers.
type Num = string | number | undefined
export type RawAnalytics = {
  dateRange?: { start?: Day; end?: Day }
  pivotValues?: string[]
  costInLocalCurrency?: Num
  impressions?: Num
  clicks?: Num
  externalWebsiteConversions?: Num
  conversionValueInLocalCurrency?: Num
}
export type RawCampaign = { id?: number | string; name?: string }
export type LinkedinAdsDaily = {
  date: string
  campaignId: string
  campaignName: string
  spend: number
  impressions: number
  clicks: number
  conversions: number
  conversionValue: number
}
export type LinkedinAdsAccount = { account: string; name: string; currency: string; status: string; test: boolean }

// The id shows in Campaign Manager's address bar (accounts/123456789). The URN form is accepted too.
export function normalizeAccountId(raw: string): string {
  const v = raw.trim().replace(/^urn:li:sponsoredAccount:/, '')
  if (!/^\d{1,19}$/.test(v)) throw new CliError('That is not a LinkedIn ad account id.', 'Use the number after accounts/ in the Campaign Manager address bar, such as 512345678.', 'linkedin_ads_account')
  return v
}

const num = (v: Num) => Number(v) || 0
const two = (n: number) => Math.round(n * 100) / 100
const DATE = /^\d{4}-\d{2}-\d{2}$/
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d?: Day) => (d?.year && d.month && d.day ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : '')
const CAMPAIGN = /^urn:li:sponsoredCampaign:(\d+)$/

// Pure, so tests can pin every rule. Rows without a day or a campaign URN are dropped. Names come from the
// campaign list; a campaign that is not in it (removed since) keeps an empty name.
export function toDaily(rows: RawAnalytics[], names: Map<string, string>): LinkedinAdsDaily[] {
  const out: LinkedinAdsDaily[] = []
  for (const r of rows) {
    const date = iso(r.dateRange?.start)
    const id = CAMPAIGN.exec(r.pivotValues?.[0] ?? '')?.[1]
    if (!id || !DATE.test(date)) continue
    out.push({
      date,
      campaignId: id,
      campaignName: names.get(id) ?? '',
      spend: two(num(r.costInLocalCurrency)),
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      conversions: two(num(r.externalWebsiteConversions)),
      conversionValue: two(num(r.conversionValueInLocalCurrency)),
    })
  }
  return out
}

// Rest.li 2.0 syntax. Only checked dates and the numeric account id reach the URL.
const restDate = (d: string) => `(year:${Number(d.slice(0, 4))},month:${Number(d.slice(5, 7))},day:${Number(d.slice(8, 10))})`
export function analyticsUrl(account: string, since: string, until: string) {
  if (!DATE.test(since) || !DATE.test(until)) throw new CliError('Dates must be YYYY-MM-DD.', 'cosmic sync', 'bad_value')
  return `${API}/adAnalytics?q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY&dateRange=(start:${restDate(since)},end:${restDate(until)})&accounts=List(${encodeURIComponent(`urn:li:sponsoredAccount:${normalizeAccountId(account)}`)})&fields=${FIELDS.join(',')}`
}
// Search criteria are required, so every campaign status is listed: removed campaigns still have history.
const STATUSES = 'ACTIVE,PAUSED,ARCHIVED,COMPLETED,CANCELED,DRAFT,PENDING_DELETION,REMOVED'
export const campaignsUrl = (account: string, pageToken?: string) =>
  `${API}/adAccounts/${normalizeAccountId(account)}/adCampaigns?q=search&search=(status:(values:List(${STATUSES})))&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`

const nextDay = (d: string, by = 1) => new Date(Date.parse(`${d}T00:00:00Z`) + by * 86400000).toISOString().slice(0, 10)
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)

// Programmatic refresh tokens last 365 days from the first sign-in, and refreshing does not extend that.
// https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
export async function linkedinAccessToken(clientId: string, clientSecret: string, refreshToken: string, fetcher = fetchJson): Promise<string> {
  const body = await fetcher(
    'https://www.linkedin.com/oauth/v2/accessToken',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    },
    'LinkedIn token request',
  ).catch((e: unknown) => {
    // An expired (past its year), revoked or wrong refresh token, or a wrong client, comes back as 400 or 401.
    if (e instanceof HttpError && (e.status === 400 || e.status === 401)) {
      throw new CliError('LinkedIn rejected the saved LinkedIn Ads sign-in.', 'Sign in with LinkedIn again for a new refresh token, then cosmic connect linkedin-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME', 'key_rejected')
    }
    throw e
  })
  if (!body?.access_token) throw new CliError('LinkedIn returned no access token.', 'cosmic doctor', 'key_rejected')
  return String(body.access_token)
}

// LinkedIn errors are { status, serviceErrorCode, code?, message }.
export function errorInfo(body: string): { message: string; code: string } {
  try {
    const e = JSON.parse(body) ?? {}
    return { message: String(e.message ?? ''), code: String(e.code ?? e.serviceErrorCode ?? '') }
  } catch {
    return { message: '', code: '' }
  }
}

function explain(e: unknown): never {
  if (e instanceof HttpError) {
    const { message } = errorInfo(e.body)
    const detail = message ? `: ${message}` : '.'
    if (e.status === 401) throw new CliError(`LinkedIn refused the sign-in${detail}`, 'Sign in with LinkedIn again, then cosmic connect linkedin-ads', 'key_rejected')
    if (e.status === 403) throw new CliError(`The signed-in LinkedIn member cannot read that ad account${detail}`, 'The member needs a role on the ad account (Viewer is enough), and the sign-in needs r_ads and r_ads_reporting.', 'linkedin_ads_permission')
    // LinkedIn also answers 404 when the app has no Advertising API access, so both causes are named.
    if (e.status === 404) throw new CliError(`LinkedIn does not know that ad account${detail}`, 'Check the id after accounts/ in Campaign Manager, and that the app is approved for the Advertising API.', 'linkedin_ads_account')
    if (e.status === 429) throw new CliError('LinkedIn is rate limiting this app.', 'Wait a few minutes, then run cosmic sync --only linkedin-ads again.', 'rate_limited')
    if (e.status === 426) throw new CliError(`LinkedIn no longer accepts Marketing API version ${API_VERSION}.`, 'Update Cosmic Lifecycle, then run cosmic sync --only linkedin-ads again.', 'linkedin_ads_error')
    throw new CliError(`LinkedIn answered with status ${e.status}${detail}`, 'Run the command again, then cosmic doctor.', 'linkedin_ads_error')
  }
  throw e
}

export class LinkedinAds {
  readonly account: string
  constructor(private token: string, account: string, private fetcher = fetchJson) {
    this.account = normalizeAccountId(account)
  }

  private async get(url: string, label: string): Promise<any> {
    try {
      return await this.fetcher(url, { method: 'GET', headers: { authorization: `Bearer ${this.token}`, 'linkedin-version': API_VERSION, 'x-restli-protocol-version': '2.0.0' } }, label)
    } catch (e) {
      explain(e)
    }
  }

  // Proves the sign-in can read this account before anything is saved.
  async check(): Promise<LinkedinAdsAccount> {
    const a = await this.get(`${API}/adAccounts/${this.account}`, 'LinkedIn ad account check')
    return { account: this.account, name: String(a?.name ?? ''), currency: String(a?.currency ?? '').toUpperCase(), status: String(a?.status ?? ''), test: Boolean(a?.test) }
  }

  // Search pages hold up to 1,000 campaigns. Follows metadata.nextPageToken until there is none.
  async campaignNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    let token: string | undefined
    for (let page = 0; page < 1000; page++) {
      const body = await this.get(campaignsUrl(this.account, token), 'LinkedIn campaign list')
      for (const c of (body?.elements ?? []) as RawCampaign[]) if (c.id !== undefined) names.set(String(c.id), String(c.name ?? ''))
      const next = body?.metadata?.nextPageToken
      if (!next || next === token) return names
      token = next
    }
    throw new CliError('LinkedIn kept sending campaign pages past 1,000.', 'Run cosmic sync --only linkedin-ads again. If it repeats, report it: cosmic feedback', 'linkedin_ads_error')
  }

  // One request per window. A window that comes back at the 15,000 element cap may be cut short, so it is
  // split in half and asked again, down to a single day.
  async analytics(since: string, until: string): Promise<RawAnalytics[]> {
    const body = await this.get(analyticsUrl(this.account, since, until), 'LinkedIn ad analytics')
    const rows = (body?.elements ?? []) as RawAnalytics[]
    if (rows.length < MAX_ELEMENTS) return rows
    if (since === until) throw new CliError(`LinkedIn returned its ${MAX_ELEMENTS.toLocaleString('en-US')} row limit for ${since} alone.`, 'Report it: cosmic feedback', 'linkedin_ads_error')
    const mid = nextDay(since, Math.floor(daysBetween(since, until) / 2))
    return [...(await this.analytics(since, mid)), ...(await this.analytics(nextDay(mid), until))]
  }
}
