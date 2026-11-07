import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { syncKlaviyo, syncShopify, writeFlowDaily, writeShopify } from '../src/sync.js'
import { assertReadOnlySql, runQuery, ROW_CAP } from '../src/query.js'
import { PUBLIC_TABLES } from '../src/schema.js'
import { Klaviyo } from '../src/sources/klaviyo.js'
import { HttpError } from '../src/http.js'

const order = (processedAt: string, customer: string, amount: string) => ({
  processedAt, cancelledAt: null, customer: { id: customer },
  currentTotalPriceSet: { shopMoney: { amount } }, totalDiscountsSet: { shopMoney: { amount: '0.00' } },
})
const orders = [order('2026-01-01T10:00:00Z', 'a', '100.00'), order('2026-02-01T10:00:00Z', 'a', '50.00')]

let db: Db
beforeEach(async () => {
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(async () => {
  await db.close()
  vi.restoreAllMocks()
})

describe('privacy', () => {
  it('has no column that could hold a person', async () => {
    const rows = await db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name = ANY($1)`, [PUBLIC_TABLES])
    const risky = rows.filter((r) => /email|phone|first_name|last_name|full_name|address|customer_id|profile/.test(String(r.column_name)))
    expect(risky).toEqual([])
  })
})

describe('sync', () => {
  it('leaves identical totals when run twice', async () => {
    await writeShopify(db, orders)
    const first = await db.query('SELECT date, orders, net_revenue FROM fact_orders_daily ORDER BY date')
    await writeShopify(db, orders)
    expect(await db.query('SELECT date, orders, net_revenue FROM fact_orders_daily ORDER BY date')).toEqual(first)
    expect(await db.query('SELECT sum(revenue)::text AS r FROM fact_cohort_monthly')).toEqual([{ r: '150' }])
  })

  it('updates a flow day in place', async () => {
    const row = { flowId: 'F', flowMessageId: 'M', channel: 'email', date: '2026-10-01', recipients: 10, opensUnique: 1, clicksUnique: 1, conversions: 0, revenue: 0, unsubscribes: 0, spamComplaints: 0, bounces: 0 }
    await writeFlowDaily(db, [row], new Date().toISOString())
    await writeFlowDaily(db, [{ ...row, recipients: 25 }], new Date().toISOString())
    expect(await db.query('SELECT recipients::int FROM fact_flow_daily')).toEqual([{ recipients: 25 }])
  })

  it('keeps old numbers when a source fails, and records why', async () => {
    await syncShopify(db, async () => orders)
    const r = await syncShopify(db, async () => { throw new Error('Shopify is down') })
    expect(r).toMatchObject({ status: 'failed', detail: 'Shopify is down' })
    expect(await db.query('SELECT count(*)::int AS n FROM fact_orders_daily')).toEqual([{ n: 2 }])
  })

  it('warns rather than fails when an account has no flows', async () => {
    const k = new Klaviyo('k')
    vi.spyOn(k, 'flows').mockResolvedValue([])
    vi.spyOn(k, 'campaigns').mockResolvedValue([])
    vi.spyOn(k, 'segments').mockResolvedValue([])
    vi.spyOn(k, 'placedOrderMetricId').mockResolvedValue('M')
    vi.spyOn(k, 'placedOrdersDaily').mockResolvedValue([])
    expect(await syncKlaviyo(db, k)).toMatchObject({ status: 'warning', detail: expect.stringContaining('no flows') })
  })

  it('saves flow report rows and reports ok', async () => {
    const k = new Klaviyo('k')
    vi.spyOn(k, 'flows').mockResolvedValue([{ flowId: 'F', name: 'Welcome', status: 'live', triggerType: null, archived: false, createdAt: null, updatedAt: null }])
    vi.spyOn(k, 'campaigns').mockResolvedValue([])
    vi.spyOn(k, 'segments').mockResolvedValue([])
    vi.spyOn(k, 'placedOrderMetricId').mockResolvedValue('M')
    vi.spyOn(k, 'placedOrdersDaily').mockResolvedValue([])
    vi.spyOn(k, 'flowSeries').mockResolvedValue([])
    vi.spyOn(k, 'flowTotals').mockResolvedValue([])
    expect((await syncKlaviyo(db, k)).status).toBe('ok')
  })

  it('treats the empty-account report error as a warning', async () => {
    const k = new Klaviyo('k')
    vi.spyOn(k, 'flows').mockResolvedValue([{ flowId: 'F', name: 'W', status: 'live', triggerType: null, archived: false, createdAt: null, updatedAt: null }])
    vi.spyOn(k, 'campaigns').mockResolvedValue([])
    vi.spyOn(k, 'segments').mockResolvedValue([])
    vi.spyOn(k, 'placedOrderMetricId').mockResolvedValue('M')
    vi.spyOn(k, 'placedOrdersDaily').mockResolvedValue([])
    vi.spyOn(k, 'flowSeries').mockRejectedValue(new HttpError('r', 400, 'does not support querying for values data'))
    expect((await syncKlaviyo(db, k)).status).toBe('warning')
  })
})

describe('read-only query', () => {
  it.each(['DELETE FROM fact_orders_daily', 'DROP TABLE dim_flow', 'UPDATE dim_flow SET name = 1', 'INSERT INTO dim_flow VALUES (1)'])('refuses %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow(/Only SELECT/)
  })
  it('refuses a second statement', () => {
    expect(() => assertReadOnlySql('SELECT 1; DROP TABLE dim_flow')).toThrow(/one statement/)
  })
  it('refuses system tables', () => {
    expect(() => assertReadOnlySql('SELECT * FROM information_schema.tables')).toThrow(/blocked/)
  })
  it('blocks a write hidden inside a WITH even if the text check is passed', async () => {
    await writeShopify(db, orders)
    await expect(runQuery(db, `WITH x AS (DELETE FROM fact_orders_daily RETURNING 1) SELECT * FROM x`)).rejects.toThrow()
    expect(await db.query('SELECT count(*)::int AS n FROM fact_orders_daily')).toEqual([{ n: 2 }])
  })
  it('caps rows and says so', async () => {
    const r = await runQuery(db, 'SELECT generate_series(1, 5000) AS n')
    expect(r.rowCount).toBe(ROW_CAP)
    expect(r.truncated).toBe(true)
  })
  it('gives a useful error for a bad column', async () => {
    await expect(runQuery(db, 'SELECT nope FROM dim_flow')).rejects.toThrow(/Query failed/)
  })
})
