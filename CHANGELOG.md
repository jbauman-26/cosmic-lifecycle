# Changelog

Every release of Cosmic Lifecycle from 0.13.0 on. Earlier releases are described in their GitHub release notes.

## Unreleased

Shopify sync for large stores. Measured on synthetic data shaped like a Shopify Plus brand (3 million orders over 3 years, 600,000 customers); no real store was connected.

### Added

- **Large stores sync Shopify through one bulk export.** At 25,000 orders or more (`shopify.bulk_min_orders`), `lifecycle sync` asks Shopify for a bulk operation instead of paging 250 orders at a time, which at 3 million orders is 12,000 requests in a row. The operation id is saved in `meta_shopify_bulk`, so a sync that stops early loses nothing: the next one polls the same export, or reads the same finished file again (Shopify keeps it a week). Totals are replaced only after the whole file is read and its line count matches Shopify's own count. While the export is still building, the sync returns `warning` with code `export_running`, the last totals stay, and that run does not count as fresh. A sync waits `shopify.export_wait_seconds` (120) for the export, or `--export-wait SECONDS`.
- The file is read as a stream into a compact buffer: on 3 million synthetic orders, about 560 MB peak memory and 8 seconds to read, total and write, against about 1.8 GB for the paged path holding every order as an object. The daily and cohort totals were identical to the paged path's, row for row.
- The completeness check compares the orders in the export with Shopify's count of orders created up to the moment the export started, so orders placed while Shopify builds the file do not fail it.
- **Progress for an app.** A sync that leaves the export running returns `progress` (`state`, `startedAt`, `checkedAt`, `ordersExported`, `ordersExpected`, `code`), and `lifecycle status --format json` returns the same as `shopifyExport`. Counts and times only. `state` is `running`, `done` or `failed`; `code` is `export_failed`, `file_expired`, `export_missing` or Shopify's own error code in lower case.
- A warning when the oldest order Shopify returns is within 60 days: without the `read_all_orders` scope Shopify returns only the last 60 days, and older customers then count as new.

### Fixed

- A page Shopify answers with `THROTTLED` (inside a 200 reply) is retried after the wait Shopify's cost numbers imply, up to 5 times, instead of failing the sync at once.

### What is proven and what is not

- Typecheck and the full suite pass. The bulk path is tested against replies built from Shopify's documentation, not recorded from a live store, and end to end at 3 million synthetic orders against a stand-in endpoint.
- Not run against a real Shopify store. The `created_at:<=` filter on `ordersCount` is unverified on a live store; if Shopify ignores it, `orders_complete` fails instead of passing silently.
- Every sync after the first still exports the full history. A daily export of a 3 million order store is unmeasured on Shopify's side.

## 0.14.0 (2026-11-24)

The CLI for any marketer. A workspace now says what kind of business it is, and the trust gate checks its numbers against that business's own source of truth. Shopify stays a first-class path and stops being a requirement. An install from before 0.14.0 is a Shopify store and behaves exactly as it did. The spec is `docs/WORKSPACES.md`.

### Added

- **Workspace types.** `lifecycle init --type shopify|ecommerce|saas|b2b|agency|creator`, and a picker when a new workspace is set up in a terminal with no `--type`. Stored as `workspace.type` in `config.json`. No type means `shopify`. `lifecycle workspace show` and `lifecycle workspace list`, and an MCP tool `workspace`.
- **A source of truth per type.** Shopify orders for a store, Stripe for ecommerce, SaaS and creator, HubSpot for B2B, set per client for an agency. Change it with `lifecycle config set workspace.reference stripe|hubspot|shopify|ga4|none` or `init --reference`. New checks: `reference`, `stripe_daily_complete`, `subscriptions_balance`, `ga4_vs_reference`, `ad_claims` (a warning above `reconcile.ad_claim_flag`, default 100%), `deals_complete`, `contacts_complete`, `deals_daily_vs_pulled`. A store runs the seven 0.13 checks and no others.
- **Trust status `unreferenced`.** When a workspace has no source of truth, it has not synced, or the only one is GA4, every number says so in a plain sentence instead of passing or failing.
- **Metric packs.** 22 new built-in metrics: MRR history, ARPA, churn, new paying customers, cost per new customer, visit to paid, Meta CPC, CTR and CPM, leads, lead to customer, deals, pipeline created, open pipeline, won revenue, win rate, average deal size, cost per lead. `metrics list` shows the workspace's pack; `metrics list --pack TYPE|all` shows any. MCP `list_metrics` takes `pack`. A store's list is the 0.13 list.
- **HubSpot as a built-in source.** `lifecycle connect hubspot --token-env HUBSPOT_TOKEN` (a private app with `crm.objects.deals.read` and `crm.objects.contacts.read`). It asks HubSpot for stage, source, date and amount properties only and stores daily counts and amounts in `fact_crm_deals_daily`, `fact_crm_pipeline_open` and `fact_crm_contacts_daily`. No contact, company or deal record, and no id, is stored. Built from the CRM v3 docs and tested against a stand-in; not yet run on a real portal.
- **Warehouse connectors**, built from vendor docs, not yet run on a real account: `hubspot-records` (ids, stages, sources, dates, amounts), `pipedrive`, `woocommerce`, `bigcommerce`, `customer-io`. Planned with reasons: `salesforce`, `linkedin-ads`, `posthog`, `mixpanel`. Each built one loads in dlt and passes the 0.13.2 personal-data rules on recorded rows. `sources catalog --type TYPE`.
- **Contribution margin for a store,** in the shape the Cosmic AI app reads (`cosmic-ai-desktop/docs/margin-contract.md`). Costs come from `costs.json` in the workspace folder, the file the app writes; `lifecycle costs show|set|products|sync` writes the same file. Cost of goods from Shopify product costs (needs `read_inventory` and `read_products`), a percent, or a cost per product by SKU; shipping per order or as a percent; payment fees; Meta spend. `metrics run contribution_margin` returns `total`, `rows` by day, `included`, `missing`, `orders_without_cost` and the trust line, with `status: no_costs` when no costs are set. Also `cogs`, `gross_margin`, `contribution_margin_before_ads`, `contribution_margin_percent`, `cost_coverage`. A reconcile check `cost_coverage` once product costs are synced. The margin metrics join a store's list only once costs exist.
- **One total across stores.** `metrics run NAME --all-stores|--stores A,B --currency USD [--rate-date DATE] [--rate EUR=0.91]`, and the same on the MCP `metric` tool (`stores`, `currency`, `rate_date`). The app's source and rule: European Central Bank reference rates via Frankfurter's v1 API, one rate per reporting currency and day, each store's amount divided by it, and the line "In USD at European Central Bank reference rates, via Frankfurter for Nov 20, 2026." A store with no currency or no rate is listed and left out. Settings `workspace.currency` and `rollup.currency`.
- **Named workspaces.** `lifecycle --workspace NAME ...` or `LIFECYCLE_WORKSPACE`: an agency keeps one per client, each with its own config, database, files and keychain service.
- **A demo per type.** `lifecycle demo --type saas|b2b`, and `demo` picks the workspace's type. Each plants a fault the trust gate catches.
- **Kits by type.** Kit manifests take `types` and `extra_needs`. `kits list --type TYPE`.
- `connect shopify --shop` (`--store` still works). `docs workspaces`.
- `LIFECYCLE_STRIPE_API_URL`, `LIFECYCLE_HUBSPOT_API_URL` and `LIFECYCLE_FX_API_URL` point a source at a stand-in on this machine, for tests. Only a loopback address is accepted.

### Changed

- Help text, docs, the README and the `/lifecycle` skill speak to any business. Sentences that come from Cosmic Cloud, and the JSON keys, are unchanged.
- `init --format json` also returns `type` and `reference`.
- `reconcile` removes the stored result of a check the workspace no longer runs.

### For the app and Cloud

- New trust status `unreferenced`. New check names above. New tables `fact_crm_*`, `fact_cogs_daily`, `fact_cogs_sku_daily`. A new status `no_costs` on margin metrics. New secret `hubspot-token` (`LIFECYCLE_HUBSPOT_TOKEN`). New error codes: `bad_type`, `unknown_pack`, `hubspot_scope`, `not_summable`, `no_currency`, `no_rate`.

### What is proven and what is not

- Typecheck and the full suite pass, with every 0.13 test unchanged. A SaaS workspace runs `init --type saas`, `demo`, `connect stripe` and `sync` against a stand-in Stripe, `reconcile`, `metrics run` and the MCP server end to end with no Shopify. A B2B workspace does the same against a stand-in HubSpot.
- Margin matches a hand calculation to the cent on a fixed store, in each cost mode. A USD and an EUR store roll up into one USD total that moves with the rate day.
- Not run on any real HubSpot portal, Shopify cost data, WooCommerce, BigCommerce, Pipedrive or Customer.io account. The tests use a stand-in rate source. One call to the real one (`/v1/2026-11-20?base=USD&symbols=EUR`) returned the shape the code reads, and a weekend day returned the Friday's rates with Friday's date.

## 0.13.2 (2026-11-24)

A privacy fix. The promise is that customer names, emails, phone numbers and street addresses never enter the warehouse. Two gaps were found on 2026-11-24 and are closed here, and a third was found while closing them.

### Fixed

- **A person's name could be stored.** The loader removed personal fields by key name, and did not see that a row of a people table is itself a person. A plain `name` on a Zendesk user or a Gorgias customer was loaded, and so was a review's own `name` field, text under `author` or `reviewer`, and the name inside `ship_to`. The loader now knows which tables hold people, which objects hold a person, and which fields each vendor names in its own way.
- **Callers had to guess which columns are personal.** `schema` said nothing about it, so the Mac app and Cosmic Cloud hid columns by name, and `SELECT name AS x FROM users` got through `query`. Every column now carries `personal`, and `query` refuses SQL that could return one.

- **The loader kept a copy of every row it loaded.** dlt, the loader, leaves each finished load in its working folder (`~/.lifecycle/dlt/*/load/loaded`) as compressed files. Those files held the same rows as the warehouse, so a name stored before this release is in them too. The loader is now told to delete them after each load, and `warehouse scrub --confirm` removes the ones already there.

### Added

- **One rule list**, `PERSONAL_RULES` in `src/personal.ts`, read by the loader, `schema`, `query` and `scrub`. It is written to `connectors/personal-rules.json` for the Python loader on every build and sent with every loader job. A loader with no list stops and loads nothing. The rules are in `docs/PERSONAL-DATA.md` and `lifecycle docs warehouse`.
- **`personal` and `freeText` on every column** of `lifecycle schema --format json` and `lifecycle warehouse schema --format json`. `schema --cloud` adds `personal` to each column: Cloud's own flag when it sends one, else what the rule list says about the name.
- **`query` refuses a personal column**, with code `personal_column`. This covers `lifecycle query`, `lifecycle warehouse query`, saved metrics and the MCP `query` tool. It catches an alias, a quoted or mixed case name, a star, `t.*`, a subquery, a CTE, a cast, a function, a filter or sort on the column, and a whole row (`row_to_json(u)`, `to_jsonb(u)`, `SELECT u`, `u::text`). Forms the check cannot read exactly are refused as well.
- **`lifecycle warehouse scrub [--confirm]`.** Empties personal columns an older version stored. Without `--confirm` it only counts. The report holds table names, column names and row counts, never a value. It also removes the loader's leftover row copies, and rebuilds a local warehouse file so the old values are gone from the bytes of the file, not only from queries.
- **`warehouse.free_text`**, a setting with the values `keep` (the default, as before) and `drop`. Free text is ticket subjects, message bodies, review text and notes. With `keep` it is loaded with email addresses and phone numbers replaced by `[removed]`. With `drop` it is not loaded.
- **Phone numbers are taken out of kept free text.** Email addresses already were. A value that is nothing but a phone number starting with `+` is removed under any key.
- Open-ended fields (`custom_fields`, `metadata`, `properties`) are free text as a whole, and are removed when they sit inside a person. `created_by`, `updated_by`, `assigned_to` and the like hold a person.
- **A query's answer is cleaned on the way out.** An email address or a phone number in returned text is replaced by `[removed]`, whatever column it came from, and the JSON gains `redacted` with the number of cells changed. This covers free text an older version stored, until `warehouse scrub` has run. A single word or code keeps its digits, so an id or a SKU is not touched.
- More functions are blocked in every query with `blocked_object`, because they run SQL given as text or read the database's statistics: `query_to_xml`, `ts_stat`, `query()`, `query_table()`, and any name starting `pg_` or `duckdb_`.

### Changed

- **`lifecycle warehouse schema --format json` prints one object per column**, `{ "column", "type", "personal", "freeText" }`, the same shape as `lifecycle schema`. It used to print one string per column, `"name VARCHAR"`. The text output has the same lines as before, with `(personal)` after a personal column.
- A nickname and a username are personal wherever they sit. They used to need a spec's `stripFields`.
- Inside a table of people, any field with the word `name` is removed, so a tier or company name on a customer row goes too. Losing a label is the safe direction.
- A statement that multiplies (`a * b`) beside a table that still has a personal column is refused, because the check cannot tell it from a star. A warehouse loaded by this version has no such table.
- `warehouse connect` and `warehouse disconnect` no longer drop other keys under `warehouse` in `config.json`.

### For the Mac app and Cosmic Cloud

| What | Value |
|---|---|
| New error code | `personal_column`: "That query was refused because it could return personal details." plus the reason, with a next step in `next`. |
| New error code | `scrub_failed`: `warehouse scrub` could not read or change the warehouse. |
| New setting | `warehouse.free_text`: `keep` or `drop`. `lifecycle config set warehouse.free_text drop`. |
| New command | `lifecycle warehouse scrub [--confirm] --format json`: `{ applied, database, freeText, tables: [{ table, rows, columns: [{ column, why, action, rows, status }] }], totals, loaderFiles: { files, removed, pending }, rebuilt, note, next }`. Run it once per store home with `--confirm`. |
| Query | `query` and `warehouse query` JSON may carry `redacted: N` when text in the answer had an email address or phone number replaced. |
| Schema | `personal: boolean` and `freeText: boolean` on every column of `schema` and `warehouse schema`. `warehouse schema` is now objects, not strings. |
| Loader job | Gains `rules` and `free_text`. A job that passes through another program must keep both. |
| Package | Ships `connectors/personal-rules.json` beside `connectors/run.py`. Bundle both. |

The Mac app can stop adding name keys to the loader job once it bundles this version: the loader now does it per table, so a product name in a source that also loads people is kept.

### What is proven and what is not

- Typecheck and the full test suite pass.
- The loader and the CLI are run over the same 341,880 table and key combinations and agree on every one.
- Every catalog table that holds people has a made-up row in the vendor's documented shape, and the test proves the person is gone and the useful fields stay. No connector has run on a real account, so a field a vendor names in a way the docs do not show can still get through.
- The query check is tested with more than 60 ways to read a personal column, on Postgres (PGlite) and on a local DuckDB warehouse. It is a token check, not a full SQL parser. It refuses what it cannot prove safe, so a safe statement can be refused.
- `warehouse scrub` is tested on Postgres (PGlite) and on a local DuckDB file. It was not run on a hosted Postgres.
- After a local scrub the test reads the bytes of every file under the store's home and finds none of the made-up name, email or alias. On Postgres old row versions stay until the table is vacuumed, and that was not measured.
- The query check found two real ways through while it was being tested, both now refused and covered: `u.row_to_json` (Postgres reads it as a function on the whole row) and a no-break space in place of a space (DuckDB reads it as a space).
- A name inside kept free text is not found. That is what `warehouse.free_text drop` is for.
- A phone number inside text that is not free text, such as a status line, is not found unless it is the whole value and starts with `+`.
- The end to end loader tests need uv, so they run on a developer machine and are skipped in CI.

## 0.13.1 (2026-11-24)

The first release checked against the real Cosmic Cloud: a contract test runs this CLI against Cloud's own handlers and a local Postgres.

### Fixed

- **A token without an address is not sent anywhere.** After `logout`, a `LIFECYCLE_CLOUD_TOKEN` left in the environment made `--cloud` commands, and the tool run record, fall back to the public Cloud address. Now, with no saved address and no `LIFECYCLE_CLOUD_URL`, every `--cloud` command stops with `not_logged_in` before anything is sent, `cloud status` says `loggedIn: false` with a note, and tool runs post nothing. `login` still defaults to the public address. Setting both `LIFECYCLE_CLOUD_URL` and `LIFECYCLE_CLOUD_TOKEN` still works without `login`.
- **`skills sync` installs the store's skills from the real Cloud.** Cloud's `GET /skills` lists file paths and sizes without the file text, so 0.13.0 skipped every store skill. The CLI now reads each skill whole with `GET /skills/:slug`. A skill deleted between the two calls is left out. `CloudClient` gains `skill(slug)` and `skillsWithFiles()`.
- `logout`'s note no longer says `--cloud` still works when only the token is left in the environment.

### Changed

- The command map is now `docs/COMMANDS.md` (was `docs/PARITY.md`), arranged by job, and names no other product. Code comments that named one were rewritten.
- The stand-in Cloud in the tests now answers in Cloud's real shapes: typed query columns, skill lists without text, `unknown_skill`, `unknown_connection`, `limit` up to 200 on `/runs`, and a repeated tool run id as an update. `test/cloud-contract.test.ts` replays replies recorded from the real Cloud handlers.

### Needs Cosmic Cloud from 2026-11-24 or later

Cloud now answers 404 `not_found` only for a route it does not have, so `not_built` means just that. A missing skill is `unknown_skill`, a missing connection `unknown_connection`, a missing metric `unknown_metric`. Against an older Cloud, `skills delete` of a missing skill still says `unknown_skill` (the CLI lists first), and `logs --cloud --limit` above 100 is refused.

### What is proven and what is not

- Typecheck and the full test suite pass. The Cloud contract test passes against this build (13 tests) and the replay test here (7 tests).
- The run against production Cosmic Cloud happens after this file ships, so it is recorded in the GitHub release notes, not here.
- `sync --cloud` was tested only against Cloud's handlers with a stand-in runner, never against production, so no source was called.
- The keychain path was not run again for this release.

## 0.13.0 (2026-11-24)

Sign in to Cosmic Cloud, ask Cloud instead of this machine, keep the store's own skills there, and stop a running tool job.

### Added

- **`lifecycle login [--url URL] --token-env VAR` and `lifecycle logout`.** `login` checks the store token with `GET /api/v1/store`, prints the store's name, saves the address in `config.json` (`cloud.url`) and the token in the keychain. Without a keychain it says to keep the token in `LIFECYCLE_CLOUD_TOKEN`. The token is never printed, logged or written to a file, and is only sent over https (or to this machine, for tests). A redirect is not followed.
- **`lifecycle cloud status`.** Whether this machine is logged in, to which store, where the address and token come from, and each connection on Cloud. Exits 1 with `reachable: false` when a token is saved but Cloud cannot be read.
- **`--cloud` on `query`, `schema`, `metrics list`, `metrics run`, `sources list`, `sync` and `logs`.** Each calls Cosmic Cloud API v1 with the store token: `POST /query`, `GET /schema`, `GET /metrics`, `GET /metrics/:name`, `GET /store`, `POST /sync`, `GET /runs`. `sync --cloud` starts the sync and returns at once, takes no local lock, and `--only SOURCE` starts just that connection. `query --cloud` refuses anything but one SELECT before a byte is sent. The JSON of `query --cloud` is the local shape plus `cloud: true` and `columns`. `schema --cloud` prints Cloud's own shape, `{ cloud, schemas: [{ name, tables: [{ name, columns, rows }] }] }`, not the local one. Text that comes from Cloud is cut to one line with control characters removed before it is shown.
- **`lifecycle tools abort RUN`.** Asks the provider to stop a run that is still going. Works for Apify and fal. Kie has no way to stop a job (`cannot_abort`). A run that had already finished is saved as it ended and reported with `aborted: false`. Runs gain the status `aborted`.
- **Every tool run keeps its request.** The run record has a `request` field: `provider`, `model`, `input` and, for ScrapeCreators, `method`. `tools get RUN` shows it. A key is never part of it, and an input field named like a key (`api_key`, `token`, `password` and the like) is saved as `[removed]` in both `input` and `request`.
- **Tool run records on Cloud.** When logged in, `tools run`, `tools abort` and a `tools get` that sees a run finish also `POST /api/v1/tools/runs` with `id`, `tool`, `status`, `started_at`, `finished_at`, `request` and `cost`. The output and the error text are not sent, and email addresses in the input are replaced with `[email removed]`. It is best effort with a 5 second limit: it never fails the run, and the JSON output carries `"cloud": { "posted": true }` or `{ "posted": false, "code": "..." }`.
- **`lifecycle skills push DIRECTORY [--slug NAME]` and `lifecycle skills delete SLUG`.** `push` sends a skill folder to `PUT /api/v1/skills/:slug` as `{ "files": [{ "path", "content" }] }`. It needs a `SKILL.md` at the top, takes text files only, refuses more than 200 KB, never follows a link, and sends nothing when a file looks like it holds a key (the error names the file and line, never the value). `delete` lists the store's skills first, so a missing skill is `unknown_skill` and a Cloud without the route is `not_built`.
- **`skills sync` installs the store's own skills** when logged in, under `skills/store-SLUG/` beside the kit skills, tracked the same way so an edited file is kept and `skills uninstall` removes them. Each target in the JSON output gains `account: { status, skills, skipped }`. A skill from Cloud with a path that leaves its folder, a bad name or more than 200 KB is skipped whole. If Cloud cannot be asked, kits still sync and installed store skills are left alone. `skills status` gains `storeSkills` (installed here) and `account` (what the store keeps on Cloud).
- **`kits show NAME` prints the kit's file list**, and its JSON gains `files`.
- **`lifecycle docs cloud`**, a `cloud.url` setting, and a `cloud-token` entry in `lifecycle secrets list`.

### Changed

- **`logs --cloud` now means Cosmic Cloud.** The GitHub Actions log has its own flag, `logs --actions`. A machine that is not logged in to Cosmic Cloud still gets the Actions log from `--cloud`, with a note on stderr, so existing scripts keep working. So does `logs --cloud --repo OWNER/NAME`, which can only mean the Actions log.
- **`busy`, reviewed.** Read commands that first bring an older database up to date (`report revenue-per-flow`, `audit flows`, `logs`, `metrics candidates`, `segments propose`) used to do that without the write lock. They now take the lock for that step and skip it when a writer holds the store, so a read never writes beside a sync. Cosmic Cloud's `503 busy` maps to code `busy` with the seconds Cloud said to wait.
- **`warehouse sync` results carry a `code`.** A loader process that dies without a result is `loader_failed`, with one plain sentence in `detail` in place of the tail of the loader's log. Other failures keep the code of the error that stopped them (`missing_secret`, `missing_uv`). The code is saved with the run, so `lifecycle logs` shows it. `warehouse connect`, `schema` and `query` still report a dead runner as `runner_failed`. Fixed along the way: a loader that died before reading its job could end the whole CLI with an unhandled broken pipe, so no result was printed at all.
- **`lifecycle exec` does not add the Cosmic Cloud token** from the keychain to the command's environment. A `LIFECYCLE_CLOUD_TOKEN` already set in the environment is inherited as before.

### Error codes added in 0.13.0

For the app contract. Each comes with a plain sentence in `error` and a next step in `next`.

| Code | When | Sentence |
|---|---|---|
| `not_logged_in` | A Cloud command ran with no store token | Not logged in to Cosmic Cloud. |
| `unauthorized` | Cloud answered 401 | Cosmic Cloud refused the store token. It may have been revoked. |
| `not_built` (new use) | Cloud answered 404 `not_found` or 405 on a route | Cosmic Cloud does not have this yet (GET /schema). |
| `cloud_unreachable` | No answer, or no answer in 30 seconds | Cosmic Cloud did not answer: it could not be reached. |
| `cloud_error` | An answer with no error code this CLI can read | Cosmic Cloud answered with status 500. |
| `bad_url` | The address is not plain https, Cloud redirected, or the address is not Cosmic Cloud | The Cloud address must start with https, so the store token is never sent in the clear. |
| `bad_token` | The token has a space, a line break or a character a token never has | That token has spaces, line breaks or other characters a token never has. |
| `unknown_table` | `schema TABLE --cloud` named a table Cloud does not hold | Cosmic Cloud has no table NAME. |
| `busy` (new use) | Cloud answered 503 `busy` | Another change to this store is running on Cosmic Cloud. |
| `rate_limited` (new use) | Cloud answered 429 | Cosmic Cloud is getting too many calls from this store token. |
| `loader_failed` | A warehouse loader process died without a result | The loader for NAME stopped before it finished, so this sync did not complete. |
| `too_large` | `skills push`: over 200 KB | This skill is N KB. The most a skill can be is 200 KB. |
| `secret_found` | `skills push`: a file looks like it holds a key | Nothing was pushed. FILE line N looks like a Stripe key. |
| `bad_skill` | `skills push` or `delete`: no `SKILL.md`, a bad name, a file that is not text, or a link | DIR has no SKILL.md. |
| `unknown_skill` | `skills delete`: the store has no such skill | This store has no skill named SLUG on Cosmic Cloud. |
| `cannot_abort` | `tools abort`: the provider cannot stop a job, or the run has no cancel link | Kie has no way to stop a job once it starts. It will finish and bill as usual. |
| `not_running` | `tools abort`: the run had already ended | Run ID is not running. It succeeded. |

Codes Cloud sends itself pass through unchanged with Cloud's own sentence: `invalid_request`, `unknown_metric`, `not_synced`, `read_only`, `multiple_statements`, `blocked_object`, `query_failed`, `server_error` and the rest of the Cloud API's table.

### Environment variables added

- `LIFECYCLE_CLOUD_URL`: the Cosmic Cloud address. Wins over the address `login` saved.
- `LIFECYCLE_CLOUD_TOKEN`: the store token. Wins over the keychain.

### What is proven and what is not

- Typecheck and the full test suite pass. The new tests run the real CLI against a local stand-in for the Cloud API.
- **Nothing here has run against the real Cosmic Cloud.** Cloud has `GET /store`, `POST /sync` and `GET /metrics/:name` today. `GET /schema`, `POST /query`, `GET /metrics`, `GET /runs`, `/skills` and `/tools/runs` are being built, so their shapes come from the plan. The client reads `{ "skills": [...] }`, `{ "runs": [...] }` and `{ "metrics": [...] }` or a bare list, and query rows as objects or as arrays.
- `tools abort` was written from the Apify and fal API docs and tested against recorded answers, never a real job.
- The automated tests run with the keychain off. Saving the token to the macOS keychain, reading it back and removing it on `logout` was checked once by hand, against the local stand-in.
- The check for keys in a pushed skill looks for well-known key shapes and file names. It will miss a key in a shape it does not know.
