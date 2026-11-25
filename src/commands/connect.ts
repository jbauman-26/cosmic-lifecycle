import { readConfig, writeConfig } from '../config.js'
import { setSecret, getSecret, envName, type SecretName } from '../secrets.js'
import { CliError } from '../errors.js'
import { Klaviyo } from '../sources/klaviyo.js'
import { shopifyToken } from '../sources/shopify.js'
import { ga4AccessToken, fetchGa4Daily } from '../sources/ga4.js'
import { Stripe, isRestrictedKey, stripeMode } from '../sources/stripe.js'
import { MetaAds, normalizeAccountId } from '../sources/meta.js'
import { HubSpot } from '../sources/hubspot.js'
import { GoogleAds, googleAdsAccessToken, normalizeCustomerId } from '../sources/google-ads.js'
import { RedditAds, normalizeRedditAccountId, redditAccessToken } from '../sources/reddit-ads.js'
import { SnapchatAds, normalizeSnapAccountId, snapAccessToken } from '../sources/snapchat-ads.js'

const fromEnv = (name?: string) => {
  const value = name ? process.env[name] : undefined
  if (!value) throw new CliError(`Environment variable ${name ?? '(none given)'} is empty.`, 'Export the key, then pass its variable name. Do not paste keys into a chat.', 'missing_secret')
  return value
}

// Saves a key that has just passed its check. Where there is no keychain (Linux, CI, the
// hosted runner, the app passing keys per call) nothing is saved and the connect still
// succeeds: the caller supplies the key in the environment each time it syncs.
export type KeyStorage = { keyStorage: 'keychain' | 'environment'; keyEnv: string[]; keyNote: string | null }

export function keepKeys(keys: [SecretName, string][]): KeyStorage {
  const envOnly: string[] = []
  for (const [name, value] of keys) {
    try {
      setSecret(name, value)
    } catch (e) {
      if (e instanceof CliError && e.code === 'no_keychain') envOnly.push(envName(name))
      else throw e
    }
  }
  if (!envOnly.length) return { keyStorage: 'keychain', keyEnv: [], keyNote: null }
  return {
    keyStorage: 'environment',
    keyEnv: envOnly,
    keyNote: `The key passed its check. There is no keychain here, so it was not saved: set ${envOnly.join(' and ')} in the environment whenever you sync.`,
  }
}

const NO_KEYS: KeyStorage = { keyStorage: 'keychain', keyEnv: [], keyNote: null }

export async function connectKlaviyo(opts: { keyEnv?: string }) {
  const key = opts.keyEnv ? fromEnv(opts.keyEnv) : getSecret('klaviyo-read-key')
  if (!key) throw new CliError('No Klaviyo key given.', 'lifecycle connect klaviyo --key-env NAME', 'missing_secret')
  const account = await new Klaviyo(key).account()
  const kept = opts.keyEnv ? keepKeys([['klaviyo-read-key', key]]) : NO_KEYS
  writeConfig({ ...readConfig(), klaviyo: { connected: true } })
  return { connected: true, account: account.name ?? account.id, ...kept }
}

export async function connectShopify(opts: { store?: string; clientId?: string; secretEnv?: string }) {
  if (!opts.store || !opts.clientId) throw new CliError('Store and client ID are required.', 'lifecycle connect shopify --store NAME.myshopify.com --client-id ID --secret-env NAME')
  const secret = opts.secretEnv ? fromEnv(opts.secretEnv) : getSecret('shopify-client-secret')
  if (!secret) throw new CliError('No Shopify client secret given.', 'lifecycle connect shopify --secret-env NAME', 'missing_secret')
  await shopifyToken(opts.store, opts.clientId, secret)
  const kept = opts.secretEnv ? keepKeys([['shopify-client-secret', secret]]) : NO_KEYS
  writeConfig({ ...readConfig(), shopify: { store: opts.store, clientId: opts.clientId } })
  return { connected: true, store: opts.store, ...kept }
}

export async function connectGa4(opts: { property?: string; clientId?: string; secretEnv?: string; refreshTokenEnv?: string }) {
  if (!opts.property || !opts.clientId) throw new CliError('Property and client ID are required.', 'lifecycle connect ga4 --property ID --client-id ID --secret-env NAME --refresh-token-env NAME')
  const secret = opts.secretEnv ? fromEnv(opts.secretEnv) : getSecret('ga4-client-secret')
  const refresh = opts.refreshTokenEnv ? fromEnv(opts.refreshTokenEnv) : getSecret('ga4-refresh-token')
  if (!secret || !refresh) throw new CliError('GA4 credentials are missing.', 'lifecycle docs troubleshooting', 'missing_secret')
  const token = await ga4AccessToken(opts.clientId, secret, refresh)
  const today = new Date().toISOString().slice(0, 10)
  await fetchGa4Daily(opts.property, token, today, today)
  const keys: [SecretName, string][] = []
  if (opts.secretEnv) keys.push(['ga4-client-secret', secret])
  if (opts.refreshTokenEnv) keys.push(['ga4-refresh-token', refresh])
  const kept = keys.length ? keepKeys(keys) : NO_KEYS
  writeConfig({ ...readConfig(), ga4: { property: opts.property, clientId: opts.clientId } })
  return { connected: true, property: opts.property, ...kept }
}

export async function connectStripe(opts: { keyEnv?: string }) {
  const key = opts.keyEnv ? fromEnv(opts.keyEnv) : getSecret('stripe-read-key')
  if (!key) throw new CliError('No Stripe key given.', 'lifecycle connect stripe --key-env STRIPE_READ_KEY', 'missing_secret')
  if (!/^(sk|rk)_(test|live)_/.test(key)) throw new CliError('That is not a Stripe secret or restricted key.', 'Use a restricted key that starts with rk_live_ or rk_test_.', 'stripe_key')
  const { subscriptions } = await new Stripe(key).check()
  const mode = stripeMode(key)
  const kept = opts.keyEnv ? keepKeys([['stripe-read-key', key]]) : NO_KEYS
  writeConfig({ ...readConfig(), stripe: { mode, subscriptions } })
  return {
    ...kept,
    connected: true,
    mode,
    subscriptions,
    note: isRestrictedKey(key) ? null : 'This is a full secret key, which can also write. A restricted key with Read on Charges and Subscriptions is safer.',
  }
}

export async function connectMeta(opts: { account?: string; tokenEnv?: string }) {
  if (!opts.account) throw new CliError('The ad account id is required.', 'lifecycle connect meta --account 1234567890 --token-env META_ADS_TOKEN')
  const account = normalizeAccountId(opts.account)
  const token = opts.tokenEnv ? fromEnv(opts.tokenEnv) : getSecret('meta-ads-token')
  if (!token) throw new CliError('No Meta token given.', 'lifecycle connect meta --account ID --token-env META_ADS_TOKEN', 'missing_secret')
  const a = await new MetaAds(token, account).check()
  const kept = opts.tokenEnv ? keepKeys([['meta-ads-token', token]]) : NO_KEYS
  writeConfig({ ...readConfig(), meta: { account: a.id, name: a.name, currency: a.currency, timezone: a.timezone } })
  return { connected: true, account: a.id, name: a.name, currency: a.currency, timezone: a.timezone, ...kept }
}

export async function connectHubspot(opts: { tokenEnv?: string }) {
  const token = opts.tokenEnv ? fromEnv(opts.tokenEnv) : getSecret('hubspot-token')
  if (!token) throw new CliError('No HubSpot token given.', 'lifecycle connect hubspot --token-env HUBSPOT_TOKEN', 'missing_secret')
  if (/\s/.test(token)) throw new CliError('That token has spaces or line breaks in it.', 'Copy the access token from the private app again.', 'bad_token')
  const a = await new HubSpot(token).check()
  const kept = opts.tokenEnv ? keepKeys([['hubspot-token', token]]) : NO_KEYS
  writeConfig({ ...readConfig(), hubspot: { portal: a.portal, currency: a.currency } })
  return { connected: true, portal: a.portal, currency: a.currency, ...kept }
}

const GOOGLE_ADS_NEXT = 'lifecycle connect google-ads --customer 123-456-7890 --client-id ID --secret-env NAME --refresh-token-env NAME'

// Read only: the refresh token is for the adwords scope, but this CLI only ever calls GoogleAdsService.Search.
export async function connectGoogleAds(opts: { customer?: string; loginCustomer?: string; clientId?: string; secretEnv?: string; refreshTokenEnv?: string }) {
  if (!opts.customer || !opts.clientId) throw new CliError('The customer id and OAuth client id are required.', GOOGLE_ADS_NEXT)
  const customer = normalizeCustomerId(opts.customer)
  const loginCustomer = opts.loginCustomer ? normalizeCustomerId(opts.loginCustomer) : undefined
  const secret = opts.secretEnv ? fromEnv(opts.secretEnv) : getSecret('google-ads-client-secret')
  const refresh = opts.refreshTokenEnv ? fromEnv(opts.refreshTokenEnv) : getSecret('google-ads-refresh-token')
  if (!secret || !refresh) throw new CliError('Google Ads credentials are missing.', GOOGLE_ADS_NEXT, 'missing_secret')
  const token = await googleAdsAccessToken(opts.clientId, secret, refresh)
  const a = await new GoogleAds(token, customer, loginCustomer).check()
  const keys: [SecretName, string][] = []
  if (opts.secretEnv) keys.push(['google-ads-client-secret', secret])
  if (opts.refreshTokenEnv) keys.push(['google-ads-refresh-token', refresh])
  const kept = keys.length ? keepKeys(keys) : NO_KEYS
  writeConfig({ ...readConfig(), 'google-ads': { customer, ...(loginCustomer ? { loginCustomer } : {}), clientId: opts.clientId, name: a.name, currency: a.currency, timezone: a.timezone, testAccount: a.testAccount } })
  return { connected: true, customer, loginCustomer: loginCustomer ?? null, name: a.name, currency: a.currency, timezone: a.timezone, testAccount: a.testAccount, ...kept }
}

type AdsConnectOpts = { account?: string; clientId?: string; secretEnv?: string; refreshTokenEnv?: string }

const REDDIT_ADS_NEXT = 'lifecycle connect reddit-ads --account a2_abc123 --client-id ID --secret-env NAME --refresh-token-env NAME'

// Read only: the refresh token carries the adsread scope, and this CLI only reads the account, campaign names and reports.
export async function connectRedditAds(opts: AdsConnectOpts) {
  if (!opts.account || !opts.clientId) throw new CliError('The ad account id and app id are required.', REDDIT_ADS_NEXT)
  const account = normalizeRedditAccountId(opts.account)
  const secret = opts.secretEnv ? fromEnv(opts.secretEnv) : getSecret('reddit-ads-client-secret')
  const refresh = opts.refreshTokenEnv ? fromEnv(opts.refreshTokenEnv) : getSecret('reddit-ads-refresh-token')
  if (!secret || !refresh) throw new CliError('Reddit Ads credentials are missing.', REDDIT_ADS_NEXT, 'missing_secret')
  const a = await new RedditAds(await redditAccessToken(opts.clientId, secret, refresh), account).check()
  const keys: [SecretName, string][] = []
  if (opts.secretEnv) keys.push(['reddit-ads-client-secret', secret])
  if (opts.refreshTokenEnv) keys.push(['reddit-ads-refresh-token', refresh])
  const kept = keys.length ? keepKeys(keys) : NO_KEYS
  writeConfig({ ...readConfig(), 'reddit-ads': { account, clientId: opts.clientId, name: a.name, currency: a.currency, timezone: a.timezone } })
  return { connected: true, account, name: a.name, currency: a.currency, timezone: a.timezone, ...kept }
}

const SNAPCHAT_ADS_NEXT = 'lifecycle connect snapchat-ads --account AD_ACCOUNT_ID --client-id ID --secret-env NAME --refresh-token-env NAME'

// Read only: Snap's snapchat-marketing-api scope also allows writes, but this CLI only reads the account, campaign names and stats.
export async function connectSnapchatAds(opts: AdsConnectOpts) {
  if (!opts.account || !opts.clientId) throw new CliError('The ad account id and OAuth client id are required.', SNAPCHAT_ADS_NEXT)
  const account = normalizeSnapAccountId(opts.account)
  const secret = opts.secretEnv ? fromEnv(opts.secretEnv) : getSecret('snapchat-ads-client-secret')
  const refresh = opts.refreshTokenEnv ? fromEnv(opts.refreshTokenEnv) : getSecret('snapchat-ads-refresh-token')
  if (!secret || !refresh) throw new CliError('Snapchat Ads credentials are missing.', SNAPCHAT_ADS_NEXT, 'missing_secret')
  const a = await new SnapchatAds(await snapAccessToken(opts.clientId, secret, refresh), account).check()
  const keys: [SecretName, string][] = []
  if (opts.secretEnv) keys.push(['snapchat-ads-client-secret', secret])
  if (opts.refreshTokenEnv) keys.push(['snapchat-ads-refresh-token', refresh])
  const kept = keys.length ? keepKeys(keys) : NO_KEYS
  writeConfig({ ...readConfig(), 'snapchat-ads': { account, clientId: opts.clientId, name: a.name, currency: a.currency, timezone: a.timezone, ...(a.organizationId ? { organizationId: a.organizationId } : {}) } })
  return { connected: true, account, name: a.name, currency: a.currency, timezone: a.timezone, organizationId: a.organizationId || null, ...kept }
}
