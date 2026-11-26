import { createHash } from 'node:crypto'
import type { Db, Tx } from './db.js'
import { CliError } from './errors.js'
import { MIGRATIONS, SCRAMBLED_ID_COLUMNS } from './schema.js'
import { settingValue } from './config.js'
import { assertNoPersonalColumns, markCatalog, type CatalogColumn } from './sql-guard.js'
import { sourceOfSchema } from './warehouse-names.js'
import { scrubRows } from './personal.js'

// The default. cosmic config set query.row_cap changes it.
export const ROW_CAP = 1000
export const rowCap = () => settingValue('query.row_cap')

// Layered on purpose: this check gives a clear message, and the read-only
// transaction is what actually stops a write.
export function assertReadOnlySql(sql: string) {
  const body = sql.trim().replace(/;\s*$/, '')
  if (body.includes(';')) throw new CliError('Run one statement at a time.', 'Remove the extra statement and try again.', 'multiple_statements')
  if (!/^(select|with)\b/i.test(body)) throw new CliError('Only SELECT queries are allowed.', 'cosmic schema', 'read_only')
  if (/\b(pg_catalog|information_schema|pg_read_file|pg_ls_dir|dblink\w*|lo_\w+|copy)\b/i.test(body)) {
    throw new CliError('System tables and file access are blocked.', 'cosmic schema', 'blocked_object')
  }
  return body
}

// Every column this database holds, marked by the personal data rule list (src/personal.ts).
export async function pgCatalog(db: Tx): Promise<CatalogColumn[]> {
  const rows = await db.query(`SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`)
  const scrambled = (t: string, c: string) => SCRAMBLED_ID_COLUMNS.some((s) => s.table === t && s.column === c)
  return markCatalog(rows.map((r) => ({ schema: String(r.table_schema), table: String(r.table_name), column: String(r.column_name), type: String(r.data_type) })), sourceOfSchema)
    .map((c) => (scrambled(c.table, c.column) ? { ...c, personal: true } : c))
}

// Refuses SQL that could return a personal column. If the list of columns cannot be read, nothing runs.
export async function assertNoPersonal(db: Tx, body: string) {
  let catalog: CatalogColumn[]
  try {
    catalog = await pgCatalog(db)
  } catch (e) {
    throw new CliError(`The database's columns could not be listed, so the query was not run: ${e instanceof Error ? e.message : e}`, 'cosmic doctor', 'query_failed')
  }
  assertNoPersonalColumns(body, catalog)
}

export async function runQuery(db: Db, sql: string, cap = rowCap()) {
  const body = assertReadOnlySql(sql)
  await assertNoPersonal(db, body)
  let rows
  try {
    rows = await db.readOnly(`SELECT * FROM (${body}) AS q LIMIT ${cap + 1}`)
  } catch (e) {
    throw new CliError(`Query failed: ${e instanceof Error ? e.message : e}`, 'cosmic schema', 'query_failed')
  }
  const truncated = rows.length > cap
  // The last check: an email address or phone number in returned text is replaced, whatever column it came from.
  const clean = scrubRows(truncated ? rows.slice(0, cap) : rows)
  return { rows: clean.rows, rowCount: Math.min(rows.length, cap), truncated, ...(clean.redacted ? { redacted: clean.redacted } : {}) }
}

// Normalized so the same question asked with different spacing or case counts once.
export const normalizeSql = (sql: string) => sql.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ').toLowerCase()

// Logs a custom query so `cosmic metrics candidates` can suggest new verified metrics.
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
