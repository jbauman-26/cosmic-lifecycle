import { createHash } from 'node:crypto';
import { CliError } from './errors.js';
import { MIGRATIONS } from './schema.js';
import { settingValue } from './config.js';
import { assertNoPersonalColumns, markCatalog } from './sql-guard.js';
import { sourceOfSchema } from './warehouse-names.js';
import { scrubRows } from './personal.js';
// The default. lifecycle config set query.row_cap changes it.
export const ROW_CAP = 1000;
export const rowCap = () => settingValue('query.row_cap');
// Layered on purpose: this check gives a clear message, and the read-only
// transaction is what actually stops a write.
export function assertReadOnlySql(sql) {
    const body = sql.trim().replace(/;\s*$/, '');
    if (body.includes(';'))
        throw new CliError('Run one statement at a time.', 'Remove the extra statement and try again.', 'multiple_statements');
    if (!/^(select|with)\b/i.test(body))
        throw new CliError('Only SELECT queries are allowed.', 'lifecycle schema', 'read_only');
    if (/\b(pg_catalog|information_schema|pg_read_file|pg_ls_dir|dblink|copy)\b/i.test(body)) {
        throw new CliError('System tables and file access are blocked.', 'lifecycle schema', 'blocked_object');
    }
    return body;
}
// Every column this database holds, marked by the personal data rule list (src/personal.ts).
export async function pgCatalog(db) {
    const rows = await db.query(`SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`);
    return markCatalog(rows.map((r) => ({ schema: String(r.table_schema), table: String(r.table_name), column: String(r.column_name), type: String(r.data_type) })), sourceOfSchema);
}
// Refuses SQL that could return a personal column. If the list of columns cannot be read, nothing runs.
export async function assertNoPersonal(db, body) {
    let catalog;
    try {
        catalog = await pgCatalog(db);
    }
    catch (e) {
        throw new CliError(`The database's columns could not be listed, so the query was not run: ${e instanceof Error ? e.message : e}`, 'lifecycle doctor', 'query_failed');
    }
    assertNoPersonalColumns(body, catalog);
}
export async function runQuery(db, sql, cap = rowCap()) {
    const body = assertReadOnlySql(sql);
    await assertNoPersonal(db, body);
    let rows;
    try {
        rows = await db.readOnly(`SELECT * FROM (${body}) AS q LIMIT ${cap + 1}`);
    }
    catch (e) {
        throw new CliError(`Query failed: ${e instanceof Error ? e.message : e}`, 'lifecycle schema', 'query_failed');
    }
    const truncated = rows.length > cap;
    // The last check: an email address or phone number in returned text is replaced, whatever column it came from.
    const clean = scrubRows(truncated ? rows.slice(0, cap) : rows);
    return { rows: clean.rows, rowCount: Math.min(rows.length, cap), truncated, ...(clean.redacted ? { redacted: clean.redacted } : {}) };
}
// Normalized so the same question asked with different spacing or case counts once.
export const normalizeSql = (sql) => sql.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ').toLowerCase();
// Logs a custom query so `lifecycle metrics candidates` can suggest new verified metrics.
// Holds SQL text only; the database has no customer records to leak into it.
// Never throws: a failed log must not fail the query the user asked for.
export async function recordCustomQuery(db, sql) {
    try {
        await logQuery(db, sql);
    }
    catch {
        // Older database or a read-only role: skip the log.
    }
}
async function logQuery(db, sql) {
    await db.query(MIGRATIONS.find((m) => m.includes('meta_custom_query')));
    const norm = normalizeSql(sql);
    const hash = createHash('sha256').update(norm).digest('hex').slice(0, 16);
    await db.query(`INSERT INTO meta_custom_query (sql_hash, sql, runs, first_seen, last_seen) VALUES ($1, $2, 1, now(), now())
     ON CONFLICT (sql_hash) DO UPDATE SET runs = meta_custom_query.runs + 1, last_seen = now()`, [hash, norm]);
}
