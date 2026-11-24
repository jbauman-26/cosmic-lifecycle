import { fetchJson, HttpError } from '../http.js'
import { CliError } from '../errors.js'

// Meta Ads, read only. One request shape: daily campaign totals from the Ads Insights API.
// https://developers.facebook.com/docs/marketing-api/insights
// The token goes in the Authorization header, never in a URL, and paging uses the `after`
// cursor so the `paging.next` link Meta returns (which carries the token) is never followed.
// No audiences, people or creative are read. Only campaign names and numbers are kept.

const API = 'https://graph.facebook.com/v27.0'
const FIELDS = 'campaign_id,campaign_name,spend,impressions,clicks,actions,action_values'
const PAGE = 500
// Meta asks for smaller date ranges when a request is too heavy. Thirty days of daily
// campaign rows per request stays well inside that for most accounts.
const CHUNK_DAYS = 30

type ActionStat = { action_type: string; value: string }
export type RawInsight = {
  campaign_id: string
  campaign_name?: string
  date_start: string
  spend?: string
  impressions?: string
  clicks?: string
  actions?: ActionStat[]
  action_values?: ActionStat[]
}

export type MetaDaily = { date: string; campaignId: string; campaignName: string; spend: number; impressions: number; clicks: number; purchases: number; purchaseValue: number }
export type MetaAccount = { id: string; name: string; currency: string; timezone: string }

// Meta reports one purchase under several overlapping action types. Adding them would count
// the same order two or three times, so exactly one is read, in this order of preference.
export const PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']

export function purchaseStat(stats: ActionStat[] | undefined): number {
  for (const type of PURCHASE_TYPES) {
    const hit = stats?.find((s) => s.action_type === type)
    if (hit) return Number(hit.value) || 0
  }
  return 0
}

export function normalizeAccountId(raw: string): string {
  const digits = raw.trim().replace(/^act_/, '')
  if (!/^\d{5,20}$/.test(digits)) throw new CliError('That is not a Meta ad account id.', 'Use the number from Ads Manager, such as 1234567890 or act_1234567890.', 'meta_account')
  return `act_${digits}`
}

const money = (n: number) => Math.round(n * 100) / 100

// Pure, so tests can pin every rule. Meta sends numbers as strings.
export function toDaily(rows: RawInsight[]): MetaDaily[] {
  return rows
    .filter((r) => r.campaign_id && r.date_start)
    .map((r) => ({
      date: r.date_start,
      campaignId: String(r.campaign_id),
      campaignName: r.campaign_name ?? '',
      spend: money(Number(r.spend) || 0),
      impressions: Number(r.impressions) || 0,
      clicks: Number(r.clicks) || 0,
      purchases: purchaseStat(r.actions),
      purchaseValue: money(purchaseStat(r.action_values)),
    }))
}

// Splits [since, until] into ranges of at most `days` days, oldest first. Dates are YYYY-MM-DD.
export function dateChunks(since: string, until: string, days = CHUNK_DAYS): { since: string; until: string }[] {
  const out: { since: string; until: string }[] = []
  const end = Date.parse(`${until}T00:00:00Z`)
  for (let start = Date.parse(`${since}T00:00:00Z`); start <= end; start += days * 86400000) {
    out.push({ since: new Date(start).toISOString().slice(0, 10), until: new Date(Math.min(start + (days - 1) * 86400000, end)).toISOString().slice(0, 10) })
  }
  return out
}

// Meta puts the useful reason in the response body, under error.message and error.code.
function explain(e: unknown): never {
  if (e instanceof HttpError) {
    let detail = ''
    let code: number | undefined
    try {
      const err = JSON.parse(e.body)?.error
      detail = err?.message ?? ''
      code = err?.code
    } catch {
      // Not JSON: keep the status only.
    }
    // 190 is an expired or invalid token. 200 and 10 are missing permission. 100 is a bad parameter, often the account id.
    // 4, 17, 32, 613 and 80000 to 80014 are Meta's rate limits, which it often sends with status 400.
    if (code === 190 || e.status === 401) throw new CliError(`Meta refused the token${detail ? `: ${detail}` : '.'}`, 'Create a new system user token with ads_read, then lifecycle connect meta --account ID --token-env NAME', 'key_rejected')
    if (e.status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || (code !== undefined && code >= 80000 && code <= 80014)) {
      throw new CliError('Meta is rate limiting this token.', 'Wait a few minutes, then run lifecycle sync --only meta again.', 'rate_limited')
    }
    if (code === 200 || code === 10 || e.status === 403) throw new CliError(`This token cannot read that ad account${detail ? `: ${detail}` : '.'}`, 'Give the system user access to the ad account and the ads_read permission, then connect again.', 'meta_permission')
    if (detail) throw new CliError(`Meta answered with status ${e.status}: ${detail}`, e.status === 400 ? 'Check the ad account id: lifecycle connect meta --account ID --token-env NAME' : 'Run the command again, then lifecycle doctor.', 'meta_error')
  }
  throw e
}

export class MetaAds {
  private account: string
  constructor(private token: string, account: string, private fetcher = fetchJson) {
    this.account = normalizeAccountId(account)
  }

  private async get(path: string, params: Record<string, string>, label: string) {
    try {
      return await this.fetcher(`${API}/${path}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${this.token}` } }, label)
    } catch (e) {
      explain(e)
    }
  }

  // Proves the token can read this account and its insights before anything is saved.
  async check(): Promise<MetaAccount> {
    const a = await this.get(this.account, { fields: 'name,currency,timezone_name' }, 'Meta ad account check')
    const today = new Date().toISOString().slice(0, 10)
    await this.get(`${this.account}/insights`, { level: 'account', fields: 'spend', time_range: JSON.stringify({ since: today, until: today }), limit: '1' }, 'Meta insights check')
    return { id: this.account, name: String(a?.name ?? ''), currency: String(a?.currency ?? '').toUpperCase(), timezone: String(a?.timezone_name ?? '') }
  }

  // Daily campaign rows between two dates, both included. Walks every page of every chunk.
  async insights(since: string, until: string): Promise<RawInsight[]> {
    const out: RawInsight[] = []
    for (const range of dateChunks(since, until)) {
      let after: string | undefined
      for (;;) {
        const body = await this.get(`${this.account}/insights`, { level: 'campaign', time_increment: '1', fields: FIELDS, time_range: JSON.stringify(range), limit: String(PAGE), ...(after ? { after } : {}) }, 'Meta insights request')
        const page: RawInsight[] = body?.data ?? []
        out.push(...page)
        const next = body?.paging?.cursors?.after
        // Meta sends `paging.next` when another page exists. A full page with no `next` is asked about once
        // more anyway, so a missing link can cost one empty request but never drop rows.
        if (!page.length || !next || next === after || (!body?.paging?.next && page.length < PAGE)) break
        after = next
      }
    }
    return out
  }
}
