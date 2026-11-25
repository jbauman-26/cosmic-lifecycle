import type { Db, Tx } from './db.js'
import { settingValue } from './config.js'
import { readWorkspace, REFERENCE_NAME, type Workspace } from './workspace.js'
import { readCosts } from './costs.js'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped'
export type Check = { name: string; status: CheckStatus; expected: number | null; actual: number | null; diffPct: number | null; detail: string }

// The defaults. Each one can be changed with lifecycle config set, see tolerances().
export const TOLERANCE = { klaviyoOrders: 3, ga4Purchases: 15, attributedShareFlag: 60, freshnessDays: 2 }
export type Tolerances = typeof TOLERANCE & { days: number; adClaimFlag?: number }
// Read on its own, not in tolerances(), so a store's tolerances read exactly as in 0.13.
const adClaimFlag = (t: Tolerances) => t.adClaimFlag ?? settingValue('reconcile.ad_claim_flag')

export function tolerances(): Tolerances {
  return {
    klaviyoOrders: settingValue('reconcile.tolerance.klaviyo_orders'),
    ga4Purchases: settingValue('reconcile.tolerance.ga4_purchases'),
    attributedShareFlag: settingValue('reconcile.attributed_share_flag'),
    freshnessDays: settingValue('reconcile.freshness_days'),
    days: settingValue('metrics.default_days'),
  }
}

const pct = (expected: number, actual: number) => (expected === 0 ? (actual === 0 ? 0 : 100) : (Math.abs(expected - actual) / expected) * 100)
const round = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))

export function compare(name: string, expected: number, actual: number, tolerancePct: number, label: string): Check {
  const diffPct = round(pct(expected, actual))
  const status: CheckStatus = diffPct <= tolerancePct ? 'pass' : 'fail'
  const detail = status === 'pass'
    ? `${label}: ${actual} against ${expected}, within ${tolerancePct}%.`
    : `${label}: ${actual} against ${expected}, off by ${diffPct}%. Do not trust reports built on this until it is fixed.`
  return { name, status, expected, actual, diffPct, detail }
}

const skip = (name: string, detail: string): Check => ({ name, status: 'skipped', expected: null, actual: null, diffPct: null, detail })

const one = async (db: Tx, sql: string, params: unknown[] = []) => (await db.query(sql, params))[0] ?? {}

// A source whose latest entry is a disconnect is left out, so removing a source never turns
// into a stale warning two days later. Shared by every workspace type.
// A source whose latest entry is a disconnect is left out, so removing a source never turns into a stale
// warning two days later. A Shopify run that only waited on an order export brought nothing new, so it does not count as fresh.
async function freshness(db: Tx, t: Tolerances): Promise<Check> {
  const last = await db.query(
    `SELECT source, max(finished_at) AS at FROM meta_sync_run r WHERE status NOT IN ('failed', 'disconnected', 'running') AND coalesce(code, '') <> 'export_running'
       AND NOT EXISTS (SELECT 1 FROM meta_sync_run d WHERE d.source = r.source AND d.status = 'disconnected'
         AND d.started_at >= (SELECT max(x.started_at) FROM meta_sync_run x WHERE x.source = r.source))
     GROUP BY source`,
  )
  if (!last.length) return skip('freshness', 'Nothing has synced yet.')
  const ages = last.map((r) => ({ source: String(r.source), days: (Date.now() - new Date(r.at as string).getTime()) / 86400000 }))
  const stale = ages.filter((a) => a.days > t.freshnessDays)
  return {
    name: 'freshness', status: stale.length ? 'fail' : 'pass', expected: t.freshnessDays, actual: round(Math.max(...ages.map((a) => a.days))), diffPct: null,
    detail: stale.length ? `Stale: ${stale.map((s) => s.source).join(', ')}.` : `All connected sources synced within ${t.freshnessDays} day${t.freshnessDays === 1 ? '' : 's'}.`,
  }
}

export async function runChecks(db: Tx, t: Tolerances = tolerances()): Promise<Check[]> {
  const checks: Check[] = []
  const days = t.days
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)

  // 1. Did the pull get everything Shopify says exists? This is the check that
  // would have caught a silent gap in a page table like the one we once measured.
  const totals = await db.query(`SELECT metric, value FROM meta_source_total WHERE source = 'shopify'`)
  const total = totals.find((t) => t.metric === 'orders_reported')
  const pulled = totals.find((t) => t.metric === 'orders_pulled')
  // Two stored totals can agree while the daily table is missing days, so the check also counts the rows the
  // reports read: every pulled order that was not cancelled must sit in a day. orders_kept is written by each sync
  // path; a store synced before it existed compares against everything pulled and says how to make it exact.
  const kept = totals.find((t) => t.metric === 'orders_kept')
  const daily = await one(db, `SELECT sum(orders) AS orders FROM fact_orders_daily`)
  let complete: Check
  if (!total || !pulled) complete = skip('orders_complete', 'Shopify has not been synced, or gave no exact count.')
  else {
    complete = compare('orders_complete', num(total.value), num(pulled.value), 0, 'Orders pulled against Shopify’s own count')
    if (complete.status === 'pass') {
      const inDays = num(daily.orders)
      const expected = kept ? num(kept.value) : num(pulled.value)
      const days = compare('orders_complete', expected, inDays, 0, kept ? 'Orders in the daily totals against orders pulled and not cancelled' : 'Orders in the daily totals against orders pulled')
      if (days.status === 'fail') complete = kept ? days : { ...days, detail: `${days.detail} Cancelled orders are left out of the daily totals; sync Shopify again so the check can count them exactly.` }
    }
  }
  checks.push(complete)

  // 2. Do the two tables built from those orders agree with each other?
  const d = await one(db, `SELECT sum(new_orders + returning_orders) AS orders, sum(net_revenue) AS net, sum(guest_orders) AS guest FROM fact_orders_daily`)
  const c = await one(db, `SELECT sum(orders) AS orders FROM fact_cohort_monthly`)
  checks.push(d.orders === null || d.orders === undefined
    ? skip('orders_vs_cohorts', 'No Shopify orders stored.')
    : compare('orders_vs_cohorts', num(d.orders), num(c.orders), 0, 'Customer orders in daily totals against cohorts'))

  // 3. Is Klaviyo seeing the same orders as Shopify?
  const so = await one(db, `SELECT sum(orders) AS orders, sum(net_revenue) AS net FROM fact_orders_daily WHERE date >= $1`, [since])
  // Compare only the days Klaviyo was actually pulled for. Otherwise a partial
  // sync reads as missing orders, and the check cries wolf.
  const kw = await one(db, `SELECT window_start::text AS s, window_end::text AS e FROM meta_source_window WHERE source = 'klaviyo' AND metric = 'placed_orders'`)
  const kFrom = kw.s && String(kw.s) > since ? String(kw.s) : since
  const kTo = kw.e ? String(kw.e) : new Date().toISOString().slice(0, 10)
  const period = kFrom === since ? `last ${days} days` : `${kFrom} to ${kTo}, the days Klaviyo was synced for`
  const sk = await one(db, `SELECT sum(orders) AS orders FROM fact_orders_daily WHERE date >= $1 AND date <= $2`, [kFrom, kTo])
  const ko = await one(db, `SELECT sum(placed_orders) AS orders FROM fact_klaviyo_orders_daily WHERE date >= $1 AND date <= $2`, [kFrom, kTo])
  const klaviyoSynced = (await db.query(`SELECT 1 FROM meta_sync_run WHERE source = 'klaviyo' AND status NOT IN ('failed', 'disconnected', 'running') LIMIT 1`)).length > 0
  if (so.orders === null || so.orders === undefined || !klaviyoSynced) checks.push(skip('klaviyo_orders', 'Needs both Shopify and Klaviyo synced.'))
  else if (!num(sk.orders) && !num(ko.orders)) checks.push(skip('klaviyo_orders', `Neither source has orders in ${period}.`))
  else if (num(ko.orders) === 0) {
    checks.push({ name: 'klaviyo_orders', status: 'fail', expected: num(sk.orders), actual: 0, diffPct: 100, detail: `Shopify has ${num(sk.orders)} orders in ${period}, and Klaviyo has none. The store may not be connected to this Klaviyo account.` })
  } else checks.push(compare('klaviyo_orders', num(sk.orders), num(ko.orders), t.klaviyoOrders, `Klaviyo Placed Order against Shopify orders, ${period}`))

  // 4. Is GA4 seeing the same purchases?
  const ga = await one(db, `SELECT sum(purchases) AS purchases FROM fact_ga4_daily WHERE date >= $1`, [since])
  checks.push(ga.purchases === null || ga.purchases === undefined || so.orders === null || so.orders === undefined
    ? skip('ga4_purchases', 'Needs both GA4 and Shopify synced.')
    : compare('ga4_purchases', num(so.orders), num(ga.purchases), t.ga4Purchases, `GA4 purchases against Shopify orders, last ${days} days`))

  // 5. Does the attributed revenue look believable?
  const fl = await one(db, `SELECT sum(revenue) AS revenue FROM fact_flow_daily WHERE date >= $1`, [since])
  if (fl.revenue === null || fl.revenue === undefined || !num(so.net)) checks.push(skip('attributed_share', 'Needs Klaviyo flow revenue and Shopify revenue.'))
  else {
    const share = round((num(fl.revenue) / num(so.net)) * 100)
    checks.push({
      name: 'attributed_share', status: share > t.attributedShareFlag ? 'warn' : 'pass', expected: num(so.net), actual: num(fl.revenue), diffPct: share,
      detail: `Klaviyo attributes ${share}% of Shopify net revenue to flows. This is Klaviyo's attribution, not proof of causation.`,
    })
  }

  // 6. Do the daily flow rows add up to Klaviyo's own totals?
  const w = await one(db, `SELECT min(window_start) AS s, max(window_end) AS e, sum(recipients) AS recipients FROM fact_flow_window`)
  if (w.recipients === null || w.recipients === undefined) checks.push(skip('flow_totals', 'No flow totals from Klaviyo yet.'))
  else {
    const f = await one(db, `SELECT sum(recipients) AS recipients FROM fact_flow_daily WHERE date >= $1 AND date <= $2`, [w.s, w.e])
    checks.push(compare('flow_totals', num(w.recipients), num(f.recipients), 0.5, 'Daily flow recipients against Klaviyo’s flow totals'))
  }

  // 7. Is anything stale?
  checks.push(await freshness(db, t))
  return checks
}

export async function reconcile(db: Db, t: Tolerances = tolerances(), ws: Workspace = readWorkspace()) {
  const checks = ws.type === 'shopify' && ws.reference === 'shopify' ? await runChecks(db, t) : await runReferenceChecks(db, t, ws)
  // Only a store that synced its costs gets this one, after the others, so a store without costs reads as in 0.13.
  const cost = await costCheck(db)
  if (cost) checks.push(cost)
  const at = new Date().toISOString()
  await db.transaction(async (tx) => {
    // A check this workspace no longer runs (the type or the reference changed) would otherwise
    // keep its old result and colour the trust line forever.
    await tx.query(`DELETE FROM meta_reconcile_result WHERE NOT (check_name = ANY($1))`, [checks.map((c) => c.name)])
    for (const c of checks) {
      await tx.query(
        `INSERT INTO meta_reconcile_result VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (check_name) DO UPDATE SET status = EXCLUDED.status, expected = EXCLUDED.expected, actual = EXCLUDED.actual, diff_pct = EXCLUDED.diff_pct, detail = EXCLUDED.detail, checked_at = EXCLUDED.checked_at`,
        [c.name, c.status, c.expected, c.actual, c.diffPct, c.detail, at],
      )
    }
  })
  return { passed: !checks.some((c) => c.status === 'fail'), checks }
}

// Every report calls this, so a number can never appear without its status.
// A Shopify workspace never writes a `reference` row, so its line reads exactly as before 0.14.0.
// Every other workspace writes one, and its line names the source the numbers were checked against,
// or says plainly that there was none: status `unreferenced`, never a failure.
export async function trustLine(db: Tx) {
  const rows = await db.query(`SELECT check_name, status, detail FROM meta_reconcile_result`)
  if (!rows.length) return { status: 'unchecked' as const, line: 'Numbers not checked yet. Run lifecycle reconcile.' }
  const failed = rows.filter((r) => r.status === 'fail').map((r) => String(r.check_name))
  if (failed.length) return { status: 'failed' as const, line: `DO NOT TRUST THESE NUMBERS YET. Failed checks: ${failed.join(', ')}.` }
  const ref = rows.find((r) => r.check_name === REFERENCE_CHECK)
  const others = rows.filter((r) => r.check_name !== REFERENCE_CHECK)
  const skipped = others.filter((r) => r.status === 'skipped').length
  if (!ref) return { status: 'passed' as const, line: `Numbers passed reconciliation${skipped ? `, with ${skipped} checks skipped` : ''}.` }
  if (ref.status !== 'pass') return { status: 'unreferenced' as const, line: String(ref.detail) }
  return { status: 'passed' as const, line: `${String(ref.detail)}${skipped ? ` ${skipped} check${skipped === 1 ? ' was' : 's were'} skipped.` : ''}` }
}

export type TrustStatus = Awaited<ReturnType<typeof trustLine>>['status']

// The row that names what a workspace's numbers were checked against.
export const REFERENCE_CHECK = 'reference'

const synced = async (db: Tx, source: string) =>
  (await db.query(`SELECT 1 FROM meta_sync_run WHERE source = $1 AND status IN ('ok', 'warning') LIMIT 1`, [source])).length > 0
const total = async (db: Tx, source: string, metric: string) => {
  const r = (await db.query(`SELECT value FROM meta_source_total WHERE source = $1 AND metric = $2`, [source, metric]))[0]
  return r ? num(r.value) : null
}

// Checks for every workspace that is not a Shopify store checked against Shopify. Each one compares
// a number against the workspace's reference source, or the reference against its own count.
export async function runReferenceChecks(db: Tx, t: Tolerances, ws: Workspace): Promise<Check[]> {
  const checks: Check[] = []
  const days = t.days
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  const name = REFERENCE_NAME[ws.reference]
  const has = ws.reference === 'none' ? false : await synced(db, ws.reference)

  // The reference itself: is there one, and has it synced?
  if (ws.reference === 'none') {
    checks.push({ name: REFERENCE_CHECK, status: 'skipped', expected: null, actual: null, diffPct: null, detail: 'Not checked against a source of truth: this workspace has no reference source set, so each number is its own tool\'s count. Set one with lifecycle config set workspace.reference stripe, hubspot, shopify or ga4.' })
  } else if (!has) {
    checks.push({ name: REFERENCE_CHECK, status: 'skipped', expected: null, actual: null, diffPct: null, detail: `Not checked against a source of truth yet: ${name} is this workspace's reference and has not synced. Each number is its own tool's count until it does. Connect ${ws.reference}, then lifecycle sync.` })
  } else if (ws.reference === 'ga4') {
    checks.push({ name: REFERENCE_CHECK, status: 'warn', expected: null, actual: null, diffPct: null, detail: 'Checked against GA4 only. GA4 is a tracking tool, not a record of sales or pipeline, so treat these numbers as estimates.' })
  } else {
    checks.push({ name: REFERENCE_CHECK, status: 'pass', expected: null, actual: null, diffPct: null, detail: `Numbers passed reconciliation against ${name}.` })
  }

  if (ws.reference === 'shopify') {
    // A non-store workspace that still keeps its truth in Shopify (an agency client, say) gets the store checks.
    for (const c of await runChecks(db, t)) if (c.name !== 'freshness') checks.push(c)
  }

  if (ws.reference === 'stripe' && has) {
    // Do Stripe's daily rows add up to every charge the pull saw?
    const counted = await total(db, 'stripe', 'charges_counted')
    const d = await one(db, `SELECT sum(charges + failed_charges) AS n FROM fact_stripe_daily`)
    checks.push(counted === null ? skip('stripe_daily_complete', 'Synced before 0.14.0. The next lifecycle sync records the count this check needs.') : compare('stripe_daily_complete', counted, num(d.n), 0, 'Charges in the daily table against every charge pulled from Stripe'))
    // Do subscription starts minus ends match what is open in Stripe right now? Churn is built on these.
    const open = await total(db, 'stripe', 'subscriptions_open')
    const se = await one(db, `SELECT sum(started) AS started, sum(ended) AS ended FROM fact_stripe_subscriptions_daily`)
    if (open === null || se.started === null || se.started === undefined) checks.push(skip('subscriptions_balance', 'No subscriptions synced, or the key cannot read them.'))
    else checks.push(compare('subscriptions_balance', open, num(se.started) - num(se.ended), 0, 'Subscriptions started minus ended against subscriptions open in Stripe'))
    // Does GA4 see the payments? Only where GA4 records purchases at all.
    const ga = await one(db, `SELECT sum(purchases) AS purchases FROM fact_ga4_daily WHERE date >= $1`, [since])
    const sc = await one(db, `SELECT sum(charges) AS charges FROM fact_stripe_daily WHERE date >= $1`, [since])
    if (ga.purchases === null || ga.purchases === undefined) checks.push(skip('ga4_vs_reference', 'Needs GA4 synced.'))
    else if (!num(ga.purchases)) checks.push(skip('ga4_vs_reference', 'GA4 records no purchase events, so there is nothing to compare with Stripe.'))
    else checks.push(compare('ga4_vs_reference', num(sc.charges), num(ga.purchases), t.ga4Purchases, `GA4 purchases against Stripe successful charges, last ${days} days`))
  }

  if (ws.reference === 'hubspot' && has) {
    for (const object of ['deals', 'contacts'] as const) {
      const reported = await total(db, 'hubspot', `${object}_reported`)
      const pulled = await total(db, 'hubspot', `${object}_pulled`)
      checks.push(reported === null || pulled === null ? skip(`${object}_complete`, `HubSpot gave no count of its ${object}.`) : compare(`${object}_complete`, reported, pulled, 0, `${object === 'deals' ? 'Deals' : 'Contacts'} pulled against HubSpot's own count`))
    }
    const pulled = await total(db, 'hubspot', 'deals_pulled')
    const d = await one(db, `SELECT sum(deals_created) AS n FROM fact_crm_deals_daily`)
    // A deal with no create date is counted as pulled but has no day, so allow a sliver.
    checks.push(pulled === null ? skip('deals_daily_vs_pulled', 'No HubSpot deals synced.') : compare('deals_daily_vs_pulled', pulled, num(d.n), 0.5, 'Deals in the daily table against deals pulled'))
  }

  // Do the ad platforms claim more than the reference recorded? A claim is never a failure:
  // Meta counts its own attribution window and view-throughs. A large gap is worth a look.
  const meta = await one(db, `SELECT sum(purchases) AS purchases, min(date)::text AS first FROM fact_meta_ads_daily WHERE date >= $1`, [since])
  if (meta.purchases === null || meta.purchases === undefined) checks.push(skip('ad_claims', 'Needs Meta Ads synced.'))
  else {
    const from = meta.first && String(meta.first) > since ? String(meta.first) : since
    let truth: number | null = null
    let what = ''
    if (ws.reference === 'stripe' && has) {
      const r = await one(db, ws.type === 'ecommerce' ? `SELECT sum(charges) AS n FROM fact_stripe_daily WHERE date >= $1` : `SELECT sum(new_customers) AS n FROM fact_stripe_daily WHERE date >= $1`, [from])
      truth = num(r.n)
      what = ws.type === 'ecommerce' ? 'successful charges' : 'new paying customers'
    } else if (ws.reference === 'shopify' && has) {
      truth = num((await one(db, `SELECT sum(orders) AS n FROM fact_orders_daily WHERE date >= $1`, [from])).n)
      what = 'orders'
    } else if (ws.reference === 'ga4' && has) {
      truth = num((await one(db, `SELECT sum(purchases) AS n FROM fact_ga4_daily WHERE date >= $1`, [from])).n)
      what = 'purchases'
    }
    if (truth === null) checks.push(skip('ad_claims', ws.reference === 'hubspot' ? 'Meta reports purchases, not leads, so there is nothing in HubSpot to hold them against.' : 'Needs a reference source with purchases to compare against.'))
    else {
      const claimed = num(meta.purchases)
      const share = truth === 0 ? (claimed === 0 ? 0 : 100000) : round((claimed / truth) * 100)
      const flag = adClaimFlag(t)
      const times = truth ? Math.round((claimed / truth) * 10) / 10 : null
      const ref = REFERENCE_NAME[ws.reference]
      checks.push({
        name: 'ad_claims', status: share > flag ? 'warn' : 'pass', expected: truth, actual: claimed, diffPct: share,
        detail: `Meta claims ${claimed} purchases since ${from}. ${ref} shows ${truth} ${what} on the same days${times !== null ? `, so Meta claims ${times} times as many` : ', so every one of them is a claim with nothing behind it in ' + ref}. A claim is Meta's own attribution, not a sale.`,
      })
    }
  }

  checks.push(await freshness(db, t))
  return checks
}

// Do enough line items carry a Shopify unit cost for the margin to stand on? A warning, never a failure:
// lines with no cost use the owner's cogs_percent, and the margin says so.
export async function costCheck(db: Tx): Promise<Check | null> {
  let r: Record<string, unknown> = {}
  try {
    r = (await db.query(`SELECT coalesce(sum(lines), 0) AS lines, coalesce(sum(lines_with_cost), 0) AS costed, count(*) AS days FROM fact_cogs_daily`))[0] ?? {}
  } catch {
    return null
  }
  if (!num(r.days)) return null
  const lines = num(r.lines)
  const share = lines ? round((num(r.costed) / lines) * 100) : 100
  // Only Shopify product costs depend on coverage. A percent or a cost per product does not.
  const mode = readCosts()?.cogs.mode ?? 'shopify'
  const status: CheckStatus = share >= 90 || mode !== 'shopify' ? 'pass' : 'warn'
  return {
    name: 'cost_coverage', status, expected: lines, actual: num(r.costed), diffPct: share,
    detail: `${share}% of line items have a product cost in Shopify.${share < 100 ? (mode === 'shopify' ? ' The rest count as zero cost: add costs to those products in Shopify, or use a percent or a cost per product.' : ` Cost of goods comes from your ${mode === 'percent' ? 'percent' : 'cost per product'}, so this does not change the margin.`) : ''}`,
  }
}
