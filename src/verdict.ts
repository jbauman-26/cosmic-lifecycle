import type { Db, Tx } from './db.js'
import { CliError } from './errors.js'
import { reconcile, tolerances, trustLine, TOLERANCE, type Check, type CheckStatus, type Tolerances } from './reconcile.js'
import { packMetrics, type Metric } from './metrics.js'
import { readWorkspace, type Workspace } from './workspace.js'
import { workspaceName } from './paths.js'
import { stripeReportCheck, type ReportCheck } from './stripe-report.js'

// 0.20.0: the period verdict. For one workspace and one calendar month, which KPIs can go in a client
// report and which must be held back, with the reason and what to check next.
//
// Every input comes from this CLI: the checks reconcile runs now (their names, tolerances and numbers),
// the sources config.json says are connected, and the sync runs and windows the database recorded. Nothing
// is read from the caller beyond the workspace and the month, so a verdict cannot be talked into "reportable".
//
// A KPI is reportable only when all of these hold for every source it needs:
// 1. the source is connected, is not syncing, and has finished a sync since it was connected;
// 2. the data was pulled through the end of the month (the sync's start, or Shopify's cursor, is after it);
// 3. it is not stale (last good sync within the freshness tolerance);
// 4. the synced data reaches back to the first day of the month, by what each source's sync records;
// and, for every table the KPI's SQL reads, a check that verifies that table's count ran and passed (or warned) on
// a window that includes the month, with no check on its sources failing. A checked ratio with nothing to divide
// by is reportable with no value and a note.
// The month itself must be over. A month still running, or one that has not started, holds back every KPI.
// Tolerances come from the workspace's settings. Any that differ from the defaults are listed in settings_changed.

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
  // 0.20.1: what a reportable KPI was checked against, when that is the source's own report: "matches Stripe's own
  // report". Null otherwise.
  basis: string | null
  sources: string[]
  checks: CheckRef[]
  reason: string | null
  next_checks: string[]
  // The metric's own qualifications, such as which currency a money value is in. Carry them into any report.
  notes: string[]
}
export type AsOfKpi = { kpi: string; title: string; unit: Metric['unit']; status: KpiStatus; value: number | null; basis: string | null; checks: CheckRef[]; reason: string | null; next_checks: string[]; notes: string[] }
export type AsOf = { at: string | null; kpis: AsOfKpi[] }
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
  // 0.20.1: point-in-time KPIs such as MRR, as of the last sync. Never a month figure.
  as_of: AsOf | null
  // Tolerances this workspace set away from the defaults, which loosen or tighten what passes.
  settings_changed: string[]
}

// Checks that compare a dataset's own count against something independent, by the table they vouch for.
// A KPI counts as checked only when, for every table its SQL reads, one of these ran (passed or warned) on a
// window that includes the month. A check on one table never certifies another (an order count says nothing
// about flow revenue).
const VERIFIES_TABLE: Record<string, string[]> = {
  fact_orders_daily: ['orders_complete'],
  fact_cohort_monthly: ['orders_complete'],
  fact_klaviyo_orders_daily: ['klaviyo_orders'],
  fact_flow_daily: ['flow_totals'],
  fact_flow_window: ['flow_totals'],
  fact_ga4_daily: ['ga4_purchases', 'ga4_vs_reference'],
  fact_crm_deals_daily: ['deals_complete'],
  fact_crm_contacts_daily: ['contacts_complete'],
}
// These checks compare only the trailing window (metrics.default_days up to yesterday), so they vouch for a
// month only when the month lies inside that window.
const TRAILING_CHECKS = new Set(['klaviyo_orders', 'ga4_purchases', 'ga4_vs_reference', 'flow_totals'])
export const tablesOf = (sql: string) => [...new Set([...sql.matchAll(/FROM (fact_\w+)/g)].map((m) => m[1]!))]
// Every check that can fail on a source, for holding its KPIs back.
const VERIFIES: Record<string, string[]> = {
  orders_complete: ['shopify'], klaviyo_orders: ['klaviyo'], flow_totals: ['klaviyo'], ga4_purchases: ['ga4'], ga4_vs_reference: ['ga4'],
  deals_complete: ['hubspot'], contacts_complete: ['hubspot'],
}
// Plausibility and internal-consistency checks (two tables built from the same pull). They never make a KPI checked, but a failure still holds it back.
const GUARDS: Record<string, string[]> = {
  orders_vs_cohorts: ['shopify'],
  deals_daily_vs_pulled: ['hubspot'],
  // Both are counted from the same Stripe pull, so a pull that drops pages passes them. Stripe gives no total of
  // its own to check against, so no Stripe table is verified yet.
  stripe_daily_complete: ['stripe'],
  subscriptions_balance: ['stripe'],
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

const dayBefore = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10)
// Sources whose sync pulls only a trailing window (metrics.default_days) and keeps older rows: a month older than
// the last sync's window may have gaps nobody can see. Stripe and HubSpot rebuild their daily tables from full history.
// The shipped default of metrics.default_days, the window the comparison checks use.
const DEFAULT_DAYS = 90
const TRAILING_SOURCES = new Set(['ga4', 'meta'])

async function coverage(db: Tx, source: string, connected: string[] | undefined, start: string, end: string, t: Tolerances, now: number): Promise<SourceCoverage> {
  const out = (o: Partial<SourceCoverage>): SourceCoverage => ({ source, connected: true, last_synced_at: null, data_from: null, covers_period: false, reason: null, ...o })
  if (connected && !connected.includes(source)) return out({ connected: false, reason: `${nameOf(source)} is not connected.` })
  const latest = await one(db, `SELECT status FROM meta_sync_run WHERE source = $1 ORDER BY started_at DESC LIMIT 1`, [source])
  if (latest.status === 'running') return out({ reason: `${nameOf(source)} is still syncing.` })
  const disconnected = iso((await one(db, `SELECT max(started_at) AS at FROM meta_sync_run WHERE source = $1 AND status = 'disconnected'`, [source])).at) ?? '1970-01-01T00:00:00.000Z'
  const good = await one(db, `SELECT started_at, finished_at FROM meta_sync_run WHERE source = $1 AND status IN ('ok', 'warning') AND coalesce(code, '') <> 'export_running'
    AND started_at > $2 ORDER BY started_at DESC LIMIT 1`, [source, disconnected])
  const last = iso(good.finished_at)
  const began = iso(good.started_at)
  if (!last || !began) return out({ reason: `${nameOf(source)} has not finished a sync since it was connected.` })
  const monthEnd = Date.parse(end + 'T00:00:00Z')

  // What the data was pulled through. A sync reads the source when it starts, not when it finishes. Shopify keeps a
  // cursor: a bulk export's own cut-off, or the newest change an incremental sync saw.
  let through = began
  if (source === 'shopify') {
    const cur = iso((await one(db, `SELECT cursor_at FROM meta_shopify_sync WHERE id = 1`).catch(() => ({} as Record<string, unknown>))).cursor_at)
    if (cur) through = cur
  }
  if (Date.parse(through) < monthEnd) return out({ last_synced_at: last, reason: `${nameOf(source)} data was pulled through ${through.slice(0, 16).replace('T', ' ')} UTC, before the month ended, so the end of the month may be missing.` })
  const age = (now - Date.parse(last)) / 86400000
  if (age > t.freshnessDays) return out({ last_synced_at: last, reason: `${nameOf(source)} last synced ${Math.floor(age)} days ago, past the ${t.freshnessDays}-day freshness limit.` })

  // How far back the synced data reaches, from what each sync records.
  const syncDay = began.slice(0, 10)
  let from: string | null = null
  if (source === 'shopify') {
    from = day((await one(db, `SELECT min(date) AS d FROM fact_orders_daily`)).d)
    // Without read_all_orders Shopify hands over only the last 60 days. A keyed sync records that; otherwise an
    // oldest order inside that window means the history may have been cut.
    const s = await one(db, `SELECT window_limited FROM meta_shopify_sync WHERE id = 1`).catch(() => ({} as Record<string, unknown>))
    const limited = s.window_limited === undefined || s.window_limited === null ? !from || from >= dayBefore(syncDay, 61) : Boolean(s.window_limited)
    // Shopify's 60 days roll by the clock, so a month starting exactly 60 days before the sync day lost its first hours.
    if (limited && start <= dayBefore(syncDay, 60)) return out({ last_synced_at: last, data_from: from, reason: `Shopify may have handed over only the last 60 days of orders (oldest synced: ${from ?? 'none'}; no read_all_orders scope), so this month may be incomplete.` })
  } else if (source === 'klaviyo') {
    const w = await one(db, `SELECT window_start AS s, window_end AS e FROM meta_source_window WHERE source = 'klaviyo' AND metric = 'placed_orders'`)
    from = day(w.s)
    const to = day(w.e)
    if (!from || !to) return out({ last_synced_at: last, reason: 'Klaviyo has no synced window of Placed Order data.' })
    // The window is stored as dates only, so a window that starts on the 1st may have started after midnight.
    if (from >= start || to < dayBefore(end, 1)) return out({ last_synced_at: last, data_from: from, reason: `Klaviyo was synced for ${from} to ${to}, which does not cover the whole month${from === start ? ' (a window starting on the 1st may have started after midnight)' : ''}.` })
  } else if (FACT[source]) {
    from = day((await one(db, `SELECT min(date) AS d FROM ${FACT[source]} WHERE source_synced_at > $1`, [disconnected])).d)
    if (!from) return out({ last_synced_at: last, reason: `${nameOf(source)} has synced no daily rows yet.` })
    if (from > start) return out({ last_synced_at: last, data_from: from, reason: `${nameOf(source)} data starts ${from}, after the month began.` })
    if (TRAILING_SOURCES.has(source)) {
      // The days the syncs actually pulled, recorded at sync time, not today's metrics.default_days setting.
      const w = await one(db, `SELECT window_start AS s, window_end AS e FROM meta_source_window WHERE source = $1 AND metric = 'daily'`, [source])
      const ws = day(w.s)
      const we = day(w.e)
      if (!ws || !we) return out({ last_synced_at: last, data_from: from, reason: `${nameOf(source)} has no recorded sync window (synced before 0.20.0). Sync it again: cosmic sync ${source}.` })
      if (ws > start || we < dayBefore(end, 1)) return out({ last_synced_at: last, data_from: from, reason: `${nameOf(source)} was pulled for ${ws} to ${we}, which does not cover the whole month, so it may have gaps.` })
    }
  }
  return out({ last_synced_at: last, data_from: from, covers_period: true })
}

const ref = (c: Check): CheckRef => ({ name: c.name, status: c.status, detail: c.detail, expected: c.expected, actual: c.actual })

// The reason a failing count check gives a person, with its numbers: "14 orders missing: 787 against 801".
function failReason(c: Check) {
  if (c.expected !== null && c.actual !== null && c.status === 'fail' && /orders|charges|deals|contacts|stripe_daily/.test(c.name)) {
    const gap = Math.abs(c.expected - c.actual)
    const what = c.name.startsWith('orders') || c.name === 'klaviyo_orders' ? 'orders' : c.name === 'stripe_daily_complete' ? 'charges' : (c.name.split('_')[0] ?? c.name)
    return `${gap} ${gap === 1 ? what.replace(/s$/, '') : what} ${c.actual < c.expected ? 'missing' : 'extra'}: ${c.actual} against ${c.expected} (${c.name}).`
  }
  return `${c.name} failed: ${c.detail}`
}

// 0.20.1: point-in-time KPIs, reported as of the last sync and never as a month figure. MRR is reportable as of a
// sync when that sync read subscriptions, the subscription count it pulled balances (subscriptions_balance), it is
// fresh, and the snapshot is from that sync's day.
const AS_OF_KPIS: Record<string, string> = {
  stripe_mrr: `SELECT mrr AS value FROM fact_stripe_mrr WHERE date = $1::date ORDER BY active_subscriptions DESC, currency LIMIT 1`,
}

async function asOfVerdict(db: Tx, metrics: Metric[], checks: Check[], connected: string[] | undefined, t: Tolerances, now: number): Promise<AsOf> {
  const run = await one(db, `SELECT started_at, finished_at, status FROM meta_sync_run WHERE source = 'stripe' ORDER BY started_at DESC LIMIT 1`)
  const good = await one(db, `SELECT finished_at FROM meta_sync_run WHERE source = 'stripe' AND status IN ('ok', 'warning') ORDER BY started_at DESC LIMIT 1`)
  // Written by every Stripe sync from 0.20.1: 1 when that sync read subscriptions, 0 when the key could not.
  const read = (await db.query(`SELECT value FROM meta_source_total WHERE source = 'stripe' AND metric = 'subscriptions_read'`))[0]
  const at = iso(good.finished_at)
  const balance = checks.find((c) => c.name === 'subscriptions_balance')
  const kpis: AsOfKpi[] = []
  for (const m of metrics) {
    const reasons: string[] = []
    const next: string[] = []
    if (connected && !connected.includes('stripe')) reasons.push('Stripe is not connected.')
    if (run.status === 'running') reasons.push('Stripe is still syncing.')
    if (!at) reasons.push('Stripe has not finished a sync.')
    else if ((now - Date.parse(at)) / 86400000 > t.freshnessDays) reasons.push(`Stripe last synced ${at.slice(0, 10)}, past the ${t.freshnessDays}-day freshness limit.`)
    if (at && !read) reasons.push('Stripe synced before 0.20.1 recorded whether subscriptions were read. Sync it again.')
    else if (at && Number(read!.value) !== 1) reasons.push('The latest Stripe sync did not read subscriptions. The key may lack read access to subscriptions.')
    if (!balance || balance.status !== 'pass') reasons.push(balance ? `subscriptions_balance ${balance.status === 'fail' ? 'failed' : 'did not run'}: ${balance.detail}` : 'subscriptions_balance did not run.')
    if (reasons.length) next.push('cosmic sync stripe, then cosmic verdict again')
    let value: number | null = null
    if (!reasons.length) {
      const r = await one(db, AS_OF_KPIS[m.name]!, [at!.slice(0, 10)])
      if (r.value === null || r.value === undefined) reasons.push(`No ${m.title} snapshot from the last sync's day.`)
      else value = Number(r.value)
    }
    const ok = !reasons.length
    kpis.push({
      kpi: m.name, title: m.title, unit: m.unit, status: ok ? 'reportable' : 'withheld', value,
      basis: ok ? `as of ${at}` : null, checks: balance ? [ref(balance)] : [], reason: ok ? null : reasons.join(' '), next_checks: next,
      notes: [...(m.notes ?? []), `As of ${at ?? 'no sync'}, from Stripe's subscription pull. A point in time, not a figure for any month.`],
    })
  }
  return { at, kpis }
}

export type VerdictOptions = { now?: number; tolerances?: Tolerances; workspace?: Workspace; connected?: string[]; name?: string }

/**
 * The verdict for one workspace and one month. The workspace is the one this process has open (the
 * --workspace flag or LIFECYCLE_WORKSPACE). `opts` exists for tests only; the CLI and Cosmic Cloud pass none
 * (Cloud names a store's connected sources in config.json, which connectedNow reads). Runs reconcile, so the stored check results are refreshed as `cosmic reconcile` would.
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
  let reportCheck: ReportCheck | undefined
  for (const m of metrics) {
    const stripeChecks: CheckRef[] = []
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
    // Every table the KPI reads needs its own verifying check, run on a window that includes this month.
    const checkStart = dayBefore(t.today ?? new Date(now).toISOString().slice(0, 10), t.days)
    let fromStripeReport = false
    for (const table of tablesOf(m.sql)) {
      if (table === 'fact_stripe_daily') {
        // 0.20.1: Stripe charge KPIs are held against Stripe's own report (its balance ledger), never against checks
        // counted from the same charges pull.
        const uncovered = [...m.sql.matchAll(/\b(failed_charges|new_customers|returning_charges|guest_charges)\b/g)].map((x) => x[1]!)
        if (uncovered.length) {
          reasons.push(`${m.title} uses ${[...new Set(uncovered)].join(', ')}, which Stripe's own report does not cover (it covers charge counts, gross and net), so it is not checked.`)
          continue
        }
        reportCheck ??= await stripeReportCheck(db, period, start, end)
        stripeChecks.push({ name: 'stripe_own_report', status: reportCheck.status, detail: reportCheck.detail, expected: reportCheck.expected, actual: reportCheck.actual })
        if (reportCheck.status === 'fail') {
          reasons.push(reportCheck.detail)
          next.push('cosmic sync stripe, then compare the charges list with Stripe\'s dashboard for the month')
        } else if (reportCheck.status === 'skipped') {
          reasons.push(reportCheck.detail)
          next.push('add the read permission "Report runs and report types" to the Stripe key, then cosmic sync stripe')
        } else if (/\bnet\b|\brefunded\b/.test(m.sql.replace(/fact_stripe_daily/g, '')) && !reportCheck.netChecked) {
          reasons.push(`${m.title} uses net after refunds, and Stripe's own report does not reach the last sync yet, so net is not compared. ${reportCheck.detail}`)
          next.push('cosmic sync stripe again later, once Stripe\'s report covers the last sync')
        } else fromStripeReport = true
        continue
      }
      const names = VERIFIES_TABLE[table]
      if (!names) {
        reasons.push(`No check verifies ${table} yet, so ${m.title} is not checked.`)
        continue
      }
      const verifying = checks.filter((c) => names.includes(c.name))
      // A failed check already gave its reason above; unchecked is for checks that did not vouch for this month.
      if (verifying.some((c) => c.status === 'fail')) continue
      const ran = verifying.filter((c) => c.status === 'pass' || c.status === 'warn')
      const forMonth = ran.filter((c) => !TRAILING_CHECKS.has(c.name) || start >= checkStart)
      if (!forMonth.length) {
        const why = ran.length
          ? `${ran.map((c) => c.name).join(', ')} covers only the last ${t.days} days, from ${checkStart}, not this month.`
          : verifying.find((c) => c.status === 'skipped')?.detail ?? `${names.join(' or ')} did not run.`
        reasons.push(`${m.title} is unchecked for this month: ${why}`)
        if (!ran.length) next.push('cosmic sync, then cosmic reconcile')
      }
    }
    const status: KpiStatus = reasons.length ? 'withheld' : 'reportable'
    let value: number | null = null
    if (status === 'reportable') {
      const r = await one(db, periodSql(m.sql), [start, end])
      value = r.value === null || r.value === undefined ? null : Number(r.value)
    }
    kpis.push({
      kpi: m.name, title: m.title, unit: m.unit, status, value, basis: status === 'reportable' && fromStripeReport ? "matches Stripe's own report" : null, sources: m.needs, checks: [...mine.map(ref), ...stripeChecks],
      // A checked month can still have no value: a ratio with nothing to divide by, such as AOV with no orders.
      notes: [...(m.notes ?? []), ...(status === 'reportable' && value === null ? ['No value this month: there is nothing to divide by (for example, no orders). The data behind it was checked.'] : [])],
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
    as_of: all.some((m) => m.name in AS_OF_KPIS) ? await asOfVerdict(db, all.filter((m) => m.name in AS_OF_KPIS), checks, connected, t, now) : null,
    settings_changed: [
      ...(Object.keys(TOLERANCE) as (keyof typeof TOLERANCE)[]).filter((k) => t[k] !== TOLERANCE[k]).map((k) => `${k}: ${t[k]} (default ${TOLERANCE[k]})`),
      ...(t.days !== DEFAULT_DAYS ? [`days: ${t.days} (default ${DEFAULT_DAYS})`] : []),
    ],
  }
}

// Exit codes for `cosmic verdict`: 0 every KPI reportable, 3 any withheld or none to report, 1 bad input.
export const VERDICT_WITHHELD_EXIT = 3
export const verdictExit = (v: Verdict) => (v.kpis.length && !v.withheld ? 0 : VERDICT_WITHHELD_EXIT)

export function formatVerdict(v: Verdict) {
  const lines = [`${v.workspace}, ${v.period} (${v.period_state === 'complete' ? 'complete month' : v.period_state === 'in_progress' ? 'still running' : 'not started'}): ${v.reportable} reportable, ${v.withheld} withheld.`]
  for (const k of v.kpis) {
    lines.push(k.status === 'reportable' ? `REPORT ${k.kpi}: ${k.value ?? 'no value'}${k.basis ? ` (${k.basis})` : ''}` : `HOLD   ${k.kpi}: ${k.reason}`)
  }
  if (v.as_of?.kpis.length) {
    lines.push('', `Point in time, not for ${v.period}:`)
    for (const k of v.as_of.kpis) lines.push(k.status === 'reportable' ? `AS OF  ${k.kpi}: ${k.value} (${k.basis})` : `HOLD   ${k.kpi}: ${k.reason}`)
  }
  if (!v.kpis.length) lines.push('No KPIs to report: connect a source first. Next: cosmic doctor')
  if (v.settings_changed.length) lines.push(`Tolerances changed from the defaults: ${v.settings_changed.join(', ')}.`)
  const next = [...new Set(v.kpis.flatMap((k) => k.next_checks))]
  if (next.length) lines.push('', 'Next:', ...next.map((n) => `  ${n}`))
  lines.push('', ...v.sources.map((s) => `${nameOf(s.source)}: ${s.covers_period ? `covers the month, last synced ${s.last_synced_at}` : s.reason}`))
  return lines.join('\n')
}
