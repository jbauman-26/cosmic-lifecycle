import { createHash } from 'node:crypto'
import { fetchJson, HttpError } from '../http.js'
import { CliError } from '../errors.js'
import { apiBase } from './api-base.js'

const API = 'https://api.stripe.com/v1'

// Only the fields the aggregates need. Stripe sends more, including billing
// details, and none of it is read or kept.
export type RawCharge = {
  id: string
  created: number
  amount: number
  amount_refunded: number
  currency: string
  status: string
  customer: string | null
  // 0.20.1: an authorization that was never captured took no money. Missing (older recordings, pipeline tables)
  // means captured.
  captured?: boolean
  amount_captured?: number
}
export type RawSubscription = {
  id: string
  created: number
  status: string
  ended_at: number | null
  currency: string
  items: { data: { quantity?: number | null; price: { unit_amount: number | null; recurring: { interval: string; interval_count: number } | null } }[] }
}

export type StripeDaily = {
  date: string; currency: string; charges: number; gross: number; refunded: number; net: number
  failed: number; newCustomers: number; returningCharges: number; guestCharges: number
}
export type StripeSubsDaily = { date: string; currency: string; started: number; ended: number }
export type StripeMrr = { currency: string; active: number; mrr: number; unpricedItems: number }

// Stripe amounts are in the smallest unit, and not every currency has cents.
// https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'])
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd'])
export function toMajor(amount: number, currency: string) {
  const c = currency.toLowerCase()
  const div = ZERO_DECIMAL.has(c) ? 1 : THREE_DECIMAL.has(c) ? 1000 : 100
  return Math.round((amount / div) * 1000) / 1000
}

export const stripeMode = (key: string) => (/^(sk|rk)_test_/.test(key) ? ('test' as const) : ('live' as const))
export const isRestrictedKey = (key: string) => key.startsWith('rk_')

// 0.20.1: Stripe's own record of each charge and refund, from the Reports API (itemized balance activity). Stripe
// builds it from its balance ledger, not from the charges list the sync reads, so its totals are an independent
// check. Only four columns are asked for: never a customer, card, address or description column.
// A restricted key needs the read permission report_runs_and_report_types_read. Live mode only: Stripe does not run
// reports for test keys or sandboxes.
export type ActivityRow = { reportingCategory: string; currency: string; gross: number; chargeCreated: string | null }
export type ReportRun = { id: string; status: 'pending' | 'succeeded' | 'failed'; url: string | null }
export const ACTIVITY_REPORT = 'balance_change_from_activity.itemized.3'
// customer_facing_* are the charge's own currency and amount (what the sync stores), not the settlement currency.
export const ACTIVITY_COLUMNS = ['reporting_category', 'customer_facing_currency', 'customer_facing_amount', 'charge_created_utc', 'created_utc']

// Splits one CSV line, quotes and commas inside quotes included.
function csvLine(line: string) {
  const out: string[] = []
  let cell = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { out.push(cell); cell = '' } else cell += c
  }
  out.push(cell)
  return out.map((x) => x.trim())
}

export function parseActivityCsv(csv: string): ActivityRow[] {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean)
  if (!lines.length) return []
  const head = csvLine(lines[0]!)
  const idx = ACTIVITY_COLUMNS.map((c) => head.indexOf(c))
  if (idx.some((i) => i < 0)) throw new CliError('Stripe\'s activity report did not have the expected columns.', 'cosmic feedback "stripe activity report columns"', 'stripe_report_columns')
  const [cat, cur, gross, created, own] = idx as [number, number, number, number, number]
  return lines.slice(1).map((l) => {
    const f = csvLine(l)
    const category = f[cat]!
    // A charge row's own time is its charge time when Stripe leaves charge_created_utc empty.
    const chargeCreated = f[created] ? f[created]! : category === 'charge' && f[own] ? f[own]! : null
    return { reportingCategory: category, currency: (f[cur] ?? '').toLowerCase(), gross: Number(f[gross]), chargeCreated }
  })
}

// Per month of charge creation: Stripe's charge count, gross, and the refunds against those charges (negative).
export type ReportMonth = { month: string; currency: string; charges: number; gross: number; refunds: number; unplaced: number }
// Summed in minor units, so an exact comparison is not thrown off by floating point.
const cents = (n: number) => Math.round(n * 100)
export function monthTotals(rows: ActivityRow[]): ReportMonth[] {
  const by = new Map<string, { month: string; currency: string; charges: number; gross: number; refunds: number; unplaced: number }>()
  const get = (month: string, currency: string) => {
    const key = `${month}\0${currency}`
    const m = by.get(key) ?? { month, currency, charges: 0, gross: 0, refunds: 0, unplaced: 0 }
    by.set(key, m)
    return m
  }
  for (const r of rows) {
    const counted = ['charge', 'charge_failure', 'refund', 'refund_failure'].includes(r.reportingCategory)
    if (!counted) continue
    // A row that cannot be placed in a month makes that currency's totals unknown, never silently smaller.
    if (!r.chargeCreated) { get('?', r.currency).unplaced++; continue }
    const m = get(r.chargeCreated.slice(0, 7), r.currency)
    const amount = Math.abs(cents(r.gross))
    // A bank debit that fails after posting is a charge row followed by a charge_failure row: no sale.
    if (r.reportingCategory === 'charge') { m.charges += 1; m.gross += amount }
    else if (r.reportingCategory === 'charge_failure') { m.charges -= 1; m.gross -= amount }
    else if (r.reportingCategory === 'refund') m.refunds -= amount
    else m.refunds += amount
  }
  return [...by.values()].map((m) => ({ ...m, gross: m.gross / 100, refunds: m.refunds / 100 }))
}

const fetchText = async (url: string, init: RequestInit, label: string) => {
  const res = await fetch(url, init)
  const text = await res.text()
  if (!res.ok) throw new HttpError(label, res.status, text.slice(0, 400))
  return text
}

export class Stripe {
  constructor(private key: string, private fetcher = fetchJson, private textFetcher = fetchText) {}

  get mode() {
    return stripeMode(this.key)
  }

  private post(path: string, form: Record<string, string>, label: string) {
    return this.fetcher(`${apiBase('stripe', API)}${path}`, { method: 'POST', headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() }, label)
  }

  /** The range Stripe's activity report has data for, in epoch seconds. Null when the key lacks the permission. */
  async activityAvailability(): Promise<{ start: number; end: number } | null> {
    try {
      const t = await this.get(`/reporting/report_types/${ACTIVITY_REPORT}`, {}, 'Stripe report type request')
      return typeof t.data_available_end === 'number' ? { start: Number(t.data_available_start ?? 0), end: t.data_available_end } : null
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return null
      throw e
    }
  }

  /** Starts a run of the itemized activity report for [start, end) in UTC. Null when the key lacks the permission. */
  async startActivityRun(start: number, end: number): Promise<ReportRun | null> {
    try {
      const cols = Object.fromEntries(ACTIVITY_COLUMNS.map((c, i) => [`parameters[columns][${i}]`, c]))
      const r = await this.post('/reporting/report_runs', { report_type: ACTIVITY_REPORT, 'parameters[interval_start]': String(start), 'parameters[interval_end]': String(end), 'parameters[timezone]': 'Etc/UTC', ...cols }, 'Stripe report run request')
      return { id: String(r.id), status: r.status, url: r.result?.url ?? null }
    } catch (e) {
      // Only a refused key means a missing permission. Any other refusal is reported with Stripe's own message.
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return null
      throw e
    }
  }

  async reportRun(id: string): Promise<ReportRun> {
    const r = await this.get(`/reporting/report_runs/${encodeURIComponent(id)}`, {}, 'Stripe report run status request')
    return { id: String(r.id), status: r.status, url: r.result?.url ?? null }
  }

  async reportRows(url: string): Promise<ActivityRow[]> {
    if (!/^https:\/\/files\.stripe\.com\//.test(url)) throw new CliError('Stripe gave a report file address that is not on files.stripe.com.', 'cosmic feedback "stripe report url"', 'stripe_report_url')
    return parseActivityCsv(await this.textFetcher(url, { headers: { authorization: `Bearer ${this.key}` } }, 'Stripe report file request'))
  }


  private async get(path: string, params: Record<string, string>, label: string) {
    const qs = new URLSearchParams(params).toString()
    return this.fetcher(`${apiBase('stripe', API)}${path}?${qs}`, { headers: { authorization: `Bearer ${this.key}` } }, label)
  }

  // Walks every page. Stripe lists newest first and pages with starting_after.
  async all<T extends { id: string }>(path: string, params: Record<string, string>, label: string): Promise<T[]> {
    const out: T[] = []
    let after: string | undefined
    for (;;) {
      const body = await this.get(path, { limit: '100', ...params, ...(after ? { starting_after: after } : {}) }, label)
      const page: T[] = body.data ?? []
      out.push(...page)
      if (!body.has_more || !page.length) return out
      after = page[page.length - 1]!.id
    }
  }

  charges() {
    return this.all<RawCharge>('/charges', {}, 'Stripe charges request')
  }

  // Returns null when the key has no permission for subscriptions, so a
  // charges-only restricted key still syncs.
  async subscriptions(): Promise<RawSubscription[] | null> {
    try {
      return await this.all<RawSubscription>('/subscriptions', { status: 'all' }, 'Stripe subscriptions request')
    } catch (e) {
      if (e instanceof HttpError && e.status === 403) return null
      throw e
    }
  }

  // Proves the key can read charges before anything is saved.
  async check() {
    try {
      await this.get('/charges', { limit: '1' }, 'Stripe charges check')
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        throw new CliError('Stripe refused this key for charges.', 'Create a restricted key with Read on Charges and Subscriptions, then connect again.', e.status === 401 ? 'key_rejected' : 'stripe_key')
      }
      throw e
    }
    const subs = await this.get('/subscriptions', { limit: '1', status: 'all' }, 'Stripe subscriptions check').then(() => true, (e) => {
      if (e instanceof HttpError && e.status === 403) return false
      throw e
    })
    return { subscriptions: subs }
  }
}

const hash = (id: string) => createHash('sha256').update(id).digest('hex')
const day = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 10)
const money = (n: number) => Math.round(n * 100) / 100

// Pure, so tests can pin every rule. Customer ids are hashed in memory and
// leave this function only as counts. Refunds count against the day of the
// charge, not the day of the refund, so a day's net only ever goes down.
export function aggregateCharges(charges: RawCharge[]): StripeDaily[] {
  const seen = new Set<string>()
  const daily = new Map<string, StripeDaily>()
  for (const c of [...charges].sort((a, b) => a.created - b.created)) {
    if (c.status !== 'succeeded' && c.status !== 'failed') continue
    // An authorization never captured is not a sale, and Stripe's ledger has no row for it.
    if (c.status === 'succeeded' && c.captured === false) continue
    const date = day(c.created)
    const currency = c.currency.toLowerCase()
    const id = `${date}|${currency}`
    const d = daily.get(id) ?? { date, currency, charges: 0, gross: 0, refunded: 0, net: 0, failed: 0, newCustomers: 0, returningCharges: 0, guestCharges: 0 }
    if (c.status === 'failed') {
      d.failed++
    } else {
      // Gross stays the charge amount, as in 0.20.0: on API versions before 2025-03-31.basil Stripe records the
      // uncaptured part of a partial capture as a refund, so subtracting amount_refunded from a captured gross would
      // remove it twice. A partial capture then does not match Stripe's report, and its month is withheld.
      const gross = toMajor(c.amount, currency)
      const refunded = toMajor(c.amount_refunded, currency)
      d.charges++
      d.gross = money(d.gross + gross)
      d.refunded = money(d.refunded + refunded)
      d.net = money(d.gross - d.refunded)
      const key = c.customer ? hash(c.customer) : null
      if (!key) d.guestCharges++
      else if (seen.has(key)) d.returningCharges++
      else {
        seen.add(key)
        d.newCustomers++
      }
    }
    daily.set(id, d)
  }
  return [...daily.values()]
}

const MONTHS_PER: Record<string, number> = { day: 12 / 365, week: 12 / 52, month: 1, year: 12 }

// Monthly recurring revenue as Stripe defines the base of it: active and
// past_due subscriptions, list price times quantity, scaled to a month.
// Discounts and tiered prices are not applied; tiered items are counted in
// unpricedItems so the number never claims more than it knows.
export function aggregateSubscriptions(subs: RawSubscription[]): { daily: StripeSubsDaily[]; mrr: StripeMrr[] } {
  const daily = new Map<string, StripeSubsDaily>()
  const bump = (date: string, currency: string, field: 'started' | 'ended') => {
    const id = `${date}|${currency}`
    const d = daily.get(id) ?? { date, currency, started: 0, ended: 0 }
    d[field]++
    daily.set(id, d)
  }
  const mrr = new Map<string, StripeMrr>()
  for (const s of subs) {
    const currency = s.currency.toLowerCase()
    if (s.status !== 'incomplete_expired') bump(day(s.created), currency, 'started')
    if (s.ended_at && s.status !== 'incomplete_expired') bump(day(s.ended_at), currency, 'ended')
    if (s.status !== 'active' && s.status !== 'past_due') continue
    const m = mrr.get(currency) ?? { currency, active: 0, mrr: 0, unpricedItems: 0 }
    m.active++
    for (const item of s.items.data) {
      const p = item.price
      const per = p.recurring ? MONTHS_PER[p.recurring.interval] : undefined
      if (p.unit_amount === null || !p.recurring || per === undefined) {
        m.unpricedItems++
        continue
      }
      const monthly = (toMajor(p.unit_amount, currency) * (item.quantity ?? 1)) / (per * p.recurring.interval_count)
      m.mrr = money(m.mrr + monthly)
    }
    mrr.set(currency, m)
  }
  return { daily: [...daily.values()], mrr: [...mrr.values()] }
}
