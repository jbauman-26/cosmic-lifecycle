import pg from 'pg'
import { CliError } from './errors.js'
import type { RawCharge } from './sources/stripe.js'
import type { RawOrder } from './sources/shopify.js'

// 0.19.0: bring your own pipeline. A person who already loads Stripe or Shopify with Fivetran or Airbyte
// into their own Postgres points the CLI at those tables. The CLI reads only the columns a total needs
// (never names, emails or addresses), turns the rows into the same shape the native connectors produce,
// and hands them to the same sync code. So the daily tables, every check, every metric and the MCP
// server work exactly as they do for a native connection.
//
// Column names come from the loaders' published schemas: Fivetran's dbt_stripe and dbt_shopify source
// models (github.com/fivetran/dbt_stripe, github.com/fivetran/dbt_shopify) and Airbyte's Stripe and Shopify
// streams, which mirror the Stripe and Shopify APIs. Tested against tables built in that shape, not yet
// against a real Fivetran or Airbyte load.

export const PIPELINE_TOOLS = ['fivetran', 'airbyte'] as const
export const PIPELINE_SOURCES = ['stripe', 'shopify'] as const
export type PipelineTool = (typeof PIPELINE_TOOLS)[number]
export type PipelineSource = (typeof PIPELINE_SOURCES)[number]
export type PipelineSettings = { tool: PipelineTool; schema: string; urlEnv: string; connectedAt: string }

// The table each loader writes, and the column that says when the loader last wrote a row.
export const TABLES: Record<PipelineTool, Record<PipelineSource, { table: string; loadedAt: string }>> = {
  fivetran: { stripe: { table: 'charge', loadedAt: '_fivetran_synced' }, shopify: { table: 'order', loadedAt: '_fivetran_synced' } },
  airbyte: { stripe: { table: 'charges', loadedAt: '_airbyte_extracted_at' }, shopify: { table: 'orders', loadedAt: '_airbyte_extracted_at' } },
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/
const q = (s: string) => `"${s}"`

export type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

export function checkSettings(tool: string, source: string, schema: string, urlEnv: string) {
  if (!PIPELINE_TOOLS.includes(tool as PipelineTool)) throw new CliError(`Unknown pipeline tool: ${tool}. Use fivetran or airbyte.`, 'cosmic connect pipeline --tool fivetran --source stripe --schema stripe --url-env PIPELINE_DATABASE_URL', 'bad_value')
  if (!PIPELINE_SOURCES.includes(source as PipelineSource)) throw new CliError(`Pipeline mode reads stripe or shopify so far, not ${source}.`, 'cosmic sources import NAME --csv FILE takes daily totals from any other tool', 'bad_value')
  if (!IDENT.test(schema)) throw new CliError(`Not a schema name: ${schema}. Use lowercase letters, numbers and underscores.`, 'The schema is the one your loader writes to, such as stripe or shopify.', 'bad_value')
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(urlEnv)) throw new CliError(`Not an environment variable name: ${urlEnv}.`, 'export PIPELINE_DATABASE_URL=postgres://... then pass --url-env PIPELINE_DATABASE_URL', 'bad_value')
}

async function columns(query: Query, schema: string, table: string) {
  const rows = await query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`, [schema, table])
  return new Set(rows.map((r) => String(r.column_name)))
}

function need(have: Set<string>, cols: string[], where: string) {
  const missing = cols.filter((c) => !have.has(c))
  if (!have.size) throw new CliError(`No table ${where} in the pipeline database.`, 'Check the schema name your loader writes to: cosmic connect pipeline ... --schema NAME', 'pipeline_table_missing')
  if (missing.length) throw new CliError(`${where} has no ${missing.join(', ')} column. It does not look like a ${where.split('.')[1]} table from this loader.`, 'Check --tool and --schema, or report the shape: cosmic feedback "pipeline columns"', 'pipeline_columns')
}

const epoch = (v: unknown): number => {
  if (v === null || v === undefined) return NaN
  if (typeof v === 'number') return v
  if (v instanceof Date) return Math.floor(v.getTime() / 1000)
  const s = String(v)
  return /^\d+$/.test(s) ? Number(s) : Math.floor(Date.parse(s) / 1000)
}
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString())
const money = (v: unknown) => (v === null || v === undefined ? '0' : String(v))

export async function loadCharges(query: Query, tool: PipelineTool, schema: string): Promise<RawCharge[]> {
  const { table } = TABLES[tool].stripe
  const have = await columns(query, schema, table)
  const customer = tool === 'fivetran' ? 'customer_id' : 'customer'
  need(have, ['id', 'created', 'amount', 'amount_refunded', 'currency', 'status', customer], `${schema}.${table}`)
  const deleted = have.has('_fivetran_deleted') ? ` WHERE coalesce(${q('_fivetran_deleted')}, false) = false` : ''
  const rows = await query(`SELECT id, created, amount, amount_refunded, currency, status, ${q(customer)} AS customer FROM ${q(schema)}.${q(table)}${deleted}`)
  return rows.map((r) => ({
    id: String(r.id),
    created: epoch(r.created),
    amount: Number(r.amount ?? 0),
    amount_refunded: Number(r.amount_refunded ?? 0),
    currency: String(r.currency ?? '').toLowerCase(),
    status: String(r.status ?? ''),
    customer: r.customer === null || r.customer === undefined || r.customer === '' ? null : String(r.customer),
  })).filter((c) => Number.isFinite(c.created))
}

export async function loadOrders(query: Query, tool: PipelineTool, schema: string): Promise<{ orders: RawOrder[]; refundsSubtracted: boolean }> {
  const { table } = TABLES[tool].shopify
  const have = await columns(query, schema, table)
  need(have, ['id', 'processed_at', 'cancelled_at', 'total_discounts', 'total_price', tool === 'fivetran' ? 'customer_id' : 'customer'], `${schema}.${table}`)
  // Fivetran's order table has the price at the time of the order; refunds live in other tables. Use the current
  // total when the loader keeps one, and say so when it does not.
  const current = have.has('current_total_price')
  const price = current ? `coalesce(current_total_price, total_price)` : 'total_price'
  const customer = tool === 'fivetran' ? 'customer_id::text' : `(customer ->> 'id')`
  const where = [have.has('_fivetran_deleted') ? `coalesce(${q('_fivetran_deleted')}, false) = false` : null, have.has('test') ? 'coalesce(test, false) = false' : null].filter(Boolean)
  const opt = (c: string) => (have.has(c) ? c : `NULL AS ${c}`)
  const rows = await query(`SELECT id::text AS id, ${opt('created_at')}, ${opt('updated_at')}, processed_at, cancelled_at, ${price} AS price, total_discounts, ${customer} AS customer FROM ${q(schema)}.${q(table)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`)
  const orders = rows.filter((r) => r.processed_at !== null && r.processed_at !== undefined).map((r) => ({
    id: String(r.id),
    createdAt: iso(r.created_at) ?? undefined,
    updatedAt: iso(r.updated_at) ?? undefined,
    processedAt: iso(r.processed_at)!,
    cancelledAt: iso(r.cancelled_at),
    customer: r.customer === null || r.customer === undefined || r.customer === '' ? null : { id: String(r.customer) },
    currentTotalPriceSet: { shopMoney: { amount: money(r.price) } },
    totalDiscountsSet: { shopMoney: { amount: money(r.total_discounts) } },
  }))
  return { orders, refundsSubtracted: current }
}

// When the loader last wrote a row. Null when the table has no load column.
export async function lastLoaded(query: Query, tool: PipelineTool, source: PipelineSource, schema: string): Promise<string | null> {
  const { table, loadedAt } = TABLES[tool][source]
  const have = await columns(query, schema, table)
  if (!have.has(loadedAt)) return null
  const r = await query(`SELECT max(${q(loadedAt)}) AS at FROM ${q(schema)}.${q(table)}`)
  return iso(r[0]?.at)
}

export function pipelineQuery(urlEnv: string, env: NodeJS.ProcessEnv = process.env): { query: Query; close: () => Promise<void> } {
  const url = env[urlEnv]
  if (!url) throw new CliError(`${urlEnv} is not set.`, `export ${urlEnv}=postgres://user:password@host/db (the database your loader writes to)`, 'missing_key')
  const pool = new pg.Pool({ connectionString: url, max: 1 })
  // A refused or failed connection can carry no message at all (an AggregateError per address), so name it here.
  const query: Query = async (sql, params) => {
    try {
      return (await pool.query(sql, params as unknown[])).rows
    } catch (e) {
      if (e instanceof CliError) throw e
      const err = e as { message?: string; code?: string; errors?: { code?: string }[] }
      const why = err.message || err.code || err.errors?.map((x) => x.code).filter(Boolean).join(', ') || 'no answer'
      throw new CliError(`Could not read the pipeline database in ${urlEnv}: ${why}.`, 'Check that the database is running and the URL is right. The CLI only reads.', 'pipeline_unreachable')
    }
  }
  return { query, close: () => pool.end() }
}

export function staleNote(at: string | null, now = Date.now(), days = 2) {
  if (!at) return null
  const age = (now - Date.parse(at)) / 86400000
  return age > days ? `The loader last wrote to this table ${Math.floor(age)} days ago, so these numbers may be behind. Check the loader's schedule.` : null
}
