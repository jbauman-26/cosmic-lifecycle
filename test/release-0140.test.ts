import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { reconcile, runChecks, tolerances, trustLine } from '../src/reconcile.js'
import { ALL_METRICS, listMetrics, METRICS, PACK_METRICS, PACKS, packMetrics, runMetric } from '../src/metrics.js'
import { readWorkspace, TYPES, WORKSPACE_TYPES, type Workspace } from '../src/workspace.js'
import { aggregateContacts, aggregateDeals, CONTACT_PROPERTIES, DEAL_PROPERTIES, HubSpot } from '../src/sources/hubspot.js'
import { apiBase } from '../src/sources/api-base.js'
import { syncHubspot, syncStripe, writeStripe } from '../src/sync.js'
import { sampleHubspot, sampleStripe, runTypeDemo } from '../src/demo.js'
import { WAREHOUSE_CATALOG } from '../src/warehouse-catalog.js'
import { setupChecklist } from '../src/checklist.js'
import { KitManifest, listKits, validateRegistry } from '../src/registry.js'
import { listSettings } from '../src/config.js'
import { PUBLIC_TABLES } from '../src/schema.js'

let home: string
const realHome = process.env.HOME
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lc-0140-'))
  process.env.LIFECYCLE_HOME = home
  process.env.LIFECYCLE_NO_KEYCHAIN = '1'
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  process.env.HOME = realHome
  for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'LIFECYCLE_WORKSPACE', 'LIFECYCLE_STRIPE_API_URL', 'LIFECYCLE_HUBSPOT_API_URL']) delete process.env[k]
})

const fresh = async () => {
  const db = wrapPglite(await PGlite.create())
  await migrate(db)
  return db
}
const ws = (type: Workspace['type'], reference?: Workspace['reference']): Workspace => ({ type, reference: reference ?? TYPES[type].reference, referenceSet: Boolean(reference), title: TYPES[type].title })
const writeConfig = (data: unknown) => {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify(data))
}

describe('workspace types', () => {
  it('reads an install from before 0.14.0, with no type, as a Shopify store', () => {
    writeConfig({ database: { kind: 'local' }, shopify: { store: 'x.myshopify.com', clientId: 'c' } })
    expect(readWorkspace()).toEqual({ type: 'shopify', reference: 'shopify', referenceSet: false, title: 'Shopify store' })
    expect(readWorkspace({})).toMatchObject({ type: 'shopify' })
    expect(readWorkspace({ workspace: { type: 'nonsense' } })).toMatchObject({ type: 'shopify' })
  })

  it('gives each type a reference source and five usual sources, and lets the owner change the reference', () => {
    expect(WORKSPACE_TYPES).toEqual(['shopify', 'ecommerce', 'saas', 'b2b', 'agency', 'creator'])
    for (const t of WORKSPACE_TYPES) expect(TYPES[t].sources, t).toHaveLength(5)
    expect(readWorkspace({ workspace: { type: 'saas' } })).toMatchObject({ type: 'saas', reference: 'stripe', referenceSet: false })
    expect(readWorkspace({ workspace: { type: 'agency', reference: 'hubspot' } })).toMatchObject({ reference: 'hubspot', referenceSet: true })
  })

  it('keeps a store\'s settings list as it was and shows the new settings elsewhere', () => {
    writeConfig({ database: { kind: 'local' } })
    expect(listSettings().map((s) => s.key)).not.toContain('workspace.reference')
    writeConfig({ database: { kind: 'local' }, workspace: { type: 'saas' } })
    expect(listSettings().map((s) => s.key)).toEqual(expect.arrayContaining(['workspace.reference', 'reconcile.ad_claim_flag']))
  })
})

describe('metric packs', () => {
  it('lists exactly the 0.13 metrics, in order, for a store', () => {
    expect(listMetrics('shopify').map((m) => m.name)).toEqual(METRICS.map((m) => m.name))
    expect(PACKS.shopify).toEqual(METRICS.map((m) => m.name))
  })

  it('names only real metrics in every pack, with no name used twice', () => {
    const names = ALL_METRICS.map((m) => m.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of WORKSPACE_TYPES) {
      for (const n of PACKS[t]) expect(names, `${t}: ${n}`).toContain(n)
      expect(PACKS[t].length, t).toBeGreaterThanOrEqual(10)
    }
    expect(packMetrics('all')).toHaveLength(ALL_METRICS.length)
  })

  it('runs every new metric on a SaaS and a B2B sample with a value and a trust line', async () => {
    const db = await fresh()
    try {
      const { charges, subs } = sampleStripe()
      await syncStripe(db, { charges: async () => charges, subscriptions: async () => subs })
      await db.query(`INSERT INTO fact_stripe_mrr VALUES (CURRENT_DATE - 120, 'usd', 61, 4182, 0, now())`)
      const { deals, contacts } = sampleHubspot()
      await syncHubspot(db, { deals: async () => deals, contacts: async () => contacts, total: async (o) => (o === 'deals' ? deals.length : contacts.length) })
      for (let d = 60; d >= 1; d--) {
        await db.query(`INSERT INTO fact_meta_ads_daily VALUES (CURRENT_DATE - $1::int, 'C1', 'c', 100, 5000, 120, 2, 140, 'USD', 'a', now())`, [d])
        await db.query(`INSERT INTO fact_ga4_daily VALUES (CURRENT_DATE - $1::int, 'all', 400, 0, 0, now())`, [d])
      }
      await reconcile(db, tolerances(), ws('saas'))
      for (const m of PACK_METRICS) {
        const r = await runMetric(db, m.name, 90)
        expect(r.status, m.name).toBe('ok')
        expect(r.value, m.name).not.toBeNull()
        expect(r.trust.line, m.name).toMatch(/Stripe/)
      }
      expect((await runMetric(db, 'stripe_mrr', 90)).value).toBeCloseTo(subs.filter((s) => s.status === 'active' || s.status === 'past_due').reduce((n, s) => n + s.items.data[0]!.price.unit_amount! / 100, 0), 2)
      const won = deals.filter((d) => d.properties.hs_is_closed_won === 'true' && Date.parse(String(d.properties.closedate)) >= Date.now() - 90 * 86400000)
      expect((await runMetric(db, 'crm_deals_won', 90)).value).toBe(won.length)
    } finally {
      await db.close()
    }
  })
})

describe('the trust gate for each workspace type', () => {
  it('runs exactly the 0.13 checks for a Shopify store, with no reference row', async () => {
    const db = await fresh()
    try {
      const a = await runChecks(db, tolerances())
      const b = await reconcile(db, tolerances(), ws('shopify'))
      expect(b.checks.map((c) => c.name)).toEqual(a.map((c) => c.name))
      expect(b.checks.map((c) => c.name)).not.toContain('reference')
    // 0.17.1: every check skipped is unchecked, never passed.
      expect((await trustLine(db)).line).toBe('Nothing checked yet: all 7 checks were skipped because their sources have not synced. Treat these numbers as unchecked.')
    } finally {
      await db.close()
    }
  })

  it('says plainly that SaaS numbers are unchecked while Stripe has not synced, and never fails for it', async () => {
    const db = await fresh()
    try {
      const r = await reconcile(db, tolerances(), ws('saas'))
      expect(r.passed).toBe(true)
      const t = await trustLine(db)
      expect(t.status).toBe('unreferenced')
      expect(t.line).toMatch(/^Not checked against a source of truth yet: Stripe is this workspace's reference/)
      expect(t.line).not.toMatch(/DO NOT TRUST/)
    } finally {
      await db.close()
    }
  })

  it('says so for a workspace with no reference at all, and for GA4 as the only reference', async () => {
    const db = await fresh()
    try {
      await reconcile(db, tolerances(), ws('agency'))
      expect(await trustLine(db)).toMatchObject({ status: 'unreferenced', line: expect.stringMatching(/no reference source set/) })
      await db.query(`INSERT INTO fact_ga4_daily VALUES (CURRENT_DATE - 1, 'all', 100, 2, 50, now())`)
      await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('g', 'ga4', now(), now(), 'ok')`)
      await reconcile(db, tolerances(), ws('agency', 'ga4'))
      expect(await trustLine(db)).toMatchObject({ status: 'unreferenced', line: expect.stringMatching(/^Checked against GA4 only/) })
    } finally {
      await db.close()
    }
  })

  it('catches charges missing from the Stripe daily table and a churn table that does not balance', async () => {
    const db = await fresh()
    try {
      const { charges, subs } = sampleStripe()
      await syncStripe(db, { charges: async () => charges, subscriptions: async () => subs })
      let r = await reconcile(db, tolerances(), ws('saas'))
      expect(r.checks.filter((c) => c.status === 'fail')).toEqual([])
      expect((await trustLine(db)).line).toMatch(/^Numbers passed reconciliation against Stripe\./)
      // Rows lost between the pull and the table.
      await writeStripe(db, charges.slice(5), subs)
      r = await reconcile(db, tolerances(), ws('saas'))
      expect(r.checks.find((c) => c.name === 'stripe_daily_complete')).toMatchObject({ status: 'fail', expected: charges.filter((c) => c.status !== 'pending').length })
      expect((await trustLine(db)).status).toBe('failed')
      // A subscription that ended but is still counted as open.
      await writeStripe(db, charges, subs.map((s, i) => (i === 5 ? { ...s, ended_at: null } : s)))
      r = await reconcile(db, tolerances(), ws('saas'))
      expect(r.checks.find((c) => c.name === 'subscriptions_balance')?.status).toBe('fail')
    } finally {
      await db.close()
    }
  })

  it('warns, and does not fail, when Meta claims more purchases than Stripe recorded', async () => {
    const db = await fresh()
    try {
      const { charges, subs } = sampleStripe()
      await syncStripe(db, { charges: async () => charges, subscriptions: async () => subs })
      for (let d = 30; d >= 1; d--) await db.query(`INSERT INTO fact_meta_ads_daily VALUES (CURRENT_DATE - $1::int, 'C1', 'c', 100, 5000, 120, 5, 400, 'USD', 'a', now())`, [d])
      await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status) VALUES ('m', 'meta', now(), now(), 'ok')`)
      const r = await reconcile(db, tolerances(), ws('saas'))
      const c = r.checks.find((x) => x.name === 'ad_claims')!
      expect(c.status).toBe('warn')
      expect(c.actual).toBe(150)
      expect(c.detail).toMatch(/^Meta claims 150 purchases since .* Stripe shows \d+ new paying customers on the same days/)
      expect(r.passed).toBe(true)
    } finally {
      await db.close()
    }
  })

  it('checks a HubSpot pull against HubSpot\'s own counts', async () => {
    const db = await fresh()
    try {
      const { deals, contacts } = sampleHubspot()
      await syncHubspot(db, { deals: async () => deals.slice(3), contacts: async () => contacts, total: async (o) => (o === 'deals' ? deals.length : contacts.length) })
      const r = await reconcile(db, tolerances(), ws('b2b'))
      expect(r.checks.find((c) => c.name === 'deals_complete')).toMatchObject({ status: 'fail', expected: 240, actual: 237 })
      expect(r.checks.find((c) => c.name === 'contacts_complete')?.status).toBe('pass')
      expect(r.checks.find((c) => c.name === 'ad_claims')?.status).toBe('skipped')
      await syncHubspot(db, { deals: async () => deals, contacts: async () => contacts, total: async (o) => (o === 'deals' ? deals.length : contacts.length) })
      expect((await reconcile(db, tolerances(), ws('b2b'))).passed).toBe(true)
      expect((await trustLine(db)).line).toMatch(/against HubSpot/)
    } finally {
      await db.close()
    }
  })

  it('drops the results of checks a workspace no longer runs when its type changes', async () => {
    const db = await fresh()
    try {
      await reconcile(db, tolerances(), ws('shopify'))
      await reconcile(db, tolerances(), ws('saas'))
      const names = (await db.query(`SELECT check_name FROM meta_reconcile_result`)).map((r) => String(r.check_name))
      expect(names).not.toContain('orders_complete')
      expect(names).toContain('reference')
    } finally {
      await db.close()
    }
  })

  it('asks a SaaS workspace for Stripe in the setup checklist, and a store for Shopify and Klaviyo as before', () => {
    const base = { setUp: true, sources: [], trust: null, deployed: false, skills: false }
    expect(setupChecklist(base).steps[1]!.step).toBe('Connect Shopify and Klaviyo')
    expect(setupChecklist({ ...base, workspace: ws('saas') }).steps[1]).toMatchObject({ step: "Connect Stripe, this workspace's source of truth", next: 'lifecycle connect stripe' })
    expect(setupChecklist({ ...base, workspace: ws('agency') }).steps[1]!.next).toMatch(/workspace.reference/)
  })
})

describe('HubSpot, counts only', () => {
  it('asks HubSpot for no property that could hold a name, email, phone or company', () => {
    for (const p of [...DEAL_PROPERTIES, ...CONTACT_PROPERTIES]) expect(p).not.toMatch(/name|email|phone|mobile|address|company|firstname|lastname/)
  })

  it('counts each deal once, on its create day and its close day, and keeps open deals as a snapshot', () => {
    const deal = (id: string, p: Record<string, string | null>) => ({ id, properties: p })
    const { daily, open } = aggregateDeals([
      deal('1', { createdate: '2026-10-01T10:00:00Z', closedate: '2026-10-20T10:00:00Z', amount: '1000', hs_is_closed: 'true', hs_is_closed_won: 'true', pipeline: 'p', hs_analytics_source: 'PAID_SEARCH' }),
      deal('1', { createdate: '2026-10-01T10:00:00Z', closedate: '2026-10-20T10:00:00Z', amount: '1000', hs_is_closed: 'true', hs_is_closed_won: 'true', pipeline: 'p', hs_analytics_source: 'PAID_SEARCH' }),
      deal('2', { createdate: '2026-10-01T11:00:00Z', closedate: '2026-10-21T10:00:00Z', amount: '500', hs_is_closed: 'true', hs_is_closed_won: 'false', pipeline: 'p', hs_analytics_source: null }),
      deal('3', { createdate: '1759312800000', amount: '', hs_is_closed: 'false', hs_is_closed_won: 'false', dealstage: 'contractsent', deal_currency_code: 'EUR' }),
    ], 'usd')
    const by = (date: string, source: string) => daily.find((d) => d.date === date && d.source === source)
    expect(by('2026-10-01', 'PAID_SEARCH')).toMatchObject({ created: 1, amountCreated: 1000 })
    expect(by('2026-10-20', 'PAID_SEARCH')).toMatchObject({ won: 1, wonAmount: 1000 })
    expect(by('2026-10-21', 'UNKNOWN')).toMatchObject({ lost: 1, won: 0 })
    expect(open).toEqual([{ currency: 'eur', pipeline: 'default', stage: 'contractsent', deals: 1, amount: 0 }])
    expect(aggregateContacts([{ id: 'a', properties: { createdate: '2026-10-01T00:00:00Z', lifecyclestage: 'lead' } }, { id: 'a', properties: { createdate: '2026-10-01T00:00:00Z' } }])).toEqual([{ date: '2026-10-01', source: 'UNKNOWN', stage: 'lead', contacts: 1 }])
  })

  it('keeps only the asked-for properties even when HubSpot sends more, and stores no id', async () => {
    const pages: Record<string, unknown> = {
      first: { results: [{ id: '7', properties: { createdate: '2026-11-01T00:00:00Z', email: 'ada@example.com', firstname: 'Ada', lifecyclestage: 'lead' } }], paging: { next: { after: 'n2' } } },
      n2: { results: [{ id: '8', properties: { createdate: '2026-11-02T00:00:00Z', phone: '+15555550100' } }] },
    }
    const seen: string[] = []
    const hs = new HubSpot('pat-test', async (url) => {
      seen.push(url)
      return pages[new URL(url).searchParams.get('after') ?? 'first']
    })
    const rows = await hs.contacts()
    expect(JSON.stringify(rows)).not.toMatch(/ada@|Ada|\+1555/)
    expect(seen[0]).toContain('properties=createdate%2Clifecyclestage%2Chs_analytics_source')
    const db = await fresh()
    try {
      await syncHubspot(db, { deals: async () => [], contacts: async () => rows })
      for (const t of ['fact_crm_deals_daily', 'fact_crm_pipeline_open', 'fact_crm_contacts_daily']) {
        expect(PUBLIC_TABLES).toContain(t)
        const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t])).map((r) => String(r.column_name))
        expect(cols.some((c) => /id$|email|phone|name/.test(c)), `${t}: ${cols}`).toBe(false)
      }
    } finally {
      await db.close()
    }
  })
})

describe('a stand-in API address', () => {
  it('is used only when it is on this machine', () => {
    expect(apiBase('stripe', 'https://api.stripe.com/v1', {})).toBe('https://api.stripe.com/v1')
    expect(apiBase('stripe', 'https://api.stripe.com/v1', { LIFECYCLE_STRIPE_API_URL: 'http://127.0.0.1:4010/v1/' })).toBe('http://127.0.0.1:4010/v1')
    for (const bad of ['https://evil.example/v1', 'http://10.0.0.5/v1', 'http://127.0.0.1.evil.example/', 'file:///etc/passwd', 'nope']) {
      expect(() => apiBase('stripe', 'x', { LIFECYCLE_STRIPE_API_URL: bad }), bad).toThrow(/on this machine/)
    }
  })
})

describe('named workspaces', () => {
  it('give each workspace its own folder and keychain entries, and leave the default where it was', async () => {
    const { appHome, workspaceName } = await import('../src/paths.js')
    expect(appHome()).toBe(home)
    process.env.LIFECYCLE_WORKSPACE = 'acme-co'
    expect(appHome()).toBe(join(home, 'workspaces', 'acme-co'))
    expect(workspaceName()).toBe('acme-co')
    for (const bad of ['../x', 'Acme', 'a b', 'x'.repeat(41)]) {
      process.env.LIFECYCLE_WORKSPACE = bad
      expect(() => appHome(), bad).toThrow(/workspace name/)
    }
  })
})

// The new connectors go through the runner's own personal-data filter, as the 0.12.0 ones do.
const FIXTURES = join('test', 'fixtures', 'connectors-0140')
const STRIP = `
import json, sys
sys.path.insert(0, 'connectors')
import run
job = json.loads(sys.stdin.read())
extra = frozenset(job['strip_fields'])
out = {}
for name, body in job['resources'].items():
    rows = body['response']
    for part in [p for p in (body['selector'] or '').split('.') if p and p != '$']:
        rows = rows[part]
    rows = rows if isinstance(rows, list) else [rows]
    out[name] = [run.strip_personal(row, extra) for row in rows]
print(json.dumps(out, indent=1))
`
describe('connectors added in 0.14.0 strip personal data from recorded responses', () => {
  const slugs = readdirSync(FIXTURES).map((f) => f.replace(/\.json$/, '')).sort()
  it('has a recorded response for every built connector added in this release', () => {
    expect(slugs).toEqual(['bigcommerce', 'customer-io', 'hubspot-records', 'pipedrive', 'woocommerce'])
    // LinkedIn Ads became a built-in source (lifecycle connect linkedin-ads), so it left the warehouse catalog.
    expect(WAREHOUSE_CATALOG.find((x) => x.slug === 'linkedin-ads')).toBeUndefined()
    for (const s of ['salesforce', 'posthog', 'mixpanel']) expect(WAREHOUSE_CATALOG.find((x) => x.slug === s)?.readiness, s).toBe('planned')
  })
  for (const slug of ['bigcommerce', 'customer-io', 'hubspot-records', 'pipedrive', 'woocommerce']) {
    it(`${slug}: no name, email, phone or address comes out, and the useful fields stay`, () => {
      const fixture = JSON.parse(readFileSync(join(FIXTURES, `${slug}.json`), 'utf8'))
      const source = WAREHOUSE_CATALOG.find((s) => s.slug === slug)!
      expect(source.readiness).toBe('built')
      const resources = (source.config as { resources: { name: string; endpoint: { data_selector?: string } }[]; resource_defaults?: { endpoint?: { data_selector?: string } } })
      const job = {
        strip_fields: source.stripFields ?? [],
        resources: Object.fromEntries(resources.resources.map((r) => [r.name, { selector: r.endpoint.data_selector ?? resources.resource_defaults?.endpoint?.data_selector ?? '', response: fixture.resources[r.name]?.response }])),
      }
      for (const r of resources.resources) expect(fixture.resources[r.name], `${slug}.${r.name} has no recorded body`).toBeDefined()
      const res = spawnSync('python3', ['-c', STRIP], { input: JSON.stringify(job), encoding: 'utf8' })
      expect(res.status, res.stderr).toBe(0)
      const text = res.stdout
      for (const v of fixture.personal) {
        expect(JSON.stringify(fixture.resources).includes(v), `${slug} fixture never held ${v}`).toBe(true)
        expect(text.includes(v), `${slug} still holds ${v}`).toBe(false)
      }
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
      for (const v of fixture.kept) expect(text.replace(/\s+/g, ' ').includes(v), `${slug} lost ${v}`).toBe(true)
    })
  }
})

describe('kits for each workspace type', () => {
  it('reads types and extra_needs, keeps needs readable by older CLIs, and filters by type', () => {
    const m = KitManifest.parse({ name: 'weekly-pipeline', version: '1.0.0', title: 't', summary: 's', needs: [], extra_needs: ['hubspot'], types: ['b2b', 'agency'], writes: 'nothing' })
    expect(m).toMatchObject({ needs: [], extra_needs: ['hubspot'], types: ['b2b', 'agency'] })
    expect(KitManifest.parse({ name: 'x', version: '1.0.0', title: 't', summary: 's', needs: ['shopify'], writes: 'nothing' }).types).toBeUndefined()
    const reg = mkdtempSync(join(tmpdir(), 'lc-reg-'))
    try {
      for (const [name, extra] of [['old-kit', ''], ['new-kit', 'types: [saas, b2b]\nextra_needs: [hubspot]\n']] as const) {
        mkdirSync(join(reg, 'kits', name), { recursive: true })
        writeFileSync(join(reg, 'kits', name, 'kit.yaml'), `name: ${name}\nversion: 1.0.0\ntitle: T\nsummary: S\nneeds: [stripe]\nwrites: nothing\n${extra}`)
        writeFileSync(join(reg, 'kits', name, 'AGENT.md'), '# Run\n\n## Verify\n\n- [ ] ok\n')
        writeFileSync(join(reg, 'kits', name, 'README.md'), 'r\n')
      }
      expect(validateRegistry(reg, { writeIndex: true }).ok).toBe(true)
      const index = JSON.parse(readFileSync(join(reg, 'index.json'), 'utf8')).kits
      expect(index.find((k: { name: string }) => k.name === 'old-kit').types).toBeUndefined()
      expect(index.find((k: { name: string }) => k.name === 'new-kit')).toMatchObject({ types: ['saas', 'b2b'], needs: ['stripe', 'hubspot'] })
      const r = { dir: reg, uri: reg, source: 'local' as const }
      expect(listKits(r, 'saas').map((k) => k.name)).toEqual(['new-kit'])
      expect(listKits(r, 'shopify').map((k) => k.name)).toEqual(['old-kit'])
      expect(listKits(r)).toHaveLength(2)
    } finally {
      rmSync(reg, { recursive: true, force: true })
    }
  })
})

describe('the demo for each type', () => {
  it('plants a fault the trust gate catches, then passes, for SaaS and for B2B', async () => {
    const saas = await runTypeDemo('saas')
    expect(saas.broken.checks.find((c) => c.name === 'stripe_daily_complete')?.status).toBe('fail')
    expect(saas.fixed.checks.filter((c) => c.status === 'fail')).toEqual([])
    expect(saas.trust.status).toBe('passed')
    expect(saas.metrics.every((m) => m.status === 'ok')).toBe(true)
    const b2b = await runTypeDemo('b2b')
    expect(b2b.broken.checks.find((c) => c.name === 'deals_complete')?.status).toBe('fail')
    expect(b2b.fixed.passed).toBe(true)
    expect(b2b.bySource.length).toBe(5)
  }, 20_000) // 0.17.1: two full demos on PGlite; about 1 s locally, over 5 s on a loaded CI runner
})

// The whole CLI, in its own process, for a SaaS workspace with no Shopify anywhere: init, demo,
// connect and sync against a stand-in Stripe on this machine, reconcile, metrics and the MCP server.
const fakeStripe = async () => {
  const { charges, subs } = sampleStripe()
  const lists: Record<string, { id: string }[]> = { '/v1/charges': [...charges].reverse(), '/v1/subscriptions': subs }
  const seen: string[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    seen.push(`${req.headers.authorization === 'Bearer rk_test_fake' ? 'auth' : 'noauth'} ${url.pathname}`)
    const all = lists[url.pathname]
    if (!all || req.headers.authorization !== 'Bearer rk_test_fake') {
      res.writeHead(all ? 401 : 404, { 'content-type': 'application/json' }).end('{"error":{"message":"no"}}')
      return
    }
    const limit = Number(url.searchParams.get('limit') ?? 10)
    const after = url.searchParams.get('starting_after')
    const start = after ? all.findIndex((x) => x.id === after) + 1 : 0
    const page = all.slice(start, start + limit)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: page, has_more: start + limit < all.length }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}/v1`, seen, charges, subs, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const cli = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string; json: () => any }>((done) => {
    const child = spawn(process.execPath, [resolve('node_modules', 'tsx', 'dist', 'cli.mjs'), resolve('src', 'cli.ts'), '--format', 'json', ...args], {
      env: { ...process.env, LIFECYCLE_HOME: home, HOME: home, LIFECYCLE_NO_KEYCHAIN: '1', LIFECYCLE_NO_UPDATE_CHECK: '1', ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => done({ status, stdout, stderr, json: () => JSON.parse(stdout) }))
  })

describe('a SaaS workspace end to end, with no Shopify', () => {
  it('init, demo, connect, sync, reconcile, metrics and mcp all work against a stand-in Stripe', async () => {
    const stripe = await fakeStripe()
    const env = { LIFECYCLE_STRIPE_API_URL: stripe.url, STRIPE_READ_KEY: 'rk_test_fake' }
    try {
      const init = await cli(['init', '--type', 'saas'], env)
      expect(init.status, init.stderr).toBe(0)
      expect(init.json()).toEqual({ database: 'local', type: 'saas', reference: 'stripe' })
      expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).workspace).toEqual({ type: 'saas' })

      const demo = await cli(['demo'], env)
      expect(demo.status, demo.stderr).toBe(0)
      expect(demo.json()).toMatchObject({ sample: true, type: 'saas', trust: { status: 'passed' } })

      // Before anything syncs, numbers say plainly they are unchecked.
      const early = await cli(['reconcile'], env)
      expect(early.status).toBe(0)
      expect((await cli(['metrics', 'run', 'stripe_mrr'], env)).json().trust.status).toBe('unreferenced')

      const connect = await cli(['connect', 'stripe', '--key-env', 'STRIPE_READ_KEY'], env)
      expect(connect.status, connect.stderr).toBe(0)
      expect(connect.json()).toMatchObject({ connected: true, mode: 'test', subscriptions: true, keyStorage: 'environment' })

      const sync = await cli(['sync'], { ...env, LIFECYCLE_STRIPE_READ_KEY: 'rk_test_fake' })
      expect(sync.status, sync.stderr).toBe(0)
      const s = sync.json()
      expect(s.results).toEqual([expect.objectContaining({ source: 'stripe', status: 'ok' })])
      expect(s.reconcile.passed).toBe(true)
      expect(s.reconcile.checks.map((c: { name: string }) => c.name)).toEqual(['reference', 'stripe_daily_complete', 'subscriptions_balance', 'ga4_vs_reference', 'ad_claims', 'freshness'])
      expect(stripe.seen.every((x) => x.startsWith('auth'))).toBe(true)

      const rec = await cli(['reconcile'], env)
      expect(rec.status).toBe(0)
      expect(rec.json().checks.find((c: { name: string }) => c.name === 'subscriptions_balance').status).toBe('pass')

      const list = await cli(['metrics', 'list'], env)
      expect(list.json().map((m: { name: string }) => m.name).slice(0, 4)).toEqual(['stripe_mrr', 'stripe_net_new_mrr', 'stripe_arpa', 'stripe_subscription_churn_rate'])
      const run = await cli(['metrics', 'run', 'stripe_mrr', 'stripe_new_customers', 'stripe_subscription_churn_rate', '--days', '90'], env)
      expect(run.status, run.stderr).toBe(0)
      const out = run.json()
      expect(out.trust).toMatchObject({ status: 'passed', line: expect.stringMatching(/against Stripe/) })
      const open = stripe.subs.filter((x) => x.status === 'active' || x.status === 'past_due')
      expect(out.metrics[0].value).toBeCloseTo(open.reduce((n, x) => n + x.items.data[0]!.price.unit_amount! / 100, 0), 2)
      for (const m of out.metrics) expect(m.status).toBe('ok')

      // The MCP server, as an agent sees it.
      const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('node_modules', 'tsx', 'dist', 'cli.mjs'), resolve('src', 'cli.ts'), 'mcp'], env: { ...process.env, LIFECYCLE_HOME: home, HOME: home, LIFECYCLE_NO_KEYCHAIN: '1', LIFECYCLE_NO_UPDATE_CHECK: '1' } as Record<string, string> })
      const client = new Client({ name: 'test', version: '0' })
      await client.connect(transport)
      try {
        const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text)
        expect(await call('workspace')).toMatchObject({ type: 'saas', reference: 'stripe' })
        expect((await call('list_metrics')).map((m: { name: string }) => m.name)).toContain('stripe_subscription_churn_rate')
        expect((await call('list_metrics', { pack: 'b2b' })).map((m: { name: string }) => m.name)).toContain('crm_win_rate')
        const mrr = await call('metric', { name: 'stripe_mrr' })
        expect(mrr).toMatchObject({ status: 'ok', trust: { status: 'passed' } })
        expect((await call('reconcile')).passed).toBe(true)
      } finally {
        await client.close()
      }
    } finally {
      await stripe.close()
    }
  }, 120_000)

  it('a B2B workspace syncs a stand-in HubSpot and checks the pull against HubSpot\'s own count', async () => {
    const { deals, contacts } = sampleHubspot()
    const bodies: string[] = []
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => {
        if (req.headers.authorization !== 'Bearer pat-na1-fake') return void res.writeHead(401).end('{}')
        const json = (b: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(b))
        if (url.pathname === '/account-info/v3/details') return json({ portalId: 123, companyCurrency: 'USD' })
        const m = url.pathname.match(/^\/crm\/v3\/objects\/(deals|contacts)(\/search)?$/)
        if (!m) return void res.writeHead(404).end('{}')
        const all = m[1] === 'deals' ? deals : contacts
        if (m[2]) {
          bodies.push(raw)
          return json({ total: all.length, results: [] })
        }
        const after = Number(url.searchParams.get('after') ?? 0)
        const page = all.slice(after, after + 100)
        // HubSpot also sends properties nobody asked for. They must not survive.
        json({ results: page.map((r) => ({ ...r, properties: { ...r.properties, email: 'someone@example.com', firstname: 'Someone' } })), ...(after + 100 < all.length ? { paging: { next: { after: String(after + 100) } } } : {}) })
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const env = { LIFECYCLE_HUBSPOT_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, HUBSPOT_TOKEN: 'pat-na1-fake', LIFECYCLE_HUBSPOT_TOKEN: 'pat-na1-fake' }
    try {
      expect((await cli(['init', '--type', 'b2b'], env)).status).toBe(0)
      const c = await cli(['connect', 'hubspot', '--token-env', 'HUBSPOT_TOKEN'], env)
      expect(c.status, c.stderr).toBe(0)
      expect(c.json()).toMatchObject({ connected: true, portal: '123', currency: 'usd' })
      const sync = await cli(['sync'], env)
      expect(sync.status, sync.stderr).toBe(0)
      expect(sync.json().reconcile.checks.filter((x: { status: string }) => x.status === 'fail')).toEqual([])
      expect(sync.json().reconcile.checks.find((x: { name: string }) => x.name === 'deals_complete')).toMatchObject({ status: 'pass', expected: 240, actual: 240 })
      const q = await cli(['query', 'SELECT sum(contacts)::int AS n FROM fact_crm_contacts_daily'], env)
      expect(q.json().rows).toEqual([{ n: 600 }])
      const db = readdirSync(join(home, 'pgdata'))
      expect(db.length).toBeGreaterThan(0)
      // Nothing about a person reached the database folder.
      const dump = spawnSync('grep', ['-rl', 'someone@example.com', join(home, 'pgdata')], { encoding: 'utf8' })
      expect(dump.stdout).toBe('')
      const run = await cli(['metrics', 'run', 'crm_deals_won', 'crm_win_rate', 'crm_new_leads'], env)
      expect(run.json().trust.line).toMatch(/against HubSpot/)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, 120_000)

  it('a store install from 0.13 keeps its demo, metric list and trust line', async () => {
    writeConfig({ database: { kind: 'local' } })
    const demo = await cli(['demo'])
    expect(demo.status).toBe(0)
    expect(demo.json().broken.checks.map((c: { name: string }) => c.name)).toEqual(['orders_complete', 'orders_vs_cohorts', 'klaviyo_orders', 'ga4_purchases', 'attributed_share', 'flow_totals', 'freshness'])
    const list = await cli(['metrics', 'list'])
    expect(list.json().map((m: { name: string }) => m.name)).toEqual(METRICS.map((m) => m.name))
    expect(existsSync(join(home, 'config.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).workspace).toBeUndefined()
  }, 60_000)
})

describe('0.14.0', () => {
  it('is version 0.14.0 everywhere a version is written, and documents workspaces', async () => {
    const { VERSION } = await import('../src/version.js')
    const { DOCS } = await import('../src/docs.js')
    // 0.14.1: was toBe('0.14.0'); 0.15.0: was a 0.14.x match. A version bump has to change it. package.json and the lock must still agree.
    expect(VERSION).toMatch(/^0\.1[4-8]\.\d+$/)
    expect(JSON.parse(readFileSync('package-lock.json', 'utf8')).version).toBe(VERSION)
    expect(readFileSync('CHANGELOG.md', 'utf8')).toMatch(/^## 0\.14\.0 \(2026-11-24\)/m)
    expect(DOCS.workspaces).toMatch(/unreferenced/)
    for (const f of ['docs/WORKSPACES.md', 'CHANGELOG.md', 'README.md']) expect(readFileSync(f, 'utf8')).not.toMatch(/[–—]/)
  })
})

describe('doctor and deploy outside a store', () => {
  it('asks a SaaS workspace for Stripe, not Klaviyo and Shopify, and plans its daily sync with only its own keys', async () => {
    writeConfig({ database: { kind: 'local' }, workspace: { type: 'saas' }, stripe: { mode: 'test', subscriptions: true }, hubspot: { portal: '1', currency: 'usd' } })
    const { doctor } = await import('../src/commands/doctor.js')
    const r = await doctor()
    expect(r.checks.map((c) => c.name)).not.toContain('klaviyo')
    expect(r.checks.map((c) => c.name)).not.toContain('shopify')
    expect(r.checks.find((c) => c.name === 'reference')).toMatchObject({ ok: true })
    const { deployPlan, workflowYaml } = await import('../src/deploy.js')
    const plan = deployPlan(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), 'me/sync')
    expect(plan.secrets).toEqual(['LIFECYCLE_DATABASE_URL', 'LIFECYCLE_HUBSPOT_TOKEN', 'LIFECYCLE_STRIPE_READ_KEY'])
    expect(workflowYaml(false, true, [], false, false, true)).toContain('LIFECYCLE_HUBSPOT_TOKEN: ${{ secrets.LIFECYCLE_HUBSPOT_TOKEN }}')
    expect(workflowYaml(false)).toBe(workflowYaml(false, false, [], false, false, false))
  })
})

// 0.15.0: was the 0.14.1 check; a version bump has to change it.
describe('0.15.0', () => {
  it('is version 0.15.1 everywhere a version is written, and its changelog has no dash a person would not type', async () => {
    const { VERSION } = await import('../src/version.js')
    // 0.17.0: was toBe('0.15.1'); the exact version now lives in release-0170.test.ts.
    expect(VERSION).toMatch(/^0\.1[5-8]\.\d+$/)
    expect(JSON.parse(readFileSync('package-lock.json', 'utf8')).version).toBe(VERSION)
    const log = readFileSync('CHANGELOG.md', 'utf8')
    expect(log).toMatch(/^## 0\.15\.1 \(2026-11-25\)/m)
    expect(log).toMatch(/^## 0\.15\.0 \(2026-11-25\)/m)
    expect(log).toMatch(/^## 0\.14\.1 \(2026-11-25\)/m)
    expect(log).not.toMatch(/^## Unreleased/m)
    expect(log).not.toMatch(/[–—]/)
  })
})
