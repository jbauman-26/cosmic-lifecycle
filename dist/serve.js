import { createServer } from 'node:http';
import { buildDashboard, dashboardHtml } from './dashboard.js';
import { listMetrics, runMetric } from './metrics.js';
import { auditFlows, revenuePerFlow } from './reports.js';
import { trustLine } from './reconcile.js';
import { VERSION } from './version.js';
// A local, read-only web service: the dashboard at / and a JSON API under /api.
// It binds to 127.0.0.1 only, accepts GET only, and reruns nothing that writes.
// This is Cosmic's answer to Graphed's hosted services: the same live view, on your machine.
const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body, null, 2));
};
const days = (url) => {
    const d = Number(url.searchParams.get('days') ?? 90);
    return Number.isInteger(d) && d >= 1 && d <= 730 ? d : 90;
};
export const ROUTES = ['/', '/api/status', '/api/metrics', '/api/metrics/:name', '/api/reconcile', '/api/flows', '/api/audit'];
export function createHandler(db) {
    return async (req, res) => {
        if (req.method !== 'GET')
            return json(res, 405, { error: 'Read-only. Only GET is allowed.' });
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        try {
            if (url.pathname === '/') {
                const html = dashboardHtml(await buildDashboard(db, days(url)));
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                return res.end(html);
            }
            if (url.pathname === '/api/status')
                return json(res, 200, { version: VERSION, trust: await trustLine(db), routes: ROUTES });
            if (url.pathname === '/api/metrics')
                return json(res, 200, listMetrics());
            const m = url.pathname.match(/^\/api\/metrics\/([a-z0-9_]+)$/);
            if (m)
                return json(res, 200, await runMetric(db, m[1], days(url)));
            if (url.pathname === '/api/reconcile') {
                const checks = await db.query(`SELECT check_name, status, expected, actual, diff_pct, detail, checked_at FROM meta_reconcile_result ORDER BY check_name`);
                return json(res, 200, { trust: await trustLine(db), checks });
            }
            if (url.pathname === '/api/flows')
                return json(res, 200, await revenuePerFlow(db, days(url)));
            if (url.pathname === '/api/audit')
                return json(res, 200, await auditFlows(db));
            return json(res, 404, { error: 'Not found.', routes: ROUTES });
        }
        catch (e) {
            return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
    };
}
export function serve(db, port) {
    const server = createServer((req, res) => void createHandler(db)(req, res));
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            const addr = server.address();
            const actual = typeof addr === 'object' && addr ? addr.port : port;
            resolve({ url: `http://127.0.0.1:${actual}`, close: () => new Promise((r) => server.close(() => r())) });
        });
    });
}
