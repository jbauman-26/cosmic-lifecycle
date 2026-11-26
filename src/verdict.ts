import type { Db, Tx } from './db.js'
import { CliError } from './errors.js'
import { reconcile, tolerances, trustLine, type Check, type CheckStatus, type Tolerances } from './reconcile.js'
import { packMetrics, type Metric } from './metrics.js'
import { readWorkspace, type Workspace } from './workspace.js'
import { workspaceName } from './paths.js'

// 0.20.0: the period verdict. For one workspace and one calendar month, which KPIs can go in a client
// report and which must be held back, with the reason and what to check next.
//
// Every input comes from this CLI: the checks reconcile runs now (their names, tolerances and numbers),
// the sources config.json says are connected, and the sync runs and windows the database recorded. Nothing
// is read from the caller beyond the workspace and the month, so a verdict cannot be talked into "reportable".
//
// A KPI is reportable only when all of these hold for every source it needs:
// 1. the source is connected, is not syncing, and has finished a sync since it was connected;
// 2. that sync finished after the month ended, so the whole month was pulled;
// 3. it is not stale (last good sync within the freshness tolerance);
// 4. the synced data reaches back to the first day of the month;
// 5. at least one check that verifies the source's own count ran and passed (or warned), and
// 6. no check on the source failed.
// The month itself must be over. A month still running, or one that has not started, holds back every KPI.

export type KpiStatus = 'reportable' | 'withheld'
export type PeriodState = 'complete' | 'in_progress' | 'future'
export type CheckRef = { name: string; status: CheckStatus; detail: string; expected: number | null; actual: number | null }
export type SourceCoverage = {
  source: string
  connected: boolean
  last_synced_at: string | null
  data_from: string | null
  covers_period: boolean
  reason: string | null
}
export type KpiVerdict = {
  kpi: string
  title: string
  unit: Metric['unit']
  status: KpiStatus
  value: number | null
  sources: string[]
  checks: CheckRef[]
  reason: string | null
  next_checks: string[]
}
export type Verdict = {
  workspace: string
  period: string
  period_start: string
  period_end: string
  period_state: PeriodState
  checked_at: string
  trust: { status: string; line: string }
  sources: SourceCoverage[]
  kpis: KpiVerdict[]
  reportable: number
  withheld: number
  not_by_period: string[]
}

// Checks that compare a source's own count against something independent. One of these must have run
// for the source before its numbers count as checked.
const VERIFIES: Record<string, string[]> = {
  orders_complete: ['shopify'],
  klaviyo_orders: ['klaviyo'],
  flow_totals: ['klaviyo'],
  ga4_purchases: ['ga4'],
  ga4_vs_reference: ['ga4'],
  stripe_daily_complete: ['stripe'],
  subscriptions_balance: ['stripe'],
  deals_complete: ['hubspot'],
  contacts_complete: ['hubspot'],
}
// Plausibility and internal-consistency checks (two tables built from the same pull). They never make a source "checked", but a failure still holds its KPIs back.
const GUARDS: Record<string, string[]> = {
  orders_vs_cohorts: ['shopify'],
  deals_daily_vs_pulled: ['hubspot'],
  attributed_share: ['klaviyo'],
  ad_claims: ['meta'],
  cost_coverage: ['shopify'],
}
const touches = (check: string, source: string) => (VERIFIES[check] ?? GUARDS[check] ?? []).includes(source)

const NAME: Record<string, string> = { shopify: 'Shopify', klaviyo: 'Klaviyo', ga4: 'GA4', stripe: 'Stripe', meta: 'Meta', hubspot: 'HubSpot' }
const nameOf = (s: string) => NAME[s] ?? s
// Where each source's daily rows live, to see how far back its data reaches.
const FACT: Record<string, string> = { stripe: 'fact_stripe_daily', ga4: 'fact_ga4_daily', meta: 'fact_meta_ads_daily', hubspot: 'fact_crm_deals_daily' }

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/

export function parsePeriod(period: string): { start: string; end: string } {
  const m = PERIOD.exec(period ?? '')
  const year = m ? Number(m[1]) : NaN
  if (!m || year < 2000 || year > 2100) {
    throw new CliError(`Not a month: ${period}. Use YYYY-MM, such as 2026-10.`, 'cosmic verdict --period 2026-10', 'bad_value')
  }
  const month = Number(m[2])
  const start = `${m[1]}-${m[2]}-01`
  const end = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10) // first day of the next month
  return { start, end }
}

export function periodState(start: string, end: string, now: number): PeriodState {
  if (now < Date.parse(start + 'T00:00:00Z')) return 'future'
  if (now < Date.parse(end + 'T00:00:00Z')) return 'in_progress'
  return 'complete'
}

// The metric's own SQL, closed at the end of the month. Metrics that are a point in time (MRR, open pipeline),
// count from the first Meta day, or are computed from costs.json have no value for a past month, so they are
// left out and listed in not_by_period.
const POINT_IN_TIME = /fact_stripe_mrr|fact_crm_pipeline_open|GREATEST\(\$1/
export const byPeriod = (m: Metric) => !m.margin && m.sql.includes('date >= $1') && !POINT_IN_TIME.test(m.sql)
export const periodSql = (sql: string) => sql.replaceAll('date >= $1', 'date >= $1 AND date < $2')

const one = async (db: Tx, sql: string, params: unknown[] = []) => (await db.query(sql, params))[0] ?? {}
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString())
const day = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString().slice(0, 10))

async function coverage(db: Tx, source: string, connected: string[] | undefined, start: string, end: string, t: Tolerances, now: number): Promise<SourceCoverage> {
  const out = (o: Partial<SourceCoverage>): SourceCoverage => ({ source, connected: true, last_synced_at: null, data_from: null, covers_period: false, reason: null, ...o })
  if (connected && !connected.includes(source)) return out({ connected: false, reason: `${nameOf(source)} is not connected.` })
  const latest = await one(db, `SELECT status FROM meta_sync_run WHERE source = $1 ORDER BY started_at DESC LIMIT 1`, [source])
  if (latest.status === 'running') return out({ reason: `${nameOf(source)} is still syncing.` })
  const good = await one(db, `SELECT max(finished_at) AS at FROM meta_sync_run WHERE source = $1 AND status IN ('ok', 'warning') AND coalesce(code, '') <> 'export_running'
    AND started_at > coalesce((SELECT max(started_at) FROM meta_sync_run d WHERE d.source = $1 AND d.status = 'disconnected'), '-infinity'::timestamptz)`, [source])
  const last = iso(good.at)
  if (!last) return out({ reason: `${nameOf(source)} has not finished a sync since it was connected.` })
  if (Date.parse(last) < Date.parse(end + 'T00:00:00Z')) return out({ last_synced_at: last, reason: `${nameOf(source)} last synced ${last.slice(0, 10)}, before the month ended, so the end of the month is missing.` })
  const age = (now - Date.parse(last)) / 86400000
  if (age > t.freshnessDays) return out({ last_synced_at: last, reason: `${nameOf(source)} last synced ${Math.floor(age)} days ago, past the ${t.freshnessDays}-day freshness limit.` })

  // How far back the synced data reaches.
  let from: string | null = null
  if (source === 'shopify') {
    const s = await one(db, `SELECT window_limited FROM meta_shopify_sync WHERE id = 1`).catch(() => ({} as Record<string, unknown>))
    if (s.window_limited) {
      from = day((await one(db, `SELECT min(processed_day) AS d FROM shopify_order_state`)).d)
      if (!from || from > start) return out({ last_synced_at: last, data_from: from, reason: `Shopify handed over orders only from ${from ?? 'no date'} (no read_all_orders scope), so the start of the month may be missing.` })
    }
  } else if (source === 'klaviyo') {
    const w = await one(db, `SELECT window_start AS s, window_end AS e FROM meta_source_window WHERE source = 'klaviyo' AND metric = 'placed_orders'`)
    from = day(w.s)
    const to = day(w.e)
    if (!from || !to) return out({ last_synced_at: last, reason: 'Klaviyo has no synced window of Placed Order data.' })
    if (from > start || to < new Date(Date.parse(end + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)) return out({ last_synced_at: last, data_from: from, reason: `Klaviyo was synced for ${from} to ${to}, which does not cover the whole month.` })
  } else if (FACT[source]) {
    // No window is recorded for these sources, so the evidence is the rows: data must start on or before the month.
    from = day((await one(db, `SELECT min(date) AS d FROM ${FACT[source]}`)).d)
    if (!from) return out({ last_synced_at: last, reason: `${nameOf(source)} has synced no daily rows yet.` })
    if (from > start) return out({ last_synced_at: last, data_from: from, reason: `${nameOf(source)} data starts ${from}, after the month began.` })
  }
  return out({ last_synced_at: last, data_from: from, covers_period: true })
}

const ref = (c: Check): CheckRef => ({ name: c.name, status: c.status, detail: c.detail, expected: c.expected, actual: c.actual })

// The reason a failing count check gives a person, with its numbers: "14 orders missing: 787 against 801".
function failReason(c: Check) {
  if (c.expected !== null && c.actual !== null && c.status === 'fail' && /orders|charges|deals|contacts/.test(c.name)) {
    const gap = Math.abs(c.expected - c.actual)
    const what = c.name.startsWith('orders') || c.name === 'klaviyo_orders' ? 'orders' : c.name.split('_')[0]
    return `${gap} ${what} ${c.actual < c.expected ? 'missing' : 'extra'}: ${c.actual} against ${c.expected} (${c.name}).`
  }
  return `${c.name} failed: ${c.detail}`
}

export type VerdictOptions = { now?: number; tolerances?: Tolerances; workspace?: Workspace; connected?: string[]; name?: string }

/**
 * The verdict for one workspace and one month. The workspace is the one this process has open (the
 * --workspace flag or LIFECYCLE_WORKSPACE); `opts` exists for tests and for Cosmic Cloud, which passes the
 * connected list it holds. Runs reconcile, so the stored check results are refreshed as `cosmic reconcile` would.
 */
export async function verdictFor(db: Db, period: string, opts: VerdictOptions = {}): Promise<Verdict> {
  const { start, end } = parsePeriod(period)
  const now = opts.now ?? Date.now()
  const t = opts.tolerances ?? tolerances()
  const ws = opts.workspace ?? readWorkspace()
  const connected = opts.connected ?? t.connected
  const state = periodState(start, end, now)

  const checks = (await reconcile(db, { ...t, connected }, ws)).checks
  const trust = await trustLine(db)

  // KPIs: this workspace's metrics, for sources that are connected (or, when config cannot say, have synced).
  const synced = (await db.query(`SELECT DISTINCT source FROM meta_sync_run`)).map((r) => String(r.source))
  const present = connected ?? synced
  const all = packMetrics(ws.type).filter((m) => m.needs.every((s) => present.includes(s)))
  const metrics = all.filter(byPeriod)
  const sources = [...new Set(metrics.flatMap((m) => m.needs))].sort()
  const cover = new Map<string, SourceCoverage>()
  for (const s of sources) cover.set(s, await coverage(db, s, connected, start, end, t, now))

  const kpis: KpiVerdict[] = []
  for (const m of metrics) {
    const mine = checks.filter((c) => m.needs.some((s) => touches(c.name, s)))
    const reasons: string[] = []
    const next: string[] = []
    if (state === 'future') reasons.push(`${period} has not started.`)
    if (state === 'in_progress') reasons.push(`${period} is still running, so its numbers are not final.`)
    for (const s of m.needs) {
      const c = cover.get(s)!
      if (!c.covers_period) {
        reasons.push(c.reason!)
        next.push(c.connected ? `cosmic sync ${s}` : `cosmic connect ${s}`)
      }
    }
    for (const c of mine.filter((c) => c.status === 'fail')) {
      reasons.push(failReason(c))
      next.push(`cosmic reconcile, then fix ${c.name}: ${c.detail}`)
    }
    for (const s of m.needs) {
      const verifying = checks.filter((c) => (VERIFIES[c.name] ?? []).includes(s))
      // A failed check already gave its reason above; unchecked is for checks that never ran.
      if (!verifying.some((c) => c.status === 'pass' || c.status === 'warn' || c.status === 'fail')) {
        const why = verifying.find((c) => c.status === 'skipped')?.detail
        reasons.push(verifying.length ? `${nameOf(s)} numbers are unchecked: ${why ?? 'its checks did not run.'}` : `No check verifies ${nameOf(s)}'s numbers in this workspace yet.`)
        if (verifying.length) next.push('cosmic sync, then cosmic reconcile')
      }
    }
    const status: KpiStatus = reasons.length ? 'withheld' : 'reportable'
    let value: number | null = null
    if (status === 'reportable') {
      const r = await one(db, periodSql(m.sql), [start, end])
      value = r.value === null || r.value === undefined ? null : Number(r.value)
    }
    kpis.push({
      kpi: m.name, title: m.title, unit: m.unit, status, value, sources: m.needs, checks: mine.map(ref),
      reason: reasons.length ? [...new Set(reasons)].join(' ') : null, next_checks: [...new Set(next)],
    })
  }

  return {
    workspace: opts.name ?? workspaceName() ?? 'default',
    period, period_start: start, period_end: end, period_state: state,
    checked_at: new Date(now).toISOString(),
    trust,
    sources: [...cover.values()],
    kpis,
    reportable: kpis.filter((k) => k.status === 'reportable').length,
    withheld: kpis.filter((k) => k.status === 'withheld').length,
    not_by_period: all.filter((m) => !byPeriod(m)).map((m) => m.name),
  }
}

// Exit codes for `cosmic verdict`: 0 every KPI reportable, 3 any withheld or none to report, 1 bad input.
export const VERDICT_WITHHELD_EXIT = 3
export const verdictExit = (v: Verdict) => (v.kpis.length && !v.withheld ? 0 : VERDICT_WITHHELD_EXIT)

export function formatVerdict(v: Verdict) {
  const lines = [`${v.workspace}, ${v.period} (${v.period_state === 'complete' ? 'complete month' : v.period_state === 'in_progress' ? 'still running' : 'not started'}): ${v.reportable} reportable, ${v.withheld} withheld.`]
  for (const k of v.kpis) {
    lines.push(k.status === 'reportable' ? `REPORT ${k.kpi}: ${k.value ?? 'no value'}` : `HOLD   ${k.kpi}: ${k.reason}`)
  }
  if (!v.kpis.length) lines.push('No KPIs to report: connect a source first. Next: cosmic doctor')
  const next = [...new Set(v.kpis.flatMap((k) => k.next_checks))]
  if (next.length) lines.push('', 'Next:', ...next.map((n) => `  ${n}`))
  lines.push('', ...v.sources.map((s) => `${nameOf(s.source)}: ${s.covers_period ? `covers the month, last synced ${s.last_synced_at}` : s.reason}`))
  return lines.join('\n')
}
