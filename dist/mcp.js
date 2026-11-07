import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, migrate } from './db.js';
import { runQuery } from './query.js';
import { reconcile } from './reconcile.js';
import { auditFlows, revenuePerFlow } from './reports.js';
import { PUBLIC_TABLES } from './schema.js';
import { VERSION } from './version.js';
import { DOCS } from './docs.js';
const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
export async function schemaInfo(db) {
    const out = {};
    for (const t of PUBLIC_TABLES) {
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
    server.registerTool('explore_schema', { description: 'List tables and columns. Call this before writing SQL.', annotations: readOnly }, async () => text(await schemaInfo(db)));
    server.registerTool('query', { description: 'Run one read-only SELECT. Capped at 1,000 rows.', inputSchema: { sql: z.string() }, annotations: readOnly }, async ({ sql }) => text(await runQuery(db, sql)));
    server.registerTool('reconcile', { description: 'Prove the numbers agree across sources. Run this before quoting a number.', annotations: { openWorldHint: false } }, async () => text(await reconcile(db)));
    server.registerTool('revenue_per_flow', { description: 'Rank flows by attributed revenue per recipient.', inputSchema: { days: z.number().int().min(1).max(365).default(90) }, annotations: readOnly }, async ({ days }) => text(await revenuePerFlow(db, days)));
    server.registerTool('audit_flows', { description: 'Find missing, silent and declining flows.', annotations: readOnly }, async () => text(await auditFlows(db)));
    await server.connect(new StdioServerTransport());
}
