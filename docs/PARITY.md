# Cosmic Lifecycle and the Graphed CLI, command by command

Graphed's CLI (0.0.24, checked 2026-11-07) runs your marketing on their cloud. Cosmic Lifecycle runs on your machine and your own accounts, and stores totals only. This page maps each Graphed command to its Cosmic equivalent, or says why there is none.

| Graphed | Cosmic Lifecycle | Notes |
|---|---|---|
| `login`, `logout`, `accounts list` | `status` | No account exists. `status` is the first check: setup, sources, trust, daily sync, updates. |
| `config set/get/list/unset` | `config set/get/list/unset` | Settings: `registry.uri`, `deploy.repo`, `update.check`. |
| `init` | `init` | Sets up a local or your own Postgres database. |
| `deploy` | `deploy` | Creates a private repo on your GitHub with a daily GitHub Actions sync. `--write DIR` writes the files and creates nothing. |
| `projects list/create/delete` | `config get deploy.repo` | One sync repo per store. Deleting a repo stays in your hands on GitHub. |
| `jobs list/run` | `jobs list/run` | Runs of the daily sync, with the success streak. |
| `logs` | `logs`, `logs --cloud` | Local sync history, or the last GitHub Actions log. |
| `secrets set/list/delete` | `secrets set/list/delete` | macOS keychain or `LIFECYCLE_*` variables. Values are never printed. `set` reads from an environment variable, never an argument. |
| `sources list/catalog` | `sources list/catalog` | Klaviyo, Shopify, GA4. Only sources with a working connector are listed. |
| `warehouse schema/query`, `databases query` | `schema`, `query` | Read-only, one statement, 1,000-row cap, system tables blocked. |
| MCP `explore_schema`, `query`, `list_source_catalog` | `lifecycle mcp`: same tool names | Plus `metric`, `list_metrics`, `metric_candidates`, `reconcile`, `revenue_per_flow`, `audit_flows`. |
| Verified metrics (their blog, January 2026) | `metrics list/show/run/candidates` | Fixed SQL per metric. Repeated custom queries surface as candidates for new metrics. |
| `publish_query`, embedded dashboards | `dashboard` | A local HTML page. Never a public URL, because the numbers are a brand's revenue. |
| `plugins list/search/show/add/validate` | `kits list/search/show/add/validate` | Kits come from [cosmic-registry](https://github.com/jbauman-26/cosmic-registry), refreshed every 10 minutes. |
| Skills page "Copy setup prompt" | `kits prompt NAME` | |
| `skills sync/status/push/delete/uninstall` | `skills sync/status/uninstall` | `/lifecycle` and `/lifecycle:kits:NAME` in Claude Code and Cursor. Editing a skill is done in the registry, not pushed per account. |
| `docs` | `docs` | `quickstart`, `setup`, `agents`, `kits`, `commands`, `troubleshooting`. |
| llms.txt | [llms.txt](../llms.txt) | Generated from `docs quickstart`. CI fails if they differ. |
| `feedback` | `feedback` | A prefilled GitHub issue with versions only. |
| Update notices | `status` | Checks GitHub at most once a day. Turn off with `config set update.check false`. |
| Forward-deployed engineers | [Setup with Jake at NorthSignal](https://northsignal.studio/lifecycle) | A person sets it up for you. |

## Not built, on purpose

| Graphed | Why not |
|---|---|
| `services`, `exec`, `dev run`, `files`, `storage` | These run code on Graphed's servers. Cosmic has no servers, so there is nothing to run them on. |
| `tools catalog/run` (pay-per-call credits) | Reselling provider APIs needs each provider's permission, and you would pay us a markup on your own usage. Bring your own keys. |
| A paid plan to use the CLI | The CLI is free and MIT licensed. |
| 750+ sources | Three, each reconciled against the others. A source joins when its numbers can be checked. |
