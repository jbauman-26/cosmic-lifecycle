import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
// @ts-expect-error a plain script, shared with manual runs
import { FAKE_TOKEN, startFakeCloud } from './fixtures/fake-cloud.mjs'
import { CloudClient, cloudUrl, DEFAULT_CLOUD_URL, normalizeCloudUrl, verifyLogin } from '../src/cloud.js'
import { CliError } from '../src/errors.js'
import { HttpError } from '../src/http.js'
import { readRawConfig, setSetting, writeConfig } from '../src/config.js'
import { abortRun, startOpenTool, type OpenContext } from '../src/open-tools.js'
import { cloudRunRecord, getRun, redactSecrets, runTool, saveRun, type ToolContext, type ToolRun } from '../src/tools.js'
import { accountSkillFiles, findSecrets, readSkillDir, SKILL_MAX_BYTES, skillsStatus, syncSkills, targetDir, uninstallSkills } from '../src/skills.js'
import { ensureRegistry, showKit } from '../src/registry.js'
import { loaderFailed, syncSources } from '../src/warehouse.js'
import { DOCS } from '../src/docs.js'
import { SECRET_NAMES, envName } from '../src/secrets.js'
import { VERSION } from '../src/version.js'

type Fake = { url: string; token: string; requests: { method: string; path: string; query: string; authorization: string | null; body: any }[]; skills: Map<string, { path: string; content: string }[]>; toolRuns: any[]; close: () => Promise<void> }

let home: string
let fakes: Fake[] = []
const realHome = process.env.HOME
const fakeCloud = async (opts: Record<string, unknown> = {}): Promise<Fake> => {
  const f = (await startFakeCloud(opts)) as Fake
  fakes.push(f)
  return f
}
const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e instanceof CliError ? e.code : `not a CliError: ${e}`
  }
  return 'no error'
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lc-0130-'))
  process.env.LIFECYCLE_HOME = home
  process.env.LIFECYCLE_NO_KEYCHAIN = '1'
  process.env.HOME = home
})
afterEach(async () => {
  for (const f of fakes) await f.close()
  fakes = []
  rmSync(home, { recursive: true, force: true })
  process.env.HOME = realHome
  for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'LIFECYCLE_CLOUD_URL', 'LIFECYCLE_CLOUD_TOKEN', 'LIFECYCLE_UV_PATH']) delete process.env[k]
  vi.unstubAllGlobals()
})

// The real CLI in its own process, against the fake Cloud in this one. Async, so the fake can answer.
const cli = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string; json: () => any; error: () => any }>((done) => {
    const child = spawn(process.execPath, [resolve('node_modules', 'tsx', 'dist', 'cli.mjs'), resolve('src', 'cli.ts'), '--format', 'json', ...args], {
      env: { ...process.env, LIFECYCLE_HOME: home, HOME: home, LIFECYCLE_NO_KEYCHAIN: '1', LIFECYCLE_NO_UPDATE_CHECK: '1', ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => done({ status, stdout, stderr, json: () => JSON.parse(stdout), error: () => JSON.parse(stderr.trim().split('\n').pop()!) }))
  })

describe('the Cloud client', () => {
  it('sends the token as a bearer header and reads every route in the table', async () => {
    const f = await fakeCloud()
    const c = new CloudClient({ url: f.url, token: f.token })
    expect((await c.store()).store.name).toBe('Sample store')
    expect((await c.schema()).schemas[0]!.tables[0]).toMatchObject({ name: 'fact_orders_daily', rows: 90, columns: [{ name: 'date', type: 'date' }, { name: 'orders', type: 'integer' }] })
    // Cloud sends typed columns and rows as objects; they leave as column names and objects keyed by column.
    const want = { columns: ['date', 'orders'], rows: [{ date: '2026-11-23', orders: 14 }, { date: '2026-11-24', orders: 9 }], rowCount: 2, truncated: false }
    expect(await c.query('SELECT date, orders FROM fact_orders_daily')).toEqual(want)
    // Rows sent as arrays come out the same.
    const arrays = await fakeCloud({ arrayRows: true })
    expect(await new CloudClient({ url: arrays.url, token: arrays.token }).query('SELECT date, orders FROM fact_orders_daily')).toEqual(want)
    expect((await c.metrics()).map((m) => m.name)).toEqual(['shopify_orders', 'repeat_orders'])
    expect(await c.metric('shopify_orders', 30)).toMatchObject({ metric: 'shopify_orders', days: 30, value: 412 })
    expect((await c.runs(1)).length).toBe(1)
    expect(await c.sync('c_klaviyo000001')).toEqual({ started: ['c_klaviyo000001'], already_running: [] })
    expect((await c.sync()).started.length).toBe(2)
    await c.putSkill('winback-brief', [{ path: 'SKILL.md', content: '# Winback' }])
    // The list leaves the file text out, as Cloud does; skillsWithFiles reads each skill whole.
    expect(await c.skills()).toEqual([{ slug: 'winback-brief', bytes: 17, files: [{ path: 'SKILL.md', bytes: 9 }] }])
    expect(await c.skillsWithFiles()).toEqual([{ slug: 'winback-brief', bytes: 17, files: [{ path: 'SKILL.md', content: '# Winback' }] }])
    expect(await code(c.skill('not-there'))).toBe('unknown_skill')
    await c.deleteSkill('winback-brief')
    expect(await c.skills()).toEqual([])
    await c.postToolRun({ id: 'abc' })
    expect(await c.toolRuns()).toEqual([{ id: 'abc' }])

    expect(f.requests.every((r) => r.authorization === `Bearer ${f.token}`)).toBe(true)
    expect(f.requests.map((r) => `${r.method} ${r.path}${r.query}`)).toEqual(expect.arrayContaining(['GET /store', 'GET /schema', 'POST /query', 'GET /metrics', 'GET /metrics/shopify_orders?days=30', 'GET /runs?limit=1', 'POST /sync', 'PUT /skills/winback-brief', 'DELETE /skills/winback-brief', 'POST /tools/runs']))
    // The token is in the header only: never in a path, a query or a body.
    expect(JSON.stringify(f.requests.map(({ authorization, ...rest }) => rest))).not.toContain(f.token)
    expect(f.requests.find((r) => r.path === '/sync' && r.body)!.body).toEqual({ connection_id: 'c_klaviyo000001' })
  })

  it('maps a route Cloud has not built yet to not_built, with a plain sentence', async () => {
    const f = await fakeCloud({ missing: ['/schema', '/query', '/metrics', '/runs', '/skills', '/tools/runs'] })
    const c = new CloudClient({ url: f.url, token: f.token })
    for (const call of [() => c.schema(), () => c.query('SELECT 1'), () => c.metrics(), () => c.runs(), () => c.skills(), () => c.putSkill('x', []), () => c.postToolRun({})]) {
      expect(await code(call())).toBe('not_built')
    }
    const e = await c.schema().catch((x) => x as CliError)
    expect(e.message).toBe('Cosmic Cloud does not have this yet (GET /schema).')
    expect(e.next).toMatch(/without --cloud/)
    // The store route exists, so login still works against an older Cloud.
    expect((await c.store()).store.id).toBe('sample_store')
  })

  it('passes a named 404 through, so an unknown metric is not called unbuilt', async () => {
    const f = await fakeCloud()
    const e = await new CloudClient({ url: f.url, token: f.token }).metric('nope').catch((x) => x as CliError)
    expect(e).toMatchObject({ code: 'unknown_metric', message: 'No metric named nope.' })
  })

  it('maps a refused token, a busy store and a rate limit, and never repeats the token', async () => {
    const f = await fakeCloud()
    const bad = await new CloudClient({ url: f.url, token: 'cck_wrong' }).store().catch((x) => x as CliError)
    expect(bad).toMatchObject({ code: 'unauthorized' })
    expect(`${bad.message} ${bad.next}`).not.toContain('cck_wrong')

    const busy = await fakeCloud({ respond: () => ({ status: 503, body: { error: { code: 'busy', message: 'Another change to the store is running.' } }, headers: { 'retry-after': '12' } }) })
    const b = await new CloudClient({ url: busy.url, token: busy.token }).sync().catch((x) => x as CliError)
    expect(b).toMatchObject({ code: 'busy', message: 'Another change to the store is running.', next: 'Wait 12 seconds, then run this again.' })

    const limited = await fakeCloud({ respond: () => ({ status: 429, body: { error: { code: 'rate_limited', message: 'Too many calls. Try again in 37 seconds.', retry_after_seconds: 37 } } }) })
    expect(await new CloudClient({ url: limited.url, token: limited.token }).store().catch((x) => x as CliError)).toMatchObject({ code: 'rate_limited', next: 'Wait 37 seconds, then run this again.' })

    // A server that echoes the header back cannot make the CLI print the token.
    const echo = await fakeCloud({ respond: () => ({ status: 422, body: { error: { code: 'query_failed', message: `You sent Bearer ${FAKE_TOKEN}` } } }) })
    const q = await new CloudClient({ url: echo.url, token: echo.token }).query('SELECT 1').catch((x) => x as CliError)
    expect(q).toMatchObject({ code: 'query_failed', message: 'You sent Bearer [token]' })
    // Server text is shown as one plain line.
    const noisy = await fakeCloud({ respond: () => ({ status: 422, body: { error: { code: 'query_failed', message: `line one\n\u001b[31mline two ${'x'.repeat(500)}` } } }) })
    const n = await new CloudClient({ url: noisy.url, token: noisy.token }).query('SELECT 1').catch((x) => x as CliError)
    expect(n.message).toMatch(/^line one \[31mline two x+$/)
    expect(n.message.length).toBe(300)
  })

  it('answers cloud_unreachable when nothing is listening, and cloud_error for an answer that is not Cloud', async () => {
    const f = await fakeCloud()
    await f.close()
    fakes = []
    expect(await code(new CloudClient({ url: f.url, token: 't' }).store())).toBe('cloud_unreachable')
    const html = await fakeCloud({ respond: () => ({ status: 500, body: 'oops' }) })
    expect(await code(new CloudClient({ url: html.url, token: html.token }).store())).toBe('cloud_error')
  })

  it('does not follow a redirect, which could carry the token to another host', async () => {
    const target = await fakeCloud()
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: `${target.url}/api/v1/store` })
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      expect(await code(new CloudClient({ url: `http://127.0.0.1:${port}`, token: target.token }).store())).toBe('bad_url')
      expect(target.requests.length).toBe(0)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('only sends the token over https, or to this machine', () => {
    expect(normalizeCloudUrl('https://cloud.example.com/api/v1/')).toBe('https://cloud.example.com')
    expect(normalizeCloudUrl('http://127.0.0.1:4599')).toBe('http://127.0.0.1:4599')
    for (const bad of ['http://cloud.example.com', 'ftp://x', 'not a url', 'https://user:pw@cloud.example.com', 'https://cloud.example.com/?t=1']) {
      expect(() => normalizeCloudUrl(bad), bad).toThrow(CliError)
    }
  })

  it('reads the address from LIFECYCLE_CLOUD_URL, then config, then the default, and the token from LIFECYCLE_CLOUD_TOKEN', async () => {
    expect(cloudUrl()).toEqual({ url: DEFAULT_CLOUD_URL, source: 'default' })
    setSetting('cloud.url', 'https://saved.example.com')
    expect(cloudUrl()).toEqual({ url: 'https://saved.example.com', source: 'config' })
    const f = await fakeCloud()
    process.env.LIFECYCLE_CLOUD_URL = f.url
    expect(cloudUrl()).toEqual({ url: f.url, source: 'env' })
    expect(() => new CloudClient()).toThrow(/Not logged in/)
    expect(await code((async () => new CloudClient())())).toBe('not_logged_in')
    process.env.LIFECYCLE_CLOUD_TOKEN = f.token
    expect((await new CloudClient().store()).store.name).toBe('Sample store')
  })

  it('checks a login before anything is saved', async () => {
    const f = await fakeCloud()
    expect(await verifyLogin(`${f.url}/api/v1`, f.token)).toEqual({ url: f.url, store: { id: 'sample_store', name: 'Sample store' }, connections: 2 })
    expect(await code(verifyLogin(f.url, 'cck_nope'))).toBe('unauthorized')
    expect(await code(verifyLogin(f.url, 'has a space'))).toBe('bad_token')
    expect(await code(verifyLogin(f.url, 'caf\u00e9'))).toBe('bad_token')
    const other = await fakeCloud({ respond: () => ({ status: 200, body: { hello: 'world' } }) })
    expect(await code(verifyLogin(other.url, other.token))).toBe('bad_url')
  })
})

describe('login, logout and --cloud, through the real CLI', () => {
  it('logs in, reports status, reads through --cloud and logs out, without printing the token', async () => {
    const f = await fakeCloud()
    const all: string[] = []
    const run = async (args: string[], env: Record<string, string> = {}) => {
      const r = await cli(args, { LIFECYCLE_CLOUD_TOKEN: f.token, ...env })
      all.push(r.stdout, r.stderr)
      return r
    }

    const login = await run(['login', '--url', f.url, '--token-env', 'MY_TOKEN'], { MY_TOKEN: f.token })
    expect(login.status, login.stderr).toBe(0)
    expect(login.json()).toMatchObject({ loggedIn: true, url: f.url, store: { id: 'sample_store', name: 'Sample store' }, tokenStorage: 'environment', tokenEnv: 'LIFECYCLE_CLOUD_TOKEN' })
    expect(readRawConfig().cloud).toEqual({ url: f.url })

    expect((await run(['cloud', 'status'])).json()).toMatchObject({ loggedIn: true, reachable: true, urlSource: 'config', tokenSource: 'env', store: { name: 'Sample store' }, connections: [{ source: 'klaviyo', status: 'working' }, { source: 'meta', status: 'failed', statusCode: 'key_rejected' }] })
    expect((await run(['schema', '--cloud'])).json().schemas[0].tables.map((t: any) => t.name)).toEqual(['fact_orders_daily', 'fact_flow_daily'])
    expect((await run(['schema', 'fact_flow_daily', '--cloud'])).json().schemas[0].tables.length).toBe(1)
    expect((await run(['schema', 'nope', '--cloud'])).error()).toMatchObject({ code: 'unknown_table' })
    expect((await run(['query', 'SELECT date, orders FROM fact_orders_daily', '--cloud'])).json()).toMatchObject({ cloud: true, rowCount: 2, rows: [{ date: '2026-11-23', orders: 14 }, { date: '2026-11-24', orders: 9 }] })
    // A write is refused on this machine, before anything is sent.
    const before = f.requests.length
    expect((await run(['query', 'DELETE FROM fact_orders_daily', '--cloud'])).error()).toMatchObject({ code: 'read_only' })
    expect(f.requests.length).toBe(before)
    expect((await run(['metrics', 'list', '--cloud'])).json().map((m: any) => m.name)).toEqual(['shopify_orders', 'repeat_orders'])
    expect((await run(['metrics', 'run', 'shopify_orders', '--days', '30', '--cloud'])).json()).toMatchObject({ metric: 'shopify_orders', days: 30, value: 412 })
    expect((await run(['metrics', 'run', 'shopify_orders', 'repeat_orders', '--cloud'])).json().metrics.length).toBe(2)
    expect((await run(['metrics', 'run', 'nope', '--cloud'])).error()).toMatchObject({ code: 'unknown_metric' })
    expect((await run(['sources', 'list', '--cloud'])).json()).toMatchObject([{ slug: 'klaviyo', connected: true, lastStatus: 'working' }, { slug: 'meta', lastStatus: 'failed', statusCode: 'key_rejected' }])
    expect((await run(['logs', '--cloud', '--limit', '5'])).json()).toMatchObject([{ source: 'klaviyo', status: 'ok', rows: 412 }, { source: 'meta', status: 'failed', code: 'key_rejected' }])
    expect((await run(['sync', '--cloud'])).json()).toEqual({ cloud: true, started: ['c_klaviyo000001', 'c_meta00000001'], alreadyRunning: [] })
    expect((await run(['sync', '--cloud', '--only', 'meta'])).json()).toEqual({ cloud: true, started: ['c_meta00000001'], alreadyRunning: [] })
    expect((await run(['sync', '--cloud', '--only', 'stripe'])).error()).toMatchObject({ code: 'not_connected' })
    // sync --cloud never touches this machine's store, so no lock and no database appear.
    expect(existsSync(join(home, 'pgdata'))).toBe(false)

    // Text output, for people.
    const text = await new Promise<string>((done) => {
      const child = spawn(process.execPath, [resolve('node_modules', 'tsx', 'dist', 'cli.mjs'), resolve('src', 'cli.ts'), 'cloud', 'status'], { env: { ...process.env, LIFECYCLE_NO_UPDATE_CHECK: '1', LIFECYCLE_CLOUD_TOKEN: f.token } })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.on('close', () => done(out))
    })
    all.push(text)
    expect(text).toMatch(/Logged in to Cosmic Cloud\. Store: Sample store/)

    const logout = await run(['logout'])
    expect(logout.json()).toMatchObject({ loggedOut: true, urlRemoved: true, note: expect.stringMatching(/LIFECYCLE_CLOUD_TOKEN is still set/) })
    expect(readRawConfig().cloud).toBeUndefined()
    // The token is still in the environment, but no address is saved: nothing is sent, not even to the
    // public address, and every --cloud command says not_logged_in.
    const sent = f.requests.length
    const fetches: string[] = []
    vi.stubGlobal('fetch', async (u: string) => {
      fetches.push(String(u))
      throw new Error('no call expected')
    })
    for (const args of [['query', 'SELECT 1', '--cloud'], ['schema', '--cloud'], ['metrics', 'list', '--cloud'], ['metrics', 'run', 'shopify_orders', '--cloud'], ['sources', 'list', '--cloud'], ['sync', '--cloud'], ['skills', 'delete', 'x']]) {
      expect((await run(args)).error(), args.join(' ')).toMatchObject({ code: 'not_logged_in' })
    }
    const stillSet = (await run(['cloud', 'status'])).json()
    expect(stillSet).toMatchObject({ loggedIn: false, tokenSource: 'env', urlSource: 'default', note: expect.stringMatching(/no Cloud address is saved/) })
    expect(f.requests.length).toBe(sent)
    // In this process too: a token, no address, so the client refuses before any fetch.
    process.env.LIFECYCLE_CLOUD_TOKEN = f.token
    expect(() => new CloudClient()).toThrow(/Not logged in/)
    delete process.env.LIFECYCLE_CLOUD_TOKEN
    expect(fetches).toEqual([])
    const out = await cli(['cloud', 'status'], { LIFECYCLE_CLOUD_URL: f.url })
    all.push(out.stdout, out.stderr)
    expect(out.json()).toMatchObject({ loggedIn: false, tokenSource: 'missing', urlSource: 'env' })
    // With both in the environment, as an app or a CI job sets them, --cloud works without login.
    expect((await cli(['query', 'SELECT 1', '--cloud'], { LIFECYCLE_CLOUD_URL: f.url, LIFECYCLE_CLOUD_TOKEN: f.token })).json()).toMatchObject({ cloud: true, rowCount: 2 })
    expect((await cli(['query', 'SELECT 1', '--cloud'], { LIFECYCLE_CLOUD_URL: f.url })).error()).toMatchObject({ code: 'not_logged_in' })

    expect(all.join('\n')).not.toContain(f.token)
    expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain(f.token)
  }, 120_000)

  it('saves nothing when the token is refused, the variable is empty or the address is not https', async () => {
    const f = await fakeCloud()
    expect((await cli(['login', '--url', f.url, '--token-env', 'MY_TOKEN'], { MY_TOKEN: 'cck_wrong' })).error()).toMatchObject({ code: 'unauthorized' })
    expect((await cli(['login', '--url', f.url, '--token-env', 'MY_TOKEN'])).error()).toMatchObject({ code: 'missing_secret' })
    expect((await cli(['login', '--url', f.url])).error()).toMatchObject({ code: 'missing_secret' })
    const before = f.requests.length
    expect((await cli(['login', '--url', 'http://cloud.example.com', '--token-env', 'MY_TOKEN'], { MY_TOKEN: f.token })).error()).toMatchObject({ code: 'bad_url' })
    expect(f.requests.length).toBe(before)
    expect(existsSync(join(home, 'config.json'))).toBe(false)
  }, 60_000)

  it('says not_built for each --cloud command on a Cloud without the new routes, and reports an unreachable Cloud in status', async () => {
    const f = await fakeCloud({ missing: ['/schema', '/query', '/metrics', '/runs', '/skills', '/tools/runs'] })
    const env = { LIFECYCLE_CLOUD_URL: f.url, LIFECYCLE_CLOUD_TOKEN: f.token }
    for (const args of [['schema', '--cloud'], ['query', 'SELECT 1', '--cloud'], ['metrics', 'list', '--cloud'], ['metrics', 'run', 'shopify_orders', '--cloud'], ['logs', '--cloud'], ['skills', 'delete', 'x']]) {
      const r = await cli(args, env)
      expect(r.status, args.join(' ')).toBe(1)
      expect(r.error(), args.join(' ')).toMatchObject({ code: 'not_built', error: expect.stringMatching(/^Cosmic Cloud does not have this yet/) })
    }
    await f.close()
    fakes = []
    const down = await cli(['cloud', 'status'], env)
    expect(down.status).toBe(1)
    expect(down.json()).toMatchObject({ loggedIn: true, reachable: false, code: 'cloud_unreachable' })
  }, 120_000)

  it('keeps logs --cloud as the GitHub Actions log for a machine that is not logged in', async () => {
    const r = await cli(['logs', '--cloud'])
    // No deploy repo here, so the old path fails the old way: it never reached for Cosmic Cloud.
    expect(r.status).toBe(1)
    expect(r.error().code).not.toBe('not_logged_in')
  }, 30_000)
})

const kitCtx: ToolContext = { klaviyo: () => ({ account: async () => ({ id: 'A1', name: 'Sample' }) }) as never, shopify: async () => ({ store: 's', token: 't' }) }
const openCtx = (answers: Record<string, unknown>) => {
  const calls: { url: string; method: string }[] = []
  const ctx: OpenContext = {
    key: (p) => `key-for-${p}`,
    http: async (url, init) => {
      calls.push({ url, method: init.method ?? 'GET' })
      const hit = Object.entries(answers).find(([frag]) => url.includes(frag))
      if (!hit) throw new Error(`unexpected request to ${url}`)
      if (hit[1] instanceof Error) throw hit[1]
      return hit[1]
    },
  }
  return { ctx, calls }
}

describe('tool runs keep their request', () => {
  it('stores provider, model and input with a built-in run, and tools get shows it', async () => {
    const r = await runTool('klaviyo.account', {}, kitCtx)
    expect(r.request).toEqual({ provider: 'klaviyo', model: 'klaviyo.account', input: {} })
    expect(getRun(r.id).request).toEqual(r.request)
  })

  it('stores the request of an open provider run and never a key', async () => {
    const { ctx } = openCtx({ 'api.apify.com/v2/actors': { data: { id: 'run1', defaultDatasetId: 'ds1' } } })
    const r = await startOpenTool('apify:someone~some-actor', { query: 'welcome email', api_key: 'sk-should-never-be-saved', nested: { authToken: 'abc', keep: 1 } }, ctx)
    expect(r.request).toEqual({ provider: 'apify', model: 'someone~some-actor', input: { query: 'welcome email', api_key: '[removed]', nested: { authToken: '[removed]', keep: 1 } } })
    const saved = readFileSync(join(home, 'runs', `${r.id}.json`), 'utf8')
    expect(saved).not.toContain('sk-should-never-be-saved')
    expect(saved).not.toContain('key-for-apify')
    const sc = openCtx({ 'api.scrapecreators.com': { credits_charged: 1 } })
    expect((await startOpenTool('scrapecreators:v1/reddit/search', { query: 'x' }, sc.ctx, { method: 'post' })).request).toMatchObject({ provider: 'scrapecreators', model: 'v1/reddit/search', method: 'POST' })
  })

  it('redacts by field name only, and leaves ordinary fields alone', () => {
    expect(redactSecrets({ prompt: 'a key lime pie', max_tokens: 50, monkey: 'see', keyword: 'shoes', password: 'x', list: [{ client_secret: 'y', accessToken: 'z' }], Authorization: 'Bearer z' })).toEqual({ prompt: 'a key lime pie', max_tokens: 50, monkey: 'see', keyword: 'shoes', password: '[removed]', list: [{ client_secret: '[removed]', accessToken: '[removed]' }], Authorization: '[removed]' })
  })

  it('builds the Cloud record without output, error text or email addresses', () => {
    const run: ToolRun = { id: 'ab12cd34', tool: 'apify:x~y', input: {}, status: 'succeeded', startedAt: '2026-11-24T00:00:00.000Z', finishedAt: '2026-11-24T00:01:00.000Z', provider: 'apify', request: { provider: 'apify', model: 'x~y', input: { search: 'posts by sam@example.com', n: 3 } }, output: [{ name: 'A person', email: 'person@example.com' }], error: 'boom', remote: { runId: 'r' }, cost: { amount: 0.02, unit: 'usd' } }
    const rec = cloudRunRecord(run)
    expect(rec).toEqual({ id: 'ab12cd34', tool: 'apify:x~y', status: 'succeeded', started_at: '2026-11-24T00:00:00.000Z', finished_at: '2026-11-24T00:01:00.000Z', request: { provider: 'apify', model: 'x~y', input: { search: 'posts by [email removed]', n: 3 } }, cost: { amount: 0.02, unit: 'usd' } })
    expect(JSON.stringify(rec)).not.toMatch(/person@example|A person|boom/)
  })

  it('posts the record to Cloud when logged in, and a Cloud that is down or unbuilt never fails the run', async () => {
    const f = await fakeCloud()
    // Shopify is not connected, so the tool stops before any network call. The run is still saved, and still posted.
    writeConfig({ database: { kind: 'local' } })
    const env = { LIFECYCLE_CLOUD_URL: f.url, LIFECYCLE_CLOUD_TOKEN: f.token }
    const bad = await cli(['tools', 'run', 'klaviyo.placed_orders_daily', '--input', '{"start":"nope"}'], env)
    expect(bad.error()).toMatchObject({ code: 'bad_input' })
    expect(f.toolRuns.length).toBe(0)

    const out = (await cli(['tools', 'run', 'shopify.order_count'], env)).json()
    expect(out).toMatchObject({ tool: 'shopify.order_count', status: 'failed', request: { provider: 'shopify', model: 'shopify.order_count', input: {} }, cloud: { posted: true } })
    expect(f.toolRuns).toEqual([{ id: out.id, tool: 'shopify.order_count', status: 'failed', started_at: out.startedAt, finished_at: out.finishedAt, request: out.request, cost: null }])
    expect(f.requests.at(-1)).toMatchObject({ method: 'POST', path: '/tools/runs' })
    const got = (await cli(['tools', 'get', out.id], env)).json()
    expect(got.request).toEqual(out.request)
    // Nothing changed since the run, so tools get sends nothing more.
    expect(got.cloud).toBeUndefined()
    expect(f.toolRuns.length).toBe(1)

    const unbuilt = await fakeCloud({ missing: ['/tools/runs'] })
    const r2 = (await cli(['tools', 'run', 'shopify.order_count'], { ...env, LIFECYCLE_CLOUD_URL: unbuilt.url })).json()
    expect(r2.cloud).toEqual({ posted: false, code: 'not_built' })
    expect(getRun(r2.id).tool).toBe('shopify.order_count')
    await unbuilt.close()
    fakes = fakes.filter((x) => x !== unbuilt)
    const r3 = (await cli(['tools', 'run', 'shopify.order_count'], { ...env, LIFECYCLE_CLOUD_URL: unbuilt.url })).json()
    expect(r3.cloud).toEqual({ posted: false, code: 'cloud_unreachable' })
    expect(getRun(r3.id).status).toBe('failed')
    // Not logged in: nothing is sent and the output has no cloud field.
    expect((await cli(['tools', 'run', 'shopify.order_count'])).json().cloud).toBeUndefined()
  }, 120_000)
})

describe('tools abort', () => {
  const running = (provider: string, remote: Record<string, string>): ToolRun => saveRun({ id: `${provider}0001`.slice(0, 8), tool: `${provider}:x`, input: {}, status: 'running', startedAt: '2026-11-24T00:00:00.000Z', finishedAt: '', provider, remote })

  it('stops an Apify run and marks it aborted only after Apify agrees', async () => {
    const { ctx, calls } = openCtx({ '/abort': { data: { status: 'ABORTING' } }, '/actor-runs/r1': { data: { status: 'RUNNING' } } })
    const a = await abortRun(running('apify', { runId: 'r1', datasetId: 'd1' }), ctx)
    expect(a.aborted).toBe(true)
    expect(a.run).toMatchObject({ status: 'aborted', error: expect.stringMatching(/may still bill/) })
    expect(a.run.finishedAt).not.toBe('')
    expect(calls.at(-1)).toEqual({ url: 'https://api.apify.com/v2/actor-runs/r1/abort', method: 'POST' })
    expect(getRun(a.run.id).status).toBe('aborted')
    expect(await code(abortRun(getRun(a.run.id), ctx))).toBe('not_running')
  })

  it('stops a fal run through its own cancel link, on queue.fal.run only', async () => {
    const status = 'https://queue.fal.run/fal-ai/x/requests/q1/status'
    const { ctx, calls } = openCtx({ '/cancel': { status: 'CANCELLATION_REQUESTED' }, '/status': { status: 'IN_PROGRESS' } })
    const a = await abortRun(running('fal', { requestId: 'q1', statusUrl: status, responseUrl: 'https://queue.fal.run/fal-ai/x/requests/q1' }), ctx)
    expect(a.aborted).toBe(true)
    expect(calls.at(-1)).toEqual({ url: 'https://queue.fal.run/fal-ai/x/requests/q1/cancel', method: 'PUT' })
    const elsewhere = openCtx({ '/status': { status: 'IN_PROGRESS' } })
    expect(await code(abortRun(running('fal', { requestId: 'q2', statusUrl: status, cancelUrl: 'https://evil.example.com/cancel' }), elsewhere.ctx))).toBe('cannot_abort')
    expect(elsewhere.calls.some((c) => c.url.includes('evil'))).toBe(false)
  })

  it('does not call a run aborted when it had already finished', async () => {
    const done = openCtx({ '/actor-runs/r2': { data: { status: 'SUCCEEDED', usageTotalUsd: 0.01 } }, '/datasets/': [{ a: 1 }] })
    const a = await abortRun(running('apify', { runId: 'r2', datasetId: 'd2' }), done.ctx)
    expect(a).toMatchObject({ aborted: false, run: { status: 'succeeded' } })
    expect(done.calls.some((c) => c.url.endsWith('/abort'))).toBe(false)

    // fal says 400 to a cancel that came too late. The result is read instead.
    let n = 0
    const late: OpenContext = { key: () => 'k', http: async (url) => {
      if (url.endsWith('/cancel')) throw new HttpError('fal cancel request', 400, 'ALREADY_COMPLETED')
      if (url.endsWith('/status')) return { status: n++ === 0 ? 'IN_PROGRESS' : 'COMPLETED' }
      return { images: [] }
    } }
    const b = await abortRun(running('fal', { requestId: 'q3', statusUrl: 'https://queue.fal.run/a/b/requests/q3/status', responseUrl: 'https://queue.fal.run/a/b/requests/q3' }), late)
    expect(b).toMatchObject({ aborted: false, run: { status: 'succeeded' } })
  })

  it('says plainly that Kie cannot stop a job, and leaves the run running', async () => {
    const { ctx } = openCtx({ recordInfo: { code: 200, data: { state: 'generating' } } })
    const run = running('kie', { taskId: 't1' })
    const e = await abortRun(run, ctx).catch((x) => x as CliError)
    expect(e).toMatchObject({ code: 'cannot_abort', message: expect.stringMatching(/Kie has no way to stop a job/) })
    expect(getRun(run.id).status).toBe('running')
  })

  it('has unknown_run for a run id that does not exist', async () => {
    expect((await cli(['tools', 'abort', 'nope1234'])).error()).toMatchObject({ code: 'unknown_run' })
  }, 30_000)
})

describe('skills push, delete and sync with the store\'s own skills', () => {
  const skillDir = (files: Record<string, string | Buffer>, name = 'winback-brief') => {
    const dir = join(home, name)
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(dir, p, '..'), { recursive: true })
      writeFileSync(join(dir, p), body)
    }
    return dir
  }
  const reg = () => ensureRegistry({ uri: resolve('registry-snapshot') })

  it('reads a folder into path and content pairs, with the folder name as the slug', () => {
    const dir = skillDir({ 'SKILL.md': '# Winback brief\n', 'refs/notes.md': 'Notes\n', '.DS_Store': 'x' })
    expect(readSkillDir(dir)).toEqual({ slug: 'winback-brief', bytes: 22, files: [{ path: 'refs/notes.md', content: 'Notes\n' }, { path: 'SKILL.md', content: '# Winback brief\n' }] })
    expect(readSkillDir(dir, 'other-name').slug).toBe('other-name')
  })

  it('refuses a folder over 200 KB, with no SKILL.md, with a bad name, a binary file or a link', async () => {
    expect(await code((async () => readSkillDir(skillDir({ 'SKILL.md': 'x', 'big.md': 'a'.repeat(SKILL_MAX_BYTES) }, 'big')))())).toBe('too_large')
    expect(readSkillDir(skillDir({ 'SKILL.md': 'a'.repeat(SKILL_MAX_BYTES) }, 'just-fits')).bytes).toBe(SKILL_MAX_BYTES)
    expect(await code((async () => readSkillDir(skillDir({ 'README.md': 'x' }, 'no-skill')))())).toBe('bad_skill')
    expect(await code((async () => readSkillDir(skillDir({ 'SKILL.md': 'x' }, 'Bad Name')))())).toBe('bad_skill')
    expect(await code((async () => readSkillDir(skillDir({ 'SKILL.md': 'x', 'logo.png': Buffer.from([0x89, 0x50, 0x00, 0xff]) }, 'binary')))())).toBe('bad_skill')
    const linked = skillDir({ 'SKILL.md': 'x' }, 'linked')
    writeFileSync(join(home, 'outside.txt'), 'outside the folder')
    symlinkSync(join(home, 'outside.txt'), join(linked, 'link.txt'))
    expect(await code((async () => readSkillDir(linked))())).toBe('bad_skill')
    expect(await code((async () => readSkillDir(join(home, 'missing')))())).toBe('bad_skill')
  })

  it('refuses files that look like they hold a secret, naming the file and line but never the value', () => {
    // Built at run time so this test file holds no key-shaped text of its own.
    const stripe = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_')
    const shapes: Record<string, string> = {
      'a Stripe key': stripe,
      'a private key': `-----BEGIN ${'RSA '}PRIVATE KEY-----`,
      'a Cosmic Cloud token': FAKE_TOKEN,
      'an AWS access key': `AKIA${'ABCDEFGHIJKLMNOP'}`,
      'a GitHub token': `ghp_${'a'.repeat(36)}`,
      'a key or password': `api_key = "${'q7'.repeat(16)}"`,
      'a bearer token': `curl -H "Authorization: Bearer ${'Zk4'.repeat(12)}"`,
      'a sign-in inside a web address': `postgres://app:${'hunter2hunter2'}@db.example.com/x`,
    }
    for (const [kind, text] of Object.entries(shapes)) {
      expect(findSecrets([{ path: 'SKILL.md', content: `line one\nuse ${text} here\n` }]), kind).toEqual([{ path: 'SKILL.md', line: 2, kind }])
    }
    expect(findSecrets([{ path: 'config/.env', content: 'A=1' }, { path: 'deploy.pem', content: 'x' }]).map((x) => x.path)).toEqual(['config/.env', 'deploy.pem'])
    // Ordinary writing about keys is not a key.
    expect(findSecrets([{ path: 'SKILL.md', content: 'Set api_key=$KLAVIYO_KEY\ncurl -H "Authorization: Bearer $COSMIC_CLOUD_TOKEN"\nexport TOKEN=<your token>\nNever paste a password: use lifecycle secrets set.\ntoken: your_token_goes_here_please_replace\nmax_tokens: 4000\n' }])).toEqual([])

    const dir = skillDir({ 'SKILL.md': '# Skill\n', 'run.sh': `curl -H "x: 1"\nexport STRIPE=${stripe}\n` }, 'leaky')
    let e: CliError | undefined
    try {
      readSkillDir(dir)
    } catch (x) {
      e = x as CliError
    }
    expect(e).toMatchObject({ code: 'secret_found', message: 'Nothing was pushed. run.sh line 2 looks like a Stripe key.' })
    expect(`${e!.message} ${e!.next}`).not.toContain(stripe)
  })

  it('pushes, lists, installs, deletes and removes a store skill, end to end through the CLI', async () => {
    const f = await fakeCloud()
    const env = { LIFECYCLE_CLOUD_URL: f.url, LIFECYCLE_CLOUD_TOKEN: f.token, LIFECYCLE_REGISTRY: resolve('registry-snapshot') }
    const dir = skillDir({ 'SKILL.md': '---\nname: winback-brief\n---\n# Winback brief\n', 'refs/notes.md': 'Notes\n' })
    const push = await cli(['skills', 'push', dir], env)
    expect(push.json()).toMatchObject({ slug: 'winback-brief', pushed: true, files: ['refs/notes.md', 'SKILL.md'] })
    expect(f.skills.get('winback-brief')).toEqual([{ path: 'refs/notes.md', content: 'Notes\n' }, { path: 'SKILL.md', content: '---\nname: winback-brief\n---\n# Winback brief\n' }])

    // A leaky folder sends nothing at all.
    const sent = f.requests.length
    const leaky = skillDir({ 'SKILL.md': 'x', '.env': 'A=1' }, 'leaky')
    expect((await cli(['skills', 'push', leaky], env)).error()).toMatchObject({ code: 'secret_found' })
    expect(f.requests.length).toBe(sent)
    expect((await cli(['skills', 'push', dir])).error()).toMatchObject({ code: 'not_logged_in' })

    const sync = (await cli(['skills', 'sync', '--target', 'claude'], env)).json()
    expect(sync[0].account).toEqual({ status: 'ok', skills: ['winback-brief'], skipped: [] })
    expect(sync[0].written).toEqual(expect.arrayContaining(['skills/store-winback-brief/SKILL.md', 'skills/store-winback-brief/refs/notes.md', 'skills/kit-flow-audit/SKILL.md']))
    expect(readFileSync(join(targetDir('claude'), 'skills', 'store-winback-brief', 'refs', 'notes.md'), 'utf8')).toBe('Notes\n')
    expect((await cli(['skills', 'status'], env)).json()[0]).toMatchObject({ storeSkills: ['winback-brief'], account: { status: 'ok', skills: ['winback-brief'] } })
    expect((await cli(['skills', 'status'], { LIFECYCLE_REGISTRY: env.LIFECYCLE_REGISTRY })).json()[0].account).toEqual({ status: 'not_logged_in', skills: [] })

    // Logged out, or Cloud down: kits still sync and the installed store skill stays.
    const offline = (await cli(['skills', 'sync', '--target', 'claude'], { LIFECYCLE_REGISTRY: env.LIFECYCLE_REGISTRY })).json()
    expect(offline[0]).toMatchObject({ account: { status: 'not_logged_in' }, removed: [] })
    expect(existsSync(join(targetDir('claude'), 'skills', 'store-winback-brief', 'SKILL.md'))).toBe(true)

    expect((await cli(['skills', 'delete', 'nope'], env)).error()).toMatchObject({ code: 'unknown_skill' })
    expect((await cli(['skills', 'delete', '../store'], env)).error()).toMatchObject({ code: 'bad_skill' })
    expect((await cli(['skills', 'delete', 'winback-brief'], env)).json()).toEqual({ slug: 'winback-brief', deleted: true })
    expect(f.skills.size).toBe(0)
    const after = (await cli(['skills', 'sync', '--target', 'claude'], env)).json()
    expect(after[0].removed).toEqual(expect.arrayContaining(['skills/store-winback-brief/SKILL.md', 'skills/store-winback-brief/refs/notes.md']))
    expect(existsSync(join(targetDir('claude'), 'skills', 'store-winback-brief'))).toBe(false)
  }, 180_000)

  it('keeps kits syncing and store skills in place when Cloud has no skills route yet', async () => {
    const f = await fakeCloud({ missing: ['/skills'] })
    const r = await cli(['skills', 'sync', '--target', 'claude'], { LIFECYCLE_CLOUD_URL: f.url, LIFECYCLE_CLOUD_TOKEN: f.token, LIFECYCLE_REGISTRY: resolve('registry-snapshot') })
    expect(r.status).toBe(0)
    expect(r.json()[0]).toMatchObject({ account: { status: 'not_built', code: 'not_built' } })
    expect(r.json()[0].written).toContain('SKILL.md')
    expect(r.stderr).toMatch(/store's own skills were not synced/)
  }, 60_000)

  it('never writes outside the skill folder, whatever Cloud sends', () => {
    const a = accountSkillFiles([
      { slug: 'good', files: [{ path: 'SKILL.md', content: 'ok' }, { path: 'a/b.md', content: 'ok' }] },
      { slug: 'climb', files: [{ path: '../../../../.zshrc', content: 'bad' }] },
      { slug: 'abs', files: [{ path: '/etc/hosts', content: 'bad' }] },
      { slug: 'win', files: [{ path: 'a\\..\\b', content: 'bad' }] },
      { slug: '../up', files: [{ path: 'SKILL.md', content: 'bad' }] },
      { slug: 'huge', files: [{ path: 'SKILL.md', content: 'a'.repeat(SKILL_MAX_BYTES + 1) }] },
      { slug: 'not-text', files: [{ path: 'SKILL.md', content: 5 as never }] },
      { slug: 'empty', files: [] },
    ])
    expect(a.installed).toEqual(['good'])
    expect(Object.keys(a.files)).toEqual(['skills/store-good/SKILL.md', 'skills/store-good/a/b.md'])
    expect(a.skipped).toEqual(['climb', 'abs', 'win', 'up', 'huge', 'not-text', 'empty'])

    const [r] = syncSkills(reg(), { targets: ['claude'], account: a.files })
    expect(r!.written).toContain('skills/store-good/a/b.md')
    expect(existsSync(join(home, '.zshrc'))).toBe(false)
    expect(skillsStatus(reg(), ['claude'])[0]!.storeSkills).toEqual(['good'])
    // A store skill the owner edited by hand is kept, like any other managed file.
    writeFileSync(join(targetDir('claude'), 'skills', 'store-good', 'SKILL.md'), 'my edit')
    expect(syncSkills(reg(), { targets: ['claude'], account: {} })[0]).toMatchObject({ kept: ['skills/store-good/SKILL.md'], removed: ['skills/store-good/a/b.md'] })
    uninstallSkills(['claude'])
    expect(readdirSync(join(targetDir('claude'), 'skills'))).toEqual(['store-good'])
  })
})

describe('kits show', () => {
  it('lists every file in the kit', () => {
    const r = showKit(ensureRegistry({ uri: resolve('registry-snapshot') }), 'flow-audit')
    expect(r.files).toEqual(expect.arrayContaining(['AGENT.md', 'README.md', 'kit.yaml']))
    expect(r.files).toEqual([...r.files].sort((a, b) => a.localeCompare(b)))
    for (const f of r.manifest.files) expect(r.files).toContain(f)
  })

  it('prints the file list in text and JSON', async () => {
    const env = { LIFECYCLE_REGISTRY: resolve('registry-snapshot') }
    expect((await cli(['kits', 'show', 'flow-audit'], env)).json().files).toContain('AGENT.md')
  }, 30_000)
})

describe('loader_failed', () => {
  it('gives a crashed warehouse loader a code and one plain sentence, and keeps going', async () => {
    writeConfig({ database: { kind: 'local' }, warehouse: { sources: { gorgias: { params: { subdomain: 'x', email: 'owner' }, personalData: 'strip', connectedAt: '2026-11-24T00:00:00.000Z' } } } })
    // A stand-in for uv that answers the version check, then dies mid-load with a log full of noise.
    const uv = join(home, 'uv')
    writeFileSync(uv, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "uv 0.0.0"; exit 0; fi\necho "Traceback: something private at line 12" >&2\nkill -9 $$\n', { mode: 0o755 })
    process.env.LIFECYCLE_UV_PATH = uv
    process.env.LIFECYCLE_SRC_GORGIAS_API_KEY = 'fake'
    const recorded: unknown[] = []
    try {
      const results = await syncSources(undefined, { record: async (r) => void recorded.push(r) })
      expect(results).toEqual([{ source: 'gorgias', status: 'failed', rows: 0, code: 'loader_failed', detail: loaderFailed('Gorgias', 'gorgias') }])
      expect(results[0]!.detail).not.toMatch(/Traceback|private/)
      expect(recorded).toEqual(results)
    } finally {
      delete process.env.LIFECYCLE_SRC_GORGIAS_API_KEY
    }
  })

  it('keeps the code of an error that is not a crash', async () => {
    writeConfig({ database: { kind: 'local' }, warehouse: { sources: { gorgias: { params: {}, personalData: 'strip', connectedAt: '2026-11-24T00:00:00.000Z' } } } })
    process.env.LIFECYCLE_UV_PATH = join(home, 'no-such-uv')
    const [r] = await syncSources(undefined)
    expect(r).toMatchObject({ status: 'failed' })
    expect(r!.code).not.toBe('loader_failed')
  })
})

describe('busy, reviewed', () => {
  it('lets a read answer while a writer holds the store, without writing beside it', async () => {
    expect((await cli(['init'])).status).toBe(0)
    // This test process plays a sync that is still running.
    writeFileSync(join(home, 'write.lock'), JSON.stringify({ pid: process.pid, command: 'sync', startedAt: new Date().toISOString() }))
    const env = { LIFECYCLE_LOCK_WAIT_MS: '200' }
    for (const args of [['logs'], ['metrics', 'candidates'], ['report', 'revenue-per-flow'], ['audit', 'flows']]) {
      const r = await cli(args, env)
      expect(r.status, `${args.join(' ')}: ${r.stderr}`).toBe(0)
    }
    expect((await cli(['reconcile'], env)).error()).toMatchObject({ code: 'busy' })
    expect((await cli(['sync'], env)).error()).toMatchObject({ code: 'busy' })
    // The lock is still the writer's: no read took it over or removed it.
    expect(JSON.parse(readFileSync(join(home, 'write.lock'), 'utf8')).pid).toBe(process.pid)
  }, 120_000)
})

describe('docs and release', () => {
  it('documents every new command, code and variable', () => {
    for (const cmd of ['lifecycle login [--url URL] --token-env VAR', 'lifecycle logout', 'lifecycle cloud status', 'skills sync|status|uninstall', 'skills push DIRECTORY', 'skills delete SLUG', 'abort RUN', '--cloud']) expect(DOCS.commands, cmd).toContain(cmd)
    for (const c of ['not_logged_in', 'unauthorized', 'not_built', 'cloud_unreachable', 'cloud_error', 'bad_url', 'bad_token', 'unknown_table', 'loader_failed', 'busy', 'too_large', 'secret_found', 'bad_skill', 'unknown_skill', 'cannot_abort', 'not_running']) {
      expect(DOCS.troubleshooting, c).toMatch(new RegExp(`^  ${c}\\s`, 'm'))
    }
    expect(DOCS.cloud).toMatch(/LIFECYCLE_CLOUD_URL/)
    expect(DOCS.cloud).toMatch(/LIFECYCLE_CLOUD_TOKEN/)
    const changelog = readFileSync('CHANGELOG.md', 'utf8')
    for (const c of ['not_logged_in', 'unauthorized', 'cloud_unreachable', 'cloud_error', 'bad_url', 'bad_token', 'unknown_table', 'loader_failed', 'too_large', 'secret_found', 'bad_skill', 'unknown_skill', 'cannot_abort', 'not_running']) expect(changelog, c).toContain(`\`${c}\``)
    expect(changelog).toMatch(/^## 0\.13\.0/m)
  })

  it('has no em or en dash in anything this release wrote', () => {
    for (const f of ['CHANGELOG.md', 'README.md', 'src/cloud.ts', 'src/cli.ts', 'src/skills.ts', 'src/tools.ts', 'src/open-tools.ts', 'src/docs.ts', 'test/fixtures/fake-cloud.mjs']) expect(readFileSync(f, 'utf8'), f).not.toMatch(/[\u2013\u2014]/)
  })

  it('is a 0.13 release, and the Cloud token is a secret like any other, with its own variable', () => {
    // 0.14.0: was /^0\.13\.\d+$/; a version bump has to change it. The token checks are untouched.
    expect(VERSION).toMatch(/^0\.(1[3-9]|2\d)\.\d+$/)
    expect(SECRET_NAMES).toContain('cloud-token')
    expect(envName('cloud-token')).toBe('LIFECYCLE_CLOUD_TOKEN')
  })
})
