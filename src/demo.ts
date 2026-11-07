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

    const broken = await reconcile(db)
    await syncShopify(db, async () => orders, async () => orders.length)
    const days = await db.query(`SELECT date, orders FROM fact_orders_daily WHERE date >= CURRENT_DATE - 90`)
    for (const r of days) await db.query(`INSERT INTO fact_klaviyo_orders_daily VALUES ($1,$2,$3,now())`, [r.date, r.orders, 0])
    const fixed = await reconcile(db)
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
