import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { envName, keepRotated } from '../src/secrets.js'
import { writeConfig } from '../src/config.js'

// LIFECYCLE_ROTATED_FILE hands a rotated sign-in back to a host that keeps keys in the environment
// only (Cosmic Cloud). These tests run without a keychain, as Cloud does, unless a test says otherwise.
const NEW_PIN = 'pinr_rotated_5f0c1e'
const NEW_MS = 'M.R3_rotated_9a7b2d'

let dir: string
let file: string
const saved = { platform: process.platform }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lc-rotated-'))
  file = join(dir, 'rotated.json')
  process.env.LIFECYCLE_NO_KEYCHAIN = '1'
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const k of ['LIFECYCLE_NO_KEYCHAIN', 'LIFECYCLE_ROTATED_FILE', envName('pinterest-ads-refresh-token')]) delete process.env[k]
  Object.defineProperty(process, 'platform', { value: saved.platform })
  vi.restoreAllMocks()
})

const read = () => JSON.parse(readFileSync(file, 'utf8'))
const mode = () => statSync(file).mode & 0o777

describe('keepRotated without a keychain', () => {
  it('writes the new value to LIFECYCLE_ROTATED_FILE with mode 0600, merged with what is there', () => {
    process.env.LIFECYCLE_ROTATED_FILE = file
    writeFileSync(file, JSON.stringify({ 'microsoft-ads-refresh-token': 'kept' }), { mode: 0o644 })
    const save = vi.fn()
    expect(keepRotated('pinterest-ads-refresh-token', NEW_PIN, 'pinr_old', save)).toBe(true)
    expect(read()).toEqual({ 'microsoft-ads-refresh-token': 'kept', 'pinterest-ads-refresh-token': NEW_PIN })
    expect(mode()).toBe(0o600)
    expect(keepRotated('pinterest-ads-refresh-token', 'pinr_newer', NEW_PIN, save)).toBe(true)
    expect(read()).toEqual({ 'microsoft-ads-refresh-token': 'kept', 'pinterest-ads-refresh-token': 'pinr_newer' })
    expect(save).not.toHaveBeenCalled()
    // Written through a temporary file and a rename: nothing else is left in the folder.
    expect(readdirSync(dir)).toEqual(['rotated.json'])
  })

  it('creates the file when there is none, for any secret name', () => {
    process.env.LIFECYCLE_ROTATED_FILE = file
    expect(keepRotated('google-ads-refresh-token', 'g_new', 'g_old')).toBe(true)
    expect(read()).toEqual({ 'google-ads-refresh-token': 'g_new' })
    expect(mode()).toBe(0o600)
  })

  it('writes even when the old value came from the environment, which is how Cloud passes it', () => {
    process.env.LIFECYCLE_ROTATED_FILE = file
    process.env[envName('pinterest-ads-refresh-token')] = 'pinr_old'
    expect(keepRotated('pinterest-ads-refresh-token', NEW_PIN, 'pinr_old')).toBe(true)
    expect(read()).toEqual({ 'pinterest-ads-refresh-token': NEW_PIN })
  })

  it('writes nothing when the value did not change or there is none', () => {
    process.env.LIFECYCLE_ROTATED_FILE = file
    expect(keepRotated('pinterest-ads-refresh-token', 'pinr_same', 'pinr_same')).toBe(false)
    expect(keepRotated('pinterest-ads-refresh-token', null, 'pinr_same')).toBe(false)
    expect(keepRotated('pinterest-ads-refresh-token', undefined, 'pinr_same')).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  it('writes nothing when LIFECYCLE_ROTATED_FILE is not set', () => {
    expect(keepRotated('pinterest-ads-refresh-token', NEW_PIN, 'pinr_old')).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('replaces a file it cannot read as JSON', () => {
    process.env.LIFECYCLE_ROTATED_FILE = file
    writeFileSync(file, 'not json')
    expect(keepRotated('pinterest-ads-refresh-token', NEW_PIN, 'pinr_old')).toBe(true)
    expect(read()).toEqual({ 'pinterest-ads-refresh-token': NEW_PIN })
  })

  it('never prints the value, even when the file cannot be written', () => {
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (out.push(String(c)), true))
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => (out.push(String(c)), true))
    for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.join(' ')))
    process.env.LIFECYCLE_ROTATED_FILE = file
    expect(keepRotated('pinterest-ads-refresh-token', NEW_PIN, 'pinr_old')).toBe(true)
    process.env.LIFECYCLE_ROTATED_FILE = join(dir, 'missing-folder', 'rotated.json')
    expect(keepRotated('microsoft-ads-refresh-token', NEW_MS, 'old')).toBe(false)
    expect(out.join('')).toMatch(/Could not write the new microsoft-ads-refresh-token to LIFECYCLE_ROTATED_FILE/)
    expect(out.join('')).not.toContain(NEW_PIN)
    expect(out.join('')).not.toContain(NEW_MS)
  })
})

describe('keepRotated with a keychain', () => {
  it('saves to the keychain as before and leaves the file alone', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    delete process.env.LIFECYCLE_NO_KEYCHAIN
    process.env.LIFECYCLE_ROTATED_FILE = file
    const save = vi.fn()
    expect(keepRotated('pinterest-ads-refresh-token', NEW_PIN, 'pinr_old', save)).toBe(true)
    expect(save).toHaveBeenCalledWith('pinterest-ads-refresh-token', NEW_PIN)
    // An old value from the environment is still left to whoever set it.
    process.env[envName('pinterest-ads-refresh-token')] = 'pinr_old'
    expect(keepRotated('pinterest-ads-refresh-token', 'pinr_newer', 'pinr_old', save)).toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
    expect(existsSync(file)).toBe(false)
  })
})

// A real `lifecycle sync` with keys only in the environment. A preloaded fetch answers each token
// request with a new refresh token; the run must hand it back through the file and never print it.
describe('sync hands rotated tokens back', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lc-rotated-home-'))
    process.env.LIFECYCLE_HOME = home
    writeConfig({
      database: { kind: 'local' },
      'pinterest-ads': { account: '549755885175', clientId: 'pin-app', name: 'Pins', currency: 'USD', timezone: 'America/Los_Angeles' },
      'microsoft-ads': { account: '187654321', customer: '251234567', clientId: 'ms-app', name: 'Bing', currency: 'USD', timezone: 'PacificTimeUSCanadaTijuana' },
    })
    delete process.env.LIFECYCLE_HOME
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const sync = (only: string) =>
    new Promise<{ status: number | null; out: string; json: () => any }>((done) => {
      const child = spawn(process.execPath, [resolve('node_modules', 'tsx', 'dist', 'cli.mjs'), resolve('src', 'cli.ts'), '--format', 'json', 'sync', '--only', only], {
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${pathToFileURL(resolve('test', 'fixtures', 'fake-rotating-fetch.mjs')).href}`,
          LIFECYCLE_HOME: home, HOME: home, LIFECYCLE_NO_KEYCHAIN: '1', LIFECYCLE_NO_UPDATE_CHECK: '1',
          LIFECYCLE_ROTATED_FILE: file,
          LIFECYCLE_PINTEREST_ADS_CLIENT_SECRET: 'pin-secret', LIFECYCLE_PINTEREST_ADS_REFRESH_TOKEN: 'pinr_old',
          LIFECYCLE_MICROSOFT_ADS_CLIENT_SECRET: 'ms-secret', LIFECYCLE_MICROSOFT_ADS_REFRESH_TOKEN: 'M.R3_old', LIFECYCLE_MICROSOFT_ADS_DEVELOPER_TOKEN: 'dev-token',
          FAKE_PINTEREST_ROTATED: NEW_PIN, FAKE_MICROSOFT_ROTATED: NEW_MS,
        },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (status) => done({ status, out: stdout + stderr, json: () => JSON.parse(stdout) }))
    })

  it('Pinterest sync writes the new refresh token to the file', async () => {
    const r = await sync('pinterest-ads')
    expect(r.out).not.toContain(NEW_PIN)
    expect(r.json().results).toEqual([expect.objectContaining({ source: 'pinterest-ads', status: 'warning' })])
    expect(read()).toEqual({ 'pinterest-ads-refresh-token': NEW_PIN })
    expect(mode()).toBe(0o600)
  }, 60000)

  it('Microsoft sync writes the new refresh token to the same file, keeping Pinterest', async () => {
    writeFileSync(file, JSON.stringify({ 'pinterest-ads-refresh-token': NEW_PIN }), { mode: 0o600 })
    const r = await sync('microsoft-ads')
    expect(r.out).not.toContain(NEW_MS)
    expect(r.out).not.toContain(NEW_PIN)
    expect(read()).toEqual({ 'pinterest-ads-refresh-token': NEW_PIN, 'microsoft-ads-refresh-token': NEW_MS })
    expect(mode()).toBe(0o600)
  }, 60000)
})
