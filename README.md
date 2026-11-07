# Cosmic Lifecycle

Your agent should not quote a Klaviyo number it can't prove.

Cosmic Lifecycle gives Claude Code a clean view of your Shopify and Klaviyo results. It syncs totals into a database you own, checks that the numbers agree, and shows you which flows to fix first.

It is for the person running lifecycle at a Shopify brand who already works in Claude Code. It is free and open source, from [Cosmic AI](https://store.jakebauman.io/community).

## See it in 60 seconds

No keys and no accounts. This runs on invented sample data.

```sh
npm install -g https://github.com/jbauman-26/cosmic-lifecycle/releases/latest/download/cosmic-lifecycle.tgz
lifecycle demo
```

The demo loses 14 orders on purpose, then shows the tool catching it:

```
FAIL Orders pulled against Shopify's own count: 787 against 801, off by 1.75%.
     Do not trust reports built on this until it is fixed.
```

## Or let your agent set it up

Paste this into Claude Code, Cursor or Codex:

```
Set up Cosmic Lifecycle using https://raw.githubusercontent.com/jbauman-26/cosmic-lifecycle/main/llms.txt
```

[llms.txt](llms.txt) is a setup playbook written for agents. It connects one source, checks the numbers, and gives you one verified figure before it offers anything else.

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

**Answers the same question the same way every time.** `lifecycle metrics run average_order_value` runs fixed, reviewed SQL, so Monday's number matches Friday's. Each result carries its inputs, its exact SQL and the reconcile status. `lifecycle metrics list` shows all twelve. Agents use these before writing their own SQL.

**Builds a win-back segment from your own timing.** `lifecycle segments propose winback` reads how long your customers actually take to reorder, then writes a plan. Nothing happens until you review it and run `apply --confirm`.

## What it will not do

- **It does not send.** No campaign, no flow edit, no message. The only write is creating a Klaviyo segment after a reviewed plan.
- **It does not store customer records.** The database holds totals. Shopify access is set up so name, email, phone and address fields are refused.
- **It does not hold your data.** Your keys stay in your keychain, and your database is yours. There is no Cosmic AI server in the path.
- **It does not prove causation.** Flow revenue is what Klaviyo attributes. Every report says so.

## Set it up

Klaviyo takes about 2 minutes. Shopify takes about 15, because Shopify requires steps in two dashboards. `lifecycle sources catalog` lists what each source syncs and how to connect it, and `lifecycle sources list` shows what is connected.

```sh
lifecycle docs setup
```

Then:

```sh
lifecycle init
lifecycle connect klaviyo --key-env KLAVIYO_READ_KEY
lifecycle connect shopify --store NAME.myshopify.com --client-id ID --secret-env SHOPIFY_SECRET
lifecycle connect stripe --key-env STRIPE_READ_KEY   # optional: subscriptions, MRR, repeat payments
lifecycle sync
lifecycle reconcile
lifecycle audit flows --html audit.html
```

## Use it from Claude Code

Add the read-only MCP server:

```sh
claude mcp add lifecycle -- lifecycle mcp
```

Install the skills once, then ask for a job by name:

```sh
lifecycle skills sync
```

That adds `/lifecycle` and one skill per kit, such as `/lifecycle:kits:flow-audit`. It never overwrites a skill file you edited, and `lifecycle skills uninstall` removes what it added.

## Kits

A kit is a runbook your agent follows, with a Verify checklist at the end. Kits live in their own repo, [cosmic-registry](https://github.com/jbauman-26/cosmic-registry), so a kit fix reaches you without a new CLI release. The CLI downloads it on first use, refreshes it every 10 minutes, and keeps working offline from the last copy.

```sh
lifecycle kits list
lifecycle kits search "win back"
lifecycle kits show winback-segment
lifecycle kits add winback-segment
```

Kits today: `flow-audit`, `revenue-per-flow`, `winback-segment`. `lifecycle kits prompt NAME` prints a setup prompt to paste into your agent. Any kit that writes copy includes an editing standard and a required review step. To use a fork or a local folder, pass `--registry`, or see `lifecycle docs kits`.

## Run it every day

`lifecycle deploy` puts a daily sync in a private repo on your own GitHub account, against your own Postgres. It prints the plan first, and creates nothing without `--yes`.

```sh
lifecycle provision neon --key-env NEON_API_KEY --yes   # a managed Postgres in your own Neon account
lifecycle deploy --repo YOU/lifecycle-sync
lifecycle jobs list        # recent runs and the success streak
lifecycle logs --cloud     # the last run's log
```

## Check on it

```sh
lifecycle status       # setup, sources, trust line, daily sync, updates
lifecycle dashboard    # one local HTML page with every check, metric and fix
lifecycle logs         # recent syncs on this machine
lifecycle secrets list # where each key comes from, never its value
lifecycle config list  # registry.uri, deploy.repo, update.check
```

## More from the command line

```sh
lifecycle serve                                  # dashboard and a read-only JSON API on 127.0.0.1
lifecycle tools catalog                          # read-only Klaviyo and Shopify API tools, on your own keys
lifecycle tools run shopify.order_count
lifecycle exec -- node my-report.js              # run a script with your keys in its environment
lifecycle sources import meta_ads --csv ads.csv  # any other tool's daily totals
lifecycle files ls                               # every saved report, dashboard and plan
lifecycle files pull                             # the dashboard from the last daily sync
```

How each command lines up with the Graphed CLI: [docs/PARITY.md](docs/PARITY.md).

## Where this is today

This is an early release. Here is what has and has not been tested.

**Tested**
- Sync, reconcile, reports and read-only SQL on a Shopify dev store with 150 labeled sample orders.
- The Klaviyo flow report on one real flow send to our own test address.
- Klaviyo order counts against Shopify over 90 days: 36 against 36. The Klaviyo side was sample events we sent, because Klaviyo's Shopify app could not be installed on the dev store.
- Creating a win-back segment in a Klaviyo demo account.
- Local and Postgres databases, the MCP server, and a clean install.
- Stripe connect, sync, doctor and metrics on a Stripe test-mode account. Charges, failed payments, MRR and subscription starts all matched the Stripe API.

**Not tested yet**
- A production Shopify store. A merchant may need a Partner account for one setup step.
- A real brand's flow revenue, because our test send had no conversions.
- The `flow_totals` check, because Klaviyo has returned no totals for our test flow yet.
- GA4 with live data.
- Stripe on a live account. Refunds, several currencies and tiered prices are covered by unit tests only.
- `deploy` running for days on end.

If something breaks, `lifecycle doctor` says what is wrong and what to run next. To report a bug, run `lifecycle feedback "what happened" --open`.

## Requirements

Node 20 or newer. macOS keeps keys in the keychain. On other systems, set the `LIFECYCLE_*` environment variables listed in `lifecycle docs troubleshooting`.

## Have it set up for you

Rather not wire up Shopify and Klaviyo yourself? [Jake at NorthSignal](https://northsignal.studio/lifecycle#setup) sets it up with you, starting with a free call.

## Help and community

Questions and setups get shared in [Cosmic AI](https://store.jakebauman.io/community), the free community this comes from.

MIT license.
