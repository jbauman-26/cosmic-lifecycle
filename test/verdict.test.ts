import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { TOLERANCE, type Tolerances } from '../src/reconcile.js'
import { syncGa4, syncShopify, syncStripe } from '../src/sync.js'
import { parsePeriod, periodSql, verdictExit, verdictFor, type VerdictOptions } from '../src/verdict.js'
import { CliError } from '../src/errors.js'

// The acceptance cases from the agency trust review (Codex's 11, rewritten): the same questions, but every
// answer now comes from data the CLI synced and the checks it ran, never from fields a caller supplies.

const T = (o: Partial<Tolerances> = {}): Tolerances => ({ ...TOLERANCE, days: 90, ...o })
const ws = { type: 'shopify', reference: 'shopify', referenceSet: true, title: 'Store' } as const
const opts = (o: VerdictOptions = {}): VerdictOptions => ({ tolerances: T(), workspace: ws, connected: ['shopify'], name: 'acme', ...o })

// Months relative to today, so the tests never age.
const monthOf = (offset: number) => {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 7)
}
const LAST = monthOf(-1)
const BEFORE = monthOf(-2)
const order = (month: string, i: number) => ({
  id: `o${month}${i}`, processedAt: `${month}-10T12:00:00Z`, cancelledAt: null, customer: { id: `c${i}` },
  currentTotalPriceSet: { shopMoney: { amount: '50.00' } }, totalDiscountsSet: { shopMoney: { amount: '0.00' } },
})
const orders = (month: string, n: number) => Array.from({ length: n }, (_, i) => order(month, i))
const orderKpi = (v: Awaited<ReturnType<typeof verdictFor>>) => v.kpis.find((k) => k.kpi === 'shopify_orders')!

let db: Db
beforeEach(async () => {
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(() => db.close())

describe('verdictFor: the three acceptance cases', () => {
  it('a clean month of 801 orders is reportable, with the value 801', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    const v = await verdictFor(db, LAST, opts())
    expect(orderKpi(v)).toMatchObject({ status: 'reportable', value: 801, reason: null })
    expect(v.period_state).toBe('complete')
    expect(verdictExit(v)).toBe(0)
  })

  it('787 against Shopify’s 801 is withheld, says 14 orders are missing, and has no value', async () => {
    await syncShopify(db, async () => orders(LAST, 787), async () => 801)
    const v = await verdictFor(db, LAST, opts())
    const k = orderKpi(v)
    expect(k).toMatchObject({ status: 'withheld', value: null })
    expect(k.reason).toContain('14 orders missing: 787 against 801')
    expect(k.next_checks.join(' ')).toContain('orders_complete')
    expect(k.reason).not.toContain('unchecked')
    expect(verdictExit(v)).toBe(3)
  })

  it('a genuine zero is reportable: the store had orders, just none that month', async () => {
    await syncShopify(db, async () => orders(BEFORE, 20), async () => 20)
    const v = await verdictFor(db, LAST, opts())
    expect(v.kpis.find((k) => k.kpi === 'average_order_value')).toMatchObject({ status: 'reportable', value: null })
    expect(v.kpis.find((k) => k.kpi === 'average_order_value')!.notes.join(' ')).toContain('nothing to divide by')
    expect(orderKpi(v)).toMatchObject({ status: 'reportable', value: 0 })
    expect(verdictExit(v)).toBe(0)
  })
})

describe('verdictFor: what must hold a KPI back', () => {
  it('a stored "pass" for 787 against 801 does not count: the checks are run again', async () => {
    await syncShopify(db, async () => orders(LAST, 787), async () => 801)
    await db.query(`INSERT INTO meta_reconcile_result VALUES ('orders_complete', 'pass', 801, 801, 0, 'forged', now())`)
    expect(orderKpi(await verdictFor(db, LAST, opts()))).toMatchObject({ status: 'withheld', value: null })
  })

  it('a stale source is withheld, even when its counts agree', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString()
    // Still after the month ended (the month before last ends at least a month ago), but past the freshness limit.
    await db.query(`UPDATE meta_sync_run SET finished_at = $1, started_at = $1`, [fiveDaysAgo])
    const v = await verdictFor(db, BEFORE, opts())
    expect(orderKpi(v).status).toBe('withheld')
    expect(orderKpi(v).reason).toMatch(/freshness/)
  })

  it('another client’s workspace gets its own verdict: no sync there means nothing reportable', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    const other = wrapPglite(await PGlite.create())
    await migrate(other)
    try {
      const v = await verdictFor(other, LAST, opts({ name: 'beta' }))
      expect(v.workspace).toBe('beta')
      expect(orderKpi(v)).toMatchObject({ status: 'withheld', value: null })
      expect(orderKpi(v).reason).toContain('has not finished a sync')
    } finally {
      await other.close()
    }
  })

  it('a source that never synced is withheld, not reported as zero', async () => {
    const v = await verdictFor(db, LAST, opts())
    expect(orderKpi(v)).toMatchObject({ status: 'withheld', value: null })
    expect(v.trust.status).toBe('unchecked')
  })

  it('a keyed Shopify sync limited to 60 days holds back a month older than that', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    await db.query(`INSERT INTO meta_shopify_sync (id, window_limited) VALUES (1, true)`)
    const v = await verdictFor(db, BEFORE, opts())
    expect(orderKpi(v).status).toBe('withheld')
    expect(orderKpi(v).reason).toContain('last 60 days')
  })

  it('without a store key, orders that all fall in the last 60 days hold back older months (review finding)', async () => {
    const recent = Array.from({ length: 40 }, (_, i) => ({ ...order(LAST, i), processedAt: new Date(Date.now() - (i % 30 + 1) * 86400000).toISOString() }))
    await syncShopify(db, async () => recent, async () => 40)
    const v = await verdictFor(db, monthOf(-4), opts())
    expect(orderKpi(v)).toMatchObject({ status: 'withheld', value: null })
    expect(orderKpi(v).reason).toContain('last 60 days')
  })

  it('an unkeyed store synced exactly 60 days after the month began is withheld: those 60 days roll by the clock (review finding)', async () => {
    const syncAt = Date.parse(`${BEFORE}-01T15:00:00Z`) + 60 * 86400000
    const recent = Array.from({ length: 12 }, (_, i) => ({ ...order(BEFORE, i), processedAt: new Date(Date.parse(`${BEFORE}-01T15:30:00Z`) + i * 86400000).toISOString() }))
    await syncShopify(db, async () => recent, async () => 12)
    await db.query(`UPDATE meta_sync_run SET started_at = $1, finished_at = $1`, [new Date(syncAt).toISOString()])
    const v = await verdictFor(db, BEFORE, opts({ now: syncAt + 3600000, tolerances: T({ freshnessDays: 400 }) }))
    expect(orderKpi(v).status).toBe('withheld')
    expect(orderKpi(v).reason).toContain('last 60 days')
  })

  it('a sync that started before the month ended is withheld, even if it finished after (review finding)', async () => {
    await syncShopify(db, async () => orders(BEFORE, 10), async () => 10)
    const end = Date.parse(`${LAST}-01T00:00:00Z`)
    await db.query(`UPDATE meta_sync_run SET started_at = $1, finished_at = $2`, [new Date(end - 10 * 60000).toISOString(), new Date(end + 5 * 60000).toISOString()])
    const v = await verdictFor(db, BEFORE, opts({ tolerances: T({ freshnessDays: 400 }) }))
    expect(orderKpi(v).status).toBe('withheld')
    expect(orderKpi(v).reason).toContain('pulled through')
  })

  it('a Shopify cursor (bulk export cut-off) before the month ended is withheld (review finding)', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    const cutoff = new Date(Date.parse(`${monthOf(0)}-01T00:00:00Z`) - 3600000).toISOString()
    await db.query(`INSERT INTO meta_shopify_sync (id, cursor_at, window_limited) VALUES (1, $1, false)`, [cutoff])
    const v = await verdictFor(db, LAST, opts())
    expect(orderKpi(v).status).toBe('withheld')
    expect(orderKpi(v).reason).toContain('pulled through')
  })

  it('a last sync that finished before the month ended is withheld', async () => {
    await syncShopify(db, async () => orders(BEFORE, 10), async () => 10)
    await db.query(`UPDATE meta_sync_run SET finished_at = $1, started_at = $1`, [`${LAST}-15T00:00:00Z`])
    const v = await verdictFor(db, LAST, opts({ tolerances: T({ freshnessDays: 400 }) }))
    expect(orderKpi(v).status).toBe('withheld')
    expect(orderKpi(v).reason).toContain('before the month ended')
  })

  it('a source that is syncing right now is withheld', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, status) VALUES ('r2', 'shopify', now(), 'running')`)
    const v = await verdictFor(db, LAST, opts())
    expect(orderKpi(v).status).toBe('withheld')
    expect(orderKpi(v).reason).toContain('still syncing')
  })

  it('a zero with its check skipped (no exact count from Shopify) is withheld as unchecked', async () => {
    await syncShopify(db, async () => orders(BEFORE, 5), async () => null)
    const v = await verdictFor(db, LAST, opts())
    expect(orderKpi(v)).toMatchObject({ status: 'withheld', value: null })
    expect(orderKpi(v).reason).toContain('unchecked')
  })

  it('a source that is not connected any more is withheld, whatever its old rows say', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    const v = await verdictFor(db, LAST, opts({ connected: [] }))
    // Nothing connected means no KPI qualifies, which is not a clean result.
    expect(v.kpis).toHaveLength(0)
    expect(verdictExit(v)).toBe(3)
  })

  it('the month still running is withheld, and so is one that has not started', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    const running = await verdictFor(db, monthOf(0), opts())
    expect(running.period_state).toBe('in_progress')
    expect(running.kpis.every((k) => k.status === 'withheld')).toBe(true)
    const future = await verdictFor(db, monthOf(2), opts())
    expect(future.period_state).toBe('future')
    expect(orderKpi(future).reason).toContain('has not started')
  })

  it('each KPI names its sources, checks, and the sync time it rests on', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    const v = await verdictFor(db, LAST, opts())
    expect(v).toMatchObject({ workspace: 'acme', period: LAST, period_start: `${LAST}-01` })
    expect(orderKpi(v).sources).toEqual(['shopify'])
    expect(orderKpi(v).checks.map((c) => c.name)).toContain('orders_complete')
    expect(v.sources[0]).toMatchObject({ source: 'shopify', covers_period: true })
    expect(v.sources[0]!.last_synced_at).toBeTruthy()
    expect(Array.isArray(v.not_by_period)).toBe(true)
  })
})

describe('verdictFor: each KPI needs the check for its own data (review findings)', () => {
  const klaviyo = async (from: string) => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('k1', 'klaviyo', now(), now(), 'ok')`)
    await db.query(`INSERT INTO meta_source_window VALUES ('klaviyo', 'placed_orders', $1, current_date, now())`, [from])
    await db.query(`INSERT INTO fact_klaviyo_orders_daily VALUES ($1, 801, 0, now())`, [`${LAST}-10`])
  }
  const kpi = (v: Awaited<ReturnType<typeof verdictFor>>, name: string) => v.kpis.find((k) => k.kpi === name)!

  it('a passing Klaviyo order check does not certify flow revenue when the flow check was skipped', async () => {
    await klaviyo(`${BEFORE}-01`)
    const v = await verdictFor(db, LAST, opts({ connected: ['shopify', 'klaviyo'] }))
    expect(kpi(v, 'klaviyo_placed_orders')).toMatchObject({ status: 'reportable', value: 801 })
    expect(kpi(v, 'flow_attributed_revenue').status).toBe('withheld')
    expect(kpi(v, 'flow_attributed_revenue').reason).toContain('unchecked')
  })

  it('a trailing comparison check does not vouch for a month outside its window', async () => {
    // Orders in the month and in the last few days; the Klaviyo check only compares the last 5.
    const recent = Array.from({ length: 6 }, (_, i) => ({ ...order(LAST, 900 + i), processedAt: new Date(Date.now() - 2 * 86400000).toISOString() }))
    await syncShopify(db, async () => [...orders(LAST, 801), ...recent], async () => 807)
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('k1', 'klaviyo', now(), now(), 'ok')`)
    await db.query(`INSERT INTO meta_source_window VALUES ('klaviyo', 'placed_orders', $1, current_date, now())`, [`${BEFORE}-01`])
    await db.query(`INSERT INTO fact_klaviyo_orders_daily VALUES ($1, 801, 0, now()), (current_date - 2, 6, 0, now())`, [`${LAST}-10`])
    const v = await verdictFor(db, LAST, opts({ connected: ['shopify', 'klaviyo'], tolerances: T({ days: 5 }) }))
    expect(kpi(v, 'klaviyo_placed_orders').status).toBe('withheld')
    expect(kpi(v, 'klaviyo_placed_orders').reason).toContain('covers only the last 5 days')
    // Shopify's own count check covers all history, so its KPIs stand.
    expect(orderKpi(v).status).toBe('reportable')
  })

  it('a Klaviyo window that starts on the 1st may have started after midnight, so it is withheld', async () => {
    await klaviyo(`${LAST}-01`)
    const v = await verdictFor(db, LAST, opts({ connected: ['shopify', 'klaviyo'] }))
    expect(kpi(v, 'klaviyo_placed_orders').status).toBe('withheld')
    expect(kpi(v, 'klaviyo_placed_orders').reason).toContain('after midnight')
  })

  it('GA4 is judged by the days its syncs pulled, not by today\'s metrics.default_days (review finding)', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
    // An old sync pulled one day 240 days ago; the latest pulled the last 30 days. The months between were never pulled.
    await syncGa4(db, async () => [{ date: day(240), channel: 'x', sessions: 100, purchases: 1, revenue: 1 }], { start: day(240), end: day(240) })
    await syncGa4(db, async () => [{ date: day(3), channel: 'x', sessions: 100, purchases: 1, revenue: 1 }], { start: day(30), end: day(0) })
    for (const days of [90, 730]) {
      const v = await verdictFor(db, monthOf(-5), opts({ connected: ['shopify', 'ga4'], tolerances: T({ days }) }))
      expect(kpi(v, 'ga4_sessions').status).toBe('withheld')
      expect(kpi(v, 'ga4_sessions').reason).toContain('does not cover the whole month')
    }
  })

  it('GA4 synced before windows were recorded is withheld until it syncs again', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    await syncGa4(db, async () => [{ date: `${BEFORE}-10`, channel: 'x', sessions: 100, purchases: 1, revenue: 1 }])
    const v = await verdictFor(db, LAST, opts({ connected: ['shopify', 'ga4'] }))
    expect(kpi(v, 'ga4_sessions').reason).toContain('no recorded sync window')
  })

  it("without Stripe's own report, Stripe KPIs are withheld (review finding)", async () => {
    const charge = (i: number) => ({ id: `ch${i}`, created: Date.parse(`${LAST}-10T12:00:00Z`) / 1000, amount: 5000, amount_refunded: 0, currency: 'usd', status: 'succeeded', customer: `cus${i}` })
    await syncStripe(db, { charges: async () => [charge(1), charge(2)], subscriptions: async () => null })
    const v = await verdictFor(db, LAST, opts({ connected: ['stripe'], workspace: { type: 'saas', reference: 'stripe', referenceSet: true, title: 'SaaS' } }))
    const k = kpi(v, 'stripe_net_revenue')
    expect(k.status).toBe('withheld')
    // 0.20.1: Stripe charge KPIs need Stripe's own report; same-pull checks are not enough.
    expect(k.reason).toContain("Stripe's own report for")
  })

  it('days changed from the default are listed too (review finding)', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    const v = await verdictFor(db, LAST, opts({ tolerances: T({ days: 730 }) }))
    expect(v.settings_changed).toContain('days: 730 (default 90)')
  })

  it('tolerances changed from the defaults are listed in the verdict', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    const v = await verdictFor(db, LAST, opts({ tolerances: T({ freshnessDays: 365 }) }))
    expect(v.settings_changed).toEqual(['freshnessDays: 365 (default 2)'])
  })

  it('carries the metric notes into the KPI', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    const v = await verdictFor(db, LAST, opts())
    expect(kpi(v, 'returning_order_share').notes.join(' ')).toContain('returning')
  })
})

describe('periods', () => {
  it('accepts YYYY-MM and gives the month’s first day and the next month’s', () => {
    expect(parsePeriod('2026-12')).toEqual({ start: '2026-12-01', end: '2027-01-01' })
  })

  it.each(['banana', '2026-13', '2026-1', '1999-05', ''])('refuses %j as bad input', (p) => {
    expect(() => parsePeriod(p)).toThrow(CliError)
  })

  it('closes every window at the end of the month', () => {
    expect(periodSql('SELECT sum(x) FROM t WHERE date >= $1')).toBe('SELECT sum(x) FROM t WHERE date >= $1 AND date < $2')
  })
})
