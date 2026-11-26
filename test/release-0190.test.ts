import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { writeConfig, readRawConfig } from '../src/config.js'
import { loadCharges, loadOrders, staleNote, checkSettings, type Query } from '../src/pipeline.js'
import { syncFromPipeline } from '../src/pipeline-sync.js'
import { connectedNow, reconcile } from '../src/reconcile.js'
import { runMetric } from '../src/metrics.js'
import { disconnectNative } from '../src/native.js'
import { sourceStatus } from '../src/sources-catalog.js'
import { doctor } from '../src/commands/doctor.js'
import { readConfig } from '../src/config.js'

let home: string
let db: Db
let src: PGlite
let query: Query
const open = () => ({ query, close: async () => undefined })
const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'lc-0190-'))
  process.env.LIFECYCLE_HOME = home
  process.env.LIFECYCLE_NO_KEYCHAIN = '1'
  db = wrapPglite(await PGlite.create())
  await migrate(db)
  src = await PGlite.create()
  query = async (sql, params) => (await src.query(sql, params as unknown[])).rows as Record<string, unknown>[]
  writeConfig({ database: { kind: 'local' }, workspace: { type: 'saas' } } as never)
})
afterEach(async () => {
  await db.close()
  await src.close()
  rmSync(home, { recursive: true, force: true })
  for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN']) delete process.env[k]
})

// Fivetran's Stripe charge table, in the shape of fivetran/dbt_stripe's source model, with a personal column the CLI must never read.
async function fivetranStripe() {
  await src.exec(`CREATE SCHEMA stripe; CREATE TABLE stripe.charge (id text, amount bigint, amount_refunded bigint, created timestamp, currency text, status text, customer_id text, receipt_email text, shipping_name text, _fivetran_deleted boolean, _fivetran_synced timestamptz)`)
  const rows: unknown[][] = [
    ['ch_1', 5000, 0, day(3), 'usd', 'succeeded', 'cus_a', 'a@example.com', 'Ann', false, day(0)],
    ['ch_2', 3000, 1000, day(3), 'usd', 'succeeded', 'cus_b', 'b@example.com', 'Bo', false, day(0)],
    ['ch_3', 2000, 0, day(2), 'usd', 'succeeded', 'cus_a', 'a@example.com', 'Ann', false, day(0)],
    ['ch_4', 9999, 0, day(2), 'usd', 'failed', 'cus_c', 'c@example.com', 'Cy', false, day(0)],
    ['ch_5', 7777, 0, day(2), 'usd', 'succeeded', 'cus_d', 'd@example.com', 'Di', true, day(0)],
  ]
  for (const r of rows) await src.query(`INSERT INTO stripe.charge VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, r)
}

describe('0.19.0 bring your own pipeline', () => {
  it('reads a Fivetran Stripe charge table into the same daily totals, never reading a personal column, and leaves out deleted rows', async () => {
    await fivetranStripe()
    const seen: string[] = []
    const spy: Query = async (sql, p) => { seen.push(sql); return query(sql, p) }
    const charges = await loadCharges(spy, 'fivetran', 'stripe')
    expect(charges.map((c) => c.id).sort()).toEqual(['ch_1', 'ch_2', 'ch_3', 'ch_4'])
    expect(seen.join(' ')).not.toMatch(/receipt_email|shipping_name/)
    writeConfig({ database: { kind: 'local' }, workspace: { type: 'saas', reference: 'stripe' }, pipeline: { sources: { stripe: { tool: 'fivetran', schema: 'stripe', urlEnv: 'PIPE_URL', connectedAt: day(1) } } } } as never)
    const r = await syncFromPipeline(db, 'stripe', { tool: 'fivetran', schema: 'stripe', urlEnv: 'PIPE_URL', connectedAt: day(1) }, open)
    expect(r).toMatchObject({ source: 'stripe', status: 'ok' })
    expect(r.detail).toMatch(/Read from Fivetran tables in stripe\. Subscriptions are not read/)
    const net = await runMetric(db, 'stripe_net_revenue', 30)
    expect(net.value).toBe(90) // 50 + (30 - 10) + 20 dollars; the failed and the deleted charge are out
    expect(connectedNow()).toContain('stripe')
    const rec = await reconcile(db)
    expect(rec.checks.find((c) => c.name === 'stripe_daily_complete')).toMatchObject({ status: 'pass' })
    expect(rec.passed).toBe(true)
  })

  it('reads an Airbyte Shopify orders table, with the customer as JSON, the current total and test orders left out', async () => {
    await src.exec(`CREATE SCHEMA shop; CREATE TABLE shop.orders (id bigint, created_at timestamptz, updated_at timestamptz, processed_at timestamptz, cancelled_at timestamptz, total_price numeric, current_total_price numeric, total_discounts numeric, customer jsonb, email text, test boolean, _airbyte_extracted_at timestamptz)`)
    const rows: unknown[][] = [
      [1, day(5), day(5), day(5), null, 100, 80, 0, { id: 11, email: 'x@example.com' }, 'x@example.com', false, day(4)],
      [2, day(4), day(4), day(4), null, 50, 50, 5, { id: 11 }, 'x@example.com', false, day(4)],
      [3, day(4), day(4), day(4), day(3), 70, 0, 0, null, null, false, day(4)],
      [4, day(4), day(4), day(4), null, 999, 999, 0, { id: 12 }, 't@example.com', true, day(4)],
    ]
    for (const r of rows) await src.query(`INSERT INTO shop.orders VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, r)
    const { orders, refundsSubtracted } = await loadOrders(query, 'airbyte', 'shop')
    expect(refundsSubtracted).toBe(true)
    expect(orders.map((o) => o.id).sort()).toEqual(['1', '2', '3'])
    expect(orders.find((o) => o.id === '1')).toMatchObject({ customer: { id: '11' }, currentTotalPriceSet: { shopMoney: { amount: '80' } } })
    const r = await syncFromPipeline(db, 'shopify', { tool: 'airbyte', schema: 'shop', urlEnv: 'PIPE_URL', connectedAt: day(1) }, open)
    expect(r.status).toBe('warning') // the loader last wrote 4 days ago
    expect(r.detail).toMatch(/Read from Airbyte tables in shop\..*orders_complete check is skipped.*last wrote to this table 4 days ago/)
    expect((await runMetric(db, 'shopify_orders', 30)).value).toBe(2)
    expect((await runMetric(db, 'shopify_net_revenue', 30)).value).toBe(130)
    expect((await runMetric(db, 'returning_order_share', 30)).value).toBe(50)
  })

  it('says when a Fivetran order table has no current total, so refunds are not subtracted', async () => {
    await src.exec(`CREATE SCHEMA shopify; CREATE TABLE shopify."order" (id bigint, processed_at timestamp, cancelled_at timestamp, total_price numeric, total_discounts numeric, customer_id bigint, test boolean, _fivetran_deleted boolean, _fivetran_synced timestamptz)`)
    await src.query(`INSERT INTO shopify."order" VALUES (1, $1, NULL, 40, 0, 7, false, false, $2)`, [day(2), day(0)])
    const { orders, refundsSubtracted } = await loadOrders(query, 'fivetran', 'shopify')
    expect(refundsSubtracted).toBe(false)
    expect(orders).toHaveLength(1)
    const r = await syncFromPipeline(db, 'shopify', { tool: 'fivetran', schema: 'shopify', urlEnv: 'PIPE_URL', connectedAt: day(1) }, open)
    expect(r.detail).toMatch(/refunds are not subtracted/)
  })

  it('refuses a table that is missing or not in the loader shape, and bad settings', async () => {
    await expect(loadCharges(query, 'fivetran', 'nowhere')).rejects.toMatchObject({ code: 'pipeline_table_missing' })
    await src.exec(`CREATE SCHEMA stripe; CREATE TABLE stripe.charge (id text, amount bigint)`)
    await expect(loadCharges(query, 'fivetran', 'stripe')).rejects.toMatchObject({ code: 'pipeline_columns' })
    expect(() => checkSettings('stitch', 'stripe', 'stripe', 'PIPE_URL')).toThrow(/fivetran or airbyte/)
    expect(() => checkSettings('fivetran', 'hubspot', 'stripe', 'PIPE_URL')).toThrow(/stripe or shopify/)
    expect(() => checkSettings('fivetran', 'stripe', 'Stripe; drop', 'PIPE_URL')).toThrow(/Not a schema name/)
    expect(() => checkSettings('fivetran', 'stripe', 'stripe', 'postgres://x')).toThrow(/Not an environment variable/)
    expect(staleNote(null)).toBeNull()
    expect(staleNote(day(1))).toBeNull()
  })

  it('counts a pipeline source as connected in sources list and doctor, with no key of ours', async () => {
    writeConfig({ database: { kind: 'local' }, workspace: { type: 'saas', reference: 'stripe' }, pipeline: { sources: { stripe: { tool: 'airbyte', schema: 'raw_stripe', urlEnv: 'PIPE_URL', connectedAt: day(1) } } } } as never)
    const list = await sourceStatus(readConfig(), () => false, db)
    expect(list.find((x) => x.slug === 'stripe')).toMatchObject({ connected: true, name: 'Stripe (through Airbyte tables in raw_stripe)' })
    const d = await doctor()
    expect(d.checks.find((c) => c.name === 'reference')).toMatchObject({ ok: true })
  })

  it('disconnect forgets a pipeline source', async () => {
    writeConfig({ database: { kind: 'local' }, pipeline: { sources: { stripe: { tool: 'fivetran', schema: 'stripe', urlEnv: 'PIPE_URL', connectedAt: day(1) } } } } as never)
    const r = await disconnectNative('stripe', { remove: () => false })
    expect(r.configRemoved).toBe(true)
    expect(readRawConfig().pipeline.sources).toEqual({})
  })
})
