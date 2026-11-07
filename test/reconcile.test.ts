import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { reconcile, trustLine, compare } from '../src/reconcile.js'
import { syncShopify } from "../src/sync.js"
import { parseGa4Report } from '../src/sources/ga4.js'
import { parseFlowValues, parseMetricAggregate } from '../src/sources/klaviyo.js'

const day = new Date(Date.now() - 3 * 86400000).toISOString()
const order = (customer: string | null) => ({
  processedAt: day, cancelledAt: null, customer: customer ? { id: customer } : null,
  currentTotalPriceSet: { shopMoney: { amount: '100.00' } }, totalDiscountsSet: { shopMoney: { amount: '0.00' } },
})
const orders = [order('a'), order('b'), order(null)]
const byName = async (db: Db) => Object.fromEntries((await reconcile(db)).checks.map((c) => [c.name, c]))

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

  it('catches a number changed after sync', async () => {
    await syncShopify(db, async () => orders, async () => 3)
    await db.query(`UPDATE fact_orders_daily SET new_orders = new_orders + 7`)
    expect((await byName(db)).orders_vs_cohorts?.status).toBe('fail')
  })

  it('flags Klaviyo seeing no orders at all', async () => {
    await syncShopify(db, async () => orders, async () => 3)
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('k', 'klaviyo', now(), now(), 'ok')`)
    const c = await byName(db)
    expect(c.klaviyo_orders?.status).toBe('fail')
    expect(c.klaviyo_orders?.detail).toContain('may not be connected')
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
