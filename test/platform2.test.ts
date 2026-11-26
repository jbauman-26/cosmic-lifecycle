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
import { followRun, workflowYaml, type WorkflowRun } from '../src/deploy.js'
import { checklistLines, loadChecklist, setupChecklist } from '../src/checklist.js'
import { buildDashboard, dashboardHtml } from '../src/dashboard.js'

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

describe('provision', () => {
  it('creates a Neon project from the user key and returns its connection string', async () => {
    const { provisionNeon, neonPlan } = await import('../src/provision.js')
    let sent: { url: string; init: RequestInit } | null = null
    const fake = (async (url: string, init: RequestInit) => {
      sent = { url, init }
      return { project: { id: 'proj-1' }, connection_uris: [{ connection_uri: 'postgres://u:p@h/db' }] }
    }) as any
    const r = await provisionNeon('neon_key', 'lifecycle', 'aws-us-east-2', fake)
    expect(r).toEqual({ projectId: 'proj-1', region: 'aws-us-east-2', uri: 'postgres://u:p@h/db' })
    expect(sent!.url).toBe('https://console.neon.tech/api/v2/projects')
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe('Bearer neon_key')
    expect(JSON.parse(String(sent!.init.body))).toEqual({ project: { name: 'lifecycle', region_id: 'aws-us-east-2' } })
    expect(neonPlan('lifecycle', 'aws-us-east-2').creates[0]).toMatch(/your own Neon account/)
    await expect(provisionNeon('k', 'Bad Name', 'r', fake)).rejects.toThrow(/lowercase/)
    await expect(provisionNeon('k', 'ok', 'r', (async () => ({})) as any)).rejects.toThrow(/no connection string/)
  })
})

describe('setup checklist', () => {
  const src = (slug: string, connected: boolean, lastStatus: string | null = null) => ({ slug, connected, lastStatus })

  it('starts at zero with the first command to run', () => {
    const c = setupChecklist({ setUp: false, sources: [], trust: null, deployed: false, skills: false })
    expect(c.done).toBe(0)
    expect(c.total).toBe(6)
    expect(c.steps[0]).toEqual({ step: 'Set up the database', done: false, next: 'cosmic init' })
    expect(checklistLines(c)[0]).toBe('Setup: 0 of 6 steps done')
  })

  it('needs both Shopify and Klaviyo, and a passing reconcile', () => {
    const c = setupChecklist({ setUp: true, sources: [src('shopify', true, 'warning'), src('klaviyo', false)], trust: 'failed', deployed: false, skills: true })
    const by = Object.fromEntries(c.steps.map((s) => [s.step, s]))
    expect(by['Connect Shopify and Klaviyo']!.done).toBe(false)
    expect(by['Run the first sync']!.done).toBe(true)
    expect(by['Prove the numbers agree']!.next).toMatch(/failed checks/)
    expect(by['Install the skills for your agent']!.next).toBeNull()
    expect(c.done).toBe(3)
  })

  it('does not count a failed or running sync as the first sync', () => {
    for (const status of ['failed', 'running']) {
      const c = setupChecklist({ setUp: true, sources: [src('shopify', true, status), src('klaviyo', true, null)], trust: null, deployed: false, skills: false })
      const step = c.steps.find((s) => s.step === 'Run the first sync')!
      expect(step.done).toBe(false)
      expect(step.next).toBe('cosmic sync')
    }
  })

  it('is complete when every step is done', () => {
    const c = setupChecklist({ setUp: true, sources: [src('shopify', true, 'ok'), src('klaviyo', true, 'ok')], trust: 'passed', deployed: true, skills: true })
    expect(c.done).toBe(6)
    expect(c.steps.every((s) => s.next === null)).toBe(true)
  })

  it('loads from an empty machine and shows on the dashboard', async () => {
    const c = await loadChecklist(db, null)
    expect(c.steps[0]!.done).toBe(false)
    const html = dashboardHtml(await buildDashboard(db))
    expect(html).toContain('steps done')
    expect(html).toContain('cosmic init')
  })
})

describe('logs --follow', () => {
  const run = (status: string, conclusion: string | null, id = 7): WorkflowRun => ({ id, status, conclusion, event: 'schedule', createdAt: '2026-11-24T09:17:00Z', url: 'https://example.invalid/run/7' })

  it('reports each state once and returns the finished run', async () => {
    const states = [run('queued', null), run('in_progress', null), run('in_progress', null), run('completed', 'success')]
    const seen: string[] = []
    let polls = 0
    const last = await followRun(() => states[polls++], () => states[polls++]!, (r) => seen.push(r.conclusion ?? r.status), async () => {})
    expect(seen).toEqual(['queued', 'in_progress', 'success'])
    expect(last.conclusion).toBe('success')
  })

  it('stays on the first run when a newer one is dispatched', async () => {
    // The newest run is now #8 and it succeeded. The run being followed, #7, failed.
    const asked: number[] = []
    const last = await followRun(() => (asked.length ? run('completed', 'success', 8) : run('in_progress', null, 7)), (id) => { asked.push(id); return run('completed', 'failure', id) }, () => {}, async () => {})
    expect(asked).toEqual([7])
    expect(last.id).toBe(7)
    expect(last.conclusion).toBe('failure')
  })

  it('returns at once when the newest run already finished', async () => {
    let waits = 0
    const last = await followRun(() => run('completed', 'failure'), () => run('completed', 'failure'), () => {}, async () => { waits++ })
    expect(last.conclusion).toBe('failure')
    expect(waits).toBe(0)
  })

  it('fails clearly with no runs, and stops after the poll limit', async () => {
    await expect(followRun(() => undefined, () => run('queued', null), () => {}, async () => {})).rejects.toThrow(/No runs yet/)
    await expect(followRun(() => run('in_progress', null), () => run('in_progress', null), () => {}, async () => {}, 3)).rejects.toThrow(/still going/)
  })
})
