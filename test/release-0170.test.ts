import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { buildMcpServer } from '../src/mcp.js'
import { addNote, notesFor, notesPath, readNotes, removeNote, withNotes } from '../src/notes.js'
import { METRICS } from '../src/metrics.js'

let home: string
let db: Db
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'lc-0170-'))
  process.env.LIFECYCLE_HOME = home
  process.env.LIFECYCLE_NO_KEYCHAIN = '1'
  db = wrapPglite(await PGlite.create())
  await migrate(db)
})
afterEach(async () => {
  await db.close()
  rmSync(home, { recursive: true, force: true })
  for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'LIFECYCLE_WORKSPACE']) delete process.env[k]
})

describe('0.17.0 owner notes', () => {
  it('keeps notes in the workspace folder, not the database, and matches them to metrics', async () => {
    expect(readNotes()).toEqual([])
    const all = addNote('  Exclude   wholesale orders from revenue ')
    const one = addNote('Black Friday 2025 is a one-off spike', 'shopify_net_revenue')
    expect(all).toMatchObject({ text: 'Exclude wholesale orders from revenue', metric: null })
    expect(existsSync(notesPath())).toBe(true)
    expect(notesPath().startsWith(home)).toBe(true)
    expect(notesFor('shopify_net_revenue').map((n) => n.id)).toEqual([all.id, one.id])
    expect(notesFor('shopify_orders').map((n) => n.id)).toEqual([all.id])
    expect(withNotes({ value: 1 })).toMatchObject({ owner_notes: { notes: [{ id: all.id }] } })
    removeNote(all.id)
    expect(withNotes({ value: 1 })).toEqual({ value: 1 })
    expect(() => removeNote('nope')).toThrow(/No note/)
    expect(() => addNote('')).toThrow(/needs some text/)
    expect(() => addNote('x'.repeat(501))).toThrow(/at most 500/)
    expect(() => addNote('ok', 'Bad Name')).toThrow(/Not a metric name/)
    const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE '%note%'`)
    expect(tables).toEqual([])
  })

  it('keeps each workspace its own notes', () => {
    addNote('client A only')
    process.env.LIFECYCLE_WORKSPACE = 'client-b'
    expect(readNotes()).toEqual([])
    addNote('client B only')
    expect(readNotes().map((n) => n.text)).toEqual(['client B only'])
    delete process.env.LIFECYCLE_WORKSPACE
    expect(readNotes().map((n) => n.text)).toEqual(['client A only'])
  })

  it('hands the matching notes to the agent with every MCP metric and query, and lists them', async () => {
    addNote('Exclude wholesale orders from revenue')
    addNote('AOV target is 80 dollars', 'average_order_value')
    const [c, s] = InMemoryTransport.createLinkedPair()
    await buildMcpServer(db).connect(s)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(c)
    const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text)
    const m = await call('metric', { name: 'shopify_orders', days: 30 })
    expect(m.sql).toBeTruthy()
    expect(m.trust).toBeTruthy()
    expect(m.owner_notes.notes.map((n: { text: string }) => n.text)).toEqual(['Exclude wholesale orders from revenue'])
    const aov = await call('metric', { name: 'average_order_value', days: 30 })
    expect(aov.owner_notes.notes).toHaveLength(2)
    const q = await call('query', { sql: 'SELECT 1 AS one' })
    expect(q.owner_notes.notes).toHaveLength(1)
    const list = await call('owner_notes')
    expect(list.notes).toHaveLength(2)
    expect(list.rule).toMatch(/do not change the SQL/)
  })
})

describe('0.17.0', () => {
  it('is version 0.17.0 everywhere, with a changelog entry and the metric definitions file', async () => {
    const { VERSION } = await import('../src/version.js')
    expect(VERSION).toBe('0.17.0')
    expect(JSON.parse(readFileSync('package-lock.json', 'utf8')).version).toBe('0.17.0')
    const log = readFileSync('CHANGELOG.md', 'utf8')
    expect(log).toMatch(/^## 0\.17\.0 \(2026-11-25\)/m)
    expect(log).not.toMatch(/[–—]/)
    const defs = readFileSync('docs/METRICS.md', 'utf8')
    for (const m of METRICS) expect(defs).toContain(`\`${m.name}\``)
    for (const f of ['README.md', 'llms.txt', 'docs/METRICS.md']) expect(readFileSync(f, 'utf8')).not.toMatch(/[–—]|store\.jakebauman\.io/)
  })
})

describe('0.17.0 MCP on a fresh install', () => {
  it('starts before lifecycle init, lists its tools and says nothing is set up', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'lc-0170-fresh-'))
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp'], { env: { ...process.env, LIFECYCLE_HOME: fresh, LIFECYCLE_NO_KEYCHAIN: '1', LIFECYCLE_NO_UPDATE_CHECK: '1' } })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    for (let i = 0; i < 100 && !out.includes('"id":2'); i++) await new Promise((r) => setTimeout(r, 100))
    child.kill()
    rmSync(fresh, { recursive: true, force: true })
    const lines = out.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].result.instructions).toMatch(/not set up yet/)
    const names = lines.find((l) => l.id === 2).result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['metric', 'reconcile', 'owner_notes', 'query']))
    expect(existsSync(join(fresh, 'config.json'))).toBe(false)
  }, 20000)
})
