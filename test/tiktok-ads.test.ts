import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { DIMENSIONS, METRICS, normalizeAdvertiserId, spans, TikTokAds, toDaily } from '../src/sources/tiktok-ads.js'
import { syncTiktokAds, writeTiktokAds } from '../src/sync.js'
import { connectTiktokAds } from '../src/commands/connect.js'
import { readConfig, writeConfig } from '../src/config.js'
import { workflowYaml } from '../src/deploy.js'
import { HttpError } from '../src/http.js'
import { NATIVE_SECRETS, NATIVE_TABLES, parseOnly } from '../src/native.js'
import { PUBLIC_TABLES } from '../src/schema.js'

// Answer shapes follow the TikTok API for Business v1.3 reference (advertiser/info and
// report/integrated/get, metric values as strings, codes in the body). Written from the docs,
// not captured from a live account.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/tiktok-ads/${name}.json`, import.meta.url), 'utf8'))
const ACCOUNT = '7123456789012345678'
const API = 'https://business-api.tiktok.com/open_api/v1.3'

type Call = { url: URL; method: string; headers: Record<string, string>; body: unknown }
function fake(answers: unknown[]) {
  const calls: Call[] = []
  const queue = [...answers]
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url: new URL(url), method: String(init.method), headers: init.headers as Record<string, string>, body: init.body })
    const next = queue.shift()
    if (next === undefined) throw new Error(`unexpected request to ${url}`)
    if (next instanceof Error) throw next
    return structuredClone(next)
  }) as any
  return { calls, fetcher }
}

describe('advertiser ids', () => {
  it('accepts the digits, trimmed', () => {
    expect(normalizeAdvertiserId(` ${ACCOUNT} `)).toBe(ACCOUNT)
  })
  it('refuses anything else, so nothing odd reaches the URL', () => {
    for (const bad of ['', '123', 'act_7123456789012345678', '7123456789012345678&x=1', '71234567890123456789012345']) expect(() => normalizeAdvertiserId(bad)).toThrow(/not a TikTok advertiser id/)
  })
})

describe('rows', () => {
  it('keeps the date part of stat_time_day and turns strings into numbers', () => {
    expect(toDaily(fixture('report-page1').data.list)).toEqual([
      { date: '2026-11-22', campaignId: '1800000000000001', campaignName: 'Spark Ads Prospecting', spend: 40.25, impressions: 12000, clicks: 180, conversions: 6, conversionValue: 512.4 },
      { date: '2026-11-22', campaignId: '1800000000000002', campaignName: 'Retargeting', spend: 12, impressions: 3100, clicks: 44, conversions: 0, conversionValue: 0 },
    ])
  })
  it('drops rows with no campaign or no day, and counts missing metrics as 0', () => {
    expect(toDaily([{ dimensions: { stat_time_day: '2026-11-01 00:00:00' } }, { dimensions: { campaign_id: '1' } }, { dimensions: { campaign_id: '1', stat_time_day: 'Nov 1' } }])).toEqual([])
    expect(toDaily([{ dimensions: { campaign_id: '9', stat_time_day: '2026-11-01' } }])).toEqual([{ date: '2026-11-01', campaignId: '9', campaignName: '', spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 }])
  })
})

describe('date guard', () => {
  it('splits a window into spans of at most 30 days', () => {
    expect(spans('2026-08-26', '2026-11-24')).toEqual([
      ['2026-08-26', '2026-09-24'],
      ['2026-09-25', '2026-10-24'],
      ['2026-10-25', '2026-11-23'],
      ['2026-11-24', '2026-11-24'],
    ])
    expect(spans('2026-11-24', '2026-11-24')).toEqual([['2026-11-24', '2026-11-24']])
    for (const [a, b] of spans('2026-01-01', '2026-12-31')) expect((Date.parse(b) - Date.parse(a)) / 86400000).toBeLessThan(30)
  })
  it('refuses dates that are not dates', () => {
    expect(() => spans("2026-01-01' OR 1=1", '2026-11-24')).toThrow(/YYYY-MM-DD/)
    expect(() => spans('2026-01-01', 'today')).toThrow(/YYYY-MM-DD/)
  })
})

describe('the API client', () => {
  it('reads the account with the token in the Access-Token header', async () => {
    const { calls, fetcher } = fake([fixture('advertiser-info')])
    expect(await new TikTokAds('tok', ACCOUNT, fetcher).check()).toEqual({ account: ACCOUNT, name: 'Northwind TikTok', currency: 'USD', timezone: 'America/Los_Angeles' })
    const c = calls[0]!
    expect(`${c.url.origin}${c.url.pathname}`).toBe(`${API}/advertiser/info/`)
    expect(c.method).toBe('GET')
    expect(c.headers).toEqual({ 'Access-Token': 'tok' })
    expect(JSON.parse(c.url.searchParams.get('advertiser_ids')!)).toEqual([ACCOUNT])
  })

  it('asks for a daily BASIC campaign report with only names and numbers', async () => {
    const one = fixture('report-page2')
    one.data.page_info.total_page = 1
    const { calls, fetcher } = fake([one])
    await new TikTokAds('tok', ACCOUNT, fetcher).report('2026-11-23', '2026-11-23')
    const q = calls[0]!.url.searchParams
    expect(calls[0]!.url.pathname).toBe('/open_api/v1.3/report/integrated/get/')
    expect(Object.fromEntries(q)).toMatchObject({ advertiser_id: ACCOUNT, report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN', start_date: '2026-11-23', end_date: '2026-11-23', page: '1', page_size: '1000' })
    expect(JSON.parse(q.get('dimensions')!)).toEqual([...DIMENSIONS])
    expect(JSON.parse(q.get('metrics')!)).toEqual([...METRICS])
    // Nothing personal or creative is ever asked for.
    for (const f of [...METRICS, ...DIMENSIONS]) expect(f).not.toMatch(/audience|creative|ad_text|video|image|comment|email|phone|^age|gender|identity/)
  })

  it('follows page_info.total_page, then moves to the next 30-day span', async () => {
    const single = fixture('report-page2')
    single.data.page_info = { page: 1, page_size: 1000, total_number: 1, total_page: 1 }
    const { calls, fetcher } = fake([fixture('report-page1'), fixture('report-page2'), single])
    const rows = await new TikTokAds('tok', ACCOUNT, fetcher).report('2026-10-01', '2026-11-05')
    // Span one has two pages, span two has one.
    expect(rows).toHaveLength(4)
    expect(calls.map((c) => `${c.url.searchParams.get('start_date')} ${c.url.searchParams.get('end_date')} p${c.url.searchParams.get('page')}`)).toEqual([
      '2026-10-01 2026-10-30 p1',
      '2026-10-01 2026-10-30 p2',
      '2026-10-31 2026-11-05 p1',
    ])
  })

  it('stops after one page when total_page is missing', async () => {
    const one = fixture('report-page2')
    delete one.data.page_info
    const { calls, fetcher } = fake([one])
    await new TikTokAds('tok', ACCOUNT, fetcher).report('2026-11-23', '2026-11-23')
    expect(calls).toHaveLength(1)
  })

  it('only ever reads: GET calls to two paths, and no call that changes anything', async () => {
    const { calls, fetcher } = fake([fixture('advertiser-info'), fixture('report-page1'), fixture('report-page2')])
    const api = new TikTokAds('tok', ACCOUNT, fetcher)
    await api.check()
    await api.report('2026-11-22', '2026-11-23')
    expect(calls).toHaveLength(3)
    for (const c of calls) {
      expect(c.method).toBe('GET')
      expect(c.body).toBeUndefined()
      expect(['/open_api/v1.3/advertiser/info/', '/open_api/v1.3/report/integrated/get/']).toContain(c.url.pathname)
    }
    // The client has no method that could write.
    const methods = Object.getOwnPropertyNames(TikTokAds.prototype).filter((m) => m !== 'constructor')
    expect(methods.sort()).toEqual(['check', 'get', 'report'])
  })

  it('names the fix for each documented return code, even on HTTP 200', async () => {
    const cases: [unknown, string, RegExp][] = [
      [fixture('error-token'), 'key_rejected', /authorize the app again/],
      [fixture('error-permission'), 'tiktok_ads_permission', /Reporting permission/],
      [fixture('error-rate'), 'rate_limited', /five minutes/],
      [fixture('error-advertiser'), 'tiktok_ads_account', /advertiser id/],
      [{ code: 40002, message: 'Invalid parameter.', data: {} }, 'tiktok_ads_error', /advertiser id/],
      [{ code: 50000, message: 'System error.', data: {} }, 'tiktok_ads_error', /again/],
      [new HttpError('TikTok campaign report', 401, ''), 'key_rejected', /authorize/],
      [new HttpError('TikTok campaign report', 429, ''), 'rate_limited', /five minutes/],
      [new HttpError('TikTok campaign report', 404, '<html>'), 'tiktok_ads_error', /again/],
    ]
    for (const [answer, code, next] of cases) {
      const p = new TikTokAds('tok', ACCOUNT, fake([answer]).fetcher).report('2026-11-22', '2026-11-23')
      await expect(p).rejects.toSatisfy((e: any) => e.code === code && next.test(`${e.message} ${e.next}`))
    }
  })

  it('says so when TikTok returns no advertiser for the id', async () => {
    const { fetcher } = fake([{ code: 0, message: 'OK', data: { list: [] } }])
    await expect(new TikTokAds('tok', ACCOUNT, fetcher).check()).rejects.toMatchObject({ code: 'tiktok_ads_account' })
  })
})

describe('connect', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lc-tiktok-'))
    process.env.LIFECYCLE_HOME = home
    process.env.LIFECYCLE_NO_KEYCHAIN = '1'
    process.env.TIKTOK_TEST_TOKEN = 'longterm-token'
    writeConfig({ database: { kind: 'local' } })
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'TIKTOK_TEST_TOKEN']) delete process.env[k]
  })

  it('checks the token, then writes the account, app id, name, currency and time zone', async () => {
    const { calls, fetcher } = fake([fixture('advertiser-info')])
    const r = await connectTiktokAds({ account: ACCOUNT, appId: '7000000000000000001', tokenEnv: 'TIKTOK_TEST_TOKEN' }, fetcher)
    expect(r).toMatchObject({ connected: true, account: ACCOUNT, appId: '7000000000000000001', name: 'Northwind TikTok', currency: 'USD', timezone: 'America/Los_Angeles', keyStorage: 'environment' })
    expect(r.keyEnv).toEqual(['LIFECYCLE_TIKTOK_ADS_ACCESS_TOKEN'])
    expect(readConfig()['tiktok-ads']).toEqual({ account: ACCOUNT, clientId: '7000000000000000001', name: 'Northwind TikTok', currency: 'USD', timezone: 'America/Los_Angeles' })
    expect(calls).toHaveLength(1)
    // The token is never written to the config.
    expect(JSON.stringify(readConfig())).not.toMatch(/longterm-token/)
  })

  it('writes nothing when the token cannot read the account', async () => {
    const { fetcher } = fake([fixture('error-permission')])
    await expect(connectTiktokAds({ account: ACCOUNT, appId: '1', tokenEnv: 'TIKTOK_TEST_TOKEN' }, fetcher)).rejects.toMatchObject({ code: 'tiktok_ads_permission' })
    expect(readConfig()['tiktok-ads']).toBeUndefined()
  })

  it('asks for the advertiser id and app id first, and refuses a token with spaces', async () => {
    await expect(connectTiktokAds({ appId: '1' }, fake([]).fetcher)).rejects.toThrow(/advertiser id and TikTok app id/)
    process.env.TIKTOK_TEST_TOKEN = 'two words'
    await expect(connectTiktokAds({ account: ACCOUNT, appId: '1', tokenEnv: 'TIKTOK_TEST_TOKEN' }, fake([]).fetcher)).rejects.toMatchObject({ code: 'bad_token' })
  })
})

describe('sync', () => {
  let db: Db
  beforeEach(async () => {
    db = wrapPglite(await PGlite.create())
    await migrate(db)
  })
  afterEach(async () => db.close())

  const rows = async () => db.query(`SELECT date::text AS date, account_id, campaign_id, campaign_name, spend::float AS spend, conversions::float AS conversions, conversion_value::float AS value, currency FROM fact_tiktok_ads_daily ORDER BY date, campaign_id`)
  const raw = (date: string, id: string, spend: string) => ({ dimensions: { campaign_id: id, stat_time_day: `${date} 00:00:00` }, metrics: { campaign_name: id, spend } })

  it('pulls a 90-day window and writes daily campaign rows', async () => {
    const asked: string[] = []
    const r = await syncTiktokAds(db, async (s, u) => (asked.push(`${s}..${u}`), [...fixture('report-page1').data.list, ...fixture('report-page2').data.list]), { account: ACCOUNT, currency: 'USD', today: '2026-11-24' })
    expect(asked).toEqual(['2026-08-26..2026-11-24'])
    expect(r).toMatchObject({ source: 'tiktok-ads', status: 'ok', rows: 3 })
    expect(await rows()).toEqual([
      { date: '2026-11-22', account_id: ACCOUNT, campaign_id: '1800000000000001', campaign_name: 'Spark Ads Prospecting', spend: 40.25, conversions: 6, value: 512.4, currency: 'USD' },
      { date: '2026-11-22', account_id: ACCOUNT, campaign_id: '1800000000000002', campaign_name: 'Retargeting', spend: 12, conversions: 0, value: 0, currency: 'USD' },
      { date: '2026-11-23', account_id: ACCOUNT, campaign_id: '1800000000000001', campaign_name: 'Spark Ads Prospecting', spend: 41, conversions: 7, value: 600, currency: 'USD' },
    ])
  })

  it('replaces the window, keeps older days, and drops another account', async () => {
    await writeTiktokAds(db, [raw('2026-07-01', 'old', '5'), raw('2026-11-23', 'c1', '50'), raw('2026-11-23', 'gone', '1')], '2026-07-01', 'USD', '1111111')
    await syncTiktokAds(db, async () => [raw('2026-11-23', 'c1', '55')], { account: '1111111', currency: 'USD', today: '2026-11-24' })
    expect((await rows()).map((r) => `${r.date} ${r.campaign_id} ${r.spend}`)).toEqual(['2026-07-01 old 5', '2026-11-23 c1 55'])
    await syncTiktokAds(db, async () => [raw('2026-11-23', 'b1', '1')], { account: '2222222', currency: 'EUR', today: '2026-11-24' })
    expect((await rows()).map((r) => `${r.account_id} ${r.campaign_id} ${r.currency}`)).toEqual(['2222222 b1 EUR'])
  })

  it('warns when there is no activity, and records a failure with its code', async () => {
    expect(await syncTiktokAds(db, async () => [], { account: ACCOUNT, today: '2026-11-24' })).toMatchObject({ status: 'warning', rows: 0, detail: expect.stringMatching(/no campaign activity/) })
    const failed = await syncTiktokAds(db, (s, u) => new TikTokAds('t', ACCOUNT, fake([fixture('error-token')]).fetcher).report(s, u), { account: ACCOUNT, today: '2026-11-24' })
    expect(failed).toMatchObject({ source: 'tiktok-ads', status: 'failed', code: 'key_rejected' })
    expect(await db.query(`SELECT status, code FROM meta_sync_run WHERE source = 'tiktok-ads' ORDER BY started_at DESC LIMIT 1`)).toEqual([{ status: 'failed', code: 'key_rejected' }])
  })
})

describe('wiring', () => {
  it('is a built-in source with its own key and table', () => {
    expect(parseOnly(['tiktok-ads'])).toEqual(['tiktok-ads'])
    expect(NATIVE_SECRETS['tiktok-ads']).toEqual(['tiktok-ads-access-token'])
    expect(NATIVE_TABLES['tiktok-ads']).toEqual(['fact_tiktok_ads_daily'])
    expect(PUBLIC_TABLES).toContain('fact_tiktok_ads_daily')
  })
  it('puts the TikTok token in the daily workflow only when connected', () => {
    const y = workflowYaml(false, false, [], false, false, false, false, false, false, false, false, false, true)
    expect(y).toContain('LIFECYCLE_TIKTOK_ADS_ACCESS_TOKEN: ${{ secrets.LIFECYCLE_TIKTOK_ADS_ACCESS_TOKEN }}')
    expect(workflowYaml(false)).not.toContain('TIKTOK')
  })
})
