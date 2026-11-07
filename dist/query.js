import { CliError } from './errors.js';
export const ROW_CAP = 1000;
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
export async function runQuery(db, sql) {
    const body = assertReadOnlySql(sql);
    let rows;
    try {
        rows = await db.readOnly(`SELECT * FROM (${body}) AS q LIMIT ${ROW_CAP + 1}`);
    }
    catch (e) {
        throw new CliError(`Query failed: ${e instanceof Error ? e.message : e}`, 'lifecycle schema', 'query_failed');
    }
    const truncated = rows.length > ROW_CAP;
    return { rows: truncated ? rows.slice(0, ROW_CAP) : rows, rowCount: Math.min(rows.length, ROW_CAP), truncated };
}
