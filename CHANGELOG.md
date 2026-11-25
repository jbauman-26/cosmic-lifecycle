# Changelog

Every release of Cosmic Lifecycle from 0.13.0 on. Earlier releases are described in their GitHub release notes.

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
- **`warehouse sync` results carry a `code`.** A loader process that dies without a result is `loader_failed`, with one plain sentence in `detail` in place of the tail of the loader's log. Other failures keep the code of the error that stopped them (`missing_secret`, `missing_uv`). The code is saved with the run, so `lifecycle logs` shows it. `warehouse connect`, `schema` and `query` still report a dead runner as `runner_failed`.
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
