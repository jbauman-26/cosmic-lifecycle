#!/usr/bin/env node
import { Command } from 'commander'
import { emit, emitError, type Format } from './output.js'
import { init } from './commands/init.js'
import { connectGa4, connectKlaviyo, connectShopify } from './commands/connect.js'
import { doctor } from './commands/doctor.js'
import { openDb, migrate } from './db.js'
import { readConfig } from './config.js'
import { getSecret } from './secrets.js'
import { CliError } from './errors.js'
import { fetchOrderCount, fetchOrders, shopifyToken } from './sources/shopify.js'
import { fetchGa4Daily, ga4AccessToken } from './sources/ga4.js'
import { reconcile } from './reconcile.js'
import { Klaviyo } from './sources/klaviyo.js'
import { syncGa4, syncKlaviyo, syncShopify, type SourceResult } from './sync.js'
import { runQuery } from './query.js'
import { PUBLIC_TABLES } from './schema.js'
import { VERSION } from './version.js'
import { DOCS } from './docs.js'
import { addKit, listKits } from './kits.js'
import { startMcp } from './mcp.js'
import { runDemo } from './demo.js'
import { deploy, deployPlan } from './deploy.js'
import { auditFlows, auditHtml, revenueHtml, revenuePerFlow, writeHtml } from './reports.js'
import { applyPlan, buildPlan, readPlan, suggestLapsedDays, writePlan } from './segments.js'

const program = new Command('lifecycle')
  .description('A clean view of Shopify and Klaviyo for Claude Code. Read-only. Nothing sends.')
  .version(VERSION)
  .option('--format <format>', 'text or json', 'text')

const format = () => (program.opts().format === 'json' ? 'json' : 'text') as Format
const run = (fn: (...a: any[]) => Promise<void>) => async (...a: any[]) => {
  try {
    await fn(...a)
  } catch (e) {
    emitError(format(), e)
  }
}

program.command('init').description('Set up the database').option('--database-url-env <name>', 'use your own Postgres instead of the local database').action(run(async (opts) => {
  const r = await init(opts)
  emit(format(), r, () => `Ready. Database: ${r.database}\nNext: lifecycle connect klaviyo --key-env NAME`)
}))

const connect = program.command('connect').description('Connect a data source')
connect.command('klaviyo').option('--key-env <name>', 'environment variable holding a read-only private key').action(run(async (opts) => {
  const r = await connectKlaviyo(opts)
  emit(format(), r, () => `Connected to Klaviyo: ${r.account}`)
}))
connect.command('shopify').option('--store <domain>').option('--client-id <id>').option('--secret-env <name>', 'environment variable holding the client secret').action(run(async (opts) => {
  const r = await connectShopify(opts)
  emit(format(), r, () => `Connected to ${r.store}`)
}))

connect.command('ga4').option('--property <id>').option('--client-id <id>').option('--secret-env <name>').option('--refresh-token-env <name>').action(run(async (opts) => {
  const r = await connectGa4(opts)
  emit(format(), r, () => `Connected to GA4 property ${r.property}`)
}))

program.command('sync').description('Pull fresh totals from connected sources').option('--since <date>', 'start of the Klaviyo report window').action(run(async (opts) => {
  const config = readConfig()
  const db = await openDb()
  try {
    await migrate(db)
    const results: SourceResult[] = []
    const shopifySecret = getSecret('shopify-client-secret')
    if (config.shopify && shopifySecret) {
      const { store, clientId } = config.shopify
      const token = await shopifyToken(store, clientId, shopifySecret)
      results.push(await syncShopify(db, () => fetchOrders(store, token), () => fetchOrderCount(store, token)))
    }
    const key = getSecret('klaviyo-read-key')
    if (key) results.push(await syncKlaviyo(db, new Klaviyo(key), opts))
    const ga4Secret = getSecret('ga4-client-secret')
    const ga4Refresh = getSecret('ga4-refresh-token')
    if (config.ga4 && ga4Secret && ga4Refresh) {
      const { property, clientId } = config.ga4
      const start = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
      const end = new Date().toISOString().slice(0, 10)
      results.push(await syncGa4(db, async () => fetchGa4Daily(property, await ga4AccessToken(clientId, ga4Secret, ga4Refresh), start, end)))
    }
    if (!results.length) throw new CliError('No sources connected.', 'lifecycle connect klaviyo --key-env NAME')
    emit(format(), { results }, () => results.map((r) => `${r.source}: ${r.status}, ${r.rows} rows${r.detail ? `. ${r.detail}` : ''}`).join('\n'))
    const check = await reconcile(db)
    const failed = check.checks.filter((c) => c.status === 'fail')
    emit(format(), { reconcile: check }, () => (failed.length ? `Reconcile: ${failed.length} failed. Run lifecycle reconcile for details.` : 'Reconcile: passed.'))
    if (results.some((r) => r.status === 'failed')) process.exitCode = 1
  } finally {
    await db.close()
  }
}))

program.command('reconcile').description('Prove the numbers agree across sources').action(run(async () => {
  const db = await openDb()
  try {
    await migrate(db)
    const r = await reconcile(db)
    const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skipped: 'SKIP' }
    emit(format(), r, () => r.checks.map((c) => `${mark[c.status]} ${c.name}: ${c.detail}`).join('\n'))
    if (!r.passed) process.exitCode = 1
  } finally {
    await db.close()
  }
}))

program.command('schema').argument('[table]').description('List tables and columns').action(run(async (table?: string) => {
  const db = await openDb()
  try {
    const names = table ? [table] : [...PUBLIC_TABLES]
    if (table && !(PUBLIC_TABLES as readonly string[]).includes(table)) throw new CliError(`Unknown table ${table}.`, 'lifecycle schema')
    const out: Record<string, { column: string; type: string }[]> = {}
    for (const n of names) {
      const rows = await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [n])
      out[n] = rows.map((r) => ({ column: String(r.column_name), type: String(r.data_type) }))
    }
    emit(format(), out, () => Object.entries(out).map(([t, cols]) => `${t}\n${cols.map((c) => `  ${c.column} ${c.type}`).join('\n')}`).join('\n\n'))
  } finally {
    await db.close()
  }
}))

program.command('query').argument('<sql>').description('Run one read-only SQL query').action(run(async (sql: string) => {
  const db = await openDb()
  try {
    const r = await runQuery(db, sql)
    emit(format(), r, () => `${JSON.stringify(r.rows, null, 2)}\n${r.rowCount} rows${r.truncated ? ' (capped)' : ''}`)
  } finally {
    await db.close()
  }
}))

const report = program.command('report').description('Reports, each with a trust line')
report.command('revenue-per-flow').option('--days <n>', 'window in days', '90').option('--html <file>', 'also write an HTML report').action(run(async (opts) => {
  const db = await openDb()
  try {
    await migrate(db)
    const r = await revenuePerFlow(db, Number(opts.days))
    if (opts.html) writeHtml(opts.html, revenueHtml(r))
    emit(format(), r, () => [r.trust.line, ...r.flows.map((f) => `${f.name}: ${f.recipients} recipients, $${f.revenue}, $${f.revenuePerRecipient} per recipient`), r.flows.length ? '' : 'No flow data yet.', ...r.notes].join('\n'))
  } finally {
    await db.close()
  }
}))

program.command('audit').description('Find what to fix').command('flows').option('--html <file>', 'also write an HTML report').action(run(async (opts) => {
  const db = await openDb()
  try {
    await migrate(db)
    const a = await auditFlows(db)
    if (opts.html) writeHtml(opts.html, auditHtml(a))
    emit(format(), a, () => [a.trust.line, `${a.flowsReviewed} flows reviewed, ${a.liveFlows} live.`, ...a.findings.map((f) => `[${f.severity}] ${f.title}\n  ${f.evidence}\n  Next: ${f.action}`), ...a.notes].join('\n'))
  } finally {
    await db.close()
  }
}))

const segments = program.command('segments').description('Propose and create Klaviyo segments. Never sends.')
segments.command('propose').argument('<kind>', 'winback').option('--out <file>', 'plan file', 'winback-plan.json').option('--days <n>', 'override lapsed days').action(run(async (kind: string, opts) => {
  if (kind !== 'winback') throw new CliError(`No segment type ${kind}.`, 'lifecycle segments propose winback')
  const key = getSecret('klaviyo-read-key')
  if (!key) throw new CliError('Klaviyo is not connected.', 'lifecycle connect klaviyo --key-env NAME')
  const metricId = await new Klaviyo(key).placedOrderMetricId()
  if (!metricId) throw new CliError('Klaviyo has no Placed Order metric.', 'Connect Shopify to Klaviyo first.')
  const db = await openDb()
  try {
    await migrate(db)
    const s = opts.days ? { days: Number(opts.days), basis: `Set by hand to ${opts.days} days.` } : await suggestLapsedDays(db)
    const plan = buildPlan({ lapsedAfterDays: s.days, basis: s.basis, metricId })
    writePlan(opts.out, plan)
    emit(format(), { plan, file: opts.out }, () => `Plan written to ${opts.out}. Nothing was created.\nSegment: ${plan.name}\nWhy: ${plan.reason}\nReview it, then run: lifecycle segments apply ${opts.out} --confirm`)
  } finally {
    await db.close()
  }
}))
segments.command('apply').argument('<plan>').option('--confirm', 'create the segment').option('--key-env <name>', 'variable holding a Klaviyo key with segments write access').action(run(async (file: string, opts) => {
  const plan = readPlan(file)
  const key = (opts.keyEnv ? process.env[opts.keyEnv] : undefined) ?? getSecret('klaviyo-write-key')
  if (opts.confirm && !key) throw new CliError('A separate Klaviyo key with Segments write access is needed.', 'lifecycle segments apply PLAN --confirm --key-env NAME', 'missing_secret')
  const r = await applyPlan(plan, key ?? '', opts)
  emit(format(), r, () => `Created segment ${r.name} (${r.segmentId}). Nothing was sent.`)
}))

const kits = program.command('kits').description('Runbooks your agent can follow')
kits.command('list').action(run(async () => {
  const k = listKits()
  emit(format(), k, () => k.map((x) => `${x.name}: ${x.summary}`).join('\n'))
}))
kits.command('add').argument('<name>').option('--into <dir>', 'folder to copy into', 'lifecycle-kits').action(run(async (name: string, opts) => {
  const r = addKit(name, opts.into)
  emit(format(), r, () => `Added ${r.kit} to ${r.path}. Ask your agent to follow ${r.runbook}`)
}))

program.command('mcp').description('Start the read-only MCP server').action(run(startMcp))

program.command('deploy').description('Run the daily sync from your own GitHub account').requiredOption('--repo <owner/name>').option('--yes', 'create it. Without this, only prints the plan').action(run(async (opts) => {
  const config = readConfig()
  const plan = deployPlan(config, opts.repo)
  if (!opts.yes) {
    emit(format(), plan, () => [`This would create:`, ...plan.creates.map((c) => `  ${c}`), `Secrets to set: ${plan.secrets.join(', ')}`, `Cost: ${plan.expectedCost}`, `Nothing was created. Add --yes to go ahead.`].join('\n'))
    return
  }
  const names = { LIFECYCLE_DATABASE_URL: 'database-url', LIFECYCLE_KLAVIYO_READ_KEY: 'klaviyo-read-key', LIFECYCLE_SHOPIFY_CLIENT_SECRET: 'shopify-client-secret', LIFECYCLE_GA4_CLIENT_SECRET: 'ga4-client-secret', LIFECYCLE_GA4_REFRESH_TOKEN: 'ga4-refresh-token' } as const
  const secrets: Record<string, string> = {}
  for (const s of plan.secrets) {
    const v = getSecret(names[s as keyof typeof names])
    if (!v) throw new CliError(`Missing ${s}.`, s === 'LIFECYCLE_DATABASE_URL' ? 'Create a Postgres database, then lifecycle init --database-url-env NAME' : 'lifecycle doctor', 'missing_secret')
    secrets[s] = v
  }
  const r = deploy(config, opts.repo, secrets)
  emit(format(), r, () => `Deployed to ${r.url}\nRun it once now: ${r.firstRun}`)
}))

program.command('demo').description('See it work on invented sample data. No keys needed').option('--html <file>', 'also write the sample report').action(run(async (opts) => {
  const d = await runDemo({ html: opts.html, write: writeHtml })
  emit(format(), d, () => {
    const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skipped: 'SKIP' }
    const lost = d.broken.checks.find((c) => c.name === 'orders_complete')
    return [
      'SAMPLE DATA. Every number below is invented.', '',
      '1. A sync loses 14 orders without any error. Reconcile catches it:',
      `   ${mark[lost!.status]} ${lost!.detail}`, '',
      '2. After a clean sync, the checks pass:',
      ...d.fixed.checks.filter((c) => c.status !== 'skipped').map((c) => `   ${mark[c.status]} ${c.name}`), '',
      `3. Revenue per flow. ${d.revenue.trust.line}`,
      ...d.revenue.flows.map((f) => `   ${f.name}: $${f.revenuePerRecipient.toFixed(2)} per recipient`), '',
      `4. Flow audit found ${d.audit.findings.length} things to fix. The top three:`,
      ...d.audit.findings.slice(0, 3).map((f) => `   [${f.severity}] ${f.title}`), '',
      'Next: lifecycle docs setup',
    ].join('\n')
  })
}))

program.command('doctor').description('Check keys, connections and sync age').action(run(async () => {
  const r = await doctor()
  emit(format(), r, () => r.checks.map((c) => `${c.ok ? 'OK ' : 'NO '} ${c.name}: ${c.detail}${c.next ? `\n    Next: ${c.next}` : ''}`).join('\n'))
  if (!r.healthy) process.exitCode = 1
}))

program.command('docs').argument('[topic]', 'agents, commands or troubleshooting', 'agents').description('Read the built-in docs').action(run(async (topic: string) => {
  const doc = DOCS[topic]
  if (!doc) throw new CliError(`No doc named ${topic}.`, 'lifecycle docs commands')
  emit(format(), { topic, doc }, () => doc)
}))

await program.parseAsync()
