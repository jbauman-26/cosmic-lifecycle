import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { aggregateCharges, aggregateSubscriptions, Stripe, stripeMode, toMajor, type RawCharge, type RawSubscription } from '../src/sources/stripe.js'
import { syncStripe, writeStripe } from '../src/sync.js'
import { runMetric } from '../src/metrics.js'
import { HttpError } from '../src/http.js'

const t = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)
let n = 0
const charge = (iso: string, customer: string | null, amount = 1000, extra: Partial<RawCharge> = {}): RawCharge => ({
  id: `ch_${++n}`, created: t(iso), amount, amount_refunded: 0, currency: 'usd', status: 'succeeded', customer, ...extra,
})
const sub = (iso: string, status: string, price: { unit_amount: number | null; interval: string; count?: number }, extra: Partial<RawSubscription> = {}, quantity = 1): RawSubscription => ({
  id: `sub_${++n}`, created: t(iso), status, ended_at: null, currency: 'usd',
  items: { data: [{ quantity, price: { unit_amount: price.unit_amount, recurring: { interval: price.interval, interval_count: price.count ?? 1 } } }] },
  ...extra,
})

describe('toMajor', () => {
  it('handles cents, zero-decimal and three-decimal currencies', () => {
    expect(toMajor(1999, 'usd')).toBe(19.99)
    expect(toMajor(1999, 'JPY')).toBe(1999)
    expect(toMajor(1999, 'kwd')).toBe(1.999)
  })
})

describe('stripeMode', () => {
  it('reads the mode from the key prefix', () => {
    expect(stripeMode('rk_test_abc')).toBe('test')
    expect(stripeMode('sk_test_abc')).toBe('test')
    expect(stripeMode('rk_live_abc')).toBe('live')
  })
})

describe('aggregateCharges', () => {
  it('splits a first payment from a repeat one, in date order', () => {
    const daily = aggregateCharges([charge('2026-02-01T10:00:00Z', 'cus_a'), charge('2026-01-01T10:00:00Z', 'cus_a')])
    expect(daily.find((d) => d.date === '2026-01-01')).toMatchObject({ charges: 1, newCustomers: 1, returningCharges: 0 })
    expect(daily.find((d) => d.date === '2026-02-01')).toMatchObject({ charges: 1, newCustomers: 0, returningCharges: 1 })
  })

  it('counts failed charges without counting their money', () => {
    const [d] = aggregateCharges([charge('2026-01-01T10:00:00Z', 'cus_a', 500, { status: 'failed' })])
    expect(d).toMatchObject({ charges: 0, failed: 1, gross: 0, newCustomers: 0 })
  })

  it('a failed charge does not make the next payment a repeat', () => {
    const daily = aggregateCharges([
      charge('2026-01-01T10:00:00Z', 'cus_a', 500, { status: 'failed' }),
      charge('2026-01-02T10:00:00Z', 'cus_a', 500),
    ])
    expect(daily.find((d) => d.date === '2026-01-02')).toMatchObject({ newCustomers: 1, returningCharges: 0 })
  })

  it('ignores pending charges', () => {
    expect(aggregateCharges([charge('2026-01-01T10:00:00Z', 'cus_a', 500, { status: 'pending' })])).toEqual([])
  })

  it('takes refunds off the day of the charge', () => {
    const [d] = aggregateCharges([charge('2026-01-01T10:00:00Z', 'cus_a', 1000, { amount_refunded: 250 })])
    expect(d).toMatchObject({ gross: 10, refunded: 2.5, net: 7.5 })
  })

  it('keeps currencies apart', () => {
    const daily = aggregateCharges([charge('2026-01-01T10:00:00Z', 'cus_a', 1000), charge('2026-01-01T11:00:00Z', 'cus_b', 1000, { currency: 'jpy' })])
    expect(daily).toHaveLength(2)
    expect(daily.find((d) => d.currency === 'jpy')?.gross).toBe(1000)
  })

  it('counts a charge with no customer as a guest', () => {
    const [d] = aggregateCharges([charge('2026-01-01T10:00:00Z', null)])
    expect(d).toMatchObject({ charges: 1, guestCharges: 1, newCustomers: 0, returningCharges: 0 })
  })

  it('sums money without float drift', () => {
    const [d] = aggregateCharges([charge('2026-01-01T10:00:00Z', 'a', 10), charge('2026-01-01T11:00:00Z', 'b', 20)])
    expect(d?.gross).toBe(0.3)
  })

  it('never lets a customer id out', () => {
    const out = JSON.stringify(aggregateCharges([charge('2026-01-01T10:00:00Z', 'cus_SECRET123')]))
    expect(out).not.toContain('SECRET123')
  })
})

describe('aggregateSubscriptions', () => {
  it('scales every interval to a month', () => {
    const { mrr } = aggregateSubscriptions([
      sub('2026-01-01T00:00:00Z', 'active', { unit_amount: 1000, interval: 'month' }),
      sub('2026-01-01T00:00:00Z', 'active', { unit_amount: 12000, interval: 'year' }),
      sub('2026-01-01T00:00:00Z', 'active', { unit_amount: 3000, interval: 'month', count: 3 }),
      sub('2026-01-01T00:00:00Z', 'past_due', { unit_amount: 500, interval: 'month' }, {}, 2),
    ])
    expect(mrr).toEqual([{ currency: 'usd', active: 4, mrr: 40, unpricedItems: 0 }])
  })

  it('leaves out trials, canceled and unpaid subscriptions from MRR', () => {
    const { mrr } = aggregateSubscriptions([
      sub('2026-01-01T00:00:00Z', 'trialing', { unit_amount: 1000, interval: 'month' }),
      sub('2026-01-01T00:00:00Z', 'canceled', { unit_amount: 1000, interval: 'month' }, { ended_at: t('2026-02-01T00:00:00Z') }),
      sub('2026-01-01T00:00:00Z', 'unpaid', { unit_amount: 1000, interval: 'month' }),
    ])
    expect(mrr).toEqual([])
  })

  it('counts tiered prices as unpriced instead of guessing', () => {
    const { mrr } = aggregateSubscriptions([sub('2026-01-01T00:00:00Z', 'active', { unit_amount: null, interval: 'month' })])
    expect(mrr).toEqual([{ currency: 'usd', active: 1, mrr: 0, unpricedItems: 1 }])
  })

  it('records starts and ends on their own days, skipping checkouts that never completed', () => {
    const { daily } = aggregateSubscriptions([
      sub('2026-01-01T00:00:00Z', 'canceled', { unit_amount: 1000, interval: 'month' }, { ended_at: t('2026-03-01T00:00:00Z') }),
      sub('2026-01-01T00:00:00Z', 'incomplete_expired', { unit_amount: 1000, interval: 'month' }, { ended_at: t('2026-01-02T00:00:00Z') }),
    ])
    expect(daily).toContainEqual({ date: '2026-01-01', currency: 'usd', started: 1, ended: 0 })
    expect(daily).toContainEqual({ date: '2026-03-01', currency: 'usd', started: 0, ended: 1 })
    expect(daily).toHaveLength(2)
  })
})

describe('Stripe client', () => {
  it('follows has_more with the last id', async () => {
    const calls: string[] = []
    const pages = [
      { data: [{ id: 'ch_1' }, { id: 'ch_2' }], has_more: true },
      { data: [{ id: 'ch_3' }], has_more: false },
    ]
    const fake = async (url: string) => {
      calls.push(url)
      return pages[calls.length - 1]
    }
    const out = await new Stripe('rk_test_x', fake as any).all('/charges', {}, 'x')
    expect(out.map((c) => c.id)).toEqual(['ch_1', 'ch_2', 'ch_3'])
    expect(calls[1]).toContain('starting_after=ch_2')
  })

  it('treats a 403 on subscriptions as no access, not a failure', async () => {
    const fake = async () => {
      throw new HttpError('x', 403, '')
    }
    expect(await new Stripe('rk_test_x', fake as any).subscriptions()).toBeNull()
  })
})

describe('Stripe sync', () => {
  let db: Db
  beforeEach(async () => {
    db = wrapPglite(await PGlite.create())
    await migrate(db)
  })
  afterEach(async () => db.close())

  const charges = [charge('2026-01-01T10:00:00Z', 'cus_a', 2000), charge('2026-01-05T10:00:00Z', 'cus_a', 1000, { amount_refunded: 1000 })]

  it('leaves identical totals when run twice', async () => {
    await writeStripe(db, charges, null)
    const first = await db.query('SELECT * FROM fact_stripe_daily ORDER BY date')
    await writeStripe(db, charges, null)
    expect((await db.query('SELECT * FROM fact_stripe_daily ORDER BY date')).map(({ source_synced_at: _, ...r }) => r)).toEqual(first.map(({ source_synced_at: _, ...r }) => r))
  })

  it('keeps one MRR row per day and currency, so history builds up', async () => {
    const subs = [sub('2026-01-01T00:00:00Z', 'active', { unit_amount: 1000, interval: 'month' })]
    await writeStripe(db, charges, subs, '2026-11-01')
    await writeStripe(db, charges, subs, '2026-11-01')
    await writeStripe(db, charges, subs, '2026-11-02')
    expect(await db.query(`SELECT date::text AS date, mrr::text AS mrr FROM fact_stripe_mrr ORDER BY date`)).toEqual([
      { date: '2026-11-01', mrr: '10' },
      { date: '2026-11-02', mrr: '10' },
    ])
  })

  it('warns, but succeeds, when the key cannot read subscriptions', async () => {
    const r = await syncStripe(db, { charges: async () => charges, subscriptions: async () => null })
    expect(r).toMatchObject({ source: 'stripe', status: 'warning' })
    expect(r.detail).toMatch(/subscriptions/)
  })

  it('feeds the verified metrics', async () => {
    const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString()
    await writeStripe(db, [
      charge(recent(10), 'cus_a', 5000),
      charge(recent(5), 'cus_a', 5000, { amount_refunded: 1000 }),
      charge(recent(4), 'cus_b', 5000, { status: 'failed' }),
      charge(recent(3), 'cus_c', 99999, { currency: 'jpy' }),
    ], [sub('2026-01-01T00:00:00Z', 'active', { unit_amount: 2500, interval: 'month' })])
    expect((await runMetric(db, 'stripe_net_revenue', 30)).value).toBe(90)
    expect((await runMetric(db, 'stripe_repeat_charge_share', 30)).value).toBeCloseTo(33.3333, 3)
    expect((await runMetric(db, 'stripe_failed_payment_rate', 30)).value).toBe(25)
    expect((await runMetric(db, 'stripe_mrr', 30)).value).toBe(25)
  })

  it('says Stripe is missing before anything has synced', async () => {
    expect(await runMetric(db, 'stripe_net_revenue', 30)).toMatchObject({ status: 'no_data', missing: ['stripe'] })
  })
})
