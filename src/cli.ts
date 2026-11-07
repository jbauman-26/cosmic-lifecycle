#!/usr/bin/env node
import { Command } from 'commander'
import { emit, emitError, type Format } from './output.js'
import { init } from './commands/init.js'
import { connectGa4, connectKlaviyo, connectShopify, connectStripe } from './commands/connect.js'
import { doctor } from './commands/doctor.js'
import { openDb, migrate } from './db.js'
import { readConfig } from './config.js'
import { getSecret, getSourceSecret } from './secrets.js'
import { CliError } from './errors.js'
import { fetchOrderCount, fetchOrders, shopifyToken } from './sources/shopify.js'
import { fetchGa4Daily, ga4AccessToken } from './sources/ga4.js'
import { reconcile } from './reconcile.js'
import { Klaviyo } from './sources/klaviyo.js'
import { Stripe } from './sources/stripe.js'
import { syncGa4, syncKlaviyo, syncShopify, syncStripe, type SourceResult } from './sync.js'
import { runQuery } from './query.js'
import { PUBLIC_TABLES } from './schema.js'
import { VERSION } from './version.js'
import { DOCS } from './docs.js'
import { addKit, ensureRegistry, listKits, searchKits, showKit, validateRegistry, type Registry } from './registry.js'
import { skillsStatus, syncSkills, uninstallSkills, type Target } from './skills.js'
import { feedbackUrl, openUrl } from './feedback.js'
import { findMetric, formatValue, listMetrics, runMetric } from './metrics.js'
import { CATALOG, CUSTOM_SOURCE_NOTE, kitPrompt, sourceStatus } from './sources-catalog.js'
import type { Config } from './config.js'
import { startMcp } from './mcp.js'
import { runDemo } from './demo.js'
import { deploy, deployLogs, deployPlan, deployRun, deployStatus, warehouseSecrets, writeProject } from './deploy.js'
import { getSetting, listSettings, setSetting, unsetSetting } from './config.js'
import { deleteSecret, secretStatus, setSecret, SECRET_NAMES, type SecretName } from './secrets.js'
import { buildDashboard, dashboardHtml } from './dashboard.js'
import { checkForUpdate, UPDATE_COMMAND } from './update.js'
import { trustLine } from './reconcile.js'
import { metricCandidates } from './metrics.js'
import { recordCustomQuery } from './query.js'
import { basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { saveArtifact, filesDir, listFiles, readFile, getFile, putFile, pullCloud } from './files.js'
import { customTables, importCsv } from './custom-sources.js'
import { defaultToolContext, getRun, listRuns, runTool, toolCatalog } from './tools.js'
import { serve, ROUTES } from './serve.js'
import { neonPlan, provisionNeon } from './provision.js'
import { envName, SECRET_NAMES as ALL_SECRETS } from './secrets.js'
import { auditFlows, auditHtml, revenueHtml, revenuePerFlow, writeHtml } from './reports.js'
import { applyPlan, buildPlan, readPlan, suggestLapsedDays, writePlan } from './segments.js'
import { addCustomSource, connectSource, connectedSources, datasetFor, disconnectSource, duckQuery, duckSchema, findSource, searchCatalog, syncSources, type WarehouseSyncResult } from './warehouse.js'
import { READINESS_LEGEND } from './warehouse-catalog.js'
import { randomUUID } from 'node:crypto'

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
connect.command('stripe').description('Read-only: charges, refunds, subscriptions. Totals only.').option('--key-env <name>', 'environment variable holding a restricted key').action(run(async (opts) => {
  const r = await connectStripe(opts)
  emit(format(), r, () => [`Connected to Stripe (${r.mode} mode)${r.subscriptions ? '' : '. This key cannot read subscriptions, so MRR is off.'}`, r.note].filter(Boolean).join('\n'))
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
    const stripeKey = getSecret('stripe-read-key')
    if (config.stripe && stripeKey) {
      const stripe = new Stripe(stripeKey)
      results.push(await syncStripe(db, { charges: () => stripe.charges(), subscriptions: () => stripe.subscriptions() }))
    }
    if (!results.length) throw new CliError('No sources connected.', 'lifecycle connect klaviyo --key-env NAME')
    const check = await reconcile(db)
    const failed = check.checks.filter((c) => c.status === 'fail')
    // One JSON document per command, so an agent can parse stdout whole.
    emit(format(), { results, reconcile: check }, () => [
      ...results.map((r) => `${r.source}: ${r.status}, ${r.rows} rows${r.detail ? `. ${r.detail}` : ''}`),
      failed.length ? `Reconcile: ${failed.length} failed. Run lifecycle reconcile for details.` : 'Reconcile: passed.',
    ].join('\n'))
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
    const known = [...PUBLIC_TABLES, ...(await customTables(db))]
    const names = table ? [table] : known
    if (table && !known.includes(table)) throw new CliError(`Unknown table ${table}.`, 'lifecycle schema')
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
    await recordCustomQuery(db, sql)
    emit(format(), r, () => `${JSON.stringify(r.rows, null, 2)}\n${r.rowCount} rows${r.truncated ? ' (capped)' : ''}`)
  } finally {
    await db.close()
  }
}))

// Verified metrics: fixed SQL, so the same question gets the same answer every time.
const metrics = program.command('metrics').description('Verified metrics: the same SQL every time, with a trust line')
metrics.command('list').description('List every verified metric').action(run(async () => {
  const m = listMetrics()
  emit(format(), m, () => m.map((x) => `${x.name}: ${x.description} (needs ${x.needs.join(', ')})`).join('\n'))
}))
metrics.command('show').argument('<name>').description('Show what a metric measures and its exact SQL').action(run(async (name: string) => {
  const m = findMetric(name)
  emit(format(), m, () => [`${m.title} (${m.name})`, m.description, `Needs: ${m.needs.join(', ')}. Unit: ${m.unit}.`, ...(m.notes ?? []), '', 'SQL ($1 is the first day of the window):', m.sql].join('\n'))
}))
metrics.command('run').argument('<names...>').option('--days <n>', 'window in days', '90').description('Run one or more metrics').action(run(async (names: string[], opts) => {
  const db = await openDb()
  try {
    const days = Number(opts.days)
    const results: Awaited<ReturnType<typeof runMetric>>[] = []
    for (const n of names) results.push(await runMetric(db, n, days))
    const out = names.length === 1 ? results[0]! : { metrics: results, trust: results[0]!.trust }
    emit(format(), out, () => [
      results[0]!.trust.line,
      ...results.map((r) => `${r.title}, last ${r.days} days: ${formatValue(r.unit, r.value)}${r.detail ? `. ${r.detail}` : ''}`),
      ...[...new Set(results.flatMap((r) => r.notes))],
    ].join('\n'))
  } finally {
    await db.close()
  }
}))

metrics.command('candidates').description('Custom queries run more than once: candidates for a new verified metric').option('--min-runs <n>', 'only queries run at least this often', '2').action(run(async (opts) => {
  const db = await openDb()
  try {
    await migrate(db)
    const c = await metricCandidates(db, Number(opts.minRuns))
    emit(format(), c, () => (c.length ? [...c.map((x) => `${x.runs} runs  ${x.sql}`), '', 'To ask for one as a verified metric: lifecycle feedback "metric request: ..."'].join('\n') : 'No repeated custom queries yet.'))
  } finally {
    await db.close()
  }
}))

const SECRET_FOR: Record<string, Parameters<typeof getSecret>[0]> ={ klaviyo: 'klaviyo-read-key', shopify: 'shopify-client-secret', ga4: 'ga4-client-secret', stripe: 'stripe-read-key' }
const sources = program.command('sources').description('What can be connected, and what is connected')
sources
  .command('catalog')
  .description('Every source: the built-in four, warehouse connectors, and what is planned')
  .option('--query <text>', 'search by name, slug or category')
  .option('--category <name>', 'only one category, such as reviews or helpdesk')
  .option('--readiness <level>', 'native, tested, built or planned')
  .action(run(async (opts) => {
    const warehouse = searchCatalog(opts).filter((s) => s.readiness !== 'native')
    const native = opts.query || opts.category || (opts.readiness && opts.readiness !== 'native') ? [] : CATALOG
    const out = { native, warehouse: warehouse.map(({ config, ...s }) => ({ ...s, hasConnector: Boolean(config) })), legend: READINESS_LEGEND }
    emit(format(), out, () => {
      const nativeText = native.map((s) => [`${s.name} (${s.slug}), built in, about ${s.setupMinutes} minutes`, `  Syncs: ${s.syncs}`, `  Connect: ${s.connect}`, `  Tested: ${s.tested}`].join('\n'))
      const byCategory = new Map<string, typeof warehouse>()
      for (const s of warehouse) byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s])
      const whText = [...byCategory.entries()].map(([cat, list]) => `${cat}\n${list.map((s) => `  ${s.readiness.padEnd(7)} ${s.name} (${s.slug})`).join('\n')}`)
      return [
        ...(nativeText.length ? ['Built in', ...nativeText, ''] : []),
        `Warehouse connectors (${warehouse.length})`,
        ...whText,
        '',
        READINESS_LEGEND,
        `Details for one: lifecycle warehouse show SLUG. ${CUSTOM_SOURCE_NOTE}`,
      ].join('\n')
    })
  }))
sources.command('list').description('Which sources are connected, and when each last synced').action(run(async () => {
  let config: Config | null = null
  try {
    config = readConfig()
  } catch {
    config = null
  }
  const db = config ? await openDb().catch(() => null) : null
  try {
    const r = await sourceStatus(config, (slug) => Boolean(getSecret(SECRET_FOR[slug]!)), db)
    emit(format(), r, () => r.map((s) => `${s.connected ? 'connected    ' : 'not connected'} ${s.name}${s.lastSync ? `, last sync ${s.lastSync} (${s.lastStatus})` : ''}${s.next ? `\n    Next: ${s.next}` : ''}`).join('\n'))
  } finally {
    await db?.close()
  }
}))

const report = program.command('report').description('Reports, each with a trust line')
report.command('revenue-per-flow').option('--days <n>', 'window in days', '90').option('--html <file>', 'also write an HTML report').action(run(async (opts) => {
  const db = await openDb()
  try {
    await migrate(db)
    const r = await revenuePerFlow(db, Number(opts.days))
    if (opts.html) { const html = revenueHtml(r); writeHtml(opts.html, html); saveArtifact(basename(opts.html), html) }
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
    if (opts.html) { const html = auditHtml(a); writeHtml(opts.html, html); saveArtifact(basename(opts.html), html) }
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
    saveArtifact(basename(opts.out), JSON.stringify(plan, null, 2))
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

// Registry warnings go to stderr so JSON on stdout stays clean for agents.
const registry = (opts: { registry?: string; refresh?: boolean }): Registry => {
  const reg = ensureRegistry({ uri: opts.registry, refresh: opts.refresh })
  if (reg.warning) console.error(`Warning: ${reg.warning}`)
  return reg
}
const withRegistry = (c: Command) => c.option('--registry <path-or-url>', 'kit registry: a local folder or a git URL').option('--refresh', 'fetch the latest kits now')

const kits = program.command('kits').description('Runbooks your agent can follow, from the kit registry')
withRegistry(kits.command('list').description('List kits in the registry')).action(run(async (opts) => {
  const reg = registry(opts)
  const k = listKits(reg)
  emit(format(), { source: reg.source, kits: k }, () => k.map((x) => `${x.name} ${x.version}: ${x.summary}`).join('\n'))
}))
withRegistry(kits.command('search').argument('<query>').description('Find kits by name, keyword or summary')).action(run(async (query: string, opts) => {
  const k = searchKits(registry(opts), query)
  emit(format(), k, () => (k.length ? k.map((x) => `${x.name} ${x.version}: ${x.summary}`).join('\n') : `No kits match "${query}". Try lifecycle kits list`))
}))
withRegistry(kits.command('show').argument('<name>').description("Show a kit's README, needs and secrets before adding it")).action(run(async (name: string, opts) => {
  const r = showKit(registry(opts), name)
  const m = r.manifest
  const prompt = kitPrompt(m)
  emit(format(), { ...r, prompt }, () => [r.readme.trim(), '', `Version: ${m.version}`, `Needs: ${m.needs.join(', ')}`, `Writes: ${m.writes}`, `Secrets: ${m.secrets.map((s) => `${s.name}${s.required ? '' : ' (optional)'}`).join(', ') || 'none'}`, '', `Add it: lifecycle kits add ${m.name}`, '', 'Or paste this into your agent:', prompt].join('\n'))
}))
withRegistry(kits.command('prompt').argument('<name>').description('Print a setup prompt to paste into Claude Code, Cursor or Codex')).action(run(async (name: string, opts) => {
  const prompt = kitPrompt(showKit(registry(opts), name).manifest)
  emit(format(), { kit: name, prompt }, () => prompt)
}))
withRegistry(kits.command('add').argument('<name>').description('Stage a kit for your agent to follow'))
  .option('--into <dir>', 'folder to copy into', 'lifecycle-kits')
  .option('--force', 'stage it even if it needs a newer lifecycle')
  .action(run(async (name: string, opts) => {
    const r = addKit(registry(opts), name, { into: opts.into, force: opts.force })
    emit(format(), r, () => [`Added ${r.kit} ${r.version} to ${r.path}.`, `Needs: ${r.needs.join(', ')}. Secrets: ${r.secrets.join(', ') || 'none'}.`, `Writes: ${r.writes}`, `Next: ask your agent to follow ${r.runbook}`].join('\n'))
  }))
kits.command('validate').argument('[dir]', 'registry folder', '.').description('Check a registry folder: index, manifests, runbooks and file references')
  .option('--write-index', 'rebuild index.json and the README catalog from the kit folders')
  .action(run(async (dir: string, opts) => {
    const r = validateRegistry(dir, { writeIndex: opts.writeIndex })
    emit(format(), r, () => (r.ok ? `OK: ${r.kits.length} kits${opts.writeIndex ? ', index.json written' : ''}.` : r.problems.map((p) => `${p.kit ? `${p.kit}: ` : ''}${p.problem}`).join('\n')))
    if (!r.ok) process.exitCode = 1
  }))

const targets = (t?: string): Target[] | undefined => {
  if (t === undefined) return undefined
  if (t === 'all') return ['claude', 'cursor']
  if (t === 'claude' || t === 'cursor') return [t]
  throw new CliError(`Unknown target ${t}.`, 'Use --target claude, cursor or all')
}
const skills = program.command('skills').description('Install kit skills into Claude Code and Cursor')
withRegistry(skills.command('sync').description('Install or update /lifecycle and one /lifecycle:kits:<kit> skill per kit'))
  .option('--target <target>', 'claude, cursor or all. Default: claude, plus cursor when it is installed')
  .option('--dry-run', 'show what would change')
  .option('--force', 'overwrite files you edited')
  .action(run(async (opts) => {
    const r = syncSkills(registry(opts), { targets: targets(opts.target), dryRun: opts.dryRun, force: opts.force })
    emit(format(), r, () => r.map((t) => [`${t.target}: ${t.dir}`, `  ${opts.dryRun ? 'would write' : 'wrote'} ${t.written.length}, unchanged ${t.unchanged.length}, removed ${t.removed.length}`, ...t.kept.map((k) => `  kept your edit: ${k}`)].join('\n')).join('\n') + (opts.dryRun ? '\nNothing was written.' : '\nRestart Claude Code to load new skills.'))
  }))
withRegistry(skills.command('status').description('Show installed skills and kits not installed yet')).action(run(async (opts) => {
  const r = skillsStatus(registry(opts))
  emit(format(), r, () => r.map((t) => `${t.target}: ${t.installed ? `installed (${t.installedVersion}), kits: ${t.kits.join(', ') || 'none'}` : 'not installed'}${t.installed && t.newKits.length ? `\n  new: ${t.newKits.join(', ')}. Run lifecycle skills sync` : ''}`).join('\n'))
}))
skills.command('uninstall').description('Remove the skills this CLI installed. Files you edited are kept').option('--target <target>', 'claude, cursor or all', 'all').action(run(async (opts) => {
  const r = uninstallSkills(targets(opts.target))
  emit(format(), r, () => r.map((t) => `${t.target}: removed ${t.removed.length}${t.kept.length ? `, kept your edits: ${t.kept.join(', ')}` : ''}`).join('\n'))
}))

program.command('feedback').argument('<message...>').description('Report a bug or a missing feature as a GitHub issue').option('--open', 'open the issue page in your browser').action(run(async (words: string[], opts) => {
  const url = feedbackUrl(words.join(' '))
  const opened = opts.open ? openUrl(url) : false
  emit(format(), { url, opened }, () => `${opened ? 'Opened' : 'Open this to send it'}: ${url}\nIt includes your lifecycle, Node and OS versions. Nothing else.`)
}))

program.command('mcp').description('Start the read-only MCP server').action(run(startMcp))

program.command('deploy').description('Run the daily sync from your own GitHub account')
  .option('--repo <owner/name>', 'private repo to create. Defaults to the deploy.repo setting')
  .option('--yes', 'create it. Without this, only prints the plan')
  .option('--write <dir>', 'write the project files to a folder instead, and create nothing')
  .action(run(async (opts) => {
  const config = readConfig()
  if (opts.write) {
    const w = writeProject(config, opts.write)
    emit(format(), w, () => `Wrote ${w.files.join(', ')} to ${w.dir}. Nothing was created on GitHub.`)
    return
  }
  const repo: string | undefined = opts.repo ?? config.deploy?.repo
  if (!repo) throw new CliError('Which repo should run the sync?', 'lifecycle deploy --repo OWNER/NAME', 'no_repo')
  opts.repo = repo
  const plan = deployPlan(config, opts.repo)
  if (!opts.yes) {
    emit(format(), plan, () => [`This would create:`, ...plan.creates.map((c) => `  ${c}`), `Secrets to set: ${plan.secrets.join(', ')}`, `Cost: ${plan.expectedCost}`, `Nothing was created. Add --yes to go ahead.`].join('\n'))
    return
  }
  const names = { LIFECYCLE_DATABASE_URL: 'database-url', LIFECYCLE_KLAVIYO_READ_KEY: 'klaviyo-read-key', LIFECYCLE_SHOPIFY_CLIENT_SECRET: 'shopify-client-secret', LIFECYCLE_GA4_CLIENT_SECRET: 'ga4-client-secret', LIFECYCLE_GA4_REFRESH_TOKEN: 'ga4-refresh-token', LIFECYCLE_STRIPE_READ_KEY: 'stripe-read-key' } as const
  const secrets: Record<string, string> = {}
  const wh = new Map(warehouseSecrets(config).map((w) => [w.env, w]))
  for (const s of plan.secrets) {
    const w = wh.get(s)
    const v = w ? getSourceSecret(w.slug, w.field) : getSecret(names[s as keyof typeof names])
    if (!v) throw new CliError(`Missing ${s}.`, s === 'LIFECYCLE_DATABASE_URL' ? 'Create a Postgres database, then lifecycle init --database-url-env NAME' : 'lifecycle doctor', 'missing_secret')
    secrets[s] = v
  }
  const r = deploy(config, opts.repo, secrets)
  setSetting('deploy.repo', opts.repo)
  emit(format(), r, () => `Deployed to ${r.url}\nRun it once now: ${r.firstRun}`)
}))

// The daily sync in GitHub Actions, named the way Graphed names its cloud jobs.
const jobs = program.command('jobs').description('The daily sync running in your GitHub account')
jobs.command('list').description('Recent runs of the daily sync, and the current success streak').option('--repo <owner/name>').option('--limit <n>', 'runs to show', '7').action(run(async (opts) => {
  const r = deployStatus(opts.repo ?? readConfig().deploy?.repo, Number(opts.limit))
  emit(format(), r, () => [`${r.repo}: ${r.successStreak} successful run${r.successStreak === 1 ? '' : 's'} in a row`, ...r.runs.map((x) => `  ${x.createdAt.slice(0, 16).replace('T', ' ')}  ${x.conclusion ?? x.status}  (${x.event})`)].join('\n'))
}))
jobs.command('run').description('Start the daily sync now').option('--repo <owner/name>').action(run(async (opts) => {
  const r = deployRun(opts.repo ?? readConfig().deploy?.repo)
  emit(format(), r, () => `Started a sync in ${r.repo}. Check it with lifecycle jobs list`)
}))

program.command('logs').description('Recent sync runs on this machine, or with --cloud, the last GitHub Actions log')
  .option('--cloud', 'show the log of the last daily sync in GitHub Actions')
  .option('--limit <n>', 'runs to show', '10')
  .option('--repo <owner/name>')
  .action(run(async (opts) => {
    if (opts.cloud) {
      const r = deployLogs(opts.repo ?? readConfig().deploy?.repo)
      emit(format(), r, () => `${r.run.url}\n${r.log}`)
      return
    }
    const db = await openDb()
    try {
      const rows = await db.query(`SELECT source, status, rows_written, started_at, finished_at, detail FROM meta_sync_run ORDER BY started_at DESC LIMIT $1`, [Number(opts.limit)])
      const runs = rows.map((r) => ({ source: String(r.source), status: String(r.status), rows: Number(r.rows_written), startedAt: new Date(String(r.started_at)).toISOString(), detail: r.detail ? String(r.detail) : null }))
      emit(format(), runs, () => (runs.length ? runs.map((r) => `${r.startedAt.slice(0, 16).replace('T', ' ')}  ${r.source.padEnd(8)} ${r.status.padEnd(8)} ${r.rows} rows${r.detail ? `  ${r.detail}` : ''}`).join('\n') : 'Nothing synced yet. Run lifecycle sync'))
    } finally {
      await db.close()
    }
  }))

const configCmd = program.command('config').description('Settings: registry.uri, deploy.repo, update.check')
configCmd.command('list').action(run(async () => {
  const s = listSettings()
  emit(format(), s, () => s.map((x) => `${x.key} = ${x.value ?? '(not set)'}    ${x.description}`).join('\n'))
}))
configCmd.command('get').argument('<key>').action(run(async (key: string) => {
  const value = getSetting(key) ?? null
  emit(format(), { key, value }, () => String(value ?? '(not set)'))
}))
configCmd.command('set').argument('<key>').argument('<value>').action(run(async (key: string, value: string) => {
  const v = setSetting(key, value)
  emit(format(), { key, value: v }, () => `${key} = ${v}`)
}))
configCmd.command('unset').argument('<key>').action(run(async (key: string) => {
  unsetSetting(key)
  emit(format(), { key, value: null }, () => `${key} removed`)
}))

const secretsCmd = program.command('secrets').description('Where each key comes from. Values are never shown')
secretsCmd.command('list').action(run(async () => {
  const s = secretStatus()
  emit(format(), s, () => s.map((x) => `${x.source.padEnd(8)} ${x.name}  (env: ${x.env})`).join('\n'))
}))
secretsCmd.command('set').argument('<name>').requiredOption('--from-env <var>', 'environment variable that holds the value').description('Save a key to the keychain from an environment variable').action(run(async (name: string, opts) => {
  if (!SECRET_NAMES.includes(name as SecretName)) throw new CliError(`Unknown secret ${name}.`, `Secrets: ${SECRET_NAMES.join(', ')}`, 'unknown_secret')
  const value = process.env[opts.fromEnv]
  if (!value) throw new CliError(`${opts.fromEnv} is empty.`, `export ${opts.fromEnv}=...`, 'missing_secret')
  setSecret(name as SecretName, value)
  emit(format(), { name, saved: true }, () => `Saved ${name} to the keychain.`)
}))
secretsCmd.command('delete').argument('<name>').action(run(async (name: string) => {
  if (!SECRET_NAMES.includes(name as SecretName)) throw new CliError(`Unknown secret ${name}.`, `Secrets: ${SECRET_NAMES.join(', ')}`, 'unknown_secret')
  const r = deleteSecret(name as SecretName)
  emit(format(), r, () => r.note)
}))

program.command('dashboard').description('Write one local HTML page: trust line, checks, metrics, flows, fixes and syncs')
  .option('--html <file>', 'where to write it', 'lifecycle-dashboard.html')
  .option('--days <n>', 'window in days', '90')
  .action(run(async (opts) => {
    const db = await openDb()
    try {
      const d = await buildDashboard(db, Number(opts.days))
      const html = dashboardHtml(d)
      writeHtml(opts.html, html)
      saveArtifact(basename(opts.html), html)
      emit(format(), { ...d, file: opts.html }, () => `${d.trust.line}\nWrote ${opts.html}. It stays on this machine.`)
    } finally {
      await db.close()
    }
  }))

// Tools: read-only Klaviyo and Shopify calls on your own keys. No credits, no middleman.
const tools = program.command('tools').description('Read-only Klaviyo and Shopify API tools, run on your own keys')
tools.command('catalog').description('List every tool and its inputs').action(run(async () => {
  const c = toolCatalog()
  emit(format(), c, () => c.map((t) => `${t.id}${t.input.length ? ` (${t.input.join(', ')})` : ''}\n  ${t.description}`).join('\n'))
}))
tools.command('run').argument('<tool>').option('--input <json>', 'tool input as JSON', '{}').description('Run a tool and save the result').action(run(async (id: string, opts) => {
  let input: unknown
  try {
    input = JSON.parse(opts.input)
  } catch {
    throw new CliError('--input is not valid JSON.', `lifecycle tools run ${id} --input '{"start":"2026-10-01","end":"2026-10-31"}'`, 'bad_input')
  }
  const r = await runTool(id, input, defaultToolContext())
  emit(format(), r, () => (r.status === 'succeeded' ? `${JSON.stringify(r.output, null, 2)}\nRun ${r.id} saved. lifecycle tools get ${r.id}` : `Run ${r.id} failed: ${r.error}`))
  if (r.status === 'failed') process.exitCode = 1
}))
tools.command('get').argument('<run>').option('--out <file>', 'write the output to a file').description('Print a saved run, or write its output to a file').action(run(async (id: string, opts) => {
  const r = getRun(id)
  if (opts.out) writeHtml(opts.out, JSON.stringify(r.output ?? null, null, 2))
  emit(format(), r, () => (opts.out ? `Wrote run ${r.id} output to ${opts.out}` : JSON.stringify(r, null, 2)))
}))
tools.command('runs').option('--limit <n>', 'runs to show', '20').description('Recent tool runs').action(run(async (opts) => {
  const r = listRuns(Number(opts.limit))
  emit(format(), r, () => (r.length ? r.map((x) => `${x.id}  ${x.startedAt.slice(0, 16).replace('T', ' ')}  ${x.status.padEnd(9)} ${x.tool}`).join('\n') : 'No tool runs yet.'))
}))

// Exec: like `graphed dev run`. Runs any command with your keys in its environment,
// so a script or agent can use them without the keys ever being printed or pasted.
program.command('exec').argument('<command...>').description('Run a command with your Lifecycle keys and settings in its environment').allowUnknownOption().action(run(async (command: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const provided: string[] = []
  for (const name of ALL_SECRETS) {
    const v = getSecret(name)
    if (v) {
      env[envName(name)] = v
      provided.push(envName(name))
    }
  }
  try {
    const config = readConfig()
    if (config.shopify) Object.assign(env, { LIFECYCLE_SHOPIFY_STORE: config.shopify.store, LIFECYCLE_SHOPIFY_CLIENT_ID: config.shopify.clientId })
    if (config.database.kind === 'postgres' && env.LIFECYCLE_DATABASE_URL) env.DATABASE_URL = env.LIFECYCLE_DATABASE_URL
  } catch {
    // Not set up: pass only what exists.
  }
  if (format() === 'text') console.error(`lifecycle exec: passing ${provided.length ? provided.join(', ') : 'no keys'}`)
  const r = spawnSync(command[0]!, command.slice(1), { stdio: 'inherit', env })
  if (r.error) throw new CliError(`Could not run ${command[0]}: ${r.error.message}`, 'Check the command name.', 'exec_failed')
  process.exitCode = r.status ?? 1
}))

// Serve: the dashboard and a JSON API on 127.0.0.1, read-only.
program.command('serve').description('Serve the dashboard and a read-only JSON API on this machine').option('--port <n>', 'port', '4173').action(run(async (opts) => {
  const db = await openDb()
  const s = await serve(db, Number(opts.port))
  emit(format(), { url: s.url, routes: ROUTES }, () => `Serving ${s.url}  (read-only, this machine only)\nRoutes: ${ROUTES.join(', ')}\nStop with Ctrl+C.`)
  const stop = async () => {
    await s.close()
    await db.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}))

// Files: every report, dashboard and plan, kept by date. Storage commands match Graphed's names.
const files = program.command('files').description('Reports, dashboards and plans this CLI has written, plus the daily cloud dashboard')
files.command('ls').argument('[path]', 'folder inside the store, such as cloud or a date', '').action(run(async (path: string) => {
  const f = listFiles(path)
  emit(format(), { dir: filesDir(), files: f }, () => (f.length ? f.map((x) => `${x.modified.slice(0, 16).replace('T', ' ')}  ${String(x.bytes).padStart(8)}  ${x.path}`).join('\n') : `No files yet in ${filesDir()}`))
}))
files.command('cat').argument('<path>').action(run(async (path: string) => {
  const text = readFile(path)
  emit(format(), { path, content: text }, () => text)
}))
files.command('get').argument('<path>').argument('[dir]', 'where to copy it', '.').description('Copy a stored file to a folder').action(run(async (path: string, dir: string) => {
  const dest = getFile(path, dir)
  emit(format(), { path, dest }, () => `Copied to ${dest}`)
}))
files.command('put').argument('<file>').argument('[name]').description('Keep a local file in the store, under today').action(run(async (file: string, name?: string) => {
  const path = putFile(file, name)
  emit(format(), { path }, () => `Stored as ${path}`)
}))
files.command('path').description('Print where the store lives').action(run(async () => {
  emit(format(), { dir: filesDir() }, () => filesDir())
}))
files.command('pull').option('--repo <owner/name>').description('Download the dashboard from the latest successful daily sync').action(run(async (opts) => {
  const r = pullCloud(opts.repo ?? readConfig().deploy?.repo)
  emit(format(), r, () => `Pulled run ${r.run} (${r.createdAt}):\n${r.files.map((f) => `  ${f}`).join('\n')}`)
}))

sources.command('import').argument('<name>').requiredOption('--csv <file>', 'CSV of daily totals').option('--date-column <name>', 'the date column', 'date').description('Import daily totals from any other tool as a custom source').action(run(async (name: string, opts) => {
  const db = await openDb()
  try {
    await migrate(db)
    const r = await importCsv(db, name, opts.csv, opts.dateColumn)
    emit(format(), r, () => `Imported ${r.days} day${r.days === 1 ? '' : 's'} (${r.from} to ${r.to}) into ${r.table}: ${r.columns.join(', ')}\nQuery it with lifecycle query "SELECT * FROM ${r.table} ORDER BY date DESC"`)
  } finally {
    await db.close()
  }
}))

// Provision: a managed Postgres in your own Neon account, so the daily sync has somewhere to write.
// The warehouse: raw tables from many tools, one schema per source, loaded by dlt.
const warehouse = program.command('warehouse').description('Load raw data from many tools into your database, one schema per source')
const collect = (v: string, prev: string[] = []) => [...prev, v]

warehouse.command('show').argument('<slug>').description('What a source needs, what it loads, and how far it is proven').action(run(async (slug: string) => {
  const s = findSource(slug)
  const { config, ...rest } = s
  const resources = ((config as { resources?: { name: string }[] } | undefined)?.resources ?? []).map((r) => r.name)
  const connectCmd = `lifecycle warehouse connect ${s.slug} ${[...s.credentials.map((c) => `--secret ${c.name}=${c.name.toUpperCase()}_VAR`), ...s.params.map((p) => `--set ${p.name}=${p.example}`)].join(' ')}`.trim()
  const out = { ...rest, resources, schema: datasetFor(s.slug), connect: config ? connectCmd : null }
  emit(format(), out, () => [
    `${s.name} (${s.slug}), ${s.category}, ${s.readiness}`,
    `Why: ${s.why}`,
    s.docs ? `API docs: ${s.docs}` : '',
    resources.length ? `Loads: ${resources.join(', ')} into schema ${datasetFor(s.slug)}` : 'No connector yet. Bring daily totals in with: lifecycle sources import NAME --csv FILE',
    ...s.credentials.map((c) => `Needs ${c.name}: ${c.label}. ${c.help}`),
    ...s.params.map((p) => `Needs setting ${p.name}: ${p.label} (for example ${p.example})`),
    s.tested ? `Tested: ${s.tested}` : '',
    s.notes ? `Notes: ${s.notes}` : '',
    config ? `Connect: ${connectCmd}` : '',
  ].filter(Boolean).join('\n'))
}))

warehouse.command('connect').argument('<slug>')
  .description('Check a key with one page of data, then save it. Keys come from environment variables, never the command line')
  .option('--secret <field=ENV_VAR>', 'credential field and the variable holding it (repeatable)', collect)
  .option('--set <name=value>', 'a setting such as your store or subdomain (repeatable)', collect)
  .option('--keep-personal-data', 'also load emails, names, phones and addresses. Off by default')
  .option('--skip-check', 'save without calling the API first')
  .action(run(async (slug: string, opts) => {
    const r = await connectSource(slug, opts)
    emit(format(), r, () => `Connected ${slug}. Check: ${typeof r.check === 'string' ? r.check : `${r.check.rows} rows from ${r.check.resource}`}. Personal data: ${r.personalData}.\nNext: ${r.next}`)
  }))

warehouse.command('disconnect').argument('<slug>').description('Forget a source and its keys. Loaded data is kept').action(run(async (slug: string) => {
  const r = disconnectSource(slug)
  emit(format(), r, () => `Disconnected ${slug}. ${r.keysRemoved} key(s) removed. ${r.note}`)
}))

warehouse.command('list').description('Connected warehouse sources').action(run(async () => {
  const list = connectedSources(readConfig()).map((c) => ({ ...c, schema: datasetFor(c.slug), name: findSource(c.slug).name }))
  emit(format(), list, () => list.length ? list.map((c) => `${c.name} (${c.slug}) -> ${c.schema}, personal data ${c.personalData === 'keep' ? 'kept' : 'removed'}, connected ${c.connectedAt.slice(0, 10)}`).join('\n') : 'No warehouse sources connected. See lifecycle sources catalog')
}))

warehouse.command('sync').argument('[slugs...]').description('Load fresh data from connected warehouse sources').option('--verbose', 'show the loader log').action(run(async (slugs: string[], opts) => {
  const config = readConfig()
  const db = await openDb()
  try {
    await migrate(db)
    const record = async (r: WarehouseSyncResult, startedAt: string) => {
      await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status, rows_written, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), r.source, startedAt, new Date().toISOString(), r.status, r.rows, r.detail ?? null])
    }
    const results = await syncSources(slugs, { verbose: opts.verbose, record })
    const failed = results.filter((r) => r.status === 'failed')
    if (failed.length) process.exitCode = 1
    emit(format(), { database: config.database.kind, results }, () => results.map((r) => r.status === 'ok' ? `ok      ${r.source}: ${r.rows} rows${r.tables ? ` (${Object.entries(r.tables).map(([t, n]) => `${t} ${n}`).join(', ')})` : ''}` : `failed  ${r.source}: ${r.detail}`).join('\n'))
  } finally {
    await db.close()
  }
}))

warehouse.command('schema').argument('[slug]').description('Tables and columns the warehouse holds').action(run(async (slug?: string) => {
  const config = readConfig()
  let cols: { schema: string; table: string; column: string; type: string }[]
  if (config.database.kind === 'local') cols = await duckSchema(slug)
  else {
    const db = await openDb()
    try {
      const rows = await db.query(
        `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema LIKE 'src\_%' AND table_schema NOT LIKE '%\_staging' AND column_name NOT LIKE '\_dlt%' AND table_name NOT LIKE '\_dlt%' ${slug ? 'AND table_schema = $1' : ''} ORDER BY 1, 2, ordinal_position`,
        slug ? [datasetFor(slug)] : [],
      )
      cols = rows.map((r) => ({ schema: String(r.table_schema), table: String(r.table_name), column: String(r.column_name), type: String(r.data_type) }))
    } finally {
      await db.close()
    }
  }
  const grouped: Record<string, string[]> = {}
  for (const c of cols) (grouped[`${c.schema}.${c.table}`] ??= []).push(`${c.column} ${c.type}`)
  emit(format(), grouped, () => Object.keys(grouped).length ? Object.entries(grouped).map(([t, c]) => `${t}\n  ${c.join('\n  ')}`).join('\n\n') : 'Nothing loaded yet. Run lifecycle warehouse sync')
}))

warehouse.command('query').argument('<sql>').description('Run one read-only SQL query across warehouse schemas, such as src_gorgias.tickets').action(run(async (sql: string) => {
  const config = readConfig()
  if (config.database.kind === 'local') {
    const r = await duckQuery(sql)
    emit(format(), r, () => `${JSON.stringify(r.rows, null, 2)}\n${r.rows.length} rows`)
    return
  }
  const db = await openDb()
  try {
    const r = await runQuery(db, sql)
    emit(format(), r, () => `${JSON.stringify(r.rows, null, 2)}\n${r.rowCount} rows${r.truncated ? ' (capped)' : ''}`)
  } finally {
    await db.close()
  }
}))

warehouse.command('add-api').argument('<slug>').requiredOption('--spec <file>', 'JSON spec: name, credentials, params and a dlt rest_api config').description('Add any REST API as a source. See lifecycle docs warehouse').action(run(async (slug: string, opts) => {
  const r = addCustomSource(slug, opts.spec)
  emit(format(), r, () => `Added ${slug}.\nNext: ${r.next}`)
}))

program.command('provision').description('Create a managed database in your own cloud account').argument('<provider>', 'neon')
  .requiredOption('--key-env <name>', 'environment variable holding your Neon API key')
  .option('--name <name>', 'project name', 'lifecycle')
  .option('--region <id>', 'Neon region', 'aws-us-east-2')
  .option('--yes', 'create it. Without this, only prints the plan')
  .action(run(async (provider: string, opts) => {
    if (provider !== 'neon') throw new CliError(`Unsupported provider ${provider}.`, 'lifecycle provision neon --key-env NEON_API_KEY', 'bad_provider')
    if (!opts.yes) {
      const plan = neonPlan(opts.name, opts.region)
      emit(format(), plan, () => ['This would create:', ...plan.creates.map((c) => `  ${c}`), `Cost: ${plan.cost}`, 'Nothing was created. Add --yes to go ahead.'].join('\n'))
      return
    }
    const key = process.env[opts.keyEnv]
    if (!key) throw new CliError(`${opts.keyEnv} is empty.`, `export ${opts.keyEnv}=your_neon_api_key`, 'missing_secret')
    const p = await provisionNeon(key, opts.name, opts.region)
    // The connection string is a secret: it goes to the keychain and is never printed.
    process.env.LIFECYCLE_PROVISIONED_URL = p.uri
    try {
      await init({ databaseUrlEnv: 'LIFECYCLE_PROVISIONED_URL' })
    } catch (e) {
      if (e instanceof CliError && e.code === 'no_keychain') throw new CliError('Created the Neon project, but there is no keychain here to store its connection string.', 'Copy the connection string from the Neon console into LIFECYCLE_DATABASE_URL, then lifecycle init --database-url-env LIFECYCLE_DATABASE_URL', 'no_keychain')
      throw e
    } finally {
      delete process.env.LIFECYCLE_PROVISIONED_URL
    }
    emit(format(), { provider, projectId: p.projectId, region: p.region, database: 'postgres' }, () => `Created Neon project ${p.projectId} in ${p.region} and set it as this CLI's database.\nNext: lifecycle sync, then lifecycle deploy --repo OWNER/NAME`)
  }))

program.command('status').description('One-screen summary: setup, sources, trust, the daily sync and updates').action(run(async () => {
  let config: Config | null = null
  try {
    config = readConfig()
  } catch {
    config = null
  }
  const db = config ? await openDb().catch(() => null) : null
  try {
    const sources = await sourceStatus(config, (slug) => Boolean(getSecret(SECRET_FOR[slug]!)), db)
    const trust = db ? await trustLine(db).catch(() => null) : null
    const update = await checkForUpdate()
    const out = { version: VERSION, setUp: Boolean(config), database: config?.database.kind ?? null, sources, trust, deployRepo: config?.deploy?.repo ?? null, update }
    emit(format(), out, () => [
      `lifecycle ${VERSION}${update.newer ? `  (update available: ${update.latest}. Run: ${UPDATE_COMMAND})` : ''}`,
      config ? `Database: ${config.database.kind}` : 'Not set up. Run lifecycle init, or follow lifecycle docs quickstart',
      ...sources.map((s) => `${s.connected ? 'connected    ' : 'not connected'} ${s.name}${s.lastSync ? `, last sync ${s.lastSync.slice(0, 16).replace('T', ' ')}` : ''}`),
      trust ? `Trust: ${trust.line}` : '',
      `Daily sync: ${config?.deploy?.repo ?? 'not deployed. lifecycle deploy --repo OWNER/NAME'}`,
    ].filter(Boolean).join('\n'))
  } finally {
    await db?.close()
  }
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

program.command('docs').argument('[topic]', `one of: ${Object.keys(DOCS).join(', ')}`, 'agents').description('Read the built-in docs').action(run(async (topic: string) => {
  const doc = DOCS[topic]
  if (!doc) throw new CliError(`No doc named ${topic}.`, 'lifecycle docs commands')
  emit(format(), { topic, doc }, () => doc)
}))

await program.parseAsync()
