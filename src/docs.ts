export const DOCS: Record<string, string> = {
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

Then:
  lifecycle sync
  lifecycle reconcile
  lifecycle audit flows --html audit.html

Run it every day from your own GitHub:
1. Create a free Postgres database, for example on Neon.
2. export DATABASE_URL=your_url
3. lifecycle init --database-url-env DATABASE_URL
4. lifecycle deploy --repo YOU/lifecycle-sync
5. Read the plan, then add --yes.
`,
  agents: `# Lifecycle CLI for agents

Read this before working with Lifecycle.

1. Run \`lifecycle doctor --format json\` first.
2. Run \`lifecycle schema --format json\` before writing SQL. Never guess column names.
3. Query with \`lifecycle query "SELECT ..." --format json\`. Queries are read-only and capped at 1,000 rows.
4. Run \`lifecycle reconcile\` before quoting any number. If a check failed, say so first.
5. Report the sync warnings. Do not hide them from the user.

Rules:
- The database holds totals only. It has no customer names, emails, phones or addresses.
- Revenue in fact_flow_daily is Klaviyo attributed revenue. Say so, and never present it as proof of causation.
- Nothing in this tool sends a message.
`,
  commands: `lifecycle demo
lifecycle init [--database-url-env NAME]
lifecycle connect klaviyo --key-env NAME
lifecycle connect shopify --store STORE --client-id ID --secret-env NAME
lifecycle connect ga4 --property ID --client-id ID --secret-env NAME --refresh-token-env NAME
lifecycle sync [--since DATE]
lifecycle schema [TABLE]
lifecycle query "SELECT ..."
lifecycle reconcile
lifecycle report revenue-per-flow [--html FILE]
lifecycle audit flows [--html FILE]
lifecycle segments propose winback
lifecycle segments apply PLAN_FILE --confirm
lifecycle kits list|add NAME
lifecycle deploy --repo OWNER/NAME [--yes]
lifecycle mcp
lifecycle doctor
lifecycle docs setup|agents|commands|troubleshooting

Add --format json to any command.`,
  troubleshooting: `Shopify says the app is not approved to access orders:
  In the Partner Dashboard open your app, then API access requests, then
  Protected customer data access, and select Analytics. Leave name, email,
  phone and address unselected.

No keychain, such as on Linux:
  Set these instead: LIFECYCLE_KLAVIYO_READ_KEY, LIFECYCLE_SHOPIFY_CLIENT_SECRET,
  LIFECYCLE_DATABASE_URL, LIFECYCLE_GA4_CLIENT_SECRET, LIFECYCLE_GA4_REFRESH_TOKEN.

Your orders live under a custom Klaviyo metric:
  Set LIFECYCLE_KLAVIYO_ORDER_METRIC to that metric's id.

Klaviyo returns 401:
  The key was revoked or the account changed. Create a Read-Only key and run
  lifecycle connect klaviyo again.

Flow report warning:
  An account with no sends has nothing to report. The warning clears once
  flows have sent.`,
}
