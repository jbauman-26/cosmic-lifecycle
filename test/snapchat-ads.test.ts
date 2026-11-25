import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { FIELDS, localDate, midnight, normalizeSnapAccountId, snapAccessToken, SnapchatAds, snapError, toSnapDaily, TOKEN_URL, windows } from '../src/sources/snapchat-ads.js'
import { syncSnapchatAds, writeAdsDaily } from '../src/sync.js'
import { connectSnapchatAds } from '../src/commands/connect.js'
import { readConfig, writeConfig } from '../src/config.js'
import { workflowYaml } from '../src/deploy.js'
import { HttpError } from '../src/http.js'
import { NATIVE_SECRETS, NATIVE_TABLES, parseOnly } from '../src/native.js'
import { envName } from '../src/secrets.js'
import { PUBLIC_TABLES } from '../src/schema.js'

// Answer shapes follow the Snapchat Marketing API reference (Ad Accounts, Campaigns, Measurement).
// They are written from the docs, not captured from a live account.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/snapchat-ads/${name}.json`, import.meta.url), 'utf8'))
const ACCOUNT = '8adc3db7-8148-4fbf-999c-8d2266369d74'
const LA = 'America/Los_Angeles'
const C1 = 'c6a9e09a-7126-48e1-96e0-4dbf9ab8d3c2'
const C2 = '11162f29-85c7-4d43-a037-62d540487e29'

type Call = { url: string; method: string; headers: Record<string, string>; body: any }
function fake(answers: unknown[]) {
  const calls: Call[] = []
  const queue = [...answers]
  const fetcher = (async (url: string, init: RequestInit) => {
    const raw = init.body
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: raw instanceof URLSearchParams ? Object.fromEntries(raw) : raw ? JSON.parse(String(raw)) : undefined })
    const next = queue.shift()
    if (next === undefined) throw new Error(`unexpected request to ${url}`)
    if (next instanceof Error) throw next
    return next
  }) as any
  return { calls, fetcher }
}
const httpError = (status: number, name = 'error-permission') => new HttpError('Snapchat Ads stats', status, JSON.stringify(fixture(name)))
const statsCampaigns = (name: string) => fixture(name).timeseries_stats.flatMap((t: any) => t.timeseries_stat.breakdown_stats.campaign)

describe('ad account ids', () => {
  it('accepts a UUID in any case', () => {
    expect(normalizeSnapAccountId(` ${ACCOUNT.toUpperCase()} `)).toBe(ACCOUNT)
  })
  it('refuses anything else, so nothing odd reaches the URL', () => {
    for (const bad of ['', '12345', `${ACCOUNT}/stats`, 'act_123', `${ACCOUNT}x`]) expect(() => normalizeSnapAccountId(bad)).toThrow(/not a Snapchat ad account id/)
  })
})

describe('days in the account time zone', () => {
  it('finds local midnight, including across the daylight saving change', () => {
    expect(midnight('2026-11-22', LA)).toBe('2026-11-22T08:00:00.000Z')
    expect(midnight('2026-11-01', LA)).toBe('2026-11-01T07:00:00.000Z')
    expect(midnight('2026-11-02', LA)).toBe('2026-11-02T08:00:00.000Z')
    expect(midnight('2026-11-22', 'Asia/Kolkata')).toBe('2026-11-21T18:30:00.000Z')
    expect(midnight('2026-11-22', 'UTC')).toBe('2026-11-22T00:00:00.000Z')
    expect(localDate('2026-11-22T08:00:00.000Z', LA)).toBe('2026-11-22')
    expect(localDate('2026-11-22T07:59:59.000Z', LA)).toBe('2026-11-21')
  })
  it('splits the window into requests of at most 31 days that meet end to end', () => {
    const w = windows('2026-08-26', '2026-11-24', LA)
    expect(w).toHaveLength(3)
    expect(w[0]!.start).toBe('2026-08-26T07:00:00.000Z')
    expect(w[2]!.end).toBe('2026-11-25T08:00:00.000Z')
    for (let i = 1; i < w.length; i++) expect(w[i]!.start).toBe(w[i - 1]!.end)
    for (const x of w) expect(Date.parse(x.end) - Date.parse(x.start)).toBeLessThanOrEqual(31 * 86400000 + 3600000)
    expect(() => windows("2026-01-01' x", '2026-11-24', LA)).toThrow(/YYYY-MM-DD/)
  })
})

describe('rows', () => {
  const names = new Map([[C1, 'Holiday Sales'], [C2, 'Retargeting']])
  it('turns micro-currency into money, swipes into clicks, and dates into local days', () => {
    expect(toSnapDaily([...statsCampaigns('stats-page1'), ...statsCampaigns('stats-page2')], names, LA, '2026-11-01', '2026-11-24')).toEqual([
      { date: '2026-11-22', campaignId: C1, campaignName: 'Holiday Sales', spend: 144.21, impressions: 18294, clicks: 120, conversions: 3, conversionValue: 89.99 },
      { date: '2026-11-23', campaignId: C1, campaignName: 'Holiday Sales', spend: 120.98, impressions: 15377, clicks: 98, conversions: 0, conversionValue: 0 },
      { date: '2026-11-23', campaignId: C2, campaignName: 'Retargeting', spend: 5, impressions: 900, clicks: 4, conversions: 1, conversionValue: 25 },
    ])
  })
  it('drops campaigns with no id, days with no start, and days outside the window', () => {
    const raw = [{ timeseries: [{ start_time: '2026-11-22T08:00:00.000Z' }] }, { id: 'x', timeseries: [{}, { start_time: 'soon' }, { start_time: '2026-10-31T07:00:00.000Z' }, { start_time: '2026-11-25T08:00:00.000Z' }, { start_time: '2026-11-24T08:00:00.000Z', stats: { spend: 1000000 } }] }]
    expect(toSnapDaily(raw, new Map(), LA, '2026-11-01', '2026-11-24')).toEqual([{ date: '2026-11-24', campaignId: 'x', campaignName: '', spend: 1, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 }])
  })
})

describe('the API client', () => {
  it('reads the account with a bearer token', async () => {
    const { calls, fetcher } = fake([fixture('account')])
    expect(await new SnapchatAds('tok', ACCOUNT, fetcher).check()).toEqual({ account: ACCOUNT, name: 'Northwind Snap Ads', currency: 'USD', timezone: LA, organizationId: '40d6719b-da09-410b-9185-0cc9c0dfed1d' })
    expect(calls[0]).toMatchObject({ url: `https://adsapi.snapchat.com/v1/adaccounts/${ACCOUNT}`, method: 'GET', headers: { authorization: 'Bearer tok' } })
  })

  it('reads campaign names', async () => {
    const { calls, fetcher } = fake([fixture('campaigns')])
    expect([...(await new SnapchatAds('tok', ACCOUNT, fetcher).campaignNames())]).toEqual([[C1, 'Holiday Sales'], [C2, 'Retargeting']])
    expect(calls[0]!.url).toBe(`https://adsapi.snapchat.com/v1/adaccounts/${ACCOUNT}/campaigns?limit=1000`)
  })

  it('asks for DAY stats by campaign on local midnights and follows paging.next_link', async () => {
    const { calls, fetcher } = fake([fixture('stats-page1'), fixture('stats-page2')])
    const out = await new SnapchatAds('tok', ACCOUNT, fetcher).stats('2026-11-22', '2026-11-23', LA)
    expect(out.map((c) => c.id)).toEqual([C1, C2])
    const q = new URL(calls[0]!.url).searchParams
    expect(Object.fromEntries(q)).toEqual({ granularity: 'DAY', breakdown: 'campaign', fields: FIELDS, start_time: '2026-11-22T08:00:00.000Z', end_time: '2026-11-24T08:00:00.000Z', omit_empty: 'true', limit: '200' })
    expect(calls[1]!.url).toBe(fixture('stats-page1').paging.next_link)
    expect(FIELDS).not.toMatch(/uniques|frequency|pixel|audience/)
  })

  it('makes one request per 31-day window', async () => {
    const empty = { request_status: 'SUCCESS', timeseries_stats: [] }
    const { calls, fetcher } = fake([empty, empty, empty])
    await new SnapchatAds('tok', ACCOUNT, fetcher).stats('2026-08-26', '2026-11-24', LA)
    expect(calls).toHaveLength(3)
  })

  it('refuses a next page on another host', async () => {
    const away = { ...fixture('stats-page2'), paging: { next_link: 'https://evil.example/steal' } }
    await expect(new SnapchatAds('tok', ACCOUNT, fake([away]).fetcher).stats('2026-11-22', '2026-11-23', LA)).rejects.toMatchObject({ code: 'snapchat_ads_error' })
  })

  it('names the fix for each error', async () => {
    const cases: [HttpError, string, RegExp][] = [
      [new HttpError('x', 401, ''), 'key_rejected', /sign in/i],
      [httpError(403), 'snapchat_ads_permission', /role on the ad account/],
      [new HttpError('x', 404, JSON.stringify({ request_status: 'ERROR', error_code: 'E3003', display_message: 'Resource can not be found' })), 'snapchat_ads_account', /Snapchat Ads Manager/],
      [new HttpError('x', 429, ''), 'rate_limited', /Wait a minute/],
      [httpError(400, 'error-too-large'), 'snapchat_ads_error', /metrics\.default_days/],
      [new HttpError('x', 500, '{}'), 'snapchat_ads_error', /lifecycle doctor/],
    ]
    for (const [err, code, next] of cases) {
      await expect(new SnapchatAds('tok', ACCOUNT, fake([err]).fetcher).stats('2026-11-22', '2026-11-23', LA)).rejects.toSatisfy((e: any) => e.code === code && next.test(`${e.message} ${e.next}`))
    }
  })

  it('treats an ERROR body as an error even when the status is 200', async () => {
    await expect(new SnapchatAds('tok', ACCOUNT, fake([fixture('error-permission')]).fetcher).stats('2026-11-22', '2026-11-23', LA)).rejects.toMatchObject({ code: 'snapchat_ads_permission' })
  })

  it('reads the code out of an error body', () => {
    expect(snapError(JSON.stringify(fixture('error-permission')))).toMatchObject({ code: 'E3002' })
    expect(snapError('nope')).toEqual({ code: '', message: '' })
  })
})

describe('sign-in', () => {
  it('trades the refresh token with the client id and secret in the form', async () => {
    const { calls, fetcher } = fake([{ access_token: '0.MGQCxyz123', token_type: 'Bearer', expires_in: 3600, refresh_token: 'same', scope: 'snapchat-marketing-api' }])
    expect(await snapAccessToken('cid', 'csecret', 'rtoken', fetcher)).toBe('0.MGQCxyz123')
    expect(calls[0]!.url).toBe(TOKEN_URL)
    expect(calls[0]!.headers.authorization).toBeUndefined()
    expect(calls[0]!.body).toEqual({ grant_type: 'refresh_token', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtoken' })
  })
  it('says to sign in again when the refresh token is refused', async () => {
    await expect(snapAccessToken('a', 'b', 'old', fake([new HttpError('Snapchat token request', 400, '{"error":"invalid_grant"}')]).fetcher)).rejects.toMatchObject({ code: 'key_rejected', message: /Snapchat Ads sign-in/ })
    await expect(snapAccessToken('a', 'b', 'old', fake([{ error: 'invalid_grant' }]).fetcher)).rejects.toMatchObject({ code: 'key_rejected' })
  })
})

describe('sync', () => {
  let db: Db
  beforeEach(async () => {
    db = wrapPglite(await PGlite.create())
    await migrate(db)
  })
  afterEach(async () => db.close())

  const rows = async () => db.query(`SELECT date::text AS date, account_id, campaign_id, campaign_name, spend::float AS spend, clicks::float AS clicks, conversion_value::float AS conversion_value, currency FROM fact_snapchat_ads_daily ORDER BY date, campaign_id`)
  const names = async () => new Map([[C1, 'Holiday Sales']])

  it('pulls a 90-day window and writes daily campaign rows', async () => {
    const asked: string[] = []
    const r = await syncSnapchatAds(
      db,
      { names, stats: async (s, u) => (asked.push(`${s}..${u}`), [...statsCampaigns('stats-page1'), ...statsCampaigns('stats-page2')]) },
      { account: ACCOUNT, currency: 'USD', timezone: LA, today: '2026-11-24' },
    )
    expect(asked).toEqual(['2026-08-26..2026-11-24'])
    expect(r).toMatchObject({ source: 'snapchat-ads', status: 'ok', rows: 3 })
    expect(await rows()).toEqual([
      { date: '2026-11-22', account_id: ACCOUNT, campaign_id: C1, campaign_name: 'Holiday Sales', spend: 144.21, clicks: 120, conversion_value: 89.99, currency: 'USD' },
      { date: '2026-11-23', account_id: ACCOUNT, campaign_id: C2, campaign_name: '', spend: 5, clicks: 4, conversion_value: 25, currency: 'USD' },
      { date: '2026-11-23', account_id: ACCOUNT, campaign_id: C1, campaign_name: 'Holiday Sales', spend: 120.98, clicks: 98, conversion_value: 0, currency: 'USD' },
    ])
  })

  it('replaces the window, keeps older days, and drops another account', async () => {
    const day = (date: string, id: string, spend: number) => ({ date, campaignId: id, campaignName: id, spend, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 })
    await writeAdsDaily(db, 'fact_snapchat_ads_daily', [day('2026-07-01', 'old', 5), day('2026-11-23', 'c1', 50)], '2026-07-01', 'USD', ACCOUNT)
    await syncSnapchatAds(db, { names, stats: async () => [{ id: 'c1', timeseries: [{ start_time: '2026-11-23T08:00:00.000Z', stats: { spend: 55000000 } }] }] }, { account: ACCOUNT, currency: 'USD', timezone: LA, today: '2026-11-24' })
    expect((await rows()).map((r) => `${r.date} ${r.campaign_id} ${r.spend}`)).toEqual(['2026-07-01 old 5', '2026-11-23 c1 55'])
    const other = '22335ba6-7558-4100-9663-baca7adff5f2'
    await syncSnapchatAds(db, { names, stats: async () => [{ id: 'b1', timeseries: [{ start_time: '2026-11-23T08:00:00.000Z', stats: { spend: 1000000 } }] }] }, { account: other, currency: 'EUR', timezone: LA, today: '2026-11-24' })
    expect((await rows()).map((r) => `${r.account_id} ${r.campaign_id} ${r.currency}`)).toEqual([`${other} b1 EUR`])
  })

  it('warns when there is no activity, and records a failure with its code', async () => {
    expect(await syncSnapchatAds(db, { names, stats: async () => [] }, { account: ACCOUNT, timezone: LA, today: '2026-11-24' })).toMatchObject({ status: 'warning', rows: 0, detail: expect.stringMatching(/no campaign activity/) })
    const failed = await syncSnapchatAds(db, { names, stats: () => new SnapchatAds('t', ACCOUNT, fake([httpError(403)]).fetcher).stats('2026-11-01', '2026-11-02', LA) }, { account: ACCOUNT, timezone: LA, today: '2026-11-24' })
    expect(failed).toMatchObject({ source: 'snapchat-ads', status: 'failed', code: 'snapchat_ads_permission' })
  })
})

describe('connect', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lc-snap-'))
    process.env.LIFECYCLE_HOME = home
    process.env.LIFECYCLE_NO_KEYCHAIN = '1'
    process.env.SNAP_TEST_SECRET = 'snap_secret_not_real'
    process.env.SNAP_TEST_REFRESH = 'snap_refresh_not_real'
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'SNAP_TEST_SECRET', 'SNAP_TEST_REFRESH']) delete process.env[k]
    vi.unstubAllGlobals()
  })

  it('checks the sign-in with one small read, records the account, and makes no write call', async () => {
    writeConfig({ database: { kind: 'local' } })
    const seen: { url: string; method: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, method: String(init.method) })
      const body = url === TOKEN_URL ? { access_token: '0.abc', token_type: 'Bearer', expires_in: 3600, refresh_token: 'snap_refresh_not_real' } : fixture('account')
      return new Response(JSON.stringify(body), { status: 200 })
    }))
    const r = await connectSnapchatAds({ account: ACCOUNT, clientId: 'cid', secretEnv: 'SNAP_TEST_SECRET', refreshTokenEnv: 'SNAP_TEST_REFRESH' })
    expect(r).toMatchObject({ connected: true, account: ACCOUNT, name: 'Northwind Snap Ads', currency: 'USD', timezone: LA, organizationId: '40d6719b-da09-410b-9185-0cc9c0dfed1d', keyStorage: 'environment', keyEnv: ['LIFECYCLE_SNAPCHAT_ADS_CLIENT_SECRET', 'LIFECYCLE_SNAPCHAT_ADS_REFRESH_TOKEN'] })
    expect(JSON.stringify(r)).not.toMatch(/not_real/)
    expect(readConfig()['snapchat-ads']).toEqual({ account: ACCOUNT, clientId: 'cid', name: 'Northwind Snap Ads', currency: 'USD', timezone: LA, organizationId: '40d6719b-da09-410b-9185-0cc9c0dfed1d' })
    expect(seen).toEqual([{ url: TOKEN_URL, method: 'POST' }, { url: `https://adsapi.snapchat.com/v1/adaccounts/${ACCOUNT}`, method: 'GET' }])
  })

  it('refuses a missing id or secret before calling Snapchat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no call expected') }))
    await expect(connectSnapchatAds({ clientId: 'cid' })).rejects.toThrow(/ad account id and OAuth client id are required/)
    await expect(connectSnapchatAds({ account: ACCOUNT, clientId: 'cid', secretEnv: 'UNSET_SNAP_VAR' })).rejects.toMatchObject({ code: 'missing_secret' })
  })
})

describe('read only', () => {
  it('only ever sends GET to the Ads API', async () => {
    const { calls, fetcher } = fake([fixture('account'), fixture('campaigns'), fixture('stats-page1'), fixture('stats-page2')])
    const api = new SnapchatAds('tok', ACCOUNT, fetcher)
    await api.check()
    await api.campaignNames()
    await api.stats('2026-11-22', '2026-11-23', LA)
    expect(calls.every((c) => c.method === 'GET' && c.body === undefined)).toBe(true)
    const src = readFileSync(new URL('../src/sources/snapchat-ads.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/method: '(PUT|PATCH|DELETE)'/)
    // The only POST is the token request.
    expect(src.match(/method: 'POST'/g)).toHaveLength(1)
  })
})

describe('wiring', () => {
  it('is a built-in source with its own keys, table and environment names', () => {
    expect(parseOnly(['snapchat-ads'])).toEqual(['snapchat-ads'])
    expect(NATIVE_SECRETS['snapchat-ads']).toEqual(['snapchat-ads-client-secret', 'snapchat-ads-refresh-token'])
    expect(NATIVE_TABLES['snapchat-ads']).toEqual(['fact_snapchat_ads_daily'])
    expect(PUBLIC_TABLES).toContain('fact_snapchat_ads_daily')
    expect(envName('snapchat-ads-client-secret')).toBe('LIFECYCLE_SNAPCHAT_ADS_CLIENT_SECRET')
    expect(envName('snapchat-ads-refresh-token')).toBe('LIFECYCLE_SNAPCHAT_ADS_REFRESH_TOKEN')
  })
  it('puts both secrets in the daily workflow only when connected', () => {
    const y = workflowYaml(false, false, [], false, false, false, false, false, false, false, false, true)
    expect(y).toContain('LIFECYCLE_SNAPCHAT_ADS_CLIENT_SECRET: ${{ secrets.LIFECYCLE_SNAPCHAT_ADS_CLIENT_SECRET }}')
    expect(y).toContain('LIFECYCLE_SNAPCHAT_ADS_REFRESH_TOKEN: ${{ secrets.LIFECYCLE_SNAPCHAT_ADS_REFRESH_TOKEN }}')
    expect(workflowYaml(false)).not.toContain('SNAPCHAT')
  })
})
