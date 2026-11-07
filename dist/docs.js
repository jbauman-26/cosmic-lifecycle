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
A person starts it by pasting one line into their agent:

  Set up Cosmic Lifecycle using https://raw.githubusercontent.com/jbauman-26/cosmic-lifecycle/main/llms.txt

Follow this playbook in order, then stop and report what is live. Do not invent another setup flow.

## What it is

A free, open source CLI that gives an agent a clean view of a Shopify brand's
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

1. Install:
     npm install -g https://github.com/jbauman-26/cosmic-lifecycle/releases/latest/download/cosmic-lifecycle.tgz
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
3. For a standard number, use a verified metric: \`lifecycle metrics list\`, then \`lifecycle metrics run NAME --format json\`. The same metric always runs the same SQL, so answers stay comparable over time. Quote the metric name with the number.
4. Write your own SQL only when no metric fits. Run \`lifecycle schema --format json\` first and never guess column names. Query with \`lifecycle query "SELECT ..." --format json\`. Queries are read-only and capped at 1,000 rows. Tell the user the number came from custom SQL, and show it.
5. Report the sync warnings. Do not hide them from the user.
6. For a fact only the live API has, such as the current flow list or Shopify's own order count, use a tool: \`lifecycle tools catalog\`, then \`lifecycle tools run TOOL --format json\`. Tools are read-only and return no personal data.
7. Saved reports, dashboards and plans are in \`lifecycle files ls\`. Read one with \`lifecycle files cat PATH\`.
8. For a named job, such as a flow audit, use a kit: \`lifecycle kits search "flow audit"\`, then \`lifecycle kits add NAME\`, then follow its AGENT.md through the Verify checklist.

Rules:
- The database holds totals only. It has no customer names, emails, phones or addresses.
- Revenue in fact_flow_daily is Klaviyo attributed revenue. Say so, and never present it as proof of causation.
- Nothing in this tool sends a message.
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
  removes what it installed.

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
lifecycle sync [--since DATE]
lifecycle schema [TABLE]
lifecycle query "SELECT ..."
lifecycle metrics list|show NAME|run NAME... [--days N]|candidates
lifecycle sources list|catalog|import NAME --csv FILE [--date-column NAME]
lifecycle tools catalog|run TOOL [--input JSON]|get RUN [--out FILE]|runs
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
lifecycle feedback MESSAGE [--open]
lifecycle deploy [--repo OWNER/NAME] [--yes] [--write DIR]
lifecycle jobs list|run
lifecycle logs [--cloud]
lifecycle dashboard [--html FILE] [--days N]
lifecycle status
lifecycle config list|get|set|unset KEY [VALUE]
lifecycle secrets list|set NAME --from-env VAR|delete NAME
lifecycle mcp
lifecycle doctor
lifecycle warehouse show|connect|sync|schema|query|list|disconnect|add-api
lifecycle docs quickstart|setup|agents|kits|commands|warehouse|troubleshooting

Add --format json to any command.`,
    warehouse: `# The warehouse

Raw tables from the tools a store runs on, one schema per source
(src_gorgias, src_recharge, ...), in your own database. Loaded by dlt
(Apache 2.0), run through uv. Needs uv: curl -LsSf https://astral.sh/uv/install.sh | sh

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
  native   built in, with reconcile checks (Shopify, Klaviyo, GA4, Stripe)
  tested   a warehouse connector that has synced a real account
  built    written from the vendor's API docs, not yet run on a real account.
           Expect the first sync to need a fix. Report it: lifecycle feedback
  planned  no connector yet. Use lifecycle sources import NAME --csv FILE

Personal data:
  Removed before anything is written: any field named for an email, phone,
  address, birthday, IP, or a person's name (customer_name, first_name ...),
  and email addresses inside text. A plain "name" field is kept, because it
  is usually a product or campaign. To keep everything:
  lifecycle warehouse connect SLUG ... --keep-personal-data

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

No keychain, such as on Linux:
  Set these instead: LIFECYCLE_KLAVIYO_READ_KEY, LIFECYCLE_SHOPIFY_CLIENT_SECRET,
  LIFECYCLE_DATABASE_URL, LIFECYCLE_GA4_CLIENT_SECRET, LIFECYCLE_GA4_REFRESH_TOKEN,
  LIFECYCLE_STRIPE_READ_KEY.

Your orders live under a custom Klaviyo metric:
  Set LIFECYCLE_KLAVIYO_ORDER_METRIC to that metric's id.

Klaviyo returns 401:
  The key was revoked or the account changed. Create a Read-Only key and run
  lifecycle connect klaviyo again.

Stripe says the key cannot read subscriptions:
  Charges still sync. To add MRR and churn, edit the restricted key in the
  Stripe dashboard, give it Read on Subscriptions, then lifecycle sync.

Flow report warning:
  An account with no sends has nothing to report. The warning clears once
  flows have sent.`,
};
