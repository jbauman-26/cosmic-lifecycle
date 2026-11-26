import type { Db, Tx } from './db.js'
import { CliError } from './errors.js'
import { assertNoPersonal, assertReadOnlySql } from './query.js'
import { trustLine } from './reconcile.js'
import { ATTRIBUTION_NOTE } from './reports.js'
import { settingValue } from './config.js'
import { readWorkspace, WORKSPACE_TYPES, type WorkspaceType } from './workspace.js'
import { costsConfigured } from './costs.js'
import { computeMargin, MARGIN_SQL } from './margin.js'

// 90 unless someone ran cosmic config set metrics.default_days.
export const defaultDays = () => settingValue('metrics.default_days')

// Verified metrics: fixed, reviewed SQL an agent picks from instead of writing its own.
// The same metric and window always run the same SQL, so a number asked for on Monday
// matches the one asked for on Friday. Every query returns value, numerator, denominator.
// $1 is the first day of the window, as YYYY-MM-DD.

export type Unit = 'count' | 'usd' | 'percent' | 'usd_per_recipient' | 'ratio'
export type Source = 'shopify' | 'klaviyo' | 'ga4' | 'stripe' | 'meta' | 'hubspot'

export type Metric = {
  name: string
  title: string
  description: string
  unit: Unit
  needs: Source[]
  sql: string
  notes?: string[]
  // Margin metrics are computed from costs.json; this says which part of the answer is the value.
  margin?: 'cogs' | 'cm1' | 'cm2' | 'cm3' | 'cm3_percent' | 'coverage'
}

const ratio = (num: string, den: string, scale = 1) =>
  `SELECT CASE WHEN (${den}) > 0 THEN (${num}) * ${scale}.0 / (${den}) END AS value, (${num}) AS numerator, (${den}) AS denominator`

const ORDERS = `(SELECT coalesce(sum(orders), 0) FROM fact_orders_daily WHERE date >= $1)`
const NET = `(SELECT coalesce(sum(net_revenue), 0) FROM fact_orders_daily WHERE date >= $1)`
const RETURNING = `(SELECT coalesce(sum(returning_orders), 0) FROM fact_orders_daily WHERE date >= $1)`
const FLOW_REVENUE = `(SELECT coalesce(sum(revenue), 0) FROM fact_flow_daily WHERE date >= $1)`
const FLOW_RECIPIENTS = `(SELECT coalesce(sum(recipients), 0) FROM fact_flow_daily WHERE date >= $1)`
const FLOW_UNSUBS = `(SELECT coalesce(sum(unsubscribes), 0) FROM fact_flow_daily WHERE date >= $1)`
const FLOW_SPAM = `(SELECT coalesce(sum(spam_complaints), 0) FROM fact_flow_daily WHERE date >= $1)`
const PLACED = `(SELECT coalesce(sum(placed_orders), 0) FROM fact_klaviyo_orders_daily WHERE date >= $1)`
const SESSIONS = `(SELECT coalesce(sum(sessions), 0) FROM fact_ga4_daily WHERE date >= $1)`
const PURCHASES = `(SELECT coalesce(sum(purchases), 0) FROM fact_ga4_daily WHERE date >= $1)`
// Stripe can hold several currencies. Money metrics use the one with the most
// charges in the window and say so, rather than adding yen to dollars.
const MAIN_CCY = `(SELECT currency FROM fact_stripe_daily WHERE date >= $1 GROUP BY currency ORDER BY sum(charges) DESC, currency LIMIT 1)`
const STRIPE_NET = `(SELECT coalesce(sum(net), 0) FROM fact_stripe_daily WHERE date >= $1 AND currency = ${MAIN_CCY})`
const STRIPE_CHARGES = `(SELECT coalesce(sum(charges), 0) FROM fact_stripe_daily WHERE date >= $1)`
const STRIPE_RETURNING = `(SELECT coalesce(sum(returning_charges), 0) FROM fact_stripe_daily WHERE date >= $1)`
const STRIPE_FAILED = `(SELECT coalesce(sum(failed_charges), 0) FROM fact_stripe_daily WHERE date >= $1)`
const STRIPE_ENDED = `(SELECT coalesce(sum(ended), 0) FROM fact_stripe_subscriptions_daily WHERE date >= $1)`
const STRIPE_STARTED = `(SELECT coalesce(sum(started), 0) FROM fact_stripe_subscriptions_daily WHERE date >= $1)`
// $1 is unused here, since MRR is a point in time, but every metric takes it.
const STRIPE_MRR = `(SELECT mrr FROM fact_stripe_mrr WHERE date = (SELECT max(date) FROM fact_stripe_mrr) AND $1::date IS NOT NULL ORDER BY active_subscriptions DESC, currency LIMIT 1)`
const CCY_NOTE = 'Stripe amounts are in the account\'s main currency for the window: the one with the most charges. Other currencies are left out, not converted.'
const META_SPEND = `(SELECT coalesce(sum(spend), 0) FROM fact_meta_ads_daily WHERE date >= $1)`
const META_VALUE = `(SELECT coalesce(sum(purchase_value), 0) FROM fact_meta_ads_daily WHERE date >= $1)`
const META_PURCHASES = `(SELECT coalesce(sum(purchases), 0) FROM fact_meta_ads_daily WHERE date >= $1)`
// Revenue for the efficiency ratio starts on the first day Meta data exists, so a window longer than the
// synced history never divides months of revenue by weeks of spend.
const NET_SINCE_META = `(SELECT coalesce(sum(net_revenue), 0) FROM fact_orders_daily WHERE date >= GREATEST($1::date, (SELECT min(date) FROM fact_meta_ads_daily)))`
const META_CLAIM_NOTE = 'Purchases and purchase value are what Meta attributes to its own ads, in its own attribution window. They are a claim, not orders. Do not add them to Shopify revenue or to email revenue.'
const META_CCY_NOTE = 'Spend is in the ad account\'s currency and is not converted. It is shown with a dollar sign either way.'
const single = (expr: string) => `SELECT ${expr} AS value, NULL::numeric AS numerator, NULL::numeric AS denominator`

export const METRICS: Metric[] = [
  { name: 'shopify_orders', title: 'Shopify orders', description: 'Orders placed in Shopify in the window.', unit: 'count', needs: ['shopify'], sql: single(ORDERS) },
  { name: 'shopify_net_revenue', title: 'Shopify net revenue', description: "Sum of each order's current total in Shopify, after discounts, edits and refunds, for orders in the window. Cancelled orders are left out.", unit: 'usd', needs: ['shopify'], sql: single(NET) },
  { name: 'average_order_value', title: 'Average order value', description: 'Shopify net revenue divided by Shopify orders.', unit: 'usd', needs: ['shopify'], sql: ratio(NET, ORDERS) },
  { name: 'returning_order_share', title: 'Returning order share', description: 'Share of Shopify orders placed by customers who had ordered before.', unit: 'percent', needs: ['shopify'], sql: ratio(RETURNING, ORDERS, 100), notes: ['A customer counts as returning when an earlier order of theirs is in the synced history. Guest checkouts have no customer and are counted on their own, never as returning.'] },
  { name: 'flow_attributed_revenue', title: 'Flow attributed revenue', description: 'Revenue Klaviyo attributes to all flows in the window.', unit: 'usd', needs: ['klaviyo'], sql: single(FLOW_REVENUE), notes: [ATTRIBUTION_NOTE] },
  { name: 'flow_revenue_share', title: 'Flow share of revenue', description: 'Flow attributed revenue as a share of Shopify net revenue.', unit: 'percent', needs: ['klaviyo', 'shopify'], sql: ratio(FLOW_REVENUE, NET, 100), notes: [ATTRIBUTION_NOTE] },
  { name: 'flow_revenue_per_recipient', title: 'Revenue per flow recipient', description: 'Flow attributed revenue divided by flow recipients, across all flows.', unit: 'usd_per_recipient', needs: ['klaviyo'], sql: ratio(FLOW_REVENUE, FLOW_RECIPIENTS), notes: [ATTRIBUTION_NOTE] },
  { name: 'flow_unsubscribe_rate', title: 'Flow unsubscribe rate', description: 'Unsubscribes divided by flow recipients.', unit: 'percent', needs: ['klaviyo'], sql: ratio(FLOW_UNSUBS, FLOW_RECIPIENTS, 100) },
  { name: 'flow_spam_rate', title: 'Flow spam complaint rate', description: 'Spam complaints divided by flow recipients.', unit: 'percent', needs: ['klaviyo'], sql: ratio(FLOW_SPAM, FLOW_RECIPIENTS, 100) },
  { name: 'klaviyo_placed_orders', title: 'Klaviyo Placed Order count', description: "Placed Order events Klaviyo recorded in the window. Compare with shopify_orders: they should be close.", unit: 'count', needs: ['klaviyo'], sql: single(PLACED) },
  { name: 'ga4_sessions', title: 'GA4 sessions', description: 'Sessions GA4 recorded in the window, all channels.', unit: 'count', needs: ['ga4'], sql: single(SESSIONS) },
  { name: 'stripe_net_revenue', title: 'Stripe net revenue', description: 'Successful Stripe charges minus amounts refunded on them, for charges made in the window.', unit: 'usd', needs: ['stripe'], sql: single(STRIPE_NET), notes: [CCY_NOTE, 'A refund counts against the day of the charge, not the day it was refunded.'] },
  { name: 'stripe_repeat_charge_share', title: 'Stripe repeat charge share', description: 'Share of successful Stripe charges from customers who had paid before.', unit: 'percent', needs: ['stripe'], sql: ratio(STRIPE_RETURNING, STRIPE_CHARGES, 100), notes: ['Charges with no Stripe customer attached are counted as guests, never as repeat.'] },
  { name: 'stripe_failed_payment_rate', title: 'Stripe failed payment rate', description: 'Failed Stripe charges divided by all attempted charges.', unit: 'percent', needs: ['stripe'], sql: ratio(STRIPE_FAILED, `(${STRIPE_FAILED} + ${STRIPE_CHARGES})`, 100), notes: ['Each retry is its own attempt, so a card retried three times counts three times.'] },
  { name: 'stripe_subscriptions_started', title: 'Subscriptions started', description: 'Stripe subscriptions created in the window.', unit: 'count', needs: ['stripe'], sql: single(STRIPE_STARTED) },
  { name: 'stripe_subscriptions_ended', title: 'Subscriptions ended', description: 'Stripe subscriptions that ended in the window: canceled and gone, not just set to cancel later.', unit: 'count', needs: ['stripe'], sql: single(STRIPE_ENDED) },
  { name: 'stripe_mrr', title: 'Stripe MRR', description: 'Monthly recurring revenue at the last sync: active and past_due subscriptions at list price, scaled to a month. Ignores the window.', unit: 'usd', needs: ['stripe'], sql: single(STRIPE_MRR), notes: ['Discounts are not applied. Tiered and metered prices are left out; cosmic sync reports how many.', CCY_NOTE] },
  { name: 'meta_ad_spend', title: 'Meta ad spend', description: 'What the Meta ad account spent in the window.', unit: 'usd', needs: ['meta'], sql: single(META_SPEND), notes: [META_CCY_NOTE] },
  { name: 'meta_attributed_purchases', title: 'Meta attributed purchases', description: 'Purchases Meta attributes to its ads in the window.', unit: 'count', needs: ['meta'], sql: single(META_PURCHASES), notes: [META_CLAIM_NOTE] },
  { name: 'meta_reported_roas', title: 'Meta reported ROAS', description: 'Purchase value Meta attributes to its ads, divided by spend. Meta\'s own claim.', unit: 'ratio', needs: ['meta'], sql: ratio(META_VALUE, META_SPEND), notes: [META_CLAIM_NOTE, META_CCY_NOTE] },
  { name: 'marketing_efficiency_ratio', title: 'Marketing efficiency ratio', description: 'Shopify net revenue divided by Meta ad spend. All store revenue over ad spend, with no attribution at all.', unit: 'ratio', needs: ['shopify', 'meta'], sql: ratio(NET_SINCE_META, META_SPEND), notes: ['Revenue is counted from the first day Meta data exists, or the start of the window if that is later. The first sync covers 90 days.', 'Only Meta spend is counted. Other paid channels are not in the spend, so the true ratio is lower if you run them.', 'Assumes the store and the ad account use the same currency.', 'Meta days follow the ad account\'s time zone, so a single day can differ slightly from Shopify\'s. Use a window of a week or more.'] },
  { name: 'ga4_purchase_rate', title: 'GA4 purchase rate', description: 'GA4 purchases divided by GA4 sessions.', unit: 'percent', needs: ['ga4'], sql: ratio(PURCHASES, SESSIONS, 100) },
]

// 0.14.0: metrics for workspaces that are not Shopify stores. Kept apart from METRICS, the
// Shopify pack, so a store's metric list reads exactly as it did. Every one is run by
// `metrics run` whatever the workspace type, with the same trust line.
const STRIPE_NEW = `(SELECT coalesce(sum(new_customers), 0) FROM fact_stripe_daily WHERE date >= $1)`
const STRIPE_ACTIVE = `(SELECT active_subscriptions FROM fact_stripe_mrr WHERE date = (SELECT max(date) FROM fact_stripe_mrr) AND $1::date IS NOT NULL ORDER BY active_subscriptions DESC, currency LIMIT 1)`
// MRR on the last sync on or before the first day of the window, in the same currency as today's.
const STRIPE_MRR_THEN = `(SELECT m.mrr FROM fact_stripe_mrr m WHERE m.date <= $1::date AND m.currency = (SELECT currency FROM fact_stripe_mrr WHERE date = (SELECT max(date) FROM fact_stripe_mrr) ORDER BY active_subscriptions DESC, currency LIMIT 1) ORDER BY m.date DESC LIMIT 1)`
const META_CLICKS = `(SELECT coalesce(sum(clicks), 0) FROM fact_meta_ads_daily WHERE date >= $1)`
const META_IMPRESSIONS = `(SELECT coalesce(sum(impressions), 0) FROM fact_meta_ads_daily WHERE date >= $1)`
// Spend over the days Meta was synced for, against new customers on those same days.
const META_SINCE = `GREATEST($1::date, (SELECT min(date) FROM fact_meta_ads_daily))`
const STRIPE_NEW_SINCE_META = `(SELECT coalesce(sum(new_customers), 0) FROM fact_stripe_daily WHERE date >= ${META_SINCE})`
const STRIPE_NET_SINCE_META = `(SELECT coalesce(sum(net), 0) FROM fact_stripe_daily WHERE date >= ${META_SINCE} AND currency = ${MAIN_CCY})`
const CRM_MAIN_CCY = `(SELECT currency FROM fact_crm_deals_daily WHERE date >= $1 GROUP BY currency ORDER BY sum(deals_created + deals_won) DESC, currency LIMIT 1)`
const CRM_LEADS = `(SELECT coalesce(sum(contacts), 0) FROM fact_crm_contacts_daily WHERE date >= $1)`
const CRM_LEADS_SINCE_META = `(SELECT coalesce(sum(contacts), 0) FROM fact_crm_contacts_daily WHERE date >= ${META_SINCE})`
const CRM_CUSTOMERS_FROM_LEADS = `(SELECT coalesce(sum(contacts), 0) FROM fact_crm_contacts_daily WHERE date >= $1 AND lower(lifecycle_stage) = 'customer')`
const CRM_CREATED = `(SELECT coalesce(sum(deals_created), 0) FROM fact_crm_deals_daily WHERE date >= $1)`
const CRM_CREATED_AMOUNT = `(SELECT coalesce(sum(amount_created), 0) FROM fact_crm_deals_daily WHERE date >= $1 AND currency = ${CRM_MAIN_CCY})`
const CRM_WON = `(SELECT coalesce(sum(deals_won), 0) FROM fact_crm_deals_daily WHERE date >= $1)`
const CRM_LOST = `(SELECT coalesce(sum(deals_lost), 0) FROM fact_crm_deals_daily WHERE date >= $1)`
const CRM_WON_AMOUNT = `(SELECT coalesce(sum(won_amount), 0) FROM fact_crm_deals_daily WHERE date >= $1 AND currency = ${CRM_MAIN_CCY})`
const CRM_WON_IN_CCY = `(SELECT coalesce(sum(deals_won), 0) FROM fact_crm_deals_daily WHERE date >= $1 AND currency = ${CRM_MAIN_CCY})`
const CRM_OPEN = `(SELECT coalesce(sum(open_amount), 0) FROM fact_crm_pipeline_open WHERE date = (SELECT max(date) FROM fact_crm_pipeline_open) AND $1::date IS NOT NULL AND currency = (SELECT currency FROM fact_crm_pipeline_open WHERE date = (SELECT max(date) FROM fact_crm_pipeline_open) GROUP BY currency ORDER BY sum(open_deals) DESC, currency LIMIT 1))`
const CRM_CCY_NOTE = 'Deal amounts are in the main deal currency for the window: the one with the most deals. Other currencies are left out, not converted.'
const CRM_SOURCE_NOTE = "Source is HubSpot's original source for the record (hs_analytics_source). Records HubSpot could not place show as UNKNOWN or OFFLINE."
const META_ONLY_SPEND = 'Only Meta spend is counted. Other paid channels are not in the spend yet, so the true cost is higher if you run them.'
const CLAIM_FREE = 'Uses no ad platform claim: spend from Meta, results from the reference source.'

export const PACK_METRICS: Metric[] = [
  { name: 'stripe_new_customers', title: 'New paying customers', description: 'Stripe customers whose first successful charge fell in the window.', unit: 'count', needs: ['stripe'], sql: single(STRIPE_NEW), notes: ['A customer is new on the day of their first successful charge in the synced history. Charges with no Stripe customer are not counted.'] },
  { name: 'stripe_charges', title: 'Successful Stripe charges', description: 'Successful Stripe charges in the window. For a store on a Stripe checkout this is the order count.', unit: 'count', needs: ['stripe'], sql: single(STRIPE_CHARGES) },
  { name: 'stripe_average_charge', title: 'Average charge', description: 'Stripe net revenue divided by successful charges. For a store, the average order value.', unit: 'usd', needs: ['stripe'], sql: ratio(STRIPE_NET, `(SELECT coalesce(sum(charges), 0) FROM fact_stripe_daily WHERE date >= $1 AND currency = ${MAIN_CCY})`), notes: [CCY_NOTE] },
  { name: 'stripe_arpa', title: 'Average revenue per account', description: 'Stripe MRR divided by active subscriptions at the last sync. Ignores the window.', unit: 'usd', needs: ['stripe'], sql: ratio(STRIPE_MRR, STRIPE_ACTIVE), notes: ['Counts subscriptions, not customers: a customer with two subscriptions counts twice.', CCY_NOTE] },
  { name: 'stripe_net_new_mrr', title: 'Net new MRR', description: 'MRR at the last sync minus MRR at the last sync on or before the first day of the window.', unit: 'usd', needs: ['stripe'], sql: `SELECT (${STRIPE_MRR}) - (${STRIPE_MRR_THEN}) AS value, (${STRIPE_MRR}) AS numerator, (${STRIPE_MRR_THEN}) AS denominator`, notes: ['MRR history starts on the first sync. Until a sync exists from before the window, this has no value.', 'Numerator is MRR now, denominator MRR at the start. Neither is a ratio.'] },
  { name: 'stripe_subscription_churn_rate', title: 'Subscription churn rate', description: 'Subscriptions that ended in the window, divided by subscriptions active at its start (active now, minus started, plus ended).', unit: 'percent', needs: ['stripe'], sql: ratio(STRIPE_ENDED, `(coalesce(${STRIPE_ACTIVE}, 0) - ${STRIPE_STARTED} + ${STRIPE_ENDED})`, 100), notes: ['Logo churn, not revenue churn. Active means active or past_due at the last sync, and the start count is worked back from it, so trials that never paid can move it slightly.'] },
  { name: 'cost_per_new_customer', title: 'Cost per new paying customer', description: 'Meta ad spend divided by new paying customers in Stripe, over the days Meta was synced for.', unit: 'usd', needs: ['meta', 'stripe'], sql: ratio(META_SPEND, STRIPE_NEW_SINCE_META), notes: [CLAIM_FREE, META_ONLY_SPEND, 'All new customers count, paid or not, so this is a blended cost, not the cost of a customer Meta brought.', META_CCY_NOTE] },
  { name: 'visit_to_paid_rate', title: 'Visit to paid rate', description: 'New paying customers in Stripe divided by GA4 sessions.', unit: 'percent', needs: ['ga4', 'stripe'], sql: ratio(STRIPE_NEW, SESSIONS, 100), notes: ['Two tools, two clocks: GA4 days follow the property time zone and Stripe days are UTC. Use a window of a week or more.'] },
  { name: 'stripe_efficiency_ratio', title: 'Revenue to ad spend (Stripe)', description: 'Stripe net revenue divided by Meta ad spend, over the days Meta was synced for. All revenue over spend, with no attribution.', unit: 'ratio', needs: ['stripe', 'meta'], sql: ratio(STRIPE_NET_SINCE_META, META_SPEND), notes: [CLAIM_FREE, META_ONLY_SPEND, CCY_NOTE] },
  { name: 'meta_cpc', title: 'Meta cost per click', description: 'Meta ad spend divided by clicks.', unit: 'usd', needs: ['meta'], sql: ratio(META_SPEND, META_CLICKS), notes: [META_CCY_NOTE] },
  { name: 'meta_ctr', title: 'Meta click-through rate', description: 'Meta clicks divided by impressions.', unit: 'percent', needs: ['meta'], sql: ratio(META_CLICKS, META_IMPRESSIONS, 100) },
  { name: 'meta_cpm', title: 'Meta cost per thousand impressions', description: 'Meta ad spend per 1,000 impressions.', unit: 'usd', needs: ['meta'], sql: ratio(META_SPEND, META_IMPRESSIONS, 1000), notes: [META_CCY_NOTE] },
  { name: 'crm_new_leads', title: 'New leads', description: 'HubSpot contacts created in the window, every source and stage.', unit: 'count', needs: ['hubspot'], sql: single(CRM_LEADS), notes: [CRM_SOURCE_NOTE] },
  { name: 'crm_lead_to_customer_rate', title: 'Lead to customer rate', description: 'Contacts created in the window whose lifecycle stage is customer today, divided by all contacts created in the window.', unit: 'percent', needs: ['hubspot'], sql: ratio(CRM_CUSTOMERS_FROM_LEADS, CRM_LEADS, 100), notes: ['Recent leads have had less time to close, so a short window reads low.'] },
  { name: 'crm_deals_created', title: 'Deals created', description: 'HubSpot deals created in the window, every pipeline.', unit: 'count', needs: ['hubspot'], sql: single(CRM_CREATED) },
  { name: 'crm_pipeline_created', title: 'Pipeline created', description: 'Amount on HubSpot deals created in the window.', unit: 'usd', needs: ['hubspot'], sql: single(CRM_CREATED_AMOUNT), notes: [CRM_CCY_NOTE, 'A deal with no amount counts as zero.'] },
  { name: 'crm_open_pipeline', title: 'Open pipeline', description: 'Amount on HubSpot deals still open at the last sync. Ignores the window.', unit: 'usd', needs: ['hubspot'], sql: single(CRM_OPEN), notes: ['In the currency with the most open deals. A deal with no amount counts as zero.'] },
  { name: 'crm_deals_won', title: 'Deals won', description: 'HubSpot deals closed won with a close date in the window.', unit: 'count', needs: ['hubspot'], sql: single(CRM_WON) },
  { name: 'crm_won_revenue', title: 'Closed won revenue', description: 'Amount on HubSpot deals closed won in the window.', unit: 'usd', needs: ['hubspot'], sql: single(CRM_WON_AMOUNT), notes: [CRM_CCY_NOTE] },
  { name: 'crm_win_rate', title: 'Win rate', description: 'Deals closed won divided by all deals closed, won or lost, in the window.', unit: 'percent', needs: ['hubspot'], sql: ratio(CRM_WON, `(${CRM_WON} + ${CRM_LOST})`, 100) },
  { name: 'crm_average_deal_size', title: 'Average deal size', description: 'Closed won revenue divided by deals won in the window.', unit: 'usd', needs: ['hubspot'], sql: ratio(CRM_WON_AMOUNT, CRM_WON_IN_CCY), notes: [CRM_CCY_NOTE] },
  { name: 'cost_per_lead', title: 'Cost per lead', description: 'Meta ad spend divided by new HubSpot contacts, over the days Meta was synced for.', unit: 'usd', needs: ['meta', 'hubspot'], sql: ratio(META_SPEND, CRM_LEADS_SINCE_META), notes: [CLAIM_FREE, META_ONLY_SPEND, 'Every new contact counts, from any source, so this is a blended cost per lead. Pair it with pipeline created: the cheapest lead is not always the cheapest customer.', META_CCY_NOTE] },
]

// 0.14.0: contribution margin for a store, from the owner's costs.json (the file the app writes) and
// the daily facts. Computed in src/margin.ts; the SQL shown is the one fixed query it reads.
type MarginPart = 'cogs' | 'cm1' | 'cm2' | 'cm3' | 'cm3_percent' | 'coverage'
const marginMetric = (name: string, title: string, description: string, unit: Unit, margin: MarginPart): Metric => ({ name, title, description, unit, needs: ['shopify'], sql: MARGIN_SQL, margin })
export const MARGIN_METRICS: Metric[] = [
  marginMetric('cogs', 'Cost of goods', 'Cost of goods for orders in the window, from Shopify product costs, a percent, or your cost per product.', 'usd', 'cogs'),
  marginMetric('gross_margin', 'Margin after cost of goods (CM1)', 'Revenue less what the products cost you.', 'usd', 'cm1'),
  marginMetric('contribution_margin_before_ads', 'Margin after shipping and fees (CM2)', 'CM1 less shipping and payment fees.', 'usd', 'cm2'),
  marginMetric('contribution_margin', 'Contribution margin (CM3)', 'CM2 less ad spend. Also returns each day, what went in and what is missing.', 'usd', 'cm3'),
  marginMetric('contribution_margin_percent', 'Contribution margin percent', 'CM3 as a share of revenue.', 'percent', 'cm3_percent'),
  marginMetric('cost_coverage', 'Line items with a Shopify cost', 'Share of line items in the window whose product has a cost in Shopify.', 'percent', 'coverage'),
]

// Which metrics each workspace type sees first. Shopify is exactly the 0.13 list, in order.
export const PACKS: Record<WorkspaceType, string[]> = {
  shopify: METRICS.map((m) => m.name),
  ecommerce: ['stripe_net_revenue', 'stripe_charges', 'stripe_average_charge', 'stripe_new_customers', 'stripe_repeat_charge_share', 'stripe_failed_payment_rate', 'ga4_sessions', 'ga4_purchase_rate', 'meta_ad_spend', 'stripe_efficiency_ratio', 'cost_per_new_customer', 'meta_reported_roas', 'flow_attributed_revenue'],
  saas: ['stripe_mrr', 'stripe_net_new_mrr', 'stripe_arpa', 'stripe_subscription_churn_rate', 'stripe_subscriptions_started', 'stripe_subscriptions_ended', 'stripe_new_customers', 'stripe_net_revenue', 'stripe_failed_payment_rate', 'cost_per_new_customer', 'visit_to_paid_rate', 'ga4_sessions', 'meta_ad_spend'],
  b2b: ['crm_new_leads', 'crm_lead_to_customer_rate', 'crm_deals_created', 'crm_pipeline_created', 'crm_open_pipeline', 'crm_deals_won', 'crm_won_revenue', 'crm_win_rate', 'crm_average_deal_size', 'cost_per_lead', 'ga4_sessions', 'meta_ad_spend', 'meta_cpc'],
  agency: ['meta_ad_spend', 'meta_cpc', 'meta_ctr', 'meta_cpm', 'meta_attributed_purchases', 'meta_reported_roas', 'ga4_sessions', 'ga4_purchase_rate', 'stripe_net_revenue', 'stripe_efficiency_ratio', 'crm_new_leads', 'cost_per_lead', 'shopify_net_revenue', 'marketing_efficiency_ratio'],
  creator: ['stripe_net_revenue', 'stripe_new_customers', 'stripe_mrr', 'stripe_subscriptions_started', 'stripe_subscriptions_ended', 'stripe_subscription_churn_rate', 'ga4_sessions', 'visit_to_paid_rate', 'meta_ad_spend', 'cost_per_new_customer', 'flow_attributed_revenue'],
}

// Every built-in metric: the Shopify pack, then the rest. A name is unique across both.
export const ALL_METRICS: Metric[] = [...METRICS, ...PACK_METRICS, ...MARGIN_METRICS]

export type Pack = WorkspaceType | 'all'
export function assertPack(p: string): Pack {
  const v = p.trim().toLowerCase()
  if (v !== 'all' && !(WORKSPACE_TYPES as readonly string[]).includes(v)) throw new CliError(`No metric pack named ${p}.`, `Packs: ${[...WORKSPACE_TYPES, 'all'].join(', ')}`, 'unknown_pack')
  return v as Pack
}

export function packMetrics(pack: Pack): Metric[] {
  if (pack === 'all') return ALL_METRICS
  return PACKS[pack].map((n) => ALL_METRICS.find((m) => m.name === n)!)
}

// Which table proves each source has synced at all.
const SOURCE_TABLE: Record<Source, string> = { shopify: 'fact_orders_daily', klaviyo: 'fact_flow_daily', ga4: 'fact_ga4_daily', stripe: 'fact_stripe_daily', meta: 'fact_meta_ads_daily', hubspot: 'fact_crm_deals_daily' }

export function findMetric(name: string) {
  const m = ALL_METRICS.find((x) => x.name === name)
  if (!m) throw new CliError(`No metric named ${name}.`, 'cosmic metrics list', 'unknown_metric')
  return m
}

// The workspace's pack by default, so a Shopify store lists exactly the 0.13 metrics.
export function listMetrics(pack: Pack = readWorkspace().type) {
  return packMetrics(pack).map(({ name, title, description, unit, needs }) => ({ name, title, description, unit, needs, saved: false as const }))
}

// Saved numbers: a SELECT the owner named, kept in the store's own database next to the data.
// They run through the same read-only path as `cosmic query`, carry the same trust line,
// and can never take the name of a built-in metric. Cosmic has not reviewed their SQL, and
// every answer says so.
export const UNITS: Unit[] = ['count', 'usd', 'percent', 'usd_per_recipient', 'ratio']
export const SAVED_NOTE = 'Saved by the owner. This SQL is theirs and has not been reviewed by Cosmic.'
export const NO_WINDOW_NOTE = 'This SQL has no $1, so it ignores the window and --days.'
const SAVED_NAME = /^[a-z][a-z0-9_]{2,47}$/

export type SavedMetric = { name: string; title: string; unit: Unit; sql: string; createdAt: string; updatedAt: string }

const toSaved = (r: Record<string, unknown>): SavedMetric => ({
  name: String(r.metric),
  title: String(r.title),
  unit: String(r.unit) as Unit,
  sql: String(r.sql),
  createdAt: new Date(String(r.created_at)).toISOString(),
  updatedAt: new Date(String(r.updated_at)).toISOString(),
})

// A database from before 0.12.0 has no saved-metric table until a write command migrates it.
export async function listSavedMetrics(db: Tx): Promise<SavedMetric[]> {
  try {
    return (await db.query(`SELECT metric, title, unit, sql, created_at, updated_at FROM meta_saved_metric ORDER BY metric`)).map(toSaved)
  } catch {
    return []
  }
}

export async function findSavedMetric(db: Tx, name: string): Promise<SavedMetric | null> {
  try {
    const r = await db.query(`SELECT metric, title, unit, sql, created_at, updated_at FROM meta_saved_metric WHERE metric = $1`, [name])
    return r[0] ? toSaved(r[0]) : null
  } catch {
    return null
  }
}

// Built-in metrics first, then the owner's saved ones, each marked.
export async function listAllMetrics(db: Tx | null, pack?: Pack) {
  const saved = db ? await listSavedMetrics(db) : []
  // A store that has entered costs also sees the margin metrics, after the 0.13 list.
  const p = pack ?? readWorkspace().type
  const margin = p === 'shopify' && (await costsConfigured(db)) ? MARGIN_METRICS.map(({ name, title, description, unit, needs }) => ({ name, title, description, unit, needs, saved: false as const })) : []
  return [
    ...listMetrics(pack),
    ...margin,
    ...saved.map((m) => ({ name: m.name, title: m.title, description: SAVED_NOTE, unit: m.unit, needs: [] as Source[], saved: true as const })),
  ]
}

// What `metrics show` prints: a built-in metric or a saved one, in one shape.
export async function describeMetric(db: Tx | null, name: string) {
  const builtIn = ALL_METRICS.find((x) => x.name === name)
  if (builtIn) return { ...builtIn, saved: false as const }
  const m = db ? await findSavedMetric(db, name) : null
  if (!m) throw new CliError(`No metric named ${name}.`, 'cosmic metrics list', 'unknown_metric')
  return { name: m.name, title: m.title, description: SAVED_NOTE, unit: m.unit, needs: [] as Source[], sql: m.sql, notes: savedNotes(m.sql), saved: true as const, createdAt: m.createdAt, updatedAt: m.updatedAt }
}

const usesWindow = (sql: string) => /\$1(?!\d)/.test(sql)
const savedNotes = (sql: string) => (usesWindow(sql) ? [SAVED_NOTE] : [SAVED_NOTE, NO_WINDOW_NOTE])

function assertSavedSql(sql: string) {
  const body = assertReadOnlySql(sql)
  const other = body.match(/\$(\d+)/g)?.find((p) => p !== '$1')
  if (other) throw new CliError(`Only $1 is available, the first day of the window. Found ${other}.`, "cosmic metrics save NAME --sql 'SELECT sum(orders) FROM fact_orders_daily WHERE date >= $1'", 'bad_metric')
  return body
}

// One row, and the number is the column called value, or the first column when there is none.
async function runSavedSql(db: Db, sql: string, since: string) {
  const body = assertSavedSql(sql)
  await assertNoPersonal(db, body)
  let rows
  try {
    rows = await db.readOnly(`SELECT * FROM (${body}) AS q LIMIT 2`, usesWindow(body) ? [since] : undefined)
  } catch (e) {
    throw new CliError(`Query failed: ${e instanceof Error ? e.message : e}`, 'cosmic schema', 'query_failed')
  }
  if (rows.length > 1) throw new CliError('A saved metric must return one row.', 'Wrap it in an aggregate, such as SELECT sum(...) or SELECT count(*).', 'bad_metric')
  const row = rows[0] ?? {}
  const keys = Object.keys(row)
  const raw = 'value' in row ? row.value : keys.length ? row[keys[0]!] : null
  const value = raw === null || raw === undefined ? null : Number(raw)
  if (value !== null && !Number.isFinite(value)) throw new CliError('A saved metric must return a number.', 'Name the number column value, or put it first.', 'bad_metric')
  return { value, numerator: num(row.numerator), denominator: num(row.denominator) }
}

export async function saveMetric(db: Db, name: string, opts: { sql?: string; title?: string; unit?: string }, now = Date.now()) {
  if (!SAVED_NAME.test(name)) throw new CliError('Use 3 to 48 lowercase letters, numbers and underscores, starting with a letter.', "cosmic metrics save repeat_buyers --sql 'SELECT ...'", 'bad_name')
  if (ALL_METRICS.some((m) => m.name === name)) throw new CliError(`${name} is a built-in metric, and a saved one cannot replace it.`, `Pick another name, such as my_${name}.`, 'reserved_name')
  if (!opts.sql?.trim()) throw new CliError('The SQL is missing.', `cosmic metrics save ${name} --sql 'SELECT sum(orders) FROM fact_orders_daily WHERE date >= $1'`, 'bad_metric')
  const unit = (opts.unit ?? 'count') as Unit
  if (!UNITS.includes(unit)) throw new CliError(`Unknown unit ${opts.unit}.`, `Units: ${UNITS.join(', ')}`, 'bad_value')
  const title = (opts.title ?? name).trim().slice(0, 120) || name
  const sql = assertSavedSql(opts.sql)
  // Prove it runs and gives one number before saving it, so a saved metric is never broken on day one.
  await runSavedSql(db, sql, sinceDate(defaultDays(), now))
  const stamp = new Date(now).toISOString()
  const before = await findSavedMetric(db, name)
  await db.query(
    `INSERT INTO meta_saved_metric (metric, title, unit, sql, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (metric) DO UPDATE SET title = EXCLUDED.title, unit = EXCLUDED.unit, sql = EXCLUDED.sql, updated_at = EXCLUDED.updated_at`,
    [name, title, unit, sql, stamp],
  )
  return { name, title, unit, sql, saved: true as const, replaced: Boolean(before), usesWindow: usesWindow(sql), notes: savedNotes(sql) }
}

export async function deleteMetric(db: Tx, name: string) {
  if (ALL_METRICS.some((m) => m.name === name)) throw new CliError(`${name} is a built-in metric and cannot be deleted.`, 'cosmic metrics list', 'reserved_name')
  const gone = await db.query(`DELETE FROM meta_saved_metric WHERE metric = $1 RETURNING metric`, [name])
  if (!gone.length) throw new CliError(`No saved metric named ${name}.`, 'cosmic metrics list', 'unknown_metric')
  return { name, deleted: true as const }
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const round = (n: number | null, d: number) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d)

export function sinceDate(days: number, now = Date.now()) {
  return new Date(now - days * 86400000).toISOString().slice(0, 10)
}

const assertDays = (name: string, days: number) => {
  if (!Number.isInteger(days) || days < 1 || days > 730) throw new CliError('Days must be a whole number from 1 to 730.', `cosmic metrics run ${name} --days 90`, 'bad_days')
}

async function runSavedMetric(db: Tx | Db, name: string, days: number, now: number) {
  const m = await findSavedMetric(db, name)
  if (!m) throw new CliError(`No metric named ${name}.`, 'cosmic metrics list', 'unknown_metric')
  if (!('readOnly' in db)) throw new CliError('Saved metrics need a read-only connection.', 'cosmic metrics run NAME', 'query_failed')
  assertDays(name, days)
  const since = sinceDate(days, now)
  const r = await runSavedSql(db, m.sql, since)
  return {
    metric: m.name, title: m.title, unit: m.unit, days, since, sql: m.sql, notes: savedNotes(m.sql),
    value: round(r.value, m.unit === 'count' ? 0 : 4),
    numerator: r.numerator,
    denominator: r.denominator,
    missing: [] as Source[],
    trust: await trustLine(db),
    status: r.value === null ? ('no_data' as const) : ('ok' as const),
    detail: r.value === null ? 'The query returned no value for this window.' : '',
    saved: true as const,
  }
}

export async function runMetric(db: Tx | Db, name: string, days = defaultDays(), now = Date.now()) {
  if (!ALL_METRICS.some((x) => x.name === name)) return runSavedMetric(db, name, days, now)
  const m = findMetric(name)
  assertDays(name, days)
  const since = sinceDate(days, now)

  const missing: Source[] = []
  for (const s of m.needs) {
    const r = await db.query(`SELECT 1 FROM ${SOURCE_TABLE[s]} LIMIT 1`)
    if (!r.length) missing.push(s)
  }
  const base = { metric: m.name, title: m.title, unit: m.unit, days, since, sql: m.sql, notes: m.notes ?? [], saved: false as const }
  if (m.margin && !missing.length) {
    const r = await computeMargin(db, since, days)
    if (r.status !== 'ok') return { ...base, ...r, metric: m.name, value: null, numerator: null, denominator: null, missing: [] as Source[], trust: r.trust }
    const t = r.total
    const value = m.margin === 'cm3_percent' ? (t.revenue > 0 ? Math.round((t.cm3 / t.revenue) * 1000000) / 10000 : null) : m.margin === 'coverage' ? r.coverage : t[m.margin]
    const parts = m.margin === 'cm3_percent' ? { numerator: t.cm3, denominator: t.revenue } : { numerator: null, denominator: null }
    // contribution_margin carries the whole answer the app reads; the others carry the total beside their value.
    // For contribution_margin, `missing` is the app's list of costs counted as zero, not sources.
    const extra = m.name === 'contribution_margin' ? { currency: r.currency, total: t, rows: r.rows, included: r.included, missing: r.missing as unknown as Source[], orders_without_cost: r.orders_without_cost } : { currency: r.currency, total: t, included: r.included, missing_costs: r.missing, missing: [] as Source[] }
    return { ...base, notes: [...r.notes, ...r.missing.map((x) => `Counted as zero: ${x}.`)], value, ...parts, ...extra, trust: r.trust, status: value === null ? ('no_data' as const) : ('ok' as const), detail: value === null ? 'No value for this window.' : '' }
  }
  if (missing.length) {
    return { ...base, value: null, numerator: null, denominator: null, missing, trust: await trustLine(db), status: 'no_data' as const, detail: `No ${missing.join(' or ')} data synced. Connect it, then cosmic sync.` }
  }

  const row = (await db.query(m.sql, [since]))[0] ?? {}
  const value = num(row.value)
  return {
    ...base,
    value: round(value, m.unit === 'count' ? 0 : 4),
    numerator: num(row.numerator),
    denominator: num(row.denominator),
    missing,
    trust: await trustLine(db),
    status: value === null ? ('no_data' as const) : ('ok' as const),
    detail: value === null ? 'The denominator is zero in this window.' : '',
  }
}

export function formatValue(unit: Unit, v: number | null) {
  if (v === null) return 'no value'
  if (unit === 'usd') return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (unit === 'usd_per_recipient') return `$${v.toFixed(4)} per recipient`
  if (unit === 'percent') return `${v.toFixed(2)}%`
  if (unit === 'ratio') return `${v.toFixed(2)}x`
  return v.toLocaleString('en-US')
}

// Custom queries run more than once are candidates for a new verified metric.
export async function metricCandidates(db: Tx, minRuns = 2, limit = 20) {
  const rows = await db.query(`SELECT sql_hash, sql, runs, first_seen, last_seen FROM meta_custom_query WHERE runs >= $1 ORDER BY runs DESC, last_seen DESC LIMIT $2`, [minRuns, limit])
  return rows.map((r) => ({ id: String(r.sql_hash), sql: String(r.sql), runs: Number(r.runs), firstSeen: new Date(String(r.first_seen)).toISOString(), lastSeen: new Date(String(r.last_seen)).toISOString() }))
}
