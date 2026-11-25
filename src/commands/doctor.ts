import { existsSync } from 'node:fs'
import { configPath } from '../paths.js'
import { readConfig } from '../config.js'
import { getSecret } from '../secrets.js'
import { openDb, type Db } from '../db.js'
import { Klaviyo, reportsVerified } from '../sources/klaviyo.js'
import { shopifyToken } from '../sources/shopify.js'
import { Stripe } from '../sources/stripe.js'
import { MetaAds } from '../sources/meta.js'
import { HubSpot } from '../sources/hubspot.js'
import { readWorkspace, REFERENCE_NAME } from '../workspace.js'

type Check = { name: string; ok: boolean; detail: string; next?: string }

export async function doctor(): Promise<{ healthy: boolean; checks: Check[] }> {
  const checks: Check[] = []
  if (!existsSync(configPath())) {
    return { healthy: false, checks: [{ name: 'setup', ok: false, detail: 'Not set up.', next: 'lifecycle init' }] }
  }
  const config = readConfig()
  checks.push({ name: 'setup', ok: true, detail: `Database: ${config.database.kind}` })

  // A store needs Klaviyo and Shopify, as in 0.13. Any other workspace needs its source of truth,
  // and Klaviyo and Shopify are checked only once connected.
  const ws = readWorkspace()
  const store = ws.type === 'shopify' && ws.reference === 'shopify'
  if (!store) {
    const has = ws.reference === 'none' ? false : ws.reference === 'shopify' ? Boolean(config.shopify) : Boolean((config as Record<string, unknown>)[ws.reference])
    if (ws.reference === 'none') checks.push({ name: 'reference', ok: true, detail: 'No source of truth set, so numbers are not checked against one.', next: 'lifecycle config set workspace.reference stripe (or hubspot, shopify, ga4)' })
    else checks.push({ name: 'reference', ok: has, detail: has ? `${REFERENCE_NAME[ws.reference]} is connected as the source of truth.` : `${REFERENCE_NAME[ws.reference]} is this workspace's source of truth and is not connected.`, ...(has ? {} : { next: `lifecycle connect ${ws.reference}` }) })
  }

  const klaviyoKey = getSecret('klaviyo-read-key')
  if (!klaviyoKey && !store) {
    // Optional outside a store.
  } else if (!klaviyoKey) checks.push({ name: 'klaviyo', ok: false, detail: 'Not connected.', next: 'lifecycle connect klaviyo --key-env NAME' })
  else {
    try {
      const a = await new Klaviyo(klaviyoKey).account()
      checks.push({ name: 'klaviyo', ok: true, detail: `Key works for ${a.name ?? a.id}` })
    } catch {
      checks.push({ name: 'klaviyo', ok: false, detail: 'Key was refused.', next: 'Create a Read-Only key, then lifecycle connect klaviyo --key-env NAME' })
    }
    if (!reportsVerified) checks.push({ name: 'klaviyo-reports', ok: true, detail: 'Warning: flow report parsing is untested on real sends.' })
  }

  const secret = getSecret('shopify-client-secret')
  if (!store && !config.shopify) {
    // Optional outside a store.
  } else if (!config.shopify || !secret) checks.push({ name: 'shopify', ok: false, detail: 'Not connected.', next: 'lifecycle connect shopify --store NAME.myshopify.com --client-id ID --secret-env NAME' })
  else {
    try {
      await shopifyToken(config.shopify.store, config.shopify.clientId, secret)
      checks.push({ name: 'shopify', ok: true, detail: `Token works for ${config.shopify.store}` })
    } catch {
      checks.push({ name: 'shopify', ok: false, detail: 'Token request failed.', next: 'Check the app is installed, then lifecycle connect shopify' })
    }
  }

  // Stripe is optional, so it is only checked once connected.
  // Meta Ads is optional too.
  const metaToken = getSecret('meta-ads-token')
  if (config.meta && !metaToken) checks.push({ name: 'meta', ok: false, detail: 'Connected, but the token is missing.', next: 'lifecycle connect meta --account ID --token-env NAME' })
  else if (config.meta && metaToken) {
    try {
      const a = await new MetaAds(metaToken, config.meta.account).check()
      checks.push({ name: 'meta', ok: true, detail: `Token reads insights for ${a.name || a.id} in ${a.currency}` })
    } catch (e) {
      checks.push({ name: 'meta', ok: false, detail: e instanceof Error ? e.message : 'Token was refused.', next: 'Create a new system user token with ads_read, then lifecycle connect meta --account ID --token-env NAME' })
    }
  }

  const stripeKey = getSecret('stripe-read-key')
  if (config.stripe && !stripeKey) checks.push({ name: 'stripe', ok: false, detail: 'Connected, but the key is missing.', next: 'lifecycle connect stripe --key-env NAME' })
  else if (config.stripe && stripeKey) {
    try {
      const r = await new Stripe(stripeKey).check()
      checks.push({ name: 'stripe', ok: true, detail: `Key reads charges in ${config.stripe.mode} mode${r.subscriptions ? ' and subscriptions' : ', not subscriptions'}` })
    } catch {
      checks.push({ name: 'stripe', ok: false, detail: 'Key was refused.', next: 'Create a restricted key with Read on Charges and Subscriptions, then lifecycle connect stripe --key-env NAME' })
    }
  }

  const hubspotToken = getSecret('hubspot-token')
  if (config.hubspot && !hubspotToken) checks.push({ name: 'hubspot', ok: false, detail: 'Connected, but the token is missing.', next: 'lifecycle connect hubspot --token-env NAME' })
  else if (config.hubspot && hubspotToken) {
    try {
      await new HubSpot(hubspotToken).check()
      checks.push({ name: 'hubspot', ok: true, detail: 'Token reads deals and contacts' })
    } catch (e) {
      checks.push({ name: 'hubspot', ok: false, detail: e instanceof Error ? e.message : 'Token was refused.', next: 'lifecycle connect hubspot --token-env NAME' })
    }
  }

  let db: Db | undefined
  try {
    db = await openDb()
    const last = await db.query(`SELECT DISTINCT ON (source) source, status, finished_at, detail FROM meta_sync_run ORDER BY source, started_at DESC`)
    if (!last.length) checks.push({ name: 'sync', ok: false, detail: 'Nothing synced yet.', next: 'lifecycle sync' })
    for (const r of last) {
      const age = r.finished_at ? (Date.now() - new Date(r.finished_at as string).getTime()) / 86400000 : Infinity
      const fresh = age < 2
      checks.push({
        name: `sync:${r.source}`,
        ok: r.status !== 'failed' && fresh,
        detail: `${r.status}${r.detail ? `: ${r.detail}` : ''}${fresh ? '' : ' (more than 2 days old)'}`,
        ...(r.status === 'failed' || !fresh ? { next: 'lifecycle sync' } : {}),
      })
    }
  } catch (e) {
    checks.push({ name: 'database', ok: false, detail: e instanceof Error ? e.message : String(e), next: 'lifecycle init' })
  } finally {
    await db?.close()
  }
  return { healthy: checks.every((c) => c.ok), checks }
}
