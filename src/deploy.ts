import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from './errors.js'
import type { Config } from './config.js'

export const PACKAGE = 'https://github.com/jbauman-26/cosmic-lifecycle/releases/download/v0.1.0/cosmic-lifecycle-0.1.0.tgz'

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

// Runs only with --yes. Secrets go through stdin, never the command line.
export function deploy(config: Config, repo: string, secrets: Record<string, string>) {
  if (gh(['auth', 'status']).status !== 0) throw new CliError('GitHub CLI is not signed in.', 'gh auth login', 'gh_auth')
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-deploy-'))
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(dir, '.lifecycle'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'sync.yml'), workflowYaml(Boolean(config.ga4)))
  // The store name and client id are not secret, and the runner needs them.
  writeFileSync(join(dir, '.lifecycle', 'config.json'), JSON.stringify({ ...config, database: { kind: 'postgres' } }, null, 2) + '\n')
  writeFileSync(join(dir, 'README.md'), '# Lifecycle sync\n\nRuns `lifecycle sync` every day. Keys live in GitHub Actions secrets.\n')
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
  return { repo, url: `https://github.com/${repo}`, firstRun: `gh workflow run sync.yml --repo ${repo}` }
}
