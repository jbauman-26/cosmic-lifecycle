import { readWorkspace } from './workspace.js'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from './errors.js'
import type { Config } from './config.js'
import { VERSION } from './version.js'
import { appHome } from './paths.js'
import { sourceSecretEnv } from './secrets.js'
import { WAREHOUSE_CATALOG } from './warehouse-catalog.js'

export const PACKAGE = `https://github.com/jbauman-26/cosmic-lifecycle/releases/download/v${VERSION}/cosmic-lifecycle-${VERSION}.tgz`

// One Actions secret per credential of each connected warehouse source, as {env, slug, field}.
export function warehouseSecrets(config: Config) {
  return Object.keys(config.warehouse?.sources ?? {}).flatMap((slug) => {
    const fields = WAREHOUSE_CATALOG.find((s) => s.slug === slug)?.credentials.map((c) => c.name) ?? customFields(slug)
    return fields.map((field) => ({ env: sourceSecretEnv(slug, field), slug, field }))
  })
}

function customFields(slug: string): string[] {
  try {
    const spec = JSON.parse(readFileSync(join(appHome(), 'custom-apis', `${slug}.json`), 'utf8'))
    return (spec.credentials ?? []).map((c: { name: string }) => c.name)
  } catch {
    return []
  }
}

export function workflowYaml(hasGa4: boolean, hasStripe = false, warehouseEnvs: string[] = [], hasWarehouse = warehouseEnvs.length > 0, hasMeta = false, hasHubspot = false, hasGoogleAds = false, hasTiktokAds = false, hasPinterestAds = false) {
  const ga4 = hasGa4
    ? `      LIFECYCLE_GA4_CLIENT_SECRET: \${{ secrets.LIFECYCLE_GA4_CLIENT_SECRET }}\n      LIFECYCLE_GA4_REFRESH_TOKEN: \${{ secrets.LIFECYCLE_GA4_REFRESH_TOKEN }}\n`
    : ''
  const stripe = (hasStripe ? `      LIFECYCLE_STRIPE_READ_KEY: \${{ secrets.LIFECYCLE_STRIPE_READ_KEY }}\n` : '') + (hasMeta ? `      LIFECYCLE_META_ADS_TOKEN: \${{ secrets.LIFECYCLE_META_ADS_TOKEN }}\n` : '') + (hasHubspot ? `      LIFECYCLE_HUBSPOT_TOKEN: \${{ secrets.LIFECYCLE_HUBSPOT_TOKEN }}\n` : '')
    + (hasGoogleAds ? `      LIFECYCLE_GOOGLE_ADS_CLIENT_SECRET: \${{ secrets.LIFECYCLE_GOOGLE_ADS_CLIENT_SECRET }}\n      LIFECYCLE_GOOGLE_ADS_REFRESH_TOKEN: \${{ secrets.LIFECYCLE_GOOGLE_ADS_REFRESH_TOKEN }}\n` : '')
    + (hasTiktokAds ? `      LIFECYCLE_TIKTOK_ADS_ACCESS_TOKEN: \${{ secrets.LIFECYCLE_TIKTOK_ADS_ACCESS_TOKEN }}\n` : '')
    + (hasPinterestAds ? `      LIFECYCLE_PINTEREST_ADS_CLIENT_SECRET: \${{ secrets.LIFECYCLE_PINTEREST_ADS_CLIENT_SECRET }}\n      LIFECYCLE_PINTEREST_ADS_REFRESH_TOKEN: \${{ secrets.LIFECYCLE_PINTEREST_ADS_REFRESH_TOKEN }}\n` : '')
  return `name: Daily sync
on:
  schedule:
    - cron: '17 9 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      LIFECYCLE_DATABASE_URL: \${{ secrets.LIFECYCLE_DATABASE_URL }}
      LIFECYCLE_KLAVIYO_READ_KEY: \${{ secrets.LIFECYCLE_KLAVIYO_READ_KEY }}
      LIFECYCLE_SHOPIFY_CLIENT_SECRET: \${{ secrets.LIFECYCLE_SHOPIFY_CLIENT_SECRET }}
      LIFECYCLE_SHOPIFY_CUSTOMER_KEY: \${{ secrets.LIFECYCLE_SHOPIFY_CUSTOMER_KEY }}
${ga4}${stripe}${warehouseEnvs.map((e) => `      ${e}: \${{ secrets.${e} }}\n`).join('')}      LIFECYCLE_HOME: .lifecycle
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --no-save ${PACKAGE}
      - run: npx lifecycle sync
${hasWarehouse ? `      # Warehouse sources load raw tables with dlt, run by uv.
      - uses: astral-sh/setup-uv@v6
      - run: npx lifecycle warehouse sync
` : ''}      # A dashboard of totals, kept in this private repo for 30 days. lifecycle files pull downloads it.
      - run: npx lifecycle dashboard --html lifecycle-dashboard.html
        if: always()
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: lifecycle-dashboard
          path: lifecycle-dashboard.html
          retention-days: 30
          if-no-files-found: ignore
`
}

export function deployPlan(config: Config, repo: string) {
  return {
    repo,
    creates: [`Private GitHub repo ${repo}`, 'A daily sync at 09:17 UTC in GitHub Actions'],
    // A store needs Klaviyo and Shopify keys, as in 0.13. Any other workspace only the ones it connected.
    secrets: ['LIFECYCLE_DATABASE_URL', ...(readWorkspace().type === 'shopify' || config.klaviyo ? ['LIFECYCLE_KLAVIYO_READ_KEY'] : []), ...(readWorkspace().type === 'shopify' || config.shopify ? ['LIFECYCLE_SHOPIFY_CLIENT_SECRET', 'LIFECYCLE_SHOPIFY_CUSTOMER_KEY'] : []), ...((config as { hubspot?: unknown }).hubspot ? ['LIFECYCLE_HUBSPOT_TOKEN'] : []), ...(config.ga4 ? ['LIFECYCLE_GA4_CLIENT_SECRET', 'LIFECYCLE_GA4_REFRESH_TOKEN'] : []), ...(config.stripe ? ['LIFECYCLE_STRIPE_READ_KEY'] : []), ...(config.meta ? ['LIFECYCLE_META_ADS_TOKEN'] : []), ...(config['google-ads'] ? ['LIFECYCLE_GOOGLE_ADS_CLIENT_SECRET', 'LIFECYCLE_GOOGLE_ADS_REFRESH_TOKEN'] : []), ...(config['tiktok-ads'] ? ['LIFECYCLE_TIKTOK_ADS_ACCESS_TOKEN'] : []), ...(config['pinterest-ads'] ? ['LIFECYCLE_PINTEREST_ADS_CLIENT_SECRET', 'LIFECYCLE_PINTEREST_ADS_REFRESH_TOKEN'] : []), ...warehouseSecrets(config).map((w) => w.env)],
    expectedCost: 'Likely $0 on free plans for a small brand: about 150 of 2,000 Actions minutes a month, and summary tables inside Neon Free. Check both plans for your size.',
  }
}

const gh = (args: string[], input?: string, cwd?: string) => spawnSync('gh', args, { encoding: 'utf8', input, cwd })

// The files that make up a sync project. `deploy --write DIR` writes them without creating anything on GitHub.
export function writeProject(config: Config, dir: string) {
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(dir, '.lifecycle'), { recursive: true })
  const wh = warehouseSecrets(config)
  writeFileSync(join(dir, '.github', 'workflows', 'sync.yml'), workflowYaml(Boolean(config.ga4), Boolean(config.stripe), wh.map((w) => w.env), Object.keys(config.warehouse?.sources ?? {}).length > 0, Boolean(config.meta), Boolean((config as { hubspot?: unknown }).hubspot), Boolean(config['google-ads']), Boolean(config['tiktok-ads']), Boolean(config['pinterest-ads'])))
  // Custom API specs travel with the project, so the runner can load them.
  if (existsSync(join(appHome(), 'custom-apis'))) cpSync(join(appHome(), 'custom-apis'), join(dir, '.lifecycle', 'custom-apis'), { recursive: true })
  // The store name and client id are not secret, and the runner needs them.
  const { registry: _r, deploy: _d, update: _u, ...runner } = config
  writeFileSync(join(dir, '.lifecycle', 'config.json'), JSON.stringify({ ...runner, database: { kind: 'postgres' } }, null, 2) + '\n')
  writeFileSync(join(dir, 'README.md'), '# Lifecycle sync\n\nRuns `lifecycle sync` every day. Keys live in GitHub Actions secrets.\n')
  return { dir, files: ['.github/workflows/sync.yml', '.lifecycle/config.json', 'README.md'] }
}

// Runs only with --yes. Secrets go through stdin, never the command line.
export function deploy(config: Config, repo: string, secrets: Record<string, string>) {
  if (gh(['auth', 'status']).status !== 0) throw new CliError('GitHub CLI is not signed in.', 'gh auth login', 'gh_auth')
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-deploy-'))
  writeProject(config, dir)
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'chore: daily lifecycle sync']]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new CliError(`git ${args[0]} failed.`, 'lifecycle doctor')
  }
  const created = gh(['repo', 'create', repo, '--private', '--source', '.', '--push'], undefined, dir)
  if (created.status !== 0) throw new CliError(`Could not create ${repo}: ${created.stderr.trim().slice(0, 160)}`, 'Pick another repo name.', 'gh_repo')
  for (const [name, value] of Object.entries(secrets)) {
    const r = gh(['secret', 'set', name, '--repo', repo], value)
    if (r.status !== 0) throw new CliError(`Could not set ${name}.`, 'lifecycle deploy', 'gh_secret')
  }
  return { repo, url: `https://github.com/${repo}`, firstRun: 'lifecycle deploy run' }
}

export type WorkflowRun = { id: number; status: string; conclusion: string | null; event: string; createdAt: string; url: string }

function requireRepo(repo: string | undefined): string {
  if (!repo) throw new CliError('No sync repo is set.', 'lifecycle deploy --repo OWNER/NAME, or lifecycle config set deploy.repo OWNER/NAME', 'no_repo')
  if (gh(['auth', 'status']).status !== 0) throw new CliError('GitHub CLI is not signed in.', 'gh auth login', 'gh_auth')
  return repo
}

export function deployStatus(repo: string | undefined, limit = 7) {
  const r = gh(['run', 'list', '--repo', requireRepo(repo), '--workflow', 'sync.yml', '--limit', String(limit), '--json', 'databaseId,status,conclusion,event,createdAt,url'])
  if (r.status !== 0) throw new CliError(`Could not read runs for ${repo}: ${r.stderr.trim().slice(0, 160)}`, 'Check the repo name with lifecycle config get deploy.repo', 'gh_runs')
  const runs: WorkflowRun[] = JSON.parse(r.stdout || '[]').map((x: any) => ({ id: x.databaseId, status: x.status, conclusion: x.conclusion, event: x.event, createdAt: x.createdAt, url: x.url }))
  return { repo, runs, successStreak: successStreak(runs) }
}

// Successful runs in a row, newest first. Seven in a row is the release test for running with the laptop closed.
// A run still in progress neither counts nor breaks the streak.
export function successStreak(runs: Pick<WorkflowRun, 'status' | 'conclusion'>[]) {
  let streak = 0
  for (const run of runs) {
    if (run.conclusion === 'success') streak++
    else if (run.status === 'completed') break
  }
  return streak
}

export function deployRun(repo: string | undefined) {
  const r = gh(['workflow', 'run', 'sync.yml', '--repo', requireRepo(repo)])
  if (r.status !== 0) throw new CliError(`Could not start a run: ${r.stderr.trim().slice(0, 160)}`, 'lifecycle deploy status', 'gh_run')
  return { repo, started: true, next: 'lifecycle deploy status' }
}

// One run by id, so a follow stays on the run it started with even when a newer one is dispatched.
export function deployRunById(repo: string | undefined, id: number): WorkflowRun {
  const r = gh(['run', 'view', String(id), '--repo', requireRepo(repo), '--json', 'databaseId,status,conclusion,event,createdAt,url'])
  if (r.status !== 0) throw new CliError(`Could not read run ${id} for ${repo}: ${r.stderr.trim().slice(0, 160)}`, 'lifecycle jobs list', 'gh_runs')
  const x = JSON.parse(r.stdout)
  return { id: x.databaseId, status: x.status, conclusion: x.conclusion, event: x.event, createdAt: x.createdAt, url: x.url }
}

// The log of one run. Without `run`, the newest one.
export function deployLogs(repo: string | undefined, tail = 60, run?: WorkflowRun) {
  const last = run ?? deployStatus(repo, 1).runs[0]
  if (!last) throw new CliError('No runs yet.', 'lifecycle deploy run', 'no_runs')
  const r = gh(['run', 'view', String(last.id), '--repo', repo!, '--log'])
  const lines = (r.stdout || r.stderr).trim().split('\n')
  return { repo, run: last, log: lines.slice(-tail).join('\n') }
}

// Waits for one run to finish: the first one `latest` returns. `byId` re-reads that same run on later polls. Reports each change of state once. Polls every 5 seconds for
// up to 17 minutes, which is past the workflow's own 15-minute limit.
export async function followRun(latest: () => WorkflowRun | undefined, byId: (id: number) => WorkflowRun, onChange: (run: WorkflowRun) => void, wait: () => Promise<unknown> = () => new Promise((r) => setTimeout(r, 5000)), maxPolls = 204): Promise<WorkflowRun> {
  let seen = ''
  let id: number | undefined
  for (let i = 0; i < maxPolls; i++) {
    const run = id === undefined ? latest() : byId(id)
    if (!run) throw new CliError('No runs yet.', 'lifecycle jobs run', 'no_runs')
    id = run.id
    const state = `${run.id}:${run.status}:${run.conclusion}`
    if (state !== seen) onChange(run)
    seen = state
    if (run.status === 'completed') return run
    await wait()
  }
  throw new CliError('The run is still going after 17 minutes.', 'lifecycle jobs list', 'follow_timeout')
}
