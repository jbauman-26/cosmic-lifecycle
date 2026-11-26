import { createHmac, randomBytes } from 'node:crypto'
import type { Tx } from './db.js'
import { CliError } from './errors.js'
import type { RawOrder } from './sources/shopify.js'

// 0.15.0: what an incremental Shopify sync needs to rebuild only the days and cohorts an edited order touches.
//
// An order edited today belongs to a past day, and whether it counted as new or returning depends on that
// customer's first order. So the database keeps, per order, its day, its amounts and a scrambled customer id,
// and per customer, the month of the first order. Nothing else.
//
// The scrambled id is HMAC-SHA256 of Shopify's id with a random key that belongs to this store and is kept
// outside the database: in the macOS keychain, the Cosmic AI app's keychain, or Cosmic Cloud's encrypted
// secrets, and handed to the CLI as LIFECYCLE_SHOPIFY_CUSTOMER_KEY. Without the key the ids cannot be turned
// back into Shopify ids or matched with any other store's. The raw Shopify ids never reach the database, and
// neither does the key. Names, emails, phones and addresses are never asked for.

export const KEY_ENV = 'LIFECYCLE_SHOPIFY_CUSTOMER_KEY'

// A new key: 32 random bytes as hex.
export const newCustomerKey = () => randomBytes(32).toString('hex')

export function checkCustomerKey(key: string) {
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    throw new CliError(`${KEY_ENV} is not a store key. It is 64 hex characters, made by the app or by cosmic sync.`, `Unset ${KEY_ENV} to let cosmic sync make one, or pass the one the app made.`, 'bad_customer_key')
  }
  return key.toLowerCase()
}

export type Keyer = { id: (shopifyId: string) => string; check: string }

// Both ids are Shopify gids (gid://shopify/Order/1, gid://shopify/Customer/1), so one function serves both
// without one kind ever matching the other.
export function keyer(key: string): Keyer {
  const k = Buffer.from(checkCustomerKey(key), 'hex')
  return {
    id: (shopifyId) => createHmac('sha256', k).update(shopifyId).digest('hex'),
    // Tells a later sync whether it holds the same key that made the stored ids. Not the key, and the key
    // cannot be worked out from it.
    check: createHmac('sha256', k).update('cosmic-lifecycle key check').digest('hex'),
  }
}

// One row per order the store has, cancelled ones included, so the count matches Shopify's own.
export type StateRow = { orderKey: string; customerKey: string | null; processedAt: string; processedDay: string; net: number; discounts: number; cancelled: boolean; updatedAt: string | null }

export function stateRow(o: RawOrder, k: Keyer): StateRow {
  if (!o.id) throw new CliError('Shopify sent an order without an id.', 'cosmic sync --full', 'shopify_query')
  return {
    orderKey: k.id(o.id),
    customerKey: o.customer ? k.id(o.customer.id) : null,
    processedAt: o.processedAt,
    processedDay: o.processedAt.slice(0, 10),
    net: Number(o.currentTotalPriceSet.shopMoney.amount),
    discounts: Number(o.totalDiscountsSet.shopMoney.amount),
    cancelled: Boolean(o.cancelledAt),
    updatedAt: o.updatedAt ?? null,
  }
}

// Column buffers for a whole history, so 3 million orders do not become 3 million objects.
// The hashes are kept as bytes; the raw ids are hashed as they arrive and dropped.
export class StateBuffer {
  size = 0
  private okey = new Uint8Array(32 * 1024)
  private cust = new Int32Array(1024)
  private ptime = new Float64Array(1024)
  private pday = new Int32Array(1024)
  private net = new Float64Array(1024)
  private disc = new Float64Array(1024)
  private cancelled = new Uint8Array(1024)
  private utime = new Float64Array(1024)
  private customers: string[] = []
  private customerIndex = new Map<string, number>()
  private days: string[] = []
  private dayIndex = new Map<string, number>()
  constructor(private k: Keyer) {}

  private grow() {
    const n = this.cust.length * 2
    const copy = <T extends Float64Array | Int32Array | Uint8Array>(a: T, b: T) => (b.set(a), b)
    this.okey = copy(this.okey, new Uint8Array(32 * n))
    this.cust = copy(this.cust, new Int32Array(n))
    this.ptime = copy(this.ptime, new Float64Array(n))
    this.pday = copy(this.pday, new Int32Array(n))
    this.net = copy(this.net, new Float64Array(n))
    this.disc = copy(this.disc, new Float64Array(n))
    this.cancelled = copy(this.cancelled, new Uint8Array(n))
    this.utime = copy(this.utime, new Float64Array(n))
  }

  add(o: RawOrder) {
    const r = stateRow(o, this.k)
    if (this.size === this.cust.length) this.grow()
    const i = this.size++
    this.okey.set(Buffer.from(r.orderKey, 'hex'), i * 32)
    let c = -1
    if (r.customerKey) {
      c = this.customerIndex.get(r.customerKey) ?? -1
      if (c === -1) {
        c = this.customers.length
        this.customers.push(r.customerKey)
        this.customerIndex.set(r.customerKey, c)
      }
    }
    let d = this.dayIndex.get(r.processedDay)
    if (d === undefined) {
      d = this.days.length
      this.days.push(r.processedDay)
      this.dayIndex.set(r.processedDay, d)
    }
    this.cust[i] = c
    this.ptime[i] = Date.parse(r.processedAt)
    this.pday[i] = d
    this.net[i] = r.net
    this.disc[i] = r.discounts
    this.cancelled[i] = r.cancelled ? 1 : 0
    this.utime[i] = r.updatedAt ? Date.parse(r.updatedAt) : NaN
  }

  // The latest change seen, so the next sync knows where to start.
  maxUpdated(): string | null {
    let m = -Infinity
    for (let i = 0; i < this.size; i++) if (this.utime[i]! > m) m = this.utime[i]!
    return Number.isFinite(m) ? new Date(m).toISOString() : null
  }

  // Rows for unnest(), a batch at a time.
  *batches(n = 5000): Generator<unknown[]> {
    for (let start = 0; start < this.size; start += n) {
      const end = Math.min(this.size, start + n)
      const cols: [string[], (string | null)[], string[], string[], string[], string[], boolean[], (string | null)[]] = [[], [], [], [], [], [], [], []]
      for (let i = start; i < end; i++) {
        cols[0].push(Buffer.from(this.okey.subarray(i * 32, i * 32 + 32)).toString('hex'))
        cols[1].push(this.cust[i]! >= 0 ? this.customers[this.cust[i]!]! : null)
        cols[2].push(new Date(this.ptime[i]!).toISOString())
        cols[3].push(this.days[this.pday[i]!]!)
        cols[4].push(String(this.net[i]))
        cols[5].push(String(this.disc[i]))
        cols[6].push(this.cancelled[i] === 1)
        cols[7].push(Number.isNaN(this.utime[i]!) ? null : new Date(this.utime[i]!).toISOString())
      }
      yield cols
    }
  }
}

const UPSERT = `INSERT INTO shopify_order_state (order_key, customer_key, processed_at, processed_day, net, discounts, cancelled, updated_at)
  SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::date[], $5::numeric[], $6::numeric[], $7::boolean[], $8::timestamptz[])
  ON CONFLICT (order_key) DO UPDATE SET customer_key = EXCLUDED.customer_key, processed_at = EXCLUDED.processed_at, processed_day = EXCLUDED.processed_day,
    net = EXCLUDED.net, discounts = EXCLUDED.discounts, cancelled = EXCLUDED.cancelled, updated_at = EXCLUDED.updated_at`

// Each customer's first order that was not cancelled. Ties on the same moment go to the lower order key; a tie
// is always the same day and month, so it cannot change a total.
const FIRSTS = (where: string) => `INSERT INTO shopify_customer_first (customer_key, first_order_key, first_day, first_month)
  SELECT DISTINCT ON (customer_key) customer_key, order_key, processed_day, to_char(processed_day, 'YYYY-MM')
  FROM shopify_order_state WHERE NOT cancelled AND customer_key IS NOT NULL ${where}
  ORDER BY customer_key, processed_at, order_key`

// The same rules as aggregateOrders: cancelled orders are left out, a customer's first order is new, later ones
// are returning, and an order with no customer is a guest order. trim_scale keeps 150 as 150, as the full path writes it.
const DAYS = (where: string) => `INSERT INTO fact_orders_daily (date, orders, gross_revenue, net_revenue, discounts, new_orders, returning_orders, guest_orders, source_synced_at)
  SELECT s.processed_day, count(*), trim_scale(sum(s.net + s.discounts)), trim_scale(sum(s.net)), trim_scale(sum(s.discounts)),
    count(*) FILTER (WHERE f.first_order_key = s.order_key),
    count(*) FILTER (WHERE s.customer_key IS NOT NULL AND f.first_order_key IS DISTINCT FROM s.order_key),
    count(*) FILTER (WHERE s.customer_key IS NULL), $1::timestamptz
  FROM shopify_order_state s LEFT JOIN shopify_customer_first f ON f.customer_key = s.customer_key
  WHERE NOT s.cancelled ${where} GROUP BY s.processed_day`

const COHORTS = (where: string) => `INSERT INTO fact_cohort_monthly (cohort_month, months_since, customers, orders, revenue, source_synced_at)
  SELECT f.first_month,
    (extract(year FROM s.processed_day)::int * 12 + extract(month FROM s.processed_day)::int) - (substr(f.first_month, 1, 4)::int * 12 + substr(f.first_month, 6, 2)::int),
    count(DISTINCT s.customer_key), count(*), trim_scale(sum(s.net)), $1::timestamptz
  FROM shopify_order_state s JOIN shopify_customer_first f ON f.customer_key = s.customer_key
  WHERE NOT s.cancelled ${where} GROUP BY 1, 2`

// The whole history, read in full: replaces every stored order and every first order.
export async function replaceState(tx: Tx, buf: StateBuffer) {
  await tx.query('DELETE FROM shopify_order_state')
  await tx.query('DELETE FROM shopify_customer_first')
  for (const cols of buf.batches()) await tx.query(UPSERT, cols)
  await tx.query(FIRSTS(''))
}

// Rebuilds every day and cohort from the stored orders. Used to prove the incremental path adds up to the full one.
export async function recomputeAll(tx: Tx, at: string) {
  await tx.query('DELETE FROM fact_orders_daily')
  await tx.query('DELETE FROM fact_cohort_monthly')
  await tx.query(DAYS(''), [at])
  await tx.query(COHORTS(''), [at])
}

const days = (rows: Record<string, unknown>[], col: string) => rows.map((r) => r[col]).filter((v): v is string => typeof v === 'string')

// Orders that changed: upsert them, then rebuild only what they touch. That is the days they were on before and
// after, the days of their customers' first orders before and after, and those customers' cohort months.
export async function applyChanges(tx: Tx, changed: StateRow[], at: string) {
  // Paging by updated_at can hand the same order back twice if it changes mid-sync. Keep its latest version.
  const latest = new Map<string, StateRow>()
  for (const r of changed) {
    const had = latest.get(r.orderKey)
    if (!had || (r.updatedAt ?? '') >= (had.updatedAt ?? '')) latest.set(r.orderKey, r)
  }
  const rows = [...latest.values()]
  if (!rows.length) return { orders: 0, days: 0, cohorts: 0 }
  const keys = rows.map((r) => r.orderKey)
  const before = await tx.query(`SELECT processed_day::text AS day, customer_key FROM shopify_order_state WHERE order_key = ANY($1::text[])`, [keys])
  const customers = [...new Set([...rows.map((r) => r.customerKey), ...before.map((r) => r.customer_key as string | null)].filter((c): c is string => Boolean(c)))]
  const firstsBefore = await tx.query(`SELECT first_day::text AS day, first_month FROM shopify_customer_first WHERE customer_key = ANY($1::text[])`, [customers])

  const cols = [rows.map((r) => r.orderKey), rows.map((r) => r.customerKey), rows.map((r) => r.processedAt), rows.map((r) => r.processedDay), rows.map((r) => String(r.net)), rows.map((r) => String(r.discounts)), rows.map((r) => r.cancelled), rows.map((r) => r.updatedAt)]
  await tx.query(UPSERT, cols)
  await tx.query(`DELETE FROM shopify_customer_first WHERE customer_key = ANY($1::text[])`, [customers])
  await tx.query(FIRSTS('AND customer_key = ANY($1::text[])'), [customers])
  const firstsAfter = await tx.query(`SELECT first_day::text AS day, first_month FROM shopify_customer_first WHERE customer_key = ANY($1::text[])`, [customers])

  const touchedDays = [...new Set([...rows.map((r) => r.processedDay), ...days(before, 'day'), ...days(firstsBefore, 'day'), ...days(firstsAfter, 'day')])].sort()
  const touchedMonths = [...new Set([...days(firstsBefore, 'first_month'), ...days(firstsAfter, 'first_month')])].sort()
  await tx.query(`DELETE FROM fact_orders_daily WHERE date = ANY($1::date[])`, [touchedDays])
  await tx.query(DAYS('AND s.processed_day = ANY($2::date[])'), [at, touchedDays])
  await tx.query(`DELETE FROM fact_cohort_monthly WHERE cohort_month = ANY($1::text[])`, [touchedMonths])
  await tx.query(COHORTS('AND f.first_month = ANY($2::text[])'), [at, touchedMonths])
  return { orders: rows.length, days: touchedDays.length, cohorts: touchedMonths.length }
}

export type SyncState = { cursor: string | null; lastFullAt: string | null; keyCheck: string | null; windowLimited: boolean }

export async function readSyncState(tx: Tx): Promise<SyncState | null> {
  const r = (await tx.query(`SELECT cursor_at, last_full_at, key_check, window_limited FROM meta_shopify_sync WHERE id = 1`).catch(() => []))[0]
  if (!r) return null
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)
  return { cursor: iso(r.cursor_at), lastFullAt: iso(r.last_full_at), keyCheck: (r.key_check as string | null) ?? null, windowLimited: Boolean(r.window_limited) }
}

export async function writeSyncState(tx: Tx, s: { cursor: string; keyCheck: string; full?: { at: string; windowLimited: boolean } }) {
  if (s.full) {
    await tx.query(`INSERT INTO meta_shopify_sync (id, cursor_at, last_full_at, key_check, window_limited) VALUES (1, $1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET cursor_at = EXCLUDED.cursor_at, last_full_at = EXCLUDED.last_full_at, key_check = EXCLUDED.key_check, window_limited = EXCLUDED.window_limited`,
    [s.cursor, s.full.at, s.keyCheck, s.full.windowLimited])
  } else {
    await tx.query(`UPDATE meta_shopify_sync SET cursor_at = greatest(cursor_at, $1::timestamptz) WHERE id = 1 AND key_check = $2`, [s.cursor, s.keyCheck])
  }
}

// Removes every stored order, first order and the cursor. Used when a sync runs without a key (the ids could
// not be kept up to date), and when Shopify is disconnected along with its key.
export async function clearState(tx: Tx) {
  for (const t of ['shopify_order_state', 'shopify_customer_first', 'meta_shopify_sync']) {
    const r = await tx.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t])
    if (r[0]?.ok) await tx.query(`DELETE FROM ${t}`)
  }
}

export type Plan = { mode: 'incremental' | 'full'; reason: string }

// Incremental only when the stored state was built with this same key, the last full pull is recent enough, and
// that pull did not stop at Shopify's 60-day window (without read_all_orders the store's count keeps moving).
export function plan(state: SyncState | null, k: Keyer | null, opts: { force?: boolean; fullEveryDays: number; now?: number }): Plan {
  const now = opts.now ?? Date.now()
  if (!k) return { mode: 'full', reason: 'no_key' }
  if (opts.force) return { mode: 'full', reason: 'asked' }
  if (!state || !state.cursor || !state.lastFullAt) return { mode: 'full', reason: 'first' }
  if (state.keyCheck !== k.check) return { mode: 'full', reason: 'key_changed' }
  if (state.windowLimited) return { mode: 'full', reason: 'sixty_days' }
  if (now - Date.parse(state.lastFullAt) >= opts.fullEveryDays * 86400000) return { mode: 'full', reason: 'weekly_check' }
  return { mode: 'incremental', reason: 'changed_orders' }
}

// The cursor minus the overlap: late edits, refunds and Shopify's own search index lag are picked up again.
export const changedSince = (cursor: string, overlapDays: number) => new Date(Date.parse(cursor) - overlapDays * 86400000).toISOString().replace('.000Z', 'Z')
