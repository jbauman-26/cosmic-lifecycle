import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, migrate } from './db.js';
import { recordCustomQuery, runQuery } from './query.js';
import { reconcile } from './reconcile.js';
import { auditFlows, revenuePerFlow } from './reports.js';
import { PUBLIC_TABLES } from './schema.js';
import { VERSION } from './version.js';
import { customTables } from './custom-sources.js';
import { defaultToolContext, runTool, toolCatalog, TOOLS } from './tools.js';
import { listFiles, readFile } from './files.js';
import { DOCS } from './docs.js';
import { listMetrics, metricCandidates, METRICS, runMetric } from './metrics.js';
import { CATALOG } from './sources-catalog.js';
const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
export async function schemaInfo(db) {
    const out = {};
    for (const t of [...PUBLIC_TABLES, ...(await customTables(db))]) {
        const rows = await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [t]);
        out[t] = rows.map((r) => `${r.column_name} ${r.data_type}`);
    }
    return out;
}
// Read-only by construction: there is no sync, connect or segment tool here.
export async function startMcp() {
    const db = await openDb();
    await migrate(db);
    const server = new McpServer({ name: 'cosmic-lifecycle', version: VERSION }, { instructions: DOCS.agents });
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    server.registerTool('list_metrics', { description: 'List verified metrics. Prefer these to writing SQL: the same metric always runs the same SQL.', annotations: readOnly }, async () => text(listMetrics()));
    server.registerTool('metric', {
        description: 'Run one verified metric over a window. Returns the value, its inputs, the exact SQL and the trust line.',
        inputSchema: { name: z.enum(METRICS.map((m) => m.name)), days: z.number().int().min(1).max(730).default(90) },
        annotations: readOnly,
    }, async ({ name, days }) => text(await runMetric(db, name, days)));
    server.registerTool('list_source_catalog', { description: 'Sources this CLI can connect, what each syncs, and the command to connect it.', annotations: readOnly }, async () => text(CATALOG));
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
        const r = await runQuery(db, sql);
        await recordCustomQuery(db, sql);
        return text(r);
    });
    server.registerTool('metric_candidates', { description: 'Custom queries run more than once. Each is a candidate to become a verified metric.', annotations: readOnly }, async () => text(await metricCandidates(db)));
    server.registerTool('reconcile', { description: 'Prove the numbers agree across sources. Run this before quoting a number.', annotations: { openWorldHint: false } }, async () => text(await reconcile(db)));
    server.registerTool('revenue_per_flow', { description: 'Rank flows by attributed revenue per recipient.', inputSchema: { days: z.number().int().min(1).max(365).default(90) }, annotations: readOnly }, async ({ days }) => text(await revenuePerFlow(db, days)));
    server.registerTool('audit_flows', { description: 'Find missing, silent and declining flows.', annotations: readOnly }, async () => text(await auditFlows(db)));
    await server.connect(new StdioServerTransport());
}
