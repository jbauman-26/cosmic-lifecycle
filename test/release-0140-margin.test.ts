import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, openDb, type Db } from '../src/db.js'
import { writeShopify } from '../src/sync.js'
import { setCost, writeCosts, costsConfigured } from '../src/costs.js'
import { aggregateCosts, type CostOrder } from '../src/sources/shopify-costs.js'
import { listAllMetrics, METRICS, runMetric } from '../src/metrics.js'
import { costCheck, reconcile, tolerances } from '../src/reconcile.js'
import { fetchRate, parseRates } from '../src/fx.js'
import { rollupHow, rollupMetric } from '../src/rollup.js'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lc-0140m-'))
  process.env.LIFECYCLE_HOME = home
  process.env.LIFECYCLE_NO_KEYCHAIN = '1'
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'LIFECYCLE_WORKSPACE', 'LIFECYCLE_FX_API_URL']) delete process.env[k]
})

const fresh = async () => {
  const db = wrapPglite(await PGlite.create())
  await migrate(db)
  return db
}
const DAY = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)
const order = (total: string) => ({ processedAt: `${DAY}T12:00:00Z`, cancelledAt: null, customer: { id: 'c' }, currentTotalPriceSet: { shopMoney: { amount: total } }, totalDiscountsSet: { shopMoney: { amount: '0.00' } } })
const line = (qty: number, price: string, cost: string | null) => ({ currentQuantity: qty, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: price } }, variant: cost === null ? null : { inventoryItem: { unitCost: cost === '' ? null : { amount: cost } } } })
const costOrder = (tax: string, lines: ReturnType<typeof line>[], cancelled = false): CostOrder => ({ processedAt: `${DAY}T12:00:00Z`, cancelledAt: cancelled ? `${DAY}T13:00:00Z` : null, currentTotalTaxSet: { shopMoney: { amount: tax } }, lineItems: { nodes: lines } })

// A store with known costs, worked by hand:
//   Two orders, $108.00 and $54.00, net revenue $162.00, tax $8.00 and $4.00, so revenue $150.00.
//   Order 1: 2 mugs at $50 cost $12.50 each = $25.00. Order 2: 1 bowl at $50, no unit cost: 30% of $50 = $15.00.
//   A cancelled order is left out. COGS = $40.00. CM1 = 150 - 40 = $110.00.
//   Shipping $6.10 + fulfillment $2.25 + fixed fee $0.30 per order, x2 = $17.30. Fee 2.9% of $162 = $4.698.
//   CM2 = 110 - 17.30 - 4.698 = $88.002. Meta spend $33.33. CM3 = $54.672. CM3% = 54.672 / 150 = 36.448%.
async function seed(db: Db) {
  await writeShopify(db, [order('108.00'), order('54.00')])
  await writeCosts(db, [costOrder('8.00', [line(2, '50.00', '12.50')]), costOrder('4.00', [line(1, '50.00', '')]), costOrder('9.00', [line(5, '20.00', '3.00')], true)], 'USD')
  for (const [k, v] of [['cogs_percent', '30'], ['shipping_per_order', '6.10'], ['fulfillment_per_order', '2.25'], ['payment_fee_percent', '2.9'], ['payment_fee_fixed', '0.30']]) await setCost(db, k!, v!)
  await db.query(`INSERT INTO fact_meta_ads_daily VALUES ($1, 'C1', 'c', 33.33, 1000, 10, 1, 50, 'USD', 'a', now())`, [DAY])
}

describe('contribution margin', () => {
  it('matches a hand calculation to the cent', async () => {
    const db = await fresh()
    try {
      await seed(db)
      const v = async (n: string) => (await runMetric(db, n, 30)).value
      expect(await v('cogs')).toBe(40)
      expect(await v('gross_margin')).toBe(110)
      expect(await v('contribution_margin_before_ads')).toBe(88.002)
      expect(await v('contribution_margin')).toBe(54.672)
      expect(await v('contribution_margin_percent')).toBeCloseTo(36.448, 4)
      expect(await v('cost_coverage')).toBe(50)
      const r = await runMetric(db, 'contribution_margin', 30)
      expect(r.trust).toBeDefined()
      expect(r.notes.join(' ')).toMatch(/1 of 2 line items have no unit cost/)
    } finally {
      await db.close()
    }
  })

  it('counts unset inputs as zero and says which, and uses cogs_percent of net revenue with no cost sync', async () => {
    const db = await fresh()
    try {
      await writeShopify(db, [order('100.00')])
      const r = await runMetric(db, 'contribution_margin', 30)
      expect(r.value).toBe(100)
      expect(r.notes.join(' ')).toMatch(/Not set, so counted as zero: cogs_percent, shipping_per_order/)
      expect(r.notes.join(' ')).toMatch(/No Shopify unit costs synced/)
      expect(r.notes.join(' ')).toMatch(/No ad spend synced/)
      await setCost(db, 'cogs_percent', '40')
      expect((await runMetric(db, 'cogs', 30)).value).toBe(40)
      await expect(setCost(db, 'cogs_percent', '140')).rejects.toMatchObject({ code: 'bad_value' })
      await expect(setCost(db, 'nope', '1')).rejects.toMatchObject({ code: 'unknown_setting' })
    } finally {
      await db.close()
    }
  })

  it('joins a store\'s metric list only once costs exist, after the 0.13 list', async () => {
    const db = await fresh()
    try {
      expect(await costsConfigured(db)).toBe(false)
      expect((await listAllMetrics(db)).map((m) => m.name)).toEqual(METRICS.map((m) => m.name))
      await setCost(db, 'cogs_percent', '30')
      const names = (await listAllMetrics(db)).map((m) => m.name)
      expect(names.slice(0, METRICS.length)).toEqual(METRICS.map((m) => m.name))
      expect(names).toContain('contribution_margin')
    } finally {
      await db.close()
    }
  })

  it('reads costs by order day, skipping cancelled orders, and flags orders cut at 100 lines', () => {
    const big = costOrder('0', [line(1, '10', '2')])
    big.lineItems.pageInfo = { hasNextPage: true }
    const r = aggregateCosts([costOrder('1.50', [line(2, '10', '4'), line(0, '10', '4'), line(1, '7', null)]), costOrder('9', [line(9, '9', '9')], true), big])
    expect(r.daily).toEqual([{ date: DAY, cogsKnown: 10, uncostedRevenue: 7, tax: 1.5, lines: 3, linesWithCost: 2 }])
    expect(r.truncatedOrders).toBe(1)
  })

  it('warns when few lines carry a cost and no percent covers them, and a store without costs gets no new check', async () => {
    const db = await fresh()
    try {
      expect(await costCheck(db)).toBeNull()
      const before = (await reconcile(db, tolerances(), { type: 'shopify', reference: 'shopify', referenceSet: false, title: 'Shopify store' })).checks.map((c) => c.name)
      expect(before).not.toContain('cost_coverage')
      await writeCosts(db, [costOrder('0', [line(1, '10', null), line(1, '10', '2')])], 'USD')
      expect(await costCheck(db)).toMatchObject({ status: 'warn', diffPct: 50 })
      await setCost(db, 'cogs_percent', '30')
      expect((await costCheck(db))?.status).toBe('pass')
    } finally {
      await db.close()
    }
  })
})

// A stand-in for the rate source: EUR to USD is 1.10 on the 20th and 1.20 on the 21st.
// The ECB route does not know XYZ, so it falls back to the blended route.
const fakeFx = async () => {
  const seen: string[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    seen.push(url.pathname + url.search)
    const ecb = url.pathname.match(/^\/v2\/providers\/ecb\/rate\/([a-z]{3})\/([a-z]{3})$/)
    const blend = url.pathname.match(/^\/v2\/rate\/([a-z]{3})\/([a-z]{3})$/)
    const m = ecb ?? blend
    if (!m || (ecb && m[1] === 'xyz')) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"status":404,"message":"not found"}')
    const date = url.searchParams.get('date') ?? '2026-11-21'
    const rate = m[1] === 'xyz' ? 0.5 : date === '2026-11-20' ? 1.1 : 1.2
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ date, base: m[1]!.toUpperCase(), quote: m[2]!.toUpperCase(), rate }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.LIFECYCLE_FX_API_URL = url
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) }
}

describe('exchange rates', () => {
  it('asks for the ECB rate first, falls back to the blended one, and keeps the date', async () => {
    const fx = await fakeFx()
    try {
      expect(await fetchRate('EUR', 'USD', '2026-11-20')).toEqual({ from: 'EUR', to: 'USD', rate: 1.1, date: '2026-11-20', source: 'Frankfurter (frankfurter.dev), European Central Bank reference rate' })
      expect(await fetchRate('XYZ', 'USD', null)).toMatchObject({ rate: 0.5, source: 'Frankfurter (frankfurter.dev), blended rate' })
      expect(await fetchRate('USD', 'USD', null)).toMatchObject({ rate: 1, source: 'same currency' })
      expect(fx.seen).toContain('/v2/providers/ecb/rate/eur/usd?date=2026-11-20')
    } finally {
      await fx.close()
    }
  })
  it('takes a rate by hand and refuses one that is not a number', () => {
    expect(parseRates(['eur=1.0955'], 'USD', '2026-11-20').get('EUR')).toEqual({ from: 'EUR', to: 'USD', rate: 1.0955, date: '2026-11-20', source: 'set by the owner' })
    expect(() => parseRates(['EUR=abc'], 'USD', 'x')).toThrow(/not a rate/)
    expect(() => parseRates(['EUR=0'], 'USD', 'x')).toThrow(/not a rate/)
  })
})

// Two stores on one machine: the unnamed workspace sells in USD, a named one in EUR.
async function twoStores() {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ database: { kind: 'local' } }))
  mkdirSync(join(home, 'workspaces', 'eu-store'), { recursive: true })
  writeFileSync(join(home, 'workspaces', 'eu-store', 'config.json'), JSON.stringify({ database: { kind: 'local' }, workspace: { currency: 'EUR' } }))
  let db = await openDb()
  await migrate(db)
  await seed(db)
  await db.close()
  process.env.LIFECYCLE_WORKSPACE = 'eu-store'
  db = await openDb()
  await migrate(db)
  await writeShopify(db, [order('200.00')])
  await setCost(db, 'cogs_percent', '50')
  await db.close()
  delete process.env.LIFECYCLE_WORKSPACE
}

describe('one total across stores', () => {
  it('adds a USD and an EUR store in USD, names the rate and date, and moves with the rate date', async () => {
    await twoStores()
    const fx = await fakeFx()
    try {
      const a = await rollupMetric('shopify_net_revenue', { stores: 'all', currency: 'USD', days: 30, rateDate: '2026-11-20' })
      expect(a.stores.map((s) => [s.store, s.currency, s.value, s.converted])).toEqual([['default', 'USD', 162, 162], ['eu-store', 'EUR', 200, 220]])
      expect(a.total).toBe(382)
      expect(a.rates).toEqual([{ from: 'EUR', to: 'USD', rate: 1.1, date: '2026-11-20', source: expect.stringMatching(/European Central Bank/) }])
      expect(a.trust.line).toMatch(/In USD at EUR 1.1 on 2026-11-20/)
      const b = await rollupMetric('shopify_net_revenue', { stores: 'all', currency: 'USD', days: 30, rateDate: '2026-11-21' })
      expect(b.total).toBe(402)
      const m = await rollupMetric('contribution_margin', { stores: 'all', currency: 'USD', days: 30, rateDate: '2026-11-20' })
      expect(m.total).toBeCloseTo(54.672 + 100 * 1.1, 2)
      const pct = await rollupMetric('contribution_margin_percent', { stores: 'all', currency: 'USD', days: 30, rateDate: '2026-11-20' })
      expect(pct.total).toBeCloseTo(((54.672 + 110) / (150 + 220)) * 100, 3)
      const orders = await rollupMetric('shopify_orders', { stores: 'all', currency: 'USD', days: 30 })
      expect(orders.total).toBe(3)
      expect(orders.rates).toEqual([])
      const hand = await rollupMetric('shopify_net_revenue', { stores: 'all', currency: 'USD', days: 30, rates: ['EUR=1.5'] })
      expect(hand.total).toBe(462)
    } finally {
      await fx.close()
    }
  }, 60_000)

  it('refuses a metric that cannot be added up, and a total with no currency', async () => {
    expect(rollupHow('meta_reported_roas')).toBeNull()
    expect(rollupHow('stripe_net_new_mrr')).toBeNull()
    expect(rollupHow('shopify_net_revenue')).toBe('money')
    await expect(rollupMetric('meta_reported_roas', { stores: 'all', currency: 'USD' })).rejects.toMatchObject({ code: 'not_summable' })
    await expect(rollupMetric('shopify_orders', { stores: 'all' })).rejects.toMatchObject({ code: 'no_currency' })
  })

  it('leaves out a store whose currency is unknown, and says so', async () => {
    await twoStores()
    writeFileSync(join(home, 'workspaces', 'eu-store', 'config.json'), JSON.stringify({ database: { kind: 'local' } }))
    const fx = await fakeFx()
    try {
      const r = await rollupMetric('shopify_net_revenue', { stores: 'all', currency: 'USD', days: 30 })
      expect(r.stores.find((s) => s.store === 'eu-store')?.status).toBe('no_currency')
      expect(r.total).toBe(162)
      expect(r.notes[0]).toBe('Left out of the total: eu-store.')
    } finally {
      await fx.close()
    }
  }, 60_000)

  it('works from the command line', async () => {
    await twoStores()
    const fx = await fakeFx()
    try {
      const out = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
        const child = spawn(process.execPath, [resolve('node_modules', 'tsx', 'dist', 'cli.mjs'), resolve('src', 'cli.ts'), '--format', 'json', 'metrics', 'run', 'contribution_margin', '--all-stores', '--currency', 'usd', '--rate-date', '2026-11-20', '--days', '30'], {
          env: { ...process.env, LIFECYCLE_HOME: home, HOME: home, LIFECYCLE_NO_KEYCHAIN: '1', LIFECYCLE_NO_UPDATE_CHECK: '1', LIFECYCLE_FX_API_URL: fx.url },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => (stdout += d))
        child.stderr.on('data', (d) => (stderr += d))
        child.on('close', (status) => done({ status, stdout, stderr }))
      })
      expect(out.status, out.stderr).toBe(0)
      const j = JSON.parse(out.stdout)
      expect(j).toMatchObject({ rollup: true, metric: 'contribution_margin', currency: 'USD', rates: [{ from: 'EUR', rate: 1.1, date: '2026-11-20' }] })
      expect(j.total).toBeCloseTo(164.67, 2)
    } finally {
      await fx.close()
    }
  }, 60_000)
})
