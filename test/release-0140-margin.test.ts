import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, openDb, type Db } from '../src/db.js'
import { writeShopify } from '../src/sync.js'
import { checkCosts, costsConfigured, readCosts, setCost, setProductCosts, writeCosts } from '../src/costs.js'
import { aggregateCosts, type CostOrder } from '../src/sources/shopify-costs.js'
import { listAllMetrics, METRICS, runMetric } from '../src/metrics.js'
import { costCheck, reconcile, tolerances } from '../src/reconcile.js'
import { fetchRates, parseRates, rateLine } from '../src/fx.js'
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
const line = (sku: string, qty: number, price: string, cost: string | null) => ({ sku, currentQuantity: qty, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: price } }, variant: cost === null ? null : { inventoryItem: { unitCost: cost === '' ? null : { amount: cost } } } })
const costOrder = (tax: string, lines: ReturnType<typeof line>[], cancelled = false): CostOrder => ({ processedAt: `${DAY}T12:00:00Z`, cancelledAt: cancelled ? `${DAY}T13:00:00Z` : null, currentTotalTaxSet: { shopMoney: { amount: tax } }, lineItems: { nodes: lines } })

// A store with known costs, worked by hand, in the app's definition (margin-contract.md, section 2):
//   Two orders, $108.00 and $54.00: revenue is net revenue, $162.00. A third order is cancelled and left out.
//   Shopify costs: 2 mugs at $12.50 = $25.00. The bowl has no cost in Shopify, so 1 order without cost.
//   CM1 = 162 - 25 = $137.00. Shipping $6.50 x 2 = $13.00. Fees 2.9% x 162 + 0.30 x 2 = 4.698 + 0.60 = $5.30.
//   CM2 = 137 - 13 - 5.30 = $118.70. Meta spend $33.33. CM3 = $85.37. CM3 percent = 85.37 / 162 = 52.6975%.
async function seed(db: Db) {
  await writeShopify(db, [order('108.00'), order('54.00')])
  await writeCosts(db, [costOrder('8.00', [line('MUG', 2, '50.00', '12.50')]), costOrder('4.00', [line('BOWL', 1, '50.00', '')]), costOrder('9.00', [line('MUG', 5, '20.00', '3.00')], true)], 'USD')
  for (const [k, v] of [['currency', 'USD'], ['cogs', 'shopify'], ['shipping', 'per_order:6.50'], ['payment_fee_percent', '2.9'], ['payment_fee_per_order', '0.30'], ['ad_spend', 'meta']]) setCost(k!, v!)
  await db.query(`INSERT INTO fact_meta_ads_daily VALUES ($1, 'C1', 'c', 33.33, 1000, 10, 1, 50, 'USD', 'a', now())`, [DAY])
}

describe('contribution margin, in the shape the app reads', () => {
  it('matches a hand calculation to the cent', async () => {
    const db = await fresh()
    try {
      await seed(db)
      const r: any = await runMetric(db, 'contribution_margin', 30)
      expect(r).toMatchObject({ metric: 'contribution_margin', days: 30, currency: 'USD', status: 'ok', value: 85.37, orders_without_cost: 1 })
      expect(r.total).toEqual({ revenue: 162, cogs: 25, shipping: 13, payment_fees: 5.3, ad_spend: 33.33, cm1: 137, cm2: 118.7, cm3: 85.37 })
      expect(r.rows).toEqual([{ day: DAY, ...r.total }])
      expect(r.included).toEqual(['Cost of goods from Shopify product costs', 'Shipping at 6.50 USD per order', 'Payment fees at 2.9% plus 0.30 USD per order', 'Meta Ads spend'])
      expect(r.missing).toEqual([])
      expect(r.trust).toMatchObject({ status: expect.any(String), line: expect.any(String) })
      expect(r.notes.join(' ')).toMatch(/Sales tax inside revenue in this window: 12.00 USD/)
      const v = async (n: string) => (await runMetric(db, n, 30)).value
      expect(await v('cogs')).toBe(25)
      expect(await v('gross_margin')).toBe(137)
      expect(await v('contribution_margin_before_ads')).toBe(118.7)
      expect(await v('contribution_margin_percent')).toBeCloseTo(52.6975, 4)
      expect(await v('cost_coverage')).toBe(50)
    } finally {
      await db.close()
    }
  })

  it('takes cost of goods as a percent or a cost per product, and names what was counted as zero', async () => {
    const db = await fresh()
    try {
      await seed(db)
      setCost('cogs', 'percent:30')
      let r: any = await runMetric(db, 'contribution_margin', 30)
      expect(r.total).toMatchObject({ cogs: 48.6, cm1: 113.4, cm3: 61.77 })
      setProductCosts('sku,unit_cost\nMUG,10\n', '20')
      r = await runMetric(db, 'contribution_margin', 30)
      expect(r.total.cogs).toBe(30)
      expect(r.included).toContain('SKUs not on your list at 20% of their revenue')
      setCost('shipping', 'none')
      setCost('ad_spend', 'none')
      r = await runMetric(db, 'contribution_margin', 30)
      expect(r.missing).toEqual(['Shipping', 'Ad spend: no ad source chosen'])
      await db.query(`UPDATE fact_meta_ads_daily SET currency = 'EUR'`)
      setCost('ad_spend', 'meta')
      r = await runMetric(db, 'contribution_margin', 30)
      expect(r.missing).toContain('Meta Ads spend: the ad account is in EUR, not USD, and is not converted yet')
      expect(r.total.ad_spend).toBe(0)
    } finally {
      await db.close()
    }
  })

  it('answers no_costs with no costs.json, and lists margin metrics only once costs exist', async () => {
    const db = await fresh()
    try {
      await writeShopify(db, [order('100.00')])
      expect(await runMetric(db, 'contribution_margin', 30)).toMatchObject({ status: 'no_costs', value: null })
      expect(await costsConfigured(db)).toBe(false)
      expect((await listAllMetrics(db)).map((m) => m.name)).toEqual(METRICS.map((m) => m.name))
      setCost('currency', 'EUR')
      const names = (await listAllMetrics(db)).map((m) => m.name)
      expect(names.slice(0, METRICS.length)).toEqual(METRICS.map((m) => m.name))
      expect(names).toContain('contribution_margin')
    } finally {
      await db.close()
    }
  })

  it('writes costs.json whole, private, in the app\'s shape, and refuses what the app refuses', () => {
    const c = setCost('currency', 'GBP')
    expect(c).toMatchObject({ version: 1, currency: 'GBP', cogs: { mode: 'shopify' }, shipping: { mode: 'none' }, payment_fees: { percent: 0, per_order: 0 }, ad_spend: { sources: [] } })
    expect(statSync(join(home, 'costs.json')).mode & 0o777).toBe(0o600)
    // A file the app wrote reads back the same.
    const app = { version: 1, currency: 'USD', cogs: { mode: 'per_product', items: [{ sku: 'A-1', unit_cost: 4.5 }], fallback_percent: null }, shipping: { mode: 'percent', percent: 4 }, payment_fees: { percent: 2.9, per_order: 0.3 }, ad_spend: { sources: ['meta'] }, updated_at: '2026-11-25T10:00:00.000Z' }
    writeFileSync(join(home, 'costs.json'), JSON.stringify(app))
    expect(readCosts()).toEqual(app)
    expect(() => setCost('currency', 'XXX')).toThrow(/Pick the currency/)
    expect(() => setCost('cogs', 'percent:140')).toThrow(/0 to 100/)
    expect(() => setCost('nope', '1')).toThrow(/Unknown cost/)
    expect(() => checkCosts({ ...app, cogs: { mode: 'per_product', items: [{ sku: 'A', unit_cost: 1 }, { sku: 'A', unit_cost: 2 }] } })).toThrow(/unique SKU/)
    writeFileSync(join(home, 'costs.json'), JSON.stringify({ ...app, version: 2 }))
    expect(readCosts()).toBeNull()
    expect(JSON.parse(readFileSync(join(home, 'costs.json'), 'utf8')).version).toBe(2)
  })

  it('reads costs by order day and SKU, skipping cancelled orders, and flags orders cut at 100 lines', () => {
    const big = costOrder('0', [line('X', 1, '10', '2')])
    big.lineItems.pageInfo = { hasNextPage: true }
    const r = aggregateCosts([costOrder('1.50', [line('A', 2, '10', '4'), line('A', 0, '10', '4'), line('B', 1, '7', null)]), costOrder('9', [line('C', 9, '9', '9')], true), big])
    expect(r.daily).toEqual([{ date: DAY, cogsKnown: 10, uncostedRevenue: 7, tax: 1.5, lines: 3, linesWithCost: 2, ordersWithoutCost: 1 }])
    expect(r.skus.map((x) => [x.sku, x.units, x.revenue])).toEqual([['A', 2, 20], ['B', 1, 7], ['X', 1, 10]])
    expect(r.truncatedOrders).toBe(1)
  })

  it('warns when few lines carry a Shopify cost, and a store without costs gets no new check', async () => {
    const db = await fresh()
    try {
      expect(await costCheck(db)).toBeNull()
      const before = (await reconcile(db, tolerances(), { type: 'shopify', reference: 'shopify', referenceSet: false, title: 'Shopify store' })).checks.map((c) => c.name)
      expect(before).not.toContain('cost_coverage')
      await writeCosts(db, [costOrder('0', [line('A', 1, '10', null), line('B', 1, '10', '2')])], 'USD')
      expect(await costCheck(db)).toMatchObject({ status: 'warn', diffPct: 50 })
      setCost('cogs', 'percent:30')
      expect((await costCheck(db))?.status).toBe('pass')
    } finally {
      await db.close()
    }
  })
})

// A stand-in for the rate source, in Frankfurter's v1 shape: 1 USD is 0.909 EUR on the 20th and 0.8 on the 21st.
const fakeFx = async () => {
  const seen: string[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    seen.push(url.pathname + url.search)
    const m = url.pathname.match(/^\/v1\/(latest|\d{4}-\d{2}-\d{2})$/)
    const base = url.searchParams.get('base')
    if (!m || (url.searchParams.get('symbols') ?? '').includes('XOF')) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"not found"}')
    const date = m[1] === 'latest' ? '2026-11-21' : m[1] === '2026-11-22' ? '2026-11-20' : m[1]!
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ amount: 1, base, date, rates: { EUR: date === '2026-11-20' ? 0.909 : 0.8 } }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.LIFECYCLE_FX_API_URL = url
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) }
}

describe('exchange rates, the app\'s source and rule', () => {
  it('reads the v1 ECB rates for the reporting currency, and keeps the day the source published', async () => {
    const fx = await fakeFx()
    try {
      const r = await fetchRates('USD', '2026-11-22', ['EUR'])
      expect(r).toEqual({ base: 'USD', date: '2026-11-20', rates: { USD: 1, EUR: 0.909 }, source: 'European Central Bank reference rates, via Frankfurter' })
      expect(rateLine(r, false)).toBe('In USD at European Central Bank reference rates, via Frankfurter for Nov 20, 2026.')
      expect(fx.seen).toEqual(['/v1/2026-11-22?base=USD&symbols=EUR'])
      expect((await fetchRates('USD', null, ['XOF'])).rates.XOF).toBeUndefined()
    } finally {
      await fx.close()
    }
  })
  it('takes a rate by hand, written the way the source writes it', () => {
    expect(parseRates(['eur=0.9099'])).toEqual({ EUR: 0.9099 })
    expect(() => parseRates(['EUR=abc'])).toThrow(/not a rate/)
    expect(() => parseRates(['EUR=0'])).toThrow(/not a rate/)
  })
})

// Two stores on one machine: the unnamed workspace sells in USD, a named one in EUR (set in its costs.json).
async function twoStores() {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ database: { kind: 'local' } }))
  mkdirSync(join(home, 'workspaces', 'eu-store'), { recursive: true })
  writeFileSync(join(home, 'workspaces', 'eu-store', 'config.json'), JSON.stringify({ database: { kind: 'local' } }))
  let db = await openDb()
  await migrate(db)
  await seed(db)
  await db.close()
  process.env.LIFECYCLE_WORKSPACE = 'eu-store'
  db = await openDb()
  await migrate(db)
  await writeShopify(db, [order('200.00')])
  setCost('currency', 'EUR')
  setCost('cogs', 'percent:50')
  await db.close()
  delete process.env.LIFECYCLE_WORKSPACE
}

describe('one total across stores', () => {
  it('adds a USD and an EUR store in USD, names the rate and its day, and moves with the rate day', async () => {
    await twoStores()
    const fx = await fakeFx()
    try {
      const a = await rollupMetric('shopify_net_revenue', { stores: 'all', currency: 'USD', days: 30, rateDate: '2026-11-20' })
      expect(a.stores.map((s) => [s.store, s.currency, s.value, s.rate, s.converted])).toEqual([['default', 'USD', 162, 1, 162], ['eu-store', 'EUR', 200, 0.909, 220.02]])
      expect(a.total).toBe(382.02)
      expect(a.line).toBe('In USD at European Central Bank reference rates, via Frankfurter for Nov 20, 2026.')
      expect(a.rates).toEqual([{ base: 'USD', currency: 'EUR', rate: 0.909, date: '2026-11-20', source: 'European Central Bank reference rates, via Frankfurter' }])
      expect((await rollupMetric('shopify_net_revenue', { stores: 'all', currency: 'USD', days: 30, rateDate: '2026-11-21' })).total).toBe(412)
      const m = await rollupMetric('contribution_margin', { stores: 'all', currency: 'USD', days: 30, rateDate: '2026-11-20' })
      expect(m.stores.map((s) => s.converted)).toEqual([85.37, 110.01])
      expect(m.total).toBe(195.38)
      const pct = await rollupMetric('contribution_margin_percent', { stores: 'all', currency: 'USD', days: 30, rateDate: '2026-11-20' })
      expect(pct.total).toBeCloseTo(((85.37 + 100 / 0.909) / (162 + 200 / 0.909)) * 100, 3)
      const orders = await rollupMetric('shopify_orders', { stores: 'all', currency: 'USD', days: 30 })
      expect(orders.total).toBe(3)
      expect(orders.rates).toEqual([])
      const hand = await rollupMetric('shopify_net_revenue', { stores: 'all', currency: 'USD', days: 30, rates: ['EUR=0.5'] })
      expect(hand.total).toBe(562)
      expect(hand.line).toBe('In USD at rates set by the owner.')
    } finally {
      await fx.close()
    }
  }, 60_000)

  it('refuses a metric that cannot be added up, and a total with no currency', async () => {
    expect(rollupHow('meta_reported_roas')).toBeNull()
    expect(rollupHow('stripe_net_new_mrr')).toBeNull()
    expect(rollupHow('shopify_net_revenue')).toBe('money')
    expect(rollupHow('contribution_margin')).toBe('money')
    await expect(rollupMetric('meta_reported_roas', { stores: 'all', currency: 'USD' })).rejects.toMatchObject({ code: 'not_summable' })
    await expect(rollupMetric('shopify_orders', { stores: 'all' })).rejects.toMatchObject({ code: 'no_currency' })
  })

  it('leaves out a store with no currency or no rate, and says which', async () => {
    await twoStores()
    rmSync(join(home, 'workspaces', 'eu-store', 'costs.json'))
    const fx = await fakeFx()
    try {
      const r = await rollupMetric('shopify_net_revenue', { stores: 'all', currency: 'USD', days: 30 })
      expect(r.stores.find((s) => s.store === 'eu-store')?.status).toBe('no_currency')
      expect(r.total).toBe(162)
      expect(r.left_out).toEqual(['eu-store'])
      process.env.LIFECYCLE_WORKSPACE = 'eu-store'
      setCost('currency', 'TRY')
      delete process.env.LIFECYCLE_WORKSPACE
      const t = await rollupMetric('shopify_net_revenue', { stores: 'all', currency: 'USD', days: 30 })
      expect(t.stores.find((s) => s.store === 'eu-store')).toMatchObject({ status: 'no_rate', detail: 'No TRY rate for that day.' })
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
      expect(JSON.parse(out.stdout)).toMatchObject({ rollup: true, metric: 'contribution_margin', currency: 'USD', total: 195.38, line: 'In USD at European Central Bank reference rates, via Frankfurter for Nov 20, 2026.' })
    } finally {
      await fx.close()
    }
  }, 60_000)
})
