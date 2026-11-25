import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { countStatuses, errorInfo, MerchantCenter, merchantAccessToken, normalizeMerchantId, performanceQuery, PRODUCTS_QUERY, reportDate, toPerformanceDaily } from '../src/sources/google-merchant-center.js'
import { syncMerchantCenter, writeMerchantCenter } from '../src/sync.js'
import { connectMerchantCenter } from '../src/commands/connect.js'
import { readConfig, writeConfig } from '../src/config.js'
import { workflowYaml } from '../src/deploy.js'
import { HttpError } from '../src/http.js'
import { NATIVE_SECRETS, NATIVE_TABLES, parseOnly } from '../src/native.js'
import { envName } from '../src/secrets.js'
import { PUBLIC_TABLES } from '../src/schema.js'

// Answer shapes follow the Merchant API Reports v1 reference (int64 as strings, doubles as numbers,
// dates as google.type.Date). They are written from the docs, not captured from a live account.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/google-merchant-center/${name}.json`, import.meta.url), 'utf8'))

type Call = { url: string; method: string; headers: Record<string, string>; body: any }
function fake(answers: unknown[]) {
  const calls: Call[] = []
  const queue = [...answers]
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body })
    const next = queue.shift()
    if (next === undefined) throw new Error(`unexpected request to ${url}`)
    if (next instanceof Error) throw next
    return next
  }) as any
  return { calls, fetcher }
}
const apiError = (name: string, status = 403) => new HttpError('Merchant Center performance report', status, JSON.stringify(fixture(name)))
const SEARCH = 'https://merchantapi.googleapis.com/reports/v1/accounts/123456789/reports:search'

describe('account ids', () => {
  it('accepts the number and the resource name', () => {
    expect(normalizeMerchantId('123456789')).toBe('123456789')
    expect(normalizeMerchantId(' accounts/123456789 ')).toBe('123456789')
  })
  it('refuses anything else, so nothing odd reaches the URL', () => {
    for (const bad of ['', 'abc', '123/../x', '123-456', 'accounts/', '123456789012345678901']) expect(() => normalizeMerchantId(bad)).toThrow(/not a Merchant Center account id/)
  })
})

describe('rows', () => {
  it('reads dates as Date objects or strings, and refuses anything else', () => {
    expect(reportDate({ year: 2026, month: 3, day: 7 })).toBe('2026-03-07')
    expect(reportDate('2026-03-07')).toBe('2026-03-07')
    for (const bad of [undefined, {}, { year: 2026, month: 3 }, 'Mar 7']) expect(reportDate(bad as any)).toBeNull()
  })

  it('turns micros into money, keeps fractional conversions, and leaves ADS rows without value or currency', () => {
    expect(toPerformanceDaily([...fixture('performance-page1').results, ...fixture('performance-page2').results])).toEqual([
      { date: '2026-11-22', marketingMethod: 'ADS', clicks: 40, impressions: 2900, conversions: 0, conversionValue: 0, currency: '' },
      { date: '2026-11-22', marketingMethod: 'ORGANIC', clicks: 120, impressions: 4100, conversions: 3.5, conversionValue: 412.35, currency: 'USD' },
      { date: '2026-11-23', marketingMethod: 'ORGANIC', clicks: 95, impressions: 3800, conversions: 2, conversionValue: 180, currency: 'USD' },
    ])
  })

  it('adds rows that share a date and method, and drops rows with no date', () => {
    const v = (clicks: string, date: any = { year: 2026, month: 11, day: 1 }) => ({ productPerformanceView: { date, marketingMethod: 'ORGANIC', clicks, impressions: '10' } })
    expect(toPerformanceDaily([v('1'), v('2'), v('5', null), { productView: {} } as any])).toEqual([
      { date: '2026-11-01', marketingMethod: 'ORGANIC', clicks: 3, impressions: 20, conversions: 0, conversionValue: 0, currency: '' },
    ])
  })

  it('counts products by status, once each, and keeps nothing else', () => {
    const rows = [...fixture('products-page1').results, ...fixture('products-page2').results, fixture('products-page1').results[0], { productView: { aggregatedReportingContextStatus: 'AGGREGATED_REPORTING_CONTEXT_STATUS_UNSPECIFIED' } }]
    const c = countStatuses(rows)
    expect(c).toEqual({ products: 6, eligible: 2, eligibleLimited: 1, pending: 1, disapproved: 1 })
    expect(JSON.stringify(c)).not.toMatch(/sku/)
  })

  it('builds read-only queries and refuses dates that are not dates', () => {
    expect(performanceQuery('2026-08-26', '2026-11-24')).toBe("SELECT date, marketing_method, clicks, impressions, conversions, conversion_value FROM product_performance_view WHERE date BETWEEN '2026-08-26' AND '2026-11-24'")
    expect(PRODUCTS_QUERY).toBe('SELECT id, aggregated_reporting_context_status FROM product_view')
    expect(() => performanceQuery("2026-01-01' OR '1'='1", '2026-11-24')).toThrow(/YYYY-MM-DD/)
    expect(() => performanceQuery('2026-01-01', '24/11/2026')).toThrow(/YYYY-MM-DD/)
    // Nothing about a product beyond its status, and nothing personal, is ever asked for.
    for (const q of [performanceQuery('2026-01-01', '2026-01-02'), PRODUCTS_QUERY]) expect(q).not.toMatch(/title|offer_id|price|brand|gtin|email|customer/)
  })
})

describe('the API client', () => {
  it('checks the sign-in with a one-day report, then reads the account name', async () => {
    const { calls, fetcher } = fake([{}, fixture('account')])
    const a = await new MerchantCenter('tok', '123456789', fetcher).check('2026-11-24')
    expect(a).toEqual({ account: '123456789', name: 'Northwind Goods' })
    expect(calls[0]!.url).toBe(SEARCH)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer tok' })
    expect(calls[0]!.body.query).toBe(performanceQuery('2026-11-24', '2026-11-24'))
    expect(calls[1]!.url).toBe('https://merchantapi.googleapis.com/accounts/v1/accounts/123456789')
    expect(calls[1]!.method).toBe('GET')
  })

  it('only ever reads: two methods, and no call that changes anything', async () => {
    const { calls, fetcher } = fake([{}, fixture('account'), fixture('performance-page2'), fixture('products-page2')])
    const mc = new MerchantCenter('tok', '123456789', fetcher)
    await mc.check('2026-11-24')
    await mc.performance('2026-11-01', '2026-11-24')
    await mc.products()
    for (const c of calls) expect(c.url === SEARCH || (c.method === 'GET' && c.url.endsWith('/accounts/v1/accounts/123456789'))).toBe(true)
  })

  it('leaves the name empty when the account cannot be read, but not when the sign-in is refused', async () => {
    const { fetcher } = fake([{}, new HttpError('Merchant Center account', 403, JSON.stringify(fixture('error-permission')))])
    expect(await new MerchantCenter('tok', '123456789', fetcher).check('2026-11-24')).toEqual({ account: '123456789', name: '' })
    const refused = fake([{}, new HttpError('Merchant Center account', 401, '{"error":{"code":401,"status":"UNAUTHENTICATED"}}')])
    await expect(new MerchantCenter('tok', '123456789', refused.fetcher).check('2026-11-24')).rejects.toMatchObject({ code: 'key_rejected' })
  })

  it('follows nextPageToken until the last page, with the same query', async () => {
    const { calls, fetcher } = fake([fixture('performance-page1'), fixture('performance-page2')])
    const rows = await new MerchantCenter('tok', '123456789', fetcher).performance('2026-11-22', '2026-11-23')
    expect(rows).toHaveLength(3)
    expect(calls.map((c) => c.body.pageToken)).toEqual([undefined, 'page-2-token'])
    expect(calls[1]!.body.query).toBe(calls[0]!.body.query)
    expect(calls[0]!.body.pageSize).toBe(10000)
  })

  it('pages through every product', async () => {
    const { calls, fetcher } = fake([fixture('products-page1'), fixture('products-page2')])
    const rows = await new MerchantCenter('tok', '123456789', fetcher).products()
    expect(countStatuses(rows)).toEqual({ products: 5, eligible: 2, eligibleLimited: 1, pending: 1, disapproved: 1 })
    expect(calls.map((c) => c.body.pageToken)).toEqual([undefined, 'products-2'])
  })

  it('stops when Google repeats the same page token', async () => {
    const loop = { ...fixture('products-page2'), nextPageToken: 'same' }
    const { calls, fetcher } = fake([{ ...loop }, { ...loop }])
    await new MerchantCenter('tok', '123456789', fetcher).products()
    expect(calls).toHaveLength(2)
  })

  it('names the fix for each error', async () => {
    const cases: [HttpError, string, RegExp][] = [
      [new HttpError('x', 401, JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } })), 'key_rejected', /sign in/i],
      [apiError('error-permission'), 'merchant_center_permission', /Performance and insights/],
      [apiError('error-not-registered'), 'merchant_center_permission', /not registered/],
      [apiError('error-service-disabled'), 'merchant_center_permission', /not turned on/],
      [new HttpError('x', 429, JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } })), 'rate_limited', /Wait a few minutes/],
      [new HttpError('x', 404, JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'Account not found.' } })), 'merchant_center_account', /account id|that id/],
      [new HttpError('x', 400, JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Bad query.' } })), 'merchant_center_error', /status 400/],
    ]
    for (const [err, code, text] of cases) {
      await expect(new MerchantCenter('tok', '123456789', fake([err]).fetcher).performance('2026-11-22', '2026-11-23')).rejects.toMatchObject({ code })
      await expect(new MerchantCenter('tok', '123456789', fake([err]).fetcher).performance('2026-11-22', '2026-11-23')).rejects.toSatisfy((e: any) => text.test(`${e.message} ${e.next}`))
    }
  })

  it('reads the status, message and reasons out of a failure', () => {
    expect(errorInfo(JSON.stringify(fixture('error-service-disabled')))).toMatchObject({ status: 'PERMISSION_DENIED', reasons: ['SERVICE_DISABLED'] })
    expect(errorInfo('not json')).toEqual({ status: '', message: '', reasons: [] })
  })
})

describe('sign-in', () => {
  it('trades the refresh token for an access token', async () => {
    const { calls, fetcher } = fake([{ access_token: 'ya29.fake', expires_in: 3599, token_type: 'Bearer' }])
    expect(await merchantAccessToken('cid', 'csecret', 'rtoken', fetcher)).toBe('ya29.fake')
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
    expect(calls[0]!.body).toEqual({ grant_type: 'refresh_token', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtoken' })
  })
  it('says to sign in again when the refresh token is revoked or expired', async () => {
    const { fetcher } = fake([new HttpError('Google token request', 400, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}')])
    await expect(merchantAccessToken('cid', 'csecret', 'old', fetcher)).rejects.toMatchObject({ code: 'key_rejected', message: /Merchant Center sign-in/ })
  })
})

describe('connect', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lc-gmc-'))
    process.env.LIFECYCLE_HOME = home
    process.env.LIFECYCLE_NO_KEYCHAIN = '1'
    process.env.GMC_TEST_SECRET = 'csecret'
    process.env.GMC_TEST_REFRESH = 'rtoken'
    writeConfig({ database: { kind: 'local' } })
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'GMC_TEST_SECRET', 'GMC_TEST_REFRESH']) delete process.env[k]
  })

  it('checks the sign-in, then writes the account, client id and name', async () => {
    const { calls, fetcher } = fake([{ access_token: 'ya29.fake' }, {}, fixture('account')])
    const r = await connectMerchantCenter({ account: 'accounts/123456789', clientId: 'cid', secretEnv: 'GMC_TEST_SECRET', refreshTokenEnv: 'GMC_TEST_REFRESH' }, fetcher)
    expect(r).toMatchObject({ connected: true, account: '123456789', name: 'Northwind Goods', keyStorage: 'environment' })
    expect(r.keyEnv).toEqual(['LIFECYCLE_GOOGLE_MERCHANT_CENTER_CLIENT_SECRET', 'LIFECYCLE_GOOGLE_MERCHANT_CENTER_REFRESH_TOKEN'])
    expect(readConfig()['google-merchant-center']).toEqual({ account: '123456789', clientId: 'cid', name: 'Northwind Goods' })
    expect(calls[1]!.url).toBe(SEARCH)
    // The secret and refresh token are never written to the config.
    expect(JSON.stringify(readConfig())).not.toMatch(/csecret|rtoken/)
  })

  it('writes nothing when the sign-in cannot read reports', async () => {
    const { fetcher } = fake([{ access_token: 'ya29.fake' }, apiError('error-permission')])
    await expect(connectMerchantCenter({ account: '123456789', clientId: 'cid', secretEnv: 'GMC_TEST_SECRET', refreshTokenEnv: 'GMC_TEST_REFRESH' }, fetcher)).rejects.toMatchObject({ code: 'merchant_center_permission' })
    expect(readConfig()['google-merchant-center']).toBeUndefined()
  })

  it('asks for the account and client id first', async () => {
    await expect(connectMerchantCenter({ clientId: 'cid' }, fake([]).fetcher)).rejects.toThrow(/account id and OAuth client id/)
  })
})

describe('sync', () => {
  let db: Db
  beforeEach(async () => {
    db = wrapPglite(await PGlite.create())
    await migrate(db)
  })
  afterEach(async () => db.close())

  const performance = async () => db.query(`SELECT date::text AS date, account_id, marketing_method, clicks::int AS clicks, conversion_value::float AS value, currency FROM fact_merchant_performance_daily ORDER BY date, marketing_method`)
  const products = async () => db.query(`SELECT date::text AS date, account_id, products::int AS products, eligible::int AS eligible, eligible_limited::int AS eligible_limited, pending::int AS pending, disapproved::int AS disapproved FROM fact_merchant_products_daily ORDER BY date`)
  const load = (p: unknown[], items: unknown[] = fixture('products-page2').results) => ({ performance: async () => p as any[], products: async () => items as any[] })

  it('pulls a 90-day window and writes both tables', async () => {
    const asked: string[] = []
    const r = await syncMerchantCenter(
      db,
      { performance: async (s, u) => (asked.push(`${s}..${u}`), [...fixture('performance-page1').results, ...fixture('performance-page2').results]), products: async () => [...fixture('products-page1').results, ...fixture('products-page2').results] },
      { account: '123456789', today: '2026-11-24' },
    )
    expect(asked).toEqual(['2026-08-26..2026-11-24'])
    expect(r).toMatchObject({ source: 'google-merchant-center', status: 'ok', rows: 4 })
    expect(await performance()).toEqual([
      { date: '2026-11-22', account_id: '123456789', marketing_method: 'ADS', clicks: 40, value: 0, currency: '' },
      { date: '2026-11-22', account_id: '123456789', marketing_method: 'ORGANIC', clicks: 120, value: 412.35, currency: 'USD' },
      { date: '2026-11-23', account_id: '123456789', marketing_method: 'ORGANIC', clicks: 95, value: 180, currency: 'USD' },
    ])
    expect(await products()).toEqual([{ date: '2026-11-24', account_id: '123456789', products: 5, eligible: 2, eligible_limited: 1, pending: 1, disapproved: 1 }])
  })

  it('stores counts only: no product ids or titles anywhere', async () => {
    await syncMerchantCenter(db, load(fixture('performance-page1').results, fixture('products-page1').results), { account: '123456789', today: '2026-11-24' })
    const cols = await db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('fact_merchant_performance_daily', 'fact_merchant_products_daily')`)
    expect(cols.map((c) => String(c.column_name)).filter((c) => /id$|title|offer|price/.test(c) && c !== 'account_id')).toEqual([])
    const all = JSON.stringify([...(await db.query('SELECT * FROM fact_merchant_performance_daily')), ...(await db.query('SELECT * FROM fact_merchant_products_daily'))])
    expect(all).not.toMatch(/sku|online~/)
  })

  it('replaces the window, keeps older days, and drops another account', async () => {
    const row = (day: number, clicks: string) => ({ productPerformanceView: { date: { year: 2026, month: day > 30 ? 7 : 11, day: day > 30 ? 1 : day }, marketingMethod: 'ORGANIC', clicks, impressions: '1' } })
    await writeMerchantCenter(db, { performance: [row(31, '5'), row(23, '50')], products: fixture('products-page1').results }, '2026-07-01', '2026-11-20', '111')
    await syncMerchantCenter(db, load([row(23, '55')]), { account: '111', today: '2026-11-24' })
    expect((await performance()).map((r) => `${r.date} ${r.clicks}`)).toEqual(['2026-07-01 5', '2026-11-23 55'])
    // The snapshot from an earlier day stays; the sync day gets its own row.
    expect((await products()).map((r) => `${r.date} ${r.products}`)).toEqual(['2026-11-20 3', '2026-11-24 2'])
    // The same day again replaces that day's snapshot.
    await syncMerchantCenter(db, load([row(23, '55')], fixture('products-page1').results), { account: '111', today: '2026-11-24' })
    expect((await products()).map((r) => `${r.date} ${r.products}`)).toEqual(['2026-11-20 3', '2026-11-24 3'])
    await syncMerchantCenter(db, load([row(23, '7')]), { account: '222', today: '2026-11-24' })
    expect((await performance()).map((r) => `${r.account_id} ${r.clicks}`)).toEqual(['222 7'])
    expect((await products()).map((r) => r.account_id)).toEqual(['222'])
  })

  it('warns with no products or no activity, and records a failure with its code', async () => {
    expect(await syncMerchantCenter(db, load(fixture('performance-page1').results, []), { account: '123456789', today: '2026-11-24' })).toMatchObject({ status: 'warning', detail: expect.stringMatching(/no products/) })
    expect(await syncMerchantCenter(db, load([]), { account: '123456789', today: '2026-11-24' })).toMatchObject({ status: 'warning', rows: 1, detail: expect.stringMatching(/no clicks or impressions/) })
    const failed = await syncMerchantCenter(db, { performance: async (s, u) => new MerchantCenter('t', '123456789', fake([apiError('error-not-registered')]).fetcher).performance(s, u), products: async () => [] }, { account: '123456789', today: '2026-11-24' })
    expect(failed).toMatchObject({ source: 'google-merchant-center', status: 'failed', code: 'merchant_center_permission' })
    expect(await db.query(`SELECT status, code FROM meta_sync_run WHERE source = 'google-merchant-center' ORDER BY started_at DESC LIMIT 1`)).toEqual([{ status: 'failed', code: 'merchant_center_permission' }])
  })
})

describe('wiring', () => {
  it('is a built-in source with its own keys and tables', () => {
    expect(parseOnly(['google-merchant-center'])).toEqual(['google-merchant-center'])
    expect(NATIVE_SECRETS['google-merchant-center']).toEqual(['google-merchant-center-client-secret', 'google-merchant-center-refresh-token'])
    expect(NATIVE_SECRETS['google-merchant-center'].map(envName)).toEqual(['LIFECYCLE_GOOGLE_MERCHANT_CENTER_CLIENT_SECRET', 'LIFECYCLE_GOOGLE_MERCHANT_CENTER_REFRESH_TOKEN'])
    expect(NATIVE_TABLES['google-merchant-center']).toEqual(['fact_merchant_performance_daily', 'fact_merchant_products_daily'])
    for (const t of NATIVE_TABLES['google-merchant-center']) expect(PUBLIC_TABLES).toContain(t)
  })
  it('puts both Merchant Center secrets in the daily workflow only when connected', () => {
    const y = workflowYaml(false, false, [], false, false, false, false, true)
    expect(y).toContain('LIFECYCLE_GOOGLE_MERCHANT_CENTER_CLIENT_SECRET: ${{ secrets.LIFECYCLE_GOOGLE_MERCHANT_CENTER_CLIENT_SECRET }}')
    expect(y).toContain('LIFECYCLE_GOOGLE_MERCHANT_CENTER_REFRESH_TOKEN: ${{ secrets.LIFECYCLE_GOOGLE_MERCHANT_CENTER_REFRESH_TOKEN }}')
    expect(workflowYaml(false, false, [], false, false, false, true)).not.toContain('MERCHANT_CENTER')
  })
})
