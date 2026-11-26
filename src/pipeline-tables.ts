import pg from 'pg'
import { CliError } from './errors.js'
import { assertReadOnlySql } from './query.js'
import { assertNoBlockedFunctions, assertNoPersonalColumns, markCatalog, type CatalogColumn } from './sql-guard.js'
import { scrubRows } from './personal.js'
import { PIPELINE_TOOLS, type PipelineTool, type Query } from './pipeline.js'

// 0.21.0: any table a person's own Fivetran or Airbyte loads into their own Postgres, for any connector.
//
// Nothing is copied. `cosmic connect pipeline` without --source lists the tables in one schema, and from then on
// `cosmic schema`, `cosmic query` and the MCP server read them in place, read-only, through the database URL in an
// environment variable. Personal columns are left out of the schema and refused in queries by the same rule list
// the rest of Cosmic uses (src/personal.ts), and returned text is scrubbed for email addresses and phone numbers.
//
// The only check these tables get is freshness: when the loader last wrote to each one (Fivetran's _fivetran_synced,
// Airbyte's _airbyte_extracted_at). Their numbers are not reconciled against anything, and every answer says so.
// Stripe and Shopify keep their deep checks through `connect pipeline --source`.

export type SchemaSettings = { tool: PipelineTool; urlEnv: string; connectedAt: string; tables: string[] }
export type TableColumn = { name: string; type: string; personal: boolean }
export type DiscoveredTable = { table: string; loadedAtColumn: string | null; columns: TableColumn[] }

export const LOADED_AT: Record<PipelineTool, string> = { fivetran: '_fivetran_synced', airbyte: '_airbyte_extracted_at' }
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/
// Loader bookkeeping, not the person's data.
const SKIP = /^(_|fivetran_audit$|fivetran_audit_warning$|airbyte_)/

export function checkSchemaSettings(tool: string, schema: string, urlEnv: string) {
  if (!PIPELINE_TOOLS.includes(tool as PipelineTool)) throw new CliError(`Unknown pipeline tool: ${tool}. Use fivetran or airbyte.`, 'cosmic connect pipeline --tool fivetran --schema hubspot --url-env PIPELINE_DATABASE_URL', 'bad_value')
  if (!IDENT.test(schema)) throw new CliError(`Not a schema name: ${schema}. Use lowercase letters, numbers and underscores.`, 'The schema is the one your loader writes to, such as hubspot.', 'bad_value')
  if (/^(public|pg_\w*|information_schema|src_\w*)$/.test(schema)) throw new CliError(`The ${schema} schema is not a loader's schema.`, 'Name the schema your Fivetran or Airbyte connector writes to, such as hubspot.', 'bad_value')
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(urlEnv)) throw new CliError(`Not an environment variable name: ${urlEnv}.`, 'export PIPELINE_DATABASE_URL=postgres://... then pass --url-env PIPELINE_DATABASE_URL', 'bad_value')
}

// The connector's name, for the personal data rules: Fivetran and Airbyte name the schema after the connector by default.
const sourceOf = (schema: string) => schema.replace(/_\d+$/, '').replace(/_/g, '-')

// Loader tables hold whole records, so on top of the shared rules these are treated as personal too: contact
// handles, job titles, free-text bodies (an email's text, a ticket comment, a note) and raw JSON records.
const LOADER_PERSONAL = /(phone|mobile|fax|twitter|linkedin|facebook|instagram|handle|job_?title|^title$|_title$|salutation|^body$|_body$|^text$|_text$|html|message|comment|^note|_note|description|subject|signature|ip_?address|user_?agent|birth|gender|salary|^_airbyte_data$|_raw$)/i
const RAW_TYPES = /^(json|jsonb|xml|bytea|user-defined|array)$/i

export function markTable(schema: string, table: string, cols: { name: string; type: string }[]): TableColumn[] {
  const marked = markCatalog(cols.map((c) => ({ schema, table, column: c.name, type: c.type })), sourceOf)
  return marked.map((c) => ({ name: c.column, type: c.type ?? '', personal: c.personal || LOADER_PERSONAL.test(c.column) || RAW_TYPES.test(c.type ?? '') }))
}

// Any identifier, quoted, so a mixed-case or odd table name is never dropped or spliced in raw.
export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

export async function discoverTables(query: Query, tool: PipelineTool, schema: string): Promise<DiscoveredTable[]> {
  // Base tables only: a view can rename a personal column past the rules, so views are not registered.
  const rows = await query(`SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = $1 ORDER BY c.table_name, c.ordinal_position`, [schema])
  const byTable = new Map<string, { name: string; type: string }[]>()
  for (const r of rows) {
    const t = String(r.table_name)
    if (SKIP.test(t)) continue
    byTable.set(t, [...(byTable.get(t) ?? []), { name: String(r.column_name), type: String(r.data_type) }])
  }
  if (!byTable.size) throw new CliError(`No tables in the ${schema} schema of the pipeline database.`, 'Check the schema name your loader writes to: cosmic connect pipeline --tool fivetran --schema NAME --url-env NAME', 'pipeline_table_missing')
  return [...byTable].map(([table, cols]) => ({
    table,
    loadedAtColumn: cols.some((c) => c.name === LOADED_AT[tool]) ? LOADED_AT[tool] : null,
    columns: markTable(schema, table, cols),
  }))
}

export type TableFreshness = { table: string; lastLoaded: string | null; ageHours: number | null; status: 'fresh' | 'stale' | 'unknown' }
export type FreshnessTrust = { status: 'freshness_only' | 'stale'; line: string; tables: TableFreshness[] }

export async function tableFreshness(query: Query, tool: PipelineTool, schema: string, tables: string[], maxDays: number, now = Date.now()): Promise<TableFreshness[]> {
  const col = LOADED_AT[tool]
  const out: TableFreshness[] = []
  for (const table of tables) {
    const has = (await query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`, [schema, table, col])).length > 0
    if (!has) {
      out.push({ table, lastLoaded: null, ageHours: null, status: 'unknown' })
      continue
    }
    const r = (await query(`SELECT max(${quoteIdent(col)}) AS at FROM ${quoteIdent(schema)}.${quoteIdent(table)}`))[0]
    const at = r?.at ? new Date(r.at as string).toISOString() : null
    const age = at ? (now - Date.parse(at)) / 3600000 : null
    out.push({ table, lastLoaded: at, ageHours: age === null ? null : Math.round(age * 10) / 10, status: age === null ? 'unknown' : age > maxDays * 24 ? 'stale' : 'fresh' })
  }
  return out
}

const ago = (h: number) => (h < 1 ? 'less than an hour ago' : h < 48 ? `${Math.round(h)} hours ago` : `${Math.floor(h / 24)} days ago`)
export const FRESHNESS_ONLY = 'Freshness only: Cosmic checks when the loader last wrote these tables, not whether their numbers are right. They are not reconciled against any other source.'

/** The trust line for answers from these tables. It never says "passed". */
export function freshnessTrust(schema: string, fresh: TableFreshness[], maxDays: number): FreshnessTrust {
  const stale = fresh.filter((f) => f.status === 'stale')
  const unknown = fresh.filter((f) => f.status === 'unknown')
  const parts = fresh.filter((f) => f.status === 'fresh').map((f) => `${schema}.${f.table} loaded ${ago(f.ageHours!)}`)
  if (stale.length) {
    return { status: 'stale', tables: fresh, line: `STALE: ${stale.map((f) => `${schema}.${f.table} last loaded ${f.lastLoaded ? ago(f.ageHours!) : 'never'}`).join(', ')}, past the ${maxDays}-day limit, so these numbers may be behind. ${FRESHNESS_ONLY}` }
  }
  const tail = unknown.length ? `No load time for ${unknown.map((f) => `${schema}.${f.table}`).join(', ')}.` : ''
  const head = parts.length ? `${parts.join(', ')}.` : ''
  return { status: 'freshness_only', tables: fresh, line: `${[head, tail].filter(Boolean).join(' ') || 'No load times found.'} ${FRESHNESS_ONLY}` }
}

/** The registered schemas a query names, such as hubspot in "SELECT ... FROM hubspot.deal". */
// Strings and comments removed first, so 'hubspot.deal' as a label or in a comment never routes a local query.
// Routing only picks the database: what the query may read is decided by the plan check in pipelineQueryRun.
export const codeOnly = (sql: string) => sql
  .replace(/'(?:[^']|'')*'/g, "''")
  .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
  .replace(/--[^\n]*/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

export function schemasIn(sql: string, schemas: string[]) {
  const code = codeOnly(sql)
  return schemas.filter((s) => new RegExp(`(^|[^a-z0-9_"])"?${s}"?\\s*\\.`, 'i').test(code))
}

export function catalogFor(schema: string, tables: DiscoveredTable[]): CatalogColumn[] {
  return tables.flatMap((t) => t.columns.map((c) => ({ schema, table: t.table, column: c.name, type: c.type, personal: c.personal })))
}

export type PipelineConn = { query: Query; readOnly: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>; close: () => Promise<void> }

export function pipelineConn(urlEnv: string, env: NodeJS.ProcessEnv = process.env): PipelineConn {
  const url = env[urlEnv]
  if (!url) throw new CliError(`${urlEnv} is not set.`, `export ${urlEnv}=postgres://user:password@host/db (the database your loader writes to)`, 'missing_key')
  const pool = new pg.Pool({ connectionString: url, max: 1 })
  const wrap = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof CliError) throw e
      const err = e as { message?: string; code?: string; errors?: { code?: string }[] }
      const why = err.message || err.code || err.errors?.map((x) => x.code).filter(Boolean).join(', ') || 'no answer'
      // A SQL error has a five-character SQLSTATE that is not a connection (08) or login (28) class.
      if (err.code && /^[0-9A-Z]{5}$/.test(err.code) && !/^(08|28|3D|57P)/.test(err.code)) throw new CliError(`Query failed: ${why}`, 'cosmic schema NAME lists the tables and columns you can use', 'query_failed')
      throw new CliError(`Could not read the pipeline database in ${urlEnv}: ${why}.`, 'Check that the database is running and the URL is right. The CLI only reads.', 'pipeline_unreachable')
    }
  }
  return {
    query: (sql, params) => wrap(async () => (await pool.query(sql, params as unknown[])).rows),
    // A read-only transaction is what actually stops a write; the SQL check before it gives the clear message.
    readOnly: (sql, params) => wrap(async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN READ ONLY')
        await client.query(`SET LOCAL statement_timeout = '30s'`)
        return (await client.query(sql, params as unknown[])).rows
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    }),
    close: () => pool.end(),
  }
}

// Every table a query reads, as Postgres itself plans it: views and subqueries resolve to their base tables, and
// comments, quoting and string tricks do not matter. EXPLAIN plans the query without running it.
type PlanNode = { 'Relation Name'?: string; Schema?: string; Plans?: PlanNode[]; Output?: string[]; [k: string]: unknown }
export type TableRead = { schema: string; table: string; outputs: string[][] }
export type PlanRead = { tables: TableRead[]; tokens: Set<string>; text: string[]; functions: { schema: string | null; name: string }[] }
// Words in plan expressions (outputs, filters, keys, conditions), so a column read through a view, a function or a
// cast is still seen under its real name.
export function words(v: unknown, out: Set<string>) {
  if (typeof v === 'string') for (const m of v.matchAll(/"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*)/g)) out.add((m[1] ?? m[2]!).replace(/""/g, '"').toLowerCase())
  else if (Array.isArray(v)) v.forEach((x) => typeof x !== 'object' && words(x, out))
}
// Every expression string in the plan, as Postgres prints it: function names decoded, whatever the SQL spelled.
function strings(v: unknown, out: string[]) {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => typeof x !== 'object' && strings(x, out))
}
function walk(node: PlanNode, tables: Map<string, TableRead>, tokens: Set<string>, text: string[] = [], functions: PlanRead['functions'] = []) {
  for (const [k, v] of Object.entries(node)) if (k !== 'Plans' && k !== 'Node Type' && k !== 'Relation Name' && k !== 'Schema' && k !== 'Alias') strings(v, text)
  if (typeof node['Function Name'] === 'string') functions.push({ schema: typeof node.Schema === 'string' ? node.Schema : null, name: node['Function Name'] as string })
  const scan = Boolean(node['Relation Name'])
  if (scan) {
    const key = `${node.Schema ?? ''}\0${node['Relation Name']}`
    const r = tables.get(key) ?? { schema: node.Schema ?? '', table: node['Relation Name']!, outputs: [] }
    if (Array.isArray(node.Output)) r.outputs.push(node.Output)
    tables.set(key, r)
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'Plans') continue
    // A scan's output is judged with the table's column list (see pipelineQueryRun); everything else counts here.
    if (scan && k === 'Output') continue
    words(v, tokens)
  }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => typeof x === 'object' && x && walk(x as PlanNode, tables, tokens, text, functions))
    else if (typeof v === 'object' && v) walk(v as PlanNode, tables, tokens, text, functions)
  }
}
export async function tablesRead(conn: PipelineConn, body: string): Promise<PlanRead> {
  // The query is planned the way it runs: wrapped and limited. The top node then always lists the columns returned,
  // so a SELECT * view that flattens into a bare scan still names every column it hands back.
  const rows = await conn.readOnly(`EXPLAIN (FORMAT JSON, VERBOSE) SELECT * FROM (\n${body}\n) AS q LIMIT 1`)
  const plan = rows[0]?.['QUERY PLAN'] as unknown
  const parsed = (typeof plan === 'string' ? JSON.parse(plan) : plan) as { Plan: PlanNode }[]
  const tables = new Map<string, TableRead>()
  const tokens = new Set<string>()
  const text: string[] = []
  const functions: PlanRead['functions'] = []
  for (const p of parsed ?? []) walk(p.Plan, tables, tokens, text, functions)
  return { tables: [...tables.values()], tokens, text, functions }
}

// Function names called in the plan's expressions: name( or schema.name(.
const CALLS = /(?:"?([A-Za-z_][\w$]*)"?\.)?"?([A-Za-z_][\w$]*)"?\s*\(/g
export function callsIn(text: string[]) {
  const out: { schema: string | null; name: string }[] = []
  for (const t of text) for (const m of t.replace(/'(?:[^']|'')*'/g, "''").matchAll(CALLS)) out.push({ schema: m[1] ?? null, name: m[2]!.toLowerCase() })
  return out
}

/**
 * One read-only query against registered pipeline schemas in the same database (a query may join hubspot and
 * salesforce tables one loader wrote). Two checks run before it: every table Postgres would read must be a
 * registered loader table, and no column it names may be personal. Protection never depends on spotting a schema
 * name in the SQL text.
 */
export async function pipelineQueryRun(conn: PipelineConn, schemas: { schema: string; tool: PipelineTool }[], sql: string, cap: number, maxDays: number) {
  const body = assertReadOnlySql(sql)
  const found = await Promise.all(schemas.map(async (s) => ({ ...s, tables: await discoverTables(conn.query, s.tool, s.schema) })))
  const allowed = new Set(found.flatMap((f) => f.tables.map((t) => `${f.schema}\0${t.table}`)))
  assertNoPersonalColumns(body, found.flatMap((f) => catalogFor(f.schema, f.tables)))
  const plan = await tablesRead(conn, body)
  // Blocked functions, checked on Postgres's own spelling of the plan, so an escaped name (U&"...") is seen as itself.
  assertNoBlockedFunctions(callsIn(plan.text).map((c) => `${c.name}(`).join(' '))
  // A function defined in this database can read any table without the plan showing it, so only built-in
  // functions (pg_catalog) may be called.
  const called = [...callsIn(plan.text), ...plan.functions.map((f) => ({ schema: f.schema, name: f.name.toLowerCase() }))]
  const outsideSchema = called.filter((c) => c.schema && !['pg_catalog', 'information_schema'].includes(c.schema.toLowerCase()))
  const names = [...new Set(called.map((c) => c.name))]
  const userDefined = names.length
    ? (await conn.query(`SELECT DISTINCT lower(p.proname) AS name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND lower(p.proname) = ANY($1)`, [names])).map((r) => String(r.name))
    : []
  const own = [...new Set([...outsideSchema.map((c) => c.name), ...userDefined])]
  if (own.length) throw new CliError(`Refused: the query calls ${own.join(', ')}, a function defined in this database. Only built-in functions can be used on pipeline tables.`, 'Use built-in functions such as count, sum, date_trunc and coalesce.', 'blocked_object')
  const read = plan.tables
  const outside = read.filter((r) => !allowed.has(`${r.schema}\0${r.table}`))
  if (outside.length) {
    throw new CliError(`Refused: the query reads ${outside.map((r) => `${r.schema}.${r.table}`).join(', ')}, which ${outside.length === 1 ? 'is' : 'are'} not a connected pipeline table.`, `Only the tables cosmic schema ${schemas.map((s) => s.schema).join(' or ')} lists can be read. Connect another schema with cosmic connect pipeline --schema NAME`, 'not_connected')
  }
  // The same column rule, applied to what Postgres reads from each base table, so a view or an expression that
  // renames a personal column is refused too.
  for (const r of read) {
    const table = found.find((f) => f.schema === r.schema)?.tables.find((t) => t.table === r.table)!
    const all = table.columns.map((c) => c.name.toLowerCase())
    const tokens = new Set(plan.tokens)
    for (const out of r.outputs) {
      // Postgres may hand up every column of the row (a physical tuple) whatever the query uses; that list says
      // nothing about what is read, so only a real projection counts.
      const names = out.map((o) => o.replace(/^"?[^".]+"?\./, '').replace(/^"(.*)"$/, '$1').toLowerCase())
      if (names.length === all.length && names.every((n, i) => n === all[i])) continue
      for (const o of out) words(o, tokens)
    }
    const hit = table.columns.filter((c) => c.personal && tokens.has(c.name.toLowerCase())).map((c) => c.name)
    if (hit.length) throw new CliError(`That query was refused because it could return personal details. ${r.table}.${hit[0]} is marked personal.`, `cosmic schema ${r.schema}.${r.table} lists the columns you can use.`, 'personal_column')
  }
  // A newline before the closing parenthesis, so a query that ends in a -- comment still parses.
  const rows = await conn.readOnly(`SELECT * FROM (\n${body}\n) AS q LIMIT ${cap + 1}`)
  const truncated = rows.length > cap
  const clean = scrubRows(truncated ? rows.slice(0, cap) : rows)
  // Freshness for exactly the tables Postgres reads, inside the same 30-second limit.
  const timed: Query = (q, params) => conn.readOnly(q, params)
  const trusts = []
  const notes: string[] = []
  for (const f of found) {
    const mine = read.filter((r) => r.schema === f.schema).map((r) => r.table)
    if (!mine.length) continue
    trusts.push({ schema: f.schema, t: freshnessTrust(f.schema, await tableFreshness(timed, f.tool, f.schema, mine, maxDays), maxDays) })
    const deleted = f.tables.filter((t) => mine.includes(t.table) && t.columns.some((c) => c.name === '_fivetran_deleted')).map((t) => `${f.schema}.${t.table}`)
    if (deleted.length) notes.push(`${deleted.join(', ')} keep${deleted.length === 1 ? 's' : ''} rows deleted in the source, marked _fivetran_deleted = true. Add WHERE NOT _fivetran_deleted to leave them out.`)
  }
  const stale = trusts.some((x) => x.t.status === 'stale')
  const line = trusts.length ? `${trusts.map((x) => x.t.line.replace(` ${FRESHNESS_ONLY}`, '')).join(' ')} ${FRESHNESS_ONLY}` : FRESHNESS_ONLY
  return {
    pipeline: schemas,
    rows: clean.rows, rowCount: Math.min(rows.length, cap), truncated,
    ...(clean.redacted ? { redacted: clean.redacted } : {}),
    ...(notes.length ? { notes } : {}),
    trust: { status: stale ? 'stale' as const : 'freshness_only' as const, line, tables: trusts.flatMap((x) => x.t.tables.map((y) => ({ schema: x.schema, ...y }))) },
  }
}

/** Tables and columns of a registered schema, personal columns left out. */
export async function pipelineSchemaInfo(conn: PipelineConn, tool: PipelineTool, schema: string) {
  const tables = await discoverTables(conn.query, tool, schema)
  return tables.map((t) => ({
    table: `${schema}.${t.table}`,
    columns: t.columns.filter((c) => !c.personal).map((c) => `${c.name} ${c.type}`),
    leftOut: t.columns.filter((c) => c.personal).length,
  }))
}

export type RegisteredSchema = SchemaSettings & { schema: string }

/** Runs the query on the pipeline database when it names a registered schema; null when it names none. */
// A hand-edited config.json could hold any string; only plain schema names are ever used.
const valid = (list: RegisteredSchema[]) => list.filter((p) => IDENT.test(p.schema) && PIPELINE_TOOLS.includes(p.tool))

export async function queryNamedPipeline(sql: string, all: RegisteredSchema[], cap: number, maxDays: number) {
  const registered = valid(all)
  const named = registered.filter((p) => schemasIn(sql, [p.schema]).length)
  if (!named.length) return null
  if (new Set(named.map((p) => p.urlEnv)).size > 1) throw new CliError('These schemas are in different pipeline databases, so one query cannot read them together.', 'Query one database at a time.', 'bad_value')
  // Every registered schema in that database is checked, not only the ones the SQL text seems to name.
  const sameDb = registered.filter((p) => p.urlEnv === named[0]!.urlEnv)
  const conn = pipelineConn(named[0]!.urlEnv)
  try {
    return await pipelineQueryRun(conn, sameDb.map((p) => ({ schema: p.schema, tool: p.tool })), sql, cap, maxDays)
  } finally {
    await conn.close().catch(() => undefined)
  }
}

/** Every registered schema's tables and their non-personal columns, for an agent's schema listing. */
export async function pipelineListing(registered: RegisteredSchema[]) {
  const out: Record<string, string[]> = {}
  for (const p of valid(registered)) {
    let conn: PipelineConn | undefined
    try {
      conn = pipelineConn(p.urlEnv)
      for (const t of await pipelineSchemaInfo(conn, p.tool, p.schema)) out[t.table] = [...t.columns, `(${p.tool} table read in place: freshness checked only, not reconciled${t.leftOut ? `; ${t.leftOut} personal columns left out` : ''})`]
    } catch (e) {
      out[`${p.schema}.*`] = [`(could not be read: ${e instanceof Error ? e.message : String(e)})`]
    } finally {
      await conn?.close().catch(() => undefined)
    }
  }
  return out
}
