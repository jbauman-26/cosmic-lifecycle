# Cosmic Lifecycle

Your agent should not quote a marketing number it can't prove.

Cosmic Lifecycle gives Claude Code, Cursor and Codex checked marketing numbers. It syncs totals into a database you own, checks them against your business's source of truth (Shopify orders for a store, Stripe for SaaS and other stores, HubSpot for a B2B pipeline), and puts a trust line on every number.

It is for the marketer who already works in an agent: at a Shopify brand, a SaaS company, a B2B team, an agency running many clients, or a creator business. It is free, from [Cosmic AI](https://store.jakebauman.io/community).

## Pick your workspace type

```sh
lifecycle init --type saas      # shopify, ecommerce, saas, b2b, agency or creator
lifecycle workspace show        # what your numbers are checked against
lifecycle metrics list          # the metrics for your type: MRR and churn, pipeline and win rate, ...
lifecycle demo                  # the demo for your type, on invented data
```

| Type | Source of truth | First metrics |
|---|---|---|
| shopify | Shopify orders | net revenue, AOV, flow revenue, MER, contribution margin |
| ecommerce | Stripe charges | Stripe revenue, orders, AOV, cost per new customer |
| saas | Stripe | MRR, net new MRR, churn, new paying customers, cost per new customer |
| b2b | HubSpot | new leads, pipeline created, won revenue, win rate, cost per lead |
| agency | set per client | spend, CPC, CTR, revenue, leads, one workspace per client |
| creator | Stripe | revenue, members, churn, visit to paid |

A workspace with no source of truth connected still works: its numbers carry a line that says plainly they were not checked. An install from before 0.14.0 is a Shopify store and nothing changes. See `lifecycle docs workspaces`.

## Install

The CLI ships inside the Cosmic AI Mac app and Cosmic Cloud, so if you use either, you already have it. The repo is private. If you have access to it, install a release directly:

```sh
gh release download --repo jbauman-26/cosmic-lifecycle --pattern cosmic-lifecycle.tgz
npm install -g ./cosmic-lifecycle.tgz
```

## See it in 60 seconds

No keys and no accounts. This runs on invented sample data.

```sh
lifecycle demo
```

The demo loses 14 orders on purpose, then shows the tool catching it:

```
FAIL Orders pulled against Shopify's own count: 787 against 801, off by 1.75%.
     Do not trust reports built on this until it is fixed.
```

## Or let your agent set it up

With the CLI installed, paste this into Claude Code, Cursor or Codex:

```
Set up Cosmic Lifecycle by following the output of lifecycle docs quickstart
```

`lifecycle docs quickstart` (the same text as [llms.txt](llms.txt)) is a setup playbook written for agents. It connects one source, checks the numbers, and gives you one verified figure before it offers anything else.

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

**Answers the same question the same way every time.** `lifecycle metrics run average_order_value` runs fixed, reviewed SQL, so Monday's number matches Friday's. Each result carries its inputs, its exact SQL and the reconcile status. `lifecycle metrics list` shows them all. Agents use these before writing their own SQL.

**Keeps the numbers you ask for most.** `lifecycle metrics save repeat_orders --sql 'SELECT ...'` saves one SELECT of your own as a named number. It shows in `metrics list` marked as saved by the owner, runs read-only with the same trust line, and can never take the name of a built-in metric. `lifecycle metrics delete NAME` removes it.

**Builds a win-back segment from your own timing.** `lifecycle segments propose winback` reads how long your customers actually take to reorder, then writes a plan. Nothing happens until you review it and run `apply --confirm`.

## What it will not do

- **It does not send.** No campaign, no flow edit, no message. The only write is creating a Klaviyo segment after a reviewed plan.
- **It does not store customer records.** The database holds totals. Shopify access is set up so name, email, phone and address fields are refused. Since 0.15.0 it keeps one scrambled id per Shopify customer (a keyed hash; the key is held in your keychain, outside the database, and the id cannot be turned back into a Shopify id without it) so a daily sync can fetch only the orders that changed and still count new versus returning customers right.
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
lifecycle logs --actions   # the last run's log
lifecycle logs --follow    # wait for a running sync to finish, then show its log
```

## Check on it

```sh
lifecycle status       # setup, sources, trust line, daily sync, updates
lifecycle dashboard    # one local HTML page with every check, metric and fix
lifecycle logs         # recent syncs on this machine, with an error code on any that failed
lifecycle secrets list # where each key comes from, never its value
lifecycle config list  # every setting, with its default
```

Sync one source on its own schedule, or remove one:

```sh
lifecycle sync --only meta              # also --only shopify,klaviyo or a repeated --only
lifecycle sync --only shopify --full    # read the whole order history now, not only what changed
lifecycle disconnect stripe             # forget its settings and saved keys, keep its data
lifecycle disconnect stripe --delete-data
```

Settings you can change. Each one starts at the value the CLI has always used, so nothing changes until you set it:

| Setting | Default | What it does |
|---|---|---|
| `reconcile.tolerance.klaviyo_orders` | 3 | Percent Klaviyo orders may differ from Shopify before the check fails |
| `reconcile.tolerance.ga4_purchases` | 15 | Percent GA4 purchases may differ from Shopify before the check fails |
| `reconcile.attributed_share_flag` | 60 | Warn when Klaviyo credits flows with more than this percent of revenue |
| `reconcile.freshness_days` | 2 | Days without a sync before the freshness check fails |
| `query.row_cap` | 1000 | Most rows `lifecycle query` returns |
| `metrics.default_days` | 90 | Window for metrics, reports and sync pulls when none is given |
| `shopify.full_check_days` | 7 | Days between full Shopify pulls once daily syncs fetch only changed orders |
| `shopify.overlap_days` | 3 | Days before the last sync an incremental Shopify sync looks again, for late edits and refunds |

```sh
lifecycle config set reconcile.tolerance.ga4_purchases 20
lifecycle config get query.row_cap
```

With `--format json`, a failure carries a `code` the app and scripts can act on: `key_rejected` (the source refused the key), `rate_limited` (it asked to slow down), `scope_denied` (Shopify refused a field or scope), `not_connected`, `unknown_source`, `busy` (another command is writing to this store), `missing_uv` (warehouse sources have no uv to run on) and `reserved_name` (a saved number tried to take a built-in metric's name).

Two commands never write one local database at once. `sync`, `connect`, `init`, `reconcile`, `disconnect` and `metrics save` take a lock file in the home folder. A second one waits 10 seconds, then fails with `busy`. Reads are not blocked, and a lock left by a crashed command is cleared on the next run.

Environment variables for an app or a server that runs the CLI:

| Variable | What it does |
|---|---|
| `LIFECYCLE_UV_PATH` | Full path to a uv binary to use for warehouse sources, in place of uv on PATH. uv fetches its own Python. The CLI package does not ship uv. |
| `LIFECYCLE_UV_CACHE_DIR` | Where that uv keeps its downloads |
| `LIFECYCLE_DB_SCHEMA` | The Postgres schema this store lives in. Unset, the connection's own schema is used, where `query` used to force `public`. |
| `LIFECYCLE_LOCK_WAIT_MS` | How long a write command waits for the lock. Default 10000. |

Where there is no keychain, `lifecycle connect SOURCE --key-env NAME` still passes once the key checks out. It saves the source's settings, not the key, and says which `LIFECYCLE_*` variable to set when you sync.

## More from the command line

```sh
lifecycle serve                                  # dashboard and a read-only JSON API on 127.0.0.1
lifecycle tools catalog                          # read-only Klaviyo and Shopify API tools, on your own keys
lifecycle tools run shopify.order_count
lifecycle tools providers                        # Kie, fal, Apify and ScrapeCreators: any id runs, on your own account
lifecycle tools run kie:gpt-image-2-text-to-image --input '{"prompt":"A red running shoe"}' --wait
lifecycle exec -- node my-report.js              # run a script with your keys in its environment
lifecycle sources import meta_ads --csv ads.csv  # any other tool's daily totals
lifecycle sources catalog --category reviews      # 98 tools Shopify stores use, 25 with connectors
lifecycle warehouse connect gorgias --secret api_key=GORGIAS_KEY --set subdomain=you --set username=you@store.com
lifecycle warehouse sync && lifecycle warehouse query "select status, count(*) from src_gorgias.tickets group by 1"
lifecycle files ls                               # every saved report, dashboard and plan
lifecycle files pull                             # the dashboard from the last daily sync
```

Every command by the job it does: [docs/COMMANDS.md](docs/COMMANDS.md).

## Cosmic Cloud

Cosmic Cloud is the hosted copy of a store. Logging in is optional. With it, `--cloud` on a read command asks Cloud instead of the database on this machine.

```sh
export COSMIC_CLOUD_TOKEN=...                     # from Cosmic Cloud, Settings, Mac app access. Never paste it into a chat
lifecycle login --token-env COSMIC_CLOUD_TOKEN    # checks the token, prints the store name, saves the token to the keychain
lifecycle cloud status                            # the store, and each connection on Cloud
lifecycle query "select * from fact_orders_daily limit 5" --cloud
lifecycle schema --cloud
lifecycle metrics list --cloud && lifecycle metrics run shopify_orders --cloud
lifecycle sources list --cloud
lifecycle sync --cloud                            # starts it on Cloud and returns at once
lifecycle logs --cloud                            # recent runs on Cloud
lifecycle skills push ./my-skill                  # a folder with a SKILL.md, text only, 200 KB at most
lifecycle skills delete my-skill
lifecycle logout
```

- The token is never printed, logged or written to a file. Without a keychain, set `LIFECYCLE_CLOUD_TOKEN`. `LIFECYCLE_CLOUD_URL` sets the address. With no saved address and no `LIFECYCLE_CLOUD_URL` (after `logout`), `--cloud` stops with `not_logged_in` and sends nothing.
- Cloud is being built route by route. A route it does not have yet fails with code `not_built` and a plain sentence. Run the command without `--cloud` meanwhile.
- `skills push` sends nothing if a file looks like it holds a key. `skills sync` installs the store's own skills beside the kit skills.
- `lifecycle tools abort RUN` stops an Apify or fal job that is still going. Every tool run keeps the request it sent, and `lifecycle tools get RUN` shows it.
- `logs --cloud` used to mean the GitHub Actions log. That is now `logs --actions`. A machine that is not logged in still gets the Actions log from `--cloud`.

More: `lifecycle docs cloud`. Every change: [CHANGELOG.md](CHANGELOG.md).

## Where this is today

This is an early release. Here is what has and has not been tested.

**Tested**
- Sync, reconcile, reports and read-only SQL on a Shopify dev store with 150 labeled sample orders.
- The Klaviyo flow report on one real flow send to our own test address.
- Klaviyo order counts against Shopify over 90 days: 36 against 36. The Klaviyo side was sample events we sent, because Klaviyo's Shopify app could not be installed on the dev store.
- Creating a win-back segment in a Klaviyo demo account.
- Local and Postgres databases, the MCP server, and a clean install.
- Stripe connect, sync, doctor and metrics on a Stripe test-mode account. Charges, failed payments, MRR and subscription starts all matched the Stripe API.
- The write lock, with two real CLI processes on one Mac: the second fails with `busy` while a read still answers.
- Saved numbers on a local database and on a local Postgres 16 server, through the CLI and the MCP `metric` tool.
- `login`, `cloud status`, a `--cloud` query and `logout` on a Mac with the keychain, against a local stand-in for Cosmic Cloud: the token went into the keychain, was read back, and was gone after `logout`.
- Since 0.13.1, every `--cloud` command, `login`, `cloud status`, `logout`, `skills push/status/sync/delete` and tool run records against the real Cosmic Cloud handlers and a local Postgres (the contract test in cosmic-cloud).
- A store in its own Postgres schema, on a local Postgres 16 server: `query` and saved numbers read the store's schema, by the role's search path and by `LIFECYCLE_DB_SCHEMA`.

**Not tested yet**
- A production Shopify store. A merchant may need a Partner account for one setup step.
- A real brand's flow revenue, because our test send had no conversions.
- The `flow_totals` check, because Klaviyo has returned no totals for our test flow yet.
- GA4 with live data.
- Meta Ads on any real ad account. The connector was written from the Ads Insights API docs and is covered by unit tests against recorded answers only.
- Stripe on a live account. Refunds, several currencies and tiered prices are covered by unit tests only.
- `deploy` running for days on end.
- The personal data rules on a real account. They were written from the vendors' API docs and are tested against made-up rows in each vendor's documented shape (`docs/PERSONAL-DATA.md`).
- Any of the 25 warehouse connectors on a real account. All were written from the vendors' API docs. The five added in 0.12.0 (Brevo, Privy, Okendo, Loox, Fairing) load in dlt and strip personal data from recorded responses, and that is all. Okendo's paging was run against a local stand-in, never Okendo.
- `LIFECYCLE_DB_SCHEMA` on Cosmic Cloud's hosted database, or behind a connection pooler.
- A bundled uv set with `LIFECYCLE_UV_PATH` inside the packaged Mac app. Here it was run with a stand-in binary and with Homebrew's uv.
- `connect --key-env` without a keychain against a live account. It was tested against recorded answers.
- Google Ads on any account, live or test. The connector was written from the Google Ads API docs (v26) and is covered by unit tests against recorded answers only. Getting a refresh token needs Google sign-in with a passkey, done by the account owner.
- Google Search Console. It is a catalog entry only, waiting on Google sign-in. There is no connector code.
- Anything against the real Cosmic Cloud. `login`, `cloud status`, every `--cloud` command, `skills push` and `delete`, and the tool run records were run against a local stand-in for the Cloud API only. Cloud does not have `/schema`, `/query`, `GET /metrics`, `/runs`, `/skills` or `/tools/runs` yet, so the shapes come from the plan, not from a live answer.
- `tools abort` on a real Apify or fal job. It was written from their API docs and tested against recorded answers.

If something breaks, `lifecycle doctor` says what is wrong and what to run next. To report a bug, run `lifecycle feedback "what happened" --open`.

## Requirements

Node 20 or newer. macOS keeps keys in the keychain. On other systems, set the `LIFECYCLE_*` environment variables listed in `lifecycle docs troubleshooting`.

## Have it set up for you

Rather not wire up Shopify and Klaviyo yourself? [Jake at NorthSignal](https://northsignal.studio/lifecycle#setup) sets it up with you, starting with a free call.

## Help and community

Questions and setups get shared in [Cosmic AI](https://store.jakebauman.io/community), the free community this comes from.

MIT license.
