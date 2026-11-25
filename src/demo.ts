import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite } from './db.js'
import { syncShopify } from './sync.js'
import { reconcile } from './reconcile.js'
import { auditFlows, auditHtml, revenuePerFlow, revenueHtml } from './reports.js'
import type { RawOrder } from './sources/shopify.js'

const DAY = 86400000
const FLOWS = [
  { id: 'F1', name: 'Welcome Series', status: 'live', recipients: 42, revenuePerDay: 310 },
  { id: 'F2', name: 'Abandoned Checkout', status: 'live', recipients: 18, revenuePerDay: 420 },
  { id: 'F3', name: 'Post-Purchase Thank You', status: 'live', recipients: 25, revenuePerDay: 60 },
  { id: 'F4', name: 'Win-Back', status: 'draft', recipients: 0, revenuePerDay: 0 },
]

// Fixed numbers, so the demo is the same every run. All of it is invented, and
// every line of output says so.
export function sampleOrders(): RawOrder[] {
  const out: RawOrder[] = []
  for (let d = 200; d >= 1; d--) {
    for (let n = 0; n < 3 + (d % 3); n++) {
      out.push({
        processedAt: new Date(Date.now() - d * DAY).toISOString(),
        cancelledAt: null,
        customer: { id: `sample-${(d * 7 + n * 13) % 90}` },
        currentTotalPriceSet: { shopMoney: { amount: String(48 + ((d + n) % 5) * 12) } },
        totalDiscountsSet: { shopMoney: { amount: '0.00' } },
      })
    }
  }
  return out
}

// The store demo is a store whatever this workspace is.
const STORE = { type: 'shopify' as const, reference: 'shopify' as const, referenceSet: false, title: 'Shopify store' }

export async function runDemo(opts: { html?: string; write: (path: string, html: string) => void }) {
  const db = wrapPglite(await PGlite.create())
  try {
    await migrate(db)
    const orders = sampleOrders()
    // The planted fault: Shopify reports more orders than the sync received.
    await syncShopify(db, async () => orders.slice(0, -14), async () => orders.length)
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('demo', 'klaviyo', now(), now(), 'ok')`)
    for (const f of FLOWS) {
      await db.query(`INSERT INTO dim_flow (flow_id, name, status, archived, source_synced_at) VALUES ($1,$2,$3,false,now())`, [f.id, f.name, f.status])
      if (!f.recipients) continue
      for (let d = 80; d >= 1; d--) {
        const fade = f.id === 'F3' && d <= 30 ? 0.4 : 1
        await db.query(
          `INSERT INTO fact_flow_daily (flow_id, flow_message_id, channel, date, recipients, revenue, conversions, source_synced_at) VALUES ($1,$2,'email',CURRENT_DATE - $3::int,$4,$5,$6,now())`,
          [f.id, `${f.id}-M1`, d, f.recipients, Math.round(f.revenuePerDay * fade), 2],
        )
      }
    }

    const broken = await reconcile(db, tolerances(), STORE)
    await syncShopify(db, async () => orders, async () => orders.length)
    const days = await db.query(`SELECT date, orders FROM fact_orders_daily WHERE date >= CURRENT_DATE - 90`)
    for (const r of days) await db.query(`INSERT INTO fact_klaviyo_orders_daily VALUES ($1,$2,$3,now())`, [r.date, r.orders, 0])
    const fixed = await reconcile(db, tolerances(), STORE)
    const revenue = await revenuePerFlow(db)
    const audit = await auditFlows(db)
    if (opts.html) {
      const auditBody = auditHtml(audit).match(/<main>([\s\S]*)<\/main>/)?.[1] ?? ''
      opts.write(opts.html, revenueHtml(revenue).replace('</main>', `${auditBody}</main>`))
    }
    return { sample: true, broken, fixed, revenue, audit }
  } finally {
    await db.close()
  }
}

// 0.14.0: a demo for each kind of business that is not a Shopify store. Same promise: fixed
// invented numbers, a planted fault the trust gate catches, then the checks passing.
import { writeStripe, writeHubspot } from './sync.js'
import { runMetric, PACKS } from './metrics.js'
import { tolerances, trustLine } from './reconcile.js'
import type { RawCharge, RawSubscription } from './sources/stripe.js'
import type { RawContact, RawDeal } from './sources/hubspot.js'
import type { Db } from './db.js'
import { TYPES, type WorkspaceType } from './workspace.js'

const epoch = (daysAgo: number, n = 0) => Math.floor((Date.now() - daysAgo * DAY) / 1000) - n * 60

export function sampleStripe(): { charges: RawCharge[]; subs: RawSubscription[] } {
  const charges: RawCharge[] = []
  const subs: RawSubscription[] = []
  // 120 customers subscribe over 200 days at $49 or $99 a month. One in six cancels.
  for (let i = 0; i < 120; i++) {
    const startedAgo = 200 - Math.floor(i * 1.6)
    const price = i % 3 === 0 ? 9900 : 4900
    const ends = i % 6 === 5 ? Math.max(1, startedAgo - 45) : null
    subs.push({ id: `sub_${i}`, created: epoch(startedAgo), status: ends ? 'canceled' : i % 25 === 7 ? 'past_due' : 'active', ended_at: ends ? epoch(ends) : null, currency: 'usd', items: { data: [{ quantity: 1, price: { unit_amount: price, recurring: { interval: 'month', interval_count: 1 } } }] } })
    for (let ago = startedAgo; ago >= (ends ?? 1); ago -= 30) {
      charges.push({ id: `ch_${i}_${ago}`, created: epoch(ago, i % 7), amount: price, amount_refunded: 0, currency: 'usd', status: 'succeeded', customer: `cus_${i}` })
    }
    if (i % 9 === 4) charges.push({ id: `ch_${i}_failed`, created: epoch(Math.max(1, startedAgo - 31)), amount: price, amount_refunded: 0, currency: 'usd', status: 'failed', customer: `cus_${i}` })
  }
  return { charges, subs }
}

export function sampleHubspot(): { deals: RawDeal[]; contacts: RawContact[] } {
  const sources = ['PAID_SEARCH', 'ORGANIC_SEARCH', 'PAID_SOCIAL', 'REFERRALS', 'OFFLINE']
  const iso = (ago: number) => new Date(Date.now() - ago * DAY).toISOString()
  const contacts: RawContact[] = []
  for (let i = 0; i < 600; i++) {
    const ago = 1 + ((i * 37) % 180)
    contacts.push({ id: `c${i}`, properties: { createdate: iso(ago), hs_analytics_source: sources[i % 5]!, lifecyclestage: i % 11 === 0 ? 'customer' : i % 4 === 0 ? 'opportunity' : i % 3 === 0 ? 'marketingqualifiedlead' : 'lead' } })
  }
  const deals: RawDeal[] = []
  for (let i = 0; i < 240; i++) {
    const ago = 2 + ((i * 29) % 170)
    const amount = String(4000 + (i % 7) * 2500)
    const outcome = i % 5
    const closed = outcome === 0 || outcome === 1
    deals.push({ id: `d${i}`, properties: { createdate: iso(ago), closedate: closed ? iso(Math.max(1, ago - 21)) : null, amount, deal_currency_code: 'USD', pipeline: 'default', dealstage: closed ? (outcome === 0 ? 'closedwon' : 'closedlost') : ['qualifiedtobuy', 'presentationscheduled', 'contractsent'][i % 3]!, hs_is_closed: closed ? 'true' : 'false', hs_is_closed_won: outcome === 0 ? 'true' : 'false', hs_analytics_source: sources[(i * 3) % 5]! } })
  }
  return { deals, contacts }
}

async function sampleMeta(db: Db, purchasesPerDay: number) {
  for (let d = 90; d >= 1; d--) {
    await db.query(`INSERT INTO fact_meta_ads_daily VALUES (CURRENT_DATE - $1::int, 'C1', 'Sample campaign', $2, $3, $4, $5, $6, 'USD', 'act_sample', now())`, [d, 120 + (d % 4) * 15, 9000 + d * 10, 140 + (d % 5) * 9, purchasesPerDay, purchasesPerDay * 70])
  }
  await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('demo-meta', 'meta', now(), now(), 'ok')`)
}

const setTotal = (db: Db, source: string, metric: string, value: number) =>
  db.query(`INSERT INTO meta_source_total VALUES ($1,$2,$3,now()) ON CONFLICT (source, metric) DO UPDATE SET value = EXCLUDED.value`, [source, metric, value])

export const DEMO_TYPES = ['shopify', 'saas', 'b2b'] as const
export type DemoType = (typeof DEMO_TYPES)[number]
// Every Stripe-led type (ecommerce, creator, an agency client) shares the SaaS demo.
export const demoFor = (t: WorkspaceType): DemoType => (t === 'shopify' ? 'shopify' : t === 'b2b' ? 'b2b' : 'saas')

export async function runTypeDemo(type: 'saas' | 'b2b') {
  const db = wrapPglite(await PGlite.create())
  const ws = { type, reference: type === 'saas' ? ('stripe' as const) : ('hubspot' as const), referenceSet: false, title: TYPES[type].title }
  try {
    await migrate(db)
    const t = tolerances()
    let broken
    if (type === 'saas') {
      const { charges, subs } = sampleStripe()
      // The planted fault: the daily table is written from a pull that lost its last 6 charges.
      await writeStripe(db, charges.slice(6), subs)
      await setTotal(db, 'stripe', 'charges_counted', charges.filter((c) => c.status === 'succeeded' || c.status === 'failed').length)
      await setTotal(db, 'stripe', 'subscriptions_open', subs.filter((s) => !s.ended_at).length)
      await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('demo-stripe', 'stripe', now(), now(), 'ok')`)
      await sampleMeta(db, 3)
      broken = await reconcile(db, t, ws)
      await writeStripe(db, charges, subs)
      // MRR history builds up one sync a day. Pretend there was a sync 120 days ago.
      await db.query(`INSERT INTO fact_stripe_mrr VALUES (CURRENT_DATE - 120, 'usd', 61, 4182, 0, now())`)
    } else {
      const { deals, contacts } = sampleHubspot()
      // The planted fault: HubSpot says it holds 240 deals, and the pull received 228.
      await writeHubspot(db, deals.slice(12), contacts, 'usd')
      await setTotal(db, 'hubspot', 'deals_reported', deals.length)
      await setTotal(db, 'hubspot', 'deals_pulled', deals.length - 12)
      await setTotal(db, 'hubspot', 'contacts_reported', contacts.length)
      await setTotal(db, 'hubspot', 'contacts_pulled', contacts.length)
      await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('demo-hubspot', 'hubspot', now(), now(), 'ok')`)
      await sampleMeta(db, 1)
      broken = await reconcile(db, t, ws)
      await writeHubspot(db, deals, contacts, 'usd')
      await setTotal(db, 'hubspot', 'deals_pulled', deals.length)
    }
    const fixed = await reconcile(db, t, ws)
    const metrics = []
    for (const name of PACKS[type].slice(0, 10)) metrics.push(await runMetric(db, name, 90))
    const bySource = type === 'b2b'
      ? (await db.query(`SELECT source, sum(deals_created)::int AS deals, sum(amount_created)::float AS pipeline FROM fact_crm_deals_daily WHERE date >= CURRENT_DATE - 90 GROUP BY source ORDER BY pipeline DESC`)).map((r) => ({ source: String(r.source), deals: Number(r.deals), pipeline: Number(r.pipeline) }))
      : []
    return { sample: true, type, broken, fixed, metrics, bySource, trust: await trustLine(db) }
  } finally {
    await db.close()
  }
}
