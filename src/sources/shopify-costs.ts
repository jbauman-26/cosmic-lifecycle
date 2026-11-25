import { fetchJson, HttpError } from '../http.js'
import { CliError } from '../errors.js'
import { shopifyQueryError } from './shopify.js'

// Cost of goods from Shopify: each line item's inventory item unit cost (the "Cost per item" field
// on a product variant), times the quantity still on the order. Read in its own pass, apart from
// the order totals in shopify.ts, so the order sync is untouched. Written from the Admin GraphQL
// docs (https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem#field-unitCost)
// and tested against recorded answers; not yet run on a real store.
//
// No personal field is asked for. What leaves this file is daily sums: cost of the lines that have
// a cost, and the revenue of the lines that do not, so an owner-set percent can cover those.

const VERSION = '2026-10'

export type CostLine = { sku?: string | null; currentQuantity: number; discountedUnitPriceAfterAllDiscountsSet?: { shopMoney: { amount: string } } | null; variant: { inventoryItem: { unitCost: { amount: string } | null } | null } | null }
export type CostOrder = { processedAt: string; cancelledAt: string | null; currentTotalTaxSet?: { shopMoney: { amount: string } } | null; lineItems: { nodes: CostLine[]; pageInfo?: { hasNextPage: boolean } } }
export type CostDaily = { date: string; cogsKnown: number; uncostedRevenue: number; tax: number; lines: number; linesWithCost: number; ordersWithoutCost: number }
export type SkuDaily = { date: string; sku: string; units: number; revenue: number }

const COSTS_QUERY = `query($c: String) {
  shop { currencyCode }
  orders(first: 100, after: $c, sortKey: PROCESSED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      processedAt cancelledAt
      currentTotalTaxSet { shopMoney { amount } }
      lineItems(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          sku
          currentQuantity
          discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
          variant { inventoryItem { unitCost { amount } } }
        }
      }
    }
  }
}`

const money = (n: number) => Math.round(n * 10000) / 10000

// Pure. A day matches fact_orders_daily: the order's processedAt date, cancelled orders left out.
// A line with no variant, or a variant with no cost, counts its revenue as uncosted.
export function aggregateCosts(orders: CostOrder[]): { daily: CostDaily[]; skus: SkuDaily[]; truncatedOrders: number } {
  const daily = new Map<string, CostDaily>()
  const skus = new Map<string, SkuDaily>()
  let truncatedOrders = 0
  for (const o of orders) {
    if (o.cancelledAt) continue
    const date = o.processedAt.slice(0, 10)
    const d = daily.get(date) ?? { date, cogsKnown: 0, uncostedRevenue: 0, tax: 0, lines: 0, linesWithCost: 0, ordersWithoutCost: 0 }
    if (o.lineItems.pageInfo?.hasNextPage) truncatedOrders++
    d.tax = money(d.tax + Number(o.currentTotalTaxSet?.shopMoney.amount ?? 0))
    let uncosted = false
    for (const l of o.lineItems.nodes) {
      const qty = Number(l.currentQuantity ?? 0)
      if (!qty) continue
      d.lines++
      const price = Number(l.discountedUnitPriceAfterAllDiscountsSet?.shopMoney.amount ?? 0)
      // By SKU too, for a cost per product the owner keeps outside Shopify. A line with no SKU is "(none)".
      const sku = (l.sku ?? '').trim().slice(0, 64) || '(none)'
      const k = `${date}|${sku}`
      const sd = skus.get(k) ?? { date, sku, units: 0, revenue: 0 }
      sd.units += qty
      sd.revenue = money(sd.revenue + price * qty)
      skus.set(k, sd)
      const cost = l.variant?.inventoryItem?.unitCost?.amount
      if (cost !== undefined && cost !== null && cost !== '' && Number.isFinite(Number(cost))) {
        d.linesWithCost++
        d.cogsKnown = money(d.cogsKnown + Number(cost) * qty)
      } else {
        uncosted = true
        d.uncostedRevenue = money(d.uncostedRevenue + price * qty)
      }
    }
    if (uncosted) d.ordersWithoutCost++
    daily.set(date, d)
  }
  return { daily: [...daily.values()], skus: [...skus.values()], truncatedOrders }
}

export async function fetchCostOrders(store: string, token: string, fetcher = fetchJson): Promise<{ orders: CostOrder[]; currency: string | null }> {
  const out: CostOrder[] = []
  let currency: string | null = null
  let cursor: string | null = null
  do {
    const body: any = await fetcher(
      `https://${store}/admin/api/${VERSION}/graphql.json`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token }, body: JSON.stringify({ query: COSTS_QUERY, variables: { c: cursor } }) },
      'Shopify costs request',
    ).catch((e) => {
      if (e instanceof HttpError && e.status === 403) throw costScope()
      throw e
    })
    if (body.errors) {
      const text = JSON.stringify(body.errors)
      if (/unitCost|inventoryItem|read_inventory|read_products/i.test(text)) throw costScope()
      throw shopifyQueryError(body.errors)
    }
    currency ??= body.data?.shop?.currencyCode ?? null
    out.push(...body.data.orders.nodes)
    cursor = body.data.orders.pageInfo.hasNextPage ? body.data.orders.pageInfo.endCursor : null
  } while (cursor)
  return { orders: out, currency }
}

const costScope = () =>
  new CliError(
    'Shopify did not let this app read product costs. It needs the read_inventory and read_products scopes as well as read_orders.',
    'Add read_inventory and read_products to the app, install it again, then lifecycle costs sync. Or set a percent instead: lifecycle costs set cogs_percent 35',
    'scope_denied',
  )
