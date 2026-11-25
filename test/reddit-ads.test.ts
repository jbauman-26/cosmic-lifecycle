import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { normalizeRedditAccountId, RedditAds, redditAccessToken, redditError, reportBody, toRedditDaily, TOKEN_URL, USER_AGENT } from '../src/sources/reddit-ads.js'
import { syncRedditAds, writeAdsDaily } from '../src/sync.js'
import { connectRedditAds } from '../src/commands/connect.js'
import { readConfig, writeConfig } from '../src/config.js'
import { workflowYaml } from '../src/deploy.js'
import { HttpError } from '../src/http.js'
import { NATIVE_SECRETS, NATIVE_TABLES, parseOnly } from '../src/native.js'
import { envName } from '../src/secrets.js'
import { PUBLIC_TABLES } from '../src/schema.js'

// Answer shapes follow the Reddit Ads API v3 reference (Get Ad Account, List Campaigns, Get A Report).
// They are written from the docs, not captured from a live account.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/reddit-ads/${name}.json`, import.meta.url), 'utf8'))
const ACCOUNT = 'a2_bzv32cgqp'

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
const httpError = (status: number, body: unknown = fixture('error-permission')) => new HttpError('Reddit Ads report', status, JSON.stringify(body))

describe('ad account ids', () => {
  it('accepts the ids Reddit shows', () => {
    expect(normalizeRedditAccountId(' a2_bzv32cgqp ')).toBe('a2_bzv32cgqp')
    expect(normalizeRedditAccountId('t2_123456')).toBe('t2_123456')
  })
  it('refuses anything else, so nothing odd reaches the URL', () => {
    for (const bad of ['', '123456', 'a2_', 'a2_abc/../x', 'act_123', 'a2_abc?x=1']) expect(() => normalizeRedditAccountId(bad)).toThrow(/not a Reddit ad account id/)
  })
})

describe('rows', () => {
  const names = new Map([['579922433862993631', 'Spring Sale'], ['1822122159046060063', 'Brand Awareness']])
  it('turns micros into money, cents into value, and adds click and view purchases', () => {
    expect(toRedditDaily(fixture('report-page1').data.metrics, names, '2026-11-01', '2026-11-24')).toEqual([
      { date: '2026-11-22', campaignId: '579922433862993631', campaignName: 'Spring Sale', spend: 25.12, impressions: 50000, clicks: 150, conversions: 5, conversionValue: 412.35 },
      { date: '2026-11-22', campaignId: '1822122159046060063', campaignName: 'Brand Awareness', spend: 10, impressions: 31000, clicks: 12, conversions: 0, conversionValue: 0 },
    ])
  })
  it('drops rows with no campaign or date, and days outside the window', () => {
    const rows = [{ campaign_id: '1' }, { date: '2026-11-02' }, { campaign_id: '1', date: 'Nov 2' }, { campaign_id: '1', date: '2026-10-31' }, { campaign_id: '1', date: '2026-11-25' }, { campaign_id: '1', date: '2026-11-24', spend: 1000000 }]
    expect(toRedditDaily(rows, new Map(), '2026-11-01', '2026-11-24')).toEqual([{ date: '2026-11-24', campaignId: '1', campaignName: '', spend: 1, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 }])
  })
  it('asks for daily campaign totals in the account time zone, and refuses dates that are not dates', () => {
    expect(reportBody('2026-08-26', '2026-11-24', 'America/New_York')).toEqual({
      data: {
        breakdowns: ['CAMPAIGN_ID', 'DATE'],
        fields: ['SPEND', 'IMPRESSIONS', 'CLICKS', 'CONVERSION_PURCHASE_CLICKS', 'CONVERSION_PURCHASE_VIEWS', 'CONVERSION_PURCHASE_TOTAL_VALUE'],
        starts_at: '2026-08-26T00:00:00Z',
        ends_at: '2026-11-25T00:00:00Z',
        time_zone_id: 'America/New_York',
      },
    })
    expect(() => reportBody("2026-01-01' OR 1", '2026-11-24', 'UTC')).toThrow(/YYYY-MM-DD/)
    // Nothing personal, no audiences, communities or keywords.
    expect(JSON.stringify(reportBody('2026-01-01', '2026-01-02', 'UTC'))).not.toMatch(/INTEREST|COMMUNITY|KEYWORD|POST_ID|GENDER|AGE|AD_ID/)
  })
})

describe('the API client', () => {
  it('reads the account with a bearer token and its own User-Agent', async () => {
    const { calls, fetcher } = fake([fixture('account')])
    expect(await new RedditAds('tok', ACCOUNT, fetcher).check()).toEqual({ account: ACCOUNT, name: 'Northwind Reddit Ads', currency: 'USD', timezone: 'America/New_York' })
    expect(calls[0]!.url).toBe('https://ads-api.reddit.com/api/v3/ad_accounts/a2_bzv32cgqp')
    expect(calls[0]!).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer tok', 'user-agent': USER_AGENT } })
    expect(USER_AGENT).toMatch(/^node:cosmic-lifecycle:\d/)
  })

  it('follows pagination.next_url for campaign names', async () => {
    const { calls, fetcher } = fake([fixture('campaigns-page1'), fixture('campaigns-page2')])
    const names = await new RedditAds('tok', ACCOUNT, fetcher).campaignNames()
    expect([...names]).toEqual([['579922433862993631', 'Spring Sale'], ['1822122159046060063', 'Brand Awareness']])
    expect(calls.map((c) => c.url)).toEqual(['https://ads-api.reddit.com/api/v3/ad_accounts/a2_bzv32cgqp/campaigns?page.size=1000', 'https://ads-api.reddit.com/api/v3/ad_accounts/a2_bzv32cgqp/campaigns?page.token=nextToken'])
  })

  it('posts the same report body to every page', async () => {
    const { calls, fetcher } = fake([fixture('report-page1'), fixture('report-page2')])
    const rows = await new RedditAds('tok', ACCOUNT, fetcher).report('2026-11-22', '2026-11-23', 'America/New_York')
    expect(rows).toHaveLength(3)
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST'])
    expect(calls[1]!.url).toBe('https://ads-api.reddit.com/api/v3/ad_accounts/a2_bzv32cgqp/reports?page.token=nextToken')
    expect(calls[1]!.body).toEqual(calls[0]!.body)
  })

  it('stops on a repeated page and refuses a next page on another host', async () => {
    const loop = { ...fixture('report-page2'), pagination: { next_url: 'https://ads-api.reddit.com/api/v3/ad_accounts/a2_bzv32cgqp/reports?page.size=1000' } }
    const a = fake([loop])
    await new RedditAds('tok', ACCOUNT, a.fetcher).report('2026-11-22', '2026-11-23', 'UTC')
    expect(a.calls).toHaveLength(1)
    const away = { ...fixture('report-page2'), pagination: { next_url: 'https://evil.example/steal' } }
    await expect(new RedditAds('tok', ACCOUNT, fake([away]).fetcher).report('2026-11-22', '2026-11-23', 'UTC')).rejects.toMatchObject({ code: 'reddit_ads_error' })
  })

  it('names the fix for each error', async () => {
    const cases: [HttpError, string, RegExp][] = [
      [httpError(401, { error: { code: 401, message: 'Unauthorized.' } }), 'key_rejected', /sign in/i],
      [httpError(403), 'reddit_ads_permission', /reporting access/],
      [httpError(404, { error: { code: 404, message: 'Not found.' } }), 'reddit_ads_account', /Accounts in Reddit Ads Manager/],
      [httpError(429, { error: { code: 429, message: 'Too many requests.' } }), 'rate_limited', /60 requests a minute/],
      [httpError(500, { error: { code: 500, message: 'Internal Server Error' } }), 'reddit_ads_error', /lifecycle doctor/],
    ]
    for (const [err, code, next] of cases) {
      await expect(new RedditAds('tok', ACCOUNT, fake([err]).fetcher).report('2026-11-22', '2026-11-23', 'UTC')).rejects.toSatisfy((e: any) => e.code === code && next.test(`${e.message} ${e.next}`))
    }
  })

  it('reads the message out of an error body', () => {
    expect(redditError(JSON.stringify(fixture('error-permission')))).toEqual({ message: 'Forbidden.' })
    expect(redditError('not json')).toEqual({ message: '' })
  })
})

describe('sign-in', () => {
  it('trades the refresh token with HTTP Basic client auth', async () => {
    const { calls, fetcher } = fake([{ access_token: 'reddit-access', token_type: 'bearer', expires_in: 3600, scope: 'adsread' }])
    expect(await redditAccessToken('appid', 'appsecret', 'rtoken', fetcher)).toBe('reddit-access')
    expect(calls[0]!.url).toBe(TOKEN_URL)
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('appid:appsecret').toString('base64')}`)
    expect(calls[0]!.headers['user-agent']).toBe(USER_AGENT)
    expect(calls[0]!.body).toEqual({ grant_type: 'refresh_token', refresh_token: 'rtoken' })
  })
  it('says to sign in again when the refresh token is refused, with a status or in a 200 body', async () => {
    await expect(redditAccessToken('a', 'b', 'old', fake([new HttpError('Reddit token request', 401, '{"message": "Unauthorized", "error": 401}')]).fetcher)).rejects.toMatchObject({ code: 'key_rejected' })
    await expect(redditAccessToken('a', 'b', 'old', fake([{ error: 'invalid_grant' }]).fetcher)).rejects.toMatchObject({ code: 'key_rejected', message: /Reddit Ads sign-in/ })
  })
})

describe('sync', () => {
  let db: Db
  beforeEach(async () => {
    db = wrapPglite(await PGlite.create())
    await migrate(db)
  })
  afterEach(async () => db.close())

  const rows = async () => db.query(`SELECT date::text AS date, account_id, campaign_id, campaign_name, spend::float AS spend, conversions::float AS conversions, conversion_value::float AS conversion_value, currency FROM fact_reddit_ads_daily ORDER BY date, campaign_id`)
  const names = async () => new Map([['579922433862993631', 'Spring Sale']])

  it('pulls a 90-day window and writes daily campaign rows', async () => {
    const asked: string[] = []
    const r = await syncRedditAds(
      db,
      { names, report: async (s, u) => (asked.push(`${s}..${u}`), [...fixture('report-page1').data.metrics, ...fixture('report-page2').data.metrics]) },
      { account: ACCOUNT, currency: 'USD', timezone: 'America/New_York', today: '2026-11-24' },
    )
    expect(asked).toEqual(['2026-08-26..2026-11-24'])
    expect(r).toMatchObject({ source: 'reddit-ads', status: 'ok', rows: 3 })
    expect(await rows()).toEqual([
      { date: '2026-11-22', account_id: ACCOUNT, campaign_id: '1822122159046060063', campaign_name: '', spend: 10, conversions: 0, conversion_value: 0, currency: 'USD' },
      { date: '2026-11-22', account_id: ACCOUNT, campaign_id: '579922433862993631', campaign_name: 'Spring Sale', spend: 25.12, conversions: 5, conversion_value: 412.35, currency: 'USD' },
      { date: '2026-11-23', account_id: ACCOUNT, campaign_id: '579922433862993631', campaign_name: 'Spring Sale', spend: 26, conversions: 4, conversion_value: 500, currency: 'USD' },
    ])
  })

  it('replaces the window, keeps older days, and drops another account', async () => {
    const day = (date: string, id: string, spend: number) => ({ date, campaignId: id, campaignName: id, spend, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 })
    await writeAdsDaily(db, 'fact_reddit_ads_daily', [day('2026-07-01', 'old', 5), day('2026-11-23', 'c1', 50), day('2026-11-23', 'gone', 1)], '2026-07-01', 'USD', ACCOUNT)
    await syncRedditAds(db, { names, report: async () => [{ campaign_id: 'c1', date: '2026-11-23', spend: 55000000 }] }, { account: ACCOUNT, currency: 'USD', today: '2026-11-24' })
    expect((await rows()).map((r) => `${r.date} ${r.campaign_id} ${r.spend}`)).toEqual(['2026-07-01 old 5', '2026-11-23 c1 55'])
    await syncRedditAds(db, { names, report: async () => [{ campaign_id: 'b1', date: '2026-11-23', spend: 1000000 }] }, { account: 't2_999', currency: 'EUR', today: '2026-11-24' })
    expect((await rows()).map((r) => `${r.account_id} ${r.campaign_id} ${r.currency}`)).toEqual(['t2_999 b1 EUR'])
  })

  it('warns when there is no activity, and records a failure with its code', async () => {
    expect(await syncRedditAds(db, { names, report: async () => [] }, { account: ACCOUNT, today: '2026-11-24' })).toMatchObject({ status: 'warning', rows: 0, detail: expect.stringMatching(/no campaign activity/) })
    const failed = await syncRedditAds(db, { names, report: () => new RedditAds('t', ACCOUNT, fake([httpError(403)]).fetcher).report('2026-11-01', '2026-11-02', 'UTC') }, { account: ACCOUNT, today: '2026-11-24' })
    expect(failed).toMatchObject({ source: 'reddit-ads', status: 'failed', code: 'reddit_ads_permission' })
    expect(await db.query(`SELECT status, code FROM meta_sync_run WHERE source = 'reddit-ads' ORDER BY started_at DESC LIMIT 1`)).toEqual([{ status: 'failed', code: 'reddit_ads_permission' }])
  })
})

describe('connect', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lc-reddit-'))
    process.env.LIFECYCLE_HOME = home
    process.env.LIFECYCLE_NO_KEYCHAIN = '1'
    process.env.REDDIT_TEST_SECRET = 'reddit_secret_not_real'
    process.env.REDDIT_TEST_REFRESH = 'reddit_refresh_not_real'
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'REDDIT_TEST_SECRET', 'REDDIT_TEST_REFRESH']) delete process.env[k]
    vi.unstubAllGlobals()
  })

  it('checks the sign-in with one small read, records the account, and makes no write call', async () => {
    writeConfig({ database: { kind: 'local' } })
    const seen: { url: string; method: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, method: String(init.method) })
      const body = url === TOKEN_URL ? { access_token: 'reddit-access', token_type: 'bearer', expires_in: 3600, refresh_token: 'reddit_refresh_not_real', scope: 'adsread' } : fixture('account')
      return new Response(JSON.stringify(body), { status: 200 })
    }))
    const r = await connectRedditAds({ account: ACCOUNT, clientId: 'appid', secretEnv: 'REDDIT_TEST_SECRET', refreshTokenEnv: 'REDDIT_TEST_REFRESH' })
    expect(r).toMatchObject({ connected: true, account: ACCOUNT, name: 'Northwind Reddit Ads', currency: 'USD', timezone: 'America/New_York', keyStorage: 'environment', keyEnv: ['LIFECYCLE_REDDIT_ADS_CLIENT_SECRET', 'LIFECYCLE_REDDIT_ADS_REFRESH_TOKEN'] })
    expect(JSON.stringify(r)).not.toMatch(/not_real/)
    expect(readConfig()['reddit-ads']).toEqual({ account: ACCOUNT, clientId: 'appid', name: 'Northwind Reddit Ads', currency: 'USD', timezone: 'America/New_York' })
    expect(seen).toEqual([{ url: TOKEN_URL, method: 'POST' }, { url: 'https://ads-api.reddit.com/api/v3/ad_accounts/a2_bzv32cgqp', method: 'GET' }])
  })

  it('refuses a missing id or secret before calling Reddit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no call expected') }))
    await expect(connectRedditAds({ clientId: 'appid' })).rejects.toThrow(/ad account id and app id are required/)
    await expect(connectRedditAds({ account: ACCOUNT, clientId: 'appid', secretEnv: 'UNSET_REDDIT_VAR' })).rejects.toMatchObject({ code: 'missing_secret' })
  })
})

describe('read only', () => {
  it('never calls a write method, and posts only to the token and report URLs', async () => {
    const { calls, fetcher } = fake([fixture('account'), fixture('campaigns-page1'), fixture('campaigns-page2'), fixture('report-page1'), fixture('report-page2')])
    const api = new RedditAds('tok', ACCOUNT, fetcher)
    await api.check()
    await api.campaignNames()
    await api.report('2026-11-22', '2026-11-23', 'UTC')
    for (const c of calls) {
      expect(['GET', 'POST']).toContain(c.method)
      if (c.method === 'POST') expect(c.url).toMatch(/\/ad_accounts\/a2_bzv32cgqp\/reports\?/)
    }
    const src = readFileSync(new URL('../src/sources/reddit-ads.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/method: '(PUT|PATCH|DELETE)'/)
    expect(src).not.toMatch(/adsedit|adsconversions|adsdatadeletion/)
  })
})

describe('wiring', () => {
  it('is a built-in source with its own keys, table and environment names', () => {
    expect(parseOnly(['reddit-ads'])).toEqual(['reddit-ads'])
    expect(NATIVE_SECRETS['reddit-ads']).toEqual(['reddit-ads-client-secret', 'reddit-ads-refresh-token'])
    expect(NATIVE_TABLES['reddit-ads']).toEqual(['fact_reddit_ads_daily'])
    expect(PUBLIC_TABLES).toContain('fact_reddit_ads_daily')
    expect(envName('reddit-ads-client-secret')).toBe('LIFECYCLE_REDDIT_ADS_CLIENT_SECRET')
    expect(envName('reddit-ads-refresh-token')).toBe('LIFECYCLE_REDDIT_ADS_REFRESH_TOKEN')
  })
  it('puts both secrets in the daily workflow only when connected', () => {
    const y = workflowYaml(false, false, [], false, false, false, false, false, true)
    expect(y).toContain('LIFECYCLE_REDDIT_ADS_CLIENT_SECRET: ${{ secrets.LIFECYCLE_REDDIT_ADS_CLIENT_SECRET }}')
    expect(y).toContain('LIFECYCLE_REDDIT_ADS_REFRESH_TOKEN: ${{ secrets.LIFECYCLE_REDDIT_ADS_REFRESH_TOKEN }}')
    expect(workflowYaml(false)).not.toContain('REDDIT')
  })
})
