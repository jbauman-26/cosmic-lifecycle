import type { Tx } from './db.js'
import { CliError } from './errors.js'
import { trustLine } from './reconcile.js'
import { ATTRIBUTION_NOTE } from './reports.js'

// Verified metrics: fixed, reviewed SQL an agent picks from instead of writing its own.
// The same metric and window always run the same SQL, so a number asked for on Monday
// matches the one asked for on Friday. Every query returns value, numerator, denominator.
// $1 is the first day of the window, as YYYY-MM-DD.

export type Unit = 'count' | 'usd' | 'percent' | 'usd_per_recipient'
export type Source = 'shopify' | 'klaviyo' | 'ga4'

export type Metric = {
  name: string
  title: string
  description: string
  unit: Unit
  needs: Source[]
  sql: string
  notes?: string[]
}

const ratio = (num: string, den: string, scale = 1) =>
  `SELECT CASE WHEN (${den}) > 0 THEN (${num}) * ${scale}.0 / (${den}) END AS value, (${num}) AS numerator, (${den}) AS denominator`

const ORDERS = `(SELECT coalesce(sum(orders), 0) FROM fact_orders_daily WHERE date >= $1)`
const NET = `(SELECT coalesce(sum(net_revenue), 0) FROM fact_orders_daily WHERE date >= $1)`
const RETURNING = `(SELECT coalesce(sum(returning_orders), 0) FROM fact_orders_daily WHERE date >= $1)`
const FLOW_REVENUE = `(SELECT coalesce(sum(revenue), 0) FROM fact_flow_daily WHERE date >= $1)`
const FLOW_RECIPIENTS = `(SELECT coalesce(sum(recipients), 0) FROM fact_flow_daily WHERE date >= $1)`
const FLOW_UNSUBS = `(SELECT coalesce(sum(unsubscribes), 0) FROM fact_flow_daily WHERE date >= $1)`
const FLOW_SPAM = `(SELECT coalesce(sum(spam_complaints), 0) FROM fact_flow_daily WHERE date >= $1)`
const PLACED = `(SELECT coalesce(sum(placed_orders), 0) FROM fact_klaviyo_orders_daily WHERE date >= $1)`
const SESSIONS = `(SELECT coalesce(sum(sessions), 0) FROM fact_ga4_daily WHERE date >= $1)`
const PURCHASES = `(SELECT coalesce(sum(purchases), 0) FROM fact_ga4_daily WHERE date >= $1)`
const single = (expr: string) => `SELECT ${expr} AS value, NULL::numeric AS numerator, NULL::numeric AS denominator`

export const METRICS: Metric[] = [
  { name: 'shopify_orders', title: 'Shopify orders', description: 'Orders placed in Shopify in the window.', unit: 'count', needs: ['shopify'], sql: single(ORDERS) },
  { name: 'shopify_net_revenue', title: 'Shopify net revenue', description: "Sum of each order's current total in Shopify, after discounts, edits and refunds, for orders in the window. Cancelled orders are left out.", unit: 'usd', needs: ['shopify'], sql: single(NET) },
  { name: 'average_order_value', title: 'Average order value', description: 'Shopify net revenue divided by Shopify orders.', unit: 'usd', needs: ['shopify'], sql: ratio(NET, ORDERS) },
  { name: 'returning_order_share', title: 'Returning order share', description: 'Share of Shopify orders placed by customers who had ordered before.', unit: 'percent', needs: ['shopify'], sql: ratio(RETURNING, ORDERS, 100), notes: ['A customer counts as returning when an earlier order of theirs is in the synced history. Guest checkouts have no customer and are counted on their own, never as returning.'] },
  { name: 'flow_attributed_revenue', title: 'Flow attributed revenue', description: 'Revenue Klaviyo attributes to all flows in the window.', unit: 'usd', needs: ['klaviyo'], sql: single(FLOW_REVENUE), notes: [ATTRIBUTION_NOTE] },
  { name: 'flow_revenue_share', title: 'Flow share of revenue', description: 'Flow attributed revenue as a share of Shopify net revenue.', unit: 'percent', needs: ['klaviyo', 'shopify'], sql: ratio(FLOW_REVENUE, NET, 100), notes: [ATTRIBUTION_NOTE] },
  { name: 'flow_revenue_per_recipient', title: 'Revenue per flow recipient', description: 'Flow attributed revenue divided by flow recipients, across all flows.', unit: 'usd_per_recipient', needs: ['klaviyo'], sql: ratio(FLOW_REVENUE, FLOW_RECIPIENTS), notes: [ATTRIBUTION_NOTE] },
  { name: 'flow_unsubscribe_rate', title: 'Flow unsubscribe rate', description: 'Unsubscribes divided by flow recipients.', unit: 'percent', needs: ['klaviyo'], sql: ratio(FLOW_UNSUBS, FLOW_RECIPIENTS, 100) },
  { name: 'flow_spam_rate', title: 'Flow spam complaint rate', description: 'Spam complaints divided by flow recipients.', unit: 'percent', needs: ['klaviyo'], sql: ratio(FLOW_SPAM, FLOW_RECIPIENTS, 100) },
  { name: 'klaviyo_placed_orders', title: 'Klaviyo Placed Order count', description: "Placed Order events Klaviyo recorded in the window. Compare with shopify_orders: they should be close.", unit: 'count', needs: ['klaviyo'], sql: single(PLACED) },
  { name: 'ga4_sessions', title: 'GA4 sessions', description: 'Sessions GA4 recorded in the window, all channels.', unit: 'count', needs: ['ga4'], sql: single(SESSIONS) },
  { name: 'ga4_purchase_rate', title: 'GA4 purchase rate', description: 'GA4 purchases divided by GA4 sessions.', unit: 'percent', needs: ['ga4'], sql: ratio(PURCHASES, SESSIONS, 100) },
]

// Which table proves each source has synced at all.
const SOURCE_TABLE: Record<Source, string> = { shopify: 'fact_orders_daily', klaviyo: 'fact_flow_daily', ga4: 'fact_ga4_daily' }

export function findMetric(name: string) {
  const m = METRICS.find((x) => x.name === name)
  if (!m) throw new CliError(`No metric named ${name}.`, 'lifecycle metrics list', 'unknown_metric')
  return m
}

export function listMetrics() {
  return METRICS.map(({ name, title, description, unit, needs }) => ({ name, title, description, unit, needs }))
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const round = (n: number | null, d: number) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d)

export function sinceDate(days: number, now = Date.now()) {
  return new Date(now - days * 86400000).toISOString().slice(0, 10)
}

export async function runMetric(db: Tx, name: string, days = 90, now = Date.now()) {
  const m = findMetric(name)
  if (!Number.isInteger(days) || days < 1 || days > 730) throw new CliError('Days must be a whole number from 1 to 730.', `lifecycle metrics run ${name} --days 90`, 'bad_days')
  const since = sinceDate(days, now)

  const missing: Source[] = []
  for (const s of m.needs) {
    const r = await db.query(`SELECT 1 FROM ${SOURCE_TABLE[s]} LIMIT 1`)
    if (!r.length) missing.push(s)
  }
  const base = { metric: m.name, title: m.title, unit: m.unit, days, since, sql: m.sql, notes: m.notes ?? [] }
  if (missing.length) {
    return { ...base, value: null, numerator: null, denominator: null, missing, trust: await trustLine(db), status: 'no_data' as const, detail: `No ${missing.join(' or ')} data synced. Connect it, then lifecycle sync.` }
  }

  const row = (await db.query(m.sql, [since]))[0] ?? {}
  const value = num(row.value)
  return {
    ...base,
    value: round(value, m.unit === 'count' ? 0 : 4),
    numerator: num(row.numerator),
    denominator: num(row.denominator),
    missing,
    trust: await trustLine(db),
    status: value === null ? ('no_data' as const) : ('ok' as const),
    detail: value === null ? 'The denominator is zero in this window.' : '',
  }
}

export function formatValue(unit: Unit, v: number | null) {
  if (v === null) return 'no value'
  if (unit === 'usd') return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (unit === 'usd_per_recipient') return `$${v.toFixed(4)} per recipient`
  if (unit === 'percent') return `${v.toFixed(2)}%`
  return v.toLocaleString('en-US')
}
