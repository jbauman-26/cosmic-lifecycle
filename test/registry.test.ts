import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  addKit, compareVersions, DEFAULT_REGISTRY, ensureRegistry, listKits, REFRESH_AFTER_MS, resolveRegistryUri,
  searchKits, showKit, SNAPSHOT_DIR, validateRegistry,
} from '../src/registry.js'

const SNAPSHOT = resolve('registry-snapshot')
let tmp: string
let home: string

// A writable copy of the shipped registry for each test.
const copyRegistry = () => {
  const dir = join(tmp, 'reg')
  cpSync(SNAPSHOT, dir, { recursive: true })
  return dir
}

const bareRepo = (from: string) => {
  const work = join(tmp, 'work')
  cpSync(from, work, { recursive: true })
  const g = (...a: string[]) => execFileSync('git', a, { cwd: work, stdio: 'ignore' })
  g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'kits')
  const bare = join(tmp, 'reg.git')
  execFileSync('git', ['clone', '-q', '--bare', work, bare])
  return bare
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lc-reg-'))
  home = join(tmp, 'home')
  process.env.LIFECYCLE_HOME = home
  delete process.env.LIFECYCLE_REGISTRY
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.LIFECYCLE_HOME
  delete process.env.LIFECYCLE_REGISTRY
})

describe('where kits come from', () => {
  it('uses the flag, then the env var, then config, then the public registry', () => {
    expect(resolveRegistryUri()).toBe(DEFAULT_REGISTRY)
    cpSync(SNAPSHOT, join(home, 'unused'), { recursive: true })
    writeFileSync(join(home, 'config.json'), JSON.stringify({ database: { kind: 'local' }, registry: { uri: '/from/config' } }))
    expect(resolveRegistryUri()).toBe('/from/config')
    process.env.LIFECYCLE_REGISTRY = '/from/env'
    expect(resolveRegistryUri()).toBe('/from/env')
    expect(resolveRegistryUri('/from/flag')).toBe('/from/flag')
  })

  it('reads a local folder in place', () => {
    const reg = ensureRegistry({ uri: SNAPSHOT })
    expect(reg).toMatchObject({ dir: SNAPSHOT, source: 'local' })
    expect(listKits(reg).map((k) => k.name)).toEqual(['flow-audit', 'revenue-per-flow', 'winback-segment'])
  })

  it('refuses a folder with no index.json', () => {
    expect(() => ensureRegistry({ uri: tmp })).toThrow(/No index.json/)
  })

  it('clones a git registry once, then waits 10 minutes before refreshing', () => {
    const uri = `git+file://${bareRepo(SNAPSHOT)}`
    const first = ensureRegistry({ uri })
    expect(first.source).toBe('cache')
    expect(existsSync(join(home, 'registry', 'index.json'))).toBe(true)
    expect(ensureRegistry({ uri }).warning).toBeUndefined()
  })

  it('keeps working from the cache when a refresh fails', () => {
    const bare = bareRepo(SNAPSHOT)
    const uri = `git+file://${bare}`
    ensureRegistry({ uri })
    rmSync(bare, { recursive: true, force: true })
    const later = ensureRegistry({ uri, now: Date.now() + REFRESH_AFTER_MS + 60_000 })
    expect(later.source).toBe('cache')
    expect(later.warning).toMatch(/Using the copy from/)
    expect(listKits(later)).toHaveLength(3)
  })

  it('falls back to the bundled copy when it has never downloaded', () => {
    const reg = ensureRegistry({ uri: `git+file://${join(tmp, 'missing.git')}` })
    expect(reg.source).toBe('bundled')
    expect(reg.dir).toBe(SNAPSHOT_DIR)
    expect(reg.warning).toMatch(/shipped with lifecycle/)
  })
})

describe('finding and staging kits', () => {
  it('searches names, titles, summaries and keywords', () => {
    const reg = ensureRegistry({ uri: SNAPSHOT })
    expect(searchKits(reg, 'win back').map((k) => k.name)).toEqual(['winback-segment'])
    expect(searchKits(reg, 'klaviyo').length).toBe(3)
    expect(searchKits(reg, 'tiktok')).toEqual([])
  })

  it('shows the manifest and README', () => {
    const r = showKit(ensureRegistry({ uri: SNAPSHOT }), 'winback-segment')
    expect(r.manifest.secrets.map((s) => s.name)).toContain('KLAVIYO_SEGMENTS_KEY')
    expect(r.readme).toMatch(/never sends/i)
  })

  it('stages the kit with the shared editing standard and lists its secrets', () => {
    const into = join(tmp, 'project', 'lifecycle-kits')
    const r = addKit(ensureRegistry({ uri: SNAPSHOT }), 'flow-audit', { into })
    expect(r.secrets).toEqual(['KLAVIYO_READ_KEY'])
    expect(existsSync(join(into, 'flow-audit', 'AGENT.md'))).toBe(true)
    expect(existsSync(join(into, 'flow-audit', 'files', 'findings-summary.md'))).toBe(true)
    expect(existsSync(join(into, 'shared', 'editing-standard.md'))).toBe(true)
    expect(() => addKit(ensureRegistry({ uri: SNAPSHOT }), 'flow-audit', { into })).toThrow(/already exists/)
  })

  it('refuses a kit that needs a newer CLI unless forced', () => {
    const dir = copyRegistry()
    const p = join(dir, 'kits', 'flow-audit', 'kit.yaml')
    writeFileSync(p, readFileSync(p, 'utf8').replace('requires_cli: 0.1.1', 'requires_cli: 9.0.0'))
    const reg = ensureRegistry({ uri: dir })
    expect(() => addKit(reg, 'flow-audit', { into: join(tmp, 'a'), cliVersion: '0.2.0' })).toThrow(/needs lifecycle 9.0.0/)
    expect(addKit(reg, 'flow-audit', { into: join(tmp, 'b'), cliVersion: '0.2.0', force: true }).kit).toBe('flow-audit')
  })

  it('names an unknown kit', () => {
    expect(() => addKit(ensureRegistry({ uri: SNAPSHOT }), 'nope')).toThrow(/No kit named nope/)
  })

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.1.1', '0.2.0')).toBe(-1)
  })
})

describe('validate', () => {
  it('passes the shipped registry', () => {
    expect(validateRegistry(SNAPSHOT)).toMatchObject({ ok: true })
  })

  it('catches a missing Verify list, a broken file reference, a dash and a stale index', () => {
    const dir = copyRegistry()
    const agent = join(dir, 'kits', 'flow-audit', 'AGENT.md')
    writeFileSync(agent, readFileSync(agent, 'utf8').replace('## Verify', '## Done') + '\nSee `files/missing.md` — here.\n')
    const yaml = join(dir, 'kits', 'revenue-per-flow', 'kit.yaml')
    writeFileSync(yaml, readFileSync(yaml, 'utf8').replace('version: 1.0.0', 'version: 1.1.0'))
    const problems = validateRegistry(dir).problems.map((p) => p.problem).join('\n')
    expect(problems).toMatch(/no "## Verify"/)
    expect(problems).toMatch(/files\/missing.md/)
    expect(problems).toMatch(/em or en dash/)
    expect(problems).toMatch(/index.json is out of date/)
  })

  it('rebuilds index.json from the kit folders', () => {
    const dir = copyRegistry()
    rmSync(join(dir, 'index.json'))
    expect(validateRegistry(dir).ok).toBe(false)
    expect(validateRegistry(dir, { writeIndex: true }).ok).toBe(true)
    expect(validateRegistry(dir).ok).toBe(true)
  })

  it('reports an invalid manifest by field', () => {
    const dir = copyRegistry()
    writeFileSync(join(dir, 'kits', 'flow-audit', 'kit.yaml'), 'name: flow-audit\nversion: one\n')
    expect(validateRegistry(dir).problems[0]!.problem).toMatch(/version/)
  })
})
