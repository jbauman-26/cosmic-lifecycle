import { createHash } from 'node:crypto'
import { fetchJson, HttpError } from '../http.js'
import { CliError } from '../errors.js'

export const SHOPIFY_VERSION = '2026-10'
const VERSION = SHOPIFY_VERSION

export type RawOrder = {
  // The order's id and when it last changed. Ids are hashed with the store's own key before anything is
  // stored (src/shopify-state.ts); the raw id never reaches the database.
  id?: string
  createdAt?: string
  updatedAt?: string
  processedAt: string
  cancelledAt: string | null
  customer: { id: string } | null
  currentTotalPriceSet: { shopMoney: { amount: string } }
  totalDiscountsSet: { shopMoney: { amount: string } }
  totalRefundedSet?: { shopMoney: { amount: string } }
}
export type OrdersDaily = { date: string; orders: number; gross: number; net: number; discounts: number; newOrders: number; returningOrders: number; guestOrders: number }
export type CohortMonthly = { cohortMonth: string; monthsSince: number; customers: number; orders: number; revenue: number }

export async function shopifyToken(store: string, clientId: string, clientSecret: string): Promise<string> {
  const body = await fetchJson(
    `https://${store}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    },
    'Shopify token request',
  )
  if (!body.access_token) throw new CliError('Shopify returned no access token.', 'cosmic connect shopify')
  return body.access_token
}

// Deliberately asks for no personal field. At Level 1 access Shopify refuses
// them anyway, which is the behavior we want.
// With $q, only the orders Shopify's search matches, such as updated_at:>='...' for an incremental sync.
const ORDERS_QUERY = (sortKey: 'PROCESSED_AT' | 'UPDATED_AT') => `query($c: String, $q: String) {
  orders(first: 250, after: $c, sortKey: ${sortKey}, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id createdAt updatedAt processedAt cancelledAt
      customer { id }
      currentTotalPriceSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
    }
  }
}`

const SCOPE_NEXT = 'In the Shopify admin open Settings, then Apps and sales channels, then Develop apps, then your app, then Configuration, and add the read_orders scope, plus read_all_orders for orders older than 60 days. Install the app again, then cosmic connect shopify.'

export function scopeDenied(text: string) {
  const scope = /`?(read_[a-z_]+)`?/.exec(text)?.[1]
  return new CliError(`Shopify did not let this app read orders${scope ? `. It needs the ${scope} scope` : ', because the app is missing a scope'}.`, SCOPE_NEXT, 'scope_denied')
}

// Turns Shopify's GraphQL errors into one plain sentence and a code the app can map.
export function shopifyQueryError(errors: unknown): CliError {
  const list = Array.isArray(errors) ? errors : [errors]
  const text = JSON.stringify(errors)
  if (text.includes('not approved to access')) {
    return new CliError(
      'Shopify blocked order access for this app.',
      'In the Partner Dashboard open your app, then API access requests, then Protected customer data access, and select Analytics. Leave name, email, phone and address unselected.',
      'shopify_protected_data',
    )
  }
  const denied = list.find((e: any) => e?.extensions?.code === 'ACCESS_DENIED' || /access denied|required access/i.test(String(e?.message ?? '')))
  if (denied) return scopeDenied(String((denied as any).message ?? ''))
  if (list.some((e: any) => e?.extensions?.code === 'THROTTLED')) {
    return new CliError('Shopify is rate limiting this app.', 'Wait a few minutes, then run cosmic sync again.', 'rate_limited')
  }
  return new CliError('Shopify rejected the orders query.', 'cosmic doctor', 'shopify_query')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const throttled = (errors: unknown) => Array.isArray(errors) && errors.some((e: any) => e?.extensions?.code === 'THROTTLED')

// Shopify reports a spent rate limit as THROTTLED inside a 200 reply, so fetchJson's retry never sees it.
// Wait for the bucket to refill, using the cost Shopify sends back, and try the same page again a few times.
export function throttleWait(body: any, attempt: number) {
  const t = body?.extensions?.cost?.throttleStatus
  const need = Number(body?.extensions?.cost?.requestedQueryCost)
  if (t && Number(t.restoreRate) > 0 && Number.isFinite(need)) {
    return Math.min(60000, Math.max(1000, Math.ceil(((need - Number(t.currentlyAvailable)) / Number(t.restoreRate)) * 1000) + 250))
  }
  return Math.min(60000, 2 ** attempt * 1000)
}

export async function fetchOrders(store: string, token: string, opts: { wait?: (ms: number) => Promise<void>; retries?: number; query?: string } = {}): Promise<RawOrder[]> {
  const wait = opts.wait ?? sleep
  const query = ORDERS_QUERY(opts.query ? 'UPDATED_AT' : 'PROCESSED_AT')
  const retries = opts.retries ?? 5
  const out: RawOrder[] = []
  let cursor: string | null = null
  let attempt = 0
  for (;;) {
    const body: any = await fetchJson(
      `https://${store}/admin/api/${VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
        body: JSON.stringify({ query, variables: { c: cursor, q: opts.query ?? null } }),
      },
      'Shopify orders request',
    ).catch((e) => {
      // A missing scope can also come back as a plain 403.
      if (e instanceof HttpError && e.status === 403) throw scopeDenied(e.body)
      throw e
    })
    if (body.errors && throttled(body.errors) && attempt < retries) {
      await wait(throttleWait(body, attempt++))
      continue
    }
    if (body.errors) throw shopifyQueryError(body.errors)
    attempt = 0
    for (const n of body.data.orders.nodes) out.push(n)
    if (!body.data.orders.pageInfo.hasNextPage) return out
    cursor = body.data.orders.pageInfo.endCursor
  }
}

// The store's own count, used to prove the pull was complete. Returns null when
// Shopify only gives a lower bound, because that cannot prove anything.
// With createdBefore, only orders created up to that moment, to compare with an export started then.
export async function fetchOrderCount(store: string, token: string, createdBefore?: string): Promise<number | null> {
  const body = await fetchJson(
    `https://${store}/admin/api/${VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify(createdBefore
        ? { query: 'query($q: String) { ordersCount(query: $q, limit: null) { count precision } }', variables: { q: `created_at:<='${createdBefore}'` } }
        : { query: '{ ordersCount(limit: null) { count precision } }' }),
    },
    'Shopify order count',
  )
  const c = body.data?.ordersCount
  return c?.precision === 'EXACT' ? c.count : null
}

const hash = (id: string) => createHash('sha256').update(id).digest('hex')

// Only the orders changed at or after a moment: what an incremental sync asks for. Sorted by when they changed.
export const changedSinceQuery = (since: string) => `updated_at:>='${since}'`
const monthOf = (d: string) => d.slice(0, 7)
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7))
const money = (n: number) => Math.round(n * 100) / 100

// Pure, so the tests can pin every rule. Customer ids are hashed in memory and
// leave this function only as counts.
export function aggregateOrders(orders: RawOrder[]): { daily: OrdersDaily[]; cohorts: CohortMonthly[] } {
  const firstMonth = new Map<string, string>()
  const daily = new Map<string, OrdersDaily>()
  const cohorts = new Map<string, { customers: Set<string>; orders: number; revenue: number }>()

  for (const o of [...orders].sort((a, b) => a.processedAt.localeCompare(b.processedAt))) {
    if (o.cancelledAt) continue
    const date = o.processedAt.slice(0, 10)
    const net = Number(o.currentTotalPriceSet.shopMoney.amount)
    const discounts = Number(o.totalDiscountsSet.shopMoney.amount)
    const key = o.customer ? hash(o.customer.id) : null
    const isNew = key !== null && !firstMonth.has(key)
    if (key && isNew) firstMonth.set(key, monthOf(date))

    const d = daily.get(date) ?? { date, orders: 0, gross: 0, net: 0, discounts: 0, newOrders: 0, returningOrders: 0, guestOrders: 0 }
    d.orders++
    d.net = money(d.net + net)
    d.gross = money(d.gross + net + discounts)
    d.discounts = money(d.discounts + discounts)
    if (isNew) d.newOrders++
    else if (key) d.returningOrders++
    else d.guestOrders++
    daily.set(date, d)

    if (key) {
      const cohortMonth = firstMonth.get(key)!
      const monthsSince = monthsBetween(cohortMonth, monthOf(date))
      const id = `${cohortMonth}|${monthsSince}`
      const c = cohorts.get(id) ?? { customers: new Set<string>(), orders: 0, revenue: 0 }
      c.customers.add(key)
      c.orders++
      c.revenue = money(c.revenue + net)
      cohorts.set(id, c)
    }
  }

  return {
    daily: [...daily.values()],
    cohorts: [...cohorts].map(([id, c]) => {
      const [cohortMonth, months] = id.split('|') as [string, string]
      return { cohortMonth, monthsSince: Number(months), customers: c.customers.size, orders: c.orders, revenue: c.revenue }
    }),
  }
}
