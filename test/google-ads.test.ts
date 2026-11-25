import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { adGroupQuery, campaignQuery, errorCodes, GoogleAds, googleAdsAccessToken, normalizeCustomerId, toAdGroupDaily, toCampaignDaily } from '../src/sources/google-ads.js'
import { syncGoogleAds, writeGoogleAds } from '../src/sync.js'
import { workflowYaml } from '../src/deploy.js'
import { HttpError } from '../src/http.js'
import { NATIVE_SECRETS, NATIVE_TABLES, parseOnly } from '../src/native.js'

// Answer shapes follow the Google Ads REST reference for v26 (int64 as strings, doubles as numbers).
// They are written from the docs, not captured from a live account.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/google-ads/${name}.json`, import.meta.url), 'utf8'))

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
const apiError = (name: string, status = 403) => new HttpError('Google Ads campaign report', status, JSON.stringify(fixture(name)))

describe('customer ids', () => {
  it('accepts the dashed form and the ten digits', () => {
    expect(normalizeCustomerId('123-456-7890')).toBe('1234567890')
    expect(normalizeCustomerId(' 1234567890 ')).toBe('1234567890')
  })
  it('refuses anything else, so nothing odd reaches the URL', () => {
    for (const bad of ['', '12345', '123-456-789', '1234567890/x', 'act_1234567890', '12345678901']) expect(() => normalizeCustomerId(bad)).toThrow(/not a Google Ads customer id/)
  })
})

describe('rows', () => {
  it('turns micros into money and keeps fractional conversions', () => {
    expect(toCampaignDaily(fixture('campaign-page1').results)).toEqual([
      { date: '2026-11-22', campaignId: '111', campaignName: 'Brand Search', cost: 25.12, impressions: 900, clicks: 40, conversions: 3.5, conversionsValue: 412.35 },
      { date: '2026-11-22', campaignId: '222', campaignName: 'Shopping', cost: 10, impressions: 3100, clicks: 12, conversions: 0, conversionsValue: 0 },
    ])
  })
  it('drops rows with no date or campaign, and ad group rows with no ad group', () => {
    expect(toCampaignDaily([{ campaign: { id: '1' } }, { segments: { date: '2026-11-01' } }, { campaign: { id: '1' }, segments: { date: 'Nov 1' } }])).toEqual([])
    expect(toAdGroupDaily([...fixture('campaign-page1').results, ...fixture('ad-group').results])).toEqual([
      { date: '2026-11-22', campaignId: '111', campaignName: 'Brand Search', adGroupId: '9001', adGroupName: 'Brand exact', cost: 25.12, impressions: 900, clicks: 40, conversions: 3.5, conversionsValue: 412.35 },
    ])
  })
  it('builds read-only queries and refuses dates that are not dates', () => {
    expect(campaignQuery('2026-08-26', '2026-11-24')).toBe("SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '2026-08-26' AND '2026-11-24'")
    expect(adGroupQuery('2026-08-26', '2026-11-24')).toMatch(/^SELECT .* FROM ad_group WHERE segments\.date BETWEEN/)
    expect(() => campaignQuery("2026-01-01' OR '1'='1", '2026-11-24')).toThrow(/YYYY-MM-DD/)
    // Nothing personal is ever asked for.
    for (const q of [campaignQuery('2026-01-01', '2026-01-02'), adGroupQuery('2026-01-01', '2026-01-02')]) expect(q).not.toMatch(/email|phone|address|user_list|search_term|keyword|ad_group_ad/)
  })
})

describe('the API client', () => {
  it('reads the account, sends the token in a header and no developer token', async () => {
    const { calls, fetcher } = fake([fixture('customer')])
    const a = await new GoogleAds('tok', '123-456-7890', undefined, fetcher).check()
    expect(a).toEqual({ customer: '1234567890', name: 'Northwind Test Ads', currency: 'USD', timezone: 'America/Los_Angeles', testAccount: true })
    expect(calls[0]!.url).toBe('https://googleads.googleapis.com/v26/customers/1234567890/googleAds:search')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer tok' })
    expect(calls[0]!.body.query).toMatch(/FROM customer LIMIT 1$/)
  })

  it('sends login-customer-id when access comes through a manager', async () => {
    const { calls, fetcher } = fake([fixture('customer')])
    await new GoogleAds('tok', '1234567890', '949-030-1639', fetcher).check()
    expect(calls[0]!.headers['login-customer-id']).toBe('9490301639')
  })

  it('refuses a manager account at connect time', async () => {
    const manager = fixture('customer')
    manager.results[0].customer.manager = true
    const { fetcher } = fake([manager])
    await expect(new GoogleAds('tok', '9490301639', undefined, fetcher).check()).rejects.toMatchObject({ code: 'google_ads_manager' })
  })

  it('follows nextPageToken until the last page', async () => {
    const { calls, fetcher } = fake([fixture('campaign-page1'), fixture('campaign-page2')])
    const rows = await new GoogleAds('tok', '1234567890', undefined, fetcher).campaigns('2026-11-22', '2026-11-23')
    expect(rows).toHaveLength(3)
    expect(calls.map((c) => c.body.pageToken)).toEqual([undefined, 'page-2-token'])
    expect(calls[1]!.body.query).toBe(calls[0]!.body.query)
  })

  it('stops when Google repeats the same page token', async () => {
    const loop = { ...fixture('campaign-page2'), nextPageToken: 'same' }
    const { calls, fetcher } = fake([{ ...loop }, { ...loop }])
    await new GoogleAds('tok', '1234567890', undefined, fetcher).campaigns('2026-11-22', '2026-11-23')
    expect(calls).toHaveLength(2)
  })

  it('names the fix for each documented error', async () => {
    const cases: [HttpError, string, RegExp][] = [
      [apiError('error-test-access'), 'google_ads_access_level', /Test access/],
      [apiError('error-permission'), 'google_ads_permission', /login-customer/],
      [new HttpError('x', 401, JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } })), 'key_rejected', /sign in/i],
      [new HttpError('x', 429, JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Too many requests.' } })), 'rate_limited', /2,880/],
    ]
    for (const [err, code, next] of cases) {
      const { fetcher } = fake([err])
      const p = new GoogleAds('tok', '1234567890', undefined, fetcher).campaigns('2026-11-22', '2026-11-23')
      await expect(p).rejects.toMatchObject({ code })
      await expect(new GoogleAds('tok', '1234567890', undefined, fake([err]).fetcher).campaigns('2026-11-22', '2026-11-23')).rejects.toSatisfy((e: any) => next.test(`${e.message} ${e.next}`))
    }
  })

  it('reads error codes out of the failure details', () => {
    expect(errorCodes(JSON.stringify(fixture('error-permission')))).toMatchObject({ status: 'PERMISSION_DENIED', codes: ['USER_PERMISSION_DENIED'] })
    expect(errorCodes('not json')).toEqual({ status: '', message: '', codes: [] })
  })
})

describe('sign-in', () => {
  it('trades the refresh token for an access token', async () => {
    const { calls, fetcher } = fake([{ access_token: 'ya29.fake', expires_in: 3599, token_type: 'Bearer' }])
    expect(await googleAdsAccessToken('cid', 'csecret', 'rtoken', fetcher)).toBe('ya29.fake')
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
    expect(calls[0]!.body).toEqual({ grant_type: 'refresh_token', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtoken' })
  })
  it('says to sign in again when the refresh token is revoked or expired', async () => {
    const { fetcher } = fake([new HttpError('Google token request', 400, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}')])
    await expect(googleAdsAccessToken('cid', 'csecret', 'old', fetcher)).rejects.toMatchObject({ code: 'key_rejected', message: /Google Ads sign-in/ })
  })
})

describe('sync', () => {
  let db: Db
  beforeEach(async () => {
    db = wrapPglite(await PGlite.create())
    await migrate(db)
  })
  afterEach(async () => db.close())

  const campaigns = async () => db.query(`SELECT date::text AS date, account_id, campaign_id, cost::float AS cost, conversions::float AS conversions, currency FROM fact_google_ads_campaign_daily ORDER BY date, campaign_id`)
  const load = (c: unknown[], g: unknown[] = []) => ({ campaigns: async () => c as any[], adGroups: async () => g as any[] })

  it('pulls a 90-day window and writes campaign and ad group rows', async () => {
    const asked: string[] = []
    const r = await syncGoogleAds(
      db,
      { campaigns: async (s, u) => (asked.push(`c ${s}..${u}`), [...fixture('campaign-page1').results, ...fixture('campaign-page2').results]), adGroups: async (s, u) => (asked.push(`g ${s}..${u}`), fixture('ad-group').results) },
      { customer: '1234567890', currency: 'USD', today: '2026-11-24' },
    )
    expect(asked).toEqual(['c 2026-08-26..2026-11-24', 'g 2026-08-26..2026-11-24'])
    expect(r).toMatchObject({ source: 'google-ads', status: 'ok', rows: 4 })
    expect(await campaigns()).toEqual([
      { date: '2026-11-22', account_id: '1234567890', campaign_id: '111', cost: 25.12, conversions: 3.5, currency: 'USD' },
      { date: '2026-11-22', account_id: '1234567890', campaign_id: '222', cost: 10, conversions: 0, currency: 'USD' },
      { date: '2026-11-23', account_id: '1234567890', campaign_id: '111', cost: 26, conversions: 4, currency: 'USD' },
    ])
    expect(await db.query(`SELECT ad_group_id, ad_group_name, campaign_id FROM fact_google_ads_ad_group_daily`)).toEqual([{ ad_group_id: '9001', ad_group_name: 'Brand exact', campaign_id: '111' }])
  })

  it('replaces the window, keeps older days, and drops another account', async () => {
    const row = (date: string, id: string, micros: string) => ({ segments: { date }, campaign: { id, name: id }, metrics: { costMicros: micros } })
    await writeGoogleAds(db, { campaigns: [row('2026-07-01', 'old', '5000000'), row('2026-11-23', 'c1', '50000000'), row('2026-11-23', 'gone', '1')], adGroups: [] }, '2026-07-01', 'USD', '1111111111')
    await syncGoogleAds(db, load([row('2026-11-23', 'c1', '55000000')]), { customer: '1111111111', currency: 'USD', today: '2026-11-24' })
    expect((await campaigns()).map((r) => `${r.date} ${r.campaign_id} ${r.cost}`)).toEqual(['2026-07-01 old 5', '2026-11-23 c1 55'])
    await syncGoogleAds(db, load([row('2026-11-23', 'b1', '1000000')]), { customer: '2222222222', currency: 'EUR', today: '2026-11-24' })
    expect((await campaigns()).map((r) => `${r.account_id} ${r.campaign_id} ${r.currency}`)).toEqual(['2222222222 b1 EUR'])
  })

  it('warns when there is no activity, and records a failure with its code', async () => {
    expect(await syncGoogleAds(db, load([]), { customer: '1234567890', today: '2026-11-24' })).toMatchObject({ status: 'warning', rows: 0, detail: expect.stringMatching(/no campaign activity/) })
    const failed = await syncGoogleAds(db, { campaigns: async () => new GoogleAds('t', '1234567890', undefined, fake([apiError('error-test-access')]).fetcher).campaigns('2026-11-01', '2026-11-02'), adGroups: async () => [] }, { customer: '1234567890', today: '2026-11-24' })
    expect(failed).toMatchObject({ source: 'google-ads', status: 'failed', code: 'google_ads_access_level' })
    expect(await db.query(`SELECT status, code FROM meta_sync_run WHERE source = 'google-ads' ORDER BY started_at DESC LIMIT 1`)).toEqual([{ status: 'failed', code: 'google_ads_access_level' }])
  })
})

describe('wiring', () => {
  it('is a built-in source with its own keys and tables', () => {
    expect(parseOnly(['google-ads'])).toEqual(['google-ads'])
    expect(NATIVE_SECRETS['google-ads']).toEqual(['google-ads-client-secret', 'google-ads-refresh-token'])
    expect(NATIVE_TABLES['google-ads']).toEqual(['fact_google_ads_campaign_daily', 'fact_google_ads_ad_group_daily'])
  })
  it('puts both Google Ads secrets in the daily workflow only when connected', () => {
    const y = workflowYaml(false, false, [], false, false, false, true)
    expect(y).toContain('LIFECYCLE_GOOGLE_ADS_CLIENT_SECRET: ${{ secrets.LIFECYCLE_GOOGLE_ADS_CLIENT_SECRET }}')
    expect(y).toContain('LIFECYCLE_GOOGLE_ADS_REFRESH_TOKEN: ${{ secrets.LIFECYCLE_GOOGLE_ADS_REFRESH_TOKEN }}')
    expect(workflowYaml(false)).not.toContain('GOOGLE_ADS')
  })
})
