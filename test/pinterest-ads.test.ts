import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { clampSince, COLUMNS, normalizeAdAccountId, PinterestAds, pinterestAccessToken, toDaily } from '../src/sources/pinterest-ads.js'
import { syncPinterestAds, writePinterestAds } from '../src/sync.js'
import { connectPinterestAds } from '../src/commands/connect.js'
import { readConfig, writeConfig } from '../src/config.js'
import { workflowYaml } from '../src/deploy.js'
import { HttpError } from '../src/http.js'
import { NATIVE_SECRETS, NATIVE_TABLES, parseOnly } from '../src/native.js'
import { PUBLIC_TABLES } from '../src/schema.js'

// Answer shapes follow the Pinterest API v5 OpenAPI spec (5.32.0): AdAccount, the campaigns list
// with a bookmark, CampaignsAnalyticsMetrics rows keyed by column name, and { code, message } errors.
// Written from the spec, not captured from a live account.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/pinterest-ads/${name}.json`, import.meta.url), 'utf8'))
const ACCOUNT = '549755885175'
const API = 'https://api.pinterest.com/v5'

type Call = { url: URL; method: string; headers: Record<string, string>; body: Record<string, string> | undefined }
function fake(answers: unknown[]) {
  const calls: Call[] = []
  const queue = [...answers]
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url: new URL(url), method: String(init.method), headers: init.headers as Record<string, string>, body: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : undefined })
    const next = queue.shift()
    if (next === undefined) throw new Error(`unexpected request to ${url}`)
    if (next instanceof Error) throw next
    return structuredClone(next)
  }) as any
  return { calls, fetcher }
}
const apiError = (status: number, name = 'error-auth') => new HttpError('Pinterest campaign report', status, JSON.stringify(fixture(name)))

describe('ad account ids', () => {
  it('accepts the digits, trimmed', () => {
    expect(normalizeAdAccountId(` ${ACCOUNT} `)).toBe(ACCOUNT)
  })
  it('refuses anything else, so nothing odd reaches the URL', () => {
    for (const bad of ['', 'act_549755885175', '549755885175/campaigns', '1234567890123456789', '../me']) expect(() => normalizeAdAccountId(bad)).toThrow(/not a Pinterest ad account id/)
  })
})

describe('rows', () => {
  it('turns micro units into money, names campaigns, and counts missing columns as 0', () => {
    const names = new Map([['626736533506', 'Holiday Shopping'], ['626736533508', 'Catalog Sales']])
    expect(toDaily(fixture('analytics'), names)).toEqual([
      { date: '2026-11-22', campaignId: '626736533506', campaignName: 'Holiday Shopping', spend: 25.12, impressions: 9000, clicks: 140, conversions: 3, conversionValue: 412.35 },
      { date: '2026-11-22', campaignId: '626736533508', campaignName: 'Catalog Sales', spend: 10, impressions: 3100, clicks: 12, conversions: 0, conversionValue: 0 },
      { date: '2026-11-23', campaignId: '626736533506', campaignName: 'Holiday Shopping', spend: 26, impressions: 9500, clicks: 150, conversions: 4, conversionValue: 500 },
    ])
  })
  it('drops rows with no date or campaign', () => {
    expect(toDaily([{ CAMPAIGN_ID: '1' }, { DATE: '2026-11-01' }, { CAMPAIGN_ID: '1', DATE: 'Nov 1' }])).toEqual([])
  })
})

describe('date guard', () => {
  it('never starts more than 89 days before today, inside the 90-day limit', () => {
    expect(clampSince('2026-08-26', '2026-11-24')).toBe('2026-08-27')
    expect(clampSince('2026-11-01', '2026-11-24')).toBe('2026-11-01')
    expect(clampSince('2025-01-01', '2026-11-24')).toBe('2026-08-27')
  })
  it('refuses dates that are not dates', async () => {
    expect(() => clampSince("2026-01-01' OR 1=1", '2026-11-24')).toThrow(/YYYY-MM-DD/)
    await expect(new PinterestAds('tok', ACCOUNT, fake([]).fetcher).analytics(['1'], 'yesterday', '2026-11-24')).rejects.toThrow(/YYYY-MM-DD/)
  })
})

describe('the API client', () => {
  it('reads the account with a bearer token', async () => {
    const { calls, fetcher } = fake([fixture('ad-account')])
    expect(await new PinterestAds('pina_tok', ACCOUNT, fetcher).check()).toEqual({ account: ACCOUNT, name: 'Northwind Pins', currency: 'USD', timezone: 'America/Los_Angeles' })
    expect(calls[0]!.url.toString()).toBe(`${API}/ad_accounts/${ACCOUNT}`)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.headers).toEqual({ authorization: 'Bearer pina_tok' })
  })

  it('follows the campaign bookmark, and asks for active, paused and archived campaigns', async () => {
    const { calls, fetcher } = fake([fixture('campaigns-page1'), fixture('campaigns-page2')])
    const names = await new PinterestAds('tok', ACCOUNT, fetcher).campaigns()
    expect([...names]).toEqual([['626736533506', 'Holiday Shopping'], ['626736533507', 'Spring Archive'], ['626736533508', 'Catalog Sales']])
    expect(calls.map((c) => c.url.searchParams.get('bookmark'))).toEqual([null, 'Y2JVRUZCVHNucGI='])
    expect(calls[0]!.url.searchParams.getAll('entity_statuses')).toEqual(['ACTIVE', 'PAUSED', 'ARCHIVED'])
    expect(calls[0]!.url.searchParams.get('page_size')).toBe('250')
  })

  it('stops when Pinterest repeats the same bookmark', async () => {
    const loop = { ...fixture('campaigns-page2'), bookmark: 'same' }
    const { calls, fetcher } = fake([loop, loop])
    await new PinterestAds('tok', ACCOUNT, fetcher).campaigns()
    expect(calls).toHaveLength(2)
  })

  it('asks for daily analytics in batches of 250 campaigns, in the account time zone', async () => {
    const ids = Array.from({ length: 251 }, (_, i) => String(1000 + i))
    const { calls, fetcher } = fake([fixture('analytics'), []])
    const rows = await new PinterestAds('tok', ACCOUNT, fetcher).analytics(ids, '2026-08-27', '2026-11-24', 'America/Los_Angeles')
    expect(rows).toHaveLength(3)
    expect(calls.map((c) => c.url.searchParams.getAll('campaign_ids').length)).toEqual([250, 1])
    const q = calls[0]!.url.searchParams
    expect(calls[0]!.url.pathname).toBe(`/v5/ad_accounts/${ACCOUNT}/campaigns/analytics`)
    expect(Object.fromEntries(q)).toMatchObject({ start_date: '2026-08-27', end_date: '2026-11-24', granularity: 'DAY', reporting_timezone: 'AD_ACCOUNT_TIME_ZONE', columns: COLUMNS.join(',') })
  })

  it('leaves the time zone at Pinterest default when the account has none', async () => {
    const { calls, fetcher } = fake([[]])
    await new PinterestAds('tok', ACCOUNT, fetcher).analytics(['1'], '2026-11-01', '2026-11-24')
    expect(calls[0]!.url.searchParams.has('reporting_timezone')).toBe(false)
  })

  it('skips analytics when the account has no campaigns', async () => {
    const { calls, fetcher } = fake([{ items: [], bookmark: null }])
    expect(await new PinterestAds('tok', ACCOUNT, fetcher).report('2026-11-01', '2026-11-24')).toEqual({ rows: [], names: new Map() })
    expect(calls).toHaveLength(1)
  })

  it('only ever reads: GET calls to three paths, and no call that changes anything', async () => {
    const { calls, fetcher } = fake([fixture('ad-account'), fixture('campaigns-page1'), fixture('campaigns-page2'), fixture('analytics')])
    const api = new PinterestAds('tok', ACCOUNT, fetcher)
    await api.check()
    await api.report('2026-11-01', '2026-11-24')
    expect(calls).toHaveLength(4)
    for (const c of calls) {
      expect(c.method).toBe('GET')
      expect(c.body).toBeUndefined()
      expect([`/v5/ad_accounts/${ACCOUNT}`, `/v5/ad_accounts/${ACCOUNT}/campaigns`, `/v5/ad_accounts/${ACCOUNT}/campaigns/analytics`]).toContain(c.url.pathname)
    }
    const methods = Object.getOwnPropertyNames(PinterestAds.prototype).filter((m) => m !== 'constructor')
    expect(methods.sort()).toEqual(['analytics', 'campaigns', 'check', 'get', 'report'])
    // Nothing personal or creative is ever asked for.
    for (const col of COLUMNS) expect(col).not.toMatch(/AUDIENCE|PIN_|CREATIVE|KEYWORD|AGE|GENDER/)
  })

  it('names the fix for each error status', async () => {
    const cases: [HttpError, string, RegExp][] = [
      [apiError(401), 'key_rejected', /Sign in with Pinterest/],
      [apiError(403), 'pinterest_ads_permission', /Analyst/],
      [apiError(404, 'error-not-found'), 'pinterest_ads_account', /ad account id/],
      [apiError(429), 'rate_limited', /1,000/],
      [apiError(400), 'pinterest_ads_error', /ad account id/],
      [new HttpError('x', 500, 'oops'), 'pinterest_ads_error', /again/],
    ]
    for (const [err, code, next] of cases) {
      const p = new PinterestAds('tok', ACCOUNT, fake([err]).fetcher).check()
      await expect(p).rejects.toSatisfy((e: any) => e.code === code && next.test(`${e.message} ${e.next}`))
    }
  })
})

describe('sign-in', () => {
  it('trades the refresh token with Basic auth for an access token and the new refresh token', async () => {
    const { calls, fetcher } = fake([fixture('token')])
    expect(await pinterestAccessToken('cid', 'csecret', 'pinr_old', fetcher)).toEqual({ accessToken: 'pina_fakeaccess', refreshToken: 'pinr_fakerotated' })
    expect(calls[0]!.url.toString()).toBe(`${API}/oauth/token`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`)
    expect(calls[0]!.body).toEqual({ grant_type: 'refresh_token', refresh_token: 'pinr_old', scope: 'ads:read' })
  })
  it('says to sign in again when the refresh token is refused or expired', async () => {
    const { fetcher } = fake([new HttpError('Pinterest token request', 401, JSON.stringify(fixture('error-auth')))])
    await expect(pinterestAccessToken('cid', 'csecret', 'old', fetcher)).rejects.toMatchObject({ code: 'key_rejected', message: /Pinterest Ads sign-in/ })
  })
})

describe('connect', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lc-pins-'))
    process.env.LIFECYCLE_HOME = home
    process.env.LIFECYCLE_NO_KEYCHAIN = '1'
    process.env.PINS_TEST_SECRET = 'csecret'
    process.env.PINS_TEST_REFRESH = 'pinr_old'
    writeConfig({ database: { kind: 'local' } })
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'PINS_TEST_SECRET', 'PINS_TEST_REFRESH']) delete process.env[k]
  })

  it('checks the sign-in, then writes the account, app id, name, currency and time zone', async () => {
    const { calls, fetcher } = fake([fixture('token'), fixture('ad-account')])
    const r = await connectPinterestAds({ account: ACCOUNT, clientId: 'cid', secretEnv: 'PINS_TEST_SECRET', refreshTokenEnv: 'PINS_TEST_REFRESH' }, fetcher)
    expect(r).toMatchObject({ connected: true, account: ACCOUNT, name: 'Northwind Pins', currency: 'USD', timezone: 'America/Los_Angeles', refreshTokenRotated: true, keyStorage: 'environment' })
    expect(r.keyEnv).toEqual(['LIFECYCLE_PINTEREST_ADS_CLIENT_SECRET', 'LIFECYCLE_PINTEREST_ADS_REFRESH_TOKEN'])
    expect(readConfig()['pinterest-ads']).toEqual({ account: ACCOUNT, clientId: 'cid', name: 'Northwind Pins', currency: 'USD', timezone: 'America/Los_Angeles' })
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET'])
    // The secret and tokens are never written to the config or the answer.
    expect(JSON.stringify(readConfig())).not.toMatch(/csecret|pinr_|pina_/)
    expect(JSON.stringify(r)).not.toMatch(/csecret|pinr_|pina_/)
  })

  it('writes nothing when the sign-in cannot read the account', async () => {
    const { fetcher } = fake([fixture('token'), apiError(403)])
    await expect(connectPinterestAds({ account: ACCOUNT, clientId: 'cid', secretEnv: 'PINS_TEST_SECRET', refreshTokenEnv: 'PINS_TEST_REFRESH' }, fetcher)).rejects.toMatchObject({ code: 'pinterest_ads_permission' })
    expect(readConfig()['pinterest-ads']).toBeUndefined()
  })

  it('asks for the account and app id first', async () => {
    await expect(connectPinterestAds({ clientId: 'cid' }, fake([]).fetcher)).rejects.toThrow(/ad account id and Pinterest app id/)
  })
})

describe('sync', () => {
  let db: Db
  beforeEach(async () => {
    db = wrapPglite(await PGlite.create())
    await migrate(db)
  })
  afterEach(async () => db.close())

  const rows = async () => db.query(`SELECT date::text AS date, account_id, campaign_id, campaign_name, spend::float AS spend, conversions::float AS conversions, conversion_value::float AS value, currency FROM fact_pinterest_ads_daily ORDER BY date, campaign_id`)
  const names = new Map([['626736533506', 'Holiday Shopping'], ['626736533508', 'Catalog Sales']])
  const row = (DATE: string, CAMPAIGN_ID: string, micros: number) => ({ DATE, CAMPAIGN_ID, SPEND_IN_MICRO_DOLLAR: micros })

  it('pulls the window inside the 90-day limit and writes daily campaign rows', async () => {
    const asked: string[] = []
    const r = await syncPinterestAds(db, async (s, u) => (asked.push(`${s}..${u}`), { rows: fixture('analytics'), names }), { account: ACCOUNT, currency: 'USD', today: '2026-11-24' })
    expect(asked).toEqual(['2026-08-27..2026-11-24'])
    expect(r).toMatchObject({ source: 'pinterest-ads', status: 'ok', rows: 3 })
    expect(await rows()).toEqual([
      { date: '2026-11-22', account_id: ACCOUNT, campaign_id: '626736533506', campaign_name: 'Holiday Shopping', spend: 25.12, conversions: 3, value: 412.35, currency: 'USD' },
      { date: '2026-11-22', account_id: ACCOUNT, campaign_id: '626736533508', campaign_name: 'Catalog Sales', spend: 10, conversions: 0, value: 0, currency: 'USD' },
      { date: '2026-11-23', account_id: ACCOUNT, campaign_id: '626736533506', campaign_name: 'Holiday Shopping', spend: 26, conversions: 4, value: 500, currency: 'USD' },
    ])
  })

  it('replaces the window, keeps older days, and drops another account', async () => {
    await writePinterestAds(db, { rows: [row('2026-07-01', 'old', 5e6), row('2026-11-23', 'c1', 50e6), row('2026-11-23', 'gone', 1)], names: new Map() }, '2026-07-01', 'USD', '111')
    await syncPinterestAds(db, async () => ({ rows: [row('2026-11-23', 'c1', 55e6)], names: new Map() }), { account: '111', currency: 'USD', today: '2026-11-24' })
    expect((await rows()).map((r) => `${r.date} ${r.campaign_id} ${r.spend}`)).toEqual(['2026-07-01 old 5', '2026-11-23 c1 55'])
    await syncPinterestAds(db, async () => ({ rows: [row('2026-11-23', 'b1', 1e6)], names: new Map() }), { account: '222', currency: 'EUR', today: '2026-11-24' })
    expect((await rows()).map((r) => `${r.account_id} ${r.campaign_id} ${r.currency}`)).toEqual(['222 b1 EUR'])
  })

  it('warns when there is no activity, and records a failure with its code', async () => {
    expect(await syncPinterestAds(db, async () => ({ rows: [], names: new Map() }), { account: ACCOUNT, today: '2026-11-24' })).toMatchObject({ status: 'warning', rows: 0, detail: expect.stringMatching(/no campaign activity/) })
    const failed = await syncPinterestAds(db, (s, u) => new PinterestAds('t', ACCOUNT, fake([apiError(403)]).fetcher).report(s, u), { account: ACCOUNT, today: '2026-11-24' })
    expect(failed).toMatchObject({ source: 'pinterest-ads', status: 'failed', code: 'pinterest_ads_permission' })
    expect(await db.query(`SELECT status, code FROM meta_sync_run WHERE source = 'pinterest-ads' ORDER BY started_at DESC LIMIT 1`)).toEqual([{ status: 'failed', code: 'pinterest_ads_permission' }])
  })
})

describe('wiring', () => {
  it('is a built-in source with its own keys and table', () => {
    expect(parseOnly(['pinterest-ads'])).toEqual(['pinterest-ads'])
    expect(NATIVE_SECRETS['pinterest-ads']).toEqual(['pinterest-ads-client-secret', 'pinterest-ads-refresh-token'])
    expect(NATIVE_TABLES['pinterest-ads']).toEqual(['fact_pinterest_ads_daily'])
    expect(PUBLIC_TABLES).toContain('fact_pinterest_ads_daily')
  })
  it('puts both Pinterest secrets in the daily workflow only when connected', () => {
    const y = workflowYaml(false, false, [], false, false, false, false, false, false, false, false, false, false, true)
    expect(y).toContain('LIFECYCLE_PINTEREST_ADS_CLIENT_SECRET: ${{ secrets.LIFECYCLE_PINTEREST_ADS_CLIENT_SECRET }}')
    expect(y).toContain('LIFECYCLE_PINTEREST_ADS_REFRESH_TOKEN: ${{ secrets.LIFECYCLE_PINTEREST_ADS_REFRESH_TOKEN }}')
    expect(workflowYaml(false)).not.toContain('PINTEREST')
  })
})
