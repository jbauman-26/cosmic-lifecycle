import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { readConfig, writeConfig, type Config } from './config.js'
import { appHome } from './paths.js'
import { getSecret, getSourceSecret, setSourceSecret, deleteSourceSecret, sourceSecretEnv } from './secrets.js'
import { CliError } from './errors.js'
import { WAREHOUSE_CATALOG } from './warehouse-catalog.js'
import { assertReadOnlySql } from './query.js'
import type { Db } from './db.js'
import { PERSONAL_RULES, classifyColumn, scrubRows, EMAIL_PATTERN, PHONE_PATTERN, REMOVED, type FieldClass, type FreeTextMode } from './personal.js'
import { assertNoPersonalColumns, markCatalog } from './sql-guard.js'
import { datasetFor, isWarehouseSchema, sourceOfSchema } from './warehouse-names.js'

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
  // Exact key names this source's rows carry personal data under, beyond what the runner's key-name filter catches.
  stripFields?: string[]
}

const CustomSpec = z.object({
  name: z.string().min(1),
  category: z.string().default('custom'),
  docs: z.string().default(''),
  credentials: z.array(z.object({ name: z.string(), label: z.string().default(''), help: z.string().default('') })).default([]),
  params: z.array(z.object({ name: z.string(), label: z.string().default(''), example: z.string().default('') })).default([]),
  config: z.record(z.string(), z.unknown()),
  stripFields: z.array(z.string()).optional(),
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
  if (!SLUG.test(slug)) throw new CliError('Use a short name of lowercase letters, numbers and dashes.', 'cosmic warehouse add-api my-tool --spec spec.json', 'bad_value')
  if (WAREHOUSE_CATALOG.some((s) => s.slug === slug)) throw new CliError(`${slug} is already in the catalog.`, `cosmic warehouse connect ${slug}`, 'bad_value')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(specPath, 'utf8'))
  } catch {
    throw new CliError(`${specPath} is not readable JSON.`, 'cosmic docs warehouse', 'bad_value')
  }
  const parsed = CustomSpec.safeParse(raw)
  if (!parsed.success) throw new CliError(`The spec is missing fields: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`, 'cosmic docs warehouse', 'bad_value')
  const resources = (parsed.data.config as { resources?: unknown[] }).resources
  if (!Array.isArray(resources) || !resources.length) throw new CliError('The spec config needs at least one resource.', 'cosmic docs warehouse', 'bad_value')
  mkdirSync(customDir(), { recursive: true, mode: 0o700 })
  writeFileSync(join(customDir(), `${slug}.json`), JSON.stringify(parsed.data, null, 2) + '\n', { mode: 0o600 })
  return { added: slug, next: `cosmic warehouse connect ${slug}` }
}

export function allSources(): WarehouseSource[] {
  return [...WAREHOUSE_CATALOG, ...customSources()]
}

export function findSource(slug: string): WarehouseSource {
  const s = allSources().find((x) => x.slug === slug)
  if (!s) throw new CliError(`No warehouse source named ${slug}.`, 'cosmic sources catalog', 'unknown_source')
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

export { datasetFor }
export const warehouseDuckPath = () => join(appHome(), 'warehouse.duckdb')
const pipelinesDir = () => join(appHome(), 'dlt')

// warehouse.free_text: keep (the default) loads free text with email addresses and phone numbers
// replaced, drop leaves free text out. A value this version does not know reads as keep.
export function freeTextMode(config: Config = readConfig()): FreeTextMode {
  return config.warehouse?.free_text === 'drop' ? 'drop' : 'keep'
}

function runnerPath() {
  // dist/warehouse.js and src/warehouse.ts both sit one level below the package root.
  const here = dirname(fileURLToPath(import.meta.url))
  const path = join(here, '..', 'connectors', 'run.py')
  if (!existsSync(path)) throw new CliError('The connector runner is missing from this install.', 'Reinstall Cosmic Lifecycle.', 'broken_install')
  return path
}

// Which uv to run. LIFECYCLE_UV_PATH names a bundled binary (the Cosmic AI app and Cosmic Cloud
// ship one), so an owner never installs anything. uv downloads its own Python on first use.
// Without it, uv is looked up on PATH. This package never ships uv itself.
export function uvCommand(env: NodeJS.ProcessEnv = process.env): string {
  const bundled = env.LIFECYCLE_UV_PATH
  if (!bundled) return 'uv'
  if (!isAbsolute(bundled)) throw new CliError('LIFECYCLE_UV_PATH must be an absolute path to a uv binary.', 'Set it to the full path, or unset it to use uv from PATH.', 'missing_uv')
  if (!existsSync(bundled)) throw new CliError('LIFECYCLE_UV_PATH points at a file that does not exist.', 'Reinstall the app, or unset LIFECYCLE_UV_PATH to use uv from PATH.', 'missing_uv')
  return bundled
}

// LIFECYCLE_UV_CACHE_DIR keeps uv's downloads (Python and dlt) in a folder the caller owns.
export function uvEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return env.LIFECYCLE_UV_CACHE_DIR ? { UV_CACHE_DIR: env.LIFECYCLE_UV_CACHE_DIR } : {}
}

export function uvAvailable(env: NodeJS.ProcessEnv = process.env) {
  try {
    return spawnSync(uvCommand(env), ['--version'], { encoding: 'utf8' }).status === 0
  } catch {
    return false
  }
}

const MISSING_UV_NEXT = 'In the Cosmic AI app this is built in: update the app. From a terminal: curl -LsSf https://astral.sh/uv/install.sh | sh, or set LIFECYCLE_UV_PATH to a uv binary.'

type Destination = { kind: 'postgres'; url_env: string } | { kind: 'duckdb'; path: string }

function destination(config: Config): { dest: Destination; env: Record<string, string> } {
  if (config.database.kind === 'postgres') {
    const url = getSecret('database-url')
    if (!url) throw new CliError('No database URL saved.', 'Set LIFECYCLE_DATABASE_URL, or run cosmic init for the local database.', 'no_database')
    return { dest: { kind: 'postgres', url_env: 'LIFECYCLE_WAREHOUSE_URL' }, env: { LIFECYCLE_WAREHOUSE_URL: url } }
  }
  mkdirSync(appHome(), { recursive: true, mode: 0o700 })
  return { dest: { kind: 'duckdb', path: warehouseDuckPath() }, env: {} }
}

export type RunnerResult = { ok: true; [k: string]: unknown } | { ok: false; error: string }

// Starts the Python runner in its own uv environment. The job goes in on stdin and
// secrets go in as environment variables, so neither shows in the process list.
export function runRunner(job: Record<string, unknown>, env: Record<string, string>, opts: { verbose?: boolean } = {}): Promise<RunnerResult> {
  let uv: string
  try {
    uv = uvCommand()
  } catch (e) {
    return Promise.reject(e)
  }
  if (!uvAvailable()) {
    return Promise.reject(new CliError(process.env.LIFECYCLE_UV_PATH ? 'The uv binary at LIFECYCLE_UV_PATH did not run.' : 'Warehouse sources need uv, the Python runner, and it is not installed.', MISSING_UV_NEXT, 'missing_uv'))
  }
  const args = ['run', '--quiet', '--no-project', '--python', PYTHON_VERSION, '--with', `dlt[postgres,duckdb]==${DLT_VERSION}`, 'python', runnerPath()]
  return new Promise((resolve, reject) => {
    // LOAD__DELETE_COMPLETED_JOBS: dlt otherwise keeps a copy of every loaded row in its working folder.
    const child = spawn(uv, args, { env: { ...process.env, ...uvEnv(), ...env, RUNTIME__LOG_LEVEL: 'WARNING', LOAD__DELETE_COMPLETED_JOBS: 'true' }, stdio: ['pipe', 'pipe', opts.verbose ? 'inherit' : 'pipe'] })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (err += d))
    child.on('error', (e) => reject(new CliError(`Could not start uv: ${e.message}`, MISSING_UV_NEXT, 'missing_uv')))
    child.on('close', () => {
      const last = out.trim().split('\n').pop() ?? ''
      try {
        resolve(JSON.parse(last) as RunnerResult)
      } catch {
        reject(new CliError(`The connector runner stopped without a result. ${err.trim().split('\n').slice(-3).join(' ')}`.trim(), 'cosmic warehouse sync --verbose', 'runner_failed'))
      }
    })
    // A loader that dies before it reads the job breaks the pipe. Without a listener that error
    // would end this whole process. The close handler above reports the crash instead.
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(job))
  })
}

function secretEnv(source: WarehouseSource, fromEnv?: Record<string, string>) {
  const env: Record<string, string> = {}
  for (const c of source.credentials) {
    const value = fromEnv?.[c.name] ?? getSourceSecret(source.slug, c.name)
    if (!value) throw new CliError(`${source.name}: ${c.label || c.name} is missing.`, `cosmic warehouse connect ${source.slug} --secret ${c.name}=ENV_VAR_NAME`, 'missing_secret')
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
  if (source.readiness === 'native') throw new CliError(`${source.name} is a built-in source.`, `cosmic connect ${slug} --help`, 'bad_value')
  if (!source.config) {
    throw new CliError(`${source.name} has no connector yet.`, `Export daily totals to CSV, then cosmic sources import ${slug} --csv FILE. Or describe its API: cosmic docs warehouse`, 'not_built')
  }
  const config = readConfig()
  const secrets: Record<string, string> = {}
  for (const pair of opts.secret ?? []) {
    const m = KV.exec(pair)
    if (!m) throw new CliError(`Use --secret FIELD=ENV_VAR_NAME, not ${pair.split('=')[0]}=...`, `cosmic warehouse connect ${slug} --secret ${source.credentials[0]?.name ?? 'api_key'}=MY_KEY_VAR`, 'bad_value')
    if (!source.credentials.some((c) => c.name === m[1])) throw new CliError(`${source.name} has no credential called ${m[1]}.`, `cosmic warehouse show ${slug}`, 'bad_value')
    const value = process.env[m[2]!]
    if (!value) throw new CliError(`Environment variable ${m[2]} is empty.`, 'Export the key, then pass its variable name. Do not paste keys into a chat.', 'missing_secret')
    secrets[m[1]!] = value
  }
  const params: Record<string, string> = { ...(config.warehouse?.sources[slug]?.params ?? {}) }
  for (const pair of opts.set ?? []) {
    const m = KV.exec(pair)
    if (!m) throw new CliError(`Use --set NAME=VALUE.`, `cosmic warehouse show ${slug}`, 'bad_value')
    params[m[1]!] = m[2]!
  }
  const missingParams = source.params.filter((p) => !params[p.name])
  if (missingParams.length) {
    throw new CliError(`${source.name} needs ${missingParams.map((p) => p.name).join(', ')}.`, `cosmic warehouse connect ${slug} ${missingParams.map((p) => `--set ${p.name}=${p.example}`).join(' ')}`, 'bad_value')
  }
  const env = secretEnv(source, secrets)
  let check: Record<string, unknown> | null = null
  if (!opts.skipCheck) {
    const { dest, env: destEnv } = destination(config)
    const r = await runRunner({ action: 'check', source: { slug, config: source.config, strip_fields: source.stripFields ?? [] }, params, rules: PERSONAL_RULES, free_text: freeTextMode(config), destination: dest, dataset: datasetFor(slug), pipelines_dir: pipelinesDir() }, { ...env, ...destEnv })
    if (!r.ok) throw new CliError(`${source.name} check failed: ${explain(r.error)}`, `cosmic warehouse show ${slug}`, 'check_failed')
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
  writeConfig({ ...config, warehouse: { ...config.warehouse, sources } })
  return {
    connected: slug,
    personalData: opts.keepPersonalData ? 'kept (you chose --keep-personal-data)' : 'removed before anything is written',
    check: check ? { resource: check.resource, rows: check.rows } : 'skipped',
    readiness: source.readiness,
    keysSavedTo: envNotes.length ? `environment only: set ${envNotes.join(', ')} wherever syncs run` : 'keychain',
    next: `cosmic warehouse sync ${slug}`,
  }
}

export function disconnectSource(slug: string) {
  const config = readConfig()
  const source = allSources().find((s) => s.slug === slug)
  const sources = { ...(config.warehouse?.sources ?? {}) }
  if (!sources[slug]) throw new CliError(`${slug} is not connected.`, 'cosmic warehouse list', 'bad_value')
  delete sources[slug]
  writeConfig({ ...config, warehouse: { ...config.warehouse, sources } })
  const removed = (source?.credentials ?? []).map((c) => deleteSourceSecret(slug, c.name))
  return { disconnected: slug, keysRemoved: removed.filter(Boolean).length, note: `Data already loaded stays in ${datasetFor(slug)}. Drop it yourself if you no longer want it.` }
}

export function connectedSources(config: Config) {
  return Object.entries(config.warehouse?.sources ?? {}).map(([slug, s]) => ({ slug, ...s }))
}

// `code` is set when a failure has one: loader_failed when the loader process crashed, or the code of
// the error that stopped the source, such as missing_secret or missing_uv.
export type WarehouseSyncResult = { source: string; status: 'ok' | 'failed'; rows: number; tables?: Record<string, number>; detail?: string; code?: string }

// The loader runs in its own process. When that process dies without a result, the cause is in its
// log, which can hold anything, so the owner gets one plain sentence and the command to see the log.
export const loaderFailed = (name: string, slug: string) => `The loader for ${name} stopped before it finished, so this sync did not complete. Data loaded by earlier syncs is still there. To see why, run cosmic warehouse sync ${slug} --verbose.`

export async function syncSources(slugs: string[] | undefined, opts: { verbose?: boolean; record?: (r: WarehouseSyncResult, startedAt: string) => Promise<void> } = {}) {
  const config = readConfig()
  const connected = connectedSources(config)
  if (!connected.length) throw new CliError('No warehouse sources connected.', 'cosmic sources catalog', 'no_sources')
  const chosen = slugs?.length ? connected.filter((c) => slugs.includes(c.slug)) : connected
  const unknown = (slugs ?? []).filter((s) => !connected.some((c) => c.slug === s))
  if (unknown.length) throw new CliError(`Not connected: ${unknown.join(', ')}.`, 'cosmic warehouse list', 'bad_value')
  const { dest, env: destEnv } = destination(config)
  const results: WarehouseSyncResult[] = []
  for (const c of chosen) {
    const startedAt = new Date().toISOString()
    let result: WarehouseSyncResult
    try {
      const source = findSource(c.slug)
      if (!source.config) throw new Error(`${source.name} has no connector in this version.`)
      const r = await runRunner(
        { action: 'sync', source: { slug: c.slug, config: source.config, strip_fields: source.stripFields ?? [] }, params: c.params, personal_data: c.personalData, rules: PERSONAL_RULES, free_text: freeTextMode(config), destination: dest, dataset: datasetFor(c.slug), pipelines_dir: pipelinesDir(), verbose: opts.verbose },
        { ...secretEnv(source), ...destEnv },
        opts,
      )
      result = r.ok
        ? { source: c.slug, status: 'ok', rows: Number(r.rows ?? 0), tables: r.tables as Record<string, number> }
        : { source: c.slug, status: 'failed', rows: 0, detail: explain(r.error) }
    } catch (e) {
      const code = e instanceof CliError && e.code !== 'error' ? e.code : undefined
      result = code === 'runner_failed'
        ? { source: c.slug, status: 'failed', rows: 0, detail: loaderFailed(allSources().find((s) => s.slug === c.slug)?.name ?? c.slug, c.slug), code: 'loader_failed' }
        : { source: c.slug, status: 'failed', rows: 0, detail: e instanceof Error ? e.message : String(e), ...(code ? { code } : {}) }
    }
    results.push(result)
    await opts.record?.(result, startedAt)
  }
  return results
}

export type SchemaColumn = { schema: string; table: string; column: string; type: string; nullable?: boolean; personal: boolean; freeText: boolean }

/** Adds what the rule list says about each column: personal, free text, or neither. */
export function markColumns<T extends { schema: string; table: string; column: string; type: string }>(cols: T[]): (T & { personal: boolean; freeText: boolean; kind: FieldClass })[] {
  return cols.map((c) => {
    const kind = classifyColumn({ source: sourceOfSchema(c.schema), table: c.table, column: c.column, type: c.type })
    return { ...c, kind, personal: kind === 'personal', freeText: kind === 'free_text' }
  })
}

type RawColumn = { schema: string; table: string; column: string; type: string; nullable?: boolean }

// Local warehouses are DuckDB files, read through the runner. Postgres warehouses are read by the caller.
async function duckColumns(slug: string | undefined, everything: boolean): Promise<RawColumn[]> {
  const r = await runRunner({ action: 'schema', destination: { kind: 'duckdb', path: warehouseDuckPath() }, dataset: slug ? datasetFor(slug) : undefined, everything }, {})
  if (!r.ok) throw new CliError(r.error, 'cosmic warehouse sync', 'query_failed')
  return r.columns as RawColumn[]
}

export async function duckSchema(slug?: string): Promise<SchemaColumn[]> {
  return markColumns(await duckColumns(slug, false)).map(({ kind: _kind, ...c }) => c)
}

export async function duckQuery(sql: string, limit = 1000) {
  const body = assertReadOnlySql(sql)
  // The list of columns comes first. If it cannot be read, the query does not run.
  if (existsSync(warehouseDuckPath())) assertNoPersonalColumns(body, markCatalog(await duckColumns(undefined, true), sourceOfSchema))
  const r = await runRunner({ action: 'query', sql: body, limit, destination: { kind: 'duckdb', path: warehouseDuckPath() } }, {})
  if (!r.ok) throw new CliError(r.error, 'cosmic warehouse schema', 'query_failed')
  const clean = scrubRows(r.rows as Record<string, unknown>[])
  return { columns: r.columns as string[], rows: clean.rows, ...(clean.redacted ? { redacted: clean.redacted } : {}) }
}

// ---- warehouse scrub: empty the personal columns an older version stored ----

export type ScrubAction = 'null' | 'replace' | 'rewrite'
export type ScrubStep = { schema: string; table: string; column: string; action: ScrubAction | 'blocked'; why: 'personal' | 'free_text'; rows: number; status: 'planned' | 'done' | 'failed' | 'blocked' }
export type ScrubReport = {
  applied: boolean
  database: 'local' | 'postgres'
  freeText: FreeTextMode
  tables: { table: string; columns: { column: string; why: 'personal' | 'free_text'; action: ScrubStep['action']; rows: number; status: ScrubStep['status'] }[]; rows: number }[]
  totals: { tables: number; columns: number; values: number; blocked: number; failed: number }
  // Files of finished loads in the loader's working folder. Older versions kept a copy of every loaded row there.
  loaderFiles: LoaderFiles
  // Local only: true when the database file was rebuilt, so the old values are gone from its bytes too.
  rebuilt: boolean | null
  note: string
  next: string
}

const TEXT = /char|text|string/i

/**
 * What a scrub does to each column of the warehouse schemas (src_*, and dlt's _staging copies):
 *   personal column                         null it. One that may not be empty gets a placeholder unique to the row.
 *   free text column, warehouse.free_text drop   null it
 *   free text column, warehouse.free_text keep   replace email addresses and phone numbers inside it
 */
export function scrubPlan(cols: RawColumn[], mode: FreeTextMode): Omit<ScrubStep, 'rows' | 'status'>[] {
  const hasRowId = new Set(cols.filter((c) => c.column === '_dlt_id').map((c) => `${c.schema}.${c.table}`))
  const plan: Omit<ScrubStep, 'rows' | 'status'>[] = []
  for (const c of markColumns(cols.filter((x) => isWarehouseSchema(x.schema) && !x.table.startsWith('_dlt') && !x.column.startsWith('_dlt')))) {
    if (c.kind === 'keep') continue
    const base = { schema: c.schema, table: c.table, column: c.column, why: c.kind }
    const text = TEXT.test(c.type)
    if (c.kind === 'free_text' && mode === 'keep') {
      if (text) plan.push({ ...base, action: 'rewrite' })
      continue
    }
    if (c.nullable !== false) plan.push({ ...base, action: 'null' })
    else if (text && hasRowId.has(`${c.schema}.${c.table}`)) plan.push({ ...base, action: 'replace' })
    else plan.push({ ...base, action: 'blocked' })
  }
  return plan
}

const FINISHED_LOADS = ['load', 'loaded']
const UNFINISHED_LOADS = [['load', 'normalized'], ['load', 'new'], ['normalize', 'extracted']]

export type LoaderFiles = { files: number; removed: boolean; pending: number }

/**
 * The loader's working folder keeps load packages. Before 0.13.2 each finished one held a copy of every
 * row it loaded, so a name stored then is still there. Finished packages are history only: removing them
 * changes no table. Returns how many files they hold, and removes them when `apply` is set.
 * A load that did not finish is left alone, because removing it could lose rows: it is counted in
 * `pending`, and the next sync loads it.
 */
export function loaderLeftovers(apply: boolean, dir = pipelinesDir()): LoaderFiles {
  let files = 0
  const count = (path: string) => {
    for (const name of readdirSync(path)) {
      const p = join(path, name)
      if (statSync(p).isDirectory()) count(p)
      else files++
    }
  }
  const packagesIn = (base: string) => (existsSync(base) && statSync(base).isDirectory() ? readdirSync(base).map((n) => join(base, n)).filter((p) => statSync(p).isDirectory()) : [])
  if (!existsSync(dir)) return { files: 0, removed: false, pending: 0 }
  const finished: string[] = []
  let pending = 0
  for (const pipeline of readdirSync(dir)) {
    finished.push(...packagesIn(join(dir, pipeline, ...FINISHED_LOADS)))
    for (const parts of UNFINISHED_LOADS) pending += packagesIn(join(dir, pipeline, ...parts)).length
  }
  for (const p of finished) count(p)
  if (apply) for (const p of finished) rmSync(p, { recursive: true, force: true })
  return { files, removed: apply && finished.length > 0, pending }
}

function scrubReport(steps: ScrubStep[], applied: boolean, database: 'local' | 'postgres', mode: FreeTextMode, extra: { loaderFiles: LoaderFiles; rebuilt: boolean | null }): ScrubReport {
  const byTable = new Map<string, ScrubStep[]>()
  for (const s of steps) byTable.set(`${s.schema}.${s.table}`, [...(byTable.get(`${s.schema}.${s.table}`) ?? []), s])
  const tables = [...byTable].map(([table, list]) => ({ table, columns: list.map((s) => ({ column: s.column, why: s.why, action: s.action, rows: s.rows, status: s.status })), rows: list.reduce((n, s) => n + s.rows, 0) }))
  const blocked = steps.filter((s) => s.status === 'blocked').length
  const failed = steps.filter((s) => s.status === 'failed').length
  const values = steps.reduce((n, s) => n + s.rows, 0)
  const files = extra.loaderFiles.files
  return {
    applied,
    database,
    freeText: mode,
    tables,
    totals: { tables: tables.length, columns: steps.length, values, blocked, failed },
    loaderFiles: extra.loaderFiles,
    rebuilt: extra.rebuilt,
    note: [
      applied ? `Emptied or rewrote ${values} stored values.` : `Dry run: nothing was changed. ${values} stored values would be emptied or rewritten.`,
      files ? (applied ? `Removed ${files} file(s) of finished loads from the loader's folder, where copies of loaded rows were kept.` : `${files} file(s) of finished loads are in the loader's folder, where copies of loaded rows were kept. They would be removed.`) : '',
      extra.loaderFiles.pending ? `${extra.loaderFiles.pending} load(s) did not finish and still hold rows in the loader's folder. Run cosmic warehouse sync to finish them, then scrub again.` : '',
      blocked ? `${blocked} column(s) may not be empty and have no row id to stand in, so they were left alone.` : '',
      applied && extra.rebuilt === true ? 'The database file was rebuilt, so the old values are gone from the file as well.' : '',
      applied && extra.rebuilt === false ? 'Queries no longer return the old values, but the database file could not be rebuilt and can still hold old bytes.' : '',
      applied && database === 'postgres' && values ? 'Queries no longer return the old values. Postgres keeps old row versions until it vacuums the table.' : '',
    ].filter(Boolean).join(' '),
    next: applied ? (blocked || failed ? 'For a column that could not be emptied: cosmic warehouse disconnect SLUG, then drop its schema.' : 'cosmic warehouse schema --format json') : 'cosmic warehouse scrub --confirm',
  }
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`

/** Nulls stored personal columns. Counts rows per column, never reads a value into the report. */
export async function scrubWarehouse(opts: { confirm?: boolean; db?: Db | null } = {}): Promise<ScrubReport> {
  const config = readConfig()
  const mode = freeTextMode(config)
  const apply = Boolean(opts.confirm)
  if (config.database.kind === 'local') {
    if (!existsSync(warehouseDuckPath())) return scrubReport([], apply, 'local', mode, { loaderFiles: loaderLeftovers(apply), rebuilt: null })
    const plan = scrubPlan(await duckColumns(undefined, true), mode)
    const todo = plan.filter((p) => p.action !== 'blocked')
    const r = await runRunner({ action: 'scrub', plan: todo, apply, destination: { kind: 'duckdb', path: warehouseDuckPath() } }, {})
    if (!r.ok) throw new CliError(r.error, 'cosmic warehouse schema', 'scrub_failed')
    const done = r.steps as ScrubStep[]
    return scrubReport([...done, ...plan.filter((p) => p.action === 'blocked').map((p) => ({ ...p, rows: 0, status: 'blocked' as const }))], apply, 'local', mode, { loaderFiles: loaderLeftovers(apply), rebuilt: typeof r.rebuilt === 'boolean' ? r.rebuilt : null })
  }
  const db = opts.db
  if (!db) throw new CliError('The database could not be opened.', 'cosmic doctor', 'no_database')
  const rows = await db.query(`SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema LIKE 'src\\_%' ORDER BY 1, 2, ordinal_position`)
  const plan = scrubPlan(rows.map((r) => ({ schema: String(r.table_schema), table: String(r.table_name), column: String(r.column_name), type: String(r.data_type), nullable: String(r.is_nullable) !== 'NO' })), mode)
  const steps: ScrubStep[] = []
  const rewrite = (col: string) => `regexp_replace(regexp_replace(${col}::text, '${EMAIL_PATTERN}', '${REMOVED}', 'g'), '${PHONE_PATTERN}', '${REMOVED}', 'g')`
  for (const p of plan) {
    if (p.action === 'blocked') {
      steps.push({ ...p, rows: 0, status: 'blocked' })
      continue
    }
    const target = `${q(p.schema)}.${q(p.table)}`
    const col = q(p.column)
    const cond = p.action === 'rewrite' ? `${col} IS NOT NULL AND ${rewrite(col)} IS DISTINCT FROM ${col}::text` : p.action === 'replace' ? `${col} IS NOT NULL AND ${col}::text NOT LIKE 'removed-%'` : `${col} IS NOT NULL`
    const set = p.action === 'rewrite' ? rewrite(col) : p.action === 'replace' ? `'removed-' || "_dlt_id"` : 'NULL'
    try {
      const n = Number((await db.query(`SELECT count(*) AS n FROM ${target} WHERE ${cond}`))[0]?.n ?? 0)
      if (apply && n) await db.query(`UPDATE ${target} SET ${col} = ${set} WHERE ${cond}`)
      steps.push({ ...p, rows: n, status: apply ? 'done' : 'planned' })
    } catch {
      steps.push({ ...p, rows: 0, status: 'failed' })
    }
  }
  return scrubReport(steps, apply, 'postgres', mode, { loaderFiles: loaderLeftovers(apply), rebuilt: null })
}
