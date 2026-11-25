# Workspaces: the CLI for any marketer (0.14.0 spec)

Until 0.13.2 the CLI assumed a Shopify store: the trust gate checked every source against Shopify orders, the built-in metrics were order and revenue shaped, and the wording said "store". 0.14.0 makes the kind of business a setting. Shopify stays a first-class path and stops being a requirement. This file is the spec; `lifecycle docs workspaces` is the short version for owners and agents.

Line numbers below refer to `origin/main` at 0.13.2 (commit 4e0fd07) unless marked otherwise.

## 1. Where Shopify was assumed

| Where | What | Class | 0.14.0 |
|---|---|---|---|
| `src/reconcile.ts:43-48` | `orders_complete` reads `meta_source_total` for `shopify` only | should become optional | runs for a store; other types get checks against their own reference (`runReferenceChecks`) |
| `src/reconcile.ts:51-55` | `orders_vs_cohorts` on Shopify tables | fine as is | store only |
| `src/reconcile.ts:57-75` | `klaviyo_orders` compares Klaviyo to Shopify orders | fine as is | store only |
| `src/reconcile.ts:77-81` | `ga4_purchases` against Shopify orders | must change | `ga4_vs_reference` against Stripe charges |
| `src/reconcile.ts:83-91` | `attributed_share` against Shopify net revenue | fine as is | store only; ad claims get `ad_claims` against the reference |
| `src/reconcile.ts` `trustLine` | passed, failed or unchecked; "passed" with nothing to check against reads as passed | must change | `unreferenced` status, with a plain sentence, when there is no reference |
| `src/metrics.ts:17` | `Source` has no CRM | must change | adds `hubspot` |
| `src/metrics.ts:65-88` | 22 metrics, most on `fact_orders_daily` | should become optional | kept as the Shopify pack; packs per type |
| `src/dashboard.ts:12` | dashboard metrics are Shopify and Klaviyo | must change | first eight of the type's pack |
| `src/demo.ts:39-55` | demo data is a store | must change | SaaS and B2B demos as well |
| `src/checklist.ts:20` | "Connect Shopify and Klaviyo" | must change | "Connect REFERENCE, this workspace's source of truth" |
| `src/commands/init.ts` | no notion of a business type | must change | `--type`, `--reference`, a picker in a terminal |
| `src/native.ts:9` | five built-in sources, no CRM | must change | adds `hubspot` |
| `src/sources-catalog.ts:107` | kit prompt says "for my store" | must change | "store" for a store, "workspace" otherwise |
| `src/registry.ts:28` | kit `needs` has no CRM | must change | `extra_needs` and `types`; `needs` stays readable by 0.13 CLIs |
| `src/skills.ts:44,56` | router skill is "Shopify and Klaviyo numbers" | must change | any business, names the workspace commands |
| `src/docs.ts:11-18,59` | setup and quickstart are store-first | must change | a type step first, HubSpot section, `docs workspaces` |
| `src/cli.ts:61` | program description "Shopify and Klaviyo" | must change | any business |
| `src/cli.ts:101` and Cloud wording | Cloud tenants are "stores", tokens "store tokens" | should become optional | help text says workspace; JSON keys and Cloud's own sentences unchanged (tests pin them) |
| `src/config.ts:100-102` | reconcile tolerances describe Shopify | fine as is | they apply to a store; `reconcile.ad_claim_flag` added for other types |
| `src/cli.ts` `connect shopify --store` | the shop domain flag | fine as is | `--shop` added, `--store` kept |
| `src/sources/shopify.ts` | the Shopify source | fine as is | untouched (another package owns it); unit costs read in `src/sources/shopify-costs.ts` |
| `src/tools.ts:14-56` | built-in tools are Klaviyo and Shopify | fine as is | unchanged; the open providers cover the rest |
| `src/reports.ts:32-37,120` | revenue per flow is a share of Shopify revenue | fine as is | a Klaviyo store report |
| `src/paths.ts`, `src/secrets.ts` | one home folder, one keychain service | should become optional | named workspaces: `--workspace NAME`, one keychain service each |

## 2. Workspace types

What marketers say they need, by type. Sources: posts and threads, cited inline. Short paraphrases.

- **Other ecommerce.** GA4 purchases rarely match the store's order count (https://www.reddit.com/r/GoogleAnalytics/comments/1unrvd5/ga4_purchases_never_match_the_actual_order_count/); WooCommerce subscription stores see purchase data that does not match (https://www.reddit.com/r/GoogleAnalytics/comments/1voaecy/need_help_with_ga4_tracking_and_woocommerce/); store, GA4 and ad platform give three numbers (https://www.reddit.com/r/ecommercemarketing/comments/1x7n55z/how_do_you_handle_it_when_shopify_ga4_and_ad/); Meta over-reports purchases (https://www.reddit.com/r/FacebookAds/comments/1sin0e2/meta_way_overreporting_purchases_this_week/); weekly LTV, CAC and ROAS from one view (https://www.reddit.com/r/ecommerce/comments/1lisdts/best_way_to_manage_analytics_and_finances/); Stripe payments often arrive with no traffic source (https://readme.anytrack.io/docs/stripe).
- **SaaS.** Founders track MRR, churn and failed payments in Stripe or a spreadsheet (https://www.reddit.com/r/SaaS/comments/1xwci6n/saas_founders_how_do_you_actually_track_mrr_and/); Stripe MRR does not match bank payouts (https://www.reddit.com/r/SaaS/comments/1xr8276/why_your_stripe_mrr_never_matches_your_bank/); failed payments muddy churn (https://www.reddit.com/r/SaaS/comments/1uxf4e2/losing_revenue_to_failed_stripe_payments_how_are/); LTV:CAC and CAC payback (https://www.reddit.com/r/SaaS/comments/1plr0gt/the_ltvcac_ratio_every_saas_founder_should_know/); trial to paid from Stripe (https://www.reddit.com/r/stripe/comments/1mtmquf/using_stripe_data_to_improve_free_trial_paid/).
- **B2B.** Lead source lands as "Other" in the CRM (https://www.reddit.com/r/b2bmarketing/comments/1xxn4g9/our_crm_says_most_of_our_leads_come_from_other/); every platform claims the same conversion (https://www.reddit.com/r/b2bmarketing/comments/1r3y461/how_do_you_handle_marketing_analytics_when/); cost per lead must sit next to pipeline (https://www.reddit.com/r/PPC/comments/1xce0zf/whats_your_actual_cpl_for_b2b_saas_i_think_were/); the CRM's lead source is the record (https://www.reddit.com/r/PPC/comments/1oc0fu7/agencies_how_do_you_track_conversions/); small teams struggle with monthly CRM reports (https://www.reddit.com/r/hubspot/comments/1r7df28/solo_b2b_marketers_how_do_you_handle_monthly/).
- **Agency.** Three numbers from GA4, Google Ads and Meta every month (https://www.reddit.com/r/GoogleAnalytics/comments/1xfrp7t/should_i_be_worried_that_my_ga4_numbers_dont/); each new client adds setup (https://www.reddit.com/r/marketingagency/comments/1xxmrgn/we_rebuilt_reporting_for_agencies_managing_10250/); combining and correcting cross-platform data stays manual (https://www.reddit.com/r/marketingagency/comments/1xo60pw/whats_still_painful_after_automating_client/); 4 to 5 hours a client a week on reports (https://www.reddit.com/r/marketingagency/comments/1qunnc5/i_built_a_client_reporting_tool_that_cut_our/).
- **Creator or media.** Income arrives on different clocks (https://www.reddit.com/r/PartneredYoutube/comments/1rx9zrg/how_are_we_all_keeping_track_of_our_money/); a spreadsheet is the record (https://www.reddit.com/r/IMadeThis/comments/1r3j054/i_made_a_revenue_dashboard_for_content_creators/); open rate is a vanity number if the goal is revenue (https://www.reddit.com/r/newslettergrowth/).

The common thread: every tool reports its own number, and nobody has an agreed rule for which one wins. The trust gate is that rule.

| Type | Source of truth (default `workspace.reference`) | Five usual sources | Metric pack |
|---|---|---|---|
| `shopify` | Shopify orders | shopify, klaviyo, ga4, meta, stripe | the 22 metrics of 0.13, plus margin once costs are set |
| `ecommerce` | Stripe charges | stripe, ga4, meta, woocommerce, klaviyo | stripe_net_revenue, stripe_charges, stripe_average_charge, stripe_new_customers, stripe_repeat_charge_share, stripe_failed_payment_rate, ga4_sessions, ga4_purchase_rate, meta_ad_spend, stripe_efficiency_ratio, cost_per_new_customer, meta_reported_roas, flow_attributed_revenue |
| `saas` | Stripe | stripe, ga4, meta, hubspot, posthog | stripe_mrr, stripe_net_new_mrr, stripe_arpa, stripe_subscription_churn_rate, stripe_subscriptions_started, stripe_subscriptions_ended, stripe_new_customers, stripe_net_revenue, stripe_failed_payment_rate, cost_per_new_customer, visit_to_paid_rate, ga4_sessions, meta_ad_spend |
| `b2b` | HubSpot | hubspot, ga4, meta, pipedrive, stripe | crm_new_leads, crm_lead_to_customer_rate, crm_deals_created, crm_pipeline_created, crm_open_pipeline, crm_deals_won, crm_won_revenue, crm_win_rate, crm_average_deal_size, cost_per_lead, ga4_sessions, meta_ad_spend, meta_cpc |
| `agency` | none until set per client | ga4, meta, stripe, hubspot, shopify | meta_ad_spend, meta_cpc, meta_ctr, meta_cpm, meta_attributed_purchases, meta_reported_roas, ga4_sessions, ga4_purchase_rate, stripe_net_revenue, stripe_efficiency_ratio, crm_new_leads, cost_per_lead, shopify_net_revenue, marketing_efficiency_ratio |
| `creator` | Stripe | stripe, ga4, meta, mailchimp, klaviyo | stripe_net_revenue, stripe_new_customers, stripe_mrr, stripe_subscriptions_started, stripe_subscriptions_ended, stripe_subscription_churn_rate, ga4_sessions, visit_to_paid_rate, meta_ad_spend, cost_per_new_customer, flow_attributed_revenue |

GA4 can be set as the reference when nothing better exists. The line then says GA4 is a tracking tool, not a ledger.

CAC here is blended (all new customers, Meta spend only), and the notes say so. No LTV metric ships: Stripe's own LTV figure is not trusted by the people who see it (https://www.reddit.com/r/SaaS/comments/jcrag3/how_accurate_is_stripes_lifetime_value/), and a cohort LTV on margin needs more history than a first sync has. [UNSOURCED: the claim that a first sync is too short is a design judgement.]

## 3. The trust gate per reference

| Reference | Checks |
|---|---|
| shopify (a store) | the seven 0.13 checks, unchanged; `cost_coverage` once costs are synced |
| stripe | `reference`, `stripe_daily_complete` (daily rows add up to every charge pulled), `subscriptions_balance` (starts minus ends equals open subscriptions), `ga4_vs_reference`, `ad_claims` (warn, never fail), `freshness` |
| hubspot | `reference`, `deals_complete` and `contacts_complete` (pulled against HubSpot's own total from the search endpoint), `deals_daily_vs_pulled`, `ad_claims` (skipped: Meta reports purchases, not leads), `freshness` |
| ga4 | `reference` (warn: tracking tool), `ad_claims` against GA4 purchases, `freshness` |
| none | `reference` (skipped), `freshness` |

Trust line statuses: `passed`, `failed`, `unchecked`, and new in 0.14.0 `unreferenced`. A store never writes a `reference` row, so its line reads word for word as in 0.13.

## 4. Connectors added

| Source | Path | Readiness | Personal data |
|---|---|---|---|
| HubSpot | built in (`connect hubspot`), reconcile checks | built: from the CRM v3 docs, tested against a stand-in; not run on a real portal | asks only for stage, source, date and amount properties; stores daily counts, no ids |
| HubSpot records | warehouse `hubspot-records` | built | ids, stages, sources, dates, amounts; deal names and company fields removed |
| Pipedrive | warehouse | built | person and org names, deal and lead titles, CC address removed; `person_id` keeps its number |
| WooCommerce | warehouse | built | billing, shipping, notes, IP, user agent and all `meta_data` removed |
| BigCommerce | warehouse (orders v2) | built; the 204 end page is unproven | billing address, messages, IP removed |
| Customer.io | warehouse (campaigns, newsletters) | built | teammate names removed; no people loaded |
| Stripe subscriptions | already native | native | unchanged |
| Salesforce | catalog | planned: needs an OAuth connected app | |
| Google Ads | built in (`connect google-ads`), read only | built: from the Google Ads API docs (v26), tested against recorded answers; not run on a live or test account | daily cost and results by campaign and ad group; no audiences, keywords, people or creative |
| Google Merchant Center | built in (`connect google-merchant-center`), read only | built: from the Merchant API Reports v1 docs, tested against recorded answers; not run on a live account | daily clicks and impressions for free listings and Shopping ads, and product counts by status; no product ids, titles or prices |
| Microsoft Advertising | built in (`connect microsoft-ads`), read only | built: from the Bing Ads API v13 REST docs, tested against recorded answers; not run on a live account | daily spend and results by campaign; no audiences, keywords, people or creative |
| LinkedIn Ads | built in (`connect linkedin-ads`), read only | built: from the LinkedIn Marketing API docs (202611), tested against recorded answers; not run on a live ad account | daily spend and results by campaign; no audiences, creatives or member data |
| Reddit Ads | built in (`connect reddit-ads`), read only | built: from the Reddit Ads API docs (v3), tested against recorded answers; not run on a live account | daily spend and attributed purchases by campaign; no audiences, communities, keywords, people or creative |
| Snapchat Ads | built in (`connect snapchat-ads`), read only | built: from the Snapchat Marketing API docs (v1), tested against recorded answers; not run on a live account | daily spend and attributed purchases by campaign; no audiences, creatives, people or pixel events |
| Google Search Console | catalog | planned: needs Google sign-in | |
| PostHog, Mixpanel | catalog | planned: query results come as arrays or streams, which need a runner change | |

dlt status, for the record: HubSpot, Salesforce, Pipedrive, Google Ads and Stripe are dlt verified sources (https://dlthub.com/docs/dlt-ecosystem/verified-sources); LinkedIn Ads, Search Console, PostHog, Mixpanel, Mailchimp, Customer.io, WooCommerce and BigCommerce have only REST API context pages (for example https://dlthub.com/context/source/woocommerce). The CLI's warehouse path uses dlt's REST API source with its own specs, so every connector above is a spec in `connectors/specs/` that loads in dlt 1.32.0 and passes the 0.13.2 personal-data rules on recorded rows.

## 5. Contribution margin and one total across stores

Added at the coordinator's request for the beta readiness plan (WP8). Contract for the app and Cloud: `cosmic-ai-desktop/docs/margin-contract.md`.

- Costs: the app's `costs.json` in the workspace folder (cost of goods from Shopify product costs, a percent, or a cost per SKU; shipping; payment fees; ad sources). Shopify product costs and SKU sales are read in `src/sources/shopify-costs.ts`. Fulfillment has no field of its own in the app's file; put it in shipping per order.
- Metrics: `cogs`, `gross_margin`, `contribution_margin_before_ads`, `contribution_margin`, `contribution_margin_percent`, `cost_coverage`. `contribution_margin` returns the app's answer: `total`, `rows`, `included`, `missing`, `orders_without_cost`, `trust`.
- Roll-up: `metrics run NAME --all-stores --currency USD`, one workspace per store, ECB reference rates via Frankfurter's v1 API, the app's rule (divide by the rate) and its line (https://frankfurter.dev).

## 6. Named workspaces

`lifecycle --workspace NAME` (or `LIFECYCLE_WORKSPACE`) keeps a workspace under `~/.lifecycle/workspaces/NAME` with its own config, database, files and keychain service `lifecycle-cli:NAME`. The unnamed workspace is `~/.lifecycle` and the keychain service `lifecycle-cli`, as before.

## 7. Compatibility

- No type in config means `shopify`. `init` without `--type` on an existing install changes nothing; the picker shows only for a new workspace in a terminal.
- A store's `metrics list`, `config list`, `sources list`, checklist, demo and trust line read as in 0.13 (pinned by the 0.13 tests, unchanged).
- Kits: `needs` stays within the five 0.13 sources so older CLIs can read the registry; new sources go in `extra_needs`, and `types` says which workspaces a kit fits.
