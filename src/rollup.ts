import { existsSync, readdirSync } from 'node:fs'
import { openDb, migrate } from './db.js'
import { getSetting, readConfig } from './config.js'
import { CliError } from './errors.js'
import { workspacesDir } from './paths.js'
import { findMetric, runMetric } from './metrics.js'
import { storeCurrency } from './costs.js'
import { tryWriteLock } from './lock.js'
import { assertCurrency, fetchRates, parseRates, rateLine, type Rates } from './fx.js'
import { readWorkspace } from './workspace.js'

// One number across several stores, in one currency. Each store is a workspace on this machine:
// the default one and any named one (lifecycle --workspace NAME). Each runs the same metric with
// its own trust line, its value is converted at a stated rate on a stated date, then they are added.

type How = 'money' | 'count' | 'money_per_count' | 'money_over_money' | 'count_over_count'
// How a metric adds up across stores. A metric not listed and not a plain total cannot be rolled up.
const HOW: Record<string, How> = {
  average_order_value: 'money_per_count',
  stripe_average_charge: 'money_per_count',
  crm_average_deal_size: 'money_per_count',
  contribution_margin_percent: 'money_over_money',
  flow_revenue_share: 'money_over_money',
  returning_order_share: 'count_over_count',
  ga4_purchase_rate: 'count_over_count',
  crm_win_rate: 'count_over_count',
  crm_lead_to_customer_rate: 'count_over_count',
}
export function rollupHow(name: string): How | null {
  if (HOW[name]) return HOW[name]
  let m
  try {
    m = findMetric(name)
  } catch {
    return null
  }
  if (m.unit === 'count') return 'count'
  // A plain money total. Not a ratio of two numbers, and not a point-in-time snapshot of one currency's subscriptions.
  if (m.unit === 'usd' && !/ratio\(|AS denominator/.test(m.sql.replace(/NULL::numeric AS denominator/g, ''))) return 'money'
  return null
}

const TRUST_ORDER = ['failed', 'unreferenced', 'unchecked', 'passed'] as const

export function listStores(): string[] {
  const dir = workspacesDir()
  const named = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(`${dir}/${e.name}/config.json`)).map((e) => e.name).sort() : []
  return ['default', ...named]
}

async function inStore<T>(store: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.LIFECYCLE_WORKSPACE
  if (store === 'default') delete process.env.LIFECYCLE_WORKSPACE
  else process.env.LIFECYCLE_WORKSPACE = store
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.LIFECYCLE_WORKSPACE
    else process.env.LIFECYCLE_WORKSPACE = prev
  }
}

export type RollupOptions = { open?: { store: string; db: import('./db.js').Db }; stores?: string[] | 'all'; currency?: string; days?: number; rateDate?: string; rates?: string[]; fetchRates?: typeof fetchRates }

export async function rollupMetric(name: string, opts: RollupOptions) {
  const how = rollupHow(name)
  if (!how) throw new CliError(`${name} cannot be added up across stores.`, 'Run it per store, or pick a total, a count or a metric with a numerator and denominator.', 'not_summable')
  const wanted = opts.currency ?? (getSetting('rollup.currency') as string | undefined)
  if (!wanted) throw new CliError('Which currency should the total be in?', `lifecycle metrics run ${name} --all-stores --currency USD, or lifecycle config set rollup.currency USD`, 'no_currency')
  const currency = assertCurrency(wanted)
  const stores = opts.stores === 'all' || !opts.stores?.length ? listStores() : opts.stores
  if (opts.rateDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.rateDate)) throw new CliError('Use a rate date like 2026-11-20.', `lifecycle metrics run ${name} --all-stores --currency ${currency} --rate-date 2026-11-20`, 'bad_value')
  const manual = parseRates(opts.rates)
  const m = findMetric(name)
  const counts = how === 'count' || how === 'count_over_count'
  type StoreRow = { store: string; status: string; [k: string]: any }
  const rows: StoreRow[] = []
  // First every store's own answer and currency, then one rate request for all of them.
  for (const store of stores) {
    rows.push(await inStore(store, async () => {
      try {
        readConfig()
      } catch {
        return { store, status: 'not_set_up', detail: 'This store is not set up on this machine.' }
      }
      // A database this process already holds (the MCP server's own) is used as it is, never opened twice.
      const held = opts.open?.store === store ? opts.open.db : null
      const db = held ?? (await openDb())
      try {
        const lock = held ? null : tryWriteLock('rollup')
        if (lock) {
          try {
            await migrate(db)
          } finally {
            lock()
          }
        }
        const r = await runMetric(db, name, opts.days)
        const set = getSetting('workspace.currency')
        const ccy = (await storeCurrency(db)) ?? (set ? String(set) : null)
        const base = { store, status: r.status, value: r.value, numerator: r.numerator, denominator: r.denominator, trust: r.trust, notes: r.notes, detail: r.detail, workspace: readWorkspace().type }
        if (!ccy && !counts) return { ...base, status: 'no_currency', detail: `This store's currency is not known. Set it in the app under Settings, Costs, or: lifecycle --workspace ${store} costs set currency EUR` }
        return { ...base, currency: ccy }
      } finally {
        if (!held) await db.close()
      }
    }))
  }
  const need = [...new Set(rows.filter((r) => r.currency && r.currency !== currency && manual[r.currency] === undefined).map((r) => String(r.currency)))]
  const fetched: Rates = need.length && !counts ? await (opts.fetchRates ?? fetchRates)(currency, opts.rateDate ?? null, need) : { base: currency, date: opts.rateDate ?? '', rates: { [currency]: 1 }, source: '' }
  const rateOf = (ccy: string) => (ccy === currency ? 1 : manual[ccy] ?? fetched.rates[ccy] ?? null)
  for (const r of rows) {
    if (r.status !== 'ok') continue
    if (counts) {
      r.rate = null
      r.converted = r.value
      continue
    }
    const rate = rateOf(String(r.currency))
    r.rate = rate
    if (rate === null) {
      r.status = 'no_rate'
      r.detail = `No ${r.currency} rate for that day.`
      r.converted = null
      continue
    }
    r.rateSource = r.currency === currency ? 'same currency' : manual[r.currency] !== undefined ? 'set by the owner' : fetched.source
    r.converted = how === 'money_over_money' ? r.value : r.value === null ? null : Math.round((r.value / rate) * 100) / 100
  }
  const ok = rows.filter((r) => r.status === 'ok')
  let total: number | null = null
  if (ok.length) {
    const rate = (r: StoreRow) => (r.rate ? r.rate : 1)
    if (how === 'money' || how === 'count') total = Math.round(ok.reduce((n, r) => n + (r.converted ?? 0), 0) * 100) / 100
    else {
      const num = ok.reduce((n, r) => n + Number(r.numerator ?? 0) / (how === 'count_over_count' ? 1 : rate(r)), 0)
      const den = ok.reduce((n, r) => n + Number(r.denominator ?? 0) / (how === 'money_over_money' ? rate(r) : 1), 0)
      total = den > 0 ? Math.round((num / den) * (m.unit === 'percent' ? 100 : 1) * 10000) / 10000 : null
    }
  }
  const trusts: { status: string; line: string }[] = rows.map((r) => (r.trust ? r.trust : { status: 'unchecked', line: '' }))
  const worst = TRUST_ORDER.find((s) => trusts.some((t) => t.status === s)) ?? 'unchecked'
  const missing = rows.filter((r) => r.status !== 'ok').map((r) => r.store)
  const usedManual = rows.some((r) => r.rateSource === 'set by the owner')
  const usedFetched = rows.some((r) => r.rateSource === fetched.source && fetched.source)
  const currencyLine = counts ? `A count: no currency.` : usedFetched ? rateLine(fetched, false) + (usedManual ? ' Some rates set by the owner.' : '') : usedManual ? rateLine(fetched, true) : `In ${currency}.`
  const line = worst === 'passed' ? "Every store's numbers passed its own checks." : `Not every store's numbers passed: ${rows.map((r, i) => `${r.store} ${trusts[i]!.status}`).join(', ')}.`
  const rates = counts ? [] : Object.entries({ ...fetched.rates, ...manual }).filter(([c]) => c !== currency && rows.some((r) => r.currency === c)).map(([c, rate]) => ({ base: currency, currency: c, rate, date: manual[c] !== undefined ? null : fetched.date, source: manual[c] !== undefined ? 'set by the owner' : fetched.source }))
  return {
    rollup: true as const, metric: name, title: m.title, unit: m.unit, days: opts.days ?? null, currency, total,
    stores: rows, rates, line: currencyLine, trust: { status: worst, line }, left_out: missing,
    notes: [
      ...(missing.length ? [`Left out of the total: ${missing.join(', ')}.`] : []),
      'Each store\'s money numbers are taken to be in that store\'s currency and divided by one rate for the whole window. Rates are reference rates, not what a bank paid.',
    ],
  }
}
