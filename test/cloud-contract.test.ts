import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CloudClient, verifyLogin } from '../src/cloud.js'
import { CliError } from '../src/errors.js'
import { accountSkillFiles } from '../src/skills.js'
import { cloudRunRecord } from '../src/tools.js'

// The CLI's half of the contract with Cosmic Cloud API v1. test/fixtures/cloud-replies.json holds replies
// recorded from the real Cloud handlers while this CLI ran against them (cosmic-cloud test/cli-contract.test.ts,
// with RECORD_CLI_REPLIES). Here the client reads each recorded reply, so a change on either side that breaks
// a shape or a code fails one of the two repos. Re-record after a Cloud change: see that test's header.
type Reply = { method: string; path: string; status: number; body: any }
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'cloud-replies.json'), 'utf8')) as { cli: string; replies: Reply[] }

function reply(method: string, path: string, status: number, code?: string): Reply {
  const r = fixture.replies.find((x) => x.method === method && x.path.split('?')[0] === `/api/v1${path}` && x.status === status && (code === undefined || x.body?.error?.code === code))
  if (!r) throw new Error(`No recorded reply for ${method} ${path} ${status} ${code ?? ''}`)
  return r
}

// A client whose next call gets the recorded reply, and which checks it asked for the right route.
function client(r: Reply) {
  const asked: string[] = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    asked.push(`${init.method} ${new URL(url).pathname}`)
    return new Response(r.body === null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const c = new CloudClient({ url: 'https://cloud.example.com', token: 'cck_0123456789ab_replay-token-for-tests-only-00000000000000', fetch: fetchFn })
  return { c, asked, fetchFn }
}
const code = async (p: Promise<unknown>) => p.then(() => 'no error', (e) => (e instanceof CliError ? e.code : `not a CliError: ${e}`))

describe(`replies recorded from Cosmic Cloud (CLI ${fixture.cli})`, () => {
  it('GET /store: login and cloud status read the store and its connections', async () => {
    const r = reply('GET', '/store', 200)
    const { fetchFn } = client(r)
    const v = await verifyLogin('https://cloud.example.com', 'cck_0123456789ab_replay-token-for-tests-only-00000000000000', fetchFn)
    expect(v.store.name).toBe('Contract store')
    expect(v.connections).toBe(1)
    expect(r.body.contract_version).toBe('1.2.0')
    expect(r.body.connections[0]).toMatchObject({ id: expect.stringMatching(/^c_/), source_id: 'klaviyo', source_name: 'Klaviyo', freshness: expect.any(String) })
  })

  it('GET /schema, POST /query and its refusals', async () => {
    const s = await client(reply('GET', '/schema', 200)).c.schema()
    expect(s.schemas.length).toBe(1)
    expect(s.schemas[0]!.tables.find((t) => t.name === 'fact_orders_daily')!.columns).toContainEqual({ name: 'net_revenue', type: 'numeric' })
    const q = await client(fixture.replies.find((x) => x.path === '/api/v1/query' && x.status === 200 && x.body.columns?.[0]?.name === '?column?')!).c.query('select 1')
    expect(q).toEqual({ columns: ['?column?'], rows: [{ '?column?': 1 }], rowCount: 1, truncated: false })
    expect(await code(client(reply('POST', '/query', 422, 'blocked_object')).c.query('SELECT * FROM cloud.tenants'))).toBe('blocked_object')
    expect(await code(client(reply('POST', '/query', 422, 'query_failed')).c.query('SELECT nope FROM fact_orders_daily'))).toBe('query_failed')
    expect(await code(client(reply('POST', '/query', 401)).c.query('select 1'))).toBe('unauthorized')
  })

  it('GET /metrics and GET /metrics/:name, with unknown_metric', async () => {
    const list = await client(reply('GET', '/metrics', 200)).c.metrics()
    expect(list.map((m) => m.name)).toContain('shopify_orders')
    const m = await client(reply('GET', '/metrics/shopify_orders', 200)).c.metric('shopify_orders', 30)
    expect(m).toMatchObject({ metric: 'shopify_orders', trust: { status: expect.any(String), line: expect.any(String) } })
    expect(await code(client(reply('GET', '/metrics/not_a_metric', 404)).c.metric('not_a_metric'))).toBe('unknown_metric')
  })

  it('GET /runs and POST /sync, with unknown_connection', async () => {
    const runs = await client(reply('GET', '/runs', 200)).c.runs(200)
    expect(runs[0]).toMatchObject({ source_id: 'klaviyo', status: 'ok', started_at: expect.any(String) })
    const sync = await client(reply('POST', '/sync', 202)).c.sync()
    expect(sync.started.length).toBe(1)
    expect(await code(client(reply('POST', '/sync', 404)).c.sync('c_notthisstore0'))).toBe('unknown_connection')
  })

  it('skills: the list has no file text, GET /skills/:slug does, and a missing skill is unknown_skill', async () => {
    const listed = fixture.replies.find((x) => x.method === 'GET' && x.path === '/api/v1/skills' && x.body.skills.length)!
    expect(listed.body.skills[0].files.every((f: any) => typeof f.content !== 'string')).toBe(true)
    const one = reply('GET', '/skills/weekly-look', 200)
    // skillsWithFiles reads the list, then each skill whole.
    let n = 0
    const fetchFn = (async () => new Response(JSON.stringify(n++ === 0 ? listed.body : one.body), { status: 200 })) as unknown as typeof fetch
    const whole = await new CloudClient({ url: 'https://cloud.example.com', token: 'cck_0123456789ab_replay-token-for-tests-only-00000000000000', fetch: fetchFn }).skillsWithFiles()
    expect(accountSkillFiles(whole)).toMatchObject({ installed: ['weekly-look'], skipped: [] })
    expect(await client(reply('PUT', '/skills/weekly-look', 201)).c.putSkill('weekly-look', [{ path: 'SKILL.md', content: '# x' }])).toMatchObject({ created: true })
    expect(await client(reply('DELETE', '/skills/weekly-look', 200)).c.deleteSkill('weekly-look')).toEqual({ slug: 'weekly-look', deleted: true })
    expect(await code(client(reply('DELETE', '/skills/not-there', 404)).c.deleteSkill('not-there'))).toBe('unknown_skill')
  })

  it('POST /tools/runs: 201 for a new id, 200 for the same id again', async () => {
    const rec = cloudRunRecord({ id: 'run_contract1', tool: 'apify:x~y', provider: 'apify', input: {}, status: 'running', startedAt: new Date().toISOString(), finishedAt: '' })
    expect(await client(reply('POST', '/tools/runs', 201)).c.postToolRun(rec)).toMatchObject({ created: true })
    expect(await client(reply('POST', '/tools/runs', 200)).c.postToolRun(rec)).toMatchObject({ created: false, run: { id: 'run_contract1', provider: 'apify' } })
    expect((await client(reply('GET', '/tools/runs', 200)).c.toolRuns()).length).toBeGreaterThan(0)
  })

  it('a route Cloud does not have is 404 not_found, which the CLI calls not_built', async () => {
    const r = reply('GET', '/no-such-route', 404)
    expect(r.body.error.code).toBe('not_found')
    expect(await code(client(r).c.schema())).toBe('not_built')
  })
})
