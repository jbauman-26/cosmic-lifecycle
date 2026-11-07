import { createHash } from 'node:crypto'
import { fetchJson } from '../http.js'
import { CliError } from '../errors.js'

const VERSION = '2026-10'

export type RawOrder = {
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
  if (!body.access_token) throw new CliError('Shopify returned no access token.', 'lifecycle connect shopify')
  return body.access_token
}

// Deliberately asks for no personal field. At Level 1 access Shopify refuses
// them anyway, which is the behavior we want.
const ORDERS_QUERY = `query($c: String) {
  orders(first: 250, after: $c, sortKey: PROCESSED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      processedAt cancelledAt
      customer { id }
      currentTotalPriceSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
    }
  }
}`

export async function fetchOrders(store: string, token: string): Promise<RawOrder[]> {
  const out: RawOrder[] = []
  let cursor: string | null = null
  do {
    const body = await fetchJson(
      `https://${store}/admin/api/${VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
        body: JSON.stringify({ query: ORDERS_QUERY, variables: { c: cursor } }),
      },
      'Shopify orders request',
    )
    if (body.errors) {
      const text = JSON.stringify(body.errors)
      if (text.includes('not approved to access')) {
        throw new CliError(
          'Shopify blocked order access for this app.',
          'In the Partner Dashboard open your app, then API access requests, then Protected customer data access, and select Analytics. Leave name, email, phone and address unselected.',
          'shopify_protected_data',
        )
      }
      throw new CliError('Shopify rejected the orders query.', 'lifecycle doctor')
    }
    out.push(...body.data.orders.nodes)
    cursor = body.data.orders.pageInfo.hasNextPage ? body.data.orders.pageInfo.endCursor : null
  } while (cursor)
  return out
}

// The store's own count, used to prove the pull was complete. Returns null when
// Shopify only gives a lower bound, because that cannot prove anything.
export async function fetchOrderCount(store: string, token: string): Promise<number | null> {
  const body = await fetchJson(
    `https://${store}/admin/api/${VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify({ query: '{ ordersCount(limit: null) { count precision } }' }),
    },
    'Shopify order count',
  )
  const c = body.data?.ordersCount
  return c?.precision === 'EXACT' ? c.count : null
}

const hash = (id: string) => createHash('sha256').update(id).digest('hex')
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
