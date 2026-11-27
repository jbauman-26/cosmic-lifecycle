import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// --prefix stands in for a user-owned Node install, so this never writes the machine prefix.
const cleanEnv = (home: string, cache: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  HOME: home,
  USER: process.env.USER ?? 'user',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  npm_config_cache: cache,
  npm_config_update_notifier: 'false',
})

// The sentence README.md shows for the store demo, with a straight apostrophe.
const CHECKED = "FAIL Orders pulled against Shopify's own count: 787 against 801, off by 1.75%. Do not trust reports built on this until it is fixed."
const BANNED = /[–—!]|\b(?:beta|pilot|experimental|crew)\b|[^\n\r\t\x20-\x7E]/i

describe('first 10 minutes on a clean machine', { timeout: 180_000 }, () => {
  it('installs the packed tarball into a fresh home and prints one checked number', () => {
    const root = mkdtempSync(join(tmpdir(), 'cosmic-first10-'))
    const home = join(root, 'home')
    const work = join(root, 'work')
    const prefix = join(root, 'prefix')
    mkdirSync(home)
    mkdirSync(work)
    mkdirSync(prefix)
    const cache = spawnSync('npm', ['config', 'get', 'cache'], { encoding: 'utf8' })
    expect(cache.status, cache.stderr).toBe(0)
    const pack = spawnSync('npm', ['pack', '--pack-destination', root], { cwd: process.cwd(), encoding: 'utf8' })
    expect(pack.status, pack.stderr).toBe(0)
    const tgz = readdirSync(root).find((name) => name.endsWith('.tgz'))
    expect(tgz).toBeTruthy()
    const install = spawnSync('npm', ['install', '-g', '--prefix', prefix, join(root, tgz ?? '')], {
      cwd: work,
      encoding: 'utf8',
      env: cleanEnv(home, cache.stdout.trim()),
    })
    expect(install.status, install.stderr).toBe(0)
    const demo = spawnSync(join(prefix, 'bin', 'cosmic'), ['demo'], {
      cwd: work,
      encoding: 'utf8',
      env: cleanEnv(home, cache.stdout.trim()),
    })
    expect(demo.status, demo.stderr).toBe(0)
    expect(demo.stderr).toBe('')
    expect(demo.stdout).toContain(CHECKED)
    expect(`${demo.stdout}${demo.stderr}`).not.toMatch(BANNED)
  })
})
