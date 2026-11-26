import { mkdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import { MIGRATIONS } from './schema.js'
import { localDbPath } from './paths.js'
import { readConfig } from './config.js'
import { getSecret } from './secrets.js'
import { CliError } from './errors.js'

export type Row = Record<string, unknown>
export type Tx = { query(sql: string, params?: unknown[]): Promise<Row[]> }

export interface Db extends Tx {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  readOnly(sql: string, params?: unknown[]): Promise<Row[]>
  close(): Promise<void>
}

export function wrapPglite(client: PGlite): Db {
  return {
    query: async (sql, params) => (await client.query<Row>(sql, params as never[])).rows,
    transaction: async (fn) => {
      const out = await client.transaction((tx) => fn({ query: async (sql, params) => (await tx.query<Row>(sql, params as never[])).rows }))
      return out as Awaited<ReturnType<typeof fn>>
    },
    readOnly: async (sql, params) => {
      await client.exec('BEGIN READ ONLY')
      try {
        return (await client.query<Row>(sql, params as never[])).rows
      } finally {
        await client.exec('ROLLBACK')
      }
    },
    close: () => client.close(),
  }
}

// LIFECYCLE_DB_SCHEMA names the schema this store lives in, for a database that
// holds one schema per store. Unset, the connection's own schema is used: whatever
// its role or URL puts first on the search path, which is `public` on a plain database.
export function dbSchema(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.LIFECYCLE_DB_SCHEMA?.trim()
  if (!s) return null
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s) || /^pg_/i.test(s) || s.toLowerCase() === 'information_schema') {
    throw new CliError('LIFECYCLE_DB_SCHEMA is not a usable schema name.', 'Use letters, numbers and underscores, such as store_acme.', 'bad_schema')
  }
  return s
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`

// The slice of pg this file uses, so tests can pass a recorder instead of a server.
type PgClient = { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>; release(): void }
export type PgPool = { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>; connect(): Promise<PgClient>; end(): Promise<void> }

export function wrapPg(pool: PgPool, schema: string | null = dbSchema()): Db {
  return {
    // With a named schema, every statement runs with that schema set for its own transaction.
    // SET LOCAL holds on any connection, including one handed out by a transaction pooler.
    query: async (sql, params) => {
      if (!schema) return (await pool.query(sql, params as unknown[])).rows as Row[]
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        await c.query(`SET LOCAL search_path = ${quoteIdent(schema)}`)
        const rows = (await c.query(sql, params as unknown[])).rows as Row[]
        await c.query('COMMIT')
        return rows
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        c.release()
      }
    },
    transaction: async (fn) => {
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        if (schema) await c.query(`SET LOCAL search_path = ${quoteIdent(schema)}`)
        const out = await fn({ query: async (sql, params) => (await c.query(sql, params as unknown[])).rows as Row[] })
        await c.query('COMMIT')
        return out
      } catch (e) {
        await c.query('ROLLBACK')
        throw e
      } finally {
        c.release()
      }
    },
    readOnly: async (sql, params) => {
      const c = await pool.connect()
      try {
        await c.query('BEGIN READ ONLY')
        await c.query(`SET LOCAL statement_timeout = '15s'`)
        // Pin the search path to one schema for the query: the store's own. It used to be
        // forced to `public`, which hid every table of a store that lives in its own schema.
        // System schemas are still refused by assertReadOnlySql before the query gets here.
        const own = schema ?? String(((await c.query('SELECT current_schema() AS s')).rows[0] as { s?: string } | undefined)?.s ?? 'public')
        await c.query(`SET LOCAL search_path = ${quoteIdent(own)}`)
        return (await c.query(sql, params?.length ? params : undefined)).rows as Row[]
      } finally {
        await c.query('ROLLBACK').catch(() => {})
        c.release()
      }
    },
    close: () => pool.end(),
  }
}

export async function migrate(db: Tx) {
  for (const m of MIGRATIONS) await db.query(m)
}

export async function openDb(): Promise<Db> {
  const config = readConfig()
  if (config.database.kind === 'local') {
    mkdirSync(localDbPath(), { recursive: true, mode: 0o700 })
    const client = new PGlite(localDbPath())
    await client.waitReady
    return wrapPglite(client)
  }
  const url = getSecret('database-url')
  if (!url) throw new CliError('No database URL saved.', 'Set LIFECYCLE_DATABASE_URL, or run cosmic init for the local database.', 'no_database')
  const schema = dbSchema()
  // With LIFECYCLE_DB_SCHEMA set, reads and writes both land in that schema.
  return wrapPg(new pg.Pool({ connectionString: url, max: 2 }) as unknown as PgPool, schema)
}
