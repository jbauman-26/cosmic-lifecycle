import { describe, expect, it } from 'vitest'
import { aggregateOrders, type RawOrder } from '../src/sources/shopify.js'

const order = (processedAt: string, customer: string | null, amount = '100.00', discount = '0.00', cancelledAt: string | null = null): RawOrder => ({
  processedAt, cancelledAt, customer: customer ? { id: customer } : null,
  currentTotalPriceSet: { shopMoney: { amount } }, totalDiscountsSet: { shopMoney: { amount: discount } },
})

describe('aggregateOrders', () => {
  it('splits new and returning orders by first purchase', () => {
    const { daily } = aggregateOrders([order('2026-01-05T10:00:00Z', 'a'), order('2026-02-05T10:00:00Z', 'a'), order('2026-02-05T11:00:00Z', 'b')])
    expect(daily.find((d) => d.date === '2026-01-05')).toMatchObject({ orders: 1, newOrders: 1, returningOrders: 0 })
    expect(daily.find((d) => d.date === '2026-02-05')).toMatchObject({ orders: 2, newOrders: 1, returningOrders: 1 })
  })

  it('leaves out cancelled orders', () => {
    const { daily } = aggregateOrders([order('2026-01-05T10:00:00Z', 'a', '50.00', '0.00', '2026-01-06T10:00:00Z')])
    expect(daily).toEqual([])
  })

  it('counts a guest order without inventing a customer', () => {
    const { daily, cohorts } = aggregateOrders([order('2026-01-05T10:00:00Z', null)])
    expect(daily[0]).toMatchObject({ orders: 1, newOrders: 0, returningOrders: 0 })
    expect(cohorts).toEqual([])
  })

  it('tracks cohorts by months since first purchase, across a year end', () => {
    const { cohorts } = aggregateOrders([order('2025-12-20T10:00:00Z', 'a'), order('2026-02-01T10:00:00Z', 'a', '30.00')])
    expect(cohorts).toContainEqual({ cohortMonth: '2025-12', monthsSince: 0, customers: 1, orders: 1, revenue: 100 })
    expect(cohorts).toContainEqual({ cohortMonth: '2025-12', monthsSince: 2, customers: 1, orders: 1, revenue: 30 })
  })

  it('handles orders given out of date order', () => {
    const { cohorts } = aggregateOrders([order('2026-03-01T10:00:00Z', 'a'), order('2026-01-01T10:00:00Z', 'a')])
    expect(cohorts.map((c) => c.cohortMonth)).toEqual(['2026-01', '2026-01'])
  })

  it('sums money without float drift', () => {
    const { daily } = aggregateOrders([order('2026-01-05T10:00:00Z', 'a', '0.10'), order('2026-01-05T11:00:00Z', 'b', '0.20')])
    expect(daily[0]?.net).toBe(0.3)
  })

  it('never lets a customer id out', () => {
    const out = JSON.stringify(aggregateOrders([order('2026-01-05T10:00:00Z', 'gid://shopify/Customer/123')]))
    expect(out).not.toContain('123')
    expect(out).not.toContain('Customer')
  })
})
