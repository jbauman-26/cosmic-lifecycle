import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeConfig } from '../src/config.js'
import { WAREHOUSE_CATALOG } from '../src/warehouse-catalog.js'
import { addCustomSource, connectSource, disconnectSource, duckQuery, duckSchema, explain, runRunner, searchCatalog, syncSources, uvAvailable } from '../src/warehouse.js'

const placeholders = (v: unknown, kind: 'secret' | 'param'): string[] => {
  const text = JSON.stringify(v ?? {})
  return [...text.matchAll(new RegExp(`\\{${kind}:([A-Za-z0-9_]+)\\}`, 'g'))].map((m) => m[1]!)
}

describe('warehouse catalog', () => {
  it('has unique slugs and the fields every entry needs', () => {
    const slugs = WAREHOUSE_CATALOG.map((s) => s.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const s of WAREHOUSE_CATALOG) {
      expect(s.slug, s.slug).toMatch(/^[a-z0-9][a-z0-9-]+$/)
      expect(s.name.length, s.slug).toBeGreaterThan(1)
      expect(s.category.length, s.slug).toBeGreaterThan(1)
      expect(s.why.length, s.slug).toBeGreaterThan(10)
      if (s.docs) expect(s.docs, s.slug).toMatch(/^https:\/\//)
    }
  })

  it('gives every connector a resource, and a credential or setting for every placeholder', () => {
    for (const s of WAREHOUSE_CATALOG) {
      if (s.readiness === 'planned' || s.readiness === 'native') {
        expect(s.config, `${s.slug} is ${s.readiness} so it has no connector`).toBeUndefined()
        continue
      }
      expect(s.config, s.slug).toBeDefined()
      const resources = (s.config as { resources?: { name: string }[] }).resources ?? []
      expect(resources.length, s.slug).toBeGreaterThan(0)
      expect(new Set(placeholders(s.config, 'secret')), s.slug).toEqual(new Set(s.credentials.map((c) => c.name)))
      expect(new Set(placeholders(s.config, 'param')), s.slug).toEqual(new Set(s.params.map((p) => p.name)))
      expect(s.tested ?? s.readiness, s.slug).toBeTruthy()
    }
  })

  it('only calls a connector tested when it says what it was tested on', () => {
    for (const s of WAREHOUSE_CATALOG.filter((x) => x.readiness === 'tested')) expect(s.tested, s.slug).toMatch(/\w{10,}/)
  })

  it('searches by name, category and readiness', () => {
    const anyBuilt = WAREHOUSE_CATALOG.find((s) => s.readiness === 'built')
    if (anyBuilt) {
      expect(searchCatalog({ query: anyBuilt.name.slice(0, 4) }).some((s) => s.slug === anyBuilt.slug)).toBe(true)
      expect(searchCatalog({ category: anyBuilt.category }).every((s) => s.category === anyBuilt.category)).toBe(true)
    }
    expect(searchCatalog({ readiness: 'planned' }).every((s) => s.readiness === 'planned')).toBe(true)
  })

  it('turns common HTTP failures into plain words', () => {
    expect(explain('401 Client Error: Unauthorized')).toMatch(/rejected/)
    expect(explain('403 Client Error: Forbidden')).toMatch(/permission/)
    expect(explain('429 Too Many Requests')).toMatch(/rate limiting/)
  })
})

// End to end through uv and dlt against a local API. Skipped where uv is not installed.
describe.skipIf(!uvAvailable())('warehouse end to end', () => {
  let home: string
  let server: Server
  let port = 0

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'lc-wh-'))
    process.env.LIFECYCLE_HOME = home
    process.env.LIFECYCLE_NO_KEYCHAIN = '1'
    server = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer tok_123') {
        res.writeHead(401).end()
        return
      }
      const page = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('page') ?? '1')
      const data = page > 2 ? [] : [1, 2].map((n) => {
        const id = (page - 1) * 2 + n
        return { id, status: 'open', customer_email: `a${id}@x.com`, customer: { first_name: 'Ada', email: 'a@x.com', city: 'Austin' }, note: 'write to b@y.com', total: 10 * id }
      })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as { port: number }).port
    writeConfig({ database: { kind: 'local' } })
    const spec = {
      name: 'Mock Desk',
      category: 'helpdesk',
      credentials: [{ name: 'api_key', label: 'API key' }],
      config: {
        client: { base_url: `http://127.0.0.1:${port}/`, auth: { type: 'bearer', token: '{secret:api_key}' } },
        resource_defaults: { primary_key: 'id', write_disposition: 'merge' },
        resources: [{ name: 'tickets', endpoint: { path: 'tickets', data_selector: 'data', paginator: { type: 'page_number', page_param: 'page', base_page: 1, total_path: null } } }],
      },
    }
    writeFileSync(join(home, 'spec.json'), JSON.stringify(spec))
  }, 60_000)

  afterAll(() => {
    server?.close()
    rmSync(home, { recursive: true, force: true })
    delete process.env.LIFECYCLE_HOME
    delete process.env.LIFECYCLE_NO_KEYCHAIN
    delete process.env.MOCK_KEY
    delete process.env.LIFECYCLE_SRC_MOCK_DESK_API_KEY
  })

  it('adds a custom API, rejects a bad key, and saves a good one only after a check', async () => {
    expect(addCustomSource('mock-desk', join(home, 'spec.json')).added).toBe('mock-desk')
    process.env.MOCK_KEY = 'wrong'
    await expect(connectSource('mock-desk', { secret: ['api_key=MOCK_KEY'] })).rejects.toThrow(/rejected \(401\)/)
    process.env.MOCK_KEY = 'tok_123'
    const r = await connectSource('mock-desk', { secret: ['api_key=MOCK_KEY'] })
    expect(r.check).toEqual({ resource: 'tickets', rows: 2 })
    expect(r.keysSavedTo).toMatch(/LIFECYCLE_SRC_MOCK_DESK_API_KEY/)
  }, 180_000)

  it('loads every page, merges on a re-run, and strips personal data', async () => {
    process.env.LIFECYCLE_SRC_MOCK_DESK_API_KEY = 'tok_123'
    const first = await syncSources(['mock-desk'])
    expect(first[0]).toMatchObject({ source: 'mock-desk', status: 'ok', rows: 4 })
    await syncSources(['mock-desk'])
    const q = await duckQuery('select id, note, total from src_mock_desk.tickets order by id')
    expect(q.rows.map((r) => r.id)).toEqual([1, 2, 3, 4])
    expect(q.rows[0]!.note).toBe('write to [removed]')
    const cols = (await duckSchema('mock-desk')).map((c) => c.column)
    expect(cols).toContain('customer__city')
    expect(cols.some((c) => /email|first_name/.test(c))).toBe(false)
  }, 180_000)

  it('blocks writes and file access from warehouse queries', async () => {
    await expect(duckQuery('delete from src_mock_desk.tickets')).rejects.toThrow(/Only SELECT/)
    await expect(duckQuery(`select * from read_csv('/etc/hosts')`)).rejects.toThrow(/disabled|external|Permission/i)
  }, 120_000)

  it('disconnects and forgets the source', () => {
    expect(disconnectSource('mock-desk').disconnected).toBe('mock-desk')
  })
})

// Every built connector must load in dlt: catches a broken paginator, auth or path in any spec.
describe.skipIf(!uvAvailable())('built connectors load in dlt', () => {
  for (const s of WAREHOUSE_CATALOG.filter((x) => x.readiness === 'built')) {
    it(s.slug, async () => {
      const r = await runRunner({ action: 'validate', source: { slug: s.slug, config: s.config } }, {})
      expect(r.ok ? 'ok' : (r as { error: string }).error).toBe('ok')
      const resources = (s.config as { resources: { name: string }[] }).resources.map((x) => x.name)
      expect((r as { resources?: string[] }).resources).toEqual(resources)
    }, 60_000)
  }
})
