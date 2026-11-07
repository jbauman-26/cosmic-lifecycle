import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { appHome } from './paths.js'
import { CliError } from './errors.js'
import { fetchJson } from './http.js'
import { Klaviyo } from './sources/klaviyo.js'
import { fetchOrderCount, shopifyToken } from './sources/shopify.js'
import { getSecret } from './secrets.js'
import { readConfig } from './config.js'

// Tools: named, read-only API calls an agent can run with the user's own keys.
// Graphed resells provider calls for credits. Here every call goes straight from your
// machine to Klaviyo or Shopify on your key, so there is no markup and no middleman.
// No tool reads profiles or customers, so no output can contain personal data.

export type ToolContext = {
  klaviyo: () => Klaviyo
  shopify: () => Promise<{ store: string; token: string }>
}

type ToolDef<S extends z.ZodTypeAny> = {
  id: string
  provider: 'klaviyo' | 'shopify'
  description: string
  input: S
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>
}

const none = z.object({}).strict()
const define = <S extends z.ZodTypeAny>(t: ToolDef<S>) => t

export const TOOLS = [
  define({ id: 'klaviyo.account', provider: 'klaviyo', description: 'The Klaviyo account the key belongs to: name, id, timezone and currency.', input: none, run: (_i, c) => c.klaviyo().account() }),
  define({ id: 'klaviyo.flows', provider: 'klaviyo', description: 'Every flow with its status, trigger type and dates.', input: none, run: (_i, c) => c.klaviyo().flows() }),
  define({ id: 'klaviyo.campaigns', provider: 'klaviyo', description: 'Email campaigns with status and send time.', input: none, run: (_i, c) => c.klaviyo().campaigns() }),
  define({ id: 'klaviyo.segments', provider: 'klaviyo', description: 'Segments with their active state. Members are never read.', input: none, run: (_i, c) => c.klaviyo().segments() }),
  define({ id: 'klaviyo.placed_order_metric', provider: 'klaviyo', description: 'The id of the metric Klaviyo uses for Placed Order.', input: none, run: async (_i, c) => ({ metricId: await c.klaviyo().placedOrderMetricId() }) }),
  define({
    id: 'klaviyo.placed_orders_daily',
    provider: 'klaviyo',
    description: 'Daily Placed Order count and value between two dates.',
    input: z.object({ start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
    run: async (i, c) => {
      const k = c.klaviyo()
      const metricId = await k.placedOrderMetricId()
      if (!metricId) throw new CliError('This Klaviyo account has no Placed Order metric.', 'Set LIFECYCLE_KLAVIYO_ORDER_METRIC to your order metric id.', 'no_metric')
      return k.placedOrdersDaily(metricId, i.start, i.end)
    },
  }),
  define({ id: 'shopify.order_count', provider: 'shopify', description: "Shopify's own count of orders on the store.", input: none, run: async (_i, c) => { const s = await c.shopify(); return { orders: await fetchOrderCount(s.store, s.token) } } }),
  define({
    id: 'shopify.shop',
    provider: 'shopify',
    description: 'Store name, currency, plan and timezone.',
    input: none,
    run: async (_i, c) => {
      const s = await c.shopify()
      const body = await fetchJson(`https://${s.store}/admin/api/2026-10/graphql.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': s.token },
        body: JSON.stringify({ query: '{ shop { name currencyCode ianaTimezone plan { displayName } } }' }),
      }, 'Shopify shop details')
      return body?.data?.shop ?? null
    },
  }),
] as const

export type ToolId = (typeof TOOLS)[number]['id']

export function toolCatalog() {
  return TOOLS.map((t) => ({ id: t.id, provider: t.provider, description: t.description, input: Object.keys((t.input as z.ZodObject<any>).shape ?? {}) }))
}

const runsDir = () => join(appHome(), 'runs')

export type ToolRun = { id: string; tool: string; input: unknown; status: 'succeeded' | 'failed'; startedAt: string; finishedAt: string; output?: unknown; error?: string }

export async function runTool(id: string, rawInput: unknown, ctx: ToolContext, now = () => new Date()): Promise<ToolRun> {
  const tool = TOOLS.find((t) => t.id === id)
  if (!tool) throw new CliError(`No tool named ${id}.`, 'lifecycle tools catalog', 'unknown_tool')
  const parsed = (tool.input as z.ZodTypeAny).safeParse(rawInput ?? {})
  if (!parsed.success) throw new CliError(`Bad input for ${id}: ${parsed.error.issues.map((x) => `${x.path.join('.') || 'input'} ${x.message}`).join('; ')}`, `lifecycle tools catalog`, 'bad_input')
  const run: ToolRun = { id: randomUUID().slice(0, 8), tool: id, input: parsed.data, status: 'succeeded', startedAt: now().toISOString(), finishedAt: '' }
  try {
    run.output = await (tool.run as (i: unknown, c: ToolContext) => Promise<unknown>)(parsed.data, ctx)
  } catch (e) {
    run.status = 'failed'
    run.error = e instanceof Error ? e.message : String(e)
  }
  run.finishedAt = now().toISOString()
  mkdirSync(runsDir(), { recursive: true })
  writeFileSync(join(runsDir(), `${run.id}.json`), JSON.stringify(run, null, 2))
  return run
}

export function getRun(id: string): ToolRun {
  const p = join(runsDir(), `${id.replace(/[^\w-]/g, '')}.json`)
  if (!existsSync(p)) throw new CliError(`No run ${id}.`, 'lifecycle tools runs', 'unknown_run')
  return JSON.parse(readFileSync(p, 'utf8'))
}

export function listRuns(limit = 20) {
  if (!existsSync(runsDir())) return []
  return readdirSync(runsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(runsDir(), f), 'utf8')) as ToolRun)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
    .map(({ id, tool, status, startedAt }) => ({ id, tool, status, startedAt }))
}

// Keys come from the keychain or LIFECYCLE_* variables, the same way sync reads them.
export function defaultToolContext(): ToolContext {
  return {
    klaviyo: () => {
      const key = getSecret('klaviyo-read-key')
      if (!key) throw new CliError('Klaviyo is not connected.', 'lifecycle connect klaviyo --key-env NAME', 'missing_secret')
      return new Klaviyo(key)
    },
    shopify: async () => {
      const config = readConfig()
      const secret = getSecret('shopify-client-secret')
      if (!config.shopify || !secret) throw new CliError('Shopify is not connected.', 'lifecycle connect shopify --store NAME.myshopify.com --client-id ID --secret-env NAME', 'missing_secret')
      return { store: config.shopify.store, token: await shopifyToken(config.shopify.store, config.shopify.clientId, secret) }
    },
  }
}
