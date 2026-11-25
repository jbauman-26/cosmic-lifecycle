import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { analyticsUrl, API_VERSION, campaignsUrl, errorInfo, LinkedinAds, linkedinAccessToken, MAX_ELEMENTS, normalizeAccountId, toDaily } from '../src/sources/linkedin-ads.js'
import { syncLinkedinAds, writeLinkedinAds } from '../src/sync.js'
import { connectLinkedinAds } from '../src/commands/connect.js'
import { readConfig, writeConfig } from '../src/config.js'
import { workflowYaml } from '../src/deploy.js'
import { HttpError } from '../src/http.js'
import { NATIVE_SECRETS, NATIVE_TABLES, parseOnly } from '../src/native.js'

// Answer shapes follow the LinkedIn Marketing API reference for version 202611 (ads reporting, ad accounts,
// campaign search, error handling). They are written from the docs, not captured from a live account.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/linkedin-ads/${name}.json`, import.meta.url), 'utf8'))

const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken'
const ACCOUNT_URL = 'https://api.linkedin.com/rest/adAccounts/512345678'

type Call = { url: string; method: string; headers: Record<string, string>; body: any }
function fake(answers: unknown[]) {
  const calls: Call[] = []
  const queue = [...answers]
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body })
    const next = queue.shift()
    if (next === undefined) throw new Error(`unexpected request to ${url}`)
    if (next instanceof Error) throw next
    return next
  }) as any
  return { calls, fetcher }
}
const apiError = (name: string, status: number) => new HttpError('LinkedIn ad analytics', status, JSON.stringify(fixture(name)))
const names = new Map([['145282384', 'Pipeline: Ops leaders'], ['145282399', 'Retarget: site visitors']])

describe('account ids', () => {
  it('accepts the number and the URN', () => {
    expect(normalizeAccountId(' 512345678 ')).toBe('512345678')
    expect(normalizeAccountId('urn:li:sponsoredAccount:512345678')).toBe('512345678')
  })
  it('refuses anything else, so nothing odd reaches the URL', () => {
    for (const bad of ['', 'abc', '512345678/x', 'urn:li:organization:1', '1)&q=x']) expect(() => normalizeAccountId(bad)).toThrow(expect.objectContaining({ code: 'linkedin_ads_account' }))
  })
})

describe('rows', () => {
  it('maps daily campaign rows, turns BigDecimal strings into money, and adds names', () => {
    expect(toDaily(fixture('analytics').elements, names)).toEqual([
      { date: '2026-11-22', campaignId: '145282384', campaignName: 'Pipeline: Ops leaders', spend: 19.92, impressions: 165, clicks: 11, conversions: 2, conversionValue: 300 },
      { date: '2026-11-22', campaignId: '145282399', campaignName: 'Retarget: site visitors', spend: 0, impressions: 6, clicks: 0, conversions: 0, conversionValue: 0 },
      { date: '2026-11-23', campaignId: '145282384', campaignName: 'Pipeline: Ops leaders', spend: 22.5, impressions: 180, clicks: 14, conversions: 1, conversionValue: 0 },
    ])
  })
  it('drops rows with no day or no campaign URN, and keeps an unknown campaign with no name', () => {
    expect(toDaily([{ pivotValues: ['urn:li:sponsoredCampaign:1'] }, { dateRange: { start: { year: 2026, month: 1, day: 2 } }, pivotValues: ['urn:li:sponsoredCreative:9'] }], names)).toEqual([])
    expect(toDaily([{ dateRange: { start: { year: 2026, month: 1, day: 2 } }, pivotValues: ['urn:li:sponsoredCampaign:7'] }], names)[0]).toMatchObject({ date: '2026-01-02', campaignId: '7', campaignName: '' })
  })
  it('builds the analytics finder URL in Rest.li 2.0 syntax and refuses dates that are not dates', () => {
    expect(analyticsUrl('512345678', '2026-08-26', '2026-11-24')).toBe(
      'https://api.linkedin.com/rest/adAnalytics?q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY&dateRange=(start:(year:2026,month:8,day:26),end:(year:2026,month:11,day:24))&accounts=List(urn%3Ali%3AsponsoredAccount%3A512345678)&fields=dateRange,pivotValues,costInLocalCurrency,impressions,clicks,externalWebsiteConversions,conversionValueInLocalCurrency',
    )
    expect(() => analyticsUrl('512345678', '2026-01-01),x:(', '2026-11-24')).toThrow(/YYYY-MM-DD/)
    // No professional demographic pivot or member field is ever asked for.
    expect(analyticsUrl('1', '2026-01-01', '2026-01-02')).not.toMatch(/MEMBER_|approximateMemberReach/)
  })
})

describe('the API client', () => {
  it('reads the account with the version and Rest.li headers', async () => {
    const { calls, fetcher } = fake([fixture('account')])
    expect(await new LinkedinAds('tok', '512345678', fetcher).check()).toEqual({ account: '512345678', name: 'Northwind B2B', currency: 'USD', status: 'ACTIVE', test: false })
    expect(calls[0]).toMatchObject({ url: ACCOUNT_URL, method: 'GET' })
    expect(calls[0]!.headers).toEqual({ authorization: 'Bearer tok', 'linkedin-version': API_VERSION, 'x-restli-protocol-version': '2.0.0' })
    expect(API_VERSION).toBe('202611')
  })

  it('follows nextPageToken through the campaign list', async () => {
    const { calls, fetcher } = fake([fixture('campaigns-page1'), fixture('campaigns-page2')])
    expect(await new LinkedinAds('tok', '512345678', fetcher).campaignNames()).toEqual(names)
    expect(calls[0]!.url).toBe(campaignsUrl('512345678'))
    expect(calls[0]!.url).toContain('q=search&search=(status:(values:List(ACTIVE,PAUSED,ARCHIVED,COMPLETED,CANCELED,DRAFT,PENDING_DELETION,REMOVED)))&pageSize=1000')
    expect(calls[1]!.url).toBe(campaignsUrl('512345678', 'DgGerr1iVQreCJVjZDOW_grcp63nueBDipsS4DJpvJo'))
  })

  it('stops when LinkedIn repeats the same page token', async () => {
    const loop = { elements: [], metadata: { nextPageToken: 'same' } }
    const { calls, fetcher } = fake([loop, loop])
    await new LinkedinAds('tok', '1', fetcher).campaignNames()
    expect(calls).toHaveLength(2)
  })

  it('splits a window that reaches the 15,000 element cap and asks for each half', async () => {
    const full = { elements: Array.from({ length: MAX_ELEMENTS }, () => fixture('analytics').elements[0]) }
    const { calls, fetcher } = fake([full, fixture('analytics'), fixture('analytics')])
    const rows = await new LinkedinAds('tok', '512345678', fetcher).analytics('2026-11-01', '2026-11-10')
    expect(rows).toHaveLength(6)
    expect(calls.map((c) => /start:\(year:(\d+),month:(\d+),day:(\d+)\),end:\(year:\d+,month:\d+,day:(\d+)\)/.exec(c.url)!.slice(3).join('-'))).toEqual(['1-10', '1-5', '6-10'])
  })

  it('gives up on a single day that is still at the cap', async () => {
    const full = { elements: Array.from({ length: MAX_ELEMENTS }, () => ({})) }
    await expect(new LinkedinAds('tok', '1', fake([full]).fetcher).analytics('2026-11-01', '2026-11-01')).rejects.toMatchObject({ code: 'linkedin_ads_error' })
  })

  it('names the fix for each documented error', async () => {
    const cases: [HttpError, string][] = [
      [apiError('error-401', 401), 'key_rejected'],
      [apiError('error-403', 403), 'linkedin_ads_permission'],
      [new HttpError('x', 404, '{"status":404,"serviceErrorCode":0,"code":"NOT_FOUND","message":"Not Found"}'), 'linkedin_ads_account'],
      [new HttpError('x', 429, '{"status":429,"message":"Resource level throttle limit for calls to this resource is reached."}'), 'rate_limited'],
      [new HttpError('x', 426, '{"status":426,"code":"VERSION_DEPRECATED","message":"Requested version 20240101 is not active"}'), 'linkedin_ads_error'],
      [new HttpError('x', 400, '{"status":400,"code":"INVALID_VALUE_FOR_FIELD","message":"Invalid value for field"}'), 'linkedin_ads_error'],
    ]
    for (const [err, code] of cases) await expect(new LinkedinAds('tok', '1', fake([err]).fetcher).analytics('2026-11-01', '2026-11-02'), code).rejects.toMatchObject({ code })
    expect(errorInfo(JSON.stringify(fixture('error-403')))).toEqual({ message: expect.stringMatching(/Not enough permissions/), code: 'ACCESS_DENIED' })
    expect(errorInfo('nope')).toEqual({ message: '', code: '' })
  })
})

describe('sign-in', () => {
  it('trades the refresh token for an access token', async () => {
    const { calls, fetcher } = fake([{ access_token: 'AQX.fake', expires_in: 5184000, refresh_token: 'AQW.same', refresh_token_expires_in: 439200, scope: 'r_ads,r_ads_reporting' }])
    expect(await linkedinAccessToken('cid', 'csecret', 'AQW.same', fetcher)).toBe('AQX.fake')
    expect(calls[0]!.url).toBe(TOKEN_URL)
    expect(calls[0]!.body).toEqual({ grant_type: 'refresh_token', refresh_token: 'AQW.same', client_id: 'cid', client_secret: 'csecret' })
  })
  it('says to sign in again when the refresh token is expired or revoked', async () => {
    const { fetcher } = fake([new HttpError('LinkedIn token request', 400, '{"error":"invalid_request","error_description":"The provided authorization grant or refresh token is invalid, expired or revoked"}')])
    await expect(linkedinAccessToken('cid', 's', 'old', fetcher)).rejects.toMatchObject({ code: 'key_rejected', message: /LinkedIn Ads sign-in/ })
  })
})

describe('connect', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lc-liads-'))
    process.env.LIFECYCLE_HOME = home
    process.env.LIFECYCLE_NO_KEYCHAIN = '1'
    process.env.LI_TEST_SECRET = 'csecret'
    process.env.LI_TEST_REFRESH = 'rtoken'
    writeConfig({ database: { kind: 'local' } })
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'LI_TEST_SECRET', 'LI_TEST_REFRESH']) delete process.env[k]
  })
  const opts = { account: 'urn:li:sponsoredAccount:512345678', clientId: 'cid', secretEnv: 'LI_TEST_SECRET', refreshTokenEnv: 'LI_TEST_REFRESH' }

  it('checks the sign-in with one small read, then writes the account facts', async () => {
    const { calls, fetcher } = fake([{ access_token: 'AQX.fake' }, fixture('account')])
    const r = await connectLinkedinAds(opts, fetcher)
    expect(r).toMatchObject({ connected: true, account: '512345678', name: 'Northwind B2B', currency: 'USD', timezone: 'UTC', test: false, keyStorage: 'environment' })
    expect(r.keyEnv).toEqual(['LIFECYCLE_LINKEDIN_ADS_CLIENT_SECRET', 'LIFECYCLE_LINKEDIN_ADS_REFRESH_TOKEN'])
    expect(readConfig()['linkedin-ads']).toEqual({ account: '512345678', clientId: 'cid', name: 'Northwind B2B', currency: 'USD', timezone: 'UTC', test: false })
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, ACCOUNT_URL])
    expect(JSON.stringify(readConfig())).not.toMatch(/csecret|rtoken/)
  })

  it('writes nothing when the member cannot read the account', async () => {
    const { fetcher } = fake([{ access_token: 'AQX.fake' }, apiError('error-403', 403)])
    await expect(connectLinkedinAds(opts, fetcher)).rejects.toMatchObject({ code: 'linkedin_ads_permission' })
    expect(readConfig()['linkedin-ads']).toBeUndefined()
  })

  it('asks for the account and client id first', async () => {
    await expect(connectLinkedinAds({ clientId: 'cid' }, fake([]).fetcher)).rejects.toThrow(/ad account id and OAuth client id/)
  })
})

describe('sync', () => {
  let db: Db
  beforeEach(async () => {
    db = wrapPglite(await PGlite.create())
    await migrate(db)
  })
  afterEach(async () => db.close())

  const rows = async () => db.query(`SELECT date::text AS date, account_id, campaign_id, campaign_name, spend::float AS spend, conversions::float AS conversions, currency FROM fact_linkedin_ads_daily ORDER BY date, campaign_id`)
  const load = (raw: unknown[]) => ({ analytics: async () => raw as any[], campaignNames: async () => names })

  it('pulls the 90-day window and writes daily campaign rows in the account currency', async () => {
    const asked: string[] = []
    const r = await syncLinkedinAds(db, { analytics: async (s, u) => (asked.push(`${s}..${u}`), fixture('analytics').elements), campaignNames: async () => names }, { account: '512345678', currency: 'USD', today: '2026-11-24' })
    expect(asked).toEqual(['2026-08-26..2026-11-24'])
    expect(r).toMatchObject({ source: 'linkedin-ads', status: 'ok', rows: 3 })
    expect(await rows()).toEqual([
      { date: '2026-11-22', account_id: '512345678', campaign_id: '145282384', campaign_name: 'Pipeline: Ops leaders', spend: 19.92, conversions: 2, currency: 'USD' },
      { date: '2026-11-22', account_id: '512345678', campaign_id: '145282399', campaign_name: 'Retarget: site visitors', spend: 0, conversions: 0, currency: 'USD' },
      { date: '2026-11-23', account_id: '512345678', campaign_id: '145282384', campaign_name: 'Pipeline: Ops leaders', spend: 22.5, conversions: 1, currency: 'USD' },
    ])
  })

  it('replaces the window, keeps older days, and drops another account', async () => {
    const row = (date: string, id: string, cost: string) => ({ dateRange: { start: { year: +date.slice(0, 4), month: +date.slice(5, 7), day: +date.slice(8) } }, pivotValues: [`urn:li:sponsoredCampaign:${id}`], costInLocalCurrency: cost })
    await writeLinkedinAds(db, [row('2026-07-01', '1', '5'), row('2026-11-23', '2', '50'), row('2026-11-23', '3', '1')], new Map(), '2026-07-01', 'USD', '111')
    await syncLinkedinAds(db, load([row('2026-11-23', '2', '55')]), { account: '111', currency: 'USD', today: '2026-11-24' })
    expect((await rows()).map((r) => `${r.date} ${r.campaign_id} ${r.spend}`)).toEqual(['2026-07-01 1 5', '2026-11-23 2 55'])
    await syncLinkedinAds(db, load([row('2026-11-23', '9', '1')]), { account: '222', currency: 'EUR', today: '2026-11-24' })
    expect((await rows()).map((r) => `${r.account_id} ${r.campaign_id} ${r.currency}`)).toEqual(['222 9 EUR'])
  })

  it('warns when there is no activity, says why for a test account, and records a failure with its code', async () => {
    expect(await syncLinkedinAds(db, load([]), { account: '1', today: '2026-11-24' })).toMatchObject({ status: 'warning', rows: 0, detail: expect.stringMatching(/no campaign activity/) })
    expect(await syncLinkedinAds(db, load([]), { account: '1', test: true, today: '2026-11-24' })).toMatchObject({ status: 'warning', detail: expect.stringMatching(/test ad account/) })
    const li = new LinkedinAds('t', '512345678', fake([apiError('error-401', 401)]).fetcher)
    const failed = await syncLinkedinAds(db, { analytics: (s, u) => li.analytics(s, u), campaignNames: () => li.campaignNames() }, { account: '512345678', today: '2026-11-24' })
    expect(failed).toMatchObject({ source: 'linkedin-ads', status: 'failed', code: 'key_rejected' })
    expect(await db.query(`SELECT status, code FROM meta_sync_run WHERE source = 'linkedin-ads' ORDER BY started_at DESC LIMIT 1`)).toEqual([{ status: 'failed', code: 'key_rejected' }])
  })
})

describe('read only', () => {
  it('only ever sends GET to the API; the one POST is the token refresh', async () => {
    const { calls, fetcher } = fake([{ access_token: 'AQX.fake' }, fixture('account'), fixture('analytics'), fixture('campaigns-page1'), fixture('campaigns-page2')])
    const li = new LinkedinAds(await linkedinAccessToken('cid', 's', 'r', fetcher), '512345678', fetcher)
    await li.check()
    await li.analytics('2026-11-20', '2026-11-24')
    await li.campaignNames()
    expect(calls.filter((c) => c.method !== 'GET').map((c) => c.url)).toEqual([TOKEN_URL])
    for (const c of calls) expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain('x-restli-method')
    const src = readFileSync(new URL('../src/sources/linkedin-ads.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/PARTIAL_UPDATE|BATCH_CREATE|method: '(POST|PUT|DELETE)'[^\n]*api\.linkedin/)
    expect(src.match(/method: '(POST|PUT|DELETE|PATCH)'/g)).toEqual(["method: 'POST'"])
  })
})

describe('wiring', () => {
  it('is a built-in source with its own keys and table', () => {
    expect(parseOnly(['linkedin-ads'])).toEqual(['linkedin-ads'])
    expect(NATIVE_SECRETS['linkedin-ads']).toEqual(['linkedin-ads-client-secret', 'linkedin-ads-refresh-token'])
    expect(NATIVE_TABLES['linkedin-ads']).toEqual(['fact_linkedin_ads_daily'])
  })
  it('puts both LinkedIn secrets in the daily workflow only when connected', () => {
    const y = workflowYaml(false, false, [], false, false, false, false, false, true)
    expect(y).toContain('LIFECYCLE_LINKEDIN_ADS_CLIENT_SECRET: ${{ secrets.LIFECYCLE_LINKEDIN_ADS_CLIENT_SECRET }}')
    expect(y).toContain('LIFECYCLE_LINKEDIN_ADS_REFRESH_TOKEN: ${{ secrets.LIFECYCLE_LINKEDIN_ADS_REFRESH_TOKEN }}')
    expect(workflowYaml(false)).not.toContain('LINKEDIN_ADS')
  })
})
