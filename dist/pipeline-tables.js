import pg from 'pg';
import { CliError } from './errors.js';
import { assertReadOnlySql } from './query.js';
import { assertNoPersonalColumns, markCatalog } from './sql-guard.js';
import { scrubRows } from './personal.js';
import { PIPELINE_TOOLS } from './pipeline.js';
export const LOADED_AT = { fivetran: '_fivetran_synced', airbyte: '_airbyte_extracted_at' };
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
// Loader bookkeeping, not the person's data.
const SKIP = /^(_|fivetran_audit$|fivetran_audit_warning$|airbyte_)/;
export function checkSchemaSettings(tool, schema, urlEnv) {
    if (!PIPELINE_TOOLS.includes(tool))
        throw new CliError(`Unknown pipeline tool: ${tool}. Use fivetran or airbyte.`, 'cosmic connect pipeline --tool fivetran --schema hubspot --url-env PIPELINE_DATABASE_URL', 'bad_value');
    if (!IDENT.test(schema))
        throw new CliError(`Not a schema name: ${schema}. Use lowercase letters, numbers and underscores.`, 'The schema is the one your loader writes to, such as hubspot.', 'bad_value');
    if (/^(public|pg_\w*|information_schema|src_\w*)$/.test(schema))
        throw new CliError(`The ${schema} schema is not a loader's schema.`, 'Name the schema your Fivetran or Airbyte connector writes to, such as hubspot.', 'bad_value');
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(urlEnv))
        throw new CliError(`Not an environment variable name: ${urlEnv}.`, 'export PIPELINE_DATABASE_URL=postgres://... then pass --url-env PIPELINE_DATABASE_URL', 'bad_value');
}
// The connector's name, for the personal data rules: Fivetran and Airbyte name the schema after the connector by default.
const sourceOf = (schema) => schema.replace(/_\d+$/, '').replace(/_/g, '-');
export function markTable(schema, table, cols) {
    const marked = markCatalog(cols.map((c) => ({ schema, table, column: c.name, type: c.type })), sourceOf);
    return marked.map((c) => ({ name: c.column, type: c.type ?? '', personal: c.personal }));
}
export async function discoverTables(query, tool, schema) {
    const rows = await query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`, [schema]);
    const byTable = new Map();
    for (const r of rows) {
        const t = String(r.table_name);
        if (SKIP.test(t))
            continue;
        byTable.set(t, [...(byTable.get(t) ?? []), { name: String(r.column_name), type: String(r.data_type) }]);
    }
    if (!byTable.size)
        throw new CliError(`No tables in the ${schema} schema of the pipeline database.`, 'Check the schema name your loader writes to: cosmic connect pipeline --tool fivetran --schema NAME --url-env NAME', 'pipeline_table_missing');
    return [...byTable].map(([table, cols]) => ({
        table,
        loadedAtColumn: cols.some((c) => c.name === LOADED_AT[tool]) ? LOADED_AT[tool] : null,
        columns: markTable(schema, table, cols),
    }));
}
export async function tableFreshness(query, tool, schema, tables, maxDays, now = Date.now()) {
    const col = LOADED_AT[tool];
    const out = [];
    for (const table of tables) {
        if (!IDENT.test(table))
            continue;
        const has = (await query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`, [schema, table, col])).length > 0;
        if (!has) {
            out.push({ table, lastLoaded: null, ageHours: null, status: 'unknown' });
            continue;
        }
        const r = (await query(`SELECT max("${col}") AS at FROM "${schema}"."${table}"`))[0];
        const at = r?.at ? new Date(r.at).toISOString() : null;
        const age = at ? (now - Date.parse(at)) / 3600000 : null;
        out.push({ table, lastLoaded: at, ageHours: age === null ? null : Math.round(age * 10) / 10, status: age === null ? 'unknown' : age > maxDays * 24 ? 'stale' : 'fresh' });
    }
    return out;
}
const ago = (h) => (h < 1 ? 'less than an hour ago' : h < 48 ? `${Math.round(h)} hours ago` : `${Math.floor(h / 24)} days ago`);
export const FRESHNESS_ONLY = 'Freshness only: Cosmic checks when the loader last wrote these tables, not whether their numbers are right. They are not reconciled against any other source.';
/** The trust line for answers from these tables. It never says "passed". */
export function freshnessTrust(schema, fresh, maxDays) {
    const stale = fresh.filter((f) => f.status === 'stale');
    const unknown = fresh.filter((f) => f.status === 'unknown');
    const parts = fresh.filter((f) => f.status === 'fresh').map((f) => `${schema}.${f.table} loaded ${ago(f.ageHours)}`);
    if (stale.length) {
        return { status: 'stale', tables: fresh, line: `STALE: ${stale.map((f) => `${schema}.${f.table} last loaded ${f.lastLoaded ? ago(f.ageHours) : 'never'}`).join(', ')}, past the ${maxDays}-day limit, so these numbers may be behind. ${FRESHNESS_ONLY}` };
    }
    const tail = unknown.length ? ` No load time for ${unknown.map((f) => `${schema}.${f.table}`).join(', ')}.` : '';
    return { status: 'freshness_only', tables: fresh, line: `${parts.length ? `${parts.join(', ')}.` : 'No load times found.'}${tail} ${FRESHNESS_ONLY}` };
}
/** The registered schemas a query names, such as hubspot in "SELECT ... FROM hubspot.deal". */
export function schemasIn(sql, schemas) {
    return schemas.filter((s) => new RegExp(`(^|[^a-z0-9_"])"?${s}"?\\s*\\.`, 'i').test(sql));
}
export function catalogFor(schema, tables) {
    return tables.flatMap((t) => t.columns.map((c) => ({ schema, table: t.table, column: c.name, type: c.type, personal: c.personal })));
}
export function pipelineConn(urlEnv, env = process.env) {
    const url = env[urlEnv];
    if (!url)
        throw new CliError(`${urlEnv} is not set.`, `export ${urlEnv}=postgres://user:password@host/db (the database your loader writes to)`, 'missing_key');
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const wrap = async (fn) => {
        try {
            return await fn();
        }
        catch (e) {
            if (e instanceof CliError)
                throw e;
            const err = e;
            const why = err.message || err.code || err.errors?.map((x) => x.code).filter(Boolean).join(', ') || 'no answer';
            throw new CliError(`Could not read the pipeline database in ${urlEnv}: ${why}.`, 'Check that the database is running and the URL is right. The CLI only reads.', 'pipeline_unreachable');
        }
    };
    return {
        query: (sql, params) => wrap(async () => (await pool.query(sql, params)).rows),
        // A read-only transaction is what actually stops a write; the SQL check before it gives the clear message.
        readOnly: (sql) => wrap(async () => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN READ ONLY');
                await client.query(`SET LOCAL statement_timeout = '30s'`);
                return (await client.query(sql)).rows;
            }
            finally {
                await client.query('ROLLBACK').catch(() => undefined);
                client.release();
            }
        }),
        close: () => pool.end(),
    };
}
/**
 * One read-only query against registered pipeline schemas in the same database (a query may join hubspot and
 * salesforce tables one loader wrote). Personal columns are refused before it runs.
 */
export async function pipelineQueryRun(conn, schemas, sql, cap, maxDays) {
    const body = assertReadOnlySql(sql);
    const found = await Promise.all(schemas.map(async (s) => ({ ...s, tables: await discoverTables(conn.query, s.tool, s.schema) })));
    assertNoPersonalColumns(body, found.flatMap((f) => catalogFor(f.schema, f.tables)));
    let rows;
    try {
        rows = await conn.readOnly(`SELECT * FROM (${body}) AS q LIMIT ${cap + 1}`);
    }
    catch (e) {
        if (e instanceof CliError && e.code === 'pipeline_unreachable' && !/connect|ECONN|ENOTFOUND|password|authentication/i.test(e.message)) {
            throw new CliError(`Query failed: ${e.message.replace(/^Could not read the pipeline database in \w+: /, '')}`, `cosmic schema ${schemas[0].schema}`, 'query_failed');
        }
        throw e;
    }
    const truncated = rows.length > cap;
    const clean = scrubRows(truncated ? rows.slice(0, cap) : rows);
    // Freshness for the tables the query names, or every table of the schema when it names none.
    const trusts = [];
    for (const f of found) {
        const named = f.tables.map((t) => t.table).filter((t) => new RegExp(`\\b${f.schema}"?\\s*\\.\\s*"?${t}\\b`, 'i').test(body));
        trusts.push(freshnessTrust(f.schema, await tableFreshness(conn.query, f.tool, f.schema, named.length ? named : f.tables.map((t) => t.table), maxDays), maxDays));
    }
    const stale = trusts.some((t) => t.status === 'stale');
    return {
        pipeline: schemas,
        rows: clean.rows, rowCount: Math.min(rows.length, cap), truncated,
        ...(clean.redacted ? { redacted: clean.redacted } : {}),
        trust: { status: stale ? 'stale' : 'freshness_only', line: trusts.map((t) => t.line.replace(` ${FRESHNESS_ONLY}`, '')).join(' ') + ` ${FRESHNESS_ONLY}`, tables: trusts.flatMap((t, i) => t.tables.map((x) => ({ schema: found[i].schema, ...x }))) },
    };
}
/** Tables and columns of a registered schema, personal columns left out. */
export async function pipelineSchemaInfo(conn, tool, schema) {
    const tables = await discoverTables(conn.query, tool, schema);
    return tables.map((t) => ({
        table: `${schema}.${t.table}`,
        columns: t.columns.filter((c) => !c.personal).map((c) => `${c.name} ${c.type}`),
        leftOut: t.columns.filter((c) => c.personal).length,
    }));
}
/** Runs the query on the pipeline database when it names a registered schema; null when it names none. */
export async function queryNamedPipeline(sql, registered, cap, maxDays) {
    const named = registered.filter((p) => schemasIn(sql, [p.schema]).length);
    if (!named.length)
        return null;
    if (new Set(named.map((p) => p.urlEnv)).size > 1)
        throw new CliError('These schemas are in different pipeline databases, so one query cannot read them together.', 'Query one database at a time.', 'bad_value');
    const conn = pipelineConn(named[0].urlEnv);
    try {
        return await pipelineQueryRun(conn, named.map((p) => ({ schema: p.schema, tool: p.tool })), sql, cap, maxDays);
    }
    finally {
        await conn.close().catch(() => undefined);
    }
}
/** Every registered schema's tables and their non-personal columns, for an agent's schema listing. */
export async function pipelineListing(registered) {
    const out = {};
    for (const p of registered) {
        let conn;
        try {
            conn = pipelineConn(p.urlEnv);
            for (const t of await pipelineSchemaInfo(conn, p.tool, p.schema))
                out[t.table] = [...t.columns, `(${p.tool} table read in place: freshness checked only, not reconciled${t.leftOut ? `; ${t.leftOut} personal columns left out` : ''})`];
        }
        catch (e) {
            out[`${p.schema}.*`] = [`(could not be read: ${e instanceof Error ? e.message : String(e)})`];
        }
        finally {
            await conn?.close().catch(() => undefined);
        }
    }
    return out;
}
