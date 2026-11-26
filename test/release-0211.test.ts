import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 0.21.1: the first run, as the UX-99 audit walked it on a clean home. Each case runs the built CLI.

const cosmic = (home: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [join(process.cwd(), 'dist/cli.js'), ...args], {
    env: { ...process.env, LIFECYCLE_HOME: home, LIFECYCLE_NO_KEYCHAIN: '1', LIFECYCLE_NO_UPDATE_CHECK: '1', LIFECYCLE_WORKSPACE: '' },
    encoding: 'utf8',
    input: '',
  })
  return { out: r.stdout, err: r.stderr, code: r.status }
}
const fresh = () => mkdtempSync(join(tmpdir(), 'cosmic-0211-'))
const lastMonth = () => {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
}

describe('first run, from the UX-99 audit', () => {
  it('init with no type says it set up a store, how to change that, and points at Shopify, not Klaviyo', () => {
    const r = cosmic(fresh(), 'init')
    expect(r.out).toContain('Set up as a Shopify store, because no --type was given.')
    expect(r.out).toContain('Not a store? Run cosmic init --type ecommerce, saas, b2b, agency or creator.')
    expect(r.out).toContain('Next: cosmic connect shopify')
    expect(r.out).not.toContain('connect klaviyo')
  })

  it('init --type saas points at Stripe, its source of truth, and never at PostHog', () => {
    const r = cosmic(fresh(), 'init', '--type', 'saas')
    expect(r.out).toContain('Next: cosmic connect stripe')
    expect(r.out).not.toMatch(/posthog|klaviyo/i)
    expect(r.out).not.toContain('Set up as a Shopify store')
  })

  it('init JSON is unchanged', () => {
    const r = cosmic(fresh(), '--format', 'json', 'init', '--type', 'saas')
    expect(Object.keys(JSON.parse(r.out)).sort()).toEqual(['database', 'reference', 'type'])
  })

  it('reconcile on a new workspace prints one line and the next step, not a column of SKIPs', () => {
    const home = fresh()
    cosmic(home, 'init', '--type', 'saas')
    const r = cosmic(home, 'reconcile')
    expect(r.out).not.toContain('SKIP')
    expect(r.out).toBe('Nothing to check yet: no source has synced.\nNext: connect a source, then sync:\n  cosmic connect stripe --key-env STRIPE_READ_KEY\n  cosmic sync\n')
    // JSON still lists every check.
    const j = JSON.parse(cosmic(home, '--format', 'json', 'reconcile').out)
    expect(j.checks.length).toBeGreaterThan(0)
  })

  it('verdict with no --period uses the last finished month', () => {
    const home = fresh()
    cosmic(home, 'init', '--type', 'saas')
    const j = JSON.parse(cosmic(home, '--format', 'json', 'verdict').out)
    expect(j.period).toBe(lastMonth())
    const t = cosmic(home, 'verdict')
    expect(t.out).toContain(`Nothing to report for ${lastMonth()} yet: no source is connected.`)
    expect(t.out).toContain('cosmic connect stripe')
    expect(t.code).toBe(3)
  })

  it('verdict still refuses a bad --period', () => {
    const home = fresh()
    cosmic(home, 'init', '--type', 'saas')
    expect(cosmic(home, 'verdict', '--period', 'banana').code).toBe(1)
  })

  it('cosmic sources with no subcommand lists the sources', () => {
    const home = fresh()
    cosmic(home, 'init', '--type', 'saas')
    const r = cosmic(home, 'sources')
    expect(r.out).toMatch(/^not connected Stripe/)
    expect(r.out).not.toContain('Usage:')
  })

  it('--help says workspace token, never store token', () => {
    const r = cosmic(fresh(), '--help')
    expect(r.out).toContain('workspace token')
    expect(r.out).not.toMatch(/store token/)
    expect(r.out).toMatch(/^Usage: cosmic/)
  })
})
