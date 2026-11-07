import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { readConfig, writeConfig, type Config } from './config.js'
import { appHome } from './paths.js'
import { getSecret, getSourceSecret, setSourceSecret, deleteSourceSecret, sourceSecretEnv } from './secrets.js'
import { CliError } from './errors.js'
import { WAREHOUSE_CATALOG } from './warehouse-catalog.js'
import { assertReadOnlySql } from './query.js'

// The pipeline engine is dlt (Apache 2.0), pinned so every machine loads data the same way.
export const DLT_VERSION = '1.32.0'
export const PYTHON_VERSION = '3.12'

// How far a source has been proven. Only `native` and `tested` have run on a real account.
//   native   built into this CLI with its own reconcile checks
//   tested   a warehouse connector that has synced a real account
//   built    a warehouse connector written from the vendor's API docs, not yet run on a real account
//   planned  on the list, no connector yet: bring daily totals in with `sources import` meanwhile
export type Readiness = 'native' | 'tested' | 'built' | 'planned'

export type CredentialField = { name: string; label: string; help: string }
export type ParamField = { name: string; label: string; example: string }

export type WarehouseSource = {
  slug: string
  name: string
  category: string
  readiness: Readiness
  // Why it is on the list, with the evidence: a usage count and where it came from.
  why: string
  docs: string
  credentials: CredentialField[]
  params: ParamField[]
  // A dlt rest_api config. {secret:NAME} and {param:NAME} are filled in at run time.
  config?: Record<string, unknown>
  tested?: string
  notes?: string
}

const CustomSpec = z.object({
  name: z.string().min(1),
  category: z.string().default('custom'),
  docs: z.string().default(''),
  credentials: z.array(z.object({ name: z.string(), label: z.string().default(''), help: z.string().default('') })).default([]),
  params: z.array(z.object({ name: z.string(), label: z.string().default(''), example: z.string().default('') })).default([]),
  config: z.record(z.string(), z.unknown()),
})

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/
const customDir = () => join(appHome(), 'custom-apis')

// Any REST API can be added from a spec file, so a tool missing from the catalog is never a dead end.
export function customSources(): WarehouseSource[] {
  if (!existsSync(customDir())) return []
  return readdirSync(customDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const slug = f.replace(/\.json$/, '')
      const spec = CustomSpec.parse(JSON.parse(readFileSync(join(customDir(), f), 'utf8')))
      return { slug, readiness: 'built' as const, why: 'Added from your own API spec.', notes: 'Custom source', ...spec }
    })
}

export function addCustomSource(slug: string, specPath: string) {
  if (!SLUG.test(slug)) throw new CliError('Use a short name of lowercase letters, numbers and dashes.', 'lifecycle warehouse add-api my-tool --spec spec.json', 'bad_value')
  if (WAREHOUSE_CATALOG.some((s) => s.slug === slug)) throw new CliError(`${slug} is already in the catalog.`, `lifecycle warehouse connect ${slug}`, 'bad_value')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(specPath, 'utf8'))
  } catch {
    throw new CliError(`${specPath} is not readable JSON.`, 'lifecycle docs warehouse', 'bad_value')
  }
  const parsed = CustomSpec.safeParse(raw)
  if (!parsed.success) throw new CliError(`The spec is missing fields: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`, 'lifecycle docs warehouse', 'bad_value')
  const resources = (parsed.data.config as { resources?: unknown[] }).resources
  if (!Array.isArray(resources) || !resources.length) throw new CliError('The spec config needs at least one resource.', 'lifecycle docs warehouse', 'bad_value')
  mkdirSync(customDir(), { recursive: true, mode: 0o700 })
  writeFileSync(join(customDir(), `${slug}.json`), JSON.stringify(parsed.data, null, 2) + '\n', { mode: 0o600 })
  return { added: slug, next: `lifecycle warehouse connect ${slug}` }
}

export function allSources(): WarehouseSource[] {
  return [...WAREHOUSE_CATALOG, ...customSources()]
}

export function findSource(slug: string): WarehouseSource {
  const s = allSources().find((x) => x.slug === slug)
  if (!s) throw new CliError(`No warehouse source named ${slug}.`, 'lifecycle sources catalog', 'unknown_source')
  return s
}

export function searchCatalog(opts: { category?: string; query?: string; readiness?: string }) {
  const q = opts.query?.toLowerCase()
  return allSources().filter(
    (s) =>
      (!opts.category || s.category.toLowerCase() === opts.category.toLowerCase()) &&
      (!opts.readiness || s.readiness === opts.readiness) &&
      (!q || `${s.name} ${s.slug} ${s.category}`.toLowerCase().includes(q)),
  )
}

export const datasetFor = (slug: string) => `src_${slug.replace(/-/g, '_')}`
export const warehouseDuckPath = () => join(appHome(), 'warehouse.duckdb')
const pipelinesDir = () => join(appHome(), 'dlt')

function runnerPath() {
  // dist/warehouse.js and src/warehouse.ts both sit one level below the package root.
  const here = dirname(fileURLToPath(import.meta.url))
  const path = join(here, '..', 'connectors', 'run.py')
  if (!existsSync(path)) throw new CliError('The connector runner is missing from this install.', 'Reinstall Cosmic Lifecycle.', 'broken_install')
  return path
}

export function uvAvailable() {
  return spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0
}

type Destination = { kind: 'postgres'; url_env: string } | { kind: 'duckdb'; path: string }

function destination(config: Config): { dest: Destination; env: Record<string, string> } {
  if (config.database.kind === 'postgres') {
    const url = getSecret('database-url')
    if (!url) throw new CliError('No database URL saved.', 'Set LIFECYCLE_DATABASE_URL, or run lifecycle init --local.', 'no_database')
    return { dest: { kind: 'postgres', url_env: 'LIFECYCLE_WAREHOUSE_URL' }, env: { LIFECYCLE_WAREHOUSE_URL: url } }
  }
  mkdirSync(appHome(), { recursive: true, mode: 0o700 })
  return { dest: { kind: 'duckdb', path: warehouseDuckPath() }, env: {} }
}

export type RunnerResult = { ok: true; [k: string]: unknown } | { ok: false; error: string }

// Starts the Python runner in its own uv environment. The job goes in on stdin and
// secrets go in as environment variables, so neither shows in the process list.
export function runRunner(job: Record<string, unknown>, env: Record<string, string>, opts: { verbose?: boolean } = {}): Promise<RunnerResult> {
  if (!uvAvailable()) {
    return Promise.reject(new CliError('Warehouse sources need uv, the Python runner.', 'curl -LsSf https://astral.sh/uv/install.sh | sh', 'missing_uv'))
  }
  const args = ['run', '--quiet', '--no-project', '--python', PYTHON_VERSION, '--with', `dlt[postgres,duckdb]==${DLT_VERSION}`, 'python', runnerPath()]
  return new Promise((resolve, reject) => {
    const child = spawn('uv', args, { env: { ...process.env, ...env, RUNTIME__LOG_LEVEL: 'WARNING' }, stdio: ['pipe', 'pipe', opts.verbose ? 'inherit' : 'pipe'] })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (err += d))
    child.on('error', (e) => reject(new CliError(`Could not start uv: ${e.message}`, 'uv --version', 'missing_uv')))
    child.on('close', () => {
      const last = out.trim().split('\n').pop() ?? ''
      try {
        resolve(JSON.parse(last) as RunnerResult)
      } catch {
        reject(new CliError(`The connector runner stopped without a result. ${err.trim().split('\n').slice(-3).join(' ')}`.trim(), 'lifecycle warehouse sync --verbose', 'runner_failed'))
      }
    })
    child.stdin?.end(JSON.stringify(job))
  })
}

function secretEnv(source: WarehouseSource, fromEnv?: Record<string, string>) {
  const env: Record<string, string> = {}
  for (const c of source.credentials) {
    const value = fromEnv?.[c.name] ?? getSourceSecret(source.slug, c.name)
    if (!value) throw new CliError(`${source.name}: ${c.label || c.name} is missing.`, `lifecycle warehouse connect ${source.slug} --secret ${c.name}=ENV_VAR_NAME`, 'missing_secret')
    env[`LIFECYCLE_SRC_SECRET_${c.name.toUpperCase()}`] = value
  }
  return env
}

// Friendlier words for the errors people hit most.
export function explain(error: string) {
  if (/\b401\b|Unauthorized/i.test(error)) return 'The key was rejected (401). Check it is current and has read access.'
  if (/\b403\b|Forbidden/i.test(error)) return 'The key works but lacks permission for this data (403). Add read scopes and connect again.'
  if (/\b404\b/.test(error)) return 'The API returned 404. Check the store or account setting you passed with --set.'
  if (/\b429\b/.test(error)) return 'The API is rate limiting. Wait a few minutes, then sync again.'
  return error
}

const KV = /^([A-Za-z0-9_]+)=(.+)$/

export async function connectSource(slug: string, opts: { secret?: string[]; set?: string[]; keepPersonalData?: boolean; skipCheck?: boolean }) {
  const source = findSource(slug)
  if (source.readiness === 'native') throw new CliError(`${source.name} is a built-in source.`, `lifecycle connect ${slug} --help`, 'bad_value')
  if (!source.config) {
    throw new CliError(`${source.name} has no connector yet.`, `Export daily totals to CSV, then lifecycle sources import ${slug} --csv FILE. Or describe its API: lifecycle docs warehouse`, 'not_built')
  }
  const config = readConfig()
  const secrets: Record<string, string> = {}
  for (const pair of opts.secret ?? []) {
    const m = KV.exec(pair)
    if (!m) throw new CliError(`Use --secret FIELD=ENV_VAR_NAME, not ${pair.split('=')[0]}=...`, `lifecycle warehouse connect ${slug} --secret ${source.credentials[0]?.name ?? 'api_key'}=MY_KEY_VAR`, 'bad_value')
    if (!source.credentials.some((c) => c.name === m[1])) throw new CliError(`${source.name} has no credential called ${m[1]}.`, `lifecycle warehouse show ${slug}`, 'bad_value')
    const value = process.env[m[2]!]
    if (!value) throw new CliError(`Environment variable ${m[2]} is empty.`, 'Export the key, then pass its variable name. Do not paste keys into a chat.', 'missing_secret')
    secrets[m[1]!] = value
  }
  const params: Record<string, string> = { ...(config.warehouse?.sources[slug]?.params ?? {}) }
  for (const pair of opts.set ?? []) {
    const m = KV.exec(pair)
    if (!m) throw new CliError(`Use --set NAME=VALUE.`, `lifecycle warehouse show ${slug}`, 'bad_value')
    params[m[1]!] = m[2]!
  }
  const missingParams = source.params.filter((p) => !params[p.name])
  if (missingParams.length) {
    throw new CliError(`${source.name} needs ${missingParams.map((p) => p.name).join(', ')}.`, `lifecycle warehouse connect ${slug} ${missingParams.map((p) => `--set ${p.name}=${p.example}`).join(' ')}`, 'bad_value')
  }
  const env = secretEnv(source, secrets)
  let check: Record<string, unknown> | null = null
  if (!opts.skipCheck) {
    const { dest, env: destEnv } = destination(config)
    const r = await runRunner({ action: 'check', source: { slug, config: source.config }, params, destination: dest, dataset: datasetFor(slug), pipelines_dir: pipelinesDir() }, { ...env, ...destEnv })
    if (!r.ok) throw new CliError(`${source.name} check failed: ${explain(r.error)}`, `lifecycle warehouse show ${slug}`, 'check_failed')
    check = r
  }
  // Save only after the key has proven itself. Without a keychain (CI, Linux), syncs
  // read LIFECYCLE_SRC_<SLUG>_<FIELD> from the environment instead.
  const envNotes: string[] = []
  for (const [field, value] of Object.entries(secrets)) {
    try {
      setSourceSecret(slug, field, value)
    } catch (e) {
      if (e instanceof CliError && e.code === 'no_keychain') envNotes.push(sourceSecretEnv(slug, field))
      else throw e
    }
  }
  const sources = { ...(config.warehouse?.sources ?? {}) }
  sources[slug] = { params, personalData: opts.keepPersonalData ? 'keep' : 'strip', connectedAt: new Date().toISOString() }
  writeConfig({ ...config, warehouse: { sources } })
  return {
    connected: slug,
    personalData: opts.keepPersonalData ? 'kept (you chose --keep-personal-data)' : 'removed before anything is written',
    check: check ? { resource: check.resource, rows: check.rows } : 'skipped',
    readiness: source.readiness,
    keysSavedTo: envNotes.length ? `environment only: set ${envNotes.join(', ')} wherever syncs run` : 'keychain',
    next: `lifecycle warehouse sync ${slug}`,
  }
}

export function disconnectSource(slug: string) {
  const config = readConfig()
  const source = allSources().find((s) => s.slug === slug)
  const sources = { ...(config.warehouse?.sources ?? {}) }
  if (!sources[slug]) throw new CliError(`${slug} is not connected.`, 'lifecycle warehouse list', 'bad_value')
  delete sources[slug]
  writeConfig({ ...config, warehouse: { sources } })
  const removed = (source?.credentials ?? []).map((c) => deleteSourceSecret(slug, c.name))
  return { disconnected: slug, keysRemoved: removed.filter(Boolean).length, note: `Data already loaded stays in ${datasetFor(slug)}. Drop it yourself if you no longer want it.` }
}

export function connectedSources(config: Config) {
  return Object.entries(config.warehouse?.sources ?? {}).map(([slug, s]) => ({ slug, ...s }))
}

export type WarehouseSyncResult = { source: string; status: 'ok' | 'failed'; rows: number; tables?: Record<string, number>; detail?: string }

export async function syncSources(slugs: string[] | undefined, opts: { verbose?: boolean; record?: (r: WarehouseSyncResult, startedAt: string) => Promise<void> } = {}) {
  const config = readConfig()
  const connected = connectedSources(config)
  if (!connected.length) throw new CliError('No warehouse sources connected.', 'lifecycle sources catalog', 'no_sources')
  const chosen = slugs?.length ? connected.filter((c) => slugs.includes(c.slug)) : connected
  const unknown = (slugs ?? []).filter((s) => !connected.some((c) => c.slug === s))
  if (unknown.length) throw new CliError(`Not connected: ${unknown.join(', ')}.`, 'lifecycle warehouse list', 'bad_value')
  const { dest, env: destEnv } = destination(config)
  const results: WarehouseSyncResult[] = []
  for (const c of chosen) {
    const startedAt = new Date().toISOString()
    let result: WarehouseSyncResult
    try {
      const source = findSource(c.slug)
      if (!source.config) throw new Error(`${source.name} has no connector in this version.`)
      const r = await runRunner(
        { action: 'sync', source: { slug: c.slug, config: source.config }, params: c.params, personal_data: c.personalData, destination: dest, dataset: datasetFor(c.slug), pipelines_dir: pipelinesDir(), verbose: opts.verbose },
        { ...secretEnv(source), ...destEnv },
        opts,
      )
      result = r.ok
        ? { source: c.slug, status: 'ok', rows: Number(r.rows ?? 0), tables: r.tables as Record<string, number> }
        : { source: c.slug, status: 'failed', rows: 0, detail: explain(r.error) }
    } catch (e) {
      result = { source: c.slug, status: 'failed', rows: 0, detail: e instanceof Error ? e.message : String(e) }
    }
    results.push(result)
    await opts.record?.(result, startedAt)
  }
  return results
}

// Local warehouses are DuckDB files, read through the runner. Postgres warehouses are read by the caller.
export async function duckSchema(slug?: string) {
  const r = await runRunner({ action: 'schema', destination: { kind: 'duckdb', path: warehouseDuckPath() }, dataset: slug ? datasetFor(slug) : undefined }, {})
  if (!r.ok) throw new CliError(r.error, 'lifecycle warehouse sync', 'query_failed')
  return r.columns as { schema: string; table: string; column: string; type: string }[]
}

export async function duckQuery(sql: string, limit = 1000) {
  const body = assertReadOnlySql(sql)
  const r = await runRunner({ action: 'query', sql: body, limit, destination: { kind: 'duckdb', path: warehouseDuckPath() } }, {})
  if (!r.ok) throw new CliError(r.error, 'lifecycle warehouse schema', 'query_failed')
  return { columns: r.columns as string[], rows: r.rows as Record<string, unknown>[] }
}
