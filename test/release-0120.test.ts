import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { dbSchema, migrate, wrapPg, wrapPglite, type Db, type PgPool } from '../src/db.js'
import { readRawConfig, writeConfig } from '../src/config.js'
import { acquireWriteLock, lockNeeded, lockPath, readLock, tryWriteLock, withWriteLock } from '../src/lock.js'
import { deleteMetric, describeMetric, listAllMetrics, listMetrics, METRICS, runMetric, saveMetric, SAVED_NOTE } from '../src/metrics.js'
import { assertReadOnlySql } from '../src/query.js'
import { buildMcpServer } from '../src/mcp.js'
import { connectKlaviyo, connectMeta, keepKeys } from '../src/commands/connect.js'
import { checkForUpdate, UNREACHABLE, UPDATE_HINT } from '../src/update.js'
import { kitPrompt } from '../src/sources-catalog.js'
import { DOCS } from '../src/docs.js'
import { runRunner, uvAvailable, uvCommand, uvEnv } from '../src/warehouse.js'
import { WAREHOUSE_CATALOG } from '../src/warehouse-catalog.js'

let home: string
let db: Db

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'lc-0120-'))
  process.env.LIFECYCLE_HOME = home
  process.env.LIFECYCLE_NO_KEYCHAIN = '1'
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(async () => {
  await db.close()
  rmSync(home, { recursive: true, force: true })
  for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'LIFECYCLE_LOCK_WAIT_MS', 'LIFECYCLE_DB_SCHEMA', 'LIFECYCLE_UV_PATH', 'LIFECYCLE_UV_CACHE_DIR', 'KLAVIYO_TEST_KEY', 'META_TEST_TOKEN', 'LIFECYCLE_KLAVIYO_READ_KEY']) delete process.env[k]
  vi.unstubAllGlobals()
})

const orders = (daysAgo: number, n: number, returning: number) =>
  db.query(
    `INSERT INTO fact_orders_daily (date, orders, gross_revenue, net_revenue, discounts, new_orders, returning_orders, source_synced_at) VALUES (CURRENT_DATE - $1::int, $2::int, 100, 100, 0, $2::int - $3::int, $3::int, now())`,
    [daysAgo, n, returning],
  )

// A process id that is certainly gone: a child that has already exited.
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid
const holdLock = (pid: number, startedAt = new Date().toISOString()) => writeFileSync(lockPath(), JSON.stringify({ pid, command: 'sync', startedAt }))

describe('saved numbers', () => {
  it('saves a SELECT, lists it as saved by the owner, and runs it with the trust line', async () => {
    await orders(5, 10, 4)
    await orders(200, 50, 50) // outside a 90-day window
    const saved = await saveMetric(db, 'repeat_orders', { sql: 'SELECT sum(returning_orders) AS value FROM fact_orders_daily WHERE date >= $1', title: 'Repeat orders', unit: 'count' })
    expect(saved).toMatchObject({ name: 'repeat_orders', saved: true, replaced: false, usesWindow: true })

    const list = await listAllMetrics(db)
    expect(list.slice(0, METRICS.length).every((m) => m.saved === false)).toBe(true)
    expect(list.at(-1)).toMatchObject({ name: 'repeat_orders', title: 'Repeat orders', saved: true, description: SAVED_NOTE })

    const r = await runMetric(db, 'repeat_orders', 90)
    expect(r).toMatchObject({ metric: 'repeat_orders', value: 4, status: 'ok', saved: true, days: 90 })
    expect(r.trust.line.length).toBeGreaterThan(10)
    expect(r.notes).toContain(SAVED_NOTE)
    expect((await runMetric(db, 'repeat_orders', 365)).value).toBe(54)
    // A built-in metric says it is not a saved one, and keeps its answer.
    expect(await runMetric(db, 'shopify_orders', 90)).toMatchObject({ value: 10, saved: false })
  })

  it('never lets a saved number shadow a built-in metric', async () => {
    await expect(saveMetric(db, 'shopify_orders', { sql: 'SELECT 1' })).rejects.toMatchObject({ code: 'reserved_name' })
    await expect(deleteMetric(db, 'shopify_orders')).rejects.toMatchObject({ code: 'reserved_name' })
    expect((await listAllMetrics(db)).filter((m) => m.name === 'shopify_orders')).toHaveLength(1)
    for (const m of METRICS) await expect(saveMetric(db, m.name, { sql: 'SELECT 1' }), m.name).rejects.toMatchObject({ code: 'reserved_name' })
  })

  it('runs through the read-only path: no writes, no system tables, one statement, one row', async () => {
    await orders(1, 3, 1)
    await expect(saveMetric(db, 'wipe', { sql: 'DELETE FROM fact_orders_daily' })).rejects.toMatchObject({ code: 'read_only' })
    await expect(saveMetric(db, 'peek', { sql: 'SELECT count(*) FROM information_schema.tables' })).rejects.toMatchObject({ code: 'blocked_object' })
    await expect(saveMetric(db, 'two', { sql: 'SELECT 1; SELECT 2' })).rejects.toMatchObject({ code: 'multiple_statements' })
    await expect(saveMetric(db, 'rows', { sql: 'SELECT orders FROM (VALUES (1), (2)) AS t(orders)' })).rejects.toMatchObject({ code: 'bad_metric' })
    await expect(saveMetric(db, 'words', { sql: `SELECT 'abc' AS value` })).rejects.toMatchObject({ code: 'bad_metric' })
    await expect(saveMetric(db, 'params', { sql: 'SELECT $2::int' })).rejects.toMatchObject({ code: 'bad_metric' })
    await expect(saveMetric(db, 'broken', { sql: 'SELECT nope FROM fact_orders_daily' })).rejects.toMatchObject({ code: 'query_failed' })
    await expect(saveMetric(db, 'Bad Name', { sql: 'SELECT 1' })).rejects.toMatchObject({ code: 'bad_name' })
    await expect(saveMetric(db, 'ok_name', { sql: 'SELECT 1', unit: 'bananas' })).rejects.toMatchObject({ code: 'bad_value' })
    expect(await listAllMetrics(db)).toHaveLength(METRICS.length)
    // A write hidden inside a WITH passes the first check and is still refused, and the rows are all there.
    await expect(saveMetric(db, 'sneaky', { sql: 'WITH d AS (DELETE FROM fact_orders_daily RETURNING 1) SELECT count(*) FROM d' })).rejects.toMatchObject({ code: 'query_failed' })
    expect(Number((await db.query('SELECT count(*) AS c FROM fact_orders_daily'))[0]!.c)).toBe(1)
    expect(await listAllMetrics(db)).toHaveLength(METRICS.length)
  })

  it('says when the SQL ignores the window, uses the first column when none is named value, and can be replaced and deleted', async () => {
    await orders(1, 7, 2)
    const a = await saveMetric(db, 'all_orders', { sql: 'SELECT sum(orders) FROM fact_orders_daily' })
    expect(a.usesWindow).toBe(false)
    expect(a.notes.join(' ')).toMatch(/ignores the window/)
    expect((await runMetric(db, 'all_orders', 1)).value).toBe(7)
    const b = await saveMetric(db, 'all_orders', { sql: 'SELECT sum(orders) * 2 AS value FROM fact_orders_daily', unit: 'usd', title: 'Doubled' })
    expect(b.replaced).toBe(true)
    expect(await runMetric(db, 'all_orders')).toMatchObject({ value: 14, unit: 'usd', title: 'Doubled' })
    expect(await describeMetric(db, 'all_orders')).toMatchObject({ saved: true, sql: 'SELECT sum(orders) * 2 AS value FROM fact_orders_daily' })
    expect(await describeMetric(null, 'shopify_orders')).toMatchObject({ saved: false })
    expect(await deleteMetric(db, 'all_orders')).toEqual({ name: 'all_orders', deleted: true })
    await expect(runMetric(db, 'all_orders')).rejects.toMatchObject({ code: 'unknown_metric' })
    await expect(deleteMetric(db, 'all_orders')).rejects.toMatchObject({ code: 'unknown_metric' })
    expect(listMetrics().every((m) => m.saved === false)).toBe(true)
    expect(await listAllMetrics(null)).toHaveLength(METRICS.length)
  })

  it('answers a saved number through the MCP metric tool, and lists it', async () => {
    await orders(2, 9, 3)
    await saveMetric(db, 'repeat_orders', { sql: 'SELECT sum(returning_orders) AS value FROM fact_orders_daily WHERE date >= $1' })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const server = buildMcpServer(db)
    await server.connect(serverSide)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientSide)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
      return { isError: r.isError, body: r.isError ? r.content[0]!.text : JSON.parse(r.content[0]!.text) }
    }
    const list = await call('list_metrics')
    expect(list.body.find((m: { name: string }) => m.name === 'repeat_orders')).toMatchObject({ saved: true })
    expect((await call('metric', { name: 'repeat_orders', days: 30 })).body).toMatchObject({ value: 3, saved: true, status: 'ok' })
    expect((await call('metric', { name: 'shopify_orders', days: 30 })).body).toMatchObject({ value: 9, saved: false })
    const missing = await call('metric', { name: 'not_a_metric' })
    expect(missing.isError).toBe(true)
    expect(String(missing.body)).toMatch(/No metric named not_a_metric/)
    await client.close()
  })
})

describe('one writer per local store', () => {
  it('takes and frees a lock file, and nests inside one process', async () => {
    writeConfig({ database: { kind: 'local' } })
    const release = await acquireWriteLock('sync')
    expect(readLock()).toMatchObject({ pid: process.pid, command: 'sync' })
    const inner = await acquireWriteLock('init') // provision runs init inside itself
    inner()
    expect(existsSync(lockPath())).toBe(true)
    release()
    expect(existsSync(lockPath())).toBe(false)
    expect(await withWriteLock('reconcile', async () => existsSync(lockPath()))).toBe(true)
    expect(existsSync(lockPath())).toBe(false)
  })

  it('waits a short while for a live holder, then fails with code busy and a plain message', async () => {
    writeConfig({ database: { kind: 'local' } })
    holdLock(process.ppid)
    const started = Date.now()
    const err = await acquireWriteLock('sync', { waitMs: 250, pollMs: 25 }).catch((e) => e)
    expect(Date.now() - started).toBeGreaterThanOrEqual(240)
    expect(err).toMatchObject({ code: 'busy' })
    expect(err.message).toMatch(/Another lifecycle command is writing to this store/)
    expect(err.next).toMatch(/Wait for it to finish/)
    expect(tryWriteLock('query log')).toBeNull()
    expect(readLock()?.pid).toBe(process.ppid) // the holder's lock is untouched
  })

  it('gets the lock as soon as the holder lets go', async () => {
    writeConfig({ database: { kind: 'local' } })
    holdLock(process.ppid)
    setTimeout(() => rmSync(lockPath()), 150)
    const release = await acquireWriteLock('sync', { waitMs: 3000, pollMs: 20 })
    expect(readLock()?.pid).toBe(process.pid)
    release()
  })

  it('clears a stale lock: a dead process, an unreadable old file, or one half a day old', async () => {
    writeConfig({ database: { kind: 'local' } })
    holdLock(deadPid()!)
    ;(await acquireWriteLock('sync', { waitMs: 0 }))()
    writeFileSync(lockPath(), 'not json')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath(), old, old)
    ;(await acquireWriteLock('sync', { waitMs: 0 }))()
    holdLock(process.ppid, new Date(Date.now() - 13 * 3600_000).toISOString())
    ;(await acquireWriteLock('sync', { waitMs: 0 }))()
    expect(existsSync(lockPath())).toBe(false)
    expect(readdirSync(home).filter((f) => f.includes('stale'))).toEqual([])
  })

  it('takes no lock file for a Postgres store, which locks itself', async () => {
    expect(lockNeeded()).toBe(true) // not set up yet: init must lock
    writeConfig({ database: { kind: 'postgres' } })
    expect(lockNeeded()).toBe(false)
    const release = await acquireWriteLock('sync')
    expect(existsSync(lockPath())).toBe(false)
    release()
  })

  it('stops a second CLI process with busy, while a read still answers', () => {
    const cli = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'cli.ts'), '--format', 'json', ...args], {
        encoding: 'utf8',
        env: { ...process.env, LIFECYCLE_HOME: home, LIFECYCLE_NO_KEYCHAIN: '1', LIFECYCLE_NO_UPDATE_CHECK: '1', LIFECYCLE_LOCK_WAIT_MS: '300', ...env },
      })
    expect(cli(['init']).status).toBe(0)
    expect(existsSync(lockPath())).toBe(false) // freed when init finished
    holdLock(process.pid) // this test process plays the running sync
    for (const args of [['reconcile'], ['sync'], ['init'], ['metrics', 'save', 'x_metric', '--sql', 'SELECT 1'], ['connect', 'klaviyo', '--key-env', 'NOPE']]) {
      const r = cli(args)
      expect(r.status, args.join(' ')).toBe(1)
      expect(JSON.parse(r.stderr.trim().split('\n').pop()!), args.join(' ')).toMatchObject({ code: 'busy' })
    }
    const read = cli(['metrics', 'run', 'shopify_orders'])
    expect(read.status).toBe(0)
    expect(JSON.parse(read.stdout)).toMatchObject({ metric: 'shopify_orders', status: 'no_data' })
    expect(readLock()?.pid).toBe(process.pid)
    rmSync(lockPath())
    const saved = cli(['metrics', 'save', 'x_metric', '--sql', 'SELECT 41 + 1 AS value'])
    expect(saved.status).toBe(0)
    expect(JSON.parse(cli(['metrics', 'run', 'x_metric']).stdout)).toMatchObject({ value: 42, saved: true })
    expect(JSON.parse(cli(['metrics', 'list']).stdout).at(-1)).toMatchObject({ name: 'x_metric', saved: true })
    expect(cli(['metrics', 'save', 'shopify_orders', '--sql', 'SELECT 1']).stderr).toMatch(/reserved_name/)
    expect(cli(['metrics', 'delete', 'x_metric']).status).toBe(0)
  }, 120_000)
})

describe('Postgres read-only queries use the store\'s own schema', () => {
  const recorder = (currentSchema: string | null) => {
    const log: string[] = []
    const client = {
      query: async (sql: string) => {
        log.push(sql)
        return { rows: /current_schema/.test(sql) ? [{ s: currentSchema }] : [{ ok: 1 }] }
      },
      release: () => {},
    }
    const pool: PgPool = { query: client.query, connect: async () => client, end: async () => {} }
    return { log, pool }
  }

  it('pins the search path to the connection\'s schema instead of forcing public', async () => {
    const { log, pool } = recorder('store_acme')
    expect(await wrapPg(pool, null).readOnly('SELECT 1')).toEqual([{ ok: 1 }])
    expect(log).toEqual(['BEGIN READ ONLY', `SET LOCAL statement_timeout = '15s'`, 'SELECT current_schema() AS s', 'SET LOCAL search_path = "store_acme"', 'SELECT 1', 'ROLLBACK'])
    expect(log.join('\n')).not.toMatch(/search_path = public/)
  })

  it('still reads public on a plain database, and falls back to it when the role has no schema', async () => {
    for (const s of ['public', null]) {
      const { log, pool } = recorder(s)
      await wrapPg(pool, null).readOnly('SELECT 1')
      expect(log).toContain('SET LOCAL search_path = "public"')
    }
  })

  it('uses LIFECYCLE_DB_SCHEMA when it is set, and refuses a name that is not a plain schema', async () => {
    process.env.LIFECYCLE_DB_SCHEMA = 'brand_7'
    expect(dbSchema()).toBe('brand_7')
    const { log, pool } = recorder('public')
    await wrapPg(pool).readOnly('SELECT * FROM fact_orders_daily WHERE date >= $1', ['2026-01-01'])
    expect(log).toContain('SET LOCAL search_path = "brand_7"')
    expect(log).not.toContain('SELECT current_schema() AS s')
    // Writes land in the named schema too, each in its own short transaction.
    log.length = 0
    const named = wrapPg(pool)
    await named.query('INSERT INTO meta_saved_metric VALUES ($1)', ['x'])
    expect(log).toEqual(['BEGIN', 'SET LOCAL search_path = "brand_7"', 'INSERT INTO meta_saved_metric VALUES ($1)', 'COMMIT'])
    log.length = 0
    await named.transaction(async (tx) => tx.query('SELECT 2'))
    expect(log).toEqual(['BEGIN', 'SET LOCAL search_path = "brand_7"', 'SELECT 2', 'COMMIT'])
    // Without it, a write is one plain statement on the connection's own schema, as before.
    log.length = 0
    await wrapPg(pool, null).query('SELECT 3')
    expect(log).toEqual(['SELECT 3'])
    for (const bad of ['pg_catalog', 'information_schema', 'a;drop table x', 'a"b', 'a b', '1abc']) {
      process.env.LIFECYCLE_DB_SCHEMA = bad
      expect(() => dbSchema(), bad).toThrow(/not a usable schema name/)
    }
    delete process.env.LIFECYCLE_DB_SCHEMA
    expect(dbSchema()).toBeNull()
  })

  it('keeps system tables blocked whatever the schema', () => {
    for (const sql of ['SELECT * FROM pg_catalog.pg_roles', 'SELECT * FROM information_schema.tables', `SELECT pg_read_file('/etc/passwd')`]) {
      expect(() => assertReadOnlySql(sql), sql).toThrow(/System tables and file access are blocked/)
    }
    expect(assertReadOnlySql('SELECT * FROM store_acme.fact_orders_daily')).toBeTruthy()
  })
})

describe('connect without a keychain', () => {
  it('passes once the key check passes, and says the key must come from the environment at sync time', async () => {
    writeConfig({ database: { kind: 'local' } })
    process.env.KLAVIYO_TEST_KEY = 'pk_test_not_a_real_key_0120'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'ACC1', attributes: { contact_information: { organization_name: 'Acme Tea' } } }] }), { status: 200 })))
    const r = await connectKlaviyo({ keyEnv: 'KLAVIYO_TEST_KEY' })
    expect(r).toMatchObject({ connected: true, account: 'Acme Tea', keyStorage: 'environment', keyEnv: ['LIFECYCLE_KLAVIYO_READ_KEY'] })
    expect(r.keyNote).toMatch(/set LIFECYCLE_KLAVIYO_READ_KEY in the environment whenever you sync/)
    expect(JSON.stringify(r)).not.toContain('pk_test_not_a_real_key_0120')
    expect(readRawConfig().klaviyo).toEqual({ connected: true })
    expect(JSON.stringify(readRawConfig())).not.toContain('pk_test')
  })

  it('still fails, and saves nothing, when the key is rejected', async () => {
    writeConfig({ database: { kind: 'local' } })
    process.env.KLAVIYO_TEST_KEY = 'pk_wrong'
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    await expect(connectKlaviyo({ keyEnv: 'KLAVIYO_TEST_KEY' })).rejects.toMatchObject({ code: 'key_rejected' })
    expect(readRawConfig().klaviyo).toBeUndefined()
  })

  it('does the same for a token source, and keeps the old failure for a missing variable', async () => {
    writeConfig({ database: { kind: 'local' } })
    process.env.META_TEST_TOKEN = 'meta_token_not_real'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'act_1234567890', account_id: '1234567890', name: 'Acme Ads', currency: 'USD', timezone_name: 'America/Chicago' }), { status: 200 })))
    const r = await connectMeta({ account: '1234567890', tokenEnv: 'META_TEST_TOKEN' })
    expect(r).toMatchObject({ connected: true, keyStorage: 'environment', keyEnv: ['LIFECYCLE_META_ADS_TOKEN'] })
    expect(JSON.stringify(r)).not.toContain('meta_token_not_real')
    await expect(connectKlaviyo({ keyEnv: 'UNSET_VARIABLE_0120' })).rejects.toMatchObject({ code: 'missing_secret' })
    expect(keepKeys([['stripe-read-key', 'x'], ['ga4-refresh-token', 'y']])).toMatchObject({ keyStorage: 'environment', keyEnv: ['LIFECYCLE_STRIPE_READ_KEY', 'LIFECYCLE_GA4_REFRESH_TOKEN'] })
  })
})

describe('no stale public links', () => {
  it('keeps quiet when the release list cannot be reached, and remembers it for a day', async () => {
    const now = Date.UTC(2026, 10, 24)
    const notFound = vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch
    const a = await checkForUpdate({ fetcher: notFound, now })
    expect(a).toMatchObject({ latest: null, newer: false, skipped: UNREACHABLE })
    const b = await checkForUpdate({ fetcher: notFound, now: now + 3600_000 })
    expect(b).toMatchObject({ newer: false, skipped: UNREACHABLE })
    expect(notFound).toHaveBeenCalledTimes(1)
    await checkForUpdate({ fetcher: notFound, now: now + 25 * 3600_000 })
    expect(notFound).toHaveBeenCalledTimes(2)
  })

  it('points people at the built-in quickstart, never at a download link they cannot open', () => {
    expect(UPDATE_HINT).toMatch(/cosmic docs quickstart/)
    expect(UPDATE_HINT).not.toMatch(/https?:/)
    const prompt = kitPrompt({ name: 'flow-audit', title: 'Flow audit', needs: ['klaviyo'] })
    expect(prompt).toMatch(/cosmic docs quickstart/)
    const all = [UPDATE_HINT, prompt, ...Object.values(DOCS)].join('\n')
    // 0.17.0: the repo is public, so the one install link is the public release asset. Nothing else.
    expect(all).toContain('https://github.com/jbauman-26/cosmic-lifecycle/releases/latest/download/cosmic-lifecycle.tgz')
    expect(all).not.toMatch(/raw\.githubusercontent\.com\/jbauman-26\/cosmic-lifecycle|gh release download/)
    expect(all).not.toContain(String.fromCharCode(8212))
  })

  it('documents the new commands, codes and variables', () => {
    expect(DOCS.commands).toMatch(/metrics save NAME --sql/)
    expect(DOCS.commands).toMatch(/metrics delete NAME/)
    for (const word of ['busy', 'missing_uv', 'reserved_name', 'LIFECYCLE_DB_SCHEMA', 'LIFECYCLE_LOCK_WAIT_MS', 'keyStorage']) expect(DOCS.troubleshooting, word).toContain(word)
    for (const word of ['LIFECYCLE_UV_PATH', 'LIFECYCLE_UV_CACHE_DIR', 'Google sign-in']) expect(DOCS.warehouse, word).toContain(word)
  })
})

describe('a bundled uv instead of asking the owner to install one', () => {
  it('uses uv from PATH unless LIFECYCLE_UV_PATH names a real, absolute binary', () => {
    expect(uvCommand({})).toBe('uv')
    expect(() => uvCommand({ LIFECYCLE_UV_PATH: 'bin/uv' })).toThrow(/absolute path/)
    expect(() => uvCommand({ LIFECYCLE_UV_PATH: join(home, 'missing-uv') })).toThrow(/does not exist/)
    try {
      uvCommand({ LIFECYCLE_UV_PATH: join(home, 'missing-uv') })
    } catch (e) {
      expect(e).toMatchObject({ code: 'missing_uv' })
    }
    expect(uvAvailable({ LIFECYCLE_UV_PATH: join(home, 'missing-uv') })).toBe(false)
    expect(uvEnv({})).toEqual({})
    expect(uvEnv({ LIFECYCLE_UV_CACHE_DIR: '/tmp/cache' })).toEqual({ UV_CACHE_DIR: '/tmp/cache' })
  })

  it('fails with missing_uv and a plain next step when the named binary is not there', async () => {
    process.env.LIFECYCLE_UV_PATH = join(home, 'missing-uv')
    const err = await runRunner({ action: 'schema' }, {}).catch((e) => e)
    expect(err).toMatchObject({ code: 'missing_uv' })
    expect(err.message).toMatch(/does not exist/)
  })

  it('runs the bundled binary with its own cache folder, and never needs uv on PATH', async () => {
    // A stand-in for the app's bundled uv: it reports what it was run with.
    const fake = join(home, 'bundled-uv')
    writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "uv 0.0.0-test"; exit 0; fi\ncat > /dev/null\nprintf '{"ok": true, "cache": "%s", "args": "%s"}\\n' "$UV_CACHE_DIR" "$*"\n`)
    chmodSync(fake, 0o755)
    process.env.LIFECYCLE_UV_PATH = fake
    process.env.LIFECYCLE_UV_CACHE_DIR = join(home, 'uv-cache')
    const savedPath = process.env.PATH
    process.env.PATH = '/usr/bin:/bin' // no uv here on CI; the bundled one must be enough
    try {
      const r = (await runRunner({ action: 'schema' }, {})) as { ok: true; cache: string; args: string }
      expect(r.ok).toBe(true)
      expect(r.cache).toBe(join(home, 'uv-cache'))
      expect(r.args).toMatch(/^run --quiet --no-project --python 3\.12 --with dlt\[postgres,duckdb\]==/)
      expect(r.args).toMatch(/connectors\/run\.py$/)
    } finally {
      process.env.PATH = savedPath
    }
  })

  it('does not ship uv inside the package', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(JSON.stringify(pkg.files)).not.toMatch(/uv/)
    expect(Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).some((d) => /(^|[-/])uv($|-)/.test(d))).toBe(false)
  })
})

describe('catalog additions in 0.12.0', () => {
  const bySlug = (slug: string) => WAREHOUSE_CATALOG.find((s) => s.slug === slug)!

  it('builds Brevo, Privy, Okendo, Loox and Fairing from the vendors\' docs', () => {
    for (const slug of ['brevo', 'privy', 'okendo', 'loox', 'fairing']) {
      const s = bySlug(slug)
      expect(s, slug).toBeDefined()
      expect(s.readiness, slug).toBe('built')
      expect(s.docs, slug).toMatch(/^https:\/\//)
      expect(s.config, slug).toBeDefined()
      expect(s.tested, slug).toBeUndefined() // none has run on a real account
    }
  })

  it('leaves Postscript, Attentive, Rebuy and Northbeam planned, each with the reason', () => {
    const reasons: Record<string, RegExp> = { postscript: /enterprise plan/, attentive: /no read endpoints/, rebuy: /storefront only/, northbeam: /export job/ }
    for (const [slug, reason] of Object.entries(reasons)) {
      const s = bySlug(slug)
      expect(s.readiness, slug).toBe('planned')
      expect(s.config, slug).toBeUndefined()
      expect(s.notes, slug).toMatch(reason)
    }
  })

  it('lists Google Search Console as a planned built-in source that needs Google sign-in, with no connector', () => {
    // Google Ads became a built-in source (cosmic connect google-ads), so it left the warehouse catalog.
    expect(bySlug('google-ads')).toBeUndefined()
    for (const slug of ['google-search-console']) {
      const s = bySlug(slug)
      expect(s, slug).toBeDefined()
      expect(s.readiness, slug).toBe('planned')
      expect(s.config, slug).toBeUndefined()
      expect(s.credentials, slug).toEqual([])
      expect(s.notes, slug).toMatch(/Needs Google sign-in/)
      expect(s.notes, slug).toMatch(/no connector code/)
    }
  })

  it('has no em dash anywhere in the catalog', () => {
    expect(JSON.stringify(WAREHOUSE_CATALOG)).not.toContain(String.fromCharCode(8212))
  })
})
