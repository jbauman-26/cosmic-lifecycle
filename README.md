# Cosmic CLI

Your marketing data, ready for your AI agent.

Connect your marketing tools to Claude Code, Cursor or Codex. Cosmic CLI pulls your ads, analytics, payments, email and CRM data into a database you own (on your computer, or your own Postgres), checks the numbers against your source of truth, and puts a trust line on every answer. When two tools disagree, your agent hears it before you repeat the number to anyone.

For anyone who markets something: founders and SaaS teams, marketers and freelancers, creators, agencies running many clients, and online stores. Free and MIT licensed, no account. The command is `cosmic`; `lifecycle` is the same command and keeps working. The npm package is `cosmic-lifecycle`.

## What it connects

- **14 native sources:** Stripe, Google Analytics 4, HubSpot, Meta Ads, Google Ads, Microsoft Advertising, LinkedIn Ads, TikTok Ads, Pinterest Ads, Reddit Ads, Snapchat Ads, Google Merchant Center, Shopify and Klaviyo. Every connected source gets a freshness check, and the ones that overlap are checked against your source of truth (Stripe, Shopify or HubSpot).
- **100 more in the warehouse catalog, with readiness shown for each:** 30 have connector code (such as Mailchimp, Brevo, Customer.io, Pipedrive, WooCommerce, BigCommerce, Zendesk, Freshdesk) and 70 are still to build. `cosmic sources catalog` lists every one with its status.
- **Your own pipeline:** reads any table Fivetran or Airbyte loads into your Postgres. Every table gets a freshness check. The count checks run only on the built-in sources, such as Shopify orders against Shopify's own count. See below.
- **Anything else:** `cosmic sources import NAME --csv FILE` brings in daily totals from any tool.

Only Shopify, Klaviyo and Stripe have synced against real accounts so far. Every other connector is tested against recorded answers. The full test record is under "Where this is today" below.

## Start here: paste one message into Claude Code

You don't need to know how to code. Open Claude Code (or Cursor, or Codex) and paste this:

```
Install Cosmic CLI with: npm install -g https://github.com/jbauman-26/cosmic-lifecycle/releases/latest/download/cosmic-lifecycle.tgz
If Node 20 or newer is missing, help me install it first.
Then run cosmic demo, and set it up for my business by following the output of cosmic docs quickstart.
```

Your agent installs it, shows you the demo, then connects one source and gives you one checked number. It asks you for keys as environment variables and never asks you to paste a key into the chat.

## Or install it yourself

Node 20 or newer:

```sh
npm install -g https://github.com/jbauman-26/cosmic-lifecycle/releases/latest/download/cosmic-lifecycle.tgz
```

## See it in 60 seconds

No keys and no accounts. This runs on invented sample data.

```sh
cosmic demo
```

The store demo loses 14 orders on purpose, then shows the check catching it. `cosmic demo --type saas` plants a lost Stripe charge instead, and `--type b2b` a HubSpot gap.

```
FAIL Orders pulled against Shopify's own count: 787 against 801, off by 1.75%.
     Do not trust reports built on this until it is fixed.
```

## Connect it to your agent

Add the read-only MCP server to Claude Code:

```sh
claude mcp add cosmic -- cosmic mcp
```

Any other MCP client takes the same command: `cosmic mcp`. It starts before setup, so you can add it right after installing. `cosmic docs quickstart` (the same text as [llms.txt](llms.txt)) is the setup playbook your agent follows.

## Already run Fivetran or Airbyte? Bring your own pipeline

If a loader already copies Stripe or Shopify into your own Postgres, point the CLI at those tables instead of connecting the API again. The CLI only reads, takes only the columns a total needs (never names, emails or addresses), and feeds them into the same daily tables, so every check, metric and the MCP server work the same.

```sh
export PIPELINE_DATABASE_URL=postgres://user:password@host/db   # the database your loader writes to
cosmic connect pipeline --tool fivetran --source stripe --schema stripe --url-env PIPELINE_DATABASE_URL
cosmic sync
cosmic reconcile
```

| Loader | Stripe | Shopify |
|---|---|---|
| Fivetran | `charge` table | `order` table; refunds are not subtracted unless the table has `current_total_price` |
| Airbyte | `charges` stream | `orders` stream (`current_total_price` is used) |

What it does not cover yet: Stripe subscriptions (so MRR and churn are skipped) and Shopify's own order count (so the `orders_complete` check is skipped). A loader that has not written for two days is flagged on the sync line.

### Any other connector: read in place, freshness checked

Leave out `--source` and the CLI reads every table in the schema, for any connector (HubSpot, Salesforce, Zendesk, anything your loader writes):

```sh
cosmic connect pipeline --tool fivetran --schema hubspot --url-env PIPELINE_DATABASE_URL
cosmic schema hubspot
cosmic query "SELECT property_dealstage, count(*) FROM hubspot.deal GROUP BY 1"
```

Nothing is copied. `cosmic schema`, `cosmic query` and the MCP server read the tables where they are, read-only. Columns that look personal (emails, names, phone numbers, addresses) are left out of the schema and refused in queries, and email addresses or phone numbers in returned text are replaced. Queries use the loader tables and built-in functions and types only: views, functions or casts defined in the database are refused, and columns of an extension or custom type (citext, an enum) are left out. The only check is freshness: when the loader last wrote each table (`_fivetran_synced`, or Airbyte's `_airbyte_extracted_at`). Every answer says so: "Freshness only... They are not reconciled against any other source." It never says passed. `cosmic disconnect pipeline:hubspot` forgets the schema.

Postgres only. BigQuery and Snowflake are on the roadmap. The URL stays in your environment variable; set it wherever `cosmic sync` runs, including the GitHub Actions secrets for `cosmic deploy`.

Column names come from Fivetran's published dbt source models and Airbyte's Stripe and Shopify streams. Tested on tables built in that shape and on a local Postgres 16 server, not yet on a real Fivetran or Airbyte load.

## Same answer every time

Every built-in metric runs one fixed SQL query, written down in [docs/METRICS.md](docs/METRICS.md) and shown by `cosmic metrics show <name>`. Ask for `contribution_margin` or `marketing_efficiency_ratio` twice and you get the same SQL twice, with the trust line and the stated assumptions attached.

Write down what the numbers can't know, once:

```sh
cosmic notes add "Exclude wholesale orders from revenue"
cosmic notes add --metric shopify_net_revenue "Black Friday 2025 was a one-off spike"
```

The MCP server hands the matching notes to the agent with every metric and query result, so a correction made once is applied every time. Notes live in the workspace folder. They never change the SQL and never touch a source.

## One workspace per client

```sh
cosmic --workspace acme-co init --type shopify
cosmic --workspace acme-co metrics run shopify_net_revenue
cosmic metrics run meta_ad_spend --all-stores --currency USD
```

Each workspace has its own config, database, keys and notes. `--all-stores` adds a metric up across every workspace on the machine, in one currency.

## Pick your workspace type

```sh
cosmic init --type saas      # shopify, ecommerce, saas, b2b, agency or creator
cosmic workspace show        # what your numbers are checked against
cosmic metrics list          # the metrics for your type
cosmic demo                  # the demo for your type, on invented data
```

| Type | Source of truth | First metrics |
|---|---|---|
| shopify | Shopify orders | net revenue, AOV, flow revenue, MER; contribution margin once you set costs (`cosmic costs set`) |
| ecommerce | Stripe charges | Stripe revenue, orders, AOV, cost per new customer |
| saas | Stripe | MRR, net new MRR, churn, new paying customers, cost per new customer |
| b2b | HubSpot | new leads, pipeline created, won revenue, win rate, cost per lead |
| agency | set per client | spend, CPC, CTR, revenue, leads, one workspace per client |
| creator | Stripe | revenue, members, churn, visit to paid |

A workspace with no source of truth connected still works: its numbers carry a line that says plainly they were not checked. See `cosmic docs workspaces`.

## What it does

**Checks the numbers before anyone quotes them.** `cosmic reconcile` compares each source against the others. Every report opens with the result, so a failed check is the first thing you and your agent see.

| Check | What it compares |
|---|---|
| `orders_complete` | Orders pulled against Shopify's own count |
| `orders_vs_cohorts` | Daily totals against cohort totals |
| `klaviyo_orders` | Klaviyo Placed Order against Shopify orders |
| `ga4_purchases` | GA4 purchases against Shopify orders |
| `attributed_share` | Flow revenue as a share of Shopify net revenue |
| `flow_totals` | Daily flow rows against Klaviyo's own totals |
| `freshness` | How long ago each source synced |

**Says which numbers can go in a client report.** `cosmic verdict --period 2026-10` reruns the checks, then lists each KPI for that month as reportable, with its value, or withheld, with the reason ("14 orders missing: 787 against 801") and what to do next. A month still running, a stale or partial sync, or a check that did not run holds the KPI back. Exit code 3 means something was held back.

**Finds what to fix.** `cosmic audit flows` looks for missing core flows, flows that stopped sending, falling revenue per recipient, and high spam rates. Each finding comes with its evidence.

**Ranks your flows.** `cosmic report revenue-per-flow` ranks flows by attributed revenue per recipient, next to your Shopify revenue.

**Answers the same question the same way every time.** `cosmic metrics run average_order_value` runs fixed, reviewed SQL, so Monday's number matches Friday's. Each result carries its inputs, its exact SQL and the reconcile status. `cosmic metrics list` shows them all. Agents use these before writing their own SQL.

**Keeps the numbers you ask for most.** `cosmic metrics save repeat_orders --sql 'SELECT ...'` saves one SELECT of your own as a named number. It shows in `metrics list` marked as saved by the owner, runs read-only with the same trust line, and can never take the name of a built-in metric. `cosmic metrics delete NAME` removes it.

**Builds a win-back segment from your own timing.** `cosmic segments propose winback` reads how long your customers actually take to reorder, then writes a plan. Nothing happens until you review it and run `apply --confirm`.

## What it will not do

- **It does not send.** No campaign, no flow edit, no message. The only write is creating a Klaviyo segment after a reviewed plan.
- **It does not store customer records.** The database holds totals. Shopify access is set up so name, email, phone and address fields are refused. Since 0.15.0 it keeps one scrambled id per Shopify customer (a keyed hash; the key is held in your keychain, outside the database, and the id cannot be turned back into a Shopify id without it) so a daily sync can fetch only the orders that changed and still count new versus returning customers right.
- **It does not hold your data.** Your keys stay in your keychain, and your database is yours. There is no Cosmic AI server in the path.
- **It does not prove causation.** Flow revenue is what Klaviyo attributes. Every report says so.

## Set it up

Klaviyo takes about 2 minutes. Shopify takes about 15, because Shopify requires steps in two dashboards. `cosmic sources catalog` lists what each source syncs and how to connect it, and `cosmic sources list` shows what is connected.

```sh
cosmic docs setup
```

Then:

```sh
cosmic init
cosmic connect klaviyo --key-env KLAVIYO_READ_KEY
cosmic connect shopify --store NAME.myshopify.com --client-id ID --secret-env SHOPIFY_SECRET
cosmic connect stripe --key-env STRIPE_READ_KEY   # optional: subscriptions, MRR, repeat payments
cosmic sync
cosmic reconcile
cosmic audit flows --html audit.html
```

## Use it from Claude Code

Add the read-only MCP server:

```sh
claude mcp add cosmic -- cosmic mcp
```

Install the skills once, then ask for a job by name:

```sh
cosmic skills sync
```

That adds `/lifecycle`, one skill per kit, such as `/lifecycle:kits:flow-audit`, and four growth skills that work from what you supply: `/lifecycle:icp-and-offer`, `/lifecycle:sales-page`, `/lifecycle:content-systems` and `/lifecycle:sales-call-review`. It never overwrites a skill file you edited, and `cosmic skills uninstall` removes what it added.

## Kits

A kit is a runbook your agent follows, with a Verify checklist at the end. Kits live in their own repo, [cosmic-registry](https://github.com/jbauman-26/cosmic-registry), so a kit fix reaches you without a new CLI release. The CLI downloads it on first use, refreshes it every 10 minutes, and keeps working offline from the last copy.

```sh
cosmic kits list
cosmic kits search "win back"
cosmic kits show winback-segment
cosmic kits add winback-segment
```

Kits today: `flow-audit`, `revenue-per-flow`, `winback-segment`. `cosmic kits prompt NAME` prints a setup prompt to paste into your agent. Any kit that writes copy includes an editing standard and a required review step. To use a fork or a local folder, pass `--registry`, or see `cosmic docs kits`.

## Run it every day

`cosmic deploy` puts a daily sync in a private repo on your own GitHub account, against your own Postgres. It prints the plan first, and creates nothing without `--yes`.

```sh
cosmic provision neon --key-env NEON_API_KEY --yes   # a managed Postgres in your own Neon account
cosmic deploy --repo YOU/lifecycle-sync
cosmic jobs list        # recent runs and the success streak
cosmic logs --actions   # the last run's log
cosmic logs --follow    # wait for a running sync to finish, then show its log
```

## Check on it

```sh
cosmic status       # setup, sources, trust line, daily sync, updates
cosmic dashboard    # one local HTML page with every check, metric and fix
cosmic logs         # recent syncs on this machine, with an error code on any that failed
cosmic secrets list # where each key comes from, never its value
cosmic config list  # every setting, with its default
```

Sync one source on its own schedule, or remove one:

```sh
cosmic sync --only meta              # also --only shopify,klaviyo or a repeated --only
cosmic sync --only shopify --full    # read the whole order history now, not only what changed
cosmic disconnect stripe             # forget its settings and saved keys, keep its data
cosmic disconnect stripe --delete-data
```

Settings you can change. Each one starts at the value the CLI has always used, so nothing changes until you set it:

| Setting | Default | What it does |
|---|---|---|
| `reconcile.tolerance.klaviyo_orders` | 3 | Percent Klaviyo orders may differ from Shopify before the check fails |
| `reconcile.tolerance.ga4_purchases` | 15 | Percent GA4 purchases may differ from Shopify before the check fails |
| `reconcile.attributed_share_flag` | 60 | Warn when Klaviyo credits flows with more than this percent of revenue |
| `reconcile.freshness_days` | 2 | Days without a sync before the freshness check fails |
| `query.row_cap` | 1000 | Most rows `cosmic query` returns |
| `metrics.default_days` | 90 | Window for metrics, reports and sync pulls when none is given |
| `shopify.full_check_days` | 7 | Days between full Shopify pulls once daily syncs fetch only changed orders |
| `shopify.overlap_days` | 3 | Days before the last sync an incremental Shopify sync looks again, for late edits and refunds |

```sh
cosmic config set reconcile.tolerance.ga4_purchases 20
cosmic config get query.row_cap
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
| `LIFECYCLE_ROTATED_FILE` | Without a keychain, a path where the CLI hands back sign-ins a source replaced during a run (Pinterest on every refresh, Microsoft Advertising sometimes). The file is JSON, `{ "<secret-name>": "<new value>" }`, keyed by the secret's name such as `pinterest-ads-refresh-token`, merged with what is already there, written with mode 0600 through a temporary file and a rename. Store each value where the next run reads its `LIFECYCLE_*` variable. Values are never printed. With a keychain, the new value goes to the keychain instead and the file is not used. |

Where there is no keychain, `cosmic connect SOURCE --key-env NAME` still passes once the key checks out. It saves the source's settings, not the key, and says which `LIFECYCLE_*` variable to set when you sync.

## More from the command line

```sh
cosmic serve                                  # dashboard and a read-only JSON API on 127.0.0.1
cosmic tools catalog                          # read-only Klaviyo and Shopify API tools, on your own keys
cosmic tools run shopify.order_count
cosmic tools providers                        # Kie, fal, Apify and ScrapeCreators: any id runs, on your own account
cosmic tools run kie:gpt-image-2-text-to-image --input '{"prompt":"A red running shoe"}' --wait
cosmic exec -- node my-report.js              # run a script with your keys in its environment
cosmic sources import meta_ads --csv ads.csv  # any other tool's daily totals
cosmic sources catalog --category reviews      # 100 tools Shopify stores use, 30 with connectors
cosmic warehouse connect gorgias --secret api_key=GORGIAS_KEY --set subdomain=you --set username=you@store.com
cosmic warehouse sync && cosmic warehouse query "select status, count(*) from src_gorgias.tickets group by 1"
cosmic files ls                               # every saved report, dashboard and plan
cosmic files pull                             # the dashboard from the last daily sync
```

Every command by the job it does: [docs/COMMANDS.md](docs/COMMANDS.md).

## Plans

| Plan | Price | What you get |
|---|---|---|
| Local | Free | This open-source CLI on your own computer: demo, checks, metrics, notes, skills and MCP, with your own database and your own AI |
| Pro | $39 a month, 14-day trial | One hosted workspace: checks re-run daily on Cosmic Cloud, an alert when a number becomes unreliable, and a shared history of briefs and evidence |
| Agency | $99 a month for 5 client workspaces, plus $19 for each extra active client, 14-day trial | Pro for each client, team access, and one view of which clients need attention |

The hosted Pro and Agency features are being built now. Join the early access list at [cosmicai.tech/cli](https://cosmicai.tech/cli#waitlist); nobody is charged until they work end to end.

## Cosmic Cloud

Cosmic Cloud is the hosted copy of a store. Logging in is optional. With it, `--cloud` on a read command asks Cloud instead of the database on this machine.

```sh
export COSMIC_CLOUD_TOKEN=...                     # from Cosmic Cloud, Settings, Mac app access. Never paste it into a chat
cosmic login --token-env COSMIC_CLOUD_TOKEN    # signs in and shows a next step for this store
cosmic cloud status                            # source health, a next command and the browser tutorial
cosmic query "select * from fact_orders_daily limit 5" --cloud
cosmic schema --cloud
cosmic metrics list --cloud && cosmic metrics run shopify_orders --cloud
cosmic sources list --cloud
cosmic sync --cloud                            # starts it on Cloud and returns at once
cosmic logs --cloud                            # recent runs on Cloud
cosmic skills push ./my-skill                  # a folder with a SKILL.md, text only, 200 KB at most
cosmic skills delete my-skill
cosmic logout
```

- The token is never printed, logged or written to a file. Without a keychain, set `LIFECYCLE_CLOUD_TOKEN`. `LIFECYCLE_CLOUD_URL` sets the address. With no saved address and no `LIFECYCLE_CLOUD_URL` (after `logout`), `--cloud` stops with `not_logged_in` and sends nothing.
- Cloud is being built route by route. A route it does not have yet fails with code `not_built` and a plain sentence. Run the command without `--cloud` meanwhile.
- `skills push` sends nothing if a file looks like it holds a key. `skills sync` installs the store's own skills beside the kit skills.
- `cosmic tools abort RUN` stops an Apify or fal job that is still going. Every tool run keeps the request it sent, and `cosmic tools get RUN` shows it.
- `logs --cloud` used to mean the GitHub Actions log. That is now `logs --actions`. A machine that is not logged in still gets the Actions log from `--cloud`.

More: `cosmic docs cloud`. Every change: [CHANGELOG.md](CHANGELOG.md).

## Where this is today

Here is what has and has not been tested. Three sources have synced against real accounts (a Shopify development store, a Klaviyo test account, Stripe in test mode). Every other connector is covered by unit tests against recorded answers only, and is listed below as untested.

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
- Google Merchant Center on any account. The connector was written from the Merchant API Reports v1 docs and is covered by unit tests against recorded answers only. The exact JSON shape of a report date was not shown in Google's examples; the code reads both a { year, month, day } object and a YYYY-MM-DD string. Getting a refresh token and registering the Cloud project with the account are done by the account owner.
- Microsoft Advertising on any account. The connector was written from the Bing Ads API v13 REST docs and is covered by unit tests against recorded answers only. Microsoft's REST reference shows request and response templates but no sample error body, so error mapping reads the documented fault shapes (AdApiFaultDetail, ApiFaultDetail). Getting a refresh token and a developer token is done by the app owner and the account owner.
- LinkedIn Ads on any ad account. The connector was written from the LinkedIn Marketing API docs (version 202611) and is covered by unit tests against recorded answers only. It needs a LinkedIn app approved for the Advertising API with programmatic refresh tokens.
- Reddit Ads and Snapchat Ads on any account. Both connectors were written from the platforms' API docs (Reddit Ads API v3, Snapchat Marketing API v1) and are covered by unit tests against recorded answers only. Getting a refresh token needs the account owner to sign in with Reddit or Snapchat.
- TikTok Ads on any account. The connector was written from the TikTok API for Business docs (v1.3) and is covered by unit tests against recorded answers only. Getting the access token needs an approved TikTok developer app and the advertiser's authorization.
- Pinterest Ads on any account. The connector was written from the Pinterest API v5 docs (spec 5.32.0) and is covered by unit tests against recorded answers only. Pinterest gives a new refresh token on every refresh; whether the old one keeps working until it runs out is not documented, so the CLI keeps the newest in the keychain when it can, and without one hands it back through `LIFECYCLE_ROTATED_FILE`.
- Google Search Console. It is a catalog entry only, waiting on Google sign-in. There is no connector code.
- Anything against the real Cosmic Cloud. `login`, `cloud status`, every `--cloud` command, `skills push` and `delete`, and the tool run records were run against a local stand-in for the Cloud API only. Cloud does not have `/schema`, `/query`, `GET /metrics`, `/runs`, `/skills` or `/tools/runs` yet, so the shapes come from the plan, not from a live answer.
- `tools abort` on a real Apify or fal job. It was written from their API docs and tested against recorded answers.

If something breaks, `cosmic doctor` says what is wrong and what to run next. To report a bug, run `cosmic feedback "what happened" --open`.

## Requirements

Node 20 or newer. macOS keeps keys in the keychain. On other systems, set the `LIFECYCLE_*` environment variables listed in `cosmic docs troubleshooting`.

## Help

Bugs and missing features: `cosmic feedback "what happened" --open`, or open an issue on this repo.

MIT license.
