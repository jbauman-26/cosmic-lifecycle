import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { csvRows, faultCodes, MicrosoftAds, microsoftAdsAccessToken, normalizeId, pacificToday, parseCsv, reportRequest, toDaily, unzipFirst } from '../src/sources/microsoft-ads.js'
import { syncMicrosoftAds, writeMicrosoftAds } from '../src/sync.js'
import { connectMicrosoftAds, keepRotatedToken } from '../src/commands/connect.js'
import { readConfig, writeConfig } from '../src/config.js'
import { workflowYaml } from '../src/deploy.js'
import { HttpError } from '../src/http.js'
import { NATIVE_SECRETS, NATIVE_TABLES, parseOnly } from '../src/native.js'
import { envName } from '../src/secrets.js'

// Answer shapes follow the Bing Ads API v13 REST reference (Request JSON and Response JSON templates on each
// operation page, and the AdApiFaultDetail / ApiFaultDetail JSON syntax). They are written from the docs, not
// captured from a live account.
const dir = new URL('./fixtures/microsoft-ads/', import.meta.url)
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8'))
const reportCsv = () => readFileSync(new URL('report.csv', dir), 'utf8')

const ACCOUNT_URL = 'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13/Account/Query'
const SUBMIT_URL = 'https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/Submit'
const POLL_URL = 'https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/Poll'
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'

// A one-file ZIP, deflated, written the way any zip tool writes it. The reader does not check the CRC.
function zip(name: string, text: string): Uint8Array {
  const data = deflateRawSync(Buffer.from(text, 'utf8'))
  const raw = Buffer.byteLength(text, 'utf8')
  const fname = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw, 22); local.writeUInt16LE(fname.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw, 24); central.writeUInt16LE(fname.length, 28); central.writeUInt32LE(0, 42)
  const cdOffset = local.length + fname.length + data.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + fname.length, 12); end.writeUInt32LE(cdOffset, 16)
  return new Uint8Array(Buffer.concat([local, fname, data, central, fname, end]))
}

type Call = { url: string; method: string; headers: Record<string, string>; body: any }
function fake(answers: unknown[]) {
  const calls: Call[] = []
  const queue = [...answers]
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : JSON.parse(String(init.body)) })
    const next = queue.shift()
    if (next === undefined) throw new Error(`unexpected request to ${url}`)
    if (next instanceof Error) throw next
    return next
  }) as any
  return { calls, fetcher }
}
const fault = (name: string, status = 400) => new HttpError('Microsoft Advertising report request', status, JSON.stringify(fixture(name)))
const noWait = async () => {}
const downloads = (bytes = zip('report.csv', reportCsv())) => {
  const asked: string[] = []
  return { asked, download: async (url: string) => (asked.push(url), bytes) }
}

describe('ids', () => {
  it('accepts numbers', () => {
    expect(normalizeId(' 180012345 ', 'account')).toBe('180012345')
    expect(normalizeId('250012345', 'customer')).toBe('250012345')
  })
  it('refuses the account number and anything else, naming the right id', () => {
    expect(() => normalizeId('F123AB45', 'account')).toThrow(/account number/)
    for (const bad of ['', 'act_1', '12/3', '1 2']) expect(() => normalizeId(bad, 'account')).toThrow(/not a Microsoft Advertising account id/)
    expect(() => normalizeId('x', 'customer')).toThrow(expect.objectContaining({ code: 'microsoft_ads_account' }))
  })
})

describe('report files and rows', () => {
  it('reads quoted CSV with a BOM, commas and doubled quotes', () => {
    expect(parseCsv('﻿"a","b"\r\n"1,2","say ""hi"""\r\n')).toEqual([['a', 'b'], ['1,2', 'say "hi"']])
    expect(csvRows('')).toEqual([])
  })
  it('opens the zipped report and maps every column', () => {
    const rows = csvRows(unzipFirst(zip('Cosmic.csv', reportCsv())))
    expect(rows).toHaveLength(4)
    expect(toDaily(rows, '180012345')).toEqual([
      { date: '2026-11-22', accountId: '180012345', campaignId: '501', campaignName: 'Brand, exact', spend: 25.12, impressions: 900, clicks: 40, conversions: 3.5, conversionValue: 412.35, currency: 'USD' },
      { date: '2026-11-22', accountId: '180012345', campaignId: '502', campaignName: 'Shopping "Holiday"', spend: 10, impressions: 3100, clicks: 12, conversions: 0, conversionValue: 0, currency: 'USD' },
      // A thousands comma from format version 1.0 still parses, and the other account's row is dropped.
      { date: '2026-11-23', accountId: '180012345', campaignId: '501', campaignName: 'Brand, exact', spend: 1026, impressions: 950, clicks: 44, conversions: 4, conversionValue: 500, currency: 'USD' },
    ])
  })
  it('drops rows with no date or campaign, and falls back to the account currency', () => {
    expect(toDaily([{ CampaignId: '1' }, { TimePeriod: '2026-11-01' }, { TimePeriod: '11/1/2026', CampaignId: '1' }], '1')).toEqual([])
    expect(toDaily([{ TimePeriod: '2026-11-01', CampaignId: '1', Spend: '2' }], '1', 'eur')[0]!.currency).toBe('EUR')
  })
  it('refuses a file that is not a ZIP', () => {
    expect(() => unzipFirst(new Uint8Array(Buffer.from('not a zip at all, just text')))).toThrow(expect.objectContaining({ code: 'microsoft_ads_error' }))
  })
  it('builds a daily campaign report request and refuses dates that are not dates', () => {
    const r = reportRequest('180012345', '2026-08-26', '2026-11-24').ReportRequest
    expect(r).toMatchObject({ Type: 'CampaignPerformanceReportRequest', Aggregation: 'Daily', Format: 'Csv', FormatVersion: '2.0', ExcludeReportHeader: true, ExcludeReportFooter: true, ExcludeColumnHeaders: false, Scope: { AccountIds: ['180012345'] } })
    expect(r.Time).toEqual({ CustomDateRangeStart: { Year: 2026, Month: 8, Day: 26 }, CustomDateRangeEnd: { Year: 2026, Month: 11, Day: 24 } })
    expect(r.Columns).toEqual(['TimePeriod', 'AccountId', 'CampaignId', 'CampaignName', 'Spend', 'Impressions', 'Clicks', 'Conversions', 'Revenue', 'CurrencyCode'])
    expect(() => reportRequest('1', "2026-01-01' OR 1=1", '2026-11-24')).toThrow(/YYYY-MM-DD/)
    // Nothing personal or about targeting is asked for.
    expect(JSON.stringify(r)).not.toMatch(/Keyword|SearchQuery|Audience|Email|Phone|Address|Gender|Age/)
  })
  it('knows today in Pacific time, which the reporting service uses', () => {
    expect(pacificToday(new Date('2026-11-25T05:00:00Z'))).toBe('2026-11-24')
    expect(pacificToday(new Date('2026-11-25T09:00:00Z'))).toBe('2026-11-25')
  })
})

describe('the API client', () => {
  it('checks the account with GetAccount, the developer token and no account headers', async () => {
    const { calls, fetcher } = fake([fixture('account')])
    const ms = new MicrosoftAds('tok', 'devtok', '180012345', null, fetcher)
    expect(await ms.check()).toEqual({ account: '180012345', customer: '250012345', name: 'Northwind Search', currency: 'USD', timezone: 'PacificTimeUSCanadaTijuana', status: 'Active' })
    expect(calls[0]).toMatchObject({ url: ACCOUNT_URL, method: 'POST', body: { AccountId: '180012345' } })
    expect(calls[0]!.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer tok', developertoken: 'devtok' })
    // The customer defaults to the account's owner.
    expect(ms.customer).toBe('250012345')
  })

  it('keeps a customer given for an agency', async () => {
    const { fetcher } = fake([fixture('account')])
    const ms = new MicrosoftAds('tok', 'devtok', '180012345', '260000001', fetcher)
    expect((await ms.check()).customer).toBe('260000001')
  })

  it('submits, polls until ready, downloads and reads the report', async () => {
    const { calls, fetcher } = fake([fixture('submit'), fixture('poll-pending'), fixture('poll-pending'), fixture('poll-success')])
    const waits: number[] = []
    const d = downloads()
    const rows = await new MicrosoftAds('tok', 'devtok', '180012345', '250012345', fetcher, { download: d.download, wait: async (ms) => void waits.push(ms), today: '2026-11-24' }).campaigns('2026-11-20', '2026-11-24')
    expect(rows).toHaveLength(4)
    expect(calls.map((c) => c.url)).toEqual([SUBMIT_URL, POLL_URL, POLL_URL, POLL_URL])
    expect(calls[1]!.body).toEqual({ ReportRequestId: '30000001234_8a1b2c3d' })
    expect(calls[0]!.headers).toMatchObject({ authorization: 'Bearer tok', developertoken: 'devtok', customeraccountid: '180012345', customerid: '250012345' })
    expect(waits).toEqual([2000, 4000])
    expect(d.asked).toEqual(['https://bingadsappsstorageprod.blob.core.windows.net/download/report.zip?sig=abc'])
  })

  it('never asks for an end date later than today in Pacific time', async () => {
    const { calls, fetcher } = fake([fixture('submit'), fixture('poll-empty')])
    await new MicrosoftAds('tok', 'devtok', '180012345', '250012345', fetcher, { wait: noWait, today: '2026-11-24' }).campaigns('2026-08-26', '2026-11-25')
    expect(calls[0]!.body.ReportRequest.Time.CustomDateRangeEnd).toEqual({ Year: 2026, Month: 11, Day: 24 })
  })

  it('reads a finished report with no download link as no data', async () => {
    const { fetcher } = fake([fixture('submit'), fixture('poll-empty')])
    expect(await new MicrosoftAds('tok', 'devtok', '180012345', '250012345', fetcher, { wait: noWait, today: '2026-11-24' }).campaigns('2026-11-20', '2026-11-24')).toEqual([])
  })

  it('stops on a failed report, and on one that never finishes', async () => {
    const failed = new MicrosoftAds('tok', 'd', '1', '2', fake([fixture('submit'), fixture('poll-error')]).fetcher, { wait: noWait, today: '2026-11-24' })
    await expect(failed.campaigns('2026-11-20', '2026-11-24')).rejects.toMatchObject({ code: 'microsoft_ads_error' })
    const slow = new MicrosoftAds('tok', 'd', '1', '2', fake([fixture('submit'), ...Array(20).fill(fixture('poll-pending'))]).fetcher, { wait: noWait, maxWaitMs: 30_000, today: '2026-11-24' })
    await expect(slow.campaigns('2026-11-20', '2026-11-24')).rejects.toThrow(/not ready/)
  })

  it('names the fix for each documented error', async () => {
    const cases: [HttpError, string][] = [
      [fault('error-invalid-credentials'), 'key_rejected'],
      [new HttpError('x', 401, ''), 'key_rejected'],
      [fault('error-not-authorized'), 'microsoft_ads_permission'],
      [new HttpError('x', 403, '{}'), 'microsoft_ads_permission'],
      [fault('error-call-rate'), 'rate_limited'],
      [new HttpError('x', 429, ''), 'rate_limited'],
      [fault('error-invalid-account'), 'microsoft_ads_account'],
      [new HttpError('x', 500, '{"Type":"AdApiFaultDetail","Errors":[{"Code":0,"ErrorCode":"InternalError","Message":"An internal error has occurred."}]}'), 'microsoft_ads_error'],
    ]
    for (const [err, code] of cases) {
      const ms = new MicrosoftAds('tok', 'd', '180012345', '250012345', fake([err]).fetcher, { wait: noWait, today: '2026-11-24' })
      await expect(ms.campaigns('2026-11-20', '2026-11-24'), code).rejects.toMatchObject({ code })
    }
  })

  it('reads codes from both fault shapes', () => {
    expect(faultCodes(JSON.stringify(fixture('error-invalid-credentials')))).toMatchObject({ codes: [105], names: ['InvalidCredentials'] })
    expect(faultCodes(JSON.stringify(fixture('error-invalid-account')))).toMatchObject({ codes: [2035] })
    expect(faultCodes('not json')).toEqual({ codes: [], names: [], message: '' })
  })
})

describe('sign-in', () => {
  it('trades the refresh token for an access token with the msads.manage scope', async () => {
    const { calls, fetcher } = fake([{ token_type: 'Bearer', scope: 'https://ads.microsoft.com/msads.manage', expires_in: 3599, access_token: 'EwB.fake', refresh_token: 'M.R3_new' }])
    expect(await microsoftAdsAccessToken('cid', 'csecret', 'M.R3_old', fetcher)).toEqual({ accessToken: 'EwB.fake', refreshToken: 'M.R3_new' })
    expect(calls[0]!.url).toBe(TOKEN_URL)
    expect(calls[0]!.body).toEqual({ client_id: 'cid', client_secret: 'csecret', grant_type: 'refresh_token', refresh_token: 'M.R3_old', scope: 'https://ads.microsoft.com/msads.manage offline_access' })
  })
  it('says to sign in again when the grant is expired or revoked', async () => {
    const { fetcher } = fake([new HttpError('Microsoft token request', 400, '{"error":"invalid_grant","error_description":"AADSTS70000: The request was denied because one or more scopes requested are unauthorized or expired."}')])
    await expect(microsoftAdsAccessToken('cid', 's', 'old', fetcher)).rejects.toMatchObject({ code: 'key_rejected', message: /Microsoft Advertising sign-in/ })
  })
  it('keeps a newer refresh token, but never overwrites one set in the environment', () => {
    const saved: string[] = []
    const save = (_n: unknown, v: string) => void saved.push(v)
    expect(keepRotatedToken('microsoft-ads-refresh-token', 'new', 'old', save)).toBe(true)
    expect(keepRotatedToken('microsoft-ads-refresh-token', 'old', 'old', save)).toBe(false)
    expect(keepRotatedToken('microsoft-ads-refresh-token', null, 'old', save)).toBe(false)
    process.env[envName('microsoft-ads-refresh-token')] = 'old'
    try {
      expect(keepRotatedToken('microsoft-ads-refresh-token', 'newer', 'old', save)).toBe(false)
    } finally {
      delete process.env[envName('microsoft-ads-refresh-token')]
    }
    expect(saved).toEqual(['new'])
  })
})

describe('connect', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lc-msads-'))
    process.env.LIFECYCLE_HOME = home
    process.env.LIFECYCLE_NO_KEYCHAIN = '1'
    process.env.MS_TEST_SECRET = 'csecret'
    process.env.MS_TEST_REFRESH = 'rtoken'
    process.env.MS_TEST_DEV = 'devtok'
    writeConfig({ database: { kind: 'local' } })
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'MS_TEST_SECRET', 'MS_TEST_REFRESH', 'MS_TEST_DEV']) delete process.env[k]
  })
  const opts = { account: '180012345', clientId: 'cid', secretEnv: 'MS_TEST_SECRET', refreshTokenEnv: 'MS_TEST_REFRESH', developerTokenEnv: 'MS_TEST_DEV' }

  it('checks the sign-in with one small read, then writes the account facts', async () => {
    const { calls, fetcher } = fake([{ access_token: 'EwB.fake' }, fixture('account')])
    const r = await connectMicrosoftAds(opts, fetcher)
    expect(r).toMatchObject({ connected: true, account: '180012345', customer: '250012345', name: 'Northwind Search', currency: 'USD', timezone: 'PacificTimeUSCanadaTijuana', keyStorage: 'environment' })
    expect(r.keyEnv).toEqual(['LIFECYCLE_MICROSOFT_ADS_CLIENT_SECRET', 'LIFECYCLE_MICROSOFT_ADS_REFRESH_TOKEN', 'LIFECYCLE_MICROSOFT_ADS_DEVELOPER_TOKEN'])
    expect(readConfig()['microsoft-ads']).toEqual({ account: '180012345', customer: '250012345', clientId: 'cid', name: 'Northwind Search', currency: 'USD', timezone: 'PacificTimeUSCanadaTijuana' })
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, ACCOUNT_URL])
    // No secret, token or address ends up in the config.
    expect(JSON.stringify(readConfig())).not.toMatch(/csecret|rtoken|devtok|Example Way/)
  })

  it('writes nothing when the developer token is refused', async () => {
    const { fetcher } = fake([{ access_token: 'EwB.fake' }, fault('error-invalid-credentials')])
    await expect(connectMicrosoftAds(opts, fetcher)).rejects.toMatchObject({ code: 'key_rejected' })
    expect(readConfig()['microsoft-ads']).toBeUndefined()
  })

  it('asks for the ids first, and for all three keys', async () => {
    await expect(connectMicrosoftAds({ clientId: 'cid' }, fake([]).fetcher)).rejects.toThrow(/account id and OAuth client id/)
    await expect(connectMicrosoftAds({ account: '1', clientId: 'cid', secretEnv: 'MS_TEST_SECRET', refreshTokenEnv: 'MS_TEST_REFRESH' }, fake([]).fetcher)).rejects.toMatchObject({ code: 'missing_secret' })
  })
})

describe('sync', () => {
  let db: Db
  beforeEach(async () => {
    db = wrapPglite(await PGlite.create())
    await migrate(db)
  })
  afterEach(async () => db.close())

  const rows = async () => db.query(`SELECT date::text AS date, account_id, campaign_id, campaign_name, spend::float AS spend, conversions::float AS conversions, conversion_value::float AS conversion_value, currency FROM fact_microsoft_ads_daily ORDER BY date, campaign_id`)

  it('pulls the 90-day window and writes daily campaign rows', async () => {
    const asked: string[] = []
    const r = await syncMicrosoftAds(db, async (s, u) => (asked.push(`${s}..${u}`), csvRows(reportCsv())), { account: '180012345', currency: 'USD', today: '2026-11-24' })
    expect(asked).toEqual(['2026-08-26..2026-11-24'])
    expect(r).toMatchObject({ source: 'microsoft-ads', status: 'ok', rows: 3 })
    expect(await rows()).toEqual([
      { date: '2026-11-22', account_id: '180012345', campaign_id: '501', campaign_name: 'Brand, exact', spend: 25.12, conversions: 3.5, conversion_value: 412.35, currency: 'USD' },
      { date: '2026-11-22', account_id: '180012345', campaign_id: '502', campaign_name: 'Shopping "Holiday"', spend: 10, conversions: 0, conversion_value: 0, currency: 'USD' },
      { date: '2026-11-23', account_id: '180012345', campaign_id: '501', campaign_name: 'Brand, exact', spend: 1026, conversions: 4, conversion_value: 500, currency: 'USD' },
    ])
  })

  it('replaces the window, keeps older days, and drops another account', async () => {
    const row = (date: string, id: string, spend: string) => ({ TimePeriod: date, AccountId: '111', CampaignId: id, CampaignName: id, Spend: spend })
    await writeMicrosoftAds(db, [row('2026-07-01', 'old', '5'), row('2026-11-23', 'c1', '50'), row('2026-11-23', 'gone', '1')], '2026-07-01', 'USD', '111')
    await syncMicrosoftAds(db, async () => [row('2026-11-23', 'c1', '55')], { account: '111', currency: 'USD', today: '2026-11-24' })
    expect((await rows()).map((r) => `${r.date} ${r.campaign_id} ${r.spend}`)).toEqual(['2026-07-01 old 5', '2026-11-23 c1 55'])
    await syncMicrosoftAds(db, async () => [{ ...row('2026-11-23', 'b1', '1'), AccountId: '222' }], { account: '222', currency: 'EUR', today: '2026-11-24' })
    expect((await rows()).map((r) => `${r.account_id} ${r.campaign_id} ${r.currency}`)).toEqual(['222 b1 EUR'])
  })

  it('warns when there is no activity, and records a failure with its code', async () => {
    expect(await syncMicrosoftAds(db, async () => [], { account: '1', today: '2026-11-24' })).toMatchObject({ status: 'warning', rows: 0, detail: expect.stringMatching(/no campaign activity/) })
    const ms = new MicrosoftAds('t', 'd', '180012345', '250012345', fake([fault('error-not-authorized')]).fetcher, { wait: noWait, today: '2026-11-24' })
    const failed = await syncMicrosoftAds(db, (s, u) => ms.campaigns(s, u), { account: '180012345', today: '2026-11-24' })
    expect(failed).toMatchObject({ source: 'microsoft-ads', status: 'failed', code: 'microsoft_ads_permission' })
    expect(await db.query(`SELECT status, code FROM meta_sync_run WHERE source = 'microsoft-ads' ORDER BY started_at DESC LIMIT 1`)).toEqual([{ status: 'failed', code: 'microsoft_ads_permission' }])
  })
})

describe('read only', () => {
  it('calls only the token, GetAccount and reporting endpoints, and the download link', async () => {
    const { calls, fetcher } = fake([{ access_token: 'EwB.fake' }, fixture('account'), fixture('submit'), fixture('poll-success')])
    const d = downloads()
    const t = await microsoftAdsAccessToken('cid', 's', 'r', fetcher)
    const ms = new MicrosoftAds(t.accessToken, 'd', '180012345', null, fetcher, { download: d.download, wait: noWait, today: '2026-11-24' })
    await ms.check()
    await ms.campaigns('2026-11-20', '2026-11-24')
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, ACCOUNT_URL, SUBMIT_URL, POLL_URL])
    expect(d.asked).toHaveLength(1)
    // No Campaign Management, Bulk or Customer Billing service is ever called, and the code holds no such URL.
    const src = readFileSync(new URL('../src/sources/microsoft-ads.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/campaign\.api\.bingads|bulk\.api\.bingads|clientcenter\.api\.bingads\.microsoft\.com\/Billing|\/(Add|Update|Delete|Set|Apply)[A-Z]/)
  })
})

describe('wiring', () => {
  it('is a built-in source with its own keys and table', () => {
    expect(parseOnly(['microsoft-ads'])).toEqual(['microsoft-ads'])
    expect(NATIVE_SECRETS['microsoft-ads']).toEqual(['microsoft-ads-client-secret', 'microsoft-ads-refresh-token', 'microsoft-ads-developer-token'])
    expect(NATIVE_TABLES['microsoft-ads']).toEqual(['fact_microsoft_ads_daily'])
    expect(envName('microsoft-ads-developer-token')).toBe('LIFECYCLE_MICROSOFT_ADS_DEVELOPER_TOKEN')
  })
  it('puts all three Microsoft secrets in the daily workflow only when connected', () => {
    const y = workflowYaml(false, false, [], false, false, false, false, false, true)
    for (const n of ['CLIENT_SECRET', 'REFRESH_TOKEN', 'DEVELOPER_TOKEN']) expect(y).toContain(`LIFECYCLE_MICROSOFT_ADS_${n}: \${{ secrets.LIFECYCLE_MICROSOFT_ADS_${n} }}`)
    expect(workflowYaml(false)).not.toContain('MICROSOFT_ADS')
  })
})
