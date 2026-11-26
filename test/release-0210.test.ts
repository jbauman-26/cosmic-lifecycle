import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkSchemaSettings, discoverTables, freshnessTrust, FRESHNESS_ONLY, pipelineQueryRun, schemasIn, tableFreshness,
  type PipelineConn,
} from '../src/pipeline-tables.js'
import type { Query } from '../src/pipeline.js'
import { CliError } from '../src/errors.js'
import { TYPES } from '../src/workspace.js'

// 0.21.0: any table a Fivetran or Airbyte loader writes into the person's own Postgres, read in place.
// No Postgres in CI: a fake database answers the same queries a real one would, in Fivetran's HubSpot shape.

const HOUR = 3600000
type Table = { columns: [string, string][]; rows: Record<string, unknown>[] }
function fakeDb(tables: Record<string, Table>, schema = 'hubspot') {
  const seen: string[] = []
  const query: Query = async (sql, params = []) => {
    seen.push(sql)
    if (sql.includes('information_schema.columns') && sql.includes('ordinal_position')) {
      if (params[0] !== schema) return []
      return Object.entries(tables).flatMap(([t, d]) => d.columns.map(([column_name, data_type]) => ({ table_name: t, column_name, data_type })))
    }
    if (sql.includes('information_schema.columns') && sql.includes('column_name = $3')) {
      const t = tables[String(params[1])]
      return t?.columns.some(([c]) => c === params[2]) ? [{ '?column?': 1 }] : []
    }
    const max = /SELECT max\("(\w+)"\) AS at FROM "(\w+)"\."(\w+)"/.exec(sql)
    if (max) {
      const rows = tables[max[3]!]!.rows
      const vals = rows.map((r) => r[max[1]!]).filter(Boolean).map((v) => Date.parse(String(v)))
      return [{ at: vals.length ? new Date(Math.max(...vals)).toISOString() : null }]
    }
    throw new Error(`fake db: unexpected SQL ${sql}`)
  }
  // EXPLAIN: the relations the SQL names, the way Postgres would report them (test only: a simple match).
  const readOnly: PipelineConn['readOnly'] = async (sql, params) => {
    if (sql.startsWith('EXPLAIN')) {
      const rels = [...sql.matchAll(/(?:FROM|JOIN)\s+"?(\w+)"?\s*\.\s*"?(\w+)"?/gi)].map((m) => ({ 'Node Type': 'Seq Scan', 'Relation Name': m[2], Schema: m[1] }))
      return [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Aggregate', Plans: rels } }] }]
    }
    if (sql.includes('information_schema') || sql.includes('max(')) return query(sql, params)
    seen.push(sql)
    return [{ n: 40, note: 'call me at person1@example.com' }]
  }
  const conn: PipelineConn = { query, readOnly, close: async () => undefined }
  return { query, conn, seen }
}

const now = Date.now()
const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString()
const hubspot = () => fakeDb({
  contact: {
    columns: [['id', 'bigint'], ['property_email', 'text'], ['property_firstname', 'text'], ['property_phone', 'text'], ['property_lifecyclestage', 'text'], ['_fivetran_synced', 'timestamptz']],
    rows: [{ _fivetran_synced: at(2) }],
  },
  deal: { columns: [['deal_id', 'bigint'], ['property_amount', 'numeric'], ['property_dealstage', 'text'], ['_fivetran_synced', 'timestamptz']], rows: [{ _fivetran_synced: at(3) }] },
  company: { columns: [['id', 'bigint'], ['property_name', 'text'], ['_fivetran_synced', 'timestamptz']], rows: [{ _fivetran_synced: at(5 * 24) }] },
  fivetran_audit: { columns: [['id', 'text'], ['message', 'text']], rows: [] },
  _fivetran_setup_test: { columns: [['x', 'int']], rows: [] },
})

describe('discovery', () => {
  it('lists the schema\'s tables and leaves out loader bookkeeping', async () => {
    const { query } = hubspot()
    const t = await discoverTables(query, 'fivetran', 'hubspot')
    expect(t.map((x) => x.table).sort()).toEqual(['company', 'contact', 'deal'])
    expect(t.find((x) => x.table === 'deal')!.loadedAtColumn).toBe('_fivetran_synced')
  })

  it('refuses a schema with no tables, with a next step', async () => {
    const { query } = hubspot()
    await expect(discoverTables(query, 'fivetran', 'salesforce')).rejects.toMatchObject({ code: 'pipeline_table_missing' })
  })

  it('checks the tool, schema and variable names before connecting', () => {
    expect(() => checkSchemaSettings('stitch', 'hubspot', 'PIPELINE_DATABASE_URL')).toThrow(CliError)
    expect(() => checkSchemaSettings('fivetran', 'Hub Spot', 'PIPELINE_DATABASE_URL')).toThrow(CliError)
    expect(() => checkSchemaSettings('fivetran', 'public', 'PIPELINE_DATABASE_URL')).toThrow(CliError)
    expect(() => checkSchemaSettings('fivetran', 'hubspot', 'postgres://x')).toThrow(CliError)
    expect(() => checkSchemaSettings('airbyte', 'hubspot', 'PIPELINE_DATABASE_URL')).not.toThrow()
  })

  it('finds the schemas a query names, and not lookalikes', () => {
    expect(schemasIn('SELECT count(*) FROM hubspot.deal d JOIN "salesforce".opportunity o ON true', ['hubspot', 'salesforce', 'stripe'])).toEqual(['hubspot', 'salesforce'])
    expect(schemasIn('SELECT * FROM fact_orders_daily', ['hubspot'])).toEqual([])
    expect(schemasIn('SELECT * FROM my_hubspot.deal', ['hubspot'])).toEqual([])
  })
})

describe('personal data', () => {
  it('marks email, name and phone columns personal with the existing rules', async () => {
    const { query } = hubspot()
    const contact = (await discoverTables(query, 'fivetran', 'hubspot')).find((t) => t.table === 'contact')!
    const personal = contact.columns.filter((c) => c.personal).map((c) => c.name)
    expect(personal).toEqual(expect.arrayContaining(['property_email', 'property_firstname', 'property_phone']))
    expect(personal).not.toContain('property_lifecyclestage')
  })

  it('refuses a query that reads a personal column, before it runs', async () => {
    const { conn, seen } = hubspot()
    await expect(pipelineQueryRun(conn, [{ schema: 'hubspot', tool: 'fivetran' }], 'SELECT property_email FROM hubspot.contact', 100, 2)).rejects.toThrow(/personal/)
    expect(seen.some((s) => s.includes('property_email FROM'))).toBe(false)
  })

  it('refuses writes', async () => {
    const { conn } = hubspot()
    await expect(pipelineQueryRun(conn, [{ schema: 'hubspot', tool: 'fivetran' }], 'DELETE FROM hubspot.deal', 100, 2)).rejects.toMatchObject({ code: 'read_only' })
  })

  it('scrubs an email address out of returned text', async () => {
    const { conn } = hubspot()
    const r = await pipelineQueryRun(conn, [{ schema: 'hubspot', tool: 'fivetran' }], 'SELECT count(*) AS n FROM hubspot.deal', 100, 2)
    expect(JSON.stringify(r.rows)).not.toContain('person1@example.com')
    expect(r.redacted).toBe(1)
  })
})

describe('freshness, and the trust line that never says passed', () => {
  it('reads each table\'s last load from _fivetran_synced', async () => {
    const { query } = hubspot()
    const f = await tableFreshness(query, 'fivetran', 'hubspot', ['contact', 'company'], 2, now)
    expect(f.find((x) => x.table === 'contact')).toMatchObject({ status: 'fresh', ageHours: 2 })
    expect(f.find((x) => x.table === 'company')).toMatchObject({ status: 'stale' })
  })

  it('uses _airbyte_extracted_at for Airbyte, and says unknown when a table has no load column', async () => {
    const { query } = fakeDb({ deals: { columns: [['id', 'text'], ['_airbyte_extracted_at', 'timestamptz']], rows: [{ _airbyte_extracted_at: at(1) }] }, notes: { columns: [['id', 'text']], rows: [] } })
    const f = await tableFreshness(query, 'airbyte', 'hubspot', ['deals', 'notes'], 2, now)
    expect(f.map((x) => x.status)).toEqual(['fresh', 'unknown'])
  })

  it('a fresh answer says freshness only, not reconciled, and never passed', async () => {
    const { conn } = hubspot()
    const r = await pipelineQueryRun(conn, [{ schema: 'hubspot', tool: 'fivetran' }], 'SELECT count(*) AS n FROM hubspot.deal', 100, 2)
    expect(r.trust.status).toBe('freshness_only')
    expect(r.trust.line).toContain('hubspot.deal loaded 3 hours ago')
    expect(r.trust.line).toContain(FRESHNESS_ONLY)
    expect(r.trust.line).toContain('not reconciled')
    expect(r.trust.line.toLowerCase()).not.toContain('passed')
  })

  it('a stale table says STALE, and still freshness only', async () => {
    const { conn } = hubspot()
    const r = await pipelineQueryRun(conn, [{ schema: 'hubspot', tool: 'fivetran' }], 'SELECT count(*) FROM hubspot.company', 100, 2)
    expect(r.trust.status).toBe('stale')
    expect(r.trust.line).toMatch(/^STALE: hubspot\.company last loaded 5 days ago/)
    expect(r.trust.line.toLowerCase()).not.toContain('passed')
  })

  it('no wording the trust line can produce says passed', () => {
    for (const status of ['fresh', 'stale', 'unknown'] as const) {
      const t = freshnessTrust('hubspot', [{ table: 't', lastLoaded: status === 'unknown' ? null : at(1), ageHours: status === 'unknown' ? null : 1, status }], 2)
      expect(t.line.toLowerCase()).not.toMatch(/passed|reconciled against (stripe|shopify|hubspot)/)
      expect(t.line).toContain(FRESHNESS_ONLY)
    }
  })
})

describe('review blockers: protection never depends on the SQL text', () => {
  const planned = (rels: [string, string][]) => {
    const { query, conn } = hubspot()
    conn.readOnly = async (sql, params) => {
      if (sql.startsWith('EXPLAIN')) return [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Nested Loop', Plans: rels.map(([Schema, r]) => ({ 'Node Type': 'Seq Scan', Schema, 'Relation Name': r })) } }] }]
      if (sql.includes('information_schema') || sql.includes('max(')) return query(sql, params)
      return [{ n: 1 }]
    }
    return conn
  }
  const run = (conn: PipelineConn, sql: string) => pipelineQueryRun(conn, [{ schema: 'hubspot', tool: 'fivetran' }], sql, 100, 2)

  it('refuses a table in an unregistered schema, even when the SQL text names a registered one', async () => {
    const conn = planned([['public', 'customers']])
    await expect(run(conn, "SELECT full_name, id FROM public.customers WHERE 'hubspot.' <> ''")).rejects.toMatchObject({ code: 'not_connected', message: expect.stringContaining('public.customers') })
  })

  it('refuses a table hidden behind a comment before the dot', async () => {
    const conn = planned([['salesforce', 'lead'], ['hubspot', 'deal']])
    await expect(run(conn, 'SELECT first_name FROM salesforce/**/.lead CROSS JOIN (SELECT count(*) FROM hubspot.deal) z')).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('refuses loader bookkeeping and staging tables inside a registered schema', async () => {
    for (const t of ['_contact_staging', 'fivetran_audit']) {
      await expect(run(planned([['hubspot', t]]), `SELECT * FROM hubspot.${t}`)).rejects.toMatchObject({ code: 'not_connected' })
    }
  })

  it('marks loader columns the shared rules miss: mobile phones, handles, job titles, bodies, raw JSON', async () => {
    const { markTable } = await import('../src/pipeline-tables.js')
    const cols = markTable('hubspot', 'contact', [
      { name: 'property_mobilephone', type: 'text' }, { name: 'property_twitterhandle', type: 'text' }, { name: 'property_jobtitle', type: 'text' },
      { name: 'title', type: 'text' }, { name: 'body', type: 'text' }, { name: 'html', type: 'text' }, { name: '_airbyte_data', type: 'jsonb' },
      { name: 'properties', type: 'jsonb' }, { name: 'property_amount', type: 'numeric' }, { name: 'property_dealstage', type: 'text' },
    ])
    expect(cols.filter((c) => c.personal).map((c) => c.name)).toEqual(['property_mobilephone', 'property_twitterhandle', 'property_jobtitle', 'title', 'body', 'html', '_airbyte_data', 'properties'])
  })


  it('refuses a personal column read through a view or an expression, by what Postgres reads', async () => {
    const { query, conn } = hubspot()
    conn.readOnly = async (sql, params) => sql.startsWith('EXPLAIN')
      ? [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Seq Scan', Schema: 'hubspot', 'Relation Name': 'contact', Output: ['contact.id', 'contact.property_email'] } }] }]
      : (sql.includes('information_schema') || sql.includes('max(')) ? query(sql, params) : [{ addr: 'x' }]
    await expect(pipelineQueryRun(conn, [{ schema: 'hubspot', tool: 'fivetran' }], 'SELECT addr FROM hubspot.contact_view', 100, 2)).rejects.toThrow(/property_email is marked personal/)
  })
  it('says when deleted source rows are still in the table', async () => {
    const { query, conn } = fakeDb({ deal: { columns: [['deal_id', 'bigint'], ['_fivetran_deleted', 'boolean'], ['_fivetran_synced', 'timestamptz']], rows: [{ _fivetran_synced: at(1) }] } })
    conn.readOnly = async (sql, params) => sql.startsWith('EXPLAIN') ? [{ 'QUERY PLAN': [{ Plan: { Schema: 'hubspot', 'Relation Name': 'deal' } }] }] : (sql.includes('information_schema') || sql.includes('max(')) ? query(sql, params) : [{ n: 1 }]
    const r = await pipelineQueryRun(conn, [{ schema: 'hubspot', tool: 'fivetran' }], 'SELECT count(*) FROM hubspot.deal', 100, 2)
    expect(r.notes?.join(' ')).toContain('_fivetran_deleted')
  })
})

describe('clean install fixes', () => {
  // The daily sync workflow keeps `npx lifecycle`, so a repo pinned to an older install still runs.
  it('every hint says cosmic, not lifecycle', () => {
    const files = [...readdirSync('src').map((f) => join('src', f)), ...readdirSync('src/commands').map((f) => join('src/commands', f)), ...readdirSync('src/sources').map((f) => join('src/sources', f))]
      .filter((f) => f.endsWith('.ts'))
    const cmds = 'init|sync|connect|disconnect|schema|query|metrics|reconcile|doctor|docs|sources|warehouse|kits|skills|deploy|login|config|costs|notes|verdict|demo|mcp'
    const found = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(new RegExp(`(?<!npx )\\blifecycle (${cmds})\\b`, 'g'))].map((m) => `${f}: ${m[0]}`))
    expect(found).toEqual([])
  })

  it('a SaaS workspace is not pointed at PostHog, which is planned only', async () => {
    // The type list still names it; init and `workspace` filter planned sources out (src/cli.ts connectable).
    const { findSource } = await import('../src/warehouse.js')
    expect(TYPES.saas.sources).toContain('posthog')
    expect(findSource('posthog').readiness).toBe('planned')
    expect(readFileSync('src/cli.ts', 'utf8')).toMatch(/connectable\(t\.sources\)\.join/)
  })
  it('sources list puts the workspace type\'s usual sources first, and lists pipeline schemas', async () => {
    const { sourceStatus, EASY_SETUP } = await import('../src/sources-catalog.js')
    const home = process.env.LIFECYCLE_HOME
    const dir = mkdtempSync(join(tmpdir(), 'cosmic-0210-'))
    const config = { database: { kind: 'local' }, workspace: { type: 'saas' }, pipeline: { sources: {}, schemas: { hubspot: { tool: 'fivetran', urlEnv: 'X', connectedAt: 'now', tables: ['deal', 'contact'] } } } }
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
    process.env.LIFECYCLE_HOME = dir
    try {
      const r = await sourceStatus(config as never, () => false, null)
      expect(r.slice(0, 4).map((s) => s.slug)).toEqual(['stripe', 'ga4', 'meta', 'hubspot'])
      expect(r.find((s) => s.slug === 'pipeline:hubspot')).toMatchObject({ connected: true, name: expect.stringContaining('freshness checked only') })
      expect(EASY_SETUP).toContain('cosmic docs quickstart')
    } finally {
      if (home === undefined) delete process.env.LIFECYCLE_HOME
      else process.env.LIFECYCLE_HOME = home
    }
  })
})
