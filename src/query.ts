import { createHash } from 'node:crypto'
import type { Db, Tx } from './db.js'
import { CliError } from './errors.js'
import { MIGRATIONS } from './schema.js'

export const ROW_CAP = 1000

// Layered on purpose: this check gives a clear message, and the read-only
// transaction is what actually stops a write.
export function assertReadOnlySql(sql: string) {
  const body = sql.trim().replace(/;\s*$/, '')
  if (body.includes(';')) throw new CliError('Run one statement at a time.', 'Remove the extra statement and try again.', 'multiple_statements')
  if (!/^(select|with)\b/i.test(body)) throw new CliError('Only SELECT queries are allowed.', 'lifecycle schema', 'read_only')
  if (/\b(pg_catalog|information_schema|pg_read_file|pg_ls_dir|dblink|copy)\b/i.test(body)) {
    throw new CliError('System tables and file access are blocked.', 'lifecycle schema', 'blocked_object')
  }
  return body
}

export async function runQuery(db: Db, sql: string) {
  const body = assertReadOnlySql(sql)
  let rows
  try {
    rows = await db.readOnly(`SELECT * FROM (${body}) AS q LIMIT ${ROW_CAP + 1}`)
  } catch (e) {
    throw new CliError(`Query failed: ${e instanceof Error ? e.message : e}`, 'lifecycle schema', 'query_failed')
  }
  const truncated = rows.length > ROW_CAP
  return { rows: truncated ? rows.slice(0, ROW_CAP) : rows, rowCount: Math.min(rows.length, ROW_CAP), truncated }
}

// Normalized so the same question asked with different spacing or case counts once.
export const normalizeSql = (sql: string) => sql.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ').toLowerCase()

// Logs a custom query so `lifecycle metrics candidates` can suggest new verified metrics.
// Holds SQL text only; the database has no customer records to leak into it.
// Never throws: a failed log must not fail the query the user asked for.
export async function recordCustomQuery(db: Tx, sql: string) {
  try {
    await logQuery(db, sql)
  } catch {
    // Older database or a read-only role: skip the log.
  }
}

async function logQuery(db: Tx, sql: string) {
  await db.query(MIGRATIONS.find((m) => m.includes('meta_custom_query'))!)
  const norm = normalizeSql(sql)
  const hash = createHash('sha256').update(norm).digest('hex').slice(0, 16)
  await db.query(
    `INSERT INTO meta_custom_query (sql_hash, sql, runs, first_seen, last_seen) VALUES ($1, $2, 1, now(), now())
     ON CONFLICT (sql_hash) DO UPDATE SET runs = meta_custom_query.runs + 1, last_seen = now()`,
    [hash, norm],
  )
}
