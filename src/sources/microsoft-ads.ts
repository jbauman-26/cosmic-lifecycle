import { inflateRawSync } from 'node:zlib'
import { fetchJson, HttpError } from '../http.js'
import { CliError } from '../errors.js'

// Microsoft Advertising, read only. One report shape: daily campaign totals. It uses the Bing Ads API v13 REST
// endpoints, and every call here only reads:
//   POST https://login.microsoftonline.com/common/oauth2/v2.0/token                     refresh token for an access token
//   POST https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13/Account/Query  GetAccount (name, currency)
//   POST https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/Submit      queue a campaign report
//   POST https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/Poll        ask if it is ready
//   GET  the ReportDownloadUrl the poll returns                                           download the zipped CSV
// Submit and Poll are POST because that is how the reporting service takes a request; they create nothing in the
// account. No Campaign Management, Bulk or Customer Billing call exists in this file, so nothing can be changed.
// https://learn.microsoft.com/en-us/advertising/reporting-service/submitgeneratereport?view=bingads-13
// https://learn.microsoft.com/en-us/advertising/guides/request-download-report?view=bingads-13
// No audiences, keywords, search terms, people or creative are read. Only names and numbers.

const REPORTING = 'https://reporting.api.bingads.microsoft.com/Reporting/v13'
const CUSTOMER = 'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13'
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
export const SCOPE = 'https://ads.microsoft.com/msads.manage offline_access'

// The columns of the report, in order. Revenue is what the advertiser's own conversion goals report as value.
export const COLUMNS = ['TimePeriod', 'AccountId', 'CampaignId', 'CampaignName', 'Spend', 'Impressions', 'Clicks', 'Conversions', 'Revenue', 'CurrencyCode'] as const

export type RawReportRow = Partial<Record<(typeof COLUMNS)[number], string>>
export type MicrosoftAdsDaily = {
  date: string
  accountId: string
  campaignId: string
  campaignName: string
  spend: number
  impressions: number
  clicks: number
  conversions: number
  conversionValue: number
  currency: string
}
export type MicrosoftAdsAccount = { account: string; customer: string; name: string; currency: string; timezone: string; status: string }

// Account and customer ids are numbers. The account number (eight letters and digits, such as F123AB45) is a
// different thing and the API never takes it, so it is refused with a pointer to the right id.
export function normalizeId(raw: string, what: 'account' | 'customer'): string {
  const v = raw.trim()
  if (/^\d{1,19}$/.test(v)) return v
  const where = what === 'account' ? 'the aid= number in the Microsoft Advertising address bar' : 'the cid= number in the Microsoft Advertising address bar'
  const extra = what === 'account' && /^[A-Z0-9]{8}$/i.test(v) ? ' That looks like the account number, which the API does not use.' : ''
  throw new CliError(`That is not a Microsoft Advertising ${what} id.${extra}`, `Use ${where}.`, 'microsoft_ads_account')
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
// FormatVersion 2.0 drops the thousands comma, but strip it anyway so a 1.0 file still parses.
const num = (v: string | undefined) => Number(String(v ?? '').replace(/,/g, '')) || 0
const two = (n: number) => Math.round(n * 100) / 100

// Pure, so tests can pin every rule. Rows without a date or campaign, and rows for another account, are dropped.
export function toDaily(rows: RawReportRow[], account: string, fallbackCurrency = ''): MicrosoftAdsDaily[] {
  return rows
    .filter((r) => r.CampaignId && r.TimePeriod && DATE.test(r.TimePeriod) && (!r.AccountId || r.AccountId === account))
    .map((r) => ({
      date: r.TimePeriod!,
      accountId: account,
      campaignId: String(r.CampaignId),
      campaignName: r.CampaignName ?? '',
      spend: two(num(r.Spend)),
      impressions: num(r.Impressions),
      clicks: num(r.Clicks),
      conversions: two(num(r.Conversions)),
      conversionValue: two(num(r.Revenue)),
      currency: (r.CurrencyCode || fallbackCurrency).toUpperCase(),
    }))
}

// A small CSV reader: quoted fields, doubled quotes, commas and line breaks inside quotes, CRLF.
export function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((f) => f !== '')) out.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some((f) => f !== '')) out.push(row)
  return out
}

// The report has the column names on its first line (ExcludeColumnHeaders is false) and no header or footer text.
export function csvRows(text: string): RawReportRow[] {
  const [head, ...body] = parseCsv(text)
  if (!head) return []
  return body.map((cells) => Object.fromEntries(head.map((h, i) => [h.trim(), cells[i] ?? ''])) as RawReportRow)
}

// Report files are ZIP compressed. Reads the first file in the archive through the central directory, so a
// file written with a data descriptor (sizes after the data) still opens. No dependency needed.
export function unzipFirst(bytes: Uint8Array): string {
  const b = Buffer.from(bytes)
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  const bad = () => new CliError('Microsoft Advertising sent a report file that is not a ZIP archive.', 'Run lifecycle sync --only microsoft-ads again. If it repeats, report it: lifecycle feedback', 'microsoft_ads_error')
  if (eocd < 0 || b.readUInt16LE(eocd + 10) === 0) throw bad()
  const cd = b.readUInt32LE(eocd + 16)
  if (b.readUInt32LE(cd) !== 0x02014b50) throw bad()
  const method = b.readUInt16LE(cd + 10)
  const size = b.readUInt32LE(cd + 20)
  const local = b.readUInt32LE(cd + 42)
  if (b.readUInt32LE(local) !== 0x04034b50) throw bad()
  const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28)
  const data = b.subarray(start, start + size)
  if (method === 0) return data.toString('utf8')
  if (method === 8) return inflateRawSync(data).toString('utf8')
  throw bad()
}

const ymd = (d: string) => ({ Year: Number(d.slice(0, 4)), Month: Number(d.slice(5, 7)), Day: Number(d.slice(8, 10)) })

// The reporting service decides what "today" is in Pacific time when no ReportTimeZone is set, and an end date
// later than its today is refused. So the end date is never later than today in Los Angeles.
export function pacificToday(at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

// Only checked dates reach the request.
export function reportRequest(account: string, since: string, until: string) {
  if (!DATE.test(since) || !DATE.test(until)) throw new CliError('Dates must be YYYY-MM-DD.', 'lifecycle sync', 'bad_value')
  return {
    ReportRequest: {
      ExcludeColumnHeaders: false,
      ExcludeReportFooter: true,
      ExcludeReportHeader: true,
      Format: 'Csv',
      FormatVersion: '2.0',
      ReportName: 'Cosmic Lifecycle campaign daily',
      ReturnOnlyCompleteData: false,
      Type: 'CampaignPerformanceReportRequest',
      Aggregation: 'Daily',
      Columns: [...COLUMNS],
      Scope: { AccountIds: [account] },
      Time: { CustomDateRangeStart: ymd(since), CustomDateRangeEnd: ymd(until) },
    },
  }
}

export type TokenResult = { accessToken: string; refreshToken: string | null }

// Microsoft may hand back a new refresh token with each access token and asks that the old one be replaced
// (https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-get-tokens). It is returned so the
// caller can keep it.
export async function microsoftAdsAccessToken(clientId: string, clientSecret: string, refreshToken: string, fetcher = fetchJson): Promise<TokenResult> {
  const body = await fetcher(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPE }),
    },
    'Microsoft token request',
  ).catch((e: unknown) => {
    // A revoked or expired refresh token, a changed password, or a wrong client comes back as one of these.
    if (e instanceof HttpError && (e.status === 400 || e.status === 401) && /invalid_grant|invalid_client|unauthorized_client|invalid_request/.test(e.body)) {
      throw new CliError('Microsoft rejected the saved Microsoft Advertising sign-in.', 'Sign in with Microsoft again for a new refresh token, then lifecycle connect microsoft-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME --developer-token-env NAME', 'key_rejected')
    }
    throw e
  })
  if (!body?.access_token) throw new CliError('Microsoft returned no access token.', 'lifecycle doctor', 'key_rejected')
  return { accessToken: String(body.access_token), refreshToken: body.refresh_token ? String(body.refresh_token) : null }
}

// REST faults come as AdApiFaultDetail { Errors: [...] } or ApiFaultDetail { OperationErrors, BatchErrors },
// each error with a numeric Code and a symbolic ErrorCode.
export function faultCodes(body: string): { codes: number[]; names: string[]; message: string } {
  try {
    const f = JSON.parse(body) ?? {}
    const errs = [...(f.Errors ?? []), ...(f.OperationErrors ?? []), ...(f.BatchErrors ?? [])]
    return { codes: errs.map((e: any) => Number(e?.Code)).filter((n: number) => Number.isFinite(n)), names: errs.map((e: any) => String(e?.ErrorCode ?? '')), message: String(errs[0]?.Message ?? f.Message ?? '') }
  } catch {
    return { codes: [], names: [], message: '' }
  }
}

const AUTH = [105, 109]
const PERMISSION = [106, 2003]
const ACCOUNT = [1102, 2018, 2023, 2026, 2035, 2108]

function explain(e: unknown): never {
  if (e instanceof HttpError) {
    const { codes, message } = faultCodes(e.body)
    const has = (list: number[]) => codes.some((c) => list.includes(c))
    const detail = message ? `: ${message}` : '.'
    if (has(AUTH) || e.status === 401) throw new CliError(`Microsoft Advertising refused the sign-in or the developer token${detail}`, 'Check that the developer token is for production, not sandbox, then sign in with Microsoft again and lifecycle connect microsoft-ads', 'key_rejected')
    if (codes.includes(117) || e.status === 429) throw new CliError('Microsoft Advertising is rate limiting these calls.', 'Wait a minute, then run lifecycle sync --only microsoft-ads again.', 'rate_limited')
    if (has(PERMISSION)) throw new CliError(`The signed-in Microsoft user cannot read that account${detail}`, 'Check the account and customer ids, or ask for access to the account in Microsoft Advertising.', 'microsoft_ads_permission')
    if (has(ACCOUNT)) throw new CliError(`Microsoft Advertising does not know that account${detail}`, 'Use the aid= number from the Microsoft Advertising address bar: lifecycle connect microsoft-ads --account ID', 'microsoft_ads_account')
    if (e.status === 403) throw new CliError(`Microsoft Advertising refused the request${detail}`, 'lifecycle doctor', 'microsoft_ads_permission')
    throw new CliError(`Microsoft Advertising answered with status ${e.status}${detail}`, 'Run the command again, then lifecycle doctor.', 'microsoft_ads_error')
  }
  throw e
}

export type Download = (url: string) => Promise<Uint8Array>
const download: Download = async (url) => {
  const res = await fetch(url)
  if (!res.ok) throw new HttpError('Microsoft Advertising report download', res.status, (await res.text()).slice(0, 400))
  return new Uint8Array(await res.arrayBuffer())
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class MicrosoftAds {
  readonly account: string
  customer: string | null
  constructor(
    private token: string,
    private developerToken: string,
    account: string,
    customer: string | null,
    private fetcher = fetchJson,
    private opts: { download?: Download; wait?: (ms: number) => Promise<void>; maxWaitMs?: number; today?: string } = {},
  ) {
    this.account = normalizeId(account, 'account')
    this.customer = customer ? normalizeId(customer, 'customer') : null
  }

  private async post(url: string, body: unknown, label: string, withIds: boolean): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${this.token}`, developertoken: this.developerToken }
    if (withIds) {
      headers.customeraccountid = this.account
      if (this.customer) headers.customerid = this.customer
    }
    try {
      return await this.fetcher(url, { method: 'POST', headers, body: JSON.stringify(body) }, label)
    } catch (e) {
      explain(e)
    }
  }

  // GetAccount proves the sign-in and developer token can read this account before anything is saved. Only the
  // name, currency, time zone, status and owning customer id are kept; the rest of the answer is ignored.
  async check(): Promise<MicrosoftAdsAccount> {
    const body = await this.post(`${CUSTOMER}/Account/Query`, { AccountId: this.account }, 'Microsoft Advertising account check', false)
    const a = body?.Account
    if (!a?.Id) throw new CliError('Microsoft Advertising returned no account for that id.', 'Use the aid= number from the Microsoft Advertising address bar: lifecycle connect microsoft-ads --account ID', 'microsoft_ads_account')
    const parent = a.ParentCustomerId ? String(a.ParentCustomerId) : ''
    // The customer header is the manager account the user works from. Without one, it is the account's owner.
    this.customer ??= parent || null
    return { account: String(a.Id), customer: this.customer ?? '', name: String(a.Name ?? ''), currency: String(a.CurrencyCode ?? '').toUpperCase(), timezone: String(a.TimeZone ?? ''), status: String(a.AccountLifeCycleStatus ?? '') }
  }

  // Submit, poll until done, download, unzip, read. A finished report with no download link means no data.
  async campaigns(since: string, until: string): Promise<RawReportRow[]> {
    const today = this.opts.today ?? pacificToday()
    const end = until > today ? today : until
    if (since > end) return []
    const submitted = await this.post(`${REPORTING}/GenerateReport/Submit`, reportRequest(this.account, since, end), 'Microsoft Advertising report request', true)
    const id = submitted?.ReportRequestId
    if (!id) throw new CliError('Microsoft Advertising did not queue the report.', 'Run lifecycle sync --only microsoft-ads again.', 'microsoft_ads_error')
    const wait = this.opts.wait ?? sleep
    const maxWait = this.opts.maxWaitMs ?? 10 * 60_000
    let waited = 0
    for (let attempt = 0; ; attempt++) {
      const polled = await this.post(`${REPORTING}/GenerateReport/Poll`, { ReportRequestId: String(id) }, 'Microsoft Advertising report status', true)
      const status = String(polled?.ReportRequestStatus?.Status ?? '')
      if (status === 'Success') {
        const url = polled.ReportRequestStatus.ReportDownloadUrl
        if (!url) return []
        let bytes: Uint8Array
        try {
          bytes = await (this.opts.download ?? download)(String(url))
        } catch (e) {
          explain(e)
        }
        return csvRows(unzipFirst(bytes))
      }
      if (status !== 'Pending') throw new CliError(`Microsoft Advertising could not build the report (status ${status || 'unknown'}).`, 'Run lifecycle sync --only microsoft-ads again. If it repeats, report it: lifecycle feedback', 'microsoft_ads_error')
      // Most reports finish in seconds to minutes. Waits grow from 2 to 15 seconds.
      const ms = Math.min(15_000, 2000 * 2 ** Math.min(attempt, 3))
      if (waited + ms > maxWait) throw new CliError('The Microsoft Advertising report was not ready after 10 minutes.', 'Run lifecycle sync --only microsoft-ads again later.', 'microsoft_ads_error')
      await wait(ms)
      waited += ms
    }
  }
}
