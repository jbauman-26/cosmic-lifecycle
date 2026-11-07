import type { Tx } from './db.js'
import { formatValue, runMetric } from './metrics.js'
import { auditFlows, esc, htmlPage, revenuePerFlow } from './reports.js'
import { trustLine } from './reconcile.js'

// One local page with what an owner checks on a Monday: the trust line, every reconcile
// check, the headline metrics, revenue per flow, the audit and recent syncs.
// It is a file on your machine, never a public URL.
export const DASHBOARD_METRICS = [
  'shopify_net_revenue', 'shopify_orders', 'average_order_value', 'returning_order_share',
  'flow_revenue_share', 'flow_revenue_per_recipient', 'flow_unsubscribe_rate', 'flow_spam_rate',
]

export async function buildDashboard(db: Tx, days = 90) {
  const trust = await trustLine(db)
  const checks = await db.query(`SELECT check_name, status, detail FROM meta_reconcile_result ORDER BY check_name`)
  const revenue = await revenuePerFlow(db, days)
  const audit = await auditFlows(db)
  const runs = await db.query(`SELECT source, status, rows_written, started_at, detail FROM meta_sync_run ORDER BY started_at DESC LIMIT 8`)
  const metrics = []
  for (const name of DASHBOARD_METRICS) metrics.push(await runMetric(db, name, days))
  return {
    days,
    trust,
    checks: checks.map((c) => ({ name: String(c.check_name), status: String(c.status), detail: String(c.detail) })),
    metrics: metrics.map((m) => ({ name: m.metric, title: m.title, unit: m.unit, value: m.value, status: m.status, detail: m.detail })),
    revenue,
    findings: audit.findings,
    runs: runs.map((r) => ({ source: String(r.source), status: String(r.status), rows: Number(r.rows_written), startedAt: new Date(String(r.started_at)).toISOString(), detail: r.detail ? String(r.detail) : null })),
  }
}

const STYLE = `<style>.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin:0 0 28px}
.card{border:1px solid var(--line);border-radius:8px;padding:12px}.k{font-size:13px;color:var(--muted)}
.v{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}.s.fail,.s.failed{color:var(--bad);font-weight:600}
.s.pass,.s.ok{color:var(--ok)}.m{color:var(--muted);font-size:13px}ul{padding-left:18px}li{margin:0 0 12px}</style>`

export function dashboardHtml(d: Awaited<ReturnType<typeof buildDashboard>>) {
  const cards = d.metrics
    .map((m) => `<div class="card"><div class="k">${esc(m.title)}</div><div class="v">${esc(m.status === 'ok' ? formatValue(m.unit, m.value) : 'no data')}</div></div>`)
    .join('')
  const checks = d.checks.map((c) => `<tr><td>${esc(c.name)}</td><td class="s ${esc(c.status)}">${esc(c.status)}</td><td>${esc(c.detail)}</td></tr>`).join('')
  const flows = d.revenue.flows
    .slice(0, 12)
    .map((f) => `<tr><td>${esc(f.name)}</td><td class="n">${f.recipients.toLocaleString('en-US')}</td><td class="n">$${f.revenue.toFixed(2)}</td><td class="n">$${f.revenuePerRecipient.toFixed(2)}${f.recipients < 100 ? ' <span class="m">(small sample)</span>' : ''}</td></tr>`)
    .join('')
  const findings = d.findings.map((f) => `<li><strong>[${esc(f.severity)}] ${esc(f.title)}</strong><br>${esc(f.evidence)}<br><span class="m">Next: ${esc(f.action)}</span></li>`).join('')
  const runs = d.runs.map((r) => `<tr><td>${esc(r.source)}</td><td class="s ${esc(r.status)}">${esc(r.status)}</td><td class="n">${r.rows.toLocaleString('en-US')}</td><td>${esc(r.startedAt.slice(0, 16).replace('T', ' '))} UTC</td></tr>`).join('')
  const body = [
    STYLE,
    `<p class="m">Last ${d.days} days.</p>`,
    `<div class="grid">${cards}</div>`,
    `<h2>Reconcile</h2><table><tr><th>Check</th><th>Result</th><th>Detail</th></tr>${checks || '<tr><td colspan="3">Not checked yet. Run lifecycle reconcile.</td></tr>'}</table>`,
    `<h2>Revenue per flow</h2><table><tr><th>Flow</th><th class="n">Recipients</th><th class="n">Attributed revenue</th><th class="n">Per recipient</th></tr>${flows || '<tr><td colspan="4">No flow sends in this window.</td></tr>'}</table>`,
    `<h2>What to fix</h2>${findings ? `<ul>${findings}</ul>` : '<p>No findings.</p>'}`,
    `<h2>Recent syncs</h2><table><tr><th>Source</th><th>Result</th><th class="n">Rows</th><th>Started</th></tr>${runs || '<tr><td colspan="4">Nothing synced yet.</td></tr>'}</table>`,
  ].join('')
  return htmlPage('Lifecycle dashboard', d.trust, body, d.revenue.notes)
}
