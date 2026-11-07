import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from './errors.js'
import type { Config } from './config.js'
import { VERSION } from './version.js'

export const PACKAGE = `https://github.com/jbauman-26/cosmic-lifecycle/releases/download/v${VERSION}/cosmic-lifecycle-${VERSION}.tgz`

export function workflowYaml(hasGa4: boolean) {
  const ga4 = hasGa4
    ? `      LIFECYCLE_GA4_CLIENT_SECRET: \${{ secrets.LIFECYCLE_GA4_CLIENT_SECRET }}\n      LIFECYCLE_GA4_REFRESH_TOKEN: \${{ secrets.LIFECYCLE_GA4_REFRESH_TOKEN }}\n`
    : ''
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
${ga4}      LIFECYCLE_HOME: .lifecycle
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --no-save ${PACKAGE}
      - run: npx lifecycle sync
`
}

export function deployPlan(config: Config, repo: string) {
  return {
    repo,
    creates: [`Private GitHub repo ${repo}`, 'A daily sync at 09:17 UTC in GitHub Actions'],
    secrets: ['LIFECYCLE_DATABASE_URL', 'LIFECYCLE_KLAVIYO_READ_KEY', 'LIFECYCLE_SHOPIFY_CLIENT_SECRET', ...(config.ga4 ? ['LIFECYCLE_GA4_CLIENT_SECRET', 'LIFECYCLE_GA4_REFRESH_TOKEN'] : [])],
    expectedCost: 'Likely $0 on free plans for a small brand: about 150 of 2,000 Actions minutes a month, and summary tables inside Neon Free. Check both plans for your size.',
  }
}

const gh = (args: string[], input?: string, cwd?: string) => spawnSync('gh', args, { encoding: 'utf8', input, cwd })

// The files that make up a sync project. `deploy --write DIR` writes them without creating anything on GitHub.
export function writeProject(config: Config, dir: string) {
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(dir, '.lifecycle'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'sync.yml'), workflowYaml(Boolean(config.ga4)))
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

export function deployLogs(repo: string | undefined, tail = 60) {
  const { runs } = deployStatus(repo, 1)
  const last = runs[0]
  if (!last) throw new CliError('No runs yet.', 'lifecycle deploy run', 'no_runs')
  const r = gh(['run', 'view', String(last.id), '--repo', repo!, '--log'])
  const lines = (r.stdout || r.stderr).trim().split('\n')
  return { repo, run: last, log: lines.slice(-tail).join('\n') }
}
