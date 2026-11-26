import { syncShopify, syncStripe } from './sync.js';
import { lastLoaded, loadCharges, loadOrders, pipelineQuery, staleNote } from './pipeline.js';
const NAME = { fivetran: 'Fivetran', airbyte: 'Airbyte' };
// One pipeline source through the same sync code a native connection uses, so every check, metric and the
// MCP server work unchanged. The result's detail says where the rows came from and what is not covered.
export async function syncFromPipeline(db, source, p, open = pipelineQuery) {
    const conn = open(p.urlEnv);
    try {
        const via = `Read from ${NAME[p.tool]} tables in ${p.schema}.`;
        const notes = [via];
        let r;
        if (source === 'stripe') {
            r = await syncStripe(db, { charges: () => loadCharges(conn.query, p.tool, p.schema), subscriptions: async () => null }, { via });
            notes.push('Subscriptions are not read in pipeline mode yet, so MRR and churn are skipped.');
        }
        else {
            let refunds = true;
            r = await syncShopify(db, async () => {
                const o = await loadOrders(conn.query, p.tool, p.schema);
                refunds = o.refundsSubtracted;
                return o.orders;
            });
            if (!refunds)
                notes.push('This loader keeps the order total at the time of the order, so refunds are not subtracted from revenue.');
            notes.push("Shopify's own order count is not read in pipeline mode, so the orders_complete check is skipped. The other checks run.");
        }
        if (r.status === 'failed')
            return r;
        const stale = staleNote(await lastLoaded(conn.query, p.tool, source, p.schema).catch(() => null));
        if (stale)
            notes.push(stale);
        return { ...r, status: stale ? 'warning' : r.status === 'warning' && source === 'stripe' ? 'ok' : r.status, detail: notes.join(' ') };
    }
    finally {
        await conn.close().catch(() => undefined);
    }
}
