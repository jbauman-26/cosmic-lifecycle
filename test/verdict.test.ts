import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { TOLERANCE, type Tolerances } from '../src/reconcile.js'
import { syncShopify } from '../src/sync.js'
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

  it('data that starts after the month began is withheld (Shopify gave only recent orders)', async () => {
    await syncShopify(db, async () => orders(LAST, 801), async () => 801)
    await db.query(`INSERT INTO meta_shopify_sync (id, window_limited) VALUES (1, true)`)
    await db.query(`INSERT INTO shopify_order_state (order_key, processed_at, processed_day, net, discounts, cancelled) VALUES ('k', $1::timestamptz, $2::date, 50, 0, false)`, [`${LAST}-10T00:00:00Z`, `${LAST}-10`])
    const v = await verdictFor(db, LAST, opts())
    expect(orderKpi(v).status).toBe('withheld')
    expect(orderKpi(v).reason).toContain('start of the month may be missing')
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
