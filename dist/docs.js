export const DOCS = {
    setup: `# Set up in order

Klaviyo, about 2 minutes:
1. In Klaviyo open Settings, API keys, Create Private API Key.
2. Choose Read-Only Key and copy it.
3. export KLAVIYO_READ_KEY=your_key
4. lifecycle init
5. lifecycle connect klaviyo --key-env KLAVIYO_READ_KEY

Shopify, about 15 minutes:
1. In the Shopify Dev Dashboard create an app in the same organization as the store.
2. Give it the read_orders scope, release a version and install it on the store.
3. In the Partner Dashboard open the app, then API access requests, then Protected
   customer data access, and select Analytics. Leave name, email, phone and address
   unselected. This keeps personal fields out by design.
4. export SHOPIFY_SECRET=your_client_secret
5. lifecycle connect shopify --store NAME.myshopify.com --client-id ID --secret-env SHOPIFY_SECRET

Stripe, about 3 minutes (optional, for subscriptions and repeat payments):
1. In Stripe open Developers, API keys, Create restricted key.
2. Set Charges and Subscriptions to Read. Leave everything else at None.
3. export STRIPE_READ_KEY=rk_live_...
4. lifecycle connect stripe --key-env STRIPE_READ_KEY

Meta Ads, about 10 minutes (optional, for ad spend next to revenue):
1. In Meta Business Settings open Users, System users, and add a system user.
2. Give that system user access to the ad account, with view performance only.
3. Generate a token for it with one permission: ads_read. Nothing else.
4. Copy the ad account id from Ads Manager. It is the number after act_.
5. export META_ADS_TOKEN=...
6. lifecycle connect meta --account 1234567890 --token-env META_ADS_TOKEN
Meta's menu names change. If a step is not where this says, search Meta's help for "system user access token".

Google Ads, about 10 minutes (optional, for ad spend next to revenue):
1. You need an OAuth client id and secret from a Google Cloud project with the Google Ads API on.
   The Cosmic AI app does this sign-in for you. These steps are for doing it by hand.
2. Sign in with Google for a refresh token with the adwords scope. Google asks for a passkey.
3. Copy the customer id from the top of Google Ads, such as 123-456-7890. Pick a client account,
   not a manager account. If access comes through a manager, note its id too.
4. export GOOGLE_ADS_CLIENT_SECRET=... GOOGLE_ADS_REFRESH_TOKEN=...
5. lifecycle connect google-ads --customer 123-456-7890 --client-id ID --secret-env GOOGLE_ADS_CLIENT_SECRET --refresh-token-env GOOGLE_ADS_REFRESH_TOKEN [--login-customer MANAGER_ID]
Only read calls are made, even though Google's scope is named for full access.

Then:
  lifecycle sync
  lifecycle reconcile
  lifecycle audit flows --html audit.html

Run it every day from your own GitHub:
1. Create a free Postgres database in your own Neon account:
     lifecycle provision neon --key-env NEON_API_KEY --yes
   (Or bring any Postgres: export DATABASE_URL=your_url, then
   lifecycle init --database-url-env DATABASE_URL.)
4. lifecycle deploy --repo YOU/lifecycle-sync
5. Read the plan, then add --yes.
`,
    quickstart: `# Cosmic Lifecycle: agent setup playbook

This is the setup guide for any coding or chat agent installing Cosmic Lifecycle.
A person with the CLI installed starts it by pasting one line into their agent:

  Set up Cosmic Lifecycle by following the output of lifecycle docs quickstart

Follow this playbook in order, then stop and report what is live. Do not invent another setup flow.

## What it is

A free CLI that gives an agent a clean view of a Shopify brand's
Klaviyo results. It syncs totals into a database the user owns, checks that the
sources agree, and finds what to fix. It never sends a message, stores no
customer records, and has no account or server of ours in the path.

## Before you start

- Node 20 or newer.
- On macOS, keys go in the keychain. Elsewhere, use the LIFECYCLE_* environment
  variables in \`lifecycle docs troubleshooting\`.
- Never ask the user to paste a key into the chat. Ask them to export it as an
  environment variable, then pass the variable name with --key-env or --secret-env.

## Fastest path to a trusted number

1. Install. The CLI ships inside the Cosmic AI app and Cosmic Cloud, so most
   people already have it. With access to the private repo, install it directly:
     gh release download --repo jbauman-26/cosmic-lifecycle --pattern cosmic-lifecycle.tgz
     npm install -g ./cosmic-lifecycle.tgz
2. Show it working with no keys, on labeled sample data:
     lifecycle demo
3. Set up the local database:
     lifecycle init
4. Connect ONE source first. Klaviyo takes about 2 minutes:
     lifecycle sources catalog
     lifecycle docs setup
     lifecycle connect klaviyo --key-env KLAVIYO_READ_KEY
   Shopify takes about 15 minutes because it needs two dashboards. Add it after
   Klaviyo works. One working source beats three half-connected ones.
5. Sync and check:
     lifecycle sync --format json
     lifecycle reconcile --format json
6. Verify:
     lifecycle doctor --format json
     lifecycle sources list --format json
7. Give the user one verified number with its trust line, for example:
     lifecycle metrics run flow_revenue_per_recipient --format json

## Only after that, if the user asks

- Agent access in Claude Code: \`claude mcp add lifecycle -- lifecycle mcp\`
- Slash commands: \`lifecycle skills sync\`
- Runbooks: \`lifecycle kits list\`, then \`lifecycle kits add NAME\`
- A daily sync from their own GitHub: \`lifecycle deploy --repo OWNER/NAME\`, then \`lifecycle jobs list\`
- One local page with every number and check: \`lifecycle dashboard\`

Do not lead with these during first-time setup.

## Rules

- Never quote a number before \`lifecycle reconcile\` has run. If a check failed, say so first.
- Prefer \`lifecycle metrics\` to custom SQL.
- Never claim a source is connected until \`lifecycle sources list\` says so.
- Never run \`lifecycle segments apply\` without the user approving that exact plan.
- If the user would rather have someone set it up for them, Jake Bauman at NorthSignal does setup, starting with a free call: https://northsignal.studio/lifecycle
- When finished, report which sources are connected, the reconcile result, and the checks you ran.
`,
    agents: `# Lifecycle CLI for agents

Read this before working with Lifecycle.

If the tool is not set up yet, follow \`lifecycle docs quickstart\` instead.

1. Run \`lifecycle status --format json\` first, then \`lifecycle doctor --format json\` if anything looks wrong.
2. Run \`lifecycle reconcile\` before quoting any number. If a check failed, say so first.
3. For a standard number, use a verified metric: \`lifecycle metrics list\`, then \`lifecycle metrics run NAME --format json\`. The same metric always runs the same SQL, so answers stay comparable over time. Quote the metric name with the number. The list ends with any numbers the owner saved (\`saved: true\`). Those run the owner's own SQL through the same read-only path and carry the same trust line, but Cosmic has not reviewed them: say "saved by the owner" when you quote one. Save one only when the owner asks: \`lifecycle metrics save NAME --sql 'SELECT ...'\`.
4. Write your own SQL only when no metric fits. Run \`lifecycle schema --format json\` first and never guess column names. Query with \`lifecycle query "SELECT ..." --format json\`. Queries are read-only and capped at 1,000 rows unless \`query.row_cap\` is set. Tell the user the number came from custom SQL, and show it.
5. Report the sync warnings. Do not hide them from the user.
6. For a fact only the live API has, such as the current flow list or Shopify's own order count, use a tool: \`lifecycle tools catalog\`, then \`lifecycle tools run TOOL --format json\`. These built-in tools are read-only and return no personal data. For images, video, voice or scraping, any Kie, fal, Apify or ScrapeCreators id also runs on the user's own account with that provider. Read \`lifecycle docs tools\` first: those jobs cost money and must never be started twice.
7. Saved reports, dashboards and plans are in \`lifecycle files ls\`. Read one with \`lifecycle files cat PATH\`.
8. For a named job, such as a flow audit, use a kit: \`lifecycle kits search "flow audit"\`, then \`lifecycle kits add NAME\`, then follow its AGENT.md through the Verify checklist.

Rules:
- The database holds totals only. It has no customer names, emails, phones or addresses.
- Revenue in fact_flow_daily is Klaviyo attributed revenue. Say so, and never present it as proof of causation.
- Purchases and purchase value in fact_meta_ads_daily are what Meta attributes to its own ads. They are a claim, not orders. Never add them to Shopify revenue or to email revenue. For a number with no attribution in it, use the marketing_efficiency_ratio metric.
- Conversions and conversions_value in fact_google_ads_campaign_daily and fact_google_ads_ad_group_daily are what Google attributes to its own ads. They are a claim, not orders, and they overlap with Meta's claims. Never add them to Shopify revenue, to email revenue or to Meta's purchases. cost is in the account currency.
- Nothing in this tool sends a message, and nothing changes an ad account. Meta Ads and Google Ads are read only.
- If a command fails with code \`busy\`, another lifecycle command is writing to the store. Wait and run it again. Do not delete files to get past it.
- \`--cloud\` on a read command asks Cosmic Cloud instead of this machine. Use it only when the user is logged in (\`lifecycle cloud status --format json\`). Code \`not_built\` means Cloud does not have that route yet: run the command without \`--cloud\`, and do not retry. See \`lifecycle docs cloud\`.
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
  lifecycle kits list
  lifecycle kits search "win back"
  lifecycle kits show winback-segment
  lifecycle kits add winback-segment
  Then: "Follow lifecycle-kits/winback-segment/AGENT.md"

Skills for Claude Code and Cursor:
  lifecycle skills sync installs /lifecycle and one /lifecycle:kits:NAME skill
  per kit. It never overwrites a file you edited. lifecycle skills uninstall
  removes what it installed. When logged in to Cosmic Cloud it also installs
  the store's own skills, pushed with lifecycle skills push DIRECTORY.
  See lifecycle docs cloud.

lifecycle kits show NAME also lists every file in the kit, so you can see what
kits add will copy before it does.

Writing a kit:
  Copy a kit folder in the registry, edit it, then run
  lifecycle kits validate . --write-index
  The same check runs in the registry's CI.
`,
    commands: `lifecycle demo
lifecycle init [--database-url-env NAME]
lifecycle connect klaviyo --key-env NAME
lifecycle connect shopify --store STORE --client-id ID --secret-env NAME
lifecycle connect ga4 --property ID --client-id ID --secret-env NAME --refresh-token-env NAME
lifecycle connect stripe --key-env NAME
lifecycle connect meta --account ID --token-env NAME
lifecycle connect google-ads --customer ID --client-id ID --secret-env NAME --refresh-token-env NAME [--login-customer ID]
lifecycle sync [--since DATE] [--only SOURCE[,SOURCE]] [--cloud]
lifecycle disconnect SOURCE [--delete-data]
lifecycle schema [TABLE] [--cloud]
lifecycle query "SELECT ..." [--cloud]
lifecycle metrics list [--cloud]|show NAME|run NAME... [--days N] [--cloud]|candidates
lifecycle metrics save NAME --sql 'SELECT ...' [--title TEXT] [--unit count|usd|percent|usd_per_recipient|ratio]
lifecycle metrics delete NAME
lifecycle sources list [--cloud]|catalog|import NAME --csv FILE [--date-column NAME]
lifecycle tools catalog [--query TEXT]|providers|run TOOL [--input JSON] [--wait] [--timeout SECONDS] [--out FILE]|get RUN [--out FILE]|abort RUN|runs
lifecycle exec -- COMMAND [ARGS]
lifecycle serve [--port N]
lifecycle provision neon --key-env NEON_API_KEY [--name N] [--region R] [--yes]
lifecycle files ls [PATH]|cat PATH|get PATH [DIR]|put FILE [NAME]|path|pull
lifecycle reconcile
lifecycle report revenue-per-flow [--html FILE]
lifecycle audit flows [--html FILE]
lifecycle segments propose winback
lifecycle segments apply PLAN_FILE --confirm
lifecycle kits list|search QUERY|show NAME|prompt NAME|add NAME [--into DIR]
lifecycle kits validate [DIR] [--write-index]
lifecycle skills sync|status|uninstall [--target claude|cursor|all]
lifecycle skills push DIRECTORY [--slug NAME]
lifecycle skills delete SLUG
lifecycle login [--url URL] --token-env VAR
lifecycle logout
lifecycle cloud status
lifecycle feedback MESSAGE [--open]
lifecycle deploy [--repo OWNER/NAME] [--yes] [--write DIR]
lifecycle jobs list|run
lifecycle logs [--cloud] [--actions] [--follow] [--limit N]
lifecycle dashboard [--html FILE] [--days N]
lifecycle status
lifecycle config list|get|set|unset KEY [VALUE]
  keys: registry.uri, deploy.repo, update.check, cloud.url,
        reconcile.tolerance.klaviyo_orders (3), reconcile.tolerance.ga4_purchases (15),
        reconcile.attributed_share_flag (60), reconcile.freshness_days (2),
        query.row_cap (1000), metrics.default_days (90)
lifecycle secrets list|set NAME --from-env VAR|delete NAME
lifecycle mcp
lifecycle doctor
lifecycle warehouse show|connect|sync|schema|query|scrub [--confirm]|list|disconnect|add-api
lifecycle docs quickstart|setup|agents|kits|commands|tools|cloud|warehouse|troubleshooting

Add --format json to any command.`,
    cloud: `# Cosmic Cloud

Cosmic Cloud is the hosted copy of a store: its connections, its warehouse and
its schedules. This machine keeps working without it. Logging in adds one thing:
--cloud on a read command asks Cloud instead of the database on this machine.

Log in:
  The store owner creates a token in Cosmic Cloud under Settings, Mac app access.
  It is shown once. Put it in an environment variable, never in a chat:
    export COSMIC_CLOUD_TOKEN=...
    lifecycle login --token-env COSMIC_CLOUD_TOKEN
  login checks the token with Cloud (GET /api/v1/store), prints the store's name,
  then saves the address in config.json (cloud.url) and the token in the keychain.
  The token is never printed, logged or written to a file.
  lifecycle cloud status shows the store, the address, where the token comes
  from, and each connection on Cloud. lifecycle logout forgets the token and
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
  lifecycle schema --cloud                  GET /schema
  lifecycle query "SELECT ..." --cloud      POST /query, one read-only SELECT
  lifecycle metrics list --cloud            GET /metrics
  lifecycle metrics run NAME --cloud        GET /metrics/NAME
  lifecycle sources list --cloud            GET /store
  lifecycle logs --cloud                    GET /runs
  lifecycle sync --cloud [--only SOURCE]    POST /sync. Starts it and returns at once
  The trust line comes with Cloud's numbers too. Read it before quoting one.
  lifecycle exec does not add the Cloud token to the command's environment.

logs --cloud changed in 0.13.0:
  It used to show the last GitHub Actions log. That is now lifecycle logs --actions.
  A machine that is not logged in to Cosmic Cloud still gets the Actions log from
  --cloud, so an existing script keeps working.

The store's own skills:
  lifecycle skills push DIRECTORY saves a skill folder (a SKILL.md at the top,
  text files only, at most 200 KB) to the store on Cloud. The folder name is
  the skill's name, or pass --slug. Nothing is sent if a file looks like it
  holds a key: the error names the file and line. Links are not followed.
  lifecycle skills delete SLUG removes it from Cloud.
  lifecycle skills sync installs the store's skills beside the kit skills, under
  skills/store-SLUG, on every machine that is logged in. A skill deleted from
  Cloud is removed on the next sync, unless you edited the installed copy.

Tool runs:
  When logged in, each lifecycle tools run also sends its record to Cloud:
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
- Cloud holds totals only, like the local database. No customer names, emails or addresses.
- Never put the token in a prompt, a URL, a file or a commit.
`,
    tools: `# Tools

Two kinds of tool run from \`lifecycle tools run\`.

## Built-in tools

Read-only calls to Klaviyo and Shopify on the store's own keys. They finish in seconds and return no personal data.

\`\`\`sh
lifecycle tools catalog
lifecycle tools catalog --query orders
lifecycle tools run shopify.order_count
\`\`\`

## Open provider refs

Any model, actor or path from four providers runs by its id, with no list to be on. Each one bills the account the key belongs to. Cosmic adds no markup and holds no account.

| Ref | Key | Where ids are listed |
|---|---|---|
| \`kie:<model>\` | \`kie-api-key\` | https://kie.ai/market |
| \`fal:<endpoint_id>\` | \`fal-key\` | https://fal.ai/models |
| \`apify:<owner~actor>\` | \`apify-token\` | https://apify.com/store |
| \`scrapecreators:<path>\` | \`scrapecreators-key\` | https://docs.scrapecreators.com |

\`lifecycle tools providers\` shows which keys are set. Save a key from an environment variable, never from the command line:

\`\`\`sh
lifecycle secrets set kie-api-key --from-env KIE_KEY
\`\`\`

Input is the JSON that provider's own page documents for that id. Read that page before the first run.

\`\`\`sh
lifecycle tools run kie:gpt-image-2-text-to-image --input '{"prompt":"A red running shoe on white","aspect_ratio":"3:4"}' --wait --out shoe.json
lifecycle tools run fal:fal-ai/minimax/voice-clone --input '{"audio_url":"https://..."}' --wait
lifecycle tools run apify:apimaestro~linkedin-profile-posts --input '{"username":"someone"}' --wait --timeout 600
lifecycle tools run scrapecreators:v1/reddit/search --input '{"query":"welcome email"}'
\`\`\`

- Kie, fal and Apify jobs finish later. Without \`--wait\` the command prints a run id and returns. \`lifecycle tools get RUN\` checks the job and saves the result when it is done.
- ScrapeCreators answers in the same call. Input becomes query parameters. Pass \`--method POST\` for its POST endpoints.
- Apify output is the run's dataset, up to 1,000 items. The rest stay in the dataset on Apify.
- Kie chat models answer directly and are not supported. Use image, video and audio models.
- A finished run shows what it cost when the provider reports it: Kie and ScrapeCreators in credits, Apify in US dollars. fal does not report a cost.
- Every run keeps the request it sent: provider, model and input. \`lifecycle tools get RUN\` shows it under \`request\`, so a result can be tied back to what was asked. A key is never part of it. An input field named like a key, such as \`api_key\`, is saved as \`[removed]\`.
- \`lifecycle tools abort RUN\` asks the provider to stop a run that is still going. Apify and fal can stop one. Kie cannot (code \`cannot_abort\`), and ScrapeCreators has already answered. Work done before the stop may still be billed. A run that had already finished is saved as it ended, not as aborted.

## Rules for agents

1. **Never run a job twice to get its result.** If \`--wait\` times out, the job is still going and still billing. Check it with \`lifecycle tools get RUN\`. Starting it again pays twice.
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
  Postgres (lifecycle init --database-url-env, or provision neon): schemas in that database.
  Local setup: ~/.lifecycle/warehouse.duckdb.

Find and connect a source:
  lifecycle sources catalog [--query reviews] [--category helpdesk] [--readiness built]
  lifecycle warehouse show gorgias
  export GORGIAS_KEY=...        # never paste keys into a chat
  lifecycle warehouse connect gorgias --secret api_key=GORGIAS_KEY --set subdomain=yourstore --set email=you@store.com
  lifecycle warehouse sync [gorgias]
  lifecycle warehouse schema [gorgias]
  lifecycle warehouse query "select status, count(*) from src_gorgias.tickets group by 1"
  lifecycle warehouse list | disconnect SLUG

Readiness, said plainly:
  native   built in (Shopify, Klaviyo, GA4, Stripe, Meta Ads, Google Ads). Shopify, Klaviyo and GA4 have reconcile checks
  tested   a warehouse connector that has synced a real account
  built    written from the vendor's API docs, not yet run on a real account.
           Expect the first sync to need a fix. Report it: lifecycle feedback
  planned  no connector yet. Use lifecycle sources import NAME --csv FILE
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
    lifecycle config set warehouse.free_text keep   the default. Free text is
        loaded with email addresses and phone numbers replaced by [removed].
        A name inside the text stays.
    lifecycle config set warehouse.free_text drop   free text is not loaded.
  Text the store wrote itself (campaigns, flows, segments) is not free text.
  Open-ended fields (custom_fields, metadata, properties) are free text as a
  whole, and are removed when they sit inside a person.

  lifecycle schema and lifecycle warehouse schema mark every column:
    { "column": "name", "type": "VARCHAR", "personal": true, "freeText": false }
  lifecycle query and lifecycle warehouse query refuse SQL that could return a
  column marked personal, with code personal_column. That covers an alias, a
  star, a subquery, a CTE, a cast, and a whole row such as row_to_json(u).
  While a table still has a personal column: name the columns you need, put
  each table right after FROM or JOIN, and use count(*) as the only star.

  A warehouse filled before 0.13.2 can hold a name the old rules missed:
    lifecycle warehouse scrub             counts per table, changes nothing
    lifecycle warehouse scrub --confirm   empties those columns
  It never prints a stored value. With warehouse.free_text drop it empties
  free text too; with keep it replaces emails and phone numbers inside it.
  It also removes the copies of loaded rows that older versions left in the
  loader's folder (~/.lifecycle/dlt), and rebuilds the local database file so
  the old values are gone from its bytes, not only from queries. On Postgres
  the old row versions stay until the database vacuums the table.

  To load everything, by your own choice:
  lifecycle warehouse connect SLUG ... --keep-personal-data
  Those columns are still marked personal, and query still refuses them. Read
  them with your own database client.

Any other tool with a REST API:
  Write a spec, then lifecycle warehouse add-api my-tool --spec spec.json
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

Daily sync: lifecycle deploy adds warehouse sources and their keys to the
GitHub Actions job automatically.`,
    troubleshooting: `Shopify says the app is not approved to access orders:
  In the Partner Dashboard open your app, then API access requests, then
  Protected customer data access, and select Analytics. Leave name, email,
  phone and address unselected.

No keychain, such as on Linux, in CI, or when an app passes keys per call:
  Set these instead: LIFECYCLE_KLAVIYO_READ_KEY, LIFECYCLE_SHOPIFY_CLIENT_SECRET,
  LIFECYCLE_DATABASE_URL, LIFECYCLE_GA4_CLIENT_SECRET, LIFECYCLE_GA4_REFRESH_TOKEN,
  LIFECYCLE_STRIPE_READ_KEY, LIFECYCLE_META_ADS_TOKEN.
  lifecycle connect SOURCE --key-env NAME still works there: it checks the key,
  saves the source's settings, and reports keyStorage "environment" with the
  variable to set at sync time. The key itself is not saved anywhere.

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
  lifecycle query and saved metrics use the connection's own schema: whatever
  its role or URL puts first on the search path. To name it yourself, set
  LIFECYCLE_DB_SCHEMA=your_schema, and every read and write uses that schema.
  System tables stay blocked either way.

Your orders live under a custom Klaviyo metric:
  Set LIFECYCLE_KLAVIYO_ORDER_METRIC to that metric's id.

Klaviyo returns 401:
  The key was revoked or the account changed. Create a Read-Only key and run
  lifecycle connect klaviyo again.

Meta refused the token, or says it cannot read the ad account:
  System user tokens can be set to never expire. A token made in the Graph API Explorer lasts hours.
  Make a system user token with ads_read, give the system user access to the ad account,
  then lifecycle connect meta --account ID --token-env NAME.

Google Ads says the project only has Test access:
  A Cloud project starts with Test access, which reads test accounts only. Apply for Explorer
  access on the project's Google Ads API Overview page. Explorer allows 2,880 operations a day
  on live accounts. Basic needs brand verification first.

Google Ads says the account cannot be read, or that it is a manager account:
  Connect a client account, not a manager. If access comes through a manager account, add
  --login-customer MANAGER_ID. A refresh token from an app in Testing mode stops working after
  seven days; sign in again for a new one.

Meta spend looks low for the last few days:
  Meta restates recent days as late conversions arrive. Each sync pulls the last 90 days
  (metrics.default_days) again,
  so the numbers settle after a few syncs.

Stripe says the key cannot read subscriptions:
  Charges still sync. To add MRR and churn, edit the restricted key in the
  Stripe dashboard, give it Read on Subscriptions, then lifecycle sync.

Flow report warning:
  An account with no sends has nothing to report. The warning clears once
  flows have sent.

Error codes (the "code" field with --format json, and in lifecycle logs):
  key_rejected     The source refused the saved key (401). Make a new key, then connect again.
  rate_limited     The source asked to slow down (429) after the retries. Wait, then sync again.
  scope_denied     Shopify refused a field or scope. Add the scope it names to the app, then connect again.
  not_connected    sync --only or disconnect named a source that is not connected.
  unknown_source   Not one of shopify, klaviyo, ga4, stripe, meta.
  busy             Another lifecycle command is writing to this store, or Cosmic Cloud is changing it. Wait, then run it again.
  missing_uv       Warehouse sources need uv. Update the app, install uv, or set LIFECYCLE_UV_PATH.
  loader_failed    A warehouse source's loader stopped before it finished. Run lifecycle warehouse sync SLUG --verbose to see why.
  personal_column  The SQL could return a column marked personal. Run lifecycle schema --format json, leave those columns out, and name the rest one by one.
  scrub_failed     lifecycle warehouse scrub could not read or change the warehouse. Nothing is half done per column: run it again.
  reserved_name    metrics save or delete named a built-in metric. Pick another name.
  bad_metric       A saved metric must be one SELECT that returns one row with one number.
  bad_schema       LIFECYCLE_DB_SCHEMA is not a plain schema name.
  not_logged_in    A Cosmic Cloud command ran with no store token, or with no saved address. lifecycle login --token-env VAR.
  unauthorized     Cosmic Cloud refused the store token. Create a new one in Cloud, then log in again.
  not_built        Cosmic Cloud does not have that route yet, or a source has no connector yet. Run it without --cloud.
  cloud_unreachable  Cosmic Cloud did not answer. Check the network and lifecycle cloud status.
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
  The repo is private, so there is no public download link. The Cosmic AI app and
  Cosmic Cloud update the CLI they carry. lifecycle status checks for a newer
  release at most once a day and says nothing when it cannot see the release list.
  Turn the check off with lifecycle config set update.check false.

Save a number of your own:
  lifecycle metrics save repeat_orders --unit count --title "Repeat orders" \\
    --sql 'SELECT sum(returning_orders) AS value FROM fact_orders_daily WHERE date >= $1'
  $1 is the first day of the window. Use single quotes, or the shell eats the $1. One SELECT, one row, one number. It then shows
  in lifecycle metrics list marked as saved by the owner, runs with
  lifecycle metrics run repeat_orders, and is removed with lifecycle metrics delete.
  A saved number cannot take the name of a built-in metric.

Sync one source on its own schedule:
  lifecycle sync --only meta
  Each source keeps its own run in lifecycle logs. Reconcile runs after every sync.

Remove a source:
  lifecycle disconnect stripe removes its settings and saved keys and keeps its data.
  Add --delete-data to delete what it loaded too. A key set in a LIFECYCLE_* variable
  stays in use until you unset it.`,
};
