import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { getSetting, listSettings, readConfig, readRawConfig, setSetting, unsetSetting, writeConfig } from '../src/config.js'
import { secretStatus } from '../src/secrets.js'
import { normalizeSql, recordCustomQuery } from '../src/query.js'
import { metricCandidates } from '../src/metrics.js'
import { buildDashboard, dashboardHtml } from '../src/dashboard.js'
import { checkForUpdate } from '../src/update.js'
import { successStreak, writeProject } from '../src/deploy.js'

let home: string
let db: Db

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'lc-plat-'))
  process.env.LIFECYCLE_HOME = home
  process.env.LIFECYCLE_NO_KEYCHAIN = '1'
  delete process.env.LIFECYCLE_NO_UPDATE_CHECK
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(async () => {
  await db.close()
  rmSync(home, { recursive: true, force: true })
  delete process.env.LIFECYCLE_HOME
  delete process.env.LIFECYCLE_NO_KEYCHAIN
  delete process.env.LIFECYCLE_KLAVIYO_READ_KEY
})

describe('config', () => {
  it('sets, reads and removes settings, and validates values', () => {
    expect(setSetting('deploy.repo', 'me/lifecycle-sync')).toBe('me/lifecycle-sync')
    expect(getSetting('deploy.repo')).toBe('me/lifecycle-sync')
    expect(setSetting('update.check', 'false')).toBe(false)
    expect(() => setSetting('deploy.repo', 'not a repo')).toThrow(/OWNER\/NAME/)
    expect(() => setSetting('update.check', 'maybe')).toThrow(/true or false/)
    expect(() => setSetting('database.kind', 'local')).toThrow(/Unknown setting/)
    unsetSetting('deploy.repo')
    expect(getSetting('deploy.repo')).toBeUndefined()
    expect(listSettings().map((s) => s.key)).toEqual(['registry.uri', 'deploy.repo', 'update.check'])
  })

  it('keeps settings when connect rewrites the config', () => {
    setSetting('registry.uri', '/my/fork')
    writeConfig({ database: { kind: 'local' } })
    writeConfig({ ...readConfig(), klaviyo: { connected: true } })
    expect(readRawConfig()).toMatchObject({ registry: { uri: '/my/fork' }, klaviyo: { connected: true } })
  })

  it('says not set up when only settings exist', () => {
    setSetting('update.check', 'true')
    expect(() => readConfig()).toThrow(/Not set up/)
  })
})

describe('secrets', () => {
  it('reports where each key comes from without its value', () => {
    process.env.LIFECYCLE_KLAVIYO_READ_KEY = 'pk_supersecret'
    const s = secretStatus()
    expect(s.find((x) => x.name === 'klaviyo-read-key')).toMatchObject({ source: 'env', env: 'LIFECYCLE_KLAVIYO_READ_KEY' })
    expect(s.find((x) => x.name === 'shopify-client-secret')!.source).toBe('missing')
    expect(JSON.stringify(s)).not.toContain('pk_supersecret')
  })
})

describe('metric candidates', () => {
  it('counts the same custom query once however it is spaced', async () => {
    await recordCustomQuery(db, 'SELECT sum(orders) FROM fact_orders_daily;')
    await recordCustomQuery(db, 'select   SUM(orders)\n from fact_orders_daily')
    await recordCustomQuery(db, 'SELECT 1')
    const c = await metricCandidates(db)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ runs: 2, sql: normalizeSql('SELECT sum(orders) FROM fact_orders_daily') })
  })
})

describe('custom query log on an older database', () => {
  it('creates its table when missing, and never throws', async () => {
    const old = wrapPglite(await PGlite.create())
    await expect(recordCustomQuery(old, 'SELECT 1')).resolves.toBeUndefined()
    expect((await old.query(`SELECT runs FROM meta_custom_query`))[0]).toMatchObject({ runs: 1 })
    await old.close()
    await expect(recordCustomQuery(old, 'SELECT 1')).resolves.toBeUndefined()
  })
})

describe('dashboard', () => {
  it('renders the trust line, metrics, flows and syncs as one escaped page', async () => {
    await db.query(`INSERT INTO fact_orders_daily (date, orders, gross_revenue, net_revenue, discounts, new_orders, returning_orders, source_synced_at) VALUES (CURRENT_DATE - 3, 10, 1000, 1000, 0, 6, 4, now())`)
    await db.query(`INSERT INTO dim_flow (flow_id, name, status, archived, source_synced_at) VALUES ('F', '<Welcome>', 'live', false, now())`)
    await db.query(`INSERT INTO fact_flow_daily (flow_id, flow_message_id, channel, date, recipients, revenue, source_synced_at) VALUES ('F', 'M', 'email', CURRENT_DATE - 3, 50, 120, now())`)
    await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status, rows_written) VALUES ('r', 'shopify', now(), now(), 'ok', 12)`)
    const d = await buildDashboard(db, 90)
    expect(d.metrics.find((m) => m.name === 'average_order_value')!.value).toBe(100)
    const html = dashboardHtml(d)
    expect(html).toContain('Numbers not checked yet')
    expect(html).toContain('&lt;Welcome&gt;')
    expect(html).not.toContain('<Welcome>')
    expect(html).toContain('(small sample)')
    expect(html).toContain('$100.00')
  })
})

describe('update check', () => {
  const fake = (tag: string) => (async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 })) as unknown as typeof fetch

  it('reports a newer release and caches the answer for a day', async () => {
    const now = Date.UTC(2026, 10, 7)
    const a = await checkForUpdate({ fetcher: fake('v99.0.0'), now })
    expect(a).toMatchObject({ latest: '99.0.0', newer: true })
    const failing = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await checkForUpdate({ fetcher: failing, now: now + 3600_000 })).toMatchObject({ latest: '99.0.0', newer: true })
    expect((await checkForUpdate({ fetcher: failing, now: now + 2 * 86400_000 })).skipped).toMatch(/could not be reached/)
  })

  it('can be turned off', async () => {
    setSetting('update.check', 'false')
    expect((await checkForUpdate({ fetcher: fake('v99.0.0') })).skipped).toMatch(/update.check is false/)
  })
})

describe('deploy project files', () => {
  it('writes the workflow and a runner config without local-only settings', () => {
    const dir = join(home, 'proj')
    const r = writeProject({ database: { kind: 'local' }, klaviyo: { connected: true }, registry: { uri: '/x' }, deploy: { repo: 'me/r' } }, dir)
    expect(r.files).toContain('.github/workflows/sync.yml')
    const cfg = JSON.parse(readFileSync(join(dir, '.lifecycle', 'config.json'), 'utf8'))
    expect(cfg).toEqual({ database: { kind: 'postgres' }, klaviyo: { connected: true } })
    expect(readFileSync(join(dir, '.github', 'workflows', 'sync.yml'), 'utf8')).toMatch(/npx lifecycle sync/)
  })

  it('counts a success streak, ignoring a run still in progress', () => {
    expect(successStreak([{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }, { status: 'completed', conclusion: 'success' }])).toBe(2)
    expect(successStreak([])).toBe(0)
  })
})
