import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { reconcile, trustLine, compare, compareCounts, TOLERANCE, type Tolerances } from '../src/reconcile.js'
import { syncShopify } from "../src/sync.js"
import { parseGa4Report } from '../src/sources/ga4.js'
import { parseFlowValues, parseMetricAggregate } from '../src/sources/klaviyo.js'

const day = new Date(Date.now() - 3 * 86400000).toISOString()
const order = (customer: string | null) => ({
  processedAt: day, cancelledAt: null, customer: customer ? { id: customer } : null,
  currentTotalPriceSet: { shopMoney: { amount: '100.00' } }, totalDiscountsSet: { shopMoney: { amount: '0.00' } },
})
const orders = [order('a'), order('b'), order(null)]
// Explicit tolerances, so a developer's own config.json never changes what a test sees.
const T = (o: Partial<Tolerances> = {}): Tolerances => ({ ...TOLERANCE, days: 90, ...o })
const ws = { type: 'shopify', reference: 'shopify' } as never
const byName = async (db: Db, o: Partial<Tolerances> = {}) => Object.fromEntries((await reconcile(db, T(o), ws)).checks.map((c) => [c.name, c]))
const many = (n: number, daysAgo = 3) => Array.from({ length: n }, (_, i) => ({ ...order(`c${i}`), processedAt: new Date(Date.now() - daysAgo * 86400000).toISOString() }))
const ago = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
const run = (db: Db, source: string, status = 'ok', id = source) => db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ($1, $2, now(), now(), $3)`, [id, source, status])
const klaviyoOrders = async (db: Db, n: number, day = 3) => {
  await db.query(`INSERT INTO meta_source_window VALUES ('klaviyo', 'placed_orders', $1, $2, now())`, [ago(30), ago(0)])
  await db.query(`INSERT INTO fact_klaviyo_orders_daily VALUES ($1, $2, 0, now())`, [ago(day), n])
}

let db: Db
beforeEach(async () => {
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(() => db.close())

describe('reconcile', () => {
  it('passes complete data, including guest orders', async () => {
    await syncShopify(db, async () => orders, async () => 3)
    const c = await byName(db)
    expect(c.orders_complete?.status).toBe('pass')
    expect(c.orders_vs_cohorts?.status).toBe('pass')
  })

  it('fails loudly when the pull is incomplete', async () => {
    await syncShopify(db, async () => orders, async () => 5)
    const c = await byName(db)
    expect(c.orders_complete).toMatchObject({ status: 'fail', expected: 5, actual: 3 })
    expect(c.orders_complete?.detail).toContain('Do not trust')
  })

  it('fails when the daily totals are missing days, even though the two stored totals agree', async () => {
    await syncShopify(db, async () => orders, async () => 3)
    await db.query(`DELETE FROM fact_orders_daily`)
    await db.query(`INSERT INTO fact_orders_daily (date, orders, gross_revenue, net_revenue, discounts, new_orders, returning_orders, guest_orders, source_synced_at) VALUES (current_date - 3, 2, 200, 200, 0, 2, 0, 0, now())`)
    const c = await byName(db)
    expect(c.orders_complete).toMatchObject({ status: 'fail', expected: 3, actual: 2 })
    expect(c.orders_complete?.detail).toContain('daily totals')
  })

  it('leaves cancelled orders out of the daily count it expects', async () => {
    const cancelled = { ...order('d'), cancelledAt: day }
    await syncShopify(db, async () => [...orders, cancelled], async () => 4)
    expect((await byName(db)).orders_complete?.status).toBe('pass')
  })

  it('checks a store synced before orders_kept existed against everything pulled', async () => {
    await syncShopify(db, async () => orders, async () => 3)
    await db.query(`DELETE FROM meta_source_total WHERE metric = 'orders_kept'`)
    await db.query(`UPDATE fact_orders_daily SET orders = orders - 1`)
    const c = await byName(db)
    expect(c.orders_complete?.status).toBe('fail')
    expect(c.orders_complete?.detail).toContain('sync Shopify again')
  })

  it('catches a number changed after sync', async () => {
    await syncShopify(db, async () => orders, async () => 3)
    await db.query(`UPDATE fact_orders_daily SET new_orders = new_orders + 7`)
    expect((await byName(db)).orders_vs_cohorts?.status).toBe('fail')
  })

  it('flags Klaviyo seeing no orders at all', async () => {
    await syncShopify(db, async () => many(20), async () => 20)
    await db.query(`INSERT INTO meta_source_window VALUES ('klaviyo', 'placed_orders', $1, $2, now())`, [ago(30), ago(0)])
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('k', 'klaviyo', now(), now(), 'ok')`)
    const c = await byName(db)
    expect(c.klaviyo_orders?.status).toBe('fail')
    expect(c.klaviyo_orders?.detail).toContain('may not be connected')
  })

  it('compares Klaviyo only over the days it was synced for', async () => {
    const old = { ...order('c'), processedAt: new Date(Date.now() - 40 * 86400000).toISOString() }
    await syncShopify(db, async () => [...orders, old], async () => 4)
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('k', 'klaviyo', now(), now(), 'ok')`)
    await db.query(`INSERT INTO meta_source_window VALUES ('klaviyo', 'placed_orders', $1, $2, now())`, [ago(7), ago(0)])
    await db.query(`INSERT INTO fact_klaviyo_orders_daily VALUES ($1, 3, 300, now())`, [ago(3)])
    const c = await byName(db)
    expect(c.klaviyo_orders).toMatchObject({ status: 'pass', expected: 3, actual: 3 })
    expect(c.klaviyo_orders?.detail).toContain('the complete days Klaviyo was synced for')
  })

  it('still catches a real gap inside the synced days', async () => {
    await syncShopify(db, async () => orders, async () => 3)
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('k', 'klaviyo', now(), now(), 'ok')`)
    await db.query(`INSERT INTO meta_source_window VALUES ('klaviyo', 'placed_orders', $1, $2, now())`, [ago(7), ago(0)])
    await db.query(`INSERT INTO fact_klaviyo_orders_daily VALUES ($1, 1, 100, now())`, [ago(3)])
    // 3 against 1 is within the small-store floor of 3 orders; with the floor at 1 it is a real gap.
    expect((await byName(db)).klaviyo_orders).toMatchObject({ status: 'pass', expected: 3, actual: 1 })
    expect((await byName(db, { minDifference: 1 })).klaviyo_orders).toMatchObject({ status: 'fail', expected: 3, actual: 1 })
  })

  it('applies the 3% tolerance to Klaviyo orders', async () => {
    expect(compare('x', 100, 97, 3, 'o').status).toBe('pass')
    expect(compare('x', 100, 96, 3, 'o').status).toBe('fail')
  })

  it('flags stale data', async () => {
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('s', 'shopify', now() - interval '5 days', now() - interval '5 days', 'ok')`)
    expect((await byName(db)).freshness?.status).toBe('fail')
  })

  it('skips honestly when a source is missing', async () => {
    const c = await byName(db)
    expect(c.ga4_purchases?.status).toBe('skipped')
    expect(c.attributed_share?.status).toBe('skipped')
  })

  it('warns when attributed revenue looks too high, and names attribution', async () => {
    await syncShopify(db, async () => orders, async () => 3)
    await run(db, 'klaviyo')
    await db.query(`INSERT INTO fact_flow_daily (flow_id, flow_message_id, channel, date, revenue, source_synced_at) VALUES ('F','M','email',CURRENT_DATE - 2, 250, now())`)
    const c = await byName(db)
    expect(c.attributed_share?.status).toBe('warn')
    expect(c.attributed_share?.detail).toContain('not proof of causation')
  })

  it('makes every report carry a trust line', async () => {
    expect((await trustLine(db)).status).toBe('unchecked')
    await syncShopify(db, async () => orders, async () => 9)
    await reconcile(db)
    const t = await trustLine(db)
    expect(t.status).toBe('failed')
    expect(t.line).toContain('DO NOT TRUST')
  })
})

// The QA matrix for Jake's 2026-11-25 report: a GA4 check failed on a store with no GA4, because the
// warehouse still held rows from a copied store. Each case names what the owner should see.
describe('reconcile runs only what it can honestly check', () => {
  it('Shopify only: every pair check reads not checked yet, never failed', async () => {
    await syncShopify(db, async () => many(50), async () => 50)
    const c = await byName(db, { connected: ['shopify'] })
    expect(c.orders_complete?.status).toBe('pass')
    expect(c.klaviyo_orders).toMatchObject({ status: 'skipped', detail: 'Not checked yet: Klaviyo is not connected.' })
    expect(c.ga4_purchases).toMatchObject({ status: 'skipped', detail: 'Not checked yet: GA4 is not connected.' })
  })

  it('GA4 not connected: leftover GA4 rows from another store never fail the check', async () => {
    await syncShopify(db, async () => many(50), async () => 50)
    await run(db, 'ga4', 'ok', 'old-ga4')
    await db.query(`INSERT INTO fact_ga4_daily VALUES ($1, 'Email', 1000, 465913, 0, now())`, [ago(3)])
    const c = await byName(db, { connected: ['shopify', 'klaviyo'] })
    expect(c.ga4_purchases?.status).toBe('skipped')
    expect(c.ga4_purchases?.detail).toContain('GA4 is not connected')
  })

  it('Shopify and Klaviyo agree: pass', async () => {
    await syncShopify(db, async () => many(100), async () => 100)
    await run(db, 'klaviyo')
    await klaviyoOrders(db, 99)
    expect((await byName(db, { connected: ['shopify', 'klaviyo'] })).klaviyo_orders).toMatchObject({ status: 'pass', expected: 100, actual: 99 })
  })

  it('Shopify and Klaviyo disagree: fail with both numbers', async () => {
    await syncShopify(db, async () => many(100), async () => 100)
    await run(db, 'klaviyo')
    await klaviyoOrders(db, 70)
    const k = (await byName(db, { connected: ['shopify', 'klaviyo'] })).klaviyo_orders
    expect(k).toMatchObject({ status: 'fail', expected: 100, actual: 70, diffPct: 30 })
  })

  it('a removed Klaviyo account: rows from before the disconnect never count', async () => {
    await syncShopify(db, async () => many(100), async () => 100)
    await db.query(`INSERT INTO meta_source_window VALUES ('klaviyo', 'placed_orders', $1, $2, now() - interval '2 days')`, [ago(30), ago(0)])
    await db.query(`INSERT INTO fact_klaviyo_orders_daily VALUES ($1, 493470, 0, now() - interval '2 days')`, [ago(3)])
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('d', 'klaviyo', now() - interval '1 day', now() - interval '1 day', 'disconnected')`)
    await run(db, 'klaviyo', 'warning', 'k2')
    const k = (await byName(db, { connected: ['shopify', 'klaviyo'] })).klaviyo_orders
    // The new account has no orders, so the honest answer is the real gap, not 90,000% off.
    expect(k).toMatchObject({ status: 'fail', expected: 100, actual: 0 })
    expect(k?.detail).toContain('may not be connected')
  })

  it('a sync still running: not checked yet', async () => {
    await syncShopify(db, async () => many(100), async () => 100)
    await run(db, 'klaviyo')
    await klaviyoOrders(db, 10)
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, status) VALUES ('r', 'klaviyo', now() + interval '1 second', 'running')`)
    expect((await byName(db, { connected: ['shopify', 'klaviyo'] })).klaviyo_orders).toMatchObject({ status: 'skipped', detail: 'Not checked yet: Klaviyo is still syncing.' })
  })

  it('a different store timezone: only complete days count, so today never fails the check', async () => {
    // Klaviyo has caught up on yesterday but not today's late orders; today is left out of both sides.
    await syncShopify(db, async () => [...many(100, 3), ...many(40, 0)], async () => 140)
    await run(db, 'klaviyo')
    await klaviyoOrders(db, 100)
    expect((await byName(db, { connected: ['shopify', 'klaviyo'] })).klaviyo_orders).toMatchObject({ status: 'pass', expected: 100, actual: 100 })
  })

  it('a small store: one or two orders apart passes, a store with too few orders is not checked', async () => {
    expect(compareCounts('klaviyo_orders', 5, 3, 3, 3, 'o').status).toBe('pass')
    await syncShopify(db, async () => many(2), async () => 2)
    await run(db, 'klaviyo')
    await db.query(`INSERT INTO meta_source_window VALUES ('klaviyo', 'placed_orders', $1, $2, now())`, [ago(30), ago(0)])
    expect((await byName(db, { connected: ['shopify', 'klaviyo'] })).klaviyo_orders?.status).toBe('skipped')
  })

  it('a large store: the percent rules, the floor does not hide a real gap', async () => {
    expect(compareCounts('klaviyo_orders', 50000, 48000, 3, 3, 'o')).toMatchObject({ status: 'fail', diffPct: 4 })
    expect(compareCounts('klaviyo_orders', 50000, 49000, 3, 3, 'o').status).toBe('pass')
  })
})

describe('parsers from documented formats', () => {
  it('reads a GA4 report', () => {
    const body = { rows: [{ dimensionValues: [{ value: '20261001' }, { value: 'Email' }], metricValues: [{ value: '10' }, { value: '2' }, { value: '150.5' }] }] }
    expect(parseGa4Report(body)).toEqual([{ date: '2026-10-01', channel: 'Email', sessions: 10, purchases: 2, revenue: 150.5 }])
  })
  it('reads Klaviyo order counts', () => {
    const body = { data: { attributes: { dates: ['2026-10-01T00:00:00+00:00', '2026-10-02T00:00:00+00:00'], data: [{ measurements: { count: [3, 0], sum_value: [90, 0] } }] } } }
    expect(parseMetricAggregate(body)).toEqual([{ date: '2026-10-01', orders: 3, value: 90 }])
  })
  it('reads Klaviyo flow totals', () => {
    expect(parseFlowValues({ data: { attributes: { results: [{ groupings: { flow_id: 'F' }, statistics: { recipients: 5, conversion_value: 9 } }, { groupings: { flow_id: 'F' }, statistics: { recipients: 2, conversion_value: 1 } }] } } })).toEqual([{ flowId: 'F', recipients: 7, revenue: 10 }])
  })
})
