import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { getRun, listRuns, runTool, toolCatalog, type ToolContext } from '../src/tools.js'
import { serve } from '../src/serve.js'
import { filesDir, getFile, listFiles, putFile, readFile, saveArtifact } from '../src/files.js'
import { customTables, importCsv, parseCsv, prepareImport } from '../src/custom-sources.js'
import { sourceStatus } from '../src/sources-catalog.js'
import { workflowYaml } from '../src/deploy.js'

let home: string
let db: Db

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'lc-p2-'))
  process.env.LIFECYCLE_HOME = home
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(async () => {
  await db.close()
  rmSync(home, { recursive: true, force: true })
  delete process.env.LIFECYCLE_HOME
})

const fakeCtx = (): ToolContext => ({
  klaviyo: () => ({ flows: async () => [{ id: 'F1', name: 'Welcome', status: 'live' }], account: async () => ({ id: 'A1', name: 'Test' }) }) as any,
  shopify: async () => { throw new Error('Shopify is not connected.') },
})

describe('tools', () => {
  it('lists read-only tools with their inputs', () => {
    const c = toolCatalog()
    expect(c.map((t) => t.id)).toContain('klaviyo.flows')
    expect(c.find((t) => t.id === 'klaviyo.placed_orders_daily')!.input).toEqual(['start', 'end'])
    expect(c.every((t) => !/profile|customer/i.test(t.id))).toBe(true)
  })

  it('runs a tool, saves the run, and lists it', async () => {
    const r = await runTool('klaviyo.flows', {}, fakeCtx())
    expect(r).toMatchObject({ status: 'succeeded', output: [{ id: 'F1', name: 'Welcome', status: 'live' }] })
    expect(getRun(r.id).output).toEqual(r.output)
    expect(listRuns()[0]).toMatchObject({ id: r.id, tool: 'klaviyo.flows' })
  })

  it('records a failed run instead of throwing', async () => {
    const r = await runTool('shopify.order_count', {}, fakeCtx())
    expect(r).toMatchObject({ status: 'failed', error: 'Shopify is not connected.' })
  })

  it('rejects bad input and unknown tools', async () => {
    await expect(runTool('klaviyo.placed_orders_daily', { start: 'yesterday' }, fakeCtx())).rejects.toThrow(/Bad input/)
    await expect(runTool('klaviyo.flows', { extra: 1 }, fakeCtx())).rejects.toThrow(/Bad input/)
    await expect(runTool('nope', {}, fakeCtx())).rejects.toThrow(/No tool named/)
    expect(() => getRun('../../etc/passwd')).toThrow(/No run/)
  })
})

describe('serve', () => {
  it('serves the dashboard and a read-only JSON API on 127.0.0.1', async () => {
    await db.query(`INSERT INTO fact_orders_daily (date, orders, gross_revenue, net_revenue, discounts, new_orders, returning_orders, source_synced_at) VALUES (CURRENT_DATE - 2, 4, 400, 400, 0, 4, 0, now())`)
    const s = await serve(db, 0)
    try {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const home = await fetch(s.url)
      expect(home.status).toBe(200)
      expect(await home.text()).toContain('Lifecycle dashboard')
      expect((await (await fetch(`${s.url}/api/metrics/average_order_value?days=30`)).json()).value).toBe(100)
      expect((await (await fetch(`${s.url}/api/status`)).json()).trust.status).toBe('unchecked')
      expect((await fetch(`${s.url}/api/metrics/nope`)).status).toBe(400)
      expect((await fetch(`${s.url}/nowhere`)).status).toBe(404)
      expect((await fetch(`${s.url}/api/status`, { method: 'POST' })).status).toBe(405)
    } finally {
      await s.close()
    }
  })
})

describe('files', () => {
  it('keeps artifacts by date and reads them back', () => {
    const rel = saveArtifact('audit.html', '<p>x</p>', new Date('2026-11-07T10:00:00Z'))
    expect(rel).toBe(join('2026-11-07', 'audit.html'))
    expect(readFile(rel)).toBe('<p>x</p>')
    expect(listFiles()[0]!.path).toBe(rel)
    const local = join(home, 'note.txt')
    writeFileSync(local, 'hi')
    const stored = putFile(local, undefined, new Date('2026-11-08T00:00:00Z'))
    expect(listFiles('2026-11-08').map((f) => f.path)).toEqual([stored])
    const out = getFile(rel, join(home, 'out'))
    expect(readFileSync(out, 'utf8')).toBe('<p>x</p>')
    expect(filesDir()).toBe(join(home, 'files'))
  })

  it('refuses paths outside the store', () => {
    expect(() => readFile('../config.json')).toThrow(/outside the files folder/)
    expect(() => listFiles('../../')).toThrow(/outside/)
  })
})

describe('custom CSV sources', () => {
  it('parses quoted CSV and sums rows per day', () => {
    expect(parseCsv('a,b\n"x, y","He said ""hi"""\r\n')).toEqual([['a', 'b'], ['x, y', 'He said "hi"']])
    const p = prepareImport('meta_ads', 'Date,Spend,Clicks,30d ROAS\n2026-11-01,"$1,200.50",10,2\n2026-11-01,100,5,1\n2026-11-02,50,,3\n')
    expect(p.columns).toEqual(['spend', 'clicks', 'c_30d_roas'])
    expect(p.days).toEqual([['2026-11-01', [1300.5, 15, 3]], ['2026-11-02', [50, 0, 3]]])
  })

  it('refuses personal data, text values and bad dates', () => {
    expect(() => prepareImport('x', 'date,email,orders\n2026-11-01,a@b.com,1\n')).toThrow(/personal data/)
    expect(() => prepareImport('x', 'date,Customer Name,orders\n2026-11-01,Jo,1\n')).toThrow(/personal data/)
    expect(() => prepareImport('x', 'date,campaign,orders\n2026-11-01,Spring sale,1\n')).toThrow(/not a number/)
    expect(() => prepareImport('x', 'date,orders\n11/01/2026,1\n')).toThrow(/YYYY-MM-DD/)
    expect(() => prepareImport('x', 'date,source_synced_at\n2026-11-01,1\n')).toThrow(/uses itself/)
    expect(() => prepareImport('Bad-Name', 'date,orders\n2026-11-01,1\n')).toThrow(/lowercase/)
  })

  it('imports idempotently and shows up as a source and a table', async () => {
    const f = join(home, 'ads.csv')
    writeFileSync(f, 'date,spend,clicks\n2026-11-01,100,10\n2026-11-02,50,5\n')
    const r = await importCsv(db, 'meta_ads', f)
    expect(r).toMatchObject({ table: 'custom_meta_ads', days: 2, from: '2026-11-01', to: '2026-11-02' })
    writeFileSync(f, 'date,spend,clicks,impressions\n2026-11-02,60,6,900\n')
    await importCsv(db, 'meta_ads', f)
    const rows = await db.query(`SELECT date::text AS date, spend, clicks, impressions FROM custom_meta_ads ORDER BY date`)
    expect(rows.map((x) => [x.date, Number(x.spend), Number(x.impressions)])).toEqual([['2026-11-01', 100, 0], ['2026-11-02', 60, 900]])
    expect(await customTables(db)).toEqual(['custom_meta_ads'])
    const s = await sourceStatus(null, () => false, db)
    expect(s.find((x) => x.slug === 'custom:meta_ads')).toMatchObject({ connected: true, name: 'meta_ads (custom CSV)' })
  })
})

describe('daily sync workflow', () => {
  it('uploads the dashboard as an artifact for files pull', () => {
    const y = workflowYaml(false)
    expect(y).toContain('npx lifecycle dashboard --html lifecycle-dashboard.html')
    expect(y).toContain('name: lifecycle-dashboard')
  })
})
