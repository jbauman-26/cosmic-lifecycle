import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { TOLERANCE, type Tolerances } from '../src/reconcile.js'
import { syncGa4, syncShopify, syncStripe } from '../src/sync.js'
import { formatVerdict, parsePeriod, periodSql, verdictExit, verdictFor, type VerdictOptions } from '../src/verdict.js'
import { compare } from '../src/reconcile.js'
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

describe('0.20.1: KPIs from the workspace\'s own source of truth', () => {
  const saas = { type: 'saas', reference: 'stripe', referenceSet: true, title: 'SaaS' } as const
  const at = (month: string, day = 10) => Date.parse(`${month}-${String(day).padStart(2, '0')}T12:00:00Z`) / 1000
  const charges = (month: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `ch${month}${from + i}`, created: at(month), amount: 5000, amount_refunded: 0, currency: 'usd', status: 'succeeded', customer: `cus${from + i}` }))
  const subs = Array.from({ length: 10 }, (_, i) => ({ id: `sub${i}`, created: at(BEFORE, 5), status: 'active', ended_at: null, currency: 'usd', items: { data: [{ quantity: 1, price: { unit_amount: 4900, recurring: { interval: 'month', interval_count: 1 } } }] } }))
  const stripe = async (inMonth = 452) => {
    await syncStripe(db, { charges: async () => [...charges(BEFORE, 30), ...charges(LAST, inMonth, 100)], subscriptions: async () => subs })
    // MRR is recorded on the days Stripe syncs; an earlier sync took one late in the month.
    await db.query(`INSERT INTO fact_stripe_mrr VALUES ($1, 'usd', 10, 490, 0, now())`, [NEAR_END])
  }
  const kpi = (v: Awaited<ReturnType<typeof verdictFor>>, name: string) => v.kpis.find((k) => k.kpi === name)!
  // The second-to-last day of last month: inside the last 3 days, as the freshness limit (2) plus one allows.
  const NEAR_END = new Date(Date.UTC(Number(LAST.slice(0, 4)), Number(LAST.slice(5, 7)), -1)).toISOString().slice(0, 10)
  const saasOpts = (o: VerdictOptions = {}) => opts({ connected: ['stripe'], workspace: saas, ...o })

  it('Stripe MRR is reportable on a complete, fresh, finished month, labelled "matches Stripe"', async () => {
    await stripe()
    const v = await verdictFor(db, LAST, saasOpts())
    const mrr = kpi(v, 'stripe_mrr')
    expect(mrr).toMatchObject({ status: 'reportable', value: 490, basis: 'matches Stripe', reason: null })
    expect(mrr.notes.join(' ')).toContain(`at the last sync in the month, ${NEAR_END}`)
    expect(mrr.as_of).toBe(NEAR_END)
    expect(formatVerdict(v)).toContain(`REPORT stripe_mrr: 490 at ${NEAR_END} (matches Stripe)`)
    expect(kpi(v, 'stripe_net_revenue')).toMatchObject({ status: 'reportable', basis: 'matches Stripe' })
    expect(kpi(v, 'stripe_net_revenue').value).toBeGreaterThan(0)
    expect(JSON.stringify(v)).not.toMatch(/independent/i)
    expect(v.not_by_period).not.toContain('stripe_mrr')
  })

  it('Stripe MRR is withheld when stripe_daily_complete fails, 446 against 452', async () => {
    // 30 charges before the month and 416 in it: 446 in the daily table, while the pull counted 452.
    await stripe(416)
    await db.query(`UPDATE meta_source_total SET value = 452 WHERE source = 'stripe' AND metric = 'charges_counted'`)
    const v = await verdictFor(db, LAST, saasOpts())
    const mrr = kpi(v, 'stripe_mrr')
    expect(mrr).toMatchObject({ status: 'withheld', value: null, basis: null })
    expect(mrr.reason).toContain('6 charges missing: 446 against 452 (stripe_daily_complete)')
    expect(mrr.checks.find((c) => c.name === 'stripe_daily_complete')).toMatchObject({ status: 'fail', expected: 452, actual: 446 })
  })

  it('Stripe MRR is withheld on an unfinished month', async () => {
    await stripe()
    await db.query(`INSERT INTO fact_stripe_mrr VALUES (current_date, 'usd', 10, 490, 0, now()) ON CONFLICT DO NOTHING`)
    const v = await verdictFor(db, monthOf(0), saasOpts())
    expect(kpi(v, 'stripe_mrr').status).toBe('withheld')
    expect(kpi(v, 'stripe_mrr').reason).toContain('still running')
  })

  it('Stripe MRR is withheld when no snapshot was taken during the month', async () => {
    await stripe()
    await db.query(`DELETE FROM fact_stripe_mrr WHERE date = $1`, [NEAR_END])
    const v = await verdictFor(db, LAST, saasOpts())
    expect(kpi(v, 'stripe_mrr')).toMatchObject({ status: 'withheld', value: null })
    expect(kpi(v, 'stripe_mrr').reason).toContain('no snapshot')
  })

  it('Stripe KPIs are withheld when Stripe is not the workspace\'s source of truth', async () => {
    await stripe()
    const v = await verdictFor(db, LAST, opts({ connected: ['stripe'], workspace: { type: 'saas', reference: 'hubspot', referenceSet: true, title: 'SaaS' } }))
    expect(kpi(v, 'stripe_mrr')).toMatchObject({ status: 'withheld', basis: null })
    expect(kpi(v, 'stripe_net_revenue').reason).toContain('No check verifies fact_stripe_daily')
  })

  it('a KPI that mixes Stripe with another source gets no source-of-truth pass (visit to paid rate needs GA4 too)', async () => {
    await stripe()
    const v = await verdictFor(db, LAST, saasOpts({ connected: ['stripe', 'ga4'] }))
    expect(kpi(v, 'visit_to_paid_rate').status).toBe('withheld')
  })


  it('subscription KPIs need the subscription check: a key that cannot read subscriptions gives no match (review finding)', async () => {
    await syncStripe(db, { charges: async () => [...charges(BEFORE, 30), ...charges(LAST, 452, 100)], subscriptions: async () => null })
    await db.query(`INSERT INTO fact_stripe_mrr VALUES ($1, 'usd', 10, 490, 0, now())`, [NEAR_END])
    const v = await verdictFor(db, LAST, saasOpts())
    for (const name of ['stripe_subscriptions_started', 'stripe_subscriptions_ended', 'stripe_mrr']) expect(kpi(v, name)).toMatchObject({ status: 'withheld', basis: null })
    // Charges are counted by their own check, so charge KPIs still match.
    expect(kpi(v, 'stripe_net_revenue')).toMatchObject({ status: 'reportable', basis: 'matches Stripe' })
  })

  it('a later sync that could not read subscriptions withholds them, even though older counts still balance (review finding)', async () => {
    await stripe()
    await db.query(`UPDATE meta_source_total SET recorded_at = now() - interval '1 day' WHERE source = 'stripe' AND metric = 'subscriptions_open'`)
    const v = await verdictFor(db, LAST, saasOpts())
    expect(kpi(v, 'stripe_mrr').status).toBe('withheld')
    expect(kpi(v, 'stripe_mrr').reason).toContain('did not read subscriptions')
  })

  it('an MRR snapshot from early in the month is not the month\'s MRR (review finding)', async () => {
    await stripe()
    await db.query(`UPDATE fact_stripe_mrr SET date = $1 WHERE date = $2`, [`${LAST}-03`, NEAR_END])
    const v = await verdictFor(db, LAST, saasOpts())
    expect(kpi(v, 'stripe_mrr')).toMatchObject({ status: 'withheld', value: null })
    expect(kpi(v, 'stripe_mrr').reason).toContain(`last recorded on ${LAST}-03`)
  })

  it('a zero-tolerance count check is exact: 25,000 against 25,001 fails (review finding)', () => {
    expect(compare('stripe_daily_complete', 25001, 25000, 0, 'Charges').status).toBe('fail')
    expect(compare('stripe_daily_complete', 25001, 25000, 0, 'Charges').detail).toContain('off by 1')
    expect(compare('stripe_daily_complete', 25001, 25001, 0, 'Charges').status).toBe('pass')
  })

  it('a mixed KPI says why the Stripe match does not cover it', async () => {
    await stripe()
    const v = await verdictFor(db, LAST, saasOpts({ connected: ['stripe', 'ga4'] }))
    expect(kpi(v, 'visit_to_paid_rate').reason).toContain('combines Stripe with GA4')
  })
  it('Meta stays withheld: its numbers are the platform\'s own claims', async () => {
    await stripe()
    const v = await verdictFor(db, LAST, saasOpts({ connected: ['stripe', 'meta'] }))
    for (const name of ['meta_ad_spend', 'meta_attributed_purchases']) {
      const k = v.kpis.find((x) => x.kpi === name)
      if (!k) continue
      expect(k.status).toBe('withheld')
      expect(k.reason).toContain('No check verifies fact_meta_ads_daily')
    }
    expect(v.kpis.some((k) => k.kpi.startsWith('meta_'))).toBe(true)
  })

  it('a Shopify KPI in a store says "matches Shopify"', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    const v = await verdictFor(db, LAST, opts())
    expect(orderKpi(v)).toMatchObject({ status: 'reportable', value: 801, basis: 'matches Shopify' })
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
