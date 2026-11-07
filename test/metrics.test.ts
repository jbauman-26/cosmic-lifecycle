import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { findMetric, formatValue, listMetrics, METRICS, runMetric, sinceDate } from '../src/metrics.js'
import { CATALOG, kitPrompt, LLMS_URL, sourceStatus } from '../src/sources-catalog.js'
import { DOCS } from '../src/docs.js'

let db: Db

const orders = (daysAgo: number, n: number, net: number, returning: number) =>
  db.query(
    `INSERT INTO fact_orders_daily (date, orders, gross_revenue, net_revenue, discounts, new_orders, returning_orders, source_synced_at) VALUES (CURRENT_DATE - $1::int, $2::int, $3::numeric, $3::numeric, 0, $2::int - $4::int, $4::int, now())`,
    [daysAgo, n, net, returning],
  )
const flow = (daysAgo: number, recipients: number, revenue: number, unsubs = 0, spam = 0) =>
  db.query(
    `INSERT INTO fact_flow_daily (flow_id, flow_message_id, channel, date, recipients, revenue, unsubscribes, spam_complaints, source_synced_at) VALUES ('F', 'M' || $1, 'email', CURRENT_DATE - $1::int, $2, $3, $4, $5, now())`,
    [daysAgo, recipients, revenue, unsubs, spam],
  )

beforeEach(async () => {
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(async () => {
  await db.close()
})

describe('verified metrics', () => {
  it('has unique names and a description for each', () => {
    const names = METRICS.map((m) => m.name)
    expect(new Set(names).size).toBe(names.length)
    for (const m of listMetrics()) expect(m.description.length).toBeGreaterThan(10)
  })

  it('computes values from the window only', async () => {
    await orders(5, 10, 1000, 4)
    await orders(200, 99, 99999, 0) // outside a 90-day window
    await flow(5, 400, 150, 4, 1)
    expect((await runMetric(db, 'shopify_orders', 90)).value).toBe(10)
    expect((await runMetric(db, 'shopify_net_revenue', 90)).value).toBe(1000)
    expect((await runMetric(db, 'average_order_value', 90)).value).toBe(100)
    expect((await runMetric(db, 'returning_order_share', 90)).value).toBe(40)
    expect((await runMetric(db, 'flow_revenue_share', 90)).value).toBe(15)
    expect((await runMetric(db, 'flow_revenue_per_recipient', 90)).value).toBe(0.375)
    expect((await runMetric(db, 'flow_unsubscribe_rate', 90)).value).toBe(1)
    expect((await runMetric(db, 'flow_spam_rate', 90)).value).toBe(0.25)
    expect((await runMetric(db, 'shopify_orders', 365)).value).toBe(109)
  })

  it('returns its inputs and the exact SQL, identical on every run', async () => {
    await orders(5, 10, 1000, 4)
    const a = await runMetric(db, 'average_order_value', 30)
    const b = await runMetric(db, 'average_order_value', 30)
    expect(a.sql).toBe(b.sql)
    expect(a.sql).toBe(findMetric('average_order_value').sql)
    expect([a.numerator, a.denominator]).toEqual([1000, 10])
  })

  it('says which source is missing instead of returning zero', async () => {
    await orders(5, 10, 1000, 4)
    const r = await runMetric(db, 'flow_revenue_share', 90)
    expect(r).toMatchObject({ value: null, status: 'no_data', missing: ['klaviyo'] })
    expect(r.detail).toMatch(/No klaviyo data synced/)
  })

  it('carries the trust line and the attribution note', async () => {
    await flow(5, 100, 10)
    await db.query(`INSERT INTO meta_reconcile_result (check_name, status, detail, checked_at) VALUES ('klaviyo_orders', 'fail', 'x', now())`)
    const r = await runMetric(db, 'flow_attributed_revenue', 90)
    expect(r.trust.status).toBe('failed')
    expect(r.notes.join(' ')).toMatch(/not proof/)
  })

  it('runs every metric without a SQL error when all sources have data', async () => {
    await orders(5, 10, 1000, 4)
    await flow(5, 100, 10)
    await db.query(`INSERT INTO fact_klaviyo_orders_daily (date, placed_orders, placed_value, source_synced_at) VALUES (CURRENT_DATE - 5, 9, 900, now())`)
    await db.query(`INSERT INTO fact_ga4_daily (date, channel, sessions, purchases, revenue, source_synced_at) VALUES (CURRENT_DATE - 5, 'Organic', 1000, 20, 2000, now())`)
    for (const m of METRICS) expect((await runMetric(db, m.name, 90)).status, m.name).toBe('ok')
    expect((await runMetric(db, 'ga4_purchase_rate', 90)).value).toBe(2)
  })

  it('rejects unknown metrics and bad windows', async () => {
    await expect(runMetric(db, 'nope')).rejects.toThrow(/No metric named nope/)
    await expect(runMetric(db, 'shopify_orders', 0)).rejects.toThrow(/whole number/)
    await expect(runMetric(db, 'shopify_orders', 1.5)).rejects.toThrow(/whole number/)
  })

  it('formats values by unit', () => {
    expect(formatValue('usd', 1234.5)).toBe('$1,234.50')
    expect(formatValue('percent', 15)).toBe('15.00%')
    expect(formatValue('count', 1200)).toBe('1,200')
    expect(formatValue('usd', null)).toBe('no value')
    expect(sinceDate(1, Date.UTC(2026, 0, 2))).toBe('2026-01-01')
  })
})

describe('source catalog and setup prompts', () => {
  it('lists only sources with a working connector', () => {
    expect(CATALOG.map((s) => s.slug)).toEqual(['klaviyo', 'shopify', 'ga4'])
  })

  it('reports connected sources and the next step for the rest', async () => {
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('r1', 'klaviyo', now(), now(), 'ok')`)
    const r = await sourceStatus({ database: { kind: 'local' }, klaviyo: { connected: true } }, (s) => s === 'klaviyo', db)
    expect(r[0]).toMatchObject({ slug: 'klaviyo', connected: true, lastStatus: 'ok', next: null })
    expect(r[1]).toMatchObject({ slug: 'shopify', connected: false })
    expect(r[1]!.next).toMatch(/connect shopify/)
    expect((await sourceStatus(null, () => false, null))[0]!.next).toBe('lifecycle init')
  })

  it('builds a paste-ready prompt that never asks for a key in chat', () => {
    const p = kitPrompt({ name: 'flow-audit', title: 'Flow audit', needs: ['klaviyo'] })
    expect(p).toContain('lifecycle kits add flow-audit')
    expect(p).toContain(LLMS_URL)
    expect(p).toMatch(/Never ask me to paste a key/)
  })

  it('keeps the quickstart free of dashes and in step with llms.txt', () => {
    expect(DOCS.quickstart).not.toMatch(/[–—]/)
    expect(DOCS.quickstart).toContain('northsignal.studio/contact')
    if (existsSync('llms.txt')) expect(readFileSync('llms.txt', 'utf8')).toBe(DOCS.quickstart)
  })
})
