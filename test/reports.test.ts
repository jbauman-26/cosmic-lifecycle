import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { auditFlows, auditHtml, revenueHtml, revenuePerFlow } from '../src/reports.js'
import { applyPlan, buildPlan, readPlan, segmentBody, suggestLapsedDays, writePlan } from '../src/segments.js'

let db: Db
const flow = (id: string, name: string, status = 'live') => db.query(`INSERT INTO dim_flow (flow_id, name, status, archived, source_synced_at) VALUES ($1,$2,$3,false,now())`, [id, name, status])
const stat = (id: string, daysAgo: number, recipients: number, revenue: number, extra = '') =>
  db.query(`INSERT INTO fact_flow_daily (flow_id, flow_message_id, channel, date, recipients, revenue, spam_complaints, source_synced_at) VALUES ($1,'M','email',CURRENT_DATE - $2::int,$3,$4,${extra || 0},now())`, [id, daysAgo, recipients, revenue])

beforeEach(async () => {
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(async () => {
  await db.close()
  vi.unstubAllGlobals()
})

describe('revenue per flow', () => {
  it('ranks by revenue per recipient and carries its warnings', async () => {
    await flow('A', 'Welcome'); await flow('B', 'Big but weak')
    await stat('A', 5, 100, 500); await stat('B', 5, 1000, 1000)
    await db.query(`INSERT INTO fact_orders_daily (date, orders, gross_revenue, net_revenue, discounts, new_orders, returning_orders, source_synced_at) VALUES (CURRENT_DATE - 5, 1, 10000, 10000, 0, 1, 0, now())`)
    const r = await revenuePerFlow(db)
    expect(r.flows.map((f) => f.name)).toEqual(['Welcome', 'Big but weak'])
    expect(r.ownedSharePct).toBe(15)
    expect(r.belowOwnedLine).toBe(false)
    expect(r.notes.join(' ')).toContain('not proof')
    expect(r.trust.status).toBe('unchecked')
  })
})

describe('flow audit', () => {
  it('finds missing, drafted and silent flows', async () => {
    await flow('A', 'Welcome Series'); await flow('B', 'Abandoned Checkout', 'draft')
    const a = await auditFlows(db)
    const titles = a.findings.map((f) => f.title)
    expect(titles).toContain('Abandoned checkout flow is not live')
    expect(titles).toContain('No Win-back flow found')
    expect(titles).toContain('Welcome Series sent nothing in 30 days')
    expect(titles).not.toContain('No Welcome series flow found')
  })
  it('catches falling revenue per recipient and high spam', async () => {
    await flow('A', 'Welcome Series')
    await stat('A', 45, 500, 1000); await stat('A', 5, 500, 200, '5')
    const titles = (await auditFlows(db)).findings.map((f) => f.title)
    expect(titles).toContain('Welcome Series revenue per recipient fell')
    expect(titles).toContain('Welcome Series spam rate is high')
  })
  it('does not call a small sample a trend', async () => {
    await flow('A', 'Welcome Series')
    await stat('A', 45, 10, 100); await stat('A', 5, 10, 1)
    expect((await auditFlows(db)).findings.map((f) => f.title)).not.toContain('Welcome Series revenue per recipient fell')
  })
  it('escapes flow names in HTML', async () => {
    await flow('A', '<script>alert(1)</script>', 'draft')
    const html = auditHtml(await auditFlows(db))
    expect(html).not.toContain('<script>alert')
    expect(revenueHtml(await revenuePerFlow(db))).toContain('No flow data yet')
  })
})

describe('win-back segment', () => {
  const plan = () => buildPlan({ lapsedAfterDays: 120, basis: 'test', metricId: 'M1' })
  it('keeps consent inline, since segments cannot reference segments', () => {
    const s = JSON.stringify(segmentBody(plan()))
    expect(s).toContain('profile-marketing-consent')
    expect(s).not.toContain('segment_id')
  })
  it('falls back to a default on thin data', async () => {
    expect((await suggestLapsedDays(db)).days).toBe(120)
  })
  it('derives timing from real repeat behavior', async () => {
    await db.query(`INSERT INTO fact_cohort_monthly VALUES ('2026-01',1,10,30,1,now()),('2026-01',2,10,10,1,now()),('2026-01',6,10,5,1,now())`)
    expect((await suggestLapsedDays(db)).days).toBe(90)
  })
  it('refuses without --confirm and sends nothing', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(applyPlan(plan(), 'k', {})).rejects.toThrow(/Nothing was created/)
    expect(f).not.toHaveBeenCalled()
  })
  it('refuses a plan edited after review', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'plan-')), 'p.json')
    writePlan(file, plan())
    const edited = JSON.parse(readFileSync(file, 'utf8'))
    edited.lapsedAfterDays = 15
    writeFileSync(file, JSON.stringify(edited))
    expect(() => readPlan(file)).toThrow(/changed after/)
  })
  it('only ever touches the segments endpoint', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(u); return new Response('{"data":{"id":"S1"}}', { status: 201 }) }))
    expect((await applyPlan(plan(), 'k', { confirm: true })).segmentId).toBe('S1')
    expect(urls).toEqual(['https://a.klaviyo.com/api/segments'])
  })
})

describe('demo', () => {
  it('catches the planted fault, then passes, and is labeled as sample', async () => {
    const { runDemo } = await import('../src/demo.js')
    const d = await runDemo({ write: () => {} })
    expect(d.sample).toBe(true)
    expect(d.broken.checks.find((c) => c.name === 'orders_complete')?.status).toBe('fail')
    expect(d.fixed.passed).toBe(true)
    expect(d.audit.findings.map((f) => f.title)).toContain('Win-back flow is not live')
  }, 30000)
})
