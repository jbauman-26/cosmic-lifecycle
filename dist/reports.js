import { writeFileSync } from 'node:fs';
import { trustLine } from './reconcile.js';
import { reportsVerified } from './sources/klaviyo.js';
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const ATTRIBUTION_NOTE = 'Revenue here is what Klaviyo attributes to each flow. It shows correlation, not proof that the email caused the sale.';
const UNTESTED_NOTE = 'Flow report parsing has not yet been verified on real sends.';
// NorthSignal's working line for a brand under-using owned channels.
export const OWNED_SHARE_LINE = 15;
export async function revenuePerFlow(db, days = 90) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const rows = await db.query(`SELECT f.flow_id, coalesce(d.name, f.flow_id) AS name, coalesce(d.status, 'unknown') AS status, sum(f.recipients) AS recipients, sum(f.revenue) AS revenue, sum(f.conversions) AS conversions
     FROM fact_flow_daily f LEFT JOIN dim_flow d USING (flow_id) WHERE f.date >= $1 GROUP BY 1, 2, 3`, [since]);
    const flows = rows
        .map((r) => ({
        flowId: String(r.flow_id), name: String(r.name), status: String(r.status), recipients: num(r.recipients), revenue: num(r.revenue), conversions: num(r.conversions),
        revenuePerRecipient: num(r.recipients) ? round(num(r.revenue) / num(r.recipients), 4) : 0,
    }))
        .sort((a, b) => b.revenuePerRecipient - a.revenuePerRecipient || b.revenue - a.revenue);
    const shop = (await db.query(`SELECT sum(net_revenue) AS net FROM fact_orders_daily WHERE date >= $1`, [since]))[0];
    const shopifyNet = num(shop?.net);
    const flowRevenue = round(flows.reduce((s, f) => s + f.revenue, 0));
    return {
        days, flows, flowRevenue, shopifyNet,
        ownedSharePct: shopifyNet ? round((flowRevenue / shopifyNet) * 100) : null,
        belowOwnedLine: shopifyNet ? (flowRevenue / shopifyNet) * 100 < OWNED_SHARE_LINE : null,
        trust: await trustLine(db),
        notes: [ATTRIBUTION_NOTE, ...(reportsVerified ? [] : [UNTESTED_NOTE])],
    };
}
// Klaviyo names flows freely, so we match on words people actually use and say
// so in the finding rather than claiming certainty.
const CORE_FLOWS = [
    { key: 'welcome', label: 'Welcome series', match: /welcome|new subscriber|nurture/i },
    { key: 'abandoned_checkout', label: 'Abandoned checkout', match: /abandon.*(checkout|cart)|(checkout|cart).*abandon|checkout started/i },
    { key: 'browse', label: 'Browse abandonment', match: /browse/i },
    { key: 'post_purchase', label: 'Post-purchase', match: /post.?purchase|thank you|after purchase|order follow/i },
    { key: 'winback', label: 'Win-back', match: /win.?back|re.?engag|lapsed|come back/i },
];
export async function auditFlows(db) {
    const findings = [];
    const flows = await db.query(`SELECT flow_id, name, status, archived FROM dim_flow WHERE archived IS NOT TRUE`);
    const live = flows.filter((f) => String(f.status).toLowerCase() === 'live');
    for (const core of CORE_FLOWS) {
        const named = flows.filter((f) => core.match.test(String(f.name)));
        const isLive = named.some((f) => String(f.status).toLowerCase() === 'live');
        if (!named.length)
            findings.push({ severity: 'high', title: `No ${core.label} flow found`, evidence: 'No flow name matched. It may exist under another name.', action: `Check for this flow under another name, and build it if it is missing.` });
        else if (!isLive)
            findings.push({ severity: 'high', title: `${core.label} flow is not live`, evidence: `${named.map((f) => `${f.name} (${f.status})`).join(', ')}`, action: 'Review it and set it live, or remove it.' });
    }
    const recent = await db.query(`SELECT d.flow_id, d.name,
       sum(CASE WHEN f.date >= CURRENT_DATE - 30 THEN f.recipients ELSE 0 END) AS r30, sum(CASE WHEN f.date >= CURRENT_DATE - 30 THEN f.revenue ELSE 0 END) AS v30,
       sum(CASE WHEN f.date < CURRENT_DATE - 30 AND f.date >= CURRENT_DATE - 60 THEN f.recipients ELSE 0 END) AS r60,
       sum(CASE WHEN f.date < CURRENT_DATE - 30 AND f.date >= CURRENT_DATE - 60 THEN f.revenue ELSE 0 END) AS v60,
       sum(CASE WHEN f.date >= CURRENT_DATE - 30 THEN f.spam_complaints ELSE 0 END) AS spam30,
       sum(CASE WHEN f.date >= CURRENT_DATE - 30 THEN f.unsubscribes ELSE 0 END) AS unsub30
     FROM dim_flow d LEFT JOIN fact_flow_daily f USING (flow_id) WHERE lower(d.status) = 'live' AND d.archived IS NOT TRUE GROUP BY 1, 2`);
    for (const r of recent) {
        const name = String(r.name);
        const r30 = num(r.r30), r60 = num(r.r60);
        if (r30 === 0) {
            findings.push({ severity: 'medium', title: `${name} sent nothing in 30 days`, evidence: 'Live, with 0 recipients in the last 30 days.', action: 'Check the trigger and filters.' });
            continue;
        }
        const perNow = num(r.v30) / r30;
        const perBefore = r60 ? num(r.v60) / r60 : 0;
        if (r60 >= 50 && perBefore > 0 && perNow < perBefore * 0.7) {
            findings.push({ severity: 'medium', title: `${name} revenue per recipient fell`, evidence: `${money(perBefore)} to ${money(perNow)} per recipient, comparing the prior 30 days with the last 30.`, action: 'Review recent edits, offers and audience changes.' });
        }
        if (r30 >= 200 && (num(r.spam30) / r30) * 100 > 0.1) {
            findings.push({ severity: 'high', title: `${name} spam rate is high`, evidence: `${round((num(r.spam30) / r30) * 100)}% of recipients marked it as spam.`, action: 'Check who enters this flow and how often they hear from you.' });
        }
        if (r30 >= 200 && (num(r.unsub30) / r30) * 100 > 1) {
            findings.push({ severity: 'low', title: `${name} unsubscribe rate is high`, evidence: `${round((num(r.unsub30) / r30) * 100)}% unsubscribed.`, action: 'Review timing and message count.' });
        }
    }
    const order = { high: 0, medium: 1, low: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    return {
        flowsReviewed: flows.length, liveFlows: live.length, findings, trust: await trustLine(db),
        notes: [ATTRIBUTION_NOTE, 'Missing-flow checks match on flow names, so review each one before acting.', ...(reportsVerified ? [] : [UNTESTED_NOTE])],
    };
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function htmlPage(title, trust, body, notes) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>:root{--ink:#17181a;--muted:#5d6168;--line:#e4e4e0;--bg:#fbfbf9;--bad:#a2281d;--ok:#1f6b45}
@media (prefers-color-scheme:dark){:root{--ink:#ecece8;--muted:#a3a6ac;--line:#33353a;--bg:#16171a;--bad:#ef8b7f;--ok:#7fcfa3}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,sans-serif}main{max-width:820px;margin:0 auto;padding:48px 20px}
h1{font-size:30px;line-height:1.15;margin:0 0 16px}p{margin:0 0 12px}.trust{padding:12px 0;border-block:1px solid var(--line);margin:0 0 28px;font-weight:600}
.trust.failed,.trust.unchecked{color:var(--bad)}.trust.passed{color:var(--ok)}table{width:100%;border-collapse:collapse;margin:0 0 24px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:10px 12px 10px 0;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:13px;color:var(--muted);font-weight:600}
td.n,th.n{text-align:right}.notes{color:var(--muted);font-size:14px}h2{font-size:18px;margin:28px 0 6px}</style></head>
<body><main><h1>${esc(title)}</h1><p class="trust ${esc(trust.status)}">${esc(trust.line)}</p>${body}<div class="notes">${notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div></main></body></html>`;
}
export function revenueHtml(r) {
    const rows = r.flows.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.status)}</td><td class="n">${f.recipients.toLocaleString('en-US')}</td><td class="n">${money(f.revenue)}</td><td class="n">${money(f.revenuePerRecipient)}</td></tr>`).join('');
    const share = r.ownedSharePct === null ? '' : `<p>Flows drove ${r.ownedSharePct}% of ${money(r.shopifyNet)} Shopify net revenue over ${r.days} days.</p>`;
    return htmlPage('Revenue per flow', r.trust, `${share}<table><tr><th>Flow</th><th>Status</th><th class="n">Recipients</th><th class="n">Revenue</th><th class="n">Per recipient</th></tr>${rows || '<tr><td colspan="5">No flow data yet.</td></tr>'}</table>`, r.notes);
}
export function auditHtml(a) {
    const items = a.findings.map((f) => `<h2>${esc(f.title)}</h2><p>${esc(f.evidence)}</p><p><strong>Next:</strong> ${esc(f.action)}</p>`).join('');
    return htmlPage('Flow audit', a.trust, `<p>${a.flowsReviewed} flows reviewed, ${a.liveFlows} live, ${a.findings.length} findings.</p>${items}`, a.notes);
}
export const writeHtml = (path, html) => writeFileSync(path, html, 'utf8');
