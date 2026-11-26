import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { exportProgress, syncShopifyBulk, writeShopify } from '../src/sync.js'
import { runChecks, tolerances } from '../src/reconcile.js'
import { aggregateOrders, fetchOrders, throttleWait, type RawOrder } from '../src/sources/shopify.js'
import { BULK_ORDERS_QUERY, CompactOrders, readExport, shopifyGql, type Gql } from '../src/sources/shopify-bulk.js'

// Replies built from Shopify's bulk operation docs, not recorded from a live store. See replies.json _source.
const dir = join(__dirname, 'fixtures', 'shopify-bulk')
const R = JSON.parse(readFileSync(join(dir, 'replies.json'), 'utf8'))
const JSONL = readFileSync(join(dir, 'orders.jsonl'), 'utf8')
const fixtureOrders: RawOrder[] = JSONL.trim().split('\n').map((l) => JSON.parse(l))

// A stand-in for the GraphQL endpoint: replies are handed out in order, and every call is recorded.
function fakeGql(replies: any[]) {
  const calls: { query: string; variables?: Record<string, unknown> }[] = []
  const gql: Gql = async (query, variables) => {
    calls.push({ query, variables })
    const r = replies.shift()
    if (!r) throw new Error('no reply left')
    return r.data
  }
  return { gql, calls, starts: () => calls.filter((c) => c.query.includes('bulkOperationRunQuery')).length }
}

// The export file, served in small chunks so a line is split across reads.
function fileResponse(text: string, chunk = 7, failAfter = Infinity) {
  const bytes = new TextEncoder().encode(text)
  let at = 0
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= failAfter) return c.error(new Error('connection reset'))
      if (at >= bytes.length) return c.close()
      c.enqueue(bytes.slice(at, at + chunk))
      at += chunk
    },
  })
  return new Response(body, { status: 200 })
}

let db: Db
beforeEach(async () => {
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(async () => {
  await db.close()
  vi.unstubAllGlobals()
})

const noSleep = async () => {}

describe('the compact order buffer', () => {
  it('gives the same totals as aggregateOrders, to the cent, on a messy random history', () => {
    let seed = 7
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    const orders: RawOrder[] = []
    for (let i = 0; i < 20000; i++) {
      // Whole minutes, so many orders share a timestamp and the tie order is tested too.
      const t = Date.parse('2023-12-20T00:00:00Z') + Math.floor(rand() * 1100 * 1440) * 60000
      const at = new Date(t).toISOString().replace('.000Z', 'Z')
      const r = rand()
      orders.push({
        processedAt: at,
        cancelledAt: r < 0.03 ? at : null,
        customer: r < 0.15 ? null : { id: `gid://shopify/Customer/${Math.floor(rand() * 3000)}` },
        currentTotalPriceSet: { shopMoney: { amount: (Math.floor(rand() * 30000) / 100).toFixed(2) } },
        totalDiscountsSet: { shopMoney: { amount: rand() < 0.3 ? (Math.floor(rand() * 2000) / 100).toFixed(2) : '0.0' } },
      })
    }
    const buf = new CompactOrders()
    for (const o of orders) buf.add(o)
    expect(buf.pulled).toBe(20000)
    expect(buf.aggregate()).toEqual(aggregateOrders(orders))
  })

  it('never lets a customer id out', () => {
    const buf = new CompactOrders()
    for (const o of fixtureOrders) buf.add(o)
    const out = JSON.stringify(buf.aggregate())
    expect(out).not.toContain('9001')
    expect(out).not.toContain('Customer')
  })
})

describe('reading the export file', () => {
  it('reads every line when lines are split across chunks and the last has no newline', async () => {
    const buf = new CompactOrders()
    await readExport('https://files.example/x.jsonl', buf, (async () => fileResponse(JSONL.trimEnd(), 5)) as typeof fetch)
    expect(buf.pulled).toBe(6)
    expect(buf.aggregate()).toEqual(aggregateOrders(fixtureOrders))
  })

  it('sends no Shopify token to the file host', async () => {
    const f = vi.fn(async (..._a: unknown[]) => fileResponse(JSONL))
    await readExport('https://files.example/x.jsonl', new CompactOrders(), f as unknown as typeof fetch)
    expect(f.mock.calls[0]).toEqual(['https://files.example/x.jsonl'])
  })

  it('asks for no personal field', () => {
    expect(BULK_ORDERS_QUERY).not.toMatch(/email|phone|firstName|lastName|address|displayName|name\b/i)
  })
})

describe('syncShopifyBulk', () => {
  const download = (async () => fileResponse(JSONL)) as unknown as typeof fetch

  it('starts an export, leaves old totals alone while it runs, then reads it on the next sync', async () => {
    await writeShopify(db, [fixtureOrders[0]!])
    const before = await db.query('SELECT * FROM fact_orders_daily')
    const a = fakeGql([R.run_created, R.poll_running, R.poll_running])
    const first = await syncShopifyBulk(db, { gql: a.gql, waitMs: 1000, sleep: noSleep, download })
    expect(first).toMatchObject({ status: 'warning', code: 'export_running', rows: 0 })
    expect(await db.query('SELECT * FROM fact_orders_daily')).toEqual(before)
    expect(await db.query(`SELECT op_id, status, consumed_at FROM meta_shopify_bulk`)).toEqual([{ op_id: 'gid://shopify/BulkOperation/1000000001', status: 'RUNNING', consumed_at: null }])

    const b = fakeGql([R.poll_completed])
    const counted: (string | null)[] = []
    const second = await syncShopifyBulk(db, { gql: b.gql, waitMs: 1000, sleep: noSleep, download, reportedCount: async (x) => (counted.push(x), 5), today: '2026-11-24' })
    expect(second).toMatchObject({ status: 'ok' })
    expect(b.starts()).toBe(0)
    expect(counted).toEqual(['2026-11-20T09:00:00Z'])

    // The same daily rows as the paged path would write for the same orders.
    const viaBulk = await db.query('SELECT date::text, orders, net_revenue::text, new_orders, returning_orders, guest_orders FROM fact_orders_daily ORDER BY date')
    await writeShopify(db, fixtureOrders)
    expect(await db.query('SELECT date::text, orders, net_revenue::text, new_orders, returning_orders, guest_orders FROM fact_orders_daily ORDER BY date')).toEqual(viaBulk)

    // Both sides of the completeness check stop when the export started: 5 orders, not the 6th made during it.
    const totals = await db.query(`SELECT metric, value::int AS v FROM meta_source_total WHERE source = 'shopify' ORDER BY metric`)
    expect(totals).toEqual([{ metric: 'orders_kept', v: 5 }, { metric: 'orders_pulled', v: 5 }, { metric: 'orders_reported', v: 5 }])
    const checks = await runChecks(db, tolerances())
    expect(checks.find((c) => c.name === 'orders_complete')?.status).toBe('pass')
    expect((await db.query('SELECT consumed_at IS NOT NULL AS done FROM meta_shopify_bulk'))[0]).toEqual({ done: true })
  })

  it('reports how far the export has got, with counts and times only', async () => {
    expect(await exportProgress(db)).toBeNull()
    const a = fakeGql([R.run_created, R.poll_running])
    const first = await syncShopifyBulk(db, { gql: a.gql, waitMs: 0, sleep: noSleep, download, expected: 3_000_000 })
    expect(first.progress).toMatchObject({ state: 'running', ordersExpected: 3_000_000, code: null })
    expect(first.progress!.ordersExported).toBe(R.poll_running.data.bulkOperation.objectCount ? Number(R.poll_running.data.bulkOperation.objectCount) : 0)
    expect(Object.keys(first.progress!).sort()).toEqual(['checkedAt', 'code', 'ordersExpected', 'ordersExported', 'startedAt', 'state'])
    const b = fakeGql([R.poll_completed])
    await syncShopifyBulk(db, { gql: b.gql, waitMs: 1000, sleep: noSleep, download, today: '2026-11-24' })
    expect(await exportProgress(db)).toMatchObject({ state: 'done', code: null })
  })

  it('reports a failed export and an expired file as failed, not done', async () => {
    const a = fakeGql([R.run_created, R.poll_failed])
    await syncShopifyBulk(db, { gql: a.gql, waitMs: 1000, sleep: noSleep, download })
    expect((await exportProgress(db))?.state).toBe('failed')
    await db.query('DELETE FROM meta_shopify_bulk')
    const gone = (async () => new Response('AccessDenied', { status: 403 })) as unknown as typeof fetch
    const b = fakeGql([R.run_created, R.poll_completed])
    await syncShopifyBulk(db, { gql: b.gql, waitMs: 1000, sleep: noSleep, download: gone })
    expect(await exportProgress(db)).toMatchObject({ state: 'failed', code: 'file_expired' })
  })

  it('does not count a run that only waited as fresh', async () => {
    const a = fakeGql([R.run_created, R.poll_running, R.poll_running])
    await syncShopifyBulk(db, { gql: a.gql, waitMs: 0, sleep: noSleep, download })
    const fresh = (await runChecks(db, tolerances())).find((c) => c.name === 'freshness')
    expect(fresh?.status).toBe('skipped')
  })

  it('reads the same file again after a download cut off half way, without a new export', async () => {
    const cut = (async () => fileResponse(JSONL, 64, 300)) as unknown as typeof fetch
    const a = fakeGql([R.run_created, R.poll_completed])
    const first = await syncShopifyBulk(db, { gql: a.gql, waitMs: 1000, sleep: noSleep, download: cut })
    expect(first.status).toBe('failed')
    expect(await db.query('SELECT count(*)::int AS n FROM fact_orders_daily')).toEqual([{ n: 0 }])
    const b = fakeGql([R.poll_completed])
    const second = await syncShopifyBulk(db, { gql: b.gql, waitMs: 1000, sleep: noSleep, download, today: '2026-11-24' })
    expect(second.status).toBe('ok')
    expect(b.starts()).toBe(0)
  })

  it('starts a new export when the file has expired', async () => {
    const gone = (async () => new Response('AccessDenied', { status: 403 })) as unknown as typeof fetch
    const a = fakeGql([R.run_created, R.poll_completed])
    expect(await syncShopifyBulk(db, { gql: a.gql, waitMs: 1000, sleep: noSleep, download: gone })).toMatchObject({ status: 'failed', code: 'export_expired' })
    const b = fakeGql([R.run_created_2, R.poll_running])
    await syncShopifyBulk(db, { gql: b.gql, waitMs: 0, sleep: noSleep, download })
    expect(b.starts()).toBe(1)
  })

  it('starts a new export after Shopify fails one', async () => {
    const a = fakeGql([R.run_created, R.poll_failed])
    expect(await syncShopifyBulk(db, { gql: a.gql, waitMs: 1000, sleep: noSleep, download })).toMatchObject({ status: 'failed', code: 'export_failed' })
    const b = fakeGql([R.run_created_2, R.poll_running])
    await syncShopifyBulk(db, { gql: b.gql, waitMs: 0, sleep: noSleep, download })
    expect(b.starts()).toBe(1)
  })

  it('keeps the old totals when the file is shorter than Shopify says', async () => {
    await writeShopify(db, [fixtureOrders[0]!])
    const short = (async () => fileResponse(JSONL.split('\n').slice(0, 3).join('\n'))) as unknown as typeof fetch
    const a = fakeGql([R.run_created, R.poll_completed])
    expect(await syncShopifyBulk(db, { gql: a.gql, waitMs: 1000, sleep: noSleep, download: short })).toMatchObject({ status: 'failed', code: 'export_incomplete' })
    expect(await db.query('SELECT sum(orders)::int AS n FROM fact_orders_daily')).toEqual([{ n: 1 }])
  })

  it('says so when Shopify returned only the last 60 days', async () => {
    const recent = JSONL.trim().split('\n').slice(4).join('\n')
    const done = structuredClone(R.poll_completed)
    done.data.bulkOperation.objectCount = '2'
    const a = fakeGql([R.run_created, done])
    const r = await syncShopifyBulk(db, { gql: a.gql, waitMs: 1000, sleep: noSleep, download: (async () => fileResponse(recent)) as unknown as typeof fetch, today: '2026-11-24' })
    expect(r.status).toBe('warning')
    expect(r.detail).toMatch(/read_all_orders/)
  })

  it('says another export is running instead of a vague error', async () => {
    const a = fakeGql([R.run_busy])
    expect(await syncShopifyBulk(db, { gql: a.gql, waitMs: 0, sleep: noSleep, download })).toMatchObject({ status: 'failed', code: 'export_busy' })
  })
})

describe('Shopify GraphQL calls', () => {
  it('waits out a THROTTLED page and tries it again', async () => {
    const page = { data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: fixtureOrders.slice(0, 2) } } }
    const replies = [R.throttled, page]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200 })))
    const waits: number[] = []
    const out = await fetchOrders('x.myshopify.com', 'tok', { wait: async (ms) => void waits.push(ms) })
    expect(out).toHaveLength(2)
    // 500 points short at 1,000 a second: half a second, plus a margin, and never under a second.
    expect(waits).toEqual([throttleWait(R.throttled, 0)])
    expect(waits[0]).toBe(1000)
  })

  it('gives up on THROTTLED after the retries and says it is rate limited', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(R.throttled), { status: 200 })))
    await expect(fetchOrders('x.myshopify.com', 'tok', { wait: noSleep, retries: 2 })).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('sends the token only to the store, and maps a 403 to the scope message', async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => new Response('{"errors":"[API] This action requires merchant approval for read_all_orders scope."}', { status: 403 }))
    vi.stubGlobal('fetch', f)
    await expect(shopifyGql('x.myshopify.com', 'tok')('{ shop { id } }')).rejects.toMatchObject({ code: 'scope_denied' })
    expect(f.mock.calls[0]![0]).toBe('https://x.myshopify.com/admin/api/2026-10/graphql.json')
  })
})
