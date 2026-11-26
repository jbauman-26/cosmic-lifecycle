# Metric definitions

One definition per metric. Every built-in metric runs the same SQL every time, and every result carries that SQL and a trust line saying whether the sources it rests on agree. This file is written from the code by `scripts/write-metrics-doc.mjs`; `lifecycle metrics show <name>` prints the same definition with its exact SQL.

50 built-in metrics. Numbers you save yourself (`lifecycle metrics save`) are marked as yours and are not reviewed.

| Metric | What it measures | Unit | Needs | Packs |
|---|---|---|---|---|
| `shopify_orders` | Shopify orders. Orders placed in Shopify in the window. | count | shopify | shopify |
| `shopify_net_revenue` | Shopify net revenue. Sum of each order's current total in Shopify, after discounts, edits and refunds, for orders in the window. Cancelled orders are left out. | usd | shopify | shopify, agency |
| `average_order_value` | Average order value. Shopify net revenue divided by Shopify orders. | usd | shopify | shopify |
| `returning_order_share` | Returning order share. Share of Shopify orders placed by customers who had ordered before. | percent | shopify | shopify |
| `flow_attributed_revenue` | Flow attributed revenue. Revenue Klaviyo attributes to all flows in the window. | usd | klaviyo | shopify, ecommerce, creator |
| `flow_revenue_share` | Flow share of revenue. Flow attributed revenue as a share of Shopify net revenue. | percent | klaviyo, shopify | shopify |
| `flow_revenue_per_recipient` | Revenue per flow recipient. Flow attributed revenue divided by flow recipients, across all flows. | usd_per_recipient | klaviyo | shopify |
| `flow_unsubscribe_rate` | Flow unsubscribe rate. Unsubscribes divided by flow recipients. | percent | klaviyo | shopify |
| `flow_spam_rate` | Flow spam complaint rate. Spam complaints divided by flow recipients. | percent | klaviyo | shopify |
| `klaviyo_placed_orders` | Klaviyo Placed Order count. Placed Order events Klaviyo recorded in the window. Compare with shopify_orders: they should be close. | count | klaviyo | shopify |
| `ga4_sessions` | GA4 sessions. Sessions GA4 recorded in the window, all channels. | count | ga4 | shopify, ecommerce, saas, b2b, agency, creator |
| `stripe_net_revenue` | Stripe net revenue. Successful Stripe charges minus amounts refunded on them, for charges made in the window. | usd | stripe | shopify, ecommerce, saas, agency, creator |
| `stripe_repeat_charge_share` | Stripe repeat charge share. Share of successful Stripe charges from customers who had paid before. | percent | stripe | shopify, ecommerce |
| `stripe_failed_payment_rate` | Stripe failed payment rate. Failed Stripe charges divided by all attempted charges. | percent | stripe | shopify, ecommerce, saas |
| `stripe_subscriptions_started` | Subscriptions started. Stripe subscriptions created in the window. | count | stripe | shopify, saas, creator |
| `stripe_subscriptions_ended` | Subscriptions ended. Stripe subscriptions that ended in the window: canceled and gone, not just set to cancel later. | count | stripe | shopify, saas, creator |
| `stripe_mrr` | Stripe MRR. Monthly recurring revenue at the last sync: active and past_due subscriptions at list price, scaled to a month. Ignores the window. | usd | stripe | shopify, saas, creator |
| `meta_ad_spend` | Meta ad spend. What the Meta ad account spent in the window. | usd | meta | shopify, ecommerce, saas, b2b, agency, creator |
| `meta_attributed_purchases` | Meta attributed purchases. Purchases Meta attributes to its ads in the window. | count | meta | shopify, agency |
| `meta_reported_roas` | Meta reported ROAS. Purchase value Meta attributes to its ads, divided by spend. Meta's own claim. | ratio | meta | shopify, ecommerce, agency |
| `marketing_efficiency_ratio` | Marketing efficiency ratio. Shopify net revenue divided by Meta ad spend. All store revenue over ad spend, with no attribution at all. | ratio | shopify, meta | shopify, agency |
| `ga4_purchase_rate` | GA4 purchase rate. GA4 purchases divided by GA4 sessions. | percent | ga4 | shopify, ecommerce, agency |
| `stripe_new_customers` | New paying customers. Stripe customers whose first successful charge fell in the window. | count | stripe | ecommerce, saas, creator |
| `stripe_charges` | Successful Stripe charges. Successful Stripe charges in the window. For a store on a Stripe checkout this is the order count. | count | stripe | ecommerce |
| `stripe_average_charge` | Average charge. Stripe net revenue divided by successful charges. For a store, the average order value. | usd | stripe | ecommerce |
| `stripe_arpa` | Average revenue per account. Stripe MRR divided by active subscriptions at the last sync. Ignores the window. | usd | stripe | saas |
| `stripe_net_new_mrr` | Net new MRR. MRR at the last sync minus MRR at the last sync on or before the first day of the window. | usd | stripe | saas |
| `stripe_subscription_churn_rate` | Subscription churn rate. Subscriptions that ended in the window, divided by subscriptions active at its start (active now, minus started, plus ended). | percent | stripe | saas, creator |
| `cost_per_new_customer` | Cost per new paying customer. Meta ad spend divided by new paying customers in Stripe, over the days Meta was synced for. | usd | meta, stripe | ecommerce, saas, creator |
| `visit_to_paid_rate` | Visit to paid rate. New paying customers in Stripe divided by GA4 sessions. | percent | ga4, stripe | saas, creator |
| `stripe_efficiency_ratio` | Revenue to ad spend (Stripe). Stripe net revenue divided by Meta ad spend, over the days Meta was synced for. All revenue over spend, with no attribution. | ratio | stripe, meta | ecommerce, agency |
| `meta_cpc` | Meta cost per click. Meta ad spend divided by clicks. | usd | meta | b2b, agency |
| `meta_ctr` | Meta click-through rate. Meta clicks divided by impressions. | percent | meta | agency |
| `meta_cpm` | Meta cost per thousand impressions. Meta ad spend per 1,000 impressions. | usd | meta | agency |
| `crm_new_leads` | New leads. HubSpot contacts created in the window, every source and stage. | count | hubspot | b2b, agency |
| `crm_lead_to_customer_rate` | Lead to customer rate. Contacts created in the window whose lifecycle stage is customer today, divided by all contacts created in the window. | percent | hubspot | b2b |
| `crm_deals_created` | Deals created. HubSpot deals created in the window, every pipeline. | count | hubspot | b2b |
| `crm_pipeline_created` | Pipeline created. Amount on HubSpot deals created in the window. | usd | hubspot | b2b |
| `crm_open_pipeline` | Open pipeline. Amount on HubSpot deals still open at the last sync. Ignores the window. | usd | hubspot | b2b |
| `crm_deals_won` | Deals won. HubSpot deals closed won with a close date in the window. | count | hubspot | b2b |
| `crm_won_revenue` | Closed won revenue. Amount on HubSpot deals closed won in the window. | usd | hubspot | b2b |
| `crm_win_rate` | Win rate. Deals closed won divided by all deals closed, won or lost, in the window. | percent | hubspot | b2b |
| `crm_average_deal_size` | Average deal size. Closed won revenue divided by deals won in the window. | usd | hubspot | b2b |
| `cost_per_lead` | Cost per lead. Meta ad spend divided by new HubSpot contacts, over the days Meta was synced for. | usd | meta, hubspot | b2b, agency |
| `cogs` | Cost of goods. Cost of goods for orders in the window, from Shopify product costs, a percent, or your cost per product. | usd | shopify | all |
| `gross_margin` | Margin after cost of goods (CM1). Revenue less what the products cost you. | usd | shopify | all |
| `contribution_margin_before_ads` | Margin after shipping and fees (CM2). CM1 less shipping and payment fees. | usd | shopify | all |
| `contribution_margin` | Contribution margin (CM3). CM2 less ad spend. Also returns each day, what went in and what is missing. | usd | shopify | all |
| `contribution_margin_percent` | Contribution margin percent. CM3 as a share of revenue. | percent | shopify | all |
| `cost_coverage` | Line items with a Shopify cost. Share of line items in the window whose product has a cost in Shopify. | percent | shopify | all |

## Assumptions stated with each metric

- `returning_order_share`: A customer counts as returning when an earlier order of theirs is in the synced history. Guest checkouts have no customer and are counted on their own, never as returning.
- `flow_attributed_revenue`: Revenue here is what Klaviyo attributes to each flow. It shows correlation, not proof that the email caused the sale.
- `flow_revenue_share`: Revenue here is what Klaviyo attributes to each flow. It shows correlation, not proof that the email caused the sale.
- `flow_revenue_per_recipient`: Revenue here is what Klaviyo attributes to each flow. It shows correlation, not proof that the email caused the sale.
- `stripe_net_revenue`: Stripe amounts are in the account's main currency for the window: the one with the most charges. Other currencies are left out, not converted. A refund counts against the day of the charge, not the day it was refunded.
- `stripe_repeat_charge_share`: Charges with no Stripe customer attached are counted as guests, never as repeat.
- `stripe_failed_payment_rate`: Each retry is its own attempt, so a card retried three times counts three times.
- `stripe_mrr`: Discounts are not applied. Tiered and metered prices are left out; lifecycle sync reports how many. Stripe amounts are in the account's main currency for the window: the one with the most charges. Other currencies are left out, not converted.
- `meta_ad_spend`: Spend is in the ad account's currency and is not converted. It is shown with a dollar sign either way.
- `meta_attributed_purchases`: Purchases and purchase value are what Meta attributes to its own ads, in its own attribution window. They are a claim, not orders. Do not add them to Shopify revenue or to email revenue.
- `meta_reported_roas`: Purchases and purchase value are what Meta attributes to its own ads, in its own attribution window. They are a claim, not orders. Do not add them to Shopify revenue or to email revenue. Spend is in the ad account's currency and is not converted. It is shown with a dollar sign either way.
- `marketing_efficiency_ratio`: Revenue is counted from the first day Meta data exists, or the start of the window if that is later. The first sync covers 90 days. Only Meta spend is counted. Other paid channels are not in the spend, so the true ratio is lower if you run them. Assumes the store and the ad account use the same currency. Meta days follow the ad account's time zone, so a single day can differ slightly from Shopify's. Use a window of a week or more.
- `stripe_new_customers`: A customer is new on the day of their first successful charge in the synced history. Charges with no Stripe customer are not counted.
- `stripe_average_charge`: Stripe amounts are in the account's main currency for the window: the one with the most charges. Other currencies are left out, not converted.
- `stripe_arpa`: Counts subscriptions, not customers: a customer with two subscriptions counts twice. Stripe amounts are in the account's main currency for the window: the one with the most charges. Other currencies are left out, not converted.
- `stripe_net_new_mrr`: MRR history starts on the first sync. Until a sync exists from before the window, this has no value. Numerator is MRR now, denominator MRR at the start. Neither is a ratio.
- `stripe_subscription_churn_rate`: Logo churn, not revenue churn. Active means active or past_due at the last sync, and the start count is worked back from it, so trials that never paid can move it slightly.
- `cost_per_new_customer`: Uses no ad platform claim: spend from Meta, results from the reference source. Only Meta spend is counted. Other paid channels are not in the spend yet, so the true cost is higher if you run them. All new customers count, paid or not, so this is a blended cost, not the cost of a customer Meta brought. Spend is in the ad account's currency and is not converted. It is shown with a dollar sign either way.
- `visit_to_paid_rate`: Two tools, two clocks: GA4 days follow the property time zone and Stripe days are UTC. Use a window of a week or more.
- `stripe_efficiency_ratio`: Uses no ad platform claim: spend from Meta, results from the reference source. Only Meta spend is counted. Other paid channels are not in the spend yet, so the true cost is higher if you run them. Stripe amounts are in the account's main currency for the window: the one with the most charges. Other currencies are left out, not converted.
- `meta_cpc`: Spend is in the ad account's currency and is not converted. It is shown with a dollar sign either way.
- `meta_cpm`: Spend is in the ad account's currency and is not converted. It is shown with a dollar sign either way.
- `crm_new_leads`: Source is HubSpot's original source for the record (hs_analytics_source). Records HubSpot could not place show as UNKNOWN or OFFLINE.
- `crm_lead_to_customer_rate`: Recent leads have had less time to close, so a short window reads low.
- `crm_pipeline_created`: Deal amounts are in the main deal currency for the window: the one with the most deals. Other currencies are left out, not converted. A deal with no amount counts as zero.
- `crm_open_pipeline`: In the currency with the most open deals. A deal with no amount counts as zero.
- `crm_won_revenue`: Deal amounts are in the main deal currency for the window: the one with the most deals. Other currencies are left out, not converted.
- `crm_average_deal_size`: Deal amounts are in the main deal currency for the window: the one with the most deals. Other currencies are left out, not converted.
- `cost_per_lead`: Uses no ad platform claim: spend from Meta, results from the reference source. Only Meta spend is counted. Other paid channels are not in the spend yet, so the true cost is higher if you run them. Every new contact counts, from any source, so this is a blended cost per lead. Pair it with pipeline created: the cheapest lead is not always the cheapest customer. Spend is in the ad account's currency and is not converted. It is shown with a dollar sign either way.

## Contribution margin inputs

The margin metrics (`cogs`, `gross_margin`, `contribution_margin_before_ads`, `contribution_margin`, `contribution_margin_percent`, `cost_coverage`) read Shopify unit costs where a product has one (`lifecycle costs sync`) and the owner's rates in costs.json for the rest (`lifecycle costs set cogs percent:35`). A result lists what went in, what was missing and what was counted as zero, so an assumed cost is always visible.
