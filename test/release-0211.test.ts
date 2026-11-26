import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

// Every case starts real CLI processes, which are slow when the full suite runs in parallel.
describe('first run, from the UX-99 audit', { timeout: 60_000 }, () => {
  it('init with no type says it set up a store, how to change that, and points at Shopify, not Klaviyo', () => {
    const r = cosmic(fresh(), 'init')
    expect(r.out).toContain('Ready. This workspace is set up as a Shopify store, the default.')
    expect(r.out).toContain('Not a store? Run cosmic init --type saas (or ecommerce, b2b, agency, creator).')
    expect(r.out).toContain('Or by hand: cosmic connect shopify')
    expect(r.out).not.toContain('Database: local')
    expect(r.out).not.toContain('connect klaviyo')
  })

  it('init --type saas points at Stripe, its source of truth, and never at PostHog', () => {
    const r = cosmic(fresh(), 'init', '--type', 'saas')
    expect(r.out).toContain('Or by hand: cosmic connect stripe')
    expect(r.out).not.toMatch(/posthog|klaviyo/i)
    expect(r.out).not.toContain('set up as a Shopify store')
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
    expect(t.out).toContain(`Nothing to report for ${lastMonth()} (the last finished month) yet: no source with monthly KPIs has synced.`)
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

  it('a mistyped sources command names the real ones (review finding)', () => {
    const r = cosmic(fresh(), 'sources', 'catlog')
    expect(r.code).toBe(1)
    expect(r.err).toContain('Unknown sources command: catlog.')
    expect(r.err).toContain('cosmic sources catalog')
  })

  it('a store lists Shopify first, matching init (review finding)', () => {
    const home = fresh()
    cosmic(home, 'init')
    expect(cosmic(home, 'sources').out).toMatch(/^not connected Shopify/)
  })

  it('an agency workspace with nothing synced gets the same block, and how to set its source of truth (review finding)', () => {
    const home = fresh()
    const i = cosmic(home, 'init', '--type', 'agency')
    expect(i.out).toContain('Source of truth: not set.')
    expect(i.out).not.toContain('Source of truth: nothing')
    const r = cosmic(home, 'reconcile')
    expect(r.out).not.toContain('SKIP')
    expect(r.out).toContain('Nothing to check yet')
    expect(r.out).toContain('cosmic config set workspace.reference stripe (or hubspot, shopify, ga4)')
  })

  it('once anything has synced, the source-of-truth warning is shown, never folded (review finding)', () => {
    const home = fresh()
    cosmic(home, 'init', '--type', 'creator')
    const csv = join(home, 'sponsors.csv')
    writeFileSync(csv, 'date,revenue\n2026-10-03,500\n')
    cosmic(home, 'sources', 'import', 'sponsors', '--csv', csv)
    const r = cosmic(home, 'reconcile')
    expect(r.out).toContain('SKIP reference: Not checked against a source of truth yet')
    expect(r.out).not.toContain('Nothing to check yet')
    // The verdict does not claim nothing is connected: a CSV source has no monthly KPIs.
    expect(cosmic(home, 'verdict').out).toContain('no source with monthly KPIs has synced')
  })

  it('b2b points at HubSpot', () => {
    expect(cosmic(fresh(), 'init', '--type', 'b2b').out).toContain('Or by hand: cosmic connect hubspot')
  })

  it('--help says workspace token, never store token', () => {
    const r = cosmic(fresh(), '--help')
    expect(r.out).toContain('workspace token')
    expect(r.out).not.toMatch(/store token/)
    expect(r.out).toMatch(/^Usage: cosmic/)
  })

  it('0.21.2: the demo ends with the step into setup, by its type', () => {
    for (const type of ['saas', 'b2b', 'shopify']) {
      const r = cosmic(fresh(), 'demo', '--type', type)
      expect(r.out).toContain(`Set it up on your own numbers:\n  cosmic init --type ${type}\n`)
      expect(r.out).not.toContain('Next: cosmic docs')
    }
    const home = fresh()
    cosmic(home, 'init', '--type', 'saas')
    expect(cosmic(home, 'demo').out.trimEnd().endsWith('Next, on your own numbers: cosmic verdict')).toBe(true)
  })
})
