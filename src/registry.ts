import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { z } from 'zod'
import { appHome } from './paths.js'
import { CliError } from './errors.js'
import { VERSION } from './version.js'

// Kits live in their own git repo, so a kit fix ships without a CLI release.
// The CLI clones it once, refreshes it in the background, and keeps working offline.
export const DEFAULT_REGISTRY = 'https://github.com/jbauman-26/cosmic-registry.git'
export const REFRESH_AFTER_MS = 10 * 60 * 1000
const GIT_TIMEOUT_MS = 20_000
const STAMP = '.lifecycle-fetched'

// A copy of the registry ships in the package for machines that have never been online.
export const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'registry-snapshot')

const Secret = z.object({ name: z.string().min(1), description: z.string().min(1), required: z.boolean().default(true) })
export const KitManifest = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  title: z.string().min(1),
  summary: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  needs: z.array(z.enum(['klaviyo', 'shopify', 'ga4'])),
  requires_cli: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  writes: z.string().min(1),
  secrets: z.array(Secret).default([]),
  files: z.array(z.string()).default([]),
})
export type KitManifest = z.infer<typeof KitManifest>

export type IndexEntry = { name: string; version: string; path: string; title: string; summary: string; keywords: string[]; needs: string[]; writes: string }
export type RegistrySource = 'local' | 'cache' | 'bundled'
export type Registry = { dir: string; uri: string; source: RegistrySource; warning?: string }

function readUserRegistryUri(): string | undefined {
  const p = join(appHome(), 'config.json')
  if (!existsSync(p)) return undefined
  try {
    return JSON.parse(readFileSync(p, 'utf8'))?.registry?.uri
  } catch {
    return undefined
  }
}

// Priority: --registry, then LIFECYCLE_REGISTRY, then config.json, then the public registry.
export function resolveRegistryUri(flag?: string) {
  return flag ?? process.env.LIFECYCLE_REGISTRY ?? readUserRegistryUri() ?? DEFAULT_REGISTRY
}

// git+file:///path/repo.git is cloned and cached like a remote. file:// and plain paths are read in place.
export function isLocalUri(uri: string) {
  if (uri.startsWith('git+')) return false
  if (uri.startsWith('file://')) return true
  if (/^(https?|git|ssh):\/\//.test(uri) || /^[\w.-]+@[\w.-]+:/.test(uri)) return false
  return true
}

const localPath = (uri: string) => (uri.startsWith('file://') ? fileURLToPath(uri) : isAbsolute(uri) ? uri : resolve(uri))
export const cacheDir = () => join(appHome(), 'registry')

function git(args: string[], cwd?: string) {
  // Never stop to ask for a password: a public registry needs none, and an agent cannot answer.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  const r = spawnSync('git', args, { cwd, env, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { ok: r.status === 0, error: r.error?.message ?? r.stderr?.trim() ?? '' }
}

function stamp(dir: string) {
  writeFileSync(join(dir, '.git', STAMP), new Date().toISOString())
}

function fetchedAt(dir: string) {
  const p = join(dir, '.git', STAMP)
  return existsSync(p) ? statSync(p).mtimeMs : 0
}

// What to do when a refresh fails but an older copy is on disk.
// Default: keep working from the cached copy and say how old it is.
// A stale kit is still a reviewed kit, and an offline laptop should not block an agent.
// Return a string to warn, or throw a CliError to block.
export function onRefreshFailure(ageMs: number, error: string): string {
  const minutes = Math.round(ageMs / 60000)
  const age = minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`
  return `Could not refresh kits (${error.split('\n')[0] || 'no network'}). Using the copy from ${age} ago.`
}

export function ensureRegistry(opts: { uri?: string; refresh?: boolean; now?: number } = {}): Registry {
  const uri = resolveRegistryUri(opts.uri)
  if (isLocalUri(uri)) {
    const dir = localPath(uri)
    if (!existsSync(join(dir, 'index.json'))) throw new CliError(`No index.json in ${dir}.`, 'Point --registry at a registry folder, or run lifecycle kits validate DIR --write-index', 'bad_registry')
    return { dir, uri, source: 'local' }
  }

  const dir = cacheDir()
  const now = opts.now ?? Date.now()
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dirname(dir), { recursive: true })
    const r = git(['clone', '--depth', '1', '--quiet', uri.replace(/^git\+/, ''), dir])
    if (r.ok) {
      stamp(dir)
      return { dir, uri, source: 'cache' }
    }
    rmSync(dir, { recursive: true, force: true })
    if (existsSync(join(SNAPSHOT_DIR, 'index.json'))) {
      return { dir: SNAPSHOT_DIR, uri, source: 'bundled', warning: `Could not download kits (${r.error.split('\n')[0] || 'no network'}). Using the copy that shipped with lifecycle ${VERSION}.` }
    }
    throw new CliError('Could not download kits, and no bundled copy was found.', 'Check your network, or set LIFECYCLE_REGISTRY to a local registry folder', 'registry_unavailable')
  }

  const age = now - fetchedAt(dir)
  if (!opts.refresh && age < REFRESH_AFTER_MS) return { dir, uri, source: 'cache' }
  const r = git(['pull', '--ff-only', '--quiet'], dir)
  if (r.ok) {
    stamp(dir)
    return { dir, uri, source: 'cache' }
  }
  return { dir, uri, source: 'cache', warning: onRefreshFailure(age, r.error) }
}

export function readManifest(kitDir: string): KitManifest {
  const p = join(kitDir, 'kit.yaml')
  if (!existsSync(p)) throw new CliError(`No kit.yaml in ${kitDir}.`, 'lifecycle kits validate', 'bad_kit')
  return KitManifest.parse(parse(readFileSync(p, 'utf8')))
}

export function readIndex(reg: Registry): IndexEntry[] {
  const raw = JSON.parse(readFileSync(join(reg.dir, 'index.json'), 'utf8'))
  return (raw.kits ?? []) as IndexEntry[]
}

export function listKits(reg: Registry) {
  return readIndex(reg).map(({ name, version, title, summary, needs, writes }) => ({ name, version, title, summary, needs, writes }))
}

export function searchKits(reg: Registry, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return readIndex(reg)
    .map((k) => {
      const hay = [k.name, k.title, k.summary, ...k.keywords].join(' ').toLowerCase()
      const hits = terms.filter((t) => hay.includes(t)).length
      return { kit: k, hits, nameHit: terms.some((t) => k.name.includes(t)) }
    })
    .filter((x) => x.hits === terms.length)
    .sort((a, b) => Number(b.nameHit) - Number(a.nameHit) || a.kit.name.localeCompare(b.kit.name))
    .map(({ kit: { name, version, title, summary } }) => ({ name, version, title, summary }))
}

function findKit(reg: Registry, name: string) {
  const entry = readIndex(reg).find((k) => k.name === name)
  if (!entry) throw new CliError(`No kit named ${name}.`, 'lifecycle kits list', 'unknown_kit')
  return { entry, dir: join(reg.dir, entry.path) }
}

export function showKit(reg: Registry, name: string) {
  const { dir } = findKit(reg, name)
  const manifest = readManifest(dir)
  const readme = readFileSync(join(dir, 'README.md'), 'utf8')
  return { manifest, readme, runbook: join(dir, 'AGENT.md') }
}

export function compareVersions(a: string, b: string) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

// Copies into the folder the user chose. Nothing lands in their skills folder.
export function addKit(reg: Registry, name: string, opts: { into?: string; force?: boolean; cliVersion?: string } = {}) {
  const into = opts.into ?? 'lifecycle-kits'
  const { dir } = findKit(reg, name)
  const manifest = readManifest(dir)
  const cli = opts.cliVersion ?? VERSION
  if (manifest.requires_cli && compareVersions(cli, manifest.requires_cli) < 0 && !opts.force) {
    throw new CliError(`${name} ${manifest.version} needs lifecycle ${manifest.requires_cli} or newer. This is ${cli}.`, 'Update lifecycle, or add --force to stage it anyway', 'cli_too_old')
  }
  const target = join(into, name)
  if (existsSync(target)) throw new CliError(`${target} already exists.`, 'Remove it first, or use another folder with --into.', 'exists')
  mkdirSync(into, { recursive: true })
  cpSync(dir, target, { recursive: true })
  const shared = join(reg.dir, 'shared')
  if (existsSync(shared)) cpSync(shared, join(into, 'shared'), { recursive: true })
  return {
    kit: name,
    version: manifest.version,
    path: target,
    runbook: join(target, 'AGENT.md'),
    secrets: manifest.secrets.filter((s) => s.required).map((s) => s.name),
    needs: manifest.needs,
    writes: manifest.writes,
  }
}

export type Problem = { kit?: string; problem: string }

// The same checks the registry's CI runs. Optionally rewrites index.json and the README catalog.
export function validateRegistry(dir: string, opts: { writeIndex?: boolean } = {}) {
  const problems: Problem[] = []
  const kitsRoot = join(dir, 'kits')
  if (!existsSync(kitsRoot)) return { ok: false, problems: [{ problem: 'No kits/ folder.' }], kits: [] as IndexEntry[] }

  const built: IndexEntry[] = []
  for (const name of readdirSync(kitsRoot).sort()) {
    const kitDir = join(kitsRoot, name)
    if (!statSync(kitDir).isDirectory()) continue
    let m: KitManifest
    try {
      m = readManifest(kitDir)
    } catch (e) {
      problems.push({ kit: name, problem: `kit.yaml is invalid: ${e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') : (e as Error).message}` })
      continue
    }
    if (m.name !== name) problems.push({ kit: name, problem: `kit.yaml name is ${m.name}, folder is ${name}.` })
    for (const f of ['AGENT.md', 'README.md']) if (!existsSync(join(kitDir, f))) problems.push({ kit: name, problem: `Missing ${f}.` })
    const agent = existsSync(join(kitDir, 'AGENT.md')) ? readFileSync(join(kitDir, 'AGENT.md'), 'utf8') : ''
    if (agent && !/^## Verify$/m.test(agent)) problems.push({ kit: name, problem: 'AGENT.md has no "## Verify" checklist.' })
    for (const f of m.files) if (!existsSync(join(kitDir, f))) problems.push({ kit: name, problem: `kit.yaml lists ${f}, which does not exist.` })
    // ../shared/ is relative to where addKit stages a kit, which is the registry's shared/ folder.
    for (const ref of agent.matchAll(/`((?:\.\.\/shared|files)\/[^`\s]+)`/g)) {
      const rel = ref[1]!
      const target = rel.startsWith('../shared/') ? join(dir, 'shared', rel.slice('../shared/'.length)) : join(kitDir, rel)
      if (!existsSync(target)) problems.push({ kit: name, problem: `AGENT.md points at ${rel}, which does not exist.` })
    }
    if (/[\u2013\u2014]/.test(agent + readFileSync(join(kitDir, 'kit.yaml'), 'utf8'))) problems.push({ kit: name, problem: 'Contains an em or en dash.' })
    built.push({ name: m.name, version: m.version, path: `kits/${name}`, title: m.title, summary: m.summary, keywords: m.keywords, needs: m.needs, writes: m.writes })
  }

  if (opts.writeIndex) {
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, kits: built }, null, 2) + '\n')
    writeCatalog(dir, built)
  } else {
    const indexPath = join(dir, 'index.json')
    if (!existsSync(indexPath)) problems.push({ problem: 'No index.json. Run with --write-index.' })
    else {
      const current = (JSON.parse(readFileSync(indexPath, 'utf8')).kits ?? []) as IndexEntry[]
      if (JSON.stringify(current) !== JSON.stringify(built)) problems.push({ problem: 'index.json is out of date with the kit folders. Run with --write-index.' })
    }
  }
  return { ok: problems.length === 0, problems, kits: built }
}

const CATALOG_START = '<!-- catalog:start -->'
const CATALOG_END = '<!-- catalog:end -->'

function writeCatalog(dir: string, kits: IndexEntry[]) {
  const p = join(dir, 'README.md')
  if (!existsSync(p)) return
  const readme = readFileSync(p, 'utf8')
  const a = readme.indexOf(CATALOG_START)
  const b = readme.indexOf(CATALOG_END)
  if (a < 0 || b < a) return
  const rows = kits.map((k) => `| [${k.title}](${k.path}/README.md) | ${k.summary} | ${k.needs.join(', ')} | ${k.writes} | [Runbook](${k.path}/AGENT.md) |`)
  const table = ['', '| Kit | What your agent does | Needs | Writes | Instructions |', '| --- | --- | --- | --- | --- |', ...rows, ''].join('\n')
  writeFileSync(p, readme.slice(0, a + CATALOG_START.length) + table + readme.slice(b))
}
