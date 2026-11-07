# Cosmic Lifecycle

Your agent should not quote a Klaviyo number it can't prove.

Cosmic Lifecycle gives Claude Code a clean view of your Shopify and Klaviyo results. It syncs totals into a database you own, checks that the numbers agree, and shows you which flows to fix first.

It is for the person running lifecycle at a Shopify brand who already works in Claude Code. It is free and open source, from [Cosmic AI](https://store.jakebauman.io/community).

## See it in 60 seconds

No keys and no accounts. This runs on invented sample data.

```sh
npm install -g https://github.com/jbauman-26/cosmic-lifecycle/releases/download/v0.1.1/cosmic-lifecycle-0.1.1.tgz
lifecycle demo
```

The demo loses 14 orders on purpose, then shows the tool catching it:

```
FAIL Orders pulled against Shopify's own count: 787 against 801, off by 1.75%.
     Do not trust reports built on this until it is fixed.
```

## What it does

**Checks the numbers before anyone quotes them.** `lifecycle reconcile` compares each source against the others. Every report opens with the result, so a failed check is the first thing you and your agent see.

| Check | What it compares |
|---|---|
| `orders_complete` | Orders pulled against Shopify's own count |
| `orders_vs_cohorts` | Daily totals against cohort totals |
| `klaviyo_orders` | Klaviyo Placed Order against Shopify orders |
| `ga4_purchases` | GA4 purchases against Shopify orders |
| `attributed_share` | Flow revenue as a share of Shopify net revenue |
| `flow_totals` | Daily flow rows against Klaviyo's own totals |
| `freshness` | How long ago each source synced |

**Finds what to fix.** `lifecycle audit flows` looks for missing core flows, flows that stopped sending, falling revenue per recipient, and high spam rates. Each finding comes with its evidence.

**Ranks your flows.** `lifecycle report revenue-per-flow` ranks flows by attributed revenue per recipient, next to your Shopify revenue.

**Builds a win-back segment from your own timing.** `lifecycle segments propose winback` reads how long your customers actually take to reorder, then writes a plan. Nothing happens until you review it and run `apply --confirm`.

## What it will not do

- **It does not send.** No campaign, no flow edit, no message. The only write is creating a Klaviyo segment after a reviewed plan.
- **It does not store customer records.** The database holds totals. Shopify access is set up so name, email, phone and address fields are refused.
- **It does not hold your data.** Your keys stay in your keychain, and your database is yours. There is no Cosmic AI server in the path.
- **It does not prove causation.** Flow revenue is what Klaviyo attributes. Every report says so.

## Set it up

Klaviyo takes about 2 minutes. Shopify takes about 15, because Shopify requires steps in two dashboards.

```sh
lifecycle docs setup
```

Then:

```sh
lifecycle init
lifecycle connect klaviyo --key-env KLAVIYO_READ_KEY
lifecycle connect shopify --store NAME.myshopify.com --client-id ID --secret-env SHOPIFY_SECRET
lifecycle sync
lifecycle reconcile
lifecycle audit flows --html audit.html
```

## Use it from Claude Code

Add the read-only MCP server:

```sh
claude mcp add lifecycle -- lifecycle mcp
```

Or give your agent a runbook:

```sh
lifecycle kits add flow-audit
```

Kits: `flow-audit`, `revenue-per-flow`, `winback-segment`. Any kit that writes copy includes an editing standard and a required review step.

## Run it every day

`lifecycle deploy` puts a daily sync in a private repo on your own GitHub account, against your own Postgres. It prints the plan first, and creates nothing without `--yes`.

```sh
lifecycle init --database-url-env DATABASE_URL
lifecycle deploy --repo YOU/lifecycle-sync
```

## Where this is today

This is an early release. Here is what has and has not been tested.

**Tested**
- Sync, reconcile, reports and read-only SQL on a Shopify dev store with 150 labeled sample orders.
- The Klaviyo flow report on one real flow send to our own test address.
- Klaviyo order counts against Shopify over 90 days: 36 against 36. The Klaviyo side was sample events we sent, because Klaviyo's Shopify app could not be installed on the dev store.
- Creating a win-back segment in a Klaviyo demo account.
- Local and Postgres databases, the MCP server, and a clean install.

**Not tested yet**
- A production Shopify store. A merchant may need a Partner account for one setup step.
- A real brand's flow revenue, because our test send had no conversions.
- The `flow_totals` check, because Klaviyo has returned no totals for our test flow yet.
- GA4 with live data.
- `deploy` running for days on end.

If something breaks, `lifecycle doctor` says what is wrong and what to run next.

## Requirements

Node 20 or newer. macOS keeps keys in the keychain. On other systems, set the `LIFECYCLE_*` environment variables listed in `lifecycle docs troubleshooting`.

## Help and community

Questions and setups get shared in [Cosmic AI](https://store.jakebauman.io/community), the free community this comes from.

MIT license.
