import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { syncShopify, syncShopifyBulk, syncShopifyChanges } from '../src/sync.js'
import { aggregateOrders, type RawOrder } from '../src/sources/shopify.js'
import { changedSince, keyer, newCustomerKey, plan, readSyncState, recomputeAll } from '../src/shopify-state.js'
import { runChecks } from '../src/reconcile.js'
import { runQuery } from '../src/query.js'
import type { Gql } from '../src/sources/shopify-bulk.js'

// Hand-made orders shaped like Shopify's Order object. Not recorded from a store. See the file's _source.
const FIXTURE: RawOrder[] = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'shopify-incremental', 'orders.json'), 'utf8')).orders
// A test key, made up for this file. Real keys are random per store.
const KEY = 'c0ffee'.repeat(10) + 'c0ff'
const K = keyer(KEY)

let db: Db
beforeEach(async () => {
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(async () => {
  await db.close()
})

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const days = async () => (await db.query(`SELECT date::text AS date, orders::int, net_revenue::float8 AS net, gross_revenue::float8 AS gross, discounts::float8 AS discounts, new_orders::int AS new, returning_orders::int AS ret, guest_orders::int AS guest, source_synced_at FROM fact_orders_daily ORDER BY date`))
const cohorts = async () => (await db.query(`SELECT cohort_month, months_since, customers::int, orders::int, revenue::float8 AS revenue FROM fact_cohort_monthly ORDER BY cohort_month, months_since`))
// What a full pull of the same history would write, in the same shape.
function expected(orders: RawOrder[]) {
  const a = aggregateOrders(orders)
  return {
    days: a.daily.map((d) => ({ date: d.date, orders: d.orders, net: d.net, gross: d.gross, discounts: d.discounts, new: d.newOrders, ret: d.returningOrders, guest: d.guestOrders })).sort((x, y) => x.date.localeCompare(y.date)),
    cohorts: a.cohorts.map((c) => ({ cohort_month: c.cohortMonth, months_since: c.monthsSince, customers: c.customers, orders: c.orders, revenue: c.revenue })).sort((x, y) => x.cohort_month.localeCompare(y.cohort_month) || x.months_since - y.months_since),
  }
}
const noTime = (rows: Record<string, unknown>[]) => rows.map(({ source_synced_at, ...r }) => r)
async function matchesFull(orders: RawOrder[]) {
  const e = expected(orders)
  expect(noTime(await days())).toEqual(e.days)
  expect(await cohorts()).toEqual(e.cohorts)
}

const fullSync = (orders: RawOrder[], today = '2025-09-01') => syncShopify(db, async () => clone(orders), async () => orders.length, { keyer: K, today })
const changes = (changed: RawOrder[], total: number, asked: string[] = []) => syncShopifyChanges(db, {
  keyer: K,
  changed: async (since) => (asked.push(since), clone(changed)),
  reportedCount: async () => total,
})

describe('incremental Shopify sync', () => {
  it('edits an old order: only that day and its cohort change, and every total equals a full pull', async () => {
    await fullSync(FIXTURE)
    await matchesFull(FIXTURE)
    const before = await days()

    // A partial refund on 2025-02-03, made today.
    const edited = clone(FIXTURE)
    const o = edited.find((x) => x.id === 'gid://shopify/Order/5003')!
    o.currentTotalPriceSet.shopMoney.amount = '10.00'
    o.updatedAt = '2025-09-02T10:00:00Z'
    const r = await changes([o], edited.length)
    expect(r).toMatchObject({ status: 'ok', mode: 'incremental' })
    expect(r.detail).toBe('1 changed order; rebuilt 2 days and 1 cohort month.')

    const after = await days()
    const changed = after.filter((d, i) => JSON.stringify(d) !== JSON.stringify(before[i]))
    // The order's day, and the day of its customer's first order (rebuilt, but its numbers did not move).
    expect(changed.map((d) => d.date)).toEqual(['2025-01-10', '2025-02-03'])
    expect(noTime([after.find((d) => d.date === '2025-01-10')!])).toEqual(noTime([before.find((d) => d.date === '2025-01-10')!]))
    expect(after.find((d) => d.date === '2025-02-03')).toMatchObject({ orders: 2, net: 30, new: 0, ret: 1, guest: 1 })
    // Every other day is the same row it was, down to when it was written.
    for (const d of before.filter((x) => !['2025-01-10', '2025-02-03'].includes(String(x.date)))) expect(after).toContainEqual(d)
    await matchesFull(edited)
  })

  it('keeps new against returning right when a first order is cancelled, a customer comes back, and a guest buys', async () => {
    await fullSync(FIXTURE)
    const edited = clone(FIXTURE)
    // Customer 902's first order is cancelled, so their 2025-03-01 order becomes their first: new, in a new cohort.
    const first = edited.find((x) => x.id === 'gid://shopify/Order/5002')!
    first.cancelledAt = '2025-09-02T08:00:00Z'
    first.updatedAt = '2025-09-02T08:00:00Z'
    // Customer 901 orders again, and a guest orders too.
    const back: RawOrder = { ...clone(FIXTURE[0]!), id: 'gid://shopify/Order/5013', processedAt: '2025-09-02T09:00:00Z', createdAt: '2025-09-02T09:00:00Z', updatedAt: '2025-09-02T09:00:00Z' }
    const guest: RawOrder = { ...clone(FIXTURE[3]!), id: 'gid://shopify/Order/5014', processedAt: '2025-09-02T09:30:00Z', createdAt: '2025-09-02T09:30:00Z', updatedAt: '2025-09-02T09:30:00Z' }
    edited.push(back, guest)
    await changes([first, back, guest], edited.length)

    const d = await days()
    expect(d.find((x) => x.date === '2025-01-15')).toBeUndefined()
    expect(d.find((x) => x.date === '2025-03-01')).toMatchObject({ orders: 2, new: 2, ret: 0 })
    expect(d.find((x) => x.date === '2025-09-02')).toMatchObject({ orders: 2, new: 0, ret: 1, guest: 1 })
    expect((await cohorts()).filter((c) => c.cohort_month === '2025-03')).toContainEqual({ cohort_month: '2025-03', months_since: 0, customers: 2, orders: 2, revenue: 120 })
    await matchesFull(edited)
    // The completeness check still passes: every order the store has is in the state, cancelled ones too.
    expect((await runChecks(db)).find((c) => c.name === 'orders_complete')).toMatchObject({ status: 'pass' })
  })

  it('asks from the cursor minus 3 days, moves the cursor to the latest change, and changes nothing when nothing changed', async () => {
    await fullSync(FIXTURE)
    const cursor = (await readSyncState(db))!.cursor!
    const asked: string[] = []
    const before = await days()
    expect(await changes([], FIXTURE.length, asked)).toMatchObject({ status: 'ok', rows: 0 })
    expect(asked).toEqual([changedSince(cursor, 3)])
    expect(Date.parse(cursor) - Date.parse(asked[0]!)).toBe(3 * 86400000)
    expect(await days()).toEqual(before)

    const later = { ...clone(FIXTURE[6]!), updatedAt: '2099-01-02T03:04:05Z' }
    await changes([later], FIXTURE.length)
    expect((await readSyncState(db))!.cursor).toBe('2099-01-02T03:04:05.000Z')
    // An order seen again with an older change never moves the cursor back.
    await changes([{ ...later, updatedAt: '2098-01-01T00:00:00Z' }], FIXTURE.length)
    expect((await readSyncState(db))!.cursor).toBe('2099-01-02T03:04:05.000Z')
  })

  it('takes the latest version of an order Shopify hands back twice', async () => {
    await fullSync(FIXTURE)
    const a = { ...clone(FIXTURE[4]!), updatedAt: '2025-09-02T01:00:00Z' }
    const b = { ...clone(a), updatedAt: '2025-09-02T02:00:00Z' }
    b.currentTotalPriceSet.shopMoney.amount = '70.00'
    await changes([b, a], FIXTURE.length)
    const edited = clone(FIXTURE)
    edited[4]!.currentTotalPriceSet.shopMoney.amount = '70.00'
    await matchesFull(edited)
  })

  it('adds up to a full pull on a messy random history of 5,000 orders after 300 random edits', async () => {
    let seed = 11
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    const at = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z')
    const history: RawOrder[] = []
    for (let i = 0; i < 5000; i++) {
      // Whole hours, so customers often have two orders at the same moment and the tie rule is tested too.
      const t = Date.parse('2024-01-01T00:00:00Z') + Math.floor(rand() * 600 * 24) * 3600000
      const r = rand()
      history.push({
        id: `gid://shopify/Order/${i + 1}`, createdAt: at(t), updatedAt: at(t), processedAt: at(t), cancelledAt: r < 0.03 ? at(t) : null,
        customer: r < 0.15 ? null : { id: `gid://shopify/Customer/${Math.floor(rand() * 700)}` },
        currentTotalPriceSet: { shopMoney: { amount: (Math.floor(rand() * 30000) / 100).toFixed(2) } },
        totalDiscountsSet: { shopMoney: { amount: rand() < 0.3 ? (Math.floor(rand() * 2000) / 100).toFixed(2) : '0.00' } },
      })
    }
    await fullSync(history, '2025-09-01')
    await matchesFull(history)
    const edited = clone(history)
    const touched: RawOrder[] = []
    for (let n = 0; n < 300; n++) {
      const o = edited[Math.floor(rand() * edited.length)]!
      const kind = rand()
      if (kind < 0.3) o.cancelledAt = o.cancelledAt ? null : '2025-09-02T00:00:00Z'
      else if (kind < 0.6) o.currentTotalPriceSet.shopMoney.amount = (Math.floor(rand() * 30000) / 100).toFixed(2)
      else if (kind < 0.8) o.customer = rand() < 0.2 ? null : { id: `gid://shopify/Customer/${Math.floor(rand() * 700)}` }
      else o.processedAt = at(Date.parse('2024-01-01T00:00:00Z') + Math.floor(rand() * 600 * 24) * 3600000)
      o.updatedAt = '2025-09-02T00:00:00Z'
      touched.push(clone(o))
    }
    await changes(touched, edited.length)
    await matchesFull(edited)
    // And the SQL that rebuilds days from the stored orders gives the same answer for the whole history.
    await db.transaction((tx) => recomputeAll(tx, new Date().toISOString()))
    await matchesFull(edited)
  })
})

describe('when a full pull runs instead', () => {
  const state = { cursor: '2025-09-01T00:00:00.000Z', lastFullAt: '2025-09-01T00:00:00.000Z', keyCheck: K.check, windowLimited: false }
  const now = Date.parse('2025-09-03T00:00:00Z')
  it('runs incremental only with the same key, a recent full pull, and a history older than 60 days', () => {
    expect(plan(state, K, { fullEveryDays: 7, now })).toEqual({ mode: 'incremental', reason: 'changed_orders' })
    expect(plan(null, K, { fullEveryDays: 7, now })).toMatchObject({ mode: 'full', reason: 'first' })
    expect(plan(state, null, { fullEveryDays: 7, now })).toMatchObject({ mode: 'full', reason: 'no_key' })
    expect(plan(state, keyer(newCustomerKey()), { fullEveryDays: 7, now })).toMatchObject({ mode: 'full', reason: 'key_changed' })
    expect(plan(state, K, { fullEveryDays: 7, now: now + 7 * 86400000 })).toMatchObject({ mode: 'full', reason: 'weekly_check' })
    expect(plan({ ...state, windowLimited: true }, K, { fullEveryDays: 7, now })).toMatchObject({ mode: 'full', reason: 'sixty_days' })
    expect(plan(state, K, { fullEveryDays: 7, now, force: true })).toMatchObject({ mode: 'full', reason: 'asked' })
  })

  it('marks a history that starts within 60 days, so it keeps syncing in full', async () => {
    await fullSync(FIXTURE.slice(-1), '2025-09-01')
    expect((await readSyncState(db))!.windowLimited).toBe(true)
    await fullSync(FIXTURE, '2025-09-01')
    expect((await readSyncState(db))!.windowLimited).toBe(false)
  })

  it('reports on the weekly check how many days it corrected', async () => {
    await fullSync(FIXTURE)
    // A deletion in Shopify is invisible to a search by updated_at. The full pull finds it.
    const r = await fullSync(FIXTURE.filter((o) => o.id !== 'gid://shopify/Order/5010'))
    expect(r.detail).toBe('The weekly full check corrected 1 day the daily syncs had differently.')
  })

  it('clears the state when a sync runs without a key, so a later keyed sync starts with a full pull', async () => {
    await fullSync(FIXTURE)
    await syncShopify(db, async () => clone(FIXTURE), async () => FIXTURE.length)
    for (const t of ['shopify_order_state', 'shopify_customer_first', 'meta_shopify_sync']) expect(await db.query(`SELECT count(*)::int AS n FROM ${t}`)).toEqual([{ n: 0 }])
    expect(await readSyncState(db)).toBeNull()
  })

  it('refuses a key that is not one', () => {
    expect(() => keyer('not a key')).toThrow(/64 hex characters/)
  })

  it('builds the state from a bulk export, and while a weekly check export builds, keeps totals fresh from changed orders', async () => {
    const jsonl = FIXTURE.map((o) => JSON.stringify(o)).join('\n') + '\n'
    const op = (status: string, extra = {}) => ({ data: { bulkOperation: { id: 'gid://shopify/BulkOperation/1', status, errorCode: null, objectCount: String(FIXTURE.length), url: null, partialDataUrl: null, createdAt: '2025-09-01T00:00:00Z', ...extra } } })
    const replies: any[] = [{ data: { bulkOperationRunQuery: { bulkOperation: { id: 'gid://shopify/BulkOperation/1', status: 'CREATED' }, userErrors: [] } } }, op('COMPLETED', { url: 'https://storage.example/f.jsonl' })]
    const gql: Gql = async () => replies.shift().data
    const download = (async () => new Response(jsonl)) as unknown as typeof fetch
    const r = await syncShopifyBulk(db, { gql, download, waitMs: 0, keyer: K, sleep: async () => {}, today: '2025-09-01', reportedCount: async () => FIXTURE.length })
    expect(r).toMatchObject({ status: 'ok', mode: 'full' })
    expect(await db.query(`SELECT count(*)::int AS n FROM shopify_order_state`)).toEqual([{ n: FIXTURE.length }])
    expect((await readSyncState(db))!.cursor).toBe('2025-09-01T00:00:00.000Z')

    // The next week: a new export is still building, and an edited order arrives meanwhile.
    const edited = clone(FIXTURE)
    edited[2]!.currentTotalPriceSet.shopMoney.amount = '5.00'
    edited[2]!.updatedAt = '2025-09-08T00:00:00Z'
    replies.push({ data: { bulkOperationRunQuery: { bulkOperation: { id: 'gid://shopify/BulkOperation/2', status: 'CREATED' }, userErrors: [] } } }, { data: { bulkOperation: { id: 'gid://shopify/BulkOperation/2', status: 'RUNNING', objectCount: '3' } } })
    const r2 = await syncShopifyBulk(db, { gql, download, waitMs: 0, keyer: K, sleep: async () => {}, incremental: { keyer: K, changed: async () => [clone(edited[2]!)], reportedCount: async () => FIXTURE.length } })
    expect(r2).toMatchObject({ status: 'ok', mode: 'incremental', progress: { state: 'running' } })
    expect(r2.detail).toContain('still building')
    await matchesFull(edited)
  })
})

describe('scrambled ids stay out of answers', () => {
  it('refuses a query that would return a scrambled id, and allows a count', async () => {
    await fullSync(FIXTURE)
    await expect(runQuery(db, 'SELECT customer_key FROM shopify_customer_first')).rejects.toMatchObject({ code: 'personal_column' })
    await expect(runQuery(db, 'SELECT * FROM shopify_order_state')).rejects.toMatchObject({ code: 'personal_column' })
    expect((await runQuery(db, 'SELECT count(*)::int AS n FROM shopify_customer_first')).rows).toEqual([{ n: 4 }])
  })
})
