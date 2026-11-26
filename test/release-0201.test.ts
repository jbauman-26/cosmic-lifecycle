import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { TOLERANCE, compare, type Tolerances } from '../src/reconcile.js'
import { syncStripe } from '../src/sync.js'
import { parseActivityCsv, monthTotals, type ReportRun } from '../src/sources/stripe.js'
import { syncStripeReport, finishedMonths, NO_PERMISSION, TEST_MODE, type ReportClient } from '../src/stripe-report.js'
import { formatVerdict, verdictExit, verdictFor, type VerdictOptions } from '../src/verdict.js'

// 0.20.1: Stripe charge KPIs are reportable only against Stripe's own report (its balance ledger, from the Reports
// API), never against checks counted from the same charges pull. MRR is reported as of a sync, never as a month.

const T = (o: Partial<Tolerances> = {}): Tolerances => ({ ...TOLERANCE, days: 90, ...o })
const saas = { type: 'saas', reference: 'stripe', referenceSet: true, title: 'SaaS' } as const
const opts = (o: VerdictOptions = {}): VerdictOptions => ({ tolerances: T(), workspace: saas, connected: ['stripe'], name: 'acme', ...o })
const monthOf = (offset: number) => {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 7)
}
const LAST = monthOf(-1)
const BEFORE = monthOf(-2)
const at = (month: string, day = 10) => Date.parse(`${month}-${String(day).padStart(2, '0')}T12:00:00Z`) / 1000
const charge = (month: string, i: number, refunded = 0) => ({ id: `ch_${month}_${i}`, created: at(month), amount: 5000, amount_refunded: refunded, currency: 'usd', status: 'succeeded', customer: `cus_${i}` })
const subs = Array.from({ length: 10 }, (_, i) => ({ id: `sub_${i}`, created: at(BEFORE, 5), status: 'active', ended_at: null, currency: 'usd', items: { data: [{ quantity: 1, price: { unit_amount: 4900, recurring: { interval: 'month', interval_count: 1 } } }] } }))

let db: Db
beforeEach(async () => {
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(() => db.close())

// 30 charges the month before and n last month, one of them refunded $20.
const stripe = async (n = 452, opts: { subscriptions?: boolean } = {}) => {
  const charges = [...Array.from({ length: 30 }, (_, i) => charge(BEFORE, i)), ...Array.from({ length: n }, (_, i) => charge(LAST, 100 + i, i === 0 ? 2000 : 0))]
  return syncStripe(db, { charges: async () => charges, subscriptions: async () => (opts.subscriptions === false ? null : subs) })
}
// Stripe's own report for last month, as the sync step stores it.
// Stripe's report always ends before the sync that asked for it, as here: an hour ago.
const report = (charges: number, refunds = -20, through = new Date(Date.now() - 3600000).toISOString()) =>
  db.query(`INSERT INTO meta_stripe_report_month (month, currency, charges, gross, refunds, through_at, fetched_at) VALUES ($1, 'usd', $2, $3, $4, $5, now()), ($1, '*', 0, 0, 0, $5, now())`, [LAST, charges, charges * 50, refunds, through])
const kpi = (v: Awaited<ReturnType<typeof verdictFor>>, name: string) => v.kpis.find((k) => k.kpi === name)!

const HEAD = 'reporting_category,customer_facing_currency,customer_facing_amount,charge_created_utc,created_utc'
describe('Stripe\'s own report: parsing', () => {
  it('reads the charge\'s own currency and amount, refunds against their charge\'s month', () => {
    const rows = parseActivityCsv(`${HEAD}\ncharge,usd,50.00,2026-10-10 12:00:00,2026-10-10 12:00:00\n"refund","usd","-20.00","2026-10-10 12:00:00","2026-11-02 09:00:00"\ncharge,eur,50.00,,2026-09-03 08:00:00\nfee,usd,-1.50,,\n`)
    expect(monthTotals(rows).sort((a, b) => a.month.localeCompare(b.month))).toEqual([
      { month: '2026-09', currency: 'eur', charges: 1, gross: 50, refunds: 0, unplaced: 0 },
      { month: '2026-10', currency: 'usd', charges: 1, gross: 50, refunds: -20, unplaced: 0 },
    ])
  })

  it('a bank debit that fails after posting is no sale (review finding)', () => {
    const rows = parseActivityCsv(`${HEAD}\ncharge,usd,50.00,2026-10-10 12:00:00,2026-10-10 12:00:00\ncharge_failure,usd,-50.00,2026-10-10 12:00:00,2026-10-14 12:00:00\n`)
    expect(monthTotals(rows)).toEqual([{ month: '2026-10', currency: 'usd', charges: 0, gross: 0, refunds: 0, unplaced: 0 }])
  })

  it('a refund row with no charge date is counted as unplaced, never dropped (review finding)', () => {
    const rows = parseActivityCsv(`${HEAD}\nrefund,usd,-20.00,,2026-11-02 09:00:00\n`)
    expect(monthTotals(rows)).toEqual([{ month: '?', currency: 'usd', charges: 0, gross: 0, refunds: 0, unplaced: 1 }])
  })

  it('sums in cents, so many small amounts compare exactly (review finding)', () => {
    const rows = parseActivityCsv([HEAD, ...Array.from({ length: 10 }, () => 'charge,usd,0.10,2026-10-10 12:00:00,')].join('\n'))
    expect(monthTotals(rows)[0]!.gross).toBe(1)
  })

  it('refuses a report without the expected columns', () => {
    expect(() => parseActivityCsv('a,b\n1,2')).toThrow(/expected columns/)
  })
})

describe('Stripe\'s own report: the sync step', () => {
  const avail = () => ({ start: Date.UTC(2020, 0, 1) / 1000, end: Math.floor(Date.now() / 1000) - 3600 })
  const client = (o: Partial<ReportClient> & { runs?: ReportRun[] } = {}): ReportClient & { started: number; intervals: [number, number][] } => {
    const runs = [...(o.runs ?? [{ id: 'frr_1', status: 'succeeded', url: 'https://files.stripe.com/v1/files/file_1/contents' }])]
    const c = {
      started: 0,
      intervals: [] as [number, number][],
      mode: 'live' as const,
      activityAvailability: async () => avail(),
      startActivityRun: async (start: number, end: number) => { c.started++; c.intervals.push([start, end]); return runs[0]! },
      reportRun: async () => runs.shift() ?? runs[0]!,
      reportRows: async () => parseActivityCsv(`${HEAD}\ncharge,usd,50.00,${LAST}-10 12:00:00,${LAST}-10 12:00:00\nrefund,usd,-20.00,${LAST}-10 12:00:00,${LAST}-12 12:00:00\n`),
      ...o,
    }
    return c
  }

  it('skips test keys, because Stripe runs reports only in live mode', async () => {
    expect(await syncStripeReport(db, client({ mode: 'test' }))).toMatchObject({ status: 'unavailable', detail: TEST_MODE })
  })

  it('says which read permission is missing, and asks for nothing more', async () => {
    const r = await syncStripeReport(db, client({ activityAvailability: async () => null }))
    expect(r).toMatchObject({ status: 'unavailable', detail: NO_PERMISSION })
    expect(NO_PERMISSION).toContain('read permission "Report runs and report types"')
  })

  it('stores the last finished months, with a marker for a month with no charges', async () => {
    const r = await syncStripeReport(db, client(), { maxWaitMs: 0 })
    expect(r.status).toBe('ok')
    expect(r.months).toEqual(finishedMonths(Date.now()).map((m) => m.month))
    const rows = await db.query(`SELECT month, currency, charges, refunds FROM meta_stripe_report_month ORDER BY month, currency`)
    expect(rows.filter((x) => x.currency === '*')).toHaveLength(3)
    expect(rows.find((x) => x.month === LAST && x.currency === 'usd')).toMatchObject({ charges: 1 })
  })


  it('asks for an interval inside Stripe\'s data range: ending a second before its end (review finding)', async () => {
    const c = client()
    await syncStripeReport(db, c, { maxWaitMs: 0 })
    expect(c.intervals[0]![1]).toBe(avail().end - 1)
  })

  it('leaves out a month that starts before Stripe\'s data does (review finding)', async () => {
    const c = client({ activityAvailability: async () => ({ start: Date.parse(`${LAST}-01T00:00:00Z`) / 1000, end: avail().end }) })
    const r = await syncStripeReport(db, c, { maxWaitMs: 0 })
    expect(r.months).toEqual([LAST])
    expect(c.intervals[0]![0]).toBe(Date.parse(`${LAST}-01T00:00:00Z`) / 1000)
  })

  it('a refused request is reported with Stripe\'s own error, not as a missing permission (review finding)', async () => {
    const { HttpError } = await import('../src/http.js')
    const c = client({ startActivityRun: async () => { throw new HttpError('Stripe report run request', 400, 'interval_end out of range') } })
    await expect(syncStripeReport(db, c, { maxWaitMs: 0 })).rejects.toThrow()
  })

  it('a stored run that cannot be read is dropped, so the next sync starts fresh (review finding)', async () => {
    await syncStripeReport(db, client({ runs: [{ id: 'frr_9', status: 'pending', url: null }] }), { maxWaitMs: 0 })
    const broken = client({ reportRun: async () => { throw new Error('file gone') } })
    await expect(syncStripeReport(db, broken, { maxWaitMs: 0 })).rejects.toThrow('file gone')
    expect(await db.query(`SELECT * FROM meta_stripe_report_run`)).toEqual([])
  })

  it('reads the report once a day at most (review finding)', async () => {
    const c = client()
    await syncStripeReport(db, c, { maxWaitMs: 0 })
    const again = await syncStripeReport(db, c, { maxWaitMs: 0 })
    expect(again.detail).toContain('already read')
    expect(c.started).toBe(1)
  })

  it('leaves a report Stripe is still preparing for the next sync, and picks it up then', async () => {
    const c = client({ runs: [{ id: 'frr_2', status: 'pending', url: null }] })
    expect((await syncStripeReport(db, c, { maxWaitMs: 0 })).status).toBe('pending')
    expect((await db.query(`SELECT run_id FROM meta_stripe_report_run`))[0]).toMatchObject({ run_id: 'frr_2' })
    const later = client({ runs: [{ id: 'frr_2', status: 'succeeded', url: 'https://files.stripe.com/v1/files/file_2/contents' }] })
    expect((await syncStripeReport(db, later, { maxWaitMs: 0 })).status).toBe('ok')
    expect(later.started).toBe(0)
    expect(await db.query(`SELECT * FROM meta_stripe_report_run`)).toEqual([])
  })
})

describe('verdict: Stripe charge KPIs against Stripe\'s own report', () => {
  it('a month that matches Stripe\'s own report is reportable, labelled "matches Stripe\'s own report"', async () => {
    await stripe()
    await report(452)
    const v = await verdictFor(db, LAST, opts())
    const k = kpi(v, 'stripe_net_revenue')
    expect(k).toMatchObject({ status: 'reportable', basis: "matches Stripe's own report", reason: null })
    expect(k.value).toBe(452 * 50 - 20)
    expect(k.checks.find((c) => c.name === 'stripe_own_report')).toMatchObject({ status: 'pass' })
    expect(formatVerdict(v)).toContain("(matches Stripe's own report)")
    expect(k.notes.join(' ')).toContain('Disputes and fees are not part of that match')
    expect(JSON.stringify(v)).not.toMatch(/independent|confirmed/i)
  })

  it('446 against 452 in Stripe\'s own report is withheld, with the gap', async () => {
    await stripe(446)
    await report(452)
    const v = await verdictFor(db, LAST, opts())
    expect(kpi(v, 'stripe_net_revenue')).toMatchObject({ status: 'withheld', value: null, basis: null })
    expect(kpi(v, 'stripe_net_revenue').reason).toContain("6 charges missing: 446 against 452 in Stripe's own report")
    expect(verdictExit(v)).toBe(3)
  })

  it('without Stripe\'s own report, same-pull checks passing is not enough', async () => {
    await stripe()
    const v = await verdictFor(db, LAST, opts())
    expect(v.kpis.find((k) => k.kpi === 'stripe_net_revenue')!.checks.find((c) => c.name === 'stripe_daily_complete')?.status).toBe('pass')
    expect(kpi(v, 'stripe_net_revenue')).toMatchObject({ status: 'withheld', basis: null })
    expect(kpi(v, 'stripe_net_revenue').reason).toContain('has not been read yet')
  })

  it('net waits while refunds after the report\'s end could explain a lower net here', async () => {
    await stripe()
    await report(452, 0)
    const v = await verdictFor(db, LAST, opts())
    expect(kpi(v, 'stripe_net_revenue').status).toBe('withheld')
    expect(kpi(v, 'stripe_net_revenue').reason).toContain('net is not compared')
  })

  it('a higher net here than Stripe\'s report is a failure: timing cannot explain it (review finding)', async () => {
    await stripe()
    await report(452, -500)
    expect(kpi(await verdictFor(db, LAST, opts()), 'stripe_net_revenue').reason).toContain('Net USD')
  })

  it('an authorization never captured is no charge on either side (review finding)', async () => {
    const charges = [...Array.from({ length: 30 }, (_, i) => charge(BEFORE, i)), ...Array.from({ length: 452 }, (_, i) => charge(LAST, 100 + i, i === 0 ? 2000 : 0)), { ...charge(LAST, 999), captured: false }]
    await syncStripe(db, { charges: async () => charges, subscriptions: async () => subs })
    await report(452)
    expect(kpi(await verdictFor(db, LAST, opts()), 'stripe_net_revenue')).toMatchObject({ status: 'reportable', basis: "matches Stripe's own report" })
  })

  it('a report row with no charge date withholds the month (review finding)', async () => {
    await stripe()
    await report(452)
    await db.query(`UPDATE meta_stripe_report_month SET unplaced = 1 WHERE currency = '*'`)
    expect(kpi(await verdictFor(db, LAST, opts()), 'stripe_net_revenue').reason).toContain('no charge date')
  })

  it('KPIs built on columns the report does not cover stay withheld and say which', async () => {
    await stripe()
    await report(452)
    const v = await verdictFor(db, LAST, opts())
    expect(kpi(v, 'stripe_new_customers').status).toBe('withheld')
    expect(kpi(v, 'stripe_new_customers').reason).toContain('new_customers, which Stripe\'s own report does not cover')
  })

  it('the report vouches for the month it was run for only', async () => {
    await stripe()
    await report(452)
    expect(kpi(await verdictFor(db, BEFORE, opts()), 'stripe_net_revenue').reason).toContain(`report for ${BEFORE} has not been read yet`)
  })

  it('an unfinished month is withheld even with a report', async () => {
    await stripe()
    await report(452)
    expect(kpi(await verdictFor(db, monthOf(0), opts()), 'stripe_net_revenue').reason).toContain('still running')
  })

  it('Meta stays withheld: its numbers are the platform\'s own claims', async () => {
    await stripe()
    await report(452)
    const v = await verdictFor(db, LAST, opts({ connected: ['stripe', 'meta'] }))
    const metaKpis = v.kpis.filter((k) => k.kpi.startsWith('meta_'))
    expect(metaKpis.length).toBeGreaterThan(0)
    for (const k of metaKpis) expect(k.status).toBe('withheld')
  })
})

describe('verdict: MRR as of the last sync, never a month figure', () => {
  it('is reportable as of the sync when subscriptions were read, balance and are fresh', async () => {
    await stripe()
    const v = await verdictFor(db, LAST, opts())
    expect(v.kpis.find((k) => k.kpi === 'stripe_mrr')).toBeUndefined()
    expect(v.not_by_period).toContain('stripe_mrr')
    const mrr = v.as_of!.kpis.find((k) => k.kpi === 'stripe_mrr')!
    expect(mrr).toMatchObject({ status: 'reportable', value: 490 })
    expect(mrr.basis).toBe(`as of ${v.as_of!.at}`)
    expect(mrr.notes.join(' ')).toContain('not a figure for any month')
    expect(formatVerdict(v)).toMatch(/Point in time, not for \d{4}-\d{2}:\nAS OF  stripe_mrr: 490 \(as of /)
  })

  it('is withheld when the latest sync could not read subscriptions', async () => {
    await stripe()
    await stripe(452, { subscriptions: false })
    const mrr = (await verdictFor(db, LAST, opts())).as_of!.kpis[0]!
    expect(mrr).toMatchObject({ status: 'withheld', value: null, basis: null })
    expect(mrr.reason).toContain('did not read subscriptions')
  })

  it('is withheld when the sync is stale', async () => {
    await stripe()
    await db.query(`UPDATE meta_sync_run SET started_at = now() - interval '5 days', finished_at = now() - interval '5 days'`)
    expect((await verdictFor(db, LAST, opts())).as_of!.kpis[0]!.reason).toContain('freshness limit')
  })

  it('is withheld when the subscription count does not balance', async () => {
    await stripe()
    await db.query(`UPDATE meta_source_total SET value = value + 3 WHERE source = 'stripe' AND metric = 'subscriptions_open'`)
    expect((await verdictFor(db, LAST, opts())).as_of!.kpis[0]!.reason).toContain('subscriptions_balance failed')
  })
})

describe('checks', () => {
  it('a zero-tolerance count check is exact: 25,000 against 25,001 fails', () => {
    expect(compare('orders_complete', 25001, 25000, 0, 'Orders').status).toBe('fail')
    expect(compare('orders_complete', 25001, 25000, 0, 'Orders').detail).toContain('off by 1')
    expect(compare('orders_complete', 25001, 25001, 0, 'Orders').status).toBe('pass')
  })
})
