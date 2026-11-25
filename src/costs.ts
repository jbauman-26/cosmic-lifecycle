import type { Db, Tx } from './db.js'
import { CliError } from './errors.js'
import { aggregateCosts, type CostOrder } from './sources/shopify-costs.js'

// The owner's cost inputs for contribution margin. Each is a number kept in meta_cost_setting, so
// the margin metrics stay fixed SQL. An input never set counts as zero, and every margin answer
// names the ones that are not set.
export const COST_KEYS = {
  cogs_percent: { unit: 'percent', max: 100, help: 'Cost of goods as a percent of revenue, for lines with no Shopify unit cost (or every day, when costs were never synced).' },
  shipping_per_order: { unit: 'amount', max: 100000, help: 'What shipping costs you per order, in the store currency.' },
  fulfillment_per_order: { unit: 'amount', max: 100000, help: 'Pick, pack and handling per order, in the store currency.' },
  payment_fee_percent: { unit: 'percent', max: 100, help: 'Payment processing fee as a percent of the order total, such as 2.9.' },
  payment_fee_fixed: { unit: 'amount', max: 1000, help: 'Payment processing fee per order, such as 0.30.' },
} as const
export type CostKey = keyof typeof COST_KEYS

export function assertCostKey(k: string): CostKey {
  if (!(k in COST_KEYS)) throw new CliError(`Unknown cost ${k}.`, `Costs: ${Object.keys(COST_KEYS).join(', ')}`, 'unknown_setting')
  return k as CostKey
}

export async function listCosts(db: Tx) {
  let rows: Record<string, unknown>[] = []
  try {
    rows = await db.query(`SELECT key, value, set_at FROM meta_cost_setting`)
  } catch {
    rows = []
  }
  return (Object.keys(COST_KEYS) as CostKey[]).map((key) => {
    const r = rows.find((x) => x.key === key)
    return { key, value: r ? Number(r.value) : null, setAt: r ? new Date(String(r.set_at)).toISOString() : null, unit: COST_KEYS[key].unit, help: COST_KEYS[key].help }
  })
}

export async function setCost(db: Tx, key: string, value: string) {
  const k = assertCostKey(key)
  const n = Number(value)
  if (value.trim() === '' || !Number.isFinite(n) || n < 0 || n > COST_KEYS[k].max) throw new CliError(`Use a number from 0 to ${COST_KEYS[k].max}.`, `lifecycle costs set ${k} ${COST_KEYS[k].unit === 'percent' ? '35' : '4.50'}`, 'bad_value')
  await db.query(`INSERT INTO meta_cost_setting VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, set_at = EXCLUDED.set_at`, [k, n, new Date().toISOString()])
  return { key: k, value: n }
}

export async function unsetCost(db: Tx, key: string) {
  const k = assertCostKey(key)
  await db.query(`DELETE FROM meta_cost_setting WHERE key = $1`, [k])
  return { key: k, value: null }
}

// Has the owner given this workspace any cost at all? Margin metrics join the store's list only then.
export async function costsConfigured(db: Tx | null) {
  if (!db) return false
  try {
    return (await db.query(`SELECT 1 FROM meta_cost_setting UNION ALL SELECT 1 FROM fact_cogs_daily LIMIT 1`)).length > 0
  } catch {
    return false
  }
}

// Recomputed from the full pull in one transaction, like the order totals.
export async function writeCosts(db: Db, orders: CostOrder[], currency: string) {
  const { daily, truncatedOrders } = aggregateCosts(orders)
  const at = new Date().toISOString()
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM fact_cogs_daily')
    for (const d of daily) await tx.query(`INSERT INTO fact_cogs_daily VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [d.date, currency.toLowerCase(), d.cogsKnown, d.uncostedRevenue, d.tax, d.lines, d.linesWithCost, at])
  })
  const lines = daily.reduce((n, d) => n + d.lines, 0)
  const costed = daily.reduce((n, d) => n + d.linesWithCost, 0)
  return { days: daily.length, lines, linesWithCost: costed, truncatedOrders, coveragePct: lines ? Math.round((costed / lines) * 10000) / 100 : null }
}

// Notes a margin answer carries about inputs that are missing, so a margin is never quietly too high.
export async function costNotes(db: Tx, since: string) {
  const costs = await listCosts(db)
  const unset = costs.filter((c) => c.value === null).map((c) => c.key)
  const notes: string[] = []
  if (unset.length) notes.push(`Not set, so counted as zero: ${unset.join(', ')}. Set them with lifecycle costs set.`)
  const cov = (await db.query(`SELECT coalesce(sum(lines), 0) AS lines, coalesce(sum(lines_with_cost), 0) AS costed, count(*) AS days FROM fact_cogs_daily WHERE date >= $1`, [since]))[0] ?? {}
  if (!Number(cov.days)) notes.push('No Shopify unit costs synced for this window, so cost of goods is cogs_percent of revenue. Read real costs with lifecycle costs sync.')
  else if (Number(cov.costed) < Number(cov.lines)) notes.push(`${Number(cov.lines) - Number(cov.costed)} of ${Number(cov.lines)} line items have no unit cost in Shopify; cogs_percent covers them.`)
  const ads = (await db.query(`SELECT 1 FROM fact_meta_ads_daily LIMIT 1`)).length
  if (!ads) notes.push('No ad spend synced, so contribution margin after ads has no ad cost in it.')
  return notes
}

// The store's currency, for a roll-up: what the cost sync read from Shopify, else what the owner set.
export async function storeCurrency(db: Tx): Promise<string | null> {
  try {
    const r = await db.query(`SELECT currency FROM fact_cogs_daily GROUP BY currency ORDER BY count(*) DESC LIMIT 1`)
    if (r[0]) return String(r[0].currency).toUpperCase()
  } catch {
    // Older database: no cost table yet.
  }
  return null
}
