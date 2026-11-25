import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { getSetting, listSettings, readRawConfig, setSetting, settingValue, unsetSetting, writeConfig } from '../src/config.js'
import { reconcile, runChecks, tolerances } from '../src/reconcile.js'
import { runQuery } from '../src/query.js'
import { runMetric } from '../src/metrics.js'
import { chooseSources, disconnectNative, parseOnly } from '../src/native.js'
import { fetchJson, HttpError } from '../src/http.js'
import { fetchOrders, shopifyQueryError } from '../src/sources/shopify.js'
import { MetaAds } from '../src/sources/meta.js'
import { Stripe } from '../src/sources/stripe.js'
import { ga4AccessToken } from '../src/sources/ga4.js'
import { syncShopify, writeShopify } from '../src/sync.js'

let home: string
let db: Db

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'lc-controls-'))
  process.env.LIFECYCLE_HOME = home
  process.env.LIFECYCLE_NO_KEYCHAIN = '1'
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(async () => {
  await db.close()
  rmSync(home, { recursive: true, force: true })
  delete process.env.LIFECYCLE_HOME
  delete process.env.LIFECYCLE_NO_KEYCHAIN
  delete process.env.LIFECYCLE_META_ADS_TOKEN
  vi.unstubAllGlobals()
})

const day = (offset: number) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10)

describe('owner settings', () => {
  it('read as today\'s constants until someone sets them', () => {
    expect(settingValue('reconcile.tolerance.klaviyo_orders')).toBe(3)
    expect(settingValue('reconcile.tolerance.ga4_purchases')).toBe(15)
    expect(settingValue('reconcile.attributed_share_flag')).toBe(60)
    expect(settingValue('reconcile.freshness_days')).toBe(2)
    expect(settingValue('query.row_cap')).toBe(1000)
    expect(settingValue('metrics.default_days')).toBe(90)
    expect(tolerances()).toEqual({ klaviyoOrders: 3, ga4Purchases: 15, attributedShareFlag: 60, freshnessDays: 2, minDifference: 3, days: 90 })
    expect(listSettings().find((s) => s.key === 'query.row_cap')).toMatchObject({ value: null, default: 1000 })
  })

  it('set, read and unset as nested keys, and leave no empty section behind', () => {
    expect(setSetting('reconcile.tolerance.klaviyo_orders', '5')).toBe(5)
    expect(setSetting('reconcile.freshness_days', '3')).toBe(3)
    expect(readRawConfig()).toEqual({ reconcile: { tolerance: { klaviyo_orders: 5 }, freshness_days: 3 } })
    expect(getSetting('reconcile.tolerance.klaviyo_orders')).toBe(5)
    expect(settingValue('reconcile.tolerance.klaviyo_orders')).toBe(5)
    unsetSetting('reconcile.tolerance.klaviyo_orders')
    expect(readRawConfig()).toEqual({ reconcile: { freshness_days: 3 } })
    unsetSetting('reconcile.freshness_days')
    expect(readRawConfig()).toEqual({})
    unsetSetting('query.row_cap')
    expect(settingValue('reconcile.tolerance.klaviyo_orders')).toBe(3)
  })

  it('refuse values out of range, and fall back to the default on a bad hand edit', () => {
    expect(() => setSetting('query.row_cap', '0')).toThrow(/whole number from 1/)
    expect(() => setSetting('query.row_cap', '2.5')).toThrow(/whole number/)
    expect(() => setSetting('metrics.default_days', '731')).toThrow(/1 to 730/)
    expect(() => setSetting('reconcile.tolerance.ga4_purchases', 'lots')).toThrow(/number from 0 to 100/)
    expect(() => setSetting('reconcile.tolerance.ga4_purchases', '')).toThrow(/number/)
    expect(() => setSetting('reconcile.tolerance', '5')).toThrow(/Unknown setting/)
    writeConfig({ database: { kind: 'local' }, query: { row_cap: -4 } } as any)
    expect(settingValue('query.row_cap')).toBe(1000)
  })

  it('keep working when connect rewrites the config', () => {
    setSetting('metrics.default_days', '30')
    writeConfig({ database: { kind: 'local' } })
    writeConfig({ database: { kind: 'local' }, klaviyo: { connected: true } })
    expect(settingValue('metrics.default_days')).toBe(30)
  })
})

describe('settings wired into the numbers', () => {
  // 0.15.1: a two-source check runs only when both are connected and have synced, so connect them here.
  beforeEach(async () => {
    writeConfig({ database: { kind: 'local' }, shopify: { store: 'test.myshopify.com', clientId: 'c' }, klaviyo: { connected: true }, ga4: { property: '1', clientId: 'c' } } as any)
    for (const s of ['shopify', 'klaviyo', 'ga4']) await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ($1, $2, now() - interval '1 minute', now() - interval '1 minute', 'ok')`, [`seed-${s}`, s])
    await db.query(`INSERT INTO meta_source_window VALUES ('klaviyo', 'placed_orders', $1, $2, now())`, [day(30), day(0)])
  })
  async function seedKlaviyoGap() {
    // Shopify 100 orders, Klaviyo 95: a 5% gap.
    await db.query(`INSERT INTO fact_orders_daily VALUES ($1, 100, 1000, 1000, 0, 100, 0, now(), 0)`, [day(1)])
    await db.query(`INSERT INTO fact_klaviyo_orders_daily VALUES ($1, 95, 950, now())`, [day(1)])
  }

  it('reads the connected sources from an explicit list when a host passes one (Cosmic Cloud)', async () => {
    writeConfig({ database: { kind: 'postgres' }, connected: ['shopify', 'klaviyo'] } as any)
    expect(tolerances().connected).toEqual(['shopify', 'klaviyo'])
    writeConfig({ database: { kind: 'postgres' }, connected: ['shopify'] } as any)
    await seedKlaviyoGap()
    expect((await runChecks(db)).find((c) => c.name === 'klaviyo_orders')).toMatchObject({ status: 'skipped', detail: 'Not checked yet: Klaviyo is not connected.' })
  })

  it('uses the Klaviyo tolerance from config', async () => {
    await seedKlaviyoGap()
    expect((await runChecks(db)).find((c) => c.name === 'klaviyo_orders')!.status).toBe('fail')
    setSetting('reconcile.tolerance.klaviyo_orders', '6')
    const c = (await runChecks(db)).find((c) => c.name === 'klaviyo_orders')!
    expect(c.status).toBe('pass')
    expect(c.detail).toMatch(/within 6%/)
  })

  it('uses the GA4 tolerance and the attributed share flag from config', async () => {
    await db.query(`INSERT INTO fact_orders_daily VALUES ($1, 100, 1000, 1000, 0, 100, 0, now(), 0)`, [day(1)])
    await db.query(`INSERT INTO fact_ga4_daily VALUES ($1, 'Email', 10, 80, 800, now())`, [day(1)])
    await db.query(`INSERT INTO fact_flow_daily (flow_id, flow_message_id, channel, date, revenue, source_synced_at) VALUES ('f', 'm', 'email', $1, 500, now())`, [day(1)])
    let checks = await runChecks(db)
    expect(checks.find((c) => c.name === 'ga4_purchases')!.status).toBe('fail')
    expect(checks.find((c) => c.name === 'attributed_share')!.status).toBe('pass')
    setSetting('reconcile.tolerance.ga4_purchases', '25')
    setSetting('reconcile.attributed_share_flag', '40')
    checks = await runChecks(db)
    expect(checks.find((c) => c.name === 'ga4_purchases')!.status).toBe('pass')
    expect(checks.find((c) => c.name === 'attributed_share')!.status).toBe('warn')
  })

  it('uses the freshness limit from config', async () => {
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('s', 'stripe', now() - interval '3 days', now() - interval '3 days', 'ok')`)
    expect((await runChecks(db)).find((c) => c.name === 'freshness')!.status).toBe('fail')
    setSetting('reconcile.freshness_days', '4')
    const f = (await runChecks(db)).find((c) => c.name === 'freshness')!
    expect(f).toMatchObject({ status: 'pass', expected: 4 })
    expect(f.detail).toMatch(/within 4 days/)
  })

  it('caps query rows at the configured number', async () => {
    setSetting('query.row_cap', '5')
    const r = await runQuery(db, 'SELECT generate_series(1, 20) AS n')
    expect(r).toMatchObject({ rowCount: 5, truncated: true })
    expect((await runQuery(db, 'SELECT generate_series(1, 20) AS n', 50)).truncated).toBe(false)
  })

  it('runs metrics over the configured default window', async () => {
    expect((await runMetric(db, 'shopify_orders')).days).toBe(90)
    setSetting('metrics.default_days', '30')
    expect((await runMetric(db, 'shopify_orders')).days).toBe(30)
    expect((await runMetric(db, 'shopify_orders', 7)).days).toBe(7)
  })
})

describe('sync --only', () => {
  const none = { shopify: false, klaviyo: false, ga4: false, stripe: false, meta: false }

  it('takes repeated flags and comma lists', () => {
    expect(parseOnly(undefined)).toBeNull()
    expect(parseOnly([])).toBeNull()
    expect(parseOnly(['meta'])).toEqual(['meta'])
    expect(parseOnly(['shopify,Meta', 'meta', ' ga4 '])).toEqual(['shopify', 'meta', 'ga4'])
  })

  it('rejects a source that is not built in', () => {
    expect(() => parseOnly(['gorgias'])).toThrow(expect.objectContaining({ code: 'unknown_source' }))
  })

  it('syncs every connected source without --only, and only the named ones with it', () => {
    const connected = { ...none, shopify: true, klaviyo: true, meta: true }
    expect(chooseSources(null, connected)).toEqual(['shopify', 'klaviyo', 'meta'])
    expect(chooseSources(['meta'], connected)).toEqual(['meta'])
    expect(chooseSources(['meta', 'shopify'], connected)).toEqual(['shopify', 'meta'])
  })

  it('fails when an asked-for source is not connected, instead of doing nothing', () => {
    expect(() => chooseSources(['stripe'], { ...none, meta: true })).toThrow(expect.objectContaining({ code: 'not_connected', message: 'Not connected: stripe.' }))
  })

  it('writes one run row per source, so one source on its own schedule has its own history', async () => {
    await syncShopify(db, async () => [])
    await syncShopify(db, async () => [])
    const rows = await db.query(`SELECT source, status FROM meta_sync_run`)
    expect(rows).toEqual([{ source: 'shopify', status: 'ok' }, { source: 'shopify', status: 'ok' }])
  })
})

describe('disconnect', () => {
  const removedNone = () => false
  const order = { processedAt: `${day(1)}T10:00:00Z`, cancelledAt: null, customer: { id: 'a' }, currentTotalPriceSet: { shopMoney: { amount: '10.00' } }, totalDiscountsSet: { shopMoney: { amount: '0.00' } } }

  beforeEach(() => {
    writeConfig({ database: { kind: 'local' }, shopify: { store: 'x.myshopify.com', clientId: 'id' }, meta: { account: 'act_1', name: 'A', currency: 'USD', timezone: 'UTC' } })
    setSetting('query.row_cap', '200')
  })

  it('removes the settings and keeps the data', async () => {
    await writeShopify(db, [order])
    const r = await disconnectNative('shopify', { db, remove: removedNone })
    expect(r).toMatchObject({ source: 'shopify', disconnected: true, configRemoved: true, dataDeleted: [] })
    expect(r.note).toMatch(/kept in fact_orders_daily/)
    const raw = readRawConfig()
    expect(raw.shopify).toBeUndefined()
    expect(raw.meta).toBeDefined()
    expect(raw.query).toEqual({ row_cap: 200 })
    expect(await db.query('SELECT count(*)::int AS n FROM fact_orders_daily')).toEqual([{ n: 1 }])
  })

  it('deletes only that source\'s data with deleteData', async () => {
    await writeShopify(db, [order])
    await db.query(`INSERT INTO meta_source_total VALUES ('shopify', 'orders_pulled', 1, now()), ('stripe', 'charges_pulled', 4, now())`)
    await db.query(`INSERT INTO fact_meta_ads_daily VALUES ($1, 'c', 'C', 1, 1, 1, 0, 0, 'USD', 'act_1', now())`, [day(1)])
    const r = await disconnectNative('shopify', { db, deleteData: true, remove: removedNone })
    expect(r.dataDeleted).toEqual(['fact_orders_daily', 'fact_cohort_monthly'])
    expect(await db.query('SELECT count(*)::int AS n FROM fact_orders_daily')).toEqual([{ n: 0 }])
    expect(await db.query('SELECT count(*)::int AS n FROM fact_cohort_monthly')).toEqual([{ n: 0 }])
    expect(await db.query('SELECT source FROM meta_source_total')).toEqual([{ source: 'stripe' }])
    expect(await db.query('SELECT count(*)::int AS n FROM fact_meta_ads_daily')).toEqual([{ n: 1 }])
  })

  it('removes every saved key the source had', async () => {
    const asked: string[] = []
    const r = await disconnectNative('meta', { db, remove: (n) => (asked.push(n), true) })
    expect(asked).toEqual(['meta-ads-token'])
    expect(r.keysRemoved).toEqual(['meta-ads-token'])
  })

  it('logs the disconnect, and freshness stops counting the source', async () => {
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('old', 'meta', now() - interval '5 days', now() - interval '5 days', 'ok')`)
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('new', 'stripe', now(), now(), 'ok')`)
    expect((await runChecks(db)).find((c) => c.name === 'freshness')!.status).toBe('fail')
    await disconnectNative('meta', { db, remove: removedNone })
    expect(await db.query(`SELECT status FROM meta_sync_run WHERE source = 'meta' ORDER BY started_at DESC LIMIT 1`)).toEqual([{ status: 'disconnected' }])
    expect((await runChecks(db)).find((c) => c.name === 'freshness')!.status).toBe('pass')
    // Syncing again after reconnecting brings it back into the check.
    await syncShopify(db, async () => [])
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('back', 'meta', now() + interval '1 second', now() - interval '5 days', 'ok')`)
    expect((await runChecks(db)).find((c) => c.name === 'freshness')!.status).toBe('fail')
  })

  it('says when a key is still set in the environment', async () => {
    process.env.LIFECYCLE_META_ADS_TOKEN = 'not-a-real-token'
    const r = await disconnectNative('meta', { db, remove: removedNone })
    expect(r.stillInEnvironment).toEqual(['LIFECYCLE_META_ADS_TOKEN'])
    expect(r.note).toMatch(/still set in the environment/)
    expect(JSON.stringify(r)).not.toContain('not-a-real-token')
  })

  it('refuses an unknown source and one that is not connected', async () => {
    await expect(disconnectNative('gorgias', { db, remove: removedNone })).rejects.toMatchObject({ code: 'unknown_source' })
    await expect(disconnectNative('stripe', { db, remove: removedNone })).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('will not claim data was deleted without a database', async () => {
    await expect(disconnectNative('meta', { db: null, deleteData: true, remove: removedNone })).rejects.toMatchObject({ code: 'no_database' })
  })
})

describe('error codes the app maps', () => {
  const respond = (status: number, body = '{}') => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))

  it('gives key_rejected on a 401 and rate_limited on a 429 from any source', async () => {
    respond(401)
    await expect(fetchJson('https://example.test', {}, 'Klaviyo account check', { retries: 0 })).rejects.toMatchObject({ code: 'key_rejected', status: 401, message: 'Klaviyo account check failed: the key was rejected.' })
    respond(429)
    await expect(fetchJson('https://example.test', {}, 'Stripe charges', { retries: 0 })).rejects.toMatchObject({ code: 'rate_limited', status: 429 })
    respond(500)
    await expect(fetchJson('https://example.test', {}, 'x', { retries: 0 })).rejects.toMatchObject({ code: 'http_error' })
  })

  it('gives scope_denied when Shopify refuses a field or scope', () => {
    const e = shopifyQueryError([{ message: 'Access denied for orders field. Required access: `read_orders` access scope.', extensions: { code: 'ACCESS_DENIED' } }])
    expect(e).toMatchObject({ code: 'scope_denied', message: 'Shopify did not let this app read orders. It needs the read_orders scope.' })
    expect(e.next).toMatch(/read_orders/)
    expect(shopifyQueryError([{ message: 'Access denied for customer field.' }]).code).toBe('scope_denied')
  })

  it('keeps the protected data code, and codes every other Shopify query error', () => {
    expect(shopifyQueryError([{ message: 'This app is not approved to access the Customer object.' }]).code).toBe('shopify_protected_data')
    expect(shopifyQueryError([{ message: 'Throttled', extensions: { code: 'THROTTLED' } }]).code).toBe('rate_limited')
    expect(shopifyQueryError([{ message: 'Field oops does not exist' }])).toMatchObject({ code: 'shopify_query', message: 'Shopify rejected the orders query.' })
  })

  it('raises scope_denied from the orders pull, whether Shopify sends errors or a 403', async () => {
    respond(200, JSON.stringify({ errors: [{ message: 'Access denied for orders field. Required access: `read_orders` access scope.', extensions: { code: 'ACCESS_DENIED' } }] }))
    await expect(fetchOrders('x.myshopify.com', 'tok')).rejects.toMatchObject({ code: 'scope_denied' })
    respond(403, '{"errors":"[API] This action requires merchant approval for read_orders scope."}')
    await expect(fetchOrders('x.myshopify.com', 'tok')).rejects.toMatchObject({ code: 'scope_denied', message: expect.stringMatching(/read_orders scope/) })
  })

  it('stores the code on the failed run, so the app can show the right sentence', async () => {
    const r = await syncShopify(db, async () => { throw shopifyQueryError([{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }]) })
    expect(r).toMatchObject({ status: 'failed', code: 'scope_denied' })
    expect(await db.query(`SELECT status, code FROM meta_sync_run`)).toEqual([{ status: 'failed', code: 'scope_denied' }])
  })

  it('maps Meta, Stripe and GA4 refusals to the same codes', async () => {
    const meta = (e: Error) => new MetaAds('tok', '1234567890', (async () => { throw e }) as any)
    await expect(meta(new HttpError('Meta', 401, '{}')).check()).rejects.toMatchObject({ code: 'key_rejected' })
    await expect(meta(new HttpError('Meta', 400, JSON.stringify({ error: { message: 'User request limit reached', code: 17 } }))).check()).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(meta(new HttpError('Meta', 429, '')).check()).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(new Stripe('rk_test_x', (async () => { throw new HttpError('Stripe', 401, '') }) as any).check()).rejects.toMatchObject({ code: 'key_rejected' })
    await expect(new Stripe('rk_test_x', (async () => { throw new HttpError('Stripe', 403, '') }) as any).check()).rejects.toMatchObject({ code: 'stripe_key' })
    respond(400, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}')
    await expect(ga4AccessToken('id', 'secret', 'refresh')).rejects.toMatchObject({ code: 'key_rejected', message: 'Google rejected the saved GA4 sign-in.' })
  })

  it('reconcile still runs on defaults with no config file at all', async () => {
    rmSync(join(home, 'config.json'), { force: true })
    const r = await reconcile(db)
    expect(r.checks.map((c) => c.name)).toContain('freshness')
  })
})
