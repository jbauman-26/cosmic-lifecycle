export const DOCS = {
    setup: `# Set up in order

First say what kind of business this is. It picks the source the numbers are
checked against and the metrics you see first (cosmic docs workspaces):
  cosmic init --type shopify     (or ecommerce, saas, b2b, agency, creator)
A Shopify store follows the steps below in order. Any other type starts with its
source of truth: Stripe for ecommerce, SaaS and creator, HubSpot for B2B.

Klaviyo, about 2 minutes:
1. In Klaviyo open Settings, API keys, Create Private API Key.
2. Choose Read-Only Key and copy it.
3. export KLAVIYO_READ_KEY=your_key
4. cosmic init
5. cosmic connect klaviyo --key-env KLAVIYO_READ_KEY

Shopify, about 15 minutes:
1. In the Shopify Dev Dashboard create an app in the same organization as the store.
2. Give it the read_orders scope, release a version and install it on the store.
3. In the Partner Dashboard open the app, then API access requests, then Protected
   customer data access, and select Analytics. Leave name, email, phone and address
   unselected. This keeps personal fields out by design.
4. export SHOPIFY_SECRET=your_client_secret
5. cosmic connect shopify --store NAME.myshopify.com --client-id ID --secret-env SHOPIFY_SECRET

Stripe, about 3 minutes (optional, for subscriptions and repeat payments):
1. In Stripe open Developers, API keys, Create restricted key.
2. Set Charges and Subscriptions to Read. Leave everything else at None.
3. export STRIPE_READ_KEY=rk_live_...
4. cosmic connect stripe --key-env STRIPE_READ_KEY

Meta Ads, about 10 minutes (optional, for ad spend next to revenue):
1. In Meta Business Settings open Users, System users, and add a system user.
2. Give that system user access to the ad account, with view performance only.
3. Generate a token for it with one permission: ads_read. Nothing else.
4. Copy the ad account id from Ads Manager. It is the number after act_.
5. export META_ADS_TOKEN=...
6. cosmic connect meta --account 1234567890 --token-env META_ADS_TOKEN
Meta's menu names change. If a step is not where this says, search Meta's help for "system user access token".

HubSpot, about 5 minutes (the source of truth for a B2B workspace):
1. In HubSpot open Settings, Integrations, Private Apps, Create a private app.
2. Under Scopes tick crm.objects.deals.read and crm.objects.contacts.read. Nothing else.
3. Create it and copy the access token.
4. export HUBSPOT_TOKEN=pat-...
5. cosmic connect hubspot --token-env HUBSPOT_TOKEN
It keeps daily counts and amounts only. No name, email, phone or company is asked for.
Row-level deals and contacts (ids, stages, sources, dates, amounts) load with
  cosmic warehouse connect hubspot-records --secret access_token=HUBSPOT_TOKEN

Google Ads, about 10 minutes (optional, for ad spend next to revenue):
1. You need an OAuth client id and secret from a Google Cloud project with the Google Ads API on.
   The Cosmic AI app does this sign-in for you. These steps are for doing it by hand.
2. Sign in with Google for a refresh token with the adwords scope. Google asks for a passkey.
3. Copy the customer id from the top of Google Ads, such as 123-456-7890. Pick a client account,
   not a manager account. If access comes through a manager, note its id too.
4. export GOOGLE_ADS_CLIENT_SECRET=... GOOGLE_ADS_REFRESH_TOKEN=...
5. cosmic connect google-ads --customer 123-456-7890 --client-id ID --secret-env GOOGLE_ADS_CLIENT_SECRET --refresh-token-env GOOGLE_ADS_REFRESH_TOKEN [--login-customer MANAGER_ID]
Only read calls are made, even though Google's scope is named for full access.

Google Merchant Center, about 10 minutes (optional, for free listings and Shopping clicks next to revenue):
1. You need an OAuth client id and secret from a Google Cloud project with the Merchant API on.
   The Cosmic AI app does this sign-in for you. These steps are for doing it by hand.
2. Register the Cloud project with the Merchant Center account once (Merchant API developer
   registration). The Cosmic AI app does this; the CLI never does, because it only reads.
3. Sign in with Google for a refresh token with the content scope. Google asks for a passkey.
4. Copy the account id from the top of Merchant Center, such as 123456789.
5. export GOOGLE_MERCHANT_CENTER_CLIENT_SECRET=... GOOGLE_MERCHANT_CENTER_REFRESH_TOKEN=...
6. cosmic connect google-merchant-center --account 123456789 --client-id ID --secret-env GOOGLE_MERCHANT_CENTER_CLIENT_SECRET --refresh-token-env GOOGLE_MERCHANT_CENTER_REFRESH_TOKEN
Google has no read-only Merchant scope. Only read calls are made: reports and the account name.

Microsoft Advertising, about 15 minutes (optional, for Bing ad spend next to revenue):
1. You need a Microsoft Entra app registration (any Entra tenant plus personal Microsoft
   accounts) with a client secret, and a Microsoft Advertising developer token from
   Settings, Developer settings. The Cosmic AI app does this sign-in for you. These steps
   are for doing it by hand.
2. Sign in with Microsoft for a refresh token with the scopes msads.manage and offline_access.
3. Open the account in Microsoft Advertising. The address bar shows aid= (the account id) and
   cid= (the customer id). Use those numbers, not the account number.
4. export MICROSOFT_ADS_CLIENT_SECRET=... MICROSOFT_ADS_REFRESH_TOKEN=... MICROSOFT_ADS_DEVELOPER_TOKEN=...
5. cosmic connect microsoft-ads --account ID --client-id ID --secret-env MICROSOFT_ADS_CLIENT_SECRET --refresh-token-env MICROSOFT_ADS_REFRESH_TOKEN --developer-token-env MICROSOFT_ADS_DEVELOPER_TOKEN [--customer CID]
Pass --customer only when you reach the account through an agency's manager account.
Only read calls are made: the account check and the reporting service. Microsoft has no
read-only scope.

LinkedIn Ads, about 10 minutes (optional, for LinkedIn ad spend next to pipeline):
1. You need a LinkedIn developer app approved for the Advertising API, with programmatic
   refresh tokens. The Cosmic AI app does this sign-in for you. These steps are for doing it
   by hand.
2. Sign in with LinkedIn for a refresh token with r_ads and r_ads_reporting. Your LinkedIn
   member needs a role on the ad account; Viewer is enough.
3. Copy the ad account id from Campaign Manager: the number after accounts/ in the address bar.
4. export LINKEDIN_ADS_CLIENT_SECRET=... LINKEDIN_ADS_REFRESH_TOKEN=...
5. cosmic connect linkedin-ads --account ID --client-id ID --secret-env LINKEDIN_ADS_CLIENT_SECRET --refresh-token-env LINKEDIN_ADS_REFRESH_TOKEN
Only read calls are made. A LinkedIn refresh token lasts one year from the sign-in; sign in
again before then.

Reddit Ads, about 10 minutes (optional, for ad spend next to revenue):
1. You need a developer application from Business > Developer Portal in Reddit Ads (a business
   admin makes it). Note its app id and secret. The Cosmic AI app does this sign-in for you.
2. Sign in with Reddit for a refresh token: scope adsread, duration permanent.
3. Copy the ad account id from Accounts in Reddit Ads Manager, such as a2_abc123.
4. export REDDIT_ADS_CLIENT_SECRET=... REDDIT_ADS_REFRESH_TOKEN=...
5. cosmic connect reddit-ads --account a2_abc123 --client-id APP_ID --secret-env REDDIT_ADS_CLIENT_SECRET --refresh-token-env REDDIT_ADS_REFRESH_TOKEN
Only read calls are made. The adsread scope cannot change anything.

Snapchat Ads, about 10 minutes (optional, for ad spend next to revenue):
1. You need an OAuth app from Business Details in Snap Business Manager (an organization admin
   makes it). Note its client id and secret. The Cosmic AI app does this sign-in for you.
2. Sign in with Snapchat for a refresh token with the snapchat-marketing-api scope.
3. Copy the ad account id from Snapchat Ads Manager.
4. export SNAPCHAT_ADS_CLIENT_SECRET=... SNAPCHAT_ADS_REFRESH_TOKEN=...
5. cosmic connect snapchat-ads --account AD_ACCOUNT_ID --client-id ID --secret-env SNAPCHAT_ADS_CLIENT_SECRET --refresh-token-env SNAPCHAT_ADS_REFRESH_TOKEN
Only read calls are made, even though Snap's scope also allows changes.

TikTok Ads, about 10 minutes (optional, for ad spend next to revenue):
1. You need an app in the TikTok API for Business developer portal with the Reporting permission.
   The Cosmic AI app does this sign-in for you. These steps are for doing it by hand.
2. The advertiser opens the app's authorization link and approves it. TikTok sends back an
   auth_code, which trades for a long-term access token that does not expire unless revoked.
3. Copy the advertiser id from under the account name in TikTok Ads Manager.
4. export TIKTOK_ADS_ACCESS_TOKEN=...
5. cosmic connect tiktok-ads --account ADVERTISER_ID --app-id APP_ID --token-env TIKTOK_ADS_ACCESS_TOKEN
Only read calls are made: the account details and the campaign report.

Pinterest Ads, about 10 minutes (optional, for ad spend next to revenue):
1. You need a Pinterest app (developers.pinterest.com) with its app id and secret.
   The Cosmic AI app does this sign-in for you. These steps are for doing it by hand.
2. Sign in with Pinterest for a refresh token with the ads:read scope.
3. Copy the ad account id from the Pinterest Ads Manager address.
4. export PINTEREST_ADS_CLIENT_SECRET=... PINTEREST_ADS_REFRESH_TOKEN=...
5. cosmic connect pinterest-ads --account AD_ACCOUNT_ID --client-id APP_ID --secret-env PINTEREST_ADS_CLIENT_SECRET --refresh-token-env PINTEREST_ADS_REFRESH_TOKEN
Only read calls are made. Pinterest gives a new refresh token each time one is used, good for
60 days. With a keychain the CLI keeps the newest. Without one, set LIFECYCLE_ROTATED_FILE and
the CLI writes the newest there for you to store; otherwise keep it current yourself.

Then:
  cosmic sync
  cosmic reconcile
  cosmic audit flows --html audit.html    (a store with Klaviyo)
  cosmic metrics list                     (the metrics for this workspace type)

Run it every day from your own GitHub:
1. Create a free Postgres database in your own Neon account:
     cosmic provision neon --key-env NEON_API_KEY --yes
   (Or bring any Postgres: export DATABASE_URL=your_url, then
   cosmic init --database-url-env DATABASE_URL.)
4. cosmic deploy --repo YOU/lifecycle-sync
5. Read the plan, then add --yes.
`,
    quickstart: `# Cosmic CLI: agent setup playbook

This is the setup guide for any coding or chat agent installing Cosmic CLI (npm package cosmic-lifecycle, command cosmic or lifecycle).
A person with the CLI installed starts it by pasting one line into their agent:

  Set up Cosmic CLI by following the output of cosmic docs quickstart

Follow this playbook in order, then stop and report what is live. Do not invent another setup flow.

## What it is

A free CLI that gets the user's marketing data ready for their AI agent, with
numbers checked before it quotes them: for a founder or SaaS team, a marketer or freelancer, a
creator, an agency client or an online store. The command is cosmic; lifecycle is
the same command. It syncs totals into a database the user owns, checks them
against the business's source of truth, and finds what to fix. It never sends a message, stores no
customer records, and has no account or server of ours in the path.

## Before you start

- Node 20 or newer.
- On macOS, keys go in the keychain. Elsewhere, use the LIFECYCLE_* environment
  variables in \`cosmic docs troubleshooting\`.
- Never ask the user to paste a key into the chat. Ask them to export it as an
  environment variable, then pass the variable name with --key-env or --secret-env.

## Fastest path to a trusted number

1. Install, if cosmic --version does not answer (Node 20 or newer):
     npm install -g https://github.com/jbauman-26/cosmic-lifecycle/releases/latest/download/cosmic-lifecycle.tgz
2. Show it working with no keys, on labeled sample data:
     cosmic demo
3. Set up the local database, saying what kind of business this is:
     cosmic init --type shopify    (or ecommerce, saas, b2b, agency, creator)
   Ask the user what they market and which tools they already use, then pick the type.
   Not a Shopify store? Run cosmic docs workspaces, connect the source of truth
   it names (Stripe or HubSpot), and skip the Klaviyo and Shopify steps below.
   For a SaaS product, cosmic demo --type saas shows the checks on Stripe data.
   If the user already loads Stripe or Shopify with Fivetran or Airbyte into their own Postgres,
   read those tables instead of connecting the API again:
     cosmic connect pipeline --tool fivetran --source stripe --schema stripe --url-env PIPELINE_DATABASE_URL
4. Connect ONE source first, the one the user relies on most. For a store, Klaviyo
   takes about 2 minutes:
     cosmic sources catalog
     cosmic docs setup
     cosmic connect klaviyo --key-env KLAVIYO_READ_KEY
   Shopify takes about 15 minutes because it needs two dashboards. Add it after
   Klaviyo works. One working source beats three half-connected ones.
5. Sync and check:
     cosmic sync --format json
     cosmic reconcile --format json
6. Verify:
     cosmic doctor --format json
     cosmic sources list --format json
7. Give the user one verified number with its trust line, for example:
     cosmic metrics run flow_revenue_per_recipient --format json

## Only after that, if the user asks

- Agent access in Claude Code: \`claude mcp add lifecycle -- cosmic mcp\`
- Slash commands: \`cosmic skills sync\`
- Runbooks: \`cosmic kits list\`, then \`cosmic kits add NAME\`
- A daily sync from their own GitHub: \`cosmic deploy --repo OWNER/NAME\`, then \`cosmic jobs list\`
- One local page with every number and check: \`cosmic dashboard\`

Do not lead with these during first-time setup.

## Rules

- Never quote a number before \`cosmic reconcile\` has run. If a check failed, say so first.
- Prefer \`cosmic metrics\` to custom SQL.
- Never claim a source is connected until \`cosmic sources list\` says so.
- Never run \`cosmic segments apply\` without the user approving that exact plan.
- If the user would rather have someone set it up for them, Jake Bauman at NorthSignal does setup, starting with a free call: https://northsignal.studio/lifecycle
- When finished, report which sources are connected, the reconcile result, and the checks you ran.
`,
    agents: `# Lifecycle CLI for agents

Read this before working with Lifecycle.

If the tool is not set up yet, follow \`cosmic docs quickstart\` instead.

1. Run \`cosmic status --format json\` first, then \`cosmic doctor --format json\` if anything looks wrong. \`cosmic workspace show --format json\` says what kind of business this is and which source its numbers are checked against.
2. Run \`cosmic reconcile\` before quoting any number. If a check failed, say so first. If the trust line status is \`unreferenced\`, the numbers were not checked against a source of truth: say that first, in the line's own words.
3. For a standard number, use a verified metric: \`cosmic metrics list\`, then \`cosmic metrics run NAME --format json\`. The same metric always runs the same SQL, so answers stay comparable over time. Quote the metric name with the number. The list ends with any numbers the owner saved (\`saved: true\`). Those run the owner's own SQL through the same read-only path and carry the same trust line, but Cosmic has not reviewed them: say "saved by the owner" when you quote one. Save one only when the owner asks: \`cosmic metrics save NAME --sql 'SELECT ...'\`.
4. Write your own SQL only when no metric fits. Run \`cosmic schema --format json\` first and never guess column names. Query with \`cosmic query "SELECT ..." --format json\`. Queries are read-only and capped at 1,000 rows unless \`query.row_cap\` is set. Tell the user the number came from custom SQL, and show it.
5. Report the sync warnings. Do not hide them from the user.
6. For a fact only the live API has, such as the current flow list or Shopify's own order count, use a tool: \`cosmic tools catalog\`, then \`cosmic tools run TOOL --format json\`. These built-in tools are read-only and return no personal data. For images, video, voice or scraping, any Kie, fal, Apify or ScrapeCreators id also runs on the user's own account with that provider. Read \`cosmic docs tools\` first: those jobs cost money and must never be started twice.
7. Saved reports, dashboards and plans are in \`cosmic files ls\`. Read one with \`cosmic files cat PATH\`.
8. Read the owner's notes before explaining a number: \`cosmic notes list --format json\`, or the MCP \`owner_notes\` tool. Metric and query results carry the matching ones as \`owner_notes\`. Apply them in your explanation and say which note you applied. They never change the SQL. When the owner corrects you, offer to save the correction: \`cosmic notes add "..."\`.
9. Any before-and-after comparison you report is "before and after, not a holdout". Never call it causal lift.
10. For a named job, such as a flow audit, use a kit: \`cosmic kits search "flow audit"\`, then \`cosmic kits add NAME\`, then follow its AGENT.md through the Verify checklist.

Rules:
- The database holds totals only. It has no customer names, emails, phones or addresses. shopify_order_state and shopify_customer_first hold a scrambled id per Shopify customer and order (a keyed hash, the key kept outside the database) so a sync can fetch only changed orders. They are sync machinery: queries that would return those ids are refused, and you never need them for a number.
- Revenue in fact_flow_daily is Klaviyo attributed revenue. Say so, and never present it as proof of causation.
- fact_crm_* tables hold HubSpot counts and amounts by day, pipeline, stage and original source. There are no contact, company or deal records.
- Purchases and purchase value in fact_meta_ads_daily are what Meta attributes to its own ads. They are a claim, not orders. Never add them to Shopify revenue or to email revenue. For a number with no attribution in it, use the marketing_efficiency_ratio metric.
- Conversions and conversions_value in fact_google_ads_campaign_daily and fact_google_ads_ad_group_daily are what Google attributes to its own ads. They are a claim, not orders, and they overlap with Meta's claims. Never add them to Shopify revenue, to email revenue or to Meta's purchases. cost is in the account currency.
- fact_merchant_performance_daily holds Merchant Center clicks and impressions by day and marketing_method (ORGANIC is free listings, ADS is Shopping ads). conversions and conversion_value are reported by Google for free listings only, so ADS rows have none; they are a claim, not orders. Never add them to Shopify revenue or to Google Ads conversions. currency is empty on rows with no value.
- fact_merchant_products_daily is one snapshot per sync day of how many products Merchant Center holds and how many are eligible, eligible_limited, pending or disapproved. A day with no sync has no row. There are no product ids or titles.
- Conversions and conversion_value in fact_microsoft_ads_daily and fact_linkedin_ads_daily are what Microsoft Advertising and LinkedIn attribute to their own ads, by their own rules (for Microsoft, the account's conversion goals; for LinkedIn, post-click and post-view website conversions). They are claims, not orders, and they overlap with every other network's claims. Never add them to Shopify revenue, to CRM revenue, to email revenue or to another network's conversions. spend is in the account currency. LinkedIn days are UTC days.
- conversions and conversion_value in fact_reddit_ads_daily and fact_snapchat_ads_daily are the purchases Reddit and Snapchat attribute to their own ads (Reddit: click-through plus view-through; Snapchat: its default 28-day swipe and 1-day view windows). They are a claim, not orders, and they overlap with Meta's and Google's claims. Never add them to Shopify revenue, to email revenue or to another network's claims. spend is in the account currency. clicks in fact_snapchat_ads_daily are swipe-ups. Days follow each ad account's own time zone.
- Conversions and conversion_value in fact_tiktok_ads_daily are website purchases and their value as TikTok attributes them to its own ads. In fact_pinterest_ads_daily they are checkouts and their value as Pinterest attributes them. Both are claims, not orders, and they overlap with Meta's and Google's claims. Never add them to Shopify revenue, to email revenue or to each other. spend is in the account currency.
- Nothing in this tool sends a message, and nothing changes an ad account or a product feed. Meta Ads, Google Ads, Google Merchant Center, Microsoft Advertising, LinkedIn Ads, Reddit Ads, Snapchat Ads, TikTok Ads and Pinterest Ads are read only.
- If a command fails with code \`busy\`, another lifecycle command is writing to the store. Wait and run it again. Do not delete files to get past it.
- \`--cloud\` on a read command asks Cosmic Cloud instead of this machine. Use it only when the user is logged in (\`cosmic cloud status --format json\`). Code \`not_built\` means Cloud does not have that route yet: run the command without \`--cloud\`, and do not retry. See \`cosmic docs cloud\`.
`,
    workspaces: `# Workspace types

A workspace is one business. Its type decides the source of truth the trust gate
checks against, the metrics \`cosmic metrics list\` shows, and the demo.

  cosmic init --type TYPE           set it (asked in a terminal when not given)
  cosmic workspace show             what this workspace is checked against
  cosmic metrics list --pack TYPE   any type's metrics; --pack all for every one
  cosmic demo --type saas           the demo for a type (shopify, saas, b2b)

| Type | For | Source of truth | Usual sources |
|---|---|---|---|
| shopify | A store on Shopify | Shopify orders | shopify, klaviyo, ga4, meta, stripe |
| ecommerce | WooCommerce, BigCommerce or a Stripe checkout | Stripe charges | stripe, ga4, meta, woocommerce, klaviyo |
| saas | Software or memberships billed in Stripe | Stripe | stripe, ga4, meta, hubspot, posthog |
| b2b | Revenue through a CRM pipeline | HubSpot | hubspot, ga4, meta, pipedrive, stripe |
| agency | One workspace per client | Set per client | ga4, meta, stripe, hubspot, shopify |
| creator | Memberships, products, sponsorships | Stripe | stripe, ga4, meta, mailchimp, klaviyo |

An install made before 0.14.0 has no type and is a Shopify store. Nothing about
it changes.

## The trust line

Every metric and report carries one. For a store it reads as it always has. For
any other type it names the source of truth:

- passed: "Numbers passed reconciliation against Stripe."
- failed: "DO NOT TRUST THESE NUMBERS YET. Failed checks: ..."
- unreferenced: the numbers were not checked against a source of truth, because
  none is set or it has not synced, or the only one is GA4. The line says which,
  in plain words. This is not a failure: each number is still its tool's own count.
- unchecked: reconcile has not run, or every check was skipped because no source has synced.

Change the source of truth with:
  cosmic config set workspace.reference stripe   (or hubspot, shopify, ga4, none)

## Checks by source of truth

Stripe: stripe_daily_complete (the daily table holds every charge the pull saw),
subscriptions_balance (starts minus ends equals subscriptions open now, so churn
adds up), ga4_vs_reference (GA4 purchases against Stripe charges, when GA4 records
purchases), ad_claims (Meta's claimed purchases against new paying customers, or
charges for a store; a warning above reconcile.ad_claim_flag percent, never a
failure), freshness.

HubSpot: deals_complete and contacts_complete (pulled against HubSpot's own
count), deals_daily_vs_pulled, freshness.

Shopify: the store checks. GA4: freshness only, and the line says GA4 is a
tracking tool. None: freshness only.

## Contribution margin for a store

Costs live in costs.json in the workspace folder, the same file the Cosmic AI app
writes under Settings, Costs. From the terminal:
  cosmic costs set currency USD
  cosmic costs set cogs shopify              (or percent:35)
  cosmic costs products costs.csv --fallback 30   (sku,unit_cost; a cost per product)
  cosmic costs set shipping per_order:6.50   (or percent:4, or none)
  cosmic costs set payment_fee_percent 2.9
  cosmic costs set payment_fee_per_order 0.30
  cosmic costs set ad_spend meta             (or none)
  cosmic costs sync                          reads product costs and SKUs from Shopify
  cosmic metrics run contribution_margin

cm1 = revenue - cogs, cm2 = cm1 - shipping - payment fees, cm3 = cm2 - ad spend.
Revenue is Shopify net revenue, tax included. The answer lists what went in and
what was counted as zero. Metrics: cogs, gross_margin, contribution_margin_before_ads,
contribution_margin, contribution_margin_percent, cost_coverage.

## One total across stores

Each store is a workspace on this machine with its currency in costs.json, then:
  cosmic metrics run shopify_net_revenue --all-stores --currency USD --rate-date 2026-11-20
Rates: European Central Bank reference rates, via Frankfurter, the same as the app.
A store's amount is divided by the rate. Every total names the rate day. A store
with no currency or no rate is listed and left out. --rate EUR=0.91 sets one by hand.

## Agencies: one workspace per client

  cosmic --workspace acme-co init --type agency --reference stripe
  cosmic --workspace acme-co connect stripe --key-env ACME_STRIPE_KEY
  cosmic --workspace acme-co sync
  cosmic workspace list

Each named workspace has its own config, database, files and keychain entries
under ~/.lifecycle/workspaces/NAME. LIFECYCLE_WORKSPACE does the same as the flag.
Without either, the workspace is ~/.lifecycle, as before 0.14.0.

## Sources for each type

Built in, with reconcile checks: shopify, klaviyo, ga4, stripe, meta, hubspot.
Built in, read only, not yet run on a live account: google-ads, google-merchant-center, microsoft-ads, linkedin-ads, reddit-ads, snapchat-ads, tiktok-ads, pinterest-ads.
Warehouse connectors written from the vendor docs and not yet run on a real
account: hubspot-records, pipedrive, woocommerce, bigcommerce, customer-io.
Planned: salesforce, google-search-console, posthog, mixpanel.
For anything planned, bring daily totals in with
  cosmic sources import NAME --csv FILE
See them with: cosmic sources catalog --type TYPE
`,
    kits: `# Kits

A kit is a runbook your agent follows, not a package. Each one is a folder:

kit.yaml    what it needs, what it writes, which secrets, which CLI version
AGENT.md    the steps, ending in a Verify checklist
README.md   the human overview
files/      reference files the runbook points at

The CLI stages kits. Your agent follows them. You check the Verify list.

Where kits come from:
  Kits live in their own repo, https://github.com/jbauman-26/cosmic-registry,
  so a kit fix ships without a new CLI. The CLI clones it into ~/.lifecycle/registry
  on first use and refreshes it at most every 10 minutes. If a refresh fails, it
  keeps working from the last copy and prints a warning. A machine that has never
  been online uses the copy that shipped with the CLI.

Use another registry, such as a fork or a local folder:
  --registry PATH_OR_URL, then LIFECYCLE_REGISTRY, then "registry": {"uri": ...}
  in ~/.lifecycle/config.json, then the public registry.

Flow:
  cosmic kits list
  cosmic kits search "win back"
  cosmic kits show winback-segment
  cosmic kits add winback-segment
  Then: "Follow lifecycle-kits/winback-segment/AGENT.md"

Skills for Claude Code and Cursor:
  cosmic skills sync installs /lifecycle and one /lifecycle:kits:NAME skill
  per kit. It never overwrites a file you edited. cosmic skills uninstall
  removes what it installed. When logged in to Cosmic Cloud it also installs
  the store's own skills, pushed with cosmic skills push DIRECTORY.
  See cosmic docs cloud.

cosmic kits show NAME also lists every file in the kit, so you can see what
kits add will copy before it does.

Writing a kit:
  Copy a kit folder in the registry, edit it, then run
  cosmic kits validate . --write-index
  The same check runs in the registry's CI.
`,
    commands: `cosmic demo [--type shopify|saas|b2b]
cosmic init [--type shopify|ecommerce|saas|b2b|agency|creator] [--reference SOURCE] [--database-url-env NAME]
cosmic workspace show|list
cosmic --workspace NAME COMMAND    (or LIFECYCLE_WORKSPACE=NAME)
cosmic connect klaviyo --key-env NAME
cosmic connect shopify --shop NAME.myshopify.com --client-id ID --secret-env NAME   (--store still works)
cosmic connect ga4 --property ID --client-id ID --secret-env NAME --refresh-token-env NAME
cosmic connect stripe --key-env NAME
cosmic connect meta --account ID --token-env NAME
cosmic connect hubspot --token-env NAME
cosmic connect google-ads --customer ID --client-id ID --secret-env NAME --refresh-token-env NAME [--login-customer ID]
cosmic connect google-merchant-center --account ID --client-id ID --secret-env NAME --refresh-token-env NAME
cosmic connect microsoft-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME --developer-token-env NAME [--customer ID]
cosmic connect linkedin-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME
cosmic connect reddit-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME
cosmic connect snapchat-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME
cosmic connect tiktok-ads --account ID --app-id ID --token-env NAME
cosmic connect pinterest-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME
cosmic sync [--since DATE] [--only SOURCE[,SOURCE]] [--cloud]
cosmic disconnect SOURCE [--delete-data]
cosmic schema [TABLE] [--cloud]
cosmic query "SELECT ..." [--cloud]
cosmic metrics list [--pack TYPE|all] [--cloud]|show NAME|run NAME... [--days N] [--cloud]|candidates
cosmic metrics save NAME --sql 'SELECT ...' [--title TEXT] [--unit count|usd|percent|usd_per_recipient|ratio]
cosmic metrics delete NAME
cosmic metrics run NAME... --all-stores|--stores A,B --currency USD [--rate-date DATE] [--rate EUR=0.91]
cosmic costs show|set KEY VALUE|products CSV [--fallback PCT]|sync
cosmic sources list [--cloud]|catalog [--type TYPE]|import NAME --csv FILE [--date-column NAME]
cosmic tools catalog [--query TEXT]|providers|run TOOL [--input JSON] [--wait] [--timeout SECONDS] [--out FILE]|get RUN [--out FILE]|abort RUN|runs
cosmic exec -- COMMAND [ARGS]
cosmic serve [--port N]
cosmic provision neon --key-env NEON_API_KEY [--name N] [--region R] [--yes]
cosmic files ls [PATH]|cat PATH|get PATH [DIR]|put FILE [NAME]|path|pull
cosmic reconcile
cosmic report revenue-per-flow [--html FILE]
cosmic audit flows [--html FILE]
cosmic segments propose winback
cosmic segments apply PLAN_FILE --confirm
cosmic kits list [--type TYPE]|search QUERY|show NAME|prompt NAME|add NAME [--into DIR]
cosmic kits validate [DIR] [--write-index]
cosmic skills sync|status|uninstall [--target claude|cursor|all]
cosmic skills push DIRECTORY [--slug NAME]
cosmic skills delete SLUG
cosmic login [--url URL] --token-env VAR
cosmic logout
cosmic cloud status
cosmic feedback MESSAGE [--open]
cosmic deploy [--repo OWNER/NAME] [--yes] [--write DIR]
cosmic jobs list|run
cosmic logs [--cloud] [--actions] [--follow] [--limit N]
cosmic dashboard [--html FILE] [--days N]
cosmic status
cosmic config list|get|set|unset KEY [VALUE]
  keys: registry.uri, deploy.repo, update.check, cloud.url,
        reconcile.tolerance.klaviyo_orders (3), reconcile.tolerance.ga4_purchases (15),
        reconcile.attributed_share_flag (60), reconcile.freshness_days (2),
        query.row_cap (1000), metrics.default_days (90)
  outside a Shopify workspace also: workspace.reference, reconcile.ad_claim_flag (100)
  for a roll-up across stores: workspace.currency, rollup.currency
cosmic secrets list|set NAME --from-env VAR|delete NAME
cosmic mcp
cosmic doctor
cosmic warehouse show|connect|sync|schema|query|scrub [--confirm]|list|disconnect|add-api
cosmic docs quickstart|setup|workspaces|agents|kits|commands|tools|cloud|warehouse|troubleshooting

Add --format json to any command.`,
    cloud: `# Cosmic Cloud

Cosmic Cloud is the hosted copy of a store: its connections, its warehouse and
its schedules. This machine keeps working without it. Logging in adds one thing:
--cloud on a read command asks Cloud instead of the database on this machine.

Log in:
  The store owner creates a token in Cosmic Cloud under Settings, Mac app access.
  It is shown once. Put it in an environment variable, never in a chat:
    export COSMIC_CLOUD_TOKEN=...
    cosmic login --token-env COSMIC_CLOUD_TOKEN
  login checks the token with Cloud (GET /api/v1/store), prints the store's name,
  then saves the address in config.json (cloud.url) and the token in the keychain.
  The token is never printed, logged or written to a file.
  cosmic cloud status shows the store, the address, where the token comes
  from, and each connection on Cloud. cosmic logout forgets the token and
  the address on this machine. To stop a token working everywhere, revoke it in Cloud.
  A token alone is not a login: with no saved address and no LIFECYCLE_CLOUD_URL,
  --cloud stops with not_logged_in and sends nothing, even if LIFECYCLE_CLOUD_TOKEN
  is still set.

Without a keychain, such as on Linux or in CI:
    LIFECYCLE_CLOUD_URL     the Cloud address. It wins over the saved one.
    LIFECYCLE_CLOUD_TOKEN   the store token. It wins over the keychain.
  login still checks the token and saves the address, then says to keep the
  token in LIFECYCLE_CLOUD_TOKEN.
  The token is only ever sent over https, or to this machine for tests.

Ask Cloud instead of this machine:
  cosmic schema --cloud                  GET /schema
  cosmic query "SELECT ..." --cloud      POST /query, one read-only SELECT
  cosmic metrics list --cloud            GET /metrics
  cosmic metrics run NAME --cloud        GET /metrics/NAME
  cosmic sources list --cloud            GET /store
  cosmic logs --cloud                    GET /runs
  cosmic sync --cloud [--only SOURCE]    POST /sync. Starts it and returns at once
  The trust line comes with Cloud's numbers too. Read it before quoting one.
  cosmic exec does not add the Cloud token to the command's environment.

logs --cloud changed in 0.13.0:
  It used to show the last GitHub Actions log. That is now cosmic logs --actions.
  A machine that is not logged in to Cosmic Cloud still gets the Actions log from
  --cloud, so an existing script keeps working.

The store's own skills:
  cosmic skills push DIRECTORY saves a skill folder (a SKILL.md at the top,
  text files only, at most 200 KB) to the store on Cloud. The folder name is
  the skill's name, or pass --slug. Nothing is sent if a file looks like it
  holds a key: the error names the file and line. Links are not followed.
  cosmic skills delete SLUG removes it from Cloud.
  cosmic skills sync installs the store's skills beside the kit skills, under
  skills/store-SLUG, on every machine that is logged in. A skill deleted from
  Cloud is removed on the next sync, unless you edited the installed copy.

Tool runs:
  When logged in, each cosmic tools run also sends its record to Cloud:
  the tool, the request (provider, model and input, with any email address
  taken out), the status, the times and the cost. The output and the error
  text stay on this machine. If Cloud cannot be reached the run still succeeds,
  and the JSON says "cloud": { "posted": false }.

"Cosmic Cloud does not have this yet" (code not_built):
  Cloud is being built route by route. A route it does not have yet answers
  404 not_found, and the CLI says so plainly. Something that is not there has
  its own code instead: unknown_skill, unknown_connection, unknown_metric, unknown_table. Run the command without --cloud to use
  the data on this machine. Do not retry in a loop.

Rules:
- Cloud holds totals only, like the local database, plus the scrambled per-store Shopify ids an incremental sync needs (a keyed hash; the key is kept apart in Cloud's encrypted secrets). No customer names, emails or addresses.
- Never put the token in a prompt, a URL, a file or a commit.
`,
    tools: `# Tools

Two kinds of tool run from \`cosmic tools run\`.

## Built-in tools

Read-only calls to Klaviyo and Shopify on the store's own keys. They finish in seconds and return no personal data.

\`\`\`sh
cosmic tools catalog
cosmic tools catalog --query orders
cosmic tools run shopify.order_count
\`\`\`

## Open provider refs

Any model, actor or path from four providers runs by its id, with no list to be on. Each one bills the account the key belongs to. Cosmic adds no markup and holds no account.

| Ref | Key | Where ids are listed |
|---|---|---|
| \`kie:<model>\` | \`kie-api-key\` | https://kie.ai/market |
| \`fal:<endpoint_id>\` | \`fal-key\` | https://fal.ai/models |
| \`apify:<owner~actor>\` | \`apify-token\` | https://apify.com/store |
| \`scrapecreators:<path>\` | \`scrapecreators-key\` | https://docs.scrapecreators.com |

\`cosmic tools providers\` shows which keys are set. Save a key from an environment variable, never from the command line:

\`\`\`sh
cosmic secrets set kie-api-key --from-env KIE_KEY
\`\`\`

Input is the JSON that provider's own page documents for that id. Read that page before the first run.

\`\`\`sh
cosmic tools run kie:gpt-image-2-text-to-image --input '{"prompt":"A red running shoe on white","aspect_ratio":"3:4"}' --wait --out shoe.json
cosmic tools run fal:fal-ai/minimax/voice-clone --input '{"audio_url":"https://..."}' --wait
cosmic tools run apify:apimaestro~linkedin-profile-posts --input '{"username":"someone"}' --wait --timeout 600
cosmic tools run scrapecreators:v1/reddit/search --input '{"query":"welcome email"}'
\`\`\`

- Kie, fal and Apify jobs finish later. Without \`--wait\` the command prints a run id and returns. \`cosmic tools get RUN\` checks the job and saves the result when it is done.
- ScrapeCreators answers in the same call. Input becomes query parameters. Pass \`--method POST\` for its POST endpoints.
- Apify output is the run's dataset, up to 1,000 items. The rest stay in the dataset on Apify.
- Kie chat models answer directly and are not supported. Use image, video and audio models.
- A finished run shows what it cost when the provider reports it: Kie and ScrapeCreators in credits, Apify in US dollars. fal does not report a cost.
- Every run keeps the request it sent: provider, model and input. \`cosmic tools get RUN\` shows it under \`request\`, so a result can be tied back to what was asked. A key is never part of it. An input field named like a key, such as \`api_key\`, is saved as \`[removed]\`.
- \`cosmic tools abort RUN\` asks the provider to stop a run that is still going. Apify and fal can stop one. Kie cannot (code \`cannot_abort\`), and ScrapeCreators has already answered. Work done before the stop may still be billed. A run that had already finished is saved as it ended, not as aborted.

## Rules for agents

1. **Never run a job twice to get its result.** If \`--wait\` times out, the job is still going and still billing. Check it with \`cosmic tools get RUN\`. Starting it again pays twice.
2. If a start fails with "No answer from the provider", look in that provider's dashboard before trying again. The job may have started.
3. These jobs cost the user money. Say what you are about to run and why before a batch.
4. Scrapers return public profiles and posts. That is personal data. Do not load it into the warehouse, and keep only what the task needs.
5. Open refs are not in the MCP server. They run from the command line only, where the user can see each call.
`,
    warehouse: `# The warehouse

Raw tables from the tools a store runs on, one schema per source
(src_gorgias, src_recharge, ...), in your own database. Loaded by dlt
(Apache 2.0), run through uv.

uv, the Python runner:
  The Cosmic AI app and Cosmic Cloud carry their own uv and point the CLI at it,
  so an owner installs nothing. uv downloads the Python it needs on first use.
    LIFECYCLE_UV_PATH        full path to a uv binary to use instead of uv on PATH
    LIFECYCLE_UV_CACHE_DIR   where uv keeps its downloads (Python and dlt)
  From a terminal without either: curl -LsSf https://astral.sh/uv/install.sh | sh
  With no uv at all, warehouse commands fail with code missing_uv. The CLI package
  does not ship uv itself.

Where it lands:
  Postgres (cosmic init --database-url-env, or provision neon): schemas in that database.
  Local setup: ~/.lifecycle/warehouse.duckdb.

Find and connect a source:
  cosmic sources catalog [--query reviews] [--category helpdesk] [--readiness built]
  cosmic warehouse show gorgias
  export GORGIAS_KEY=...        # never paste keys into a chat
  cosmic warehouse connect gorgias --secret api_key=GORGIAS_KEY --set subdomain=yourstore --set email=you@store.com
  cosmic warehouse sync [gorgias]
  cosmic warehouse schema [gorgias]
  cosmic warehouse query "select status, count(*) from src_gorgias.tickets group by 1"
  cosmic warehouse list | disconnect SLUG

Readiness, said plainly:
  native   built in (Shopify, Klaviyo, GA4, Stripe, Meta Ads, Google Ads, Google Merchant Center, Microsoft Advertising, LinkedIn Ads, Reddit Ads, Snapchat Ads, TikTok Ads, Pinterest Ads). Shopify, Klaviyo and GA4 have reconcile checks
  tested   a warehouse connector that has synced a real account
  built    written from the vendor's API docs, not yet run on a real account.
           Expect the first sync to need a fix. Report it: cosmic feedback
  planned  no connector yet. Use cosmic sources import NAME --csv FILE
           Google Search Console is planned as a built-in source. It needs
           Google sign-in, which happens in the Cosmic AI app. The CLI has no
           connector code for it yet.

Personal data:
  Customer names, emails, phone numbers and street addresses never enter the
  warehouse. One rule list decides (src/personal.ts, docs/PERSONAL-DATA.md),
  and the loader, schema, query and scrub all read it:
    Removed everywhere   email, phone, mobile, fax, street address, postal code,
                         birthday, IP address, coordinates, passwords, tokens,
                         and a person's name: first, last, full, given, family,
                         display, nick, user, reviewer, author, requester,
                         assignee, customer, recipient, sender.
    Removed in people    In a table of people (users, customers, contacts,
                         members, subscribers ...) and inside a person object
                         (customer, reviewer, ship_to ...): name, alias, handle,
                         initials, avatar, photo, signature, social handles,
                         street lines. Also text stored directly under author,
                         reviewer, customer or recipient, and a review's own
                         name field.
    Kept                 ids, counts, amounts, timestamps, statuses, product
                         and campaign names, country, state or province,
                         region, city, time zone, locale, language, currency.
    Per source           Fields a vendor names in its own way are listed per
                         source and table in the same file.
  A spec can list more keys under "stripFields".

  Free text (ticket subjects, message bodies, review text, notes) can hold
  anything a customer typed, including a name. It is a known risk:
    cosmic config set warehouse.free_text keep   the default. Free text is
        loaded with email addresses and phone numbers replaced by [removed].
        A name inside the text stays.
    cosmic config set warehouse.free_text drop   free text is not loaded.
  Text the store wrote itself (campaigns, flows, segments) is not free text.
  Open-ended fields (custom_fields, metadata, properties) are free text as a
  whole, and are removed when they sit inside a person.

  cosmic schema and cosmic warehouse schema mark every column:
    { "column": "name", "type": "VARCHAR", "personal": true, "freeText": false }
  cosmic query and cosmic warehouse query refuse SQL that could return a
  column marked personal, with code personal_column. That covers an alias, a
  star, a subquery, a CTE, a cast, and a whole row such as row_to_json(u).
  While a table still has a personal column: name the columns you need, put
  each table right after FROM or JOIN, and use count(*) as the only star.

  A warehouse filled before 0.13.2 can hold a name the old rules missed:
    cosmic warehouse scrub             counts per table, changes nothing
    cosmic warehouse scrub --confirm   empties those columns
  It never prints a stored value. With warehouse.free_text drop it empties
  free text too; with keep it replaces emails and phone numbers inside it.
  It also removes the copies of loaded rows that older versions left in the
  loader's folder (~/.lifecycle/dlt), and rebuilds the local database file so
  the old values are gone from its bytes, not only from queries. On Postgres
  the old row versions stay until the database vacuums the table.

  To load everything, by your own choice:
  cosmic warehouse connect SLUG ... --keep-personal-data
  Those columns are still marked personal, and query still refuses them. Read
  them with your own database client.

Any other tool with a REST API:
  Write a spec, then cosmic warehouse add-api my-tool --spec spec.json
  {
    "name": "My Tool",
    "category": "ops",
    "docs": "https://example.com/api",
    "credentials": [{ "name": "api_key", "label": "API key", "help": "Settings, API" }],
    "params": [],
    "config": {
      "client": { "base_url": "https://api.example.com/v1/",
                  "auth": { "type": "bearer", "token": "{secret:api_key}" } },
      "resource_defaults": { "primary_key": "id", "write_disposition": "merge" },
      "resources": [ { "name": "orders", "endpoint": { "path": "orders", "data_selector": "data" } } ]
    }
  }
  "config" is a dlt rest_api config: https://dlthub.com/docs/dlt-ecosystem/verified-sources/rest_api/basic
  {secret:NAME} and {param:NAME} are filled in at run time.

Daily sync: cosmic deploy adds warehouse sources and their keys to the
GitHub Actions job automatically.`,
    troubleshooting: `Shopify says the app is not approved to access orders:
  In the Partner Dashboard open your app, then API access requests, then
  Protected customer data access, and select Analytics. Leave name, email,
  phone and address unselected.

No keychain, such as on Linux, in CI, or when an app passes keys per call:
  Set these instead: LIFECYCLE_KLAVIYO_READ_KEY, LIFECYCLE_SHOPIFY_CLIENT_SECRET,
  LIFECYCLE_DATABASE_URL, LIFECYCLE_GA4_CLIENT_SECRET, LIFECYCLE_GA4_REFRESH_TOKEN,
  LIFECYCLE_STRIPE_READ_KEY, LIFECYCLE_META_ADS_TOKEN.
  cosmic connect SOURCE --key-env NAME still works there: it checks the key,
  saves the source's settings, and reports keyStorage "environment" with the
  variable to set at sync time. The key itself is not saved anywhere.
  Some sources replace a sign-in when it is used (Pinterest always, Microsoft
  Advertising sometimes). Set LIFECYCLE_ROTATED_FILE to a path and the CLI merges
  each new value into it as JSON, { "pinterest-ads-refresh-token": "..." }, keyed
  by secret name, mode 0600. Store each value in its LIFECYCLE_* variable before
  the next run. Values are never printed.

"Another lifecycle command is writing to this store" (code busy):
  Two commands never write one local database at once. sync, connect, init,
  reconcile, disconnect, metrics save and the warehouse writes take a lock file,
  write.lock in the home folder. A second one waits 10 seconds
  (LIFECYCLE_LOCK_WAIT_MS), then fails with code busy. Reads are not blocked.
  A read that would first bring an older database up to date (report, audit,
  logs, metrics candidates, segments propose) skips that step while a writer
  holds the store, and never writes beside it.
  Cosmic Cloud answers busy the same way when a change to the store is running
  there. The CLI passes on how many seconds Cloud said to wait.
  sync --cloud takes no lock here: it does not touch this machine's database.
  A lock left by a command that crashed is cleared on the next run. A Postgres
  store does its own locking and takes no lock file.

Your tables live in their own Postgres schema, not public:
  cosmic query and saved metrics use the connection's own schema: whatever
  its role or URL puts first on the search path. To name it yourself, set
  LIFECYCLE_DB_SCHEMA=your_schema, and every read and write uses that schema.
  System tables stay blocked either way.

Your orders live under a custom Klaviyo metric:
  Set LIFECYCLE_KLAVIYO_ORDER_METRIC to that metric's id.

Klaviyo returns 401:
  The key was revoked or the account changed. Create a Read-Only key and run
  cosmic connect klaviyo again.

Meta refused the token, or says it cannot read the ad account:
  System user tokens can be set to never expire. A token made in the Graph API Explorer lasts hours.
  Make a system user token with ads_read, give the system user access to the ad account,
  then cosmic connect meta --account ID --token-env NAME.

Google Ads says the project only has Test access:
  A Cloud project starts with Test access, which reads test accounts only. Apply for Explorer
  access on the project's Google Ads API Overview page. Explorer allows 2,880 operations a day
  on live accounts. Basic needs brand verification first.

Google Ads says the account cannot be read, or that it is a manager account:
  Connect a client account, not a manager. If access comes through a manager account, add
  --login-customer MANAGER_ID. A refresh token from an app in Testing mode stops working after
  seven days; sign in again for a new one.

Merchant Center says the project is not registered, or the Merchant API is off:
  The Merchant API needs the Cloud project turned on for it and registered with the Merchant Center
  account once. Both happen in the Google Cloud console and the Cosmic AI app. The CLI does neither,
  because it only reads. Then cosmic connect google-merchant-center again.

Merchant Center says the account cannot be read:
  The Google user needs Performance and insights or Admin access on that Merchant Center account.
  Check the account id at the top of Merchant Center. A refresh token from an app in Testing mode
  stops working after seven days; sign in again for a new one.

Microsoft Advertising refused the sign-in or the developer token:
  Code 105 usually means a sandbox developer token used against production, or the other way
  round. Use the production token from Settings, Developer settings. Microsoft may replace the
  refresh token when it is used; the CLI keeps the new one in the keychain. Without a keychain it
  writes the new one to LIFECYCLE_ROTATED_FILE when that is set. Otherwise one passed in an
  environment variable (as in GitHub Actions) is not updated, so sign in again if it stops working.

Microsoft Advertising says the account cannot be read:
  Use the aid= number from the address bar, not the account number. If you reach the account
  through an agency's manager account, add --customer with that manager's cid= number.

LinkedIn says the ad account cannot be read:
  The signed-in member needs a role on the ad account (Viewer is enough), and the sign-in needs
  r_ads and r_ads_reporting. LinkedIn also answers "not found" when the app is not approved for
  the Advertising API. A test ad account syncs, but LinkedIn reports no numbers for it.

Reddit Ads or Snapchat Ads says the account cannot be read:
  The signed-in member needs access to that ad account: on Reddit, a role in the business that
  includes reporting; on Snapchat, a role on the ad account that can see reports. Check the id,
  then connect again. A refresh token stops working if the member revokes the app or leaves.

Reddit Ads or Snapchat Ads numbers change for recent days:
  Both restate recent days as late conversions arrive. Each sync pulls the last 90 days
  (metrics.default_days) again, so the numbers settle after a few syncs.

TikTok says the token is invalid, or that it cannot read the ad account:
  The long-term token stops working only when the advertiser revokes the app. Ask the advertiser
  to open the app's authorization link again, then cosmic connect tiktok-ads. If it says there
  is no permission, the app needs the Reporting permission and that advertiser's authorization.

Pinterest says the sign-in was refused:
  A refresh token lasts 60 days, and each use gives a new one. If the saved one came from the
  environment and was not updated, it runs out. Without a keychain, set LIFECYCLE_ROTATED_FILE so
  each run hands the new one back. Sign in with Pinterest again for a new one, then
  cosmic connect pinterest-ads. A user needs Owner, Admin, Analyst or Campaign Manager access
  on the ad account.

Meta spend looks low for the last few days:
  Meta restates recent days as late conversions arrive. Each sync pulls the last 90 days
  (metrics.default_days) again,
  so the numbers settle after a few syncs.

Stripe says the key cannot read subscriptions:
  Charges still sync. To add MRR and churn, edit the restricted key in the
  Stripe dashboard, give it Read on Subscriptions, then cosmic sync.

Flow report warning:
  An account with no sends has nothing to report. The warning clears once
  flows have sent.

Error codes (the "code" field with --format json, and in cosmic logs):
  key_rejected     The source refused the saved key (401). Make a new key, then connect again.
  rate_limited     The source asked to slow down (429) after the retries. Wait, then sync again.
  scope_denied     Shopify refused a field or scope. Add the scope it names to the app, then connect again.
  not_connected    sync --only or disconnect named a source that is not connected.
  unknown_source   Not one of shopify, klaviyo, ga4, stripe, meta.
  busy             Another lifecycle command is writing to this store, or Cosmic Cloud is changing it. Wait, then run it again.
  missing_uv       Warehouse sources need uv. Update the app, install uv, or set LIFECYCLE_UV_PATH.
  loader_failed    A warehouse source's loader stopped before it finished. Run cosmic warehouse sync SLUG --verbose to see why.
  personal_column  The SQL could return a column marked personal. Run cosmic schema --format json, leave those columns out, and name the rest one by one.
  scrub_failed     cosmic warehouse scrub could not read or change the warehouse. Nothing is half done per column: run it again.
  reserved_name    metrics save or delete named a built-in metric. Pick another name.
  bad_metric       A saved metric must be one SELECT that returns one row with one number.
  bad_schema       LIFECYCLE_DB_SCHEMA is not a plain schema name.
  not_logged_in    A Cosmic Cloud command ran with no store token, or with no saved address. cosmic login --token-env VAR.
  unauthorized     Cosmic Cloud refused the store token. Create a new one in Cloud, then log in again.
  not_built        Cosmic Cloud does not have that route yet, or a source has no connector yet. Run it without --cloud.
  cloud_unreachable  Cosmic Cloud did not answer. Check the network and cosmic cloud status.
  cloud_error      Cosmic Cloud answered with something this CLI does not understand. Try again in a moment.
  bad_url          The Cloud address is not a plain https address, or it answered with a redirect.
  bad_token        The store token has a space, a line break or another character a token never has. Copy it again.
  unknown_table    schema --cloud named a table Cloud does not hold.
  too_large        skills push: the folder is over 200 KB.
  secret_found     skills push: a file looks like it holds a key. Nothing was sent.
  bad_skill        skills push or delete: no SKILL.md, a bad name, a file that is not text, or a link.
  unknown_skill    skills delete named a skill this store does not have on Cloud.
  unknown_connection  Cosmic Cloud has no connection with that id for this store.
  cannot_abort     tools abort: this provider cannot stop a job, or the run has no cancel link.
  not_running      tools abort named a run that had already ended.

Updates:
  Update by running the install line again:
    npm install -g https://github.com/jbauman-26/cosmic-lifecycle/releases/latest/download/cosmic-lifecycle.tgz
  The Cosmic AI app and Cosmic Cloud update the CLI they carry. cosmic status checks for a newer
  release at most once a day and says nothing when it cannot see the release list.
  Turn the check off with cosmic config set update.check false.

Save a number of your own:
  cosmic metrics save repeat_orders --unit count --title "Repeat orders" \\
    --sql 'SELECT sum(returning_orders) AS value FROM fact_orders_daily WHERE date >= $1'
  $1 is the first day of the window. Use single quotes, or the shell eats the $1. One SELECT, one row, one number. It then shows
  in cosmic metrics list marked as saved by the owner, runs with
  cosmic metrics run repeat_orders, and is removed with cosmic metrics delete.
  A saved number cannot take the name of a built-in metric.

Sync one source on its own schedule:
  cosmic sync --only meta
  Each source keeps its own run in cosmic logs. Reconcile runs after every sync.

Remove a source:
  cosmic disconnect stripe removes its settings and saved keys and keeps its data.
  Add --delete-data to delete what it loaded too. A key set in a LIFECYCLE_* variable
  stays in use until you unset it.`,
};
