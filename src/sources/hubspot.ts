import { fetchJson, HttpError } from '../http.js'
import { CliError } from '../errors.js'
import { apiBase } from './api-base.js'

// HubSpot CRM, read-only, aggregates only. Written from the CRM API v3 docs
// (https://developers.hubspot.com/docs/api/crm/understanding-the-crm) and tested against
// recorded answers in that shape. It has not run on a real portal.
//
// Privacy by request, not by filter: the list calls name the properties they want, and
// none of them is a name, email, phone, company name or address. HubSpot returns only the
// properties asked for (plus its own id and dates). Ids are used to count in memory and
// are never written: what leaves this file is daily counts and amounts.

export const DEAL_PROPERTIES = ['createdate', 'closedate', 'amount', 'deal_currency_code', 'dealstage', 'pipeline', 'hs_is_closed', 'hs_is_closed_won', 'hs_analytics_source']
export const CONTACT_PROPERTIES = ['createdate', 'lifecyclestage', 'hs_analytics_source']

export type RawDeal = { id: string; properties: Record<string, string | null | undefined> }
export type RawContact = { id: string; properties: Record<string, string | null | undefined> }

export type DealsDaily = { date: string; currency: string; pipeline: string; source: string; created: number; amountCreated: number; won: number; lost: number; wonAmount: number }
export type OpenPipeline = { currency: string; pipeline: string; stage: string; deals: number; amount: number }
export type ContactsDaily = { date: string; source: string; stage: string; contacts: number }

const money = (n: number) => Math.round(n * 100) / 100
// HubSpot sends dates as ISO strings, and older portals sometimes as epoch milliseconds.
const toDay = (v: string | null | undefined) => {
  if (!v) return null
  const t = /^\d{10,}$/.test(v) ? Number(v) : Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null
}
const label = (v: string | null | undefined, fallback: string) => (v && v.trim() ? v.trim().slice(0, 80) : fallback)
const amountOf = (v: string | null | undefined) => {
  const n = Number(v)
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : 0
}

// Pure, so tests can pin every rule. A deal counts as created on its create date and as won
// or lost on its close date. Open deals are a snapshot: what is open right now, by stage.
export function aggregateDeals(deals: RawDeal[], portalCurrency: string): { daily: DealsDaily[]; open: OpenPipeline[] } {
  const daily = new Map<string, DealsDaily>()
  const open = new Map<string, OpenPipeline>()
  const seen = new Set<string>()
  const row = (date: string, currency: string, pipeline: string, source: string) => {
    const id = `${date}|${currency}|${pipeline}|${source}`
    const d = daily.get(id) ?? { date, currency, pipeline, source, created: 0, amountCreated: 0, won: 0, lost: 0, wonAmount: 0 }
    daily.set(id, d)
    return d
  }
  for (const deal of deals) {
    if (seen.has(deal.id)) continue
    seen.add(deal.id)
    const p = deal.properties ?? {}
    const currency = label(p.deal_currency_code, portalCurrency).toLowerCase()
    const pipeline = label(p.pipeline, 'default')
    const source = label(p.hs_analytics_source, 'UNKNOWN')
    const amount = amountOf(p.amount)
    const created = toDay(p.createdate)
    if (created) {
      const d = row(created, currency, pipeline, source)
      d.created++
      d.amountCreated = money(d.amountCreated + amount)
    }
    const closed = p.hs_is_closed === 'true'
    const won = p.hs_is_closed_won === 'true'
    const closeDay = toDay(p.closedate)
    if ((closed || won) && closeDay) {
      const d = row(closeDay, currency, pipeline, source)
      if (won) {
        d.won++
        d.wonAmount = money(d.wonAmount + amount)
      } else d.lost++
    }
    if (!closed && !won) {
      const stage = label(p.dealstage, 'unknown')
      const id = `${currency}|${pipeline}|${stage}`
      const o = open.get(id) ?? { currency, pipeline, stage, deals: 0, amount: 0 }
      o.deals++
      o.amount = money(o.amount + amount)
      open.set(id, o)
    }
  }
  return { daily: [...daily.values()], open: [...open.values()] }
}

// A contact counts on its create date, under its original source and its stage today.
export function aggregateContacts(contacts: RawContact[]): ContactsDaily[] {
  const out = new Map<string, ContactsDaily>()
  const seen = new Set<string>()
  for (const c of contacts) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    const p = c.properties ?? {}
    const date = toDay(p.createdate)
    if (!date) continue
    const source = label(p.hs_analytics_source, 'UNKNOWN')
    const stage = label(p.lifecyclestage, 'unknown')
    const id = `${date}|${source}|${stage}`
    const d = out.get(id) ?? { date, source, stage, contacts: 0 }
    d.contacts++
    out.set(id, d)
  }
  return [...out.values()]
}

export const uniqueCount = (rows: { id: string }[]) => new Set(rows.map((r) => r.id)).size

export class HubSpot {
  private base: string
  constructor(private token: string, private fetcher = fetchJson) {
    this.base = apiBase('hubspot', 'https://api.hubapi.com')
  }

  private headers() {
    return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }
  }

  // Walks every page of a list call. HubSpot pages with paging.next.after.
  async list(object: 'deals' | 'contacts', properties: string[]): Promise<RawDeal[]> {
    const out: RawDeal[] = []
    let after: string | undefined
    for (let page = 0; page < 100000; page++) {
      const qs = new URLSearchParams({ limit: '100', archived: 'false', properties: properties.join(','), ...(after ? { after } : {}) })
      const body = await this.fetcher(`${this.base}/crm/v3/objects/${object}?${qs}`, { headers: this.headers() }, `HubSpot ${object} request`)
      for (const r of body.results ?? []) out.push({ id: String(r.id), properties: pick(r.properties ?? {}, properties) })
      after = body.paging?.next?.after
      if (!after) return out
    }
    return out
  }

  // HubSpot's own count of an object, from the search endpoint, so the trust gate can prove the
  // list pull got every row. Returns null when the portal gives no total.
  async total(object: 'deals' | 'contacts'): Promise<number | null> {
    const body = await this.fetcher(`${this.base}/crm/v3/objects/${object}/search`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ limit: 1, properties: ['createdate'] }) }, `HubSpot ${object} count`)
    return typeof body.total === 'number' ? body.total : null
  }

  deals() {
    return this.list('deals', DEAL_PROPERTIES)
  }

  contacts() {
    return this.list('contacts', CONTACT_PROPERTIES)
  }

  // Proves the token can read deals and contacts before anything is saved. The portal's
  // company currency is read when the token may, else deals without a currency count as usd.
  async check(): Promise<{ portal: string; currency: string }> {
    for (const object of ['deals', 'contacts'] as const) {
      try {
        await this.fetcher(`${this.base}/crm/v3/objects/${object}?limit=1&properties=createdate`, { headers: this.headers() }, `HubSpot ${object} check`)
      } catch (e) {
        if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
          throw new CliError(`HubSpot refused this token for ${object}.`, 'Make a private app with crm.objects.deals.read and crm.objects.contacts.read only, then connect again.', e.status === 401 ? 'key_rejected' : 'hubspot_scope')
        }
        throw e
      }
    }
    let portal = ''
    let currency = 'usd'
    try {
      const a = await this.fetcher(`${this.base}/account-info/v3/details`, { headers: this.headers() }, 'HubSpot account check')
      portal = String(a.portalId ?? '')
      if (typeof a.companyCurrency === 'string' && a.companyCurrency) currency = a.companyCurrency.toLowerCase()
    } catch {
      // Account details need no extra scope on most portals. Without them the sync still works.
    }
    return { portal, currency }
  }
}

// Only the properties asked for are kept, even if HubSpot sends more.
function pick(props: Record<string, unknown>, keep: string[]) {
  const out: Record<string, string | null> = {}
  for (const k of keep) out[k] = props[k] === undefined || props[k] === null ? null : String(props[k])
  return out
}
