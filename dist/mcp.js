import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, migrate, wrapPglite } from './db.js';
import { CliError } from './errors.js';
import { recordCustomQuery, rowCap, runQuery } from './query.js';
import { pipelineListing, queryNamedPipeline } from './pipeline-tables.js';
import { readRawConfig, settingValue } from './config.js';
import { reconcile } from './reconcile.js';
import { auditFlows, revenuePerFlow } from './reports.js';
import { PUBLIC_TABLES } from './schema.js';
import { VERSION } from './version.js';
import { customTables } from './custom-sources.js';
import { defaultToolContext, runTool, toolCatalog, TOOLS } from './tools.js';
import { listFiles, readFile } from './files.js';
import { DOCS } from './docs.js';
import { listAllMetrics, metricCandidates, runMetric } from './metrics.js';
import { tryWriteLock, withWriteLock } from './lock.js';
import { ALL_NATIVE, CATALOG } from './sources-catalog.js';
import { readWorkspace, REFERENCE_NAME, TYPES, WORKSPACE_TYPES } from './workspace.js';
import { assertPack, defaultDays } from './metrics.js';
import { rollupMetric } from './rollup.js';
import { workspaceName } from './paths.js';
import { NOTES_RULE, readNotes, withNotes } from './notes.js';
const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
// 0.21.0: pipeline schemas from config.json, read in place. Unreadable config means none.
const registered = () => {
    try {
        const raw = readRawConfig();
        return Object.entries(raw?.pipeline?.schemas ?? {}).map(([schema, x]) => ({ schema, ...x }));
    }
    catch {
        return [];
    }
};
export async function schemaInfo(db) {
    const out = {};
    Object.assign(out, await pipelineListing(registered()));
    for (const t of [...PUBLIC_TABLES, ...(await customTables(db))]) {
        const rows = await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [t]);
        out[t] = rows.map((r) => `${r.column_name} ${r.data_type}`);
    }
    return out;
}
// Read-only by construction: there is no sync, connect or segment tool here.
export const NOT_SET_UP = 'This workspace is not set up yet, so there are no numbers. Tell the user to run cosmic init, or follow cosmic docs quickstart. Until then every tool that needs the workspace answers with "Not set up yet".';
export async function startMcp() {
    // 0.17.0: a fresh install starts the server too, so `claude mcp add` works before setup.
    // It runs on an empty in-memory database and says plainly that nothing is set up.
    let db;
    try {
        db = await openDb();
    }
    catch (e) {
        if (!(e instanceof CliError) || e.code !== 'not_initialized')
            throw e;
        const { PGlite } = await import('@electric-sql/pglite');
        db = wrapPglite(await PGlite.create());
        await migrate(db);
        await buildMcpServer(db, NOT_SET_UP).connect(new StdioServerTransport());
        return;
    }
    // Bring an older store up to date, unless a sync is writing right now: then it is already current.
    const startLock = tryWriteLock('mcp start');
    if (startLock) {
        try {
            await migrate(db);
        }
        finally {
            startLock();
        }
    }
    await buildMcpServer(db).connect(new StdioServerTransport());
}
export function buildMcpServer(db, notice) {
    const server = new McpServer({ name: 'cosmic-lifecycle', version: VERSION }, { instructions: notice ? `${notice}\n\n${DOCS.agents}` : DOCS.agents });
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    server.registerTool('list_metrics', {
        description: 'List the verified metrics for this workspace type, plus any numbers the owner saved (saved: true). Prefer these to writing SQL: the same metric always runs the same SQL.',
        inputSchema: { pack: z.enum([...WORKSPACE_TYPES, 'all']).optional().describe('a metric pack; defaults to this workspace\'s type. all lists every built-in metric') },
        annotations: readOnly,
    }, async ({ pack }) => text(await listAllMetrics(db, pack ? assertPack(pack) : undefined)));
    server.registerTool('workspace', { description: 'What kind of business this workspace is, the source of truth its numbers are checked against, and the sources it usually connects. Read this first.', annotations: readOnly }, async () => {
        const w = readWorkspace();
        return text({ type: w.type, title: TYPES[w.type].title, reference: w.reference, referenceName: REFERENCE_NAME[w.reference], referenceWhy: TYPES[w.type].referenceWhy, sources: TYPES[w.type].sources });
    });
    server.registerTool('metric', {
        description: 'Run one metric over a window: a verified one, or a number the owner saved (the result says saved: true, and its SQL is the owner\'s, not reviewed). Returns the value, its inputs, the exact SQL and the trust line. Names come from list_metrics.',
        inputSchema: {
            name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/).describe('a name from list_metrics'),
            days: z.number().int().min(1).max(730).optional().describe('window in days; defaults to metrics.default_days, 90 unless changed'),
            stores: z.union([z.literal('all'), z.array(z.string().regex(/^(default|[a-z0-9][a-z0-9-]{0,39})$/))]).optional().describe('add the metric up across stores (workspaces on this machine): all, or a list. Needs currency'),
            currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('reporting currency for stores, such as USD'),
            rate_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('exchange rate date; defaults to the latest'),
        },
        annotations: readOnly,
    }, async ({ name, days, stores, currency, rate_date }) => text(withNotes(stores
        ? await rollupMetric(name, { stores, currency, days: days ?? defaultDays(), rateDate: rate_date, open: { store: workspaceName() ?? 'default', db } })
        : await runMetric(db, name, days), name)));
    server.registerTool('owner_notes', { description: 'The owner\'s business context and past corrections, such as "exclude wholesale orders". Read them before explaining any number. metric and query results carry the matching ones as owner_notes.', annotations: readOnly }, async () => text({ rule: NOTES_RULE, notes: readNotes() }));
    server.registerTool('list_source_catalog', { description: 'Sources this CLI can connect, what each syncs, and the command to connect it.', annotations: readOnly }, async () => text(readWorkspace().type === 'shopify' ? CATALOG : ALL_NATIVE));
    server.registerTool('list_tool_catalog', { description: 'Read-only Klaviyo and Shopify API tools that run on the user\'s own keys.', annotations: readOnly }, async () => text(toolCatalog()));
    server.registerTool('run_tool', {
        description: 'Run one read-only Klaviyo or Shopify tool on the user\'s own keys. Returns no personal data. The run is saved locally.',
        inputSchema: { tool: z.enum(TOOLS.map((t) => t.id)), input: z.record(z.string(), z.unknown()).default({}) },
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ tool, input }) => text(await runTool(tool, input, defaultToolContext())));
    server.registerTool('list_files', { description: 'Reports, dashboards and plans this CLI has saved, newest first.', annotations: readOnly }, async () => text(listFiles()));
    server.registerTool('read_file', { description: 'Read one saved report, dashboard or plan by its path from list_files.', inputSchema: { path: z.string() }, annotations: readOnly }, async ({ path }) => text({ path, content: readFile(path) }));
    server.registerTool('explore_schema', { description: 'List tables and columns. Call this before writing SQL.', annotations: readOnly }, async () => text(await schemaInfo(db)));
    server.registerTool('query', { description: 'Run one read-only SELECT, capped at 1,000 rows. Use only when no verified metric fits. The SQL text is logged locally so repeated questions can become verified metrics.', inputSchema: { sql: z.string() }, annotations: { openWorldHint: false } }, async ({ sql }) => {
        // A query naming a pipeline schema runs on that database, read-only, with a freshness-only trust line.
        const piped = await queryNamedPipeline(sql, registered(), rowCap(), settingValue('reconcile.freshness_days'));
        if (piped)
            return text(withNotes(piped));
        const r = await runQuery(db, sql);
        // The log is a write. If a sync holds the store, skip the log rather than write beside it.
        const lock = tryWriteLock('mcp query log');
        if (lock) {
            try {
                await recordCustomQuery(db, sql);
            }
            finally {
                lock();
            }
        }
        return text(withNotes(r));
    });
    server.registerTool('metric_candidates', { description: 'Custom queries run more than once. Each is a candidate to become a verified metric.', annotations: readOnly }, async () => text(await metricCandidates(db)));
    server.registerTool('reconcile', { description: 'Prove the numbers agree across sources. Run this before quoting a number.', annotations: { openWorldHint: false } }, async () => text(await withWriteLock('mcp reconcile', () => reconcile(db))));
    server.registerTool('revenue_per_flow', { description: 'Rank flows by attributed revenue per recipient.', inputSchema: { days: z.number().int().min(1).max(365).optional().describe('window in days; defaults to metrics.default_days') }, annotations: readOnly }, async ({ days }) => text(await revenuePerFlow(db, days)));
    server.registerTool('audit_flows', { description: 'Find missing, silent and declining flows.', annotations: readOnly }, async () => text(await auditFlows(db)));
    return server;
}
