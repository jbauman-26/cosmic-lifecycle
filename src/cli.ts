#!/usr/bin/env node
import { Command } from 'commander'
import { emit, emitError, type Format } from './output.js'
import { init } from './commands/init.js'
import { connectGa4, connectGoogleAds, connectHubspot, connectKlaviyo, connectMerchantCenter, connectMeta, connectRedditAds, connectShopify, connectSnapchatAds, connectStripe } from './commands/connect.js'
import { doctor } from './commands/doctor.js'
import { openDb, migrate, type Db } from './db.js'
import { readConfig, settingValue, writeConfig } from './config.js'
import { getSecret, getSourceSecret } from './secrets.js'
import { CliError } from './errors.js'
import { changedSinceQuery, fetchOrderCount, fetchOrders, shopifyToken } from './sources/shopify.js'
import { keyer, newCustomerKey, plan as shopifyPlan, readSyncState, type Keyer } from './shopify-state.js'
import { fetchGa4Daily, ga4AccessToken } from './sources/ga4.js'
import { reconcile } from './reconcile.js'
import { Klaviyo } from './sources/klaviyo.js'
import { Stripe } from './sources/stripe.js'
import { MetaAds } from './sources/meta.js'
import { GoogleAds, googleAdsAccessToken } from './sources/google-ads.js'
import { MerchantCenter, merchantAccessToken } from './sources/google-merchant-center.js'
import { RedditAds, redditAccessToken } from './sources/reddit-ads.js'
import { SnapchatAds, snapAccessToken } from './sources/snapchat-ads.js'
import { HubSpot } from './sources/hubspot.js'
import { exportProgress, syncGa4, syncGoogleAds, syncHubspot, syncKlaviyo, syncMerchantCenter, syncMeta, syncRedditAds, syncShopify, syncShopifyBulk, syncShopifyChanges, syncSnapchatAds, syncStripe, type SourceResult } from './sync.js'
import { shopifyGql } from './sources/shopify-bulk.js'
import { runQuery } from './query.js'
import { PUBLIC_TABLES } from './schema.js'
import { VERSION } from './version.js'
import { DOCS } from './docs.js'
import { addKit, ensureRegistry, listKits, searchKits, showKit, validateRegistry, type Registry } from './registry.js'
import { accountSkillFiles, assertSlug, readSkillDir, skillsStatus, syncSkills, uninstallSkills, type Target } from './skills.js'
import { feedbackUrl, openUrl } from './feedback.js'
import { assertPack, deleteMetric, describeMetric, formatValue, listAllMetrics, runMetric, saveMetric, UNITS } from './metrics.js'
import { ALL_NATIVE, CATALOG, CUSTOM_SOURCE_NOTE, kitPrompt, sourceStatus } from './sources-catalog.js'
import type { Config } from './config.js'
import { startMcp } from './mcp.js'
import { DEMO_TYPES, demoFor, runDemo, runTypeDemo, type DemoType } from './demo.js'
import { deploy, deployLogs, deployPlan, deployRun, deployRunById, deployStatus, followRun, warehouseSecrets, writeProject } from './deploy.js'
import { defaultOf, getSetting, listSettings, setSetting, unsetSetting, type SettingKey } from './config.js'
import { deleteSecret, secretStatus, setSecret, useKeychain, SECRET_NAMES, type SecretName } from './secrets.js'
import { buildDashboard, dashboardHtml } from './dashboard.js'
import { SECRET_FOR, checklistLines, loadChecklist } from './checklist.js'
import { checkForUpdate, UPDATE_HINT } from './update.js'
import { tryWriteLock, withWriteLock } from './lock.js'
import { trustLine } from './reconcile.js'
import { defaultDays, metricCandidates } from './metrics.js'
import { recordCustomQuery } from './query.js'
import { basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { saveArtifact, filesDir, listFiles, readFile, getFile, putFile, pullCloud } from './files.js'
import { customTables, importCsv } from './custom-sources.js'
import { cloudRunRecord, defaultToolContext, getRun, listRuns, runTool, toolCatalog, type ToolRun } from './tools.js'
import { abortRun, costLine, defaultOpenContext, openProviders, parseRef, refreshRun, startOpenTool, waitForRun } from './open-tools.js'
import { serve, ROUTES } from './serve.js'
import { neonPlan, provisionNeon } from './provision.js'
import { envName, SECRET_NAMES as ALL_SECRETS } from './secrets.js'
import { auditFlows, auditHtml, revenueHtml, revenuePerFlow, writeHtml } from './reports.js'
import { applyPlan, buildPlan, readPlan, suggestLapsedDays, writePlan } from './segments.js'
import { addCustomSource, connectSource, connectedSources, datasetFor, disconnectSource, duckQuery, duckSchema, findSource, freeTextMode, markColumns, scrubWarehouse, searchCatalog, syncSources, type SchemaColumn, type WarehouseSyncResult } from './warehouse.js'
import { classifyColumn } from './personal.js'
import { sourceOfSchema } from './warehouse-names.js'
import { READINESS_LEGEND } from './warehouse-catalog.js'
import { randomUUID } from 'node:crypto'
import { NATIVE, chooseSources, disconnectNative, isNative, parseOnly } from './native.js'
import { CLOUD_TOKEN_ENV, CLOUD_URL_ENV, CloudClient, clean, cloudTokenSource, cloudUrl, isNotBuilt, loggedIn, verifyLogin } from './cloud.js'
import { assertReadOnlySql } from './query.js'
import { readCosts, setCost, setProductCosts, writeCosts, costsPath, COST_KEYS } from './costs.js'
import { readFileSync } from 'node:fs'
import { fetchCostOrders } from './sources/shopify-costs.js'
import { rollupMetric } from './rollup.js'
import { assertReference, assertType, readWorkspace, REFERENCE_NAME, TYPES, WORKSPACE_TYPES, noun, type WorkspaceType } from './workspace.js'
import { pickType } from './commands/init.js'
import { configPath, workspaceName, workspacesDir } from './paths.js'
import { existsSync, readdirSync } from 'node:fs'

const program = new Command('lifecycle')
  .description('Marketing numbers your agent can trust, for a Shopify store, a SaaS product, a B2B pipeline, an agency client or a creator business. Read-only. Nothing sends.')
  .version(VERSION)
  .option('--format <format>', 'text or json', 'text')
  .option('--workspace <name>', 'use a named workspace, such as one per agency client. Same as LIFECYCLE_WORKSPACE')
  // Set before any command runs, so every path, setting and keychain entry is the workspace's own.
  .hook('preAction', (cmd) => {
    const ws = cmd.opts().workspace
    if (ws !== undefined) process.env.LIFECYCLE_WORKSPACE = String(ws)
    try {
      workspaceName()
    } catch (e) {
      emitError(cmd.opts().format === 'json' ? 'json' : 'text', e)
      process.exit(1)
    }
  })

const format = () => (program.opts().format === 'json' ? 'json' : 'text') as Format
const run = (fn: (...a: any[]) => Promise<void>) => async (...a: any[]) => {
  try {
    await fn(...a)
  } catch (e) {
    emitError(format(), e)
  }
}
// Write commands take the store's lock first, so two of them never write one local database at once.
// A second one waits a few seconds, then fails with code `busy`.
const write = (name: string, fn: (...a: any[]) => Promise<void>) => run((...a: any[]) => withWriteLock(name, () => fn(...a)))
// Open the store for a read when it exists. Listing metrics works before init, with built-ins only.
const openIfSetUp = async () => {
  try {
    readConfig()
  } catch {
    return null
  }
  return openDb().catch(() => null)
}
const keyNote = (r: { keyNote?: string | null }) => (r.keyNote ? `\n${r.keyNote}` : '')
// A read command brings an older store up to date only when no writer holds it. A writer that is
// running has already done so, and a read must never write beside it.
const migrateIfFree = async (db: Db, name: string) => {
  const lock = tryWriteLock(name)
  if (!lock) return
  try {
    await migrate(db)
  } finally {
    lock()
  }
}
const CLOUD_FLAG = 'ask Cosmic Cloud instead of this machine. Needs lifecycle login'
const clock = (iso?: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : 'never')

// Cosmic Cloud: sign in with a store token, then --cloud on a read command asks Cloud.
program.command('login').description('Sign this machine in to Cosmic Cloud with a workspace token (Cloud calls it a store token). The token is read from an environment variable and is never printed')
  .option('--url <cloud url>', `Cosmic Cloud address. Default: ${CLOUD_URL_ENV}, then the saved address, then the public one`)
  .option('--token-env <VAR>', 'environment variable holding the token from Cosmic Cloud, Settings, Mac app access')
  .action(run(async (opts) => {
    if (!opts.tokenEnv) throw new CliError('Which variable holds the Cosmic Cloud token?', 'export COSMIC_CLOUD_TOKEN=..., then lifecycle login --token-env COSMIC_CLOUD_TOKEN', 'missing_secret')
    const token = process.env[opts.tokenEnv]
    if (!token) throw new CliError(`${opts.tokenEnv} is empty.`, `export ${opts.tokenEnv}=..., then run lifecycle login again. Never paste the token into a chat.`, 'missing_secret')
    const v = await verifyLogin(opts.url ?? cloudUrl().url, token)
    let tokenStorage: 'keychain' | 'environment' = 'keychain'
    try {
      setSecret('cloud-token', token)
    } catch (e) {
      if (!(e instanceof CliError && e.code === 'no_keychain')) throw e
      tokenStorage = 'environment'
    }
    setSetting('cloud.url', v.url)
    const note = tokenStorage === 'environment' ? `There is no keychain here, so the token was not saved: keep it in ${CLOUD_TOKEN_ENV}.` : null
    emit(format(), { loggedIn: true, url: v.url, store: v.store, connections: v.connections, tokenStorage, tokenEnv: tokenStorage === 'environment' ? CLOUD_TOKEN_ENV : null, note }, () => [`Logged in to Cosmic Cloud. Store: ${v.store.name}`, `Address: ${v.url}`, note ?? 'The token is in the keychain.', 'Next: lifecycle cloud status'].join('\n'))
  }))

program.command('logout').description('Forget the Cosmic Cloud token and address on this machine').action(run(async () => {
  const removed = deleteSecret('cloud-token').removed
  let urlRemoved = false
  if (getSetting('cloud.url') !== undefined) {
    unsetSetting('cloud.url')
    urlRemoved = true
  }
  // A token left in the environment only works with an address the owner set in the environment too.
  const envStill = Boolean(process.env[CLOUD_TOKEN_ENV]) && Boolean(process.env[CLOUD_URL_ENV])
  const note = envStill ? `${CLOUD_TOKEN_ENV} and ${CLOUD_URL_ENV} are still set in this environment, so --cloud commands still work until you unset them.` : process.env[CLOUD_TOKEN_ENV] ? `${CLOUD_TOKEN_ENV} is still set. Without a saved address it is not sent anywhere, but unset it if you are done with it.` : null
  emit(format(), { loggedOut: !envStill, tokenRemoved: removed, urlRemoved, note }, () => [envStill ? 'The saved token and address were removed.' : 'Logged out of Cosmic Cloud.', note, 'To stop the token working everywhere, revoke it in Cosmic Cloud under Settings.'].filter(Boolean).join('\n'))
}))

const cloud = program.command('cloud').description('Cosmic Cloud: the hosted copy of this workspace')
cloud.command('status').description('Whether this machine is logged in to Cosmic Cloud, which workspace, and what is connected there').action(run(async () => {
  const { url, source: urlSource } = cloudUrl()
  const tokenSource = cloudTokenSource()
  // A token with no address the owner chose is not logged in: it would not be sent anywhere.
  if (tokenSource === 'missing' || urlSource === 'default') {
    const note = tokenSource === 'missing' ? null : `A token is set, but no Cloud address is saved, so it is not used. Run lifecycle login again, or set ${CLOUD_URL_ENV}.`
    emit(format(), { loggedIn: false, url, urlSource, tokenSource, note }, () => [`Not logged in to Cosmic Cloud.`, note, `Next: lifecycle login --token-env YOUR_VAR`].filter(Boolean).join('\n'))
    return
  }
  try {
    const r = await new CloudClient().store()
    const connections = (r.connections ?? []).map((c) => ({ source: c.source_id, name: clean(String(c.source_name ?? c.source_id), 80), status: c.status ?? null, statusCode: c.status_code ?? null, lastSuccessAt: c.last_success_at ?? null, freshness: c.freshness ?? null, nextSyncAt: c.next_sync_at ?? null }))
    emit(format(), { loggedIn: true, reachable: true, url, urlSource, tokenSource, store: { id: r.store.id, name: clean(String(r.store.name), 120) }, contractVersion: r.contract_version ?? null, connections }, () => [
      `Logged in to Cosmic Cloud. Store: ${clean(String(r.store.name), 120)}`,
      `Address: ${url} (${urlSource === 'env' ? CLOUD_URL_ENV : urlSource === 'config' ? 'saved by login' : 'the default'}). Token: from the ${tokenSource === 'env' ? 'environment' : 'keychain'}.`,
      ...(connections.length ? connections.map((c) => `${String(c.status ?? 'unknown').padEnd(10)} ${c.name}, last good sync ${clock(c.lastSuccessAt)}${c.statusCode ? ` (${c.statusCode})` : ''}`) : ['No sources are connected on Cosmic Cloud yet.']),
    ].join('\n'))
  } catch (e) {
    if (!(e instanceof CliError)) throw e
    emit(format(), { loggedIn: true, reachable: false, url, urlSource, tokenSource, error: e.message, code: e.code, next: e.next }, () => `A token is saved, but Cosmic Cloud could not be read: ${e.message}\nNext: ${e.next}`)
    process.exitCode = 1
  }
}))

program.command('init').description('Set up the database and say what kind of business this workspace is')
  .option('--database-url-env <name>', 'use your own Postgres instead of the local database')
  .option('--type <type>', `workspace type: ${WORKSPACE_TYPES.join(', ')}. Asked when not given in a terminal; shopify otherwise, and for every install made before 0.14.0`)
  .option('--reference <source>', 'source of truth the trust gate checks against: shopify, stripe, hubspot, ga4 or none. Default: the one for the type')
  .action(write('init', async (opts) => {
  let type: WorkspaceType | undefined = opts.type ? assertType(opts.type) : undefined
  // Only a brand new workspace in a terminal is asked. An existing install stays as it is.
  if (!type && format() === 'text' && process.stdin.isTTY && process.stdout.isTTY && !existsSync(configPath())) type = await pickType()
  const r = await init({ ...opts, type, reference: opts.reference ? assertReference(opts.reference) : undefined })
  const t = TYPES[r.type]
  const first = t.sources[0]!
  emit(format(), r, () => r.type === 'shopify' && r.reference === 'shopify'
    ? `Ready. Database: ${r.database}\nNext: lifecycle connect klaviyo --key-env NAME`
    : [`Ready. Database: ${r.database}. Workspace: ${t.title}.`, `Source of truth: ${REFERENCE_NAME[r.reference]}. ${t.referenceWhy}`, `Sources most ${t.title.toLowerCase()} workspaces connect: ${t.sources.join(', ')}.`, `Next: ${ALL_NATIVE.find((s) => s.slug === first)?.connect ?? `lifecycle warehouse show ${first}`}`].join('\n'))
}))

const workspaceCmd = program.command('workspace').description('What kind of business this workspace is, its source of truth, and named workspaces')
workspaceCmd.command('show').description('Type, source of truth, metric pack and the sources this type usually connects').action(run(async () => {
  const w = readWorkspace()
  const t = TYPES[w.type]
  const out = { name: workspaceName() ?? 'default', type: w.type, title: t.title, reference: w.reference, referenceSet: w.referenceSet, referenceWhy: t.referenceWhy, sources: t.sources, pack: w.type }
  emit(format(), out, () => [`Workspace: ${out.name} (${t.title})`, `Source of truth: ${REFERENCE_NAME[w.reference]}${w.referenceSet ? ' (set by hand)' : ''}. ${t.referenceWhy}`, `Usual sources: ${t.sources.join(', ')}`, `Metrics: lifecycle metrics list --pack ${w.type}`].join('\n'))
}))
workspaceCmd.command('list').description('Named workspaces on this machine, such as one per agency client').action(run(async () => {
  const dir = workspacesDir()
  const names = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []
  const list = names.map((name) => {
    const prev = process.env.LIFECYCLE_WORKSPACE
    process.env.LIFECYCLE_WORKSPACE = name
    try {
      const w = readWorkspace()
      return { name, type: w.type, reference: w.reference }
    } finally {
      if (prev === undefined) delete process.env.LIFECYCLE_WORKSPACE
      else process.env.LIFECYCLE_WORKSPACE = prev
    }
  })
  emit(format(), { current: workspaceName() ?? 'default', workspaces: list }, () => (list.length ? list.map((w) => `${w.name}  ${w.type}, checked against ${REFERENCE_NAME[w.reference]}`).join('\n') : 'No named workspaces. Make one with: lifecycle --workspace NAME init --type agency'))
}))

const connect = program.command('connect').description('Connect a data source')
connect.command('klaviyo').option('--key-env <name>', 'environment variable holding a read-only private key').action(write('connect klaviyo', async (opts) => {
  const r = await connectKlaviyo(opts)
  emit(format(), r, () => `Connected to Klaviyo: ${r.account}${keyNote(r)}`)
}))
connect.command('shopify').option('--shop <domain>', 'the shop domain, NAME.myshopify.com').option('--store <domain>', 'same as --shop, kept so older scripts work').option('--client-id <id>').option('--secret-env <name>', 'environment variable holding the client secret').action(write('connect shopify', async (opts) => {
  const r = await connectShopify({ ...opts, store: opts.shop ?? opts.store })
  emit(format(), r, () => `Connected to ${r.store}${keyNote(r)}`)
}))

connect.command('ga4').option('--property <id>').option('--client-id <id>').option('--secret-env <name>').option('--refresh-token-env <name>').action(write('connect ga4', async (opts) => {
  const r = await connectGa4(opts)
  emit(format(), r, () => `Connected to GA4 property ${r.property}${keyNote(r)}`)
}))
connect.command('stripe').description('Read-only: charges, refunds, subscriptions. Totals only.').option('--key-env <name>', 'environment variable holding a restricted key').action(write('connect stripe', async (opts) => {
  const r = await connectStripe(opts)
  emit(format(), r, () => [`Connected to Stripe (${r.mode} mode)${r.subscriptions ? '' : '. This key cannot read subscriptions, so MRR is off.'}`, r.note, r.keyNote].filter(Boolean).join('\n'))
}))

connect.command('meta').description('Read-only: daily spend and results by campaign. No audiences, people or creative.').option('--account <id>', 'ad account id from Ads Manager').option('--token-env <name>', 'environment variable holding a system user token with ads_read').action(write('connect meta', async (opts) => {
  const r = await connectMeta(opts)
  emit(format(), r, () => `Connected to Meta ad account ${r.name || r.account} (${r.currency}, ${r.timezone}).${keyNote(r)}\nNext: lifecycle sync`)
}))

connect.command('hubspot').description('Read-only: daily deals, pipeline and new contacts as counts. No contact, company or deal record').option('--token-env <name>', 'environment variable holding a private app token with crm.objects.deals.read and crm.objects.contacts.read').action(write('connect hubspot', async (opts) => {
  const r = await connectHubspot(opts)
  emit(format(), r, () => `Connected to HubSpot${r.portal ? ` portal ${r.portal}` : ''} (deals without a currency count as ${r.currency}).${keyNote(r)}\nNext: lifecycle sync`)
}))
connect.command('google-ads').description('Read-only: daily cost and results by campaign and ad group. No audiences, keywords, people or creative.')
  .option('--customer <id>', 'Google Ads customer id, such as 123-456-7890')
  .option('--login-customer <id>', 'manager account id, when access to the account comes through a manager')
  .option('--client-id <id>', 'OAuth client id from the Google Cloud project')
  .option('--secret-env <name>', 'environment variable holding the OAuth client secret')
  .option('--refresh-token-env <name>', 'environment variable holding a refresh token with the adwords scope')
  .action(write('connect google-ads', async (opts) => {
    const r = await connectGoogleAds(opts)
    emit(format(), r, () => `Connected to Google Ads account ${r.name || r.customer} (${r.currency}, ${r.timezone})${r.testAccount ? ', a test account' : ''}.${keyNote(r)}\nNext: lifecycle sync`)
  }))
connect.command('google-merchant-center').description('Read-only: daily clicks and impressions for free listings and Shopping ads, and product counts by status. No product ids, titles or prices.')
  .option('--account <id>', 'Merchant Center account id, the number at the top of Merchant Center')
  .option('--client-id <id>', 'OAuth client id from the Google Cloud project')
  .option('--secret-env <name>', 'environment variable holding the OAuth client secret')
  .option('--refresh-token-env <name>', 'environment variable holding a refresh token with the content scope')
  .action(write('connect google-merchant-center', async (opts) => {
    const r = await connectMerchantCenter(opts)
    emit(format(), r, () => `Connected to Merchant Center account ${r.name || r.account}.${keyNote(r)}\nNext: lifecycle sync`)
  }))
connect.command('reddit-ads').description('Read-only: daily spend and results by campaign. No audiences, communities, keywords, people or creative.')
  .option('--account <id>', 'Reddit ad account id, such as a2_abc123, from Accounts in Ads Manager')
  .option('--client-id <id>', 'app id of the developer application in Reddit Ads')
  .option('--secret-env <name>', 'environment variable holding the app secret')
  .option('--refresh-token-env <name>', 'environment variable holding a refresh token with the adsread scope')
  .action(write('connect reddit-ads', async (opts) => {
    const r = await connectRedditAds(opts)
    emit(format(), r, () => `Connected to Reddit ad account ${r.name || r.account} (${r.currency}, ${r.timezone}).${keyNote(r)}\nNext: lifecycle sync`)
  }))
connect.command('snapchat-ads').description('Read-only: daily spend and results by campaign. No audiences, creatives, people or pixel events.')
  .option('--account <id>', 'Snapchat ad account id from Ads Manager')
  .option('--client-id <id>', 'OAuth client id from Snap Business Manager')
  .option('--secret-env <name>', 'environment variable holding the OAuth client secret')
  .option('--refresh-token-env <name>', 'environment variable holding a refresh token with the snapchat-marketing-api scope')
  .action(write('connect snapchat-ads', async (opts) => {
    const r = await connectSnapchatAds(opts)
    emit(format(), r, () => `Connected to Snapchat ad account ${r.name || r.account} (${r.currency}, ${r.timezone}).${keyNote(r)}\nNext: lifecycle sync`)
  }))

const collectList = (v: string, prev: string[] = []) => [...prev, v]

// The store's key for scrambled customer ids: LIFECYCLE_SHOPIFY_CUSTOMER_KEY (the app and Cloud pass it), or this
// workspace's keychain entry, made on the first sync. With neither (no keychain, nothing passed), Shopify syncs in
// full each time as before 0.15.0 and no per-order state is kept. The key is never printed or logged.
export function storeKeyer(): Keyer | null {
  let key = getSecret('shopify-customer-key')
  if (!key && useKeychain()) {
    key = newCustomerKey()
    setSecret('shopify-customer-key', key)
  }
  return key ? keyer(key) : null
}

program.command('sync').description('Pull fresh totals from connected sources, then reconcile')
  .option('--since <date>', 'start of the Klaviyo report window')
  .option('--only <source>', `sync only this built-in source: ${NATIVE.join(', ')} (repeatable, or a comma list)`, collectList)
  .option('--cloud', 'start the sync on Cosmic Cloud instead of on this machine. It returns at once. Needs lifecycle login')
  .option('--export-wait <seconds>', 'for a large Shopify store, seconds to wait for its bulk export before leaving it for the next sync')
  .option('--full', 'for Shopify, read the whole order history now instead of only the orders changed since the last sync')
  .action(run(async (opts) => {
  if (opts.exportWait !== undefined && !(Number.isInteger(Number(opts.exportWait)) && Number(opts.exportWait) >= 0 && Number(opts.exportWait) <= 3600)) {
    throw new CliError('Use a whole number of seconds from 0 to 3600.', 'lifecycle sync --only shopify --export-wait 120', 'bad_value')
  }
  if (opts.cloud) {
    const client = new CloudClient()
    const only = parseOnly(opts.only)
    let r: { started: string[]; already_running: string[] }
    if (only) {
      const wanted = (await client.store()).connections.filter((c) => only.includes(c.source_id as (typeof only)[number]))
      if (!wanted.length) throw new CliError(`Not connected on Cosmic Cloud: ${only.join(', ')}.`, 'lifecycle sources list --cloud', 'not_connected')
      r = { started: [], already_running: [] }
      for (const c of wanted) {
        const one = await client.sync(c.id)
        r.started.push(...one.started)
        r.already_running.push(...one.already_running)
      }
    } else {
      r = await client.sync()
    }
    emit(format(), { cloud: true, started: r.started, alreadyRunning: r.already_running }, () => [`Cosmic Cloud started ${r.started.length} sync${r.started.length === 1 ? '' : 's'}${r.already_running.length ? `. ${r.already_running.length} already running` : ''}.`, 'It runs on Cloud and finishes on its own. Check it with: lifecycle logs --cloud'].join('\n'))
    return
  }
  await withWriteLock('sync', async () => {
  const config = readConfig()
  const only = parseOnly(opts.only)
  const shopifySecret = getSecret('shopify-client-secret')
  const key = getSecret('klaviyo-read-key')
  const ga4Secret = getSecret('ga4-client-secret')
  const ga4Refresh = getSecret('ga4-refresh-token')
  const stripeKey = getSecret('stripe-read-key')
  const metaToken = getSecret('meta-ads-token')
  const hubspotToken = getSecret('hubspot-token')
  const gadsSecret = getSecret('google-ads-client-secret')
  const gadsRefresh = getSecret('google-ads-refresh-token')
  const gmcSecret = getSecret('google-merchant-center-client-secret')
  const gmcRefresh = getSecret('google-merchant-center-refresh-token')
  const radsSecret = getSecret('reddit-ads-client-secret')
  const radsRefresh = getSecret('reddit-ads-refresh-token')
  const sadsSecret = getSecret('snapchat-ads-client-secret')
  const sadsRefresh = getSecret('snapchat-ads-refresh-token')
  const chosen = chooseSources(only, {
    shopify: Boolean(config.shopify && shopifySecret),
    klaviyo: Boolean(key),
    ga4: Boolean(config.ga4 && ga4Secret && ga4Refresh),
    stripe: Boolean(config.stripe && stripeKey),
    meta: Boolean(config.meta && metaToken),
    hubspot: Boolean(config.hubspot && hubspotToken),
    'google-ads': Boolean(config['google-ads'] && gadsSecret && gadsRefresh),
    'google-merchant-center': Boolean(config['google-merchant-center'] && gmcSecret && gmcRefresh),
    'reddit-ads': Boolean(config['reddit-ads'] && radsSecret && radsRefresh),
    'snapchat-ads': Boolean(config['snapchat-ads'] && sadsSecret && sadsRefresh),
  })
  if (!chosen.length) throw new CliError('No sources connected.', readWorkspace().type === 'shopify' ? 'lifecycle connect klaviyo --key-env NAME' : `lifecycle connect ${TYPES[readWorkspace().type].sources[0]}`, 'not_connected')
  const db = await openDb()
  try {
    await migrate(db)
    const results: SourceResult[] = []
    // Each source is its own run row, so one failing never hides another's result.
    for (const source of chosen) {
      if (source === 'shopify') {
        const { store, clientId } = config.shopify!
        let token: string | undefined
        const tok = async () => (token ??= await shopifyToken(store, clientId, shopifySecret!))
        // A big store goes through one bulk export, picked up across syncs, instead of one request per 250 orders.
        // When Shopify gives no exact count the export is used too, because the store may be large.
        // A failure here (a bad key, a missing scope) falls through to the paged path, which records it as this run's error.
        const total = await (async () => fetchOrderCount(store, await tok()))().catch(() => undefined)
        const minOrders = settingValue('shopify.bulk_min_orders')
        // 0.15.0: after the first full pull, a sync asks Shopify only for orders changed since the last one, and a
        // full pull runs again every shopify.full_check_days as a check. Without a store key it is full every time.
        const k = storeKeyer()
        const p = shopifyPlan(k ? await readSyncState(db) : null, k, { force: Boolean(opts.full), fullEveryDays: settingValue('shopify.full_check_days') })
        const changes = k ? {
          keyer: k,
          changed: async (since: string) => fetchOrders(store, await tok(), { query: changedSinceQuery(since) }),
          reportedCount: async () => fetchOrderCount(store, await tok()),
          overlapDays: settingValue('shopify.overlap_days'),
        } : null
        if (p.mode === 'incremental' && changes) {
          results.push(await syncShopifyChanges(db, changes))
        } else if (total !== undefined && (total === null || total >= minOrders)) {
          results.push(await syncShopifyBulk(db, {
            gql: shopifyGql(store, await tok()),
            reportedCount: async (before) => fetchOrderCount(store, await tok(), before ?? undefined),
            waitMs: (opts.exportWait !== undefined ? Number(opts.exportWait) : settingValue('shopify.export_wait_seconds')) * 1000,
            expected: total,
            keyer: k,
            // A weekly check on a store whose state is fine: the changed orders keep it fresh while the export builds.
            incremental: p.reason === 'weekly_check' && changes ? changes : undefined,
          }))
        } else {
          results.push(await syncShopify(db, async () => fetchOrders(store, await tok()), async () => fetchOrderCount(store, await tok()), { keyer: k }))
        }
        // Unit costs, once the owner has run lifecycle costs sync. Its own result line, so a cost failure never hides the orders.
        if ((config as { costs?: { shopify?: boolean } }).costs?.shopify) {
          const at = new Date().toISOString()
          try {
            const { orders, currency } = await fetchCostOrders(store, await tok())
            const w = await writeCosts(db, orders, currency ?? 'USD')
            results.push({ source: 'shopify_costs', status: 'ok', rows: w.days })
          } catch (e) {
            results.push({ source: 'shopify_costs', status: 'failed', rows: 0, detail: e instanceof Error ? e.message : String(e), code: e instanceof CliError ? e.code : 'error' })
          }
          await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status, rows_written, detail, code) VALUES ($1,'shopify_costs',$2,$3,$4,$5,$6,$7)`, [randomUUID(), at, new Date().toISOString(), results.at(-1)!.status, results.at(-1)!.rows, results.at(-1)!.detail ?? null, results.at(-1)!.code ?? null])
        }
      } else if (source === 'klaviyo') {
        results.push(await syncKlaviyo(db, new Klaviyo(key!), opts))
      } else if (source === 'ga4') {
        const { property, clientId } = config.ga4!
        const start = new Date(Date.now() - defaultDays() * 86400000).toISOString().slice(0, 10)
        const end = new Date().toISOString().slice(0, 10)
        results.push(await syncGa4(db, async () => fetchGa4Daily(property, await ga4AccessToken(clientId, ga4Secret!, ga4Refresh!), start, end)))
      } else if (source === 'stripe') {
        const stripe = new Stripe(stripeKey!)
        results.push(await syncStripe(db, { charges: () => stripe.charges(), subscriptions: () => stripe.subscriptions() }))
      } else if (source === 'hubspot') {
        const hs = new HubSpot(hubspotToken!)
        results.push(await syncHubspot(db, { deals: () => hs.deals(), contacts: () => hs.contacts(), total: (o) => hs.total(o) }, { currency: config.hubspot!.currency }))
      } else if (source === 'meta') {
        const meta = new MetaAds(metaToken!, config.meta!.account)
        results.push(await syncMeta(db, (since, until) => meta.insights(since, until), { currency: config.meta!.currency, account: config.meta!.account }))
      } else if (source === 'google-merchant-center') {
        const g = config['google-merchant-center']!
        let mc: MerchantCenter | undefined
        const api = async () => (mc ??= new MerchantCenter(await merchantAccessToken(g.clientId, gmcSecret!, gmcRefresh!), g.account))
        results.push(await syncMerchantCenter(db, { performance: async (s, u) => (await api()).performance(s, u), products: async () => (await api()).products() }, { account: g.account }))
      } else if (source === 'reddit-ads') {
        const r = config['reddit-ads']!
        let api: RedditAds | undefined
        const client = async () => (api ??= new RedditAds(await redditAccessToken(r.clientId, radsSecret!, radsRefresh!), r.account))
        results.push(await syncRedditAds(db, { names: async () => (await client()).campaignNames(), report: async (s, u) => (await client()).report(s, u, r.timezone) }, { account: r.account, currency: r.currency, timezone: r.timezone }))
      } else if (source === 'snapchat-ads') {
        const sc = config['snapchat-ads']!
        let api: SnapchatAds | undefined
        const client = async () => (api ??= new SnapchatAds(await snapAccessToken(sc.clientId, sadsSecret!, sadsRefresh!), sc.account))
        results.push(await syncSnapchatAds(db, { names: async () => (await client()).campaignNames(), stats: async (s, u) => (await client()).stats(s, u, sc.timezone) }, { account: sc.account, currency: sc.currency, timezone: sc.timezone }))
      } else {
        const g = config['google-ads']!
        let ads: GoogleAds | undefined
        const api = async () => (ads ??= new GoogleAds(await googleAdsAccessToken(g.clientId, gadsSecret!, gadsRefresh!), g.customer, g.loginCustomer))
        results.push(await syncGoogleAds(db, { campaigns: async (s, u) => (await api()).campaigns(s, u), adGroups: async (s, u) => (await api()).adGroups(s, u) }, { customer: g.customer, currency: g.currency }))
      }
    }
    const check = await reconcile(db)
    const failed = check.checks.filter((c) => c.status === 'fail')
    // One JSON document per command, so an agent can parse stdout whole.
    emit(format(), { results, reconcile: check }, () => [
      ...results.map((r) => `${r.source}: ${r.status}, ${r.rows} rows${r.detail ? `. ${r.detail}` : ''}${r.code ? ` (${r.code})` : ''}`),
      failed.length ? `Reconcile: ${failed.length} failed. Run lifecycle reconcile for details.` : 'Reconcile: passed.',
    ].join('\n'))
    if (results.some((r) => r.status === 'failed')) process.exitCode = 1
  } finally {
    await db.close()
  }
  })
}))

program.command('disconnect').argument('<source>', `${NATIVE.join(', ')}, or a warehouse source`)
  .description('Forget a source: its settings and saved keys. Loaded data is kept unless --delete-data')
  .option('--delete-data', 'also delete the data this source loaded')
  .action(write('disconnect', async (source: string, opts) => {
    if (!isNative(source)) {
      if (opts.deleteData) throw new CliError('--delete-data works for built-in sources only.', `lifecycle warehouse disconnect ${source}, then drop its schema yourself`, 'bad_value')
      const r = disconnectSource(source)
      emit(format(), { source, ...r }, () => `Disconnected ${source}. ${r.keysRemoved} key(s) removed. ${r.note}`)
      return
    }
    readConfig()
    const db = await openDb().catch((e) => {
      if (opts.deleteData) throw e
      return null
    })
    try {
      if (db) await migrate(db)
      const r = await disconnectNative(source, { deleteData: opts.deleteData, db })
      emit(format(), r, () => `Disconnected ${source}. ${r.keysRemoved.length} saved key(s) removed.${r.configRemoved ? ' Settings removed.' : ''} ${r.note}`)
    } finally {
      await db?.close()
    }
  }))

program.command('reconcile').description('Prove the numbers agree across sources').action(write('reconcile', async () => {
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

program.command('schema').argument('[table]').description('List tables and columns').option('--cloud', CLOUD_FLAG).action(run(async (table: string | undefined, opts) => {
  if (opts.cloud) {
    const all = await new CloudClient().schema()
    const schemas = table ? all.schemas.map((s) => ({ ...s, tables: s.tables.filter((t) => t.name === table || `${s.name}.${t.name}` === table) })).filter((s) => s.tables.length) : all.schemas
    if (table && !schemas.length) throw new CliError(`Cosmic Cloud has no table ${table}.`, 'lifecycle schema --cloud', 'unknown_table')
    emit(format(), { cloud: true, schemas }, () => schemas.flatMap((s) => s.tables.map((t) => `${s.name}.${t.name}${typeof t.rows === 'number' ? ` (${t.rows} rows)` : ''}\n${t.columns.map((c) => `  ${c.name} ${c.type}${c.personal ? ' (personal)' : ''}`).join('\n')}`)).join('\n\n') || 'Cosmic Cloud holds no tables yet. Start a sync: lifecycle sync --cloud')
    return
  }
  const db = await openDb()
  try {
    const known = [...PUBLIC_TABLES, ...(await customTables(db))]
    const names = table ? [table] : known
    if (table && !known.includes(table)) throw new CliError(`Unknown table ${table}.`, 'lifecycle schema')
    const out: Record<string, { column: string; type: string; personal: boolean; freeText: boolean }[]> = {}
    for (const n of names) {
      const rows = await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [n])
      out[n] = rows.map((r) => {
        const kind = classifyColumn({ table: n, column: String(r.column_name), type: String(r.data_type) })
        return { column: String(r.column_name), type: String(r.data_type), personal: kind === 'personal', freeText: kind === 'free_text' }
      })
    }
    emit(format(), out, () => Object.entries(out).map(([t, cols]) => `${t}\n${cols.map((c) => `  ${c.column} ${c.type}${c.personal ? ' (personal)' : ''}`).join('\n')}`).join('\n\n'))
  } finally {
    await db.close()
  }
}))

program.command('query').argument('<sql>').description('Run one read-only SQL query').option('--cloud', CLOUD_FLAG).action(run(async (sql: string, opts) => {
  if (opts.cloud) {
    // The same check as on this machine, so a write is refused before anything is sent.
    const r = await new CloudClient().query(assertReadOnlySql(sql))
    emit(format(), { cloud: true, ...r }, () => `${JSON.stringify(r.rows, null, 2)}\n${r.rowCount} rows${r.truncated ? ' (capped)' : ''}`)
    return
  }
  const db = await openDb()
  try {
    const r = await runQuery(db, sql)
    // Logging the query is a write. If a sync holds the store right now, skip the log, never the answer.
    const lock = tryWriteLock('query log')
    if (lock) {
      try {
        await recordCustomQuery(db, sql)
      } finally {
        lock()
      }
    }
    emit(format(), r, () => `${JSON.stringify(r.rows, null, 2)}\n${r.rowCount} rows${r.truncated ? ' (capped)' : ''}`)
  } finally {
    await db.close()
  }
}))

// Verified metrics: fixed SQL, so the same question gets the same answer every time.
const metrics = program.command('metrics').description('Verified metrics: the same SQL every time, with a trust line. Plus numbers of your own: metrics save')
metrics.command('list').description('List the verified metrics for this workspace type, then the numbers the owner saved').option('--pack <name>', `a metric pack: ${[...WORKSPACE_TYPES, 'all'].join(', ')}. Default: this workspace's type`).option('--cloud', CLOUD_FLAG).action(run(async (opts) => {
  if (opts.cloud) {
    const m = await new CloudClient().metrics()
    emit(format(), m, () => m.map((x) => (x.saved ? `${x.name}: ${x.title ?? x.name} (saved by the owner, not reviewed)` : `${x.name}: ${x.description ?? x.title ?? ''}${x.needs?.length ? ` (needs ${x.needs.join(', ')})` : ''}`)).join('\n') || 'Cosmic Cloud lists no metrics yet.')
    return
  }
  const db = await openIfSetUp()
  try {
    const m = await listAllMetrics(db, opts.pack ? assertPack(opts.pack) : undefined)
    emit(format(), m, () => m.map((x) => (x.saved ? `${x.name}: ${x.title} (saved by the owner, not reviewed)` : `${x.name}: ${x.description} (needs ${x.needs.join(', ')})`)).join('\n'))
  } finally {
    await db?.close()
  }
}))
metrics.command('show').argument('<name>').description('Show what a metric measures and its exact SQL').action(run(async (name: string) => {
  const db = await openIfSetUp()
  try {
    const m = await describeMetric(db, name)
    emit(format(), m, () => [`${m.title} (${m.name})${m.saved ? ', saved by the owner' : ''}`, m.description, `${m.needs.length ? `Needs: ${m.needs.join(', ')}. ` : ''}Unit: ${m.unit}.`, ...(m.saved ? [] : (m.notes ?? [])), ...(m.saved ? (m.notes ?? []).slice(1) : []), '', 'SQL ($1 is the first day of the window):', m.sql].join('\n'))
  } finally {
    await db?.close()
  }
}))
metrics.command('save').argument('<name>').description('Save a SELECT as a named number of your own. It runs read-only, with the trust line, and cannot take a built-in name')
  .requiredOption('--sql <select>', 'one SELECT returning one row, in single quotes. $1 is the first day of the window. The number is the column named value, or the first column')
  .option('--title <text>', 'a label for people')
  .option('--unit <unit>', UNITS.join(', '), 'count')
  .action(write('metrics save', async (name: string, opts) => {
    const db = await openDb()
    try {
      await migrate(db)
      const r = await saveMetric(db, name, opts)
      emit(format(), r, () => [`${r.replaced ? 'Replaced' : 'Saved'} ${r.name} (${r.unit}). It shows in lifecycle metrics list as saved by the owner.`, ...r.notes.slice(1), `Run it: lifecycle metrics run ${r.name}`].join('\n'))
    } finally {
      await db.close()
    }
  }))
metrics.command('delete').argument('<name>').description('Delete a saved number. Built-in metrics cannot be deleted').action(write('metrics delete', async (name: string) => {
  const db = await openDb()
  try {
    await migrate(db)
    const r = await deleteMetric(db, name)
    emit(format(), r, () => `Deleted ${r.name}.`)
  } finally {
    await db.close()
  }
}))
metrics.command('run').argument('<names...>').option('--days <n>', 'window in days (default: metrics.default_days, 90)').option('--cloud', CLOUD_FLAG)
  .option('--all-stores', 'add the metric up across every workspace on this machine, in one currency')
  .option('--stores <names>', 'add it up across these workspaces only, a comma list (default is the unnamed one)')
  .option('--currency <code>', 'currency for --all-stores or --stores. Default: the rollup.currency setting')
  .option('--rate-date <date>', 'exchange rate date, YYYY-MM-DD. Default: the latest rate')
  .option('--rate <CODE=RATE>', 'give a rate by hand: one CODE in the reporting currency (repeatable)', collectList)
  .description('Run one or more metrics').action(run(async (names: string[], opts) => {
  if (opts.allStores || opts.stores) {
    const days = opts.days === undefined ? defaultDays() : Number(opts.days)
    const stores = opts.allStores ? ('all' as const) : String(opts.stores).split(',').map((x: string) => x.trim()).filter(Boolean)
    const results: Awaited<ReturnType<typeof rollupMetric>>[] = []
    for (const n of names) results.push(await rollupMetric(n, { stores, currency: opts.currency, days, rateDate: opts.rateDate, rates: opts.rate }))
    const out = names.length === 1 ? results[0]! : { rollup: true, currency: results[0]!.currency, metrics: results }
    emit(format(), out, () => results.map((r) => [
      r.trust.line,
      `${r.title}, all stores, last ${r.days} days: ${r.total === null ? 'no value' : r.unit === 'usd' ? `${r.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${r.currency}` : formatValue(r.unit, r.total)}`,
      r.line,
      ...r.stores.map((x: any) => `  ${x.store}: ${x.status === 'ok' ? `${x.value} ${x.currency ?? ''}${x.rate && x.rate !== 1 ? ` / ${x.rate} = ${x.converted} ${r.currency}` : ''}` : x.detail ?? x.status}`),
      ...r.notes,
    ].join('\n')).join('\n\n'))
    if (results.some((r) => r.stores.some((x: any) => x.status !== 'ok'))) process.exitCode = 1
    return
  }
  if (opts.cloud) {
    const client = new CloudClient()
    const days = opts.days === undefined ? undefined : Number(opts.days)
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 730)) throw new CliError('Use a whole number of days from 1 to 730.', `lifecycle metrics run ${names[0]} --days 30 --cloud`, 'bad_value')
    const results: Record<string, any>[] = []
    for (const n of names) results.push(await client.metric(n, days))
    const trust = results[0]!.trust ?? null
    emit(format(), names.length === 1 ? results[0]! : { metrics: results, trust }, () => [
      trust?.line ?? 'Cosmic Cloud sent no trust line. Treat these numbers as unchecked.',
      ...results.map((r) => `${r.title ?? r.metric ?? r.name}${r.saved ? ' (saved by the owner)' : ''}, last ${r.days} days: ${r.value === null || r.value === undefined ? 'no data' : formatValue(r.unit, r.value)}${r.detail ? `. ${r.detail}` : ''}`),
      ...[...new Set(results.flatMap((r) => (Array.isArray(r.notes) ? r.notes : [])))],
    ].join('\n'))
    return
  }
  const db = await openDb()
  try {
    const days = opts.days === undefined ? defaultDays() : Number(opts.days)
    const results: Awaited<ReturnType<typeof runMetric>>[] = []
    for (const n of names) results.push(await runMetric(db, n, days))
    const out = names.length === 1 ? results[0]! : { metrics: results, trust: results[0]!.trust }
    emit(format(), out, () => [
      results[0]!.trust.line,
      ...results.map((r) => `${r.title}${r.saved ? ' (saved by the owner)' : ''}, last ${r.days} days: ${formatValue(r.unit, r.value)}${r.detail ? `. ${r.detail}` : ''}`),
      ...[...new Set(results.flatMap((r) => r.notes))],
    ].join('\n'))
  } finally {
    await db.close()
  }
}))

metrics.command('candidates').description('Custom queries run more than once: candidates for a new verified metric').option('--min-runs <n>', 'only queries run at least this often', '2').action(run(async (opts) => {
  const db = await openDb()
  try {
    await migrateIfFree(db, 'metrics candidates')
    const c = await metricCandidates(db, Number(opts.minRuns))
    emit(format(), c, () => (c.length ? [...c.map((x) => `${x.runs} runs  ${x.sql}`), '', 'To ask for one as a verified metric: lifecycle feedback "metric request: ..."'].join('\n') : 'No repeated custom queries yet.'))
  } finally {
    await db.close()
  }
}))

// Costs for contribution margin: the owner's own rates, plus Shopify unit costs.
const costs = program.command('costs').description('Cost inputs for contribution margin, in costs.json, the file the Cosmic AI app writes: cost of goods, shipping, payment fees and ad spend')
costs.command('show').description('The cost inputs in costs.json, and how much of Shopify the cost sync has read').action(run(async () => {
  const c = readCosts()
  const db = await openDb()
  try {
    await migrateIfFree(db, 'costs show')
    const cov = (await db.query(`SELECT count(*)::int AS days, coalesce(sum(lines), 0)::int AS lines, coalesce(sum(lines_with_cost), 0)::int AS costed, max(source_synced_at) AS at FROM fact_cogs_daily`))[0] ?? {}
    const out = { file: costsPath(), costs: c, shopifyCosts: { days: Number(cov.days ?? 0), lines: Number(cov.lines ?? 0), linesWithCost: Number(cov.costed ?? 0), syncedAt: cov.at ? new Date(String(cov.at)).toISOString() : null } }
    emit(format(), out, () => [c ? JSON.stringify(c, null, 2) : 'No costs set. Start with: lifecycle costs set currency USD', out.shopifyCosts.days ? `Shopify product costs: ${out.shopifyCosts.linesWithCost} of ${out.shopifyCosts.lines} line items, synced ${clock(out.shopifyCosts.syncedAt)}` : 'Shopify product costs: not synced. lifecycle costs sync'].join('\n'))
  } finally {
    await db.close()
  }
}))
costs.command('set').argument('<key>', COST_KEYS.join(', ')).argument('<value>', 'such as USD, shopify, percent:35, per_order:6.50, none, 2.9, meta').description('Set one cost input in costs.json, the same file the Cosmic AI app writes').action(run(async (key: string, value: string) => {
  const c = setCost(key, value)
  emit(format(), c, () => `Saved ${key}. lifecycle costs show prints them all.`)
}))
costs.command('products').argument('<csv>', 'a CSV of sku,unit_cost').option('--fallback <percent>', 'cost of goods for SKUs not in the file, as a percent of their revenue').description('Use your own cost per product instead of Shopify\'s').action(run(async (file: string, opts) => {
  const c = setProductCosts(readFileSync(file, 'utf8'), opts.fallback)
  emit(format(), c, () => `Saved ${c.cogs.mode === 'per_product' ? c.cogs.items.length : 0} product costs. Run lifecycle costs sync so sales by SKU are read.`)
}))
costs.command('sync').description('Read each line item\'s unit cost from Shopify. Needs read_inventory and read_products on the app. After the first one, lifecycle sync does it too').action(write('costs sync', async () => {
  const config = readConfig()
  const secret = getSecret('shopify-client-secret')
  if (!config.shopify || !secret) throw new CliError('Shopify is not connected.', 'lifecycle connect shopify', 'not_connected')
  const db = await openDb()
  try {
    await migrate(db)
    const token = await shopifyToken(config.shopify.store, config.shopify.clientId, secret)
    const { orders, currency } = await fetchCostOrders(config.shopify.store, token)
    const r = await writeCosts(db, orders, currency ?? 'USD')
    writeConfig({ ...readConfig(), costs: { shopify: true } } as never)
    emit(format(), { ...r, currency }, () => [`Read unit costs for ${r.linesWithCost} of ${r.lines} line items over ${r.days} days (${currency ?? 'currency unknown'}).`, r.truncatedOrders ? `${r.truncatedOrders} orders have more than 100 line items; lines past the first 100 are not counted.` : '', r.coveragePct !== null && r.coveragePct < 100 ? 'Lines with no unit cost use cogs_percent: lifecycle costs set cogs_percent 35' : '', 'Next: lifecycle metrics run contribution_margin'].filter(Boolean).join('\n'))
  } finally {
    await db.close()
  }
}))

const sources = program.command('sources').description('What can be connected, and what is connected')
sources
  .command('catalog')
  .description('Every source: the built-in four, warehouse connectors, and what is planned')
  .option('--query <text>', 'search by name, slug or category')
  .option('--category <name>', 'only one category, such as reviews or helpdesk')
  .option('--readiness <level>', 'native, tested, built or planned')
  .option('--type <type>', `only the sources a workspace of this type usually connects: ${WORKSPACE_TYPES.join(', ')}`)
  .action(run(async (opts) => {
    const typeSources = opts.type ? TYPES[assertType(opts.type)].sources : null
    const warehouse = searchCatalog(opts).filter((s) => s.readiness !== 'native' && (!typeSources || typeSources.includes(s.slug)))
    const nativeAll = readWorkspace().type === 'shopify' && !opts.type ? CATALOG : ALL_NATIVE
    const native = opts.query || opts.category || (opts.readiness && opts.readiness !== 'native') ? [] : nativeAll.filter((s) => !typeSources || typeSources.includes(s.slug))
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
sources.command('list').description('Which sources are connected, and when each last synced').option('--cloud', CLOUD_FLAG).action(run(async (opts) => {
  if (opts.cloud) {
    const r = (await new CloudClient().store()).connections.map((c) => ({ slug: c.source_id, name: c.source_name ?? c.source_id, connected: true, lastSync: c.last_success_at ?? null, lastStatus: c.status ?? null, statusCode: c.status_code ?? null, freshness: c.freshness ?? null, nextSync: c.next_sync_at ?? null, next: null }))
    emit(format(), r, () => r.map((s) => `connected     ${s.name}, last good sync ${clock(s.lastSync)} (${s.lastStatus ?? 'unknown'}${s.statusCode ? `, ${s.statusCode}` : ''})`).join('\n') || 'No sources are connected on Cosmic Cloud yet.')
    return
  }
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
report.command('revenue-per-flow').option('--days <n>', 'window in days (default: metrics.default_days, 90)').option('--html <file>', 'also write an HTML report').action(run(async (opts) => {
  const db = await openDb()
  try {
    await migrateIfFree(db, 'report')
    const r = await revenuePerFlow(db, opts.days === undefined ? defaultDays() : Number(opts.days))
    if (opts.html) { const html = revenueHtml(r); writeHtml(opts.html, html); saveArtifact(basename(opts.html), html) }
    emit(format(), r, () => [r.trust.line, ...r.flows.map((f) => `${f.name}: ${f.recipients} recipients, $${f.revenue}, $${f.revenuePerRecipient} per recipient`), r.flows.length ? '' : 'No flow data yet.', ...r.notes].join('\n'))
  } finally {
    await db.close()
  }
}))

program.command('audit').description('Find what to fix').command('flows').option('--html <file>', 'also write an HTML report').action(run(async (opts) => {
  const db = await openDb()
  try {
    await migrateIfFree(db, 'audit')
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
    await migrateIfFree(db, 'segments propose')
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
withRegistry(kits.command('list').description('List kits in the registry').option('--type <type>', `only kits for this workspace type: ${WORKSPACE_TYPES.join(', ')}`)).action(run(async (opts) => {
  const reg = registry(opts)
  const k = listKits(reg, opts.type ? assertType(opts.type) : undefined)
  const store = readWorkspace().type === 'shopify' && !opts.type
  emit(format(), { source: reg.source, kits: k }, () => k.map((x) => `${x.name} ${x.version}: ${x.summary}${store ? '' : ` (for ${x.types.join(', ')})`}`).join('\n') || `No kits for ${opts.type} yet. lifecycle kits list shows them all.`)
}))
withRegistry(kits.command('search').argument('<query>').description('Find kits by name, keyword or summary')).action(run(async (query: string, opts) => {
  const k = searchKits(registry(opts), query)
  emit(format(), k, () => (k.length ? k.map((x) => `${x.name} ${x.version}: ${x.summary}`).join('\n') : `No kits match "${query}". Try lifecycle kits list`))
}))
withRegistry(kits.command('show').argument('<name>').description("Show a kit's README, needs and secrets before adding it")).action(run(async (name: string, opts) => {
  const r = showKit(registry(opts), name)
  const m = r.manifest
  const prompt = kitPrompt(m)
  emit(format(), { ...r, prompt }, () => [r.readme.trim(), '', `Version: ${m.version}`, `Needs: ${m.needs.join(', ')}`, `Writes: ${m.writes}`, `Secrets: ${m.secrets.map((s) => `${s.name}${s.required ? '' : ' (optional)'}`).join(', ') || 'none'}`, `Files (${r.files.length}):`, ...r.files.map((f) => `  ${f}`), '', `Add it: lifecycle kits add ${m.name}`, '', 'Or paste this into your agent:', prompt].join('\n'))
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
const skills = program.command('skills').description('Install kit skills into Claude Code and Cursor, and keep the workspace\'s own skills on Cosmic Cloud')
withRegistry(skills.command('sync').description('Install or update /lifecycle and one /lifecycle:kits:<kit> skill per kit. When logged in to Cosmic Cloud, also the workspace\'s own skills'))
  .option('--target <target>', 'claude, cursor or all. Default: claude, plus cursor when it is installed')
  .option('--dry-run', 'show what would change')
  .option('--force', 'overwrite files you edited')
  .action(run(async (opts) => {
    // The store's own skills come from Cosmic Cloud. If Cloud cannot be asked, kits still sync and
    // store skills already installed are left alone.
    let account: Record<string, string> | undefined
    let info: { status: 'ok' | 'not_logged_in' | 'not_built' | 'failed'; skills: string[]; skipped: string[]; code?: string } = { status: 'not_logged_in', skills: [], skipped: [] }
    if (loggedIn()) {
      try {
        const a = accountSkillFiles(await new CloudClient().skillsWithFiles())
        account = a.files
        info = { status: 'ok', skills: a.installed, skipped: a.skipped }
      } catch (e) {
        info = { status: isNotBuilt(e) ? 'not_built' : 'failed', skills: [], skipped: [], code: e instanceof CliError ? e.code : 'error' }
        console.error(`Warning: the store's own skills were not synced. ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const r = syncSkills(registry(opts), { targets: targets(opts.target), dryRun: opts.dryRun, force: opts.force, account }).map((t) => ({ ...t, account: info }))
    emit(format(), r, () => r.map((t) => [`${t.target}: ${t.dir}`, `  ${opts.dryRun ? 'would write' : 'wrote'} ${t.written.length}, unchanged ${t.unchanged.length}, removed ${t.removed.length}`, ...t.kept.map((k) => `  kept your edit: ${k}`)].join('\n')).join('\n') + (info.status === 'ok' ? `\nStore skills from Cosmic Cloud: ${info.skills.join(', ') || 'none'}${info.skipped.length ? `. Skipped as unsafe: ${info.skipped.join(', ')}` : ''}` : '') + (opts.dryRun ? '\nNothing was written.' : '\nRestart Claude Code to load new skills.'))
  }))
skills.command('push').argument('<directory>', 'a folder with a SKILL.md at the top').option('--slug <name>', 'name to store it under. Default: the folder name')
  .description('Save a skill folder to this workspace on Cosmic Cloud. At most 200 KB of text files. A file that looks like it holds a key is refused')
  .action(run(async (dir: string, opts) => {
    const s = readSkillDir(dir, opts.slug)
    await new CloudClient().putSkill(s.slug, s.files)
    emit(format(), { slug: s.slug, pushed: true, files: s.files.map((f) => f.path), bytes: s.bytes }, () => `Pushed ${s.slug} to Cosmic Cloud: ${s.files.length} file${s.files.length === 1 ? '' : 's'}, ${Math.ceil(s.bytes / 1024)} KB.\nInstall it on a machine with: lifecycle skills sync`)
  }))
skills.command('delete').argument('<slug>').description('Delete one of the workspace\'s own skills from Cosmic Cloud').action(run(async (slug: string) => {
  assertSlug(slug)
  const client = new CloudClient()
  // Listing first tells "no such skill" apart from "Cloud does not have skills yet".
  if (!(await client.skills()).some((x) => x.slug === slug)) throw new CliError(`This workspace has no skill named ${slug} on Cosmic Cloud.`, 'lifecycle skills status', 'unknown_skill')
  await client.deleteSkill(slug)
  emit(format(), { slug, deleted: true }, () => `Deleted ${slug} from Cosmic Cloud.\nCopies installed on a machine are removed by its next lifecycle skills sync.`)
}))
withRegistry(skills.command('status').description('Show installed skills and kits not installed yet. When logged in to Cosmic Cloud, also the workspace\'s own skills there')).action(run(async (opts) => {
  // What the store keeps on Cosmic Cloud, beside what is installed here. Status never fails because Cloud did.
  let onCloud: { status: 'ok' | 'not_logged_in' | 'not_built' | 'failed'; skills: string[] } = { status: 'not_logged_in', skills: [] }
  if (loggedIn()) {
    try {
      onCloud = { status: 'ok', skills: (await new CloudClient().skills()).map((x) => clean(String(x.slug), 63)) }
    } catch (e) {
      onCloud = { status: isNotBuilt(e) ? 'not_built' : 'failed', skills: [] }
    }
  }
  const r = skillsStatus(registry(opts)).map((t) => ({ ...t, account: onCloud }))
  emit(format(), r, () => (onCloud.status === 'ok' ? `On Cosmic Cloud: ${onCloud.skills.join(', ') || 'no workspace skills'}\n` : '') + r.map((t) => `${t.target}: ${t.installed ? `installed (${t.installedVersion}), kits: ${t.kits.join(', ') || 'none'}${t.storeSkills.length ? `, store skills: ${t.storeSkills.join(', ')}` : ''}` : 'not installed'}${t.installed && t.newKits.length ? `\n  new: ${t.newKits.join(', ')}. Run lifecycle skills sync` : ''}`).join('\n'))
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
  const names = { LIFECYCLE_DATABASE_URL: 'database-url', LIFECYCLE_KLAVIYO_READ_KEY: 'klaviyo-read-key', LIFECYCLE_SHOPIFY_CLIENT_SECRET: 'shopify-client-secret', LIFECYCLE_SHOPIFY_CUSTOMER_KEY: 'shopify-customer-key', LIFECYCLE_GA4_CLIENT_SECRET: 'ga4-client-secret', LIFECYCLE_GA4_REFRESH_TOKEN: 'ga4-refresh-token', LIFECYCLE_STRIPE_READ_KEY: 'stripe-read-key', LIFECYCLE_META_ADS_TOKEN: 'meta-ads-token', LIFECYCLE_HUBSPOT_TOKEN: 'hubspot-token', LIFECYCLE_GOOGLE_ADS_CLIENT_SECRET: 'google-ads-client-secret', LIFECYCLE_GOOGLE_ADS_REFRESH_TOKEN: 'google-ads-refresh-token', LIFECYCLE_GOOGLE_MERCHANT_CENTER_CLIENT_SECRET: 'google-merchant-center-client-secret', LIFECYCLE_GOOGLE_MERCHANT_CENTER_REFRESH_TOKEN: 'google-merchant-center-refresh-token', LIFECYCLE_REDDIT_ADS_CLIENT_SECRET: 'reddit-ads-client-secret', LIFECYCLE_REDDIT_ADS_REFRESH_TOKEN: 'reddit-ads-refresh-token', LIFECYCLE_SNAPCHAT_ADS_CLIENT_SECRET: 'snapchat-ads-client-secret', LIFECYCLE_SNAPCHAT_ADS_REFRESH_TOKEN: 'snapchat-ads-refresh-token' } as const
  const secrets: Record<string, string> = {}
  // The daily sync in GitHub Actions uses the same store key as this machine, so both keep the same scrambled ids.
  if (plan.secrets.includes('LIFECYCLE_SHOPIFY_CUSTOMER_KEY')) storeKeyer()
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

// The daily sync in GitHub Actions.
const jobs = program.command('jobs').description('The daily sync running in your GitHub account')
jobs.command('list').description('Recent runs of the daily sync, and the current success streak').option('--repo <owner/name>').option('--limit <n>', 'runs to show', '7').action(run(async (opts) => {
  const r = deployStatus(opts.repo ?? readConfig().deploy?.repo, Number(opts.limit))
  emit(format(), r, () => [`${r.repo}: ${r.successStreak} successful run${r.successStreak === 1 ? '' : 's'} in a row`, ...r.runs.map((x) => `  ${x.createdAt.slice(0, 16).replace('T', ' ')}  ${x.conclusion ?? x.status}  (${x.event})`)].join('\n'))
}))
jobs.command('run').description('Start the daily sync now').option('--repo <owner/name>').action(run(async (opts) => {
  const r = deployRun(opts.repo ?? readConfig().deploy?.repo)
  emit(format(), r, () => `Started a sync in ${r.repo}. Check it with lifecycle jobs list`)
}))

program.command('logs').description('Recent sync runs on this machine. --cloud shows the runs on Cosmic Cloud, --actions the last GitHub Actions log, --follow waits for a running one')
  .option('--cloud', 'recent sync runs on Cosmic Cloud. When not logged in, the same as --actions, as before 0.13.0')
  .option('--actions', 'show the log of the last daily sync in GitHub Actions')
  .option('--follow', 'wait for the daily sync that is running in GitHub Actions to finish, then show its log')
  .option('--limit <n>', 'runs to show', '10')
  .option('--repo <owner/name>')
  .action(run(async (opts) => {
    let followed: Awaited<ReturnType<typeof followRun>> | undefined
    if (opts.follow) {
      const repo = opts.repo ?? readConfig().deploy?.repo
      const text = format() === 'text'
      followed = await followRun(() => deployStatus(repo, 1).runs[0], (id) => deployRunById(repo, id), (r) => { if (text) console.error(`${new Date().toISOString().slice(11, 19)}  ${r.conclusion ?? r.status}`) })
      if (followed.conclusion !== 'success') process.exitCode = 1
    }
    if (opts.cloud && !opts.follow && !opts.actions && !opts.repo && loggedIn()) {
      const limit = Number(opts.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new CliError('Use a limit from 1 to 200.', 'lifecycle logs --cloud --limit 20', 'bad_value')
      const runs = (await new CloudClient().runs(limit)).map((r) => ({ source: String(r.source_id ?? r.source ?? ''), status: String(r.status ?? ''), rows: Number(r.rows ?? 0), startedAt: r.started_at ?? null, finishedAt: r.finished_at ?? null, detail: null, code: r.code ?? null }))
      emit(format(), runs, () => (runs.length ? runs.map((r) => `${clock(r.startedAt)}  ${r.source.padEnd(8)} ${r.status.padEnd(8)} ${r.rows} rows${r.code ? ` (${r.code})` : ''}`).join('\n') : 'Nothing has synced on Cosmic Cloud yet. Start one: lifecycle sync --cloud'))
      return
    }
    if (opts.cloud && !opts.actions && !opts.follow && !opts.repo && format() === 'text') console.error('Not logged in to Cosmic Cloud, so this is the GitHub Actions log. Its own flag is now --actions.')
    if (opts.cloud || opts.actions || opts.follow) {
      const r = deployLogs(opts.repo ?? readConfig().deploy?.repo, 60, followed)
      emit(format(), r, () => `${r.run.url}\n${r.log}`)
      return
    }
    const db = await openDb()
    try {
      await migrateIfFree(db, 'logs')
      const rows = await db.query(`SELECT source, status, rows_written, started_at, finished_at, detail, code FROM meta_sync_run ORDER BY started_at DESC LIMIT $1`, [Number(opts.limit)])
      const runs = rows.map((r) => ({ source: String(r.source), status: String(r.status), rows: Number(r.rows_written), startedAt: new Date(String(r.started_at)).toISOString(), detail: r.detail ? String(r.detail) : null, code: r.code ? String(r.code) : null }))
      emit(format(), runs, () => (runs.length ? runs.map((r) => `${r.startedAt.slice(0, 16).replace('T', ' ')}  ${r.source.padEnd(8)} ${r.status.padEnd(8)} ${r.rows} rows${r.detail ? `  ${r.detail}` : ''}${r.code ? ` (${r.code})` : ''}`).join('\n') : 'Nothing synced yet. Run lifecycle sync'))
    } finally {
      await db.close()
    }
  }))

const configCmd = program.command('config').description('Settings, such as reconcile tolerances, the query row cap and the default window. lifecycle config list shows them all')
configCmd.command('list').action(run(async () => {
  const s = listSettings()
  emit(format(), s, () => s.map((x) => `${x.key} = ${x.value ?? (x.default !== null ? `${x.default} (default)` : '(not set)')}    ${x.description}`).join('\n'))
}))
configCmd.command('get').argument('<key>').action(run(async (key: string) => {
  const set = getSetting(key)
  const d = defaultOf(key as SettingKey) ?? null
  const value = set ?? d
  emit(format(), { key, value, default: d, isDefault: set === undefined && d !== null }, () => (value === null ? '(not set)' : `${value}${set === undefined && d !== null ? ' (default)' : ''}`))
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
  .option('--days <n>', 'window in days (default: metrics.default_days, 90)')
  .action(run(async (opts) => {
    const db = await openDb()
    try {
      const d = await buildDashboard(db, opts.days === undefined ? defaultDays() : Number(opts.days))
      const html = dashboardHtml(d)
      writeHtml(opts.html, html)
      saveArtifact(basename(opts.html), html)
      emit(format(), { ...d, file: opts.html }, () => `${d.trust.line}\nWrote ${opts.html}. It stays on this machine.`)
    } finally {
      await db.close()
    }
  }))

// Tools: read-only Klaviyo and Shopify calls on your own keys. No credits, no middleman.
// When logged in to Cosmic Cloud, each run's record (never its output, never a key) is also sent there.
// That is best effort: whatever happens to it, the run itself is not affected.
const postRunToCloud = async (r: ToolRun): Promise<{ posted: boolean; code?: string } | undefined> => {
  try {
    if (!loggedIn()) return undefined
    await new CloudClient().postToolRun(cloudRunRecord(r))
    return { posted: true }
  } catch (e) {
    return { posted: false, code: e instanceof CliError ? e.code : 'error' }
  }
}
const withCloud = (r: ToolRun, c: Awaited<ReturnType<typeof postRunToCloud>>) => (c ? { ...r, cloud: c } : r)
const tools = program.command('tools').description('Read-only Klaviyo and Shopify tools, plus any Kie, fal, Apify or ScrapeCreators ref, all on your own keys')
tools.command('catalog').option('--query <text>', 'only tools whose id or description contains this').description('List the built-in tools and their inputs').action(run(async (opts) => {
  const q = String(opts.query ?? '').toLowerCase()
  const c = toolCatalog().filter((t) => !q || `${t.id} ${t.description}`.toLowerCase().includes(q))
  const note = 'Not limited to this list: any kie:, fal:, apify: or scrapecreators: ref also runs. See lifecycle tools providers'
  emit(format(), c, () => [...(c.length ? c.map((t) => `${t.id}${t.input.length ? ` (${t.input.join(', ')})` : ''}\n  ${t.description}`) : [`No built-in tool matches "${opts.query}".`]), note].join('\n'))
}))
tools.command('providers').description('The four open providers: ref shape, where ids are listed, which key each needs').action(run(async () => {
  const p = openProviders()
  emit(format(), p, () => p.map((x) => `${x.ref}  ${x.connected ? 'key set' : `no key. lifecycle secrets set ${x.secret} --from-env YOUR_VAR`}\n  Example: ${x.example}\n  Ids: ${x.catalog}\n  ${x.billing}`).join('\n'))
}))
tools.command('run').argument('<tool>', 'a built-in tool id, or kie:<model>, fal:<endpoint_id>, apify:<owner~actor>, scrapecreators:<path>')
  .option('--input <json>', 'tool input as JSON', '{}')
  .option('--body <json>', 'same as --input')
  .option('--wait', 'for a provider ref, wait until the job finishes')
  .option('--timeout <seconds>', 'how long --wait waits', '300')
  .option('--method <method>', 'for scrapecreators: GET or POST', 'GET')
  .option('--out <file>', 'write the output to a file')
  .description('Run a tool and save the result').action(run(async (id: string, opts) => {
    let input: unknown
    try {
      input = JSON.parse(opts.body ?? opts.input)
    } catch {
      throw new CliError('--input is not valid JSON.', `lifecycle tools run ${id} --input '{"start":"2026-10-01","end":"2026-10-31"}'`, 'bad_input')
    }
    let r: ToolRun
    if (parseRef(id)) {
      const ctx = defaultOpenContext()
      r = await startOpenTool(id, input, ctx, { method: opts.method })
      if (opts.wait) r = await waitForRun(r, ctx, { timeoutMs: Number(opts.timeout) * 1000 })
    } else {
      r = await runTool(id, input, defaultToolContext())
    }
    if (opts.out && r.status === 'succeeded') writeHtml(opts.out, JSON.stringify(r.output ?? null, null, 2))
    emit(format(), withCloud(r, await postRunToCloud(r)), () => {
      if (r.status === 'failed') return `Run ${r.id} failed: ${r.error}`
      if (r.status === 'running') return opts.wait
        ? `Run ${r.id} is still going after ${opts.timeout} seconds. It was not stopped and it is still billing.\nDo not run it again. Check it with: lifecycle tools get ${r.id}`
        : `Started run ${r.id} on ${r.provider}. Check it with: lifecycle tools get ${r.id}`
      return [opts.out ? `Wrote the output to ${opts.out}` : JSON.stringify(r.output, null, 2), costLine(r), `Run ${r.id} saved. lifecycle tools get ${r.id}`].filter(Boolean).join('\n')
    })
    if (r.status === 'failed') process.exitCode = 1
  }))
tools.command('get').argument('<run>').option('--out <file>', 'write the output to a file').description('Print a saved run with the request that was sent, or write its output to a file. A run that is still going is checked first').action(run(async (id: string, opts) => {
  let r = getRun(id)
  const was = r.status
  if (r.status === 'running') r = await refreshRun(r, defaultOpenContext())
  if (opts.out && r.status === 'succeeded') writeHtml(opts.out, JSON.stringify(r.output ?? null, null, 2))
  // Cloud saw this run as running. Tell it how the run ended.
  const sent = r.status !== was ? await postRunToCloud(r) : undefined
  emit(format(), withCloud(r, sent), () => (r.status === 'running' ? `Run ${r.id} is still going on ${r.provider}. Ask again in a moment.` : opts.out && r.status === 'succeeded' ? [`Wrote run ${r.id} output to ${opts.out}`, costLine(r)].filter(Boolean).join('\n') : JSON.stringify(r, null, 2)))
}))
tools.command('abort').argument('<run>').description('Ask the provider to stop a run that is still going. Works for Apify and fal. Work already done may still be billed').action(run(async (id: string) => {
  const a = await abortRun(getRun(id), defaultOpenContext())
  const sent = await postRunToCloud(a.run)
  emit(format(), { ...withCloud(a.run, sent), aborted: a.aborted }, () => (a.aborted ? `Stopped run ${a.run.id} on ${a.run.provider}. ${a.run.error}` : `Run ${a.run.id} had already ${a.run.status === 'succeeded' ? 'finished' : a.run.status}. Nothing was stopped. lifecycle tools get ${a.run.id}`))
}))
tools.command('runs').option('--limit <n>', 'runs to show', '20').description('Recent tool runs').action(run(async (opts) => {
  const r = listRuns(Number(opts.limit))
  emit(format(), r, () => (r.length ? r.map((x) => `${x.id}  ${x.startedAt.slice(0, 16).replace('T', ' ')}  ${x.status.padEnd(9)} ${x.tool}`).join('\n') : 'No tool runs yet.'))
}))

// Exec: runs any command with your keys in its environment,
// so a script or agent can use them without the keys ever being printed or pasted.
program.command('exec').argument('<command...>').description('Run a command with your Lifecycle keys and settings in its environment').allowUnknownOption().action(run(async (command: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const provided: string[] = []
  for (const name of ALL_SECRETS) {
    // The Cosmic Cloud token signs in as the store. A script gets the source keys. This one is not added.
    if (name === 'cloud-token') continue
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

// Files: every report, dashboard and plan, kept by date.
const files = program.command('files').description('Reports, dashboards and plans this CLI has written, plus the daily cloud dashboard')
files.command('ls').argument('[path]', 'folder inside the workspace files, such as cloud or a date', '').action(run(async (path: string) => {
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
files.command('put').argument('<file>').argument('[name]').description('Keep a local file with the workspace files, under today').action(run(async (file: string, name?: string) => {
  const path = putFile(file, name)
  emit(format(), { path }, () => `Stored as ${path}`)
}))
files.command('path').description('Print where the workspace files live').action(run(async () => {
  emit(format(), { dir: filesDir() }, () => filesDir())
}))
files.command('pull').option('--repo <owner/name>').description('Download the dashboard from the latest successful daily sync').action(run(async (opts) => {
  const r = pullCloud(opts.repo ?? readConfig().deploy?.repo)
  emit(format(), r, () => `Pulled run ${r.run} (${r.createdAt}):\n${r.files.map((f) => `  ${f}`).join('\n')}`)
}))

sources.command('import').argument('<name>').requiredOption('--csv <file>', 'CSV of daily totals').option('--date-column <name>', 'the date column', 'date').description('Import daily totals from any other tool as a custom source').action(write('sources import', async (name: string, opts) => {
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
  .option('--set <name=value>', 'a setting such as your shop domain or subdomain (repeatable)', collect)
  .option('--keep-personal-data', 'also load emails, names, phones and addresses. Off by default')
  .option('--skip-check', 'save without calling the API first')
  .action(write('warehouse connect', async (slug: string, opts) => {
    const r = await connectSource(slug, opts)
    emit(format(), r, () => `Connected ${slug}. Check: ${typeof r.check === 'string' ? r.check : `${r.check.rows} rows from ${r.check.resource}`}. Personal data: ${r.personalData}.\nNext: ${r.next}`)
  }))

warehouse.command('disconnect').argument('<slug>').description('Forget a source and its keys. Loaded data is kept').action(write('warehouse disconnect', async (slug: string) => {
  const r = disconnectSource(slug)
  emit(format(), r, () => `Disconnected ${slug}. ${r.keysRemoved} key(s) removed. ${r.note}`)
}))

warehouse.command('list').description('Connected warehouse sources').action(run(async () => {
  const list = connectedSources(readConfig()).map((c) => ({ ...c, schema: datasetFor(c.slug), name: findSource(c.slug).name }))
  emit(format(), list, () => list.length ? list.map((c) => `${c.name} (${c.slug}) -> ${c.schema}, personal data ${c.personalData === 'keep' ? 'kept' : 'removed'}, connected ${c.connectedAt.slice(0, 10)}`).join('\n') : 'No warehouse sources connected. See lifecycle sources catalog')
}))

warehouse.command('sync').argument('[slugs...]').description('Load fresh data from connected warehouse sources').option('--verbose', 'show the loader log').action(write('warehouse sync', async (slugs: string[], opts) => {
  const config = readConfig()
  const db = await openDb()
  try {
    await migrate(db)
    const record = async (r: WarehouseSyncResult, startedAt: string) => {
      await db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status, rows_written, detail, code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), r.source, startedAt, new Date().toISOString(), r.status, r.rows, r.detail ?? null, r.code ?? null])
    }
    const results = await syncSources(slugs, { verbose: opts.verbose, record })
    const failed = results.filter((r) => r.status === 'failed')
    if (failed.length) process.exitCode = 1
    emit(format(), { database: config.database.kind, results }, () => results.map((r) => r.status === 'ok' ? `ok      ${r.source}: ${r.rows} rows${r.tables ? ` (${Object.entries(r.tables).map(([t, n]) => `${t} ${n}`).join(', ')})` : ''}` : `failed  ${r.source}: ${r.detail}${r.code ? ` (${r.code})` : ''}`).join('\n'))
  } finally {
    await db.close()
  }
}))

warehouse.command('schema').argument('[slug]').description('Tables and columns the warehouse holds, each column marked personal or not').action(run(async (slug?: string) => {
  const config = readConfig()
  let cols: SchemaColumn[]
  if (config.database.kind === 'local') cols = await duckSchema(slug)
  else {
    const db = await openDb()
    try {
      const rows = await db.query(
        `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema LIKE 'src\_%' AND table_schema NOT LIKE '%\_staging' AND column_name NOT LIKE '\_dlt%' AND table_name NOT LIKE '\_dlt%' ${slug ? 'AND table_schema = $1' : ''} ORDER BY 1, 2, ordinal_position`,
        slug ? [datasetFor(slug)] : [],
      )
      cols = markColumns(rows.map((r) => ({ schema: String(r.table_schema), table: String(r.table_name), column: String(r.column_name), type: String(r.data_type) }))).map(({ kind: _kind, ...c }) => c)
    } finally {
      await db.close()
    }
  }
  // JSON: one object per column, the same shape as lifecycle schema. Text: one line per column.
  const grouped: Record<string, { column: string; type: string; personal: boolean; freeText: boolean }[]> = {}
  for (const c of cols) (grouped[`${c.schema}.${c.table}`] ??= []).push({ column: c.column, type: c.type, personal: c.personal, freeText: c.freeText })
  emit(format(), grouped, () => Object.keys(grouped).length ? Object.entries(grouped).map(([t, c]) => `${t}\n  ${c.map((x) => `${x.column} ${x.type}${x.personal ? ' (personal)' : ''}`).join('\n  ')}`).join('\n\n') : 'Nothing loaded yet. Run lifecycle warehouse sync')
}))

warehouse.command('scrub').description('Empty personal columns that an older version stored. Shows counts first; --confirm applies').option('--confirm', 'empty the columns. Without it nothing is changed').action(write('warehouse scrub', async (opts) => {
  const config = readConfig()
  const db = config.database.kind === 'postgres' ? await openDb() : null
  try {
    const r = await scrubWarehouse({ confirm: Boolean(opts.confirm), db })
    if (r.totals.failed) process.exitCode = 1
    emit(format(), r, () => [
      // Text shows what there is to do. The JSON lists every column that was looked at.
      (() => {
        const busy = r.tables.map((t) => ({ ...t, columns: t.columns.filter((c) => c.rows > 0 || c.status === 'blocked' || c.status === 'failed') })).filter((t) => t.columns.length)
        if (!busy.length) return 'No stored personal values were found.'
        const words = (c: (typeof busy)[number]['columns'][number]) => c.status === 'blocked' ? 'left alone, it may not be empty' : c.status === 'failed' ? 'could not be changed' : `${c.rows} rows ${r.applied ? (c.action === 'rewrite' ? 'rewritten' : 'emptied') : c.action === 'rewrite' ? 'to rewrite' : 'to empty'}`
        return busy.map((t) => `${t.table}\n${t.columns.map((c) => `  ${c.column}: ${words(c)} (${c.why === 'personal' ? 'personal' : 'free text'})`).join('\n')}`).join('\n\n')
      })(),
      r.note,
      `Next: ${r.next}`,
    ].join('\n\n'))
  } finally {
    await db?.close()
  }
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
  .action(write('provision', async (provider: string, opts) => {
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
    const checklist = await loadChecklist(db, config)
    const shopifyExport = db ? await exportProgress(db) : null
    const out = { version: VERSION, setUp: Boolean(config), database: config?.database.kind ?? null, sources, trust, deployRepo: config?.deploy?.repo ?? null, update, checklist, shopifyExport }
    emit(format(), out, () => [
      `lifecycle ${VERSION}${update.newer ? `  (update available: ${update.latest}. To get it, ${UPDATE_HINT})` : ''}`,
      config ? `Database: ${config.database.kind}` : 'Not set up. Run lifecycle init, or follow lifecycle docs quickstart',
      ...sources.map((s) => `${s.connected ? 'connected    ' : 'not connected'} ${s.name}${s.lastSync ? `, last sync ${s.lastSync.slice(0, 16).replace('T', ' ')}` : ''}`),
      trust ? `Trust: ${trust.line}` : '',
      shopifyExport?.state === 'running' ? `Shopify order export: ${shopifyExport.ordersExported}${shopifyExport.ordersExpected ? ` of about ${shopifyExport.ordersExpected}` : ''} orders so far. The next sync picks it up.` : '',
      `Daily sync: ${config?.deploy?.repo ?? 'not deployed. lifecycle deploy --repo OWNER/NAME'}`,
      ...(checklist.done < checklist.total ? checklistLines(checklist) : []),
    ].filter(Boolean).join('\n'))
  } finally {
    await db?.close()
  }
}))

program.command('demo').description('See it work on invented sample data. No keys needed').option('--html <file>', 'also write the sample report (store demo only)').option('--type <type>', `which demo: ${DEMO_TYPES.join(', ')}. Default: the one for this workspace's type`).action(run(async (opts) => {
  const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skipped: 'SKIP' }
  const kind: DemoType = opts.type ? (DEMO_TYPES as readonly string[]).includes(opts.type) ? opts.type : demoFor(assertType(opts.type)) : demoFor(readWorkspace().type)
  if (kind !== 'shopify') {
    const d = await runTypeDemo(kind)
    emit(format(), d, () => {
      const first = d.broken.checks.find((c) => c.status === 'fail')
      return [
        'SAMPLE DATA. Every number below is invented.', '',
        kind === 'saas' ? '1. A Stripe sync loses 6 charges without any error. Reconcile catches it:' : '1. A HubSpot sync misses 12 deals without any error. Reconcile catches it:',
        `   ${first ? `${mark[first.status]} ${first.detail}` : 'No check failed.'}`, '',
        '2. After a clean sync, the checks run against the source of truth:',
        ...d.fixed.checks.filter((c) => c.status !== 'skipped').map((c) => `   ${mark[c.status]} ${c.name}${c.status === 'warn' ? `: ${c.detail}` : ''}`), '',
        `3. ${kind === 'saas' ? 'SaaS' : 'B2B'} metrics, last 90 days. ${d.trust.line}`,
        ...d.metrics.map((m) => `   ${m.title}: ${formatValue(m.unit, m.value)}`), '',
        ...(d.bySource.length ? ['4. Pipeline created by original source:', ...d.bySource.map((r) => `   ${r.source}: ${r.deals} deals, ${formatValue('usd', r.pipeline)}`), ''] : []),
        'Next: lifecycle docs workspaces',
      ].join('\n')
    })
    return
  }
  const d = await runDemo({ html: opts.html, write: writeHtml })
  emit(format(), d, () => {
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
