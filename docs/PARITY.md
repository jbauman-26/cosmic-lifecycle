# Cosmic Lifecycle and the Graphed CLI, command by command

Graphed's CLI (0.0.24, checked 2026-11-07) runs your marketing on Graphed's cloud. Cosmic Lifecycle gives you the same command surface on your own machine, your own GitHub and your own database, and stores totals only. Every Graphed command has a Cosmic equivalent below. Where the two work differently, the Notes column says how and why.

| Graphed | Cosmic Lifecycle | Notes |
|---|---|---|
| `login`, `logout`, `accounts list` | `status` | There is no account to log in to. `status` is the first check: setup, sources, trust line, daily sync, updates. |
| `config set/get/list/unset` | `config set/get/list/unset` | `registry.uri`, `deploy.repo`, `update.check`. |
| `init` | `init` | A local database, or your own Postgres with `--database-url-env`. |
| `clone` | `deploy --write DIR` | Writes the sync project files locally. Clone an existing sync repo with `gh repo clone`. |
| `deploy` | `deploy` | A private repo on your GitHub with a daily GitHub Actions sync. Prints the plan first; creates nothing without `--yes`. |
| `projects list/create/delete` | `provision neon`, `deploy`, `config get deploy.repo` | `provision neon` creates the managed Postgres in your own Neon account; `deploy` creates the sync repo. Deleting either stays your call. |
| `jobs list/run` | `jobs list/run` | Runs of the daily sync, with the success streak toward the 7-day release test. |
| `logs` | `logs`, `logs --cloud` | Local sync history, or the log of the last GitHub Actions run. |
| `services list` | `serve` | The dashboard and a read-only JSON API (`/api/metrics/:name`, `/api/reconcile`, `/api/flows`, `/api/audit`) on 127.0.0.1. |
| `exec`, `dev run` | `exec -- COMMAND` | Runs any command with your keys and store settings in its environment, so a script or agent can use them without seeing or pasting them. |
| `secrets set/list/delete` | `secrets set/list/delete` | macOS keychain or `LIFECYCLE_*` variables. `set` reads from an environment variable, never an argument. Values are never printed. |
| `sources list/catalog` | `sources list/catalog` | Klaviyo, Shopify and GA4 natively, each reconciled against the others. |
| 750+ managed source pipelines | `sources import NAME --csv FILE` | Any other tool comes in as daily totals from its CSV export. Columns that look like personal data, and any non-numeric value, are refused. |
| `warehouse schema/query`, `databases list/query` | `schema`, `query` | Read-only, one statement, 1,000-row cap, system tables blocked. Custom sources appear in `schema`. |
| `tools catalog/run/get/abort` | `tools catalog/run/get/runs` | Read-only Klaviyo and Shopify API tools on your own keys. Runs are saved and fetched by id. Calls finish in seconds, so there is nothing to abort. No credits and no markup. |
| `files ls/cat` | `files ls/cat` | Every report, dashboard and plan the CLI writes, kept by date. |
| `storage upload/download/url` | `files put/get/path`, `files pull` | `pull` downloads the dashboard the daily sync uploads to your own private repo. No public URLs, because the numbers are a brand's revenue. |
| MCP `whoami`, `list_source_catalog`, `explore_schema`, `query` | `lifecycle mcp` | Same names where they apply, plus `metric`, `list_metrics`, `metric_candidates`, `list_tool_catalog`, `run_tool`, `list_files`, `read_file`, `reconcile`, `revenue_per_flow`, `audit_flows`. |
| Verified metrics (their blog, January 2026) | `metrics list/show/run/candidates` | Fixed SQL per metric. Repeated custom queries become candidates for new metrics. |
| `publish_query`, embedded dashboards | `dashboard`, `serve` | A local HTML file, or a local web page that updates on reload. |
| `plugins list/search/show/add/validate` | `kits list/search/show/add/validate` | Kits come from [cosmic-registry](https://github.com/jbauman-26/cosmic-registry), refreshed every 10 minutes. |
| Skills page "Copy setup prompt" | `kits prompt NAME` | |
| `skills sync/status/push/delete/uninstall` | `skills sync/status/uninstall` | `/lifecycle` and `/lifecycle:kits:NAME` in Claude Code and Cursor. Kits and skills are edited in the registry rather than pushed per account. |
| `docs` | `docs` | `quickstart`, `setup`, `agents`, `kits`, `commands`, `troubleshooting`. |
| llms.txt | [llms.txt](../llms.txt) | Generated from `docs quickstart`. CI fails if they differ. |
| `feedback` | `feedback` | A prefilled GitHub issue with versions only. |
| Update notices | `status` | Checks GitHub at most once a day. Turn off with `config set update.check false`. |
| Forward-deployed engineers | [Setup with Jake at NorthSignal](https://northsignal.studio/lifecycle) | A person sets it up for you, starting with a free call. |

## Where the two differ on purpose

- **Hosting.** A hosted Cosmic Cloud is not built. Running it means paying for infrastructure and holding brands' data, so it waits until a brand asks to pay not to run it themselves.
- **Where things run.** Graphed runs your jobs and services on its servers. Cosmic runs them on your machine and in your GitHub account, so there is no server of ours holding your data.
- **How tools are paid for.** Graphed charges plan credits per tool call, across 233 tools from 13 providers. Cosmic's tools call Klaviyo and Shopify directly on your own keys, at no cost from us. It covers fewer providers, and only the ones lifecycle work needs.
- **How sources connect.** Graphed manages 750+ pipelines into its warehouse. Cosmic connects three natively and imports any other tool's daily totals from CSV. It never imports customer records.
- **Price.** The CLI is free and MIT licensed. There is no paid plan.
