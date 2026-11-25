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
import { TikTokAds, normalizeAdvertiserId } from '../sources/tiktok-ads.js'
import { PinterestAds, pinterestAccessToken, normalizeAdAccountId } from '../sources/pinterest-ads.js'
import { fetchJson } from '../http.js'

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

const TIKTOK_ADS_NEXT = 'lifecycle connect tiktok-ads --account ADVERTISER_ID --app-id ID --token-env NAME'

// Read only: the token is TikTok's long-term advertiser token, and this CLI only ever calls
// advertiser/info and report/integrated/get, both GET. The app id is kept to say which app the
// advertiser authorized; the app secret is never needed, because the token does not expire.
export async function connectTiktokAds(opts: { account?: string; appId?: string; tokenEnv?: string }, fetcher = fetchJson) {
  if (!opts.account || !opts.appId) throw new CliError('The advertiser id and TikTok app id are required.', TIKTOK_ADS_NEXT)
  const account = normalizeAdvertiserId(opts.account)
  const token = opts.tokenEnv ? fromEnv(opts.tokenEnv) : getSecret('tiktok-ads-access-token')
  if (!token) throw new CliError('No TikTok Ads access token given.', TIKTOK_ADS_NEXT, 'missing_secret')
  if (/\s/.test(token)) throw new CliError('That token has spaces or line breaks in it.', 'Copy the access token again.', 'bad_token')
  const a = await new TikTokAds(token, account, fetcher).check()
  const kept = opts.tokenEnv ? keepKeys([['tiktok-ads-access-token', token]]) : NO_KEYS
  writeConfig({ ...readConfig(), 'tiktok-ads': { account, clientId: opts.appId, name: a.name, currency: a.currency, timezone: a.timezone } })
  return { connected: true, account, appId: opts.appId, name: a.name, currency: a.currency, timezone: a.timezone, ...kept }
}

// Pinterest hands back a new refresh token on every refresh, good for 60 days. When the saved one
// came from the keychain, the new one replaces it there. One from the environment (CI, Cloud) cannot
// be updated here: whoever set it keeps the newest one.
export function keepRotatedPinterest(fresh: string | null, used: string): boolean {
  if (!fresh || fresh === used || process.env[envName('pinterest-ads-refresh-token')]) return false
  try {
    setSecret('pinterest-ads-refresh-token', fresh)
    return true
  } catch {
    return false
  }
}

const PINTEREST_ADS_NEXT = 'lifecycle connect pinterest-ads --account AD_ACCOUNT_ID --client-id ID --secret-env NAME --refresh-token-env NAME'

// Read only: the refresh token is for the ads:read scope, and this CLI only ever reads the ad account,
// its campaigns and campaign analytics.
export async function connectPinterestAds(opts: { account?: string; clientId?: string; secretEnv?: string; refreshTokenEnv?: string }, fetcher = fetchJson) {
  if (!opts.account || !opts.clientId) throw new CliError('The ad account id and Pinterest app id are required.', PINTEREST_ADS_NEXT)
  const account = normalizeAdAccountId(opts.account)
  const secret = opts.secretEnv ? fromEnv(opts.secretEnv) : getSecret('pinterest-ads-client-secret')
  const refresh = opts.refreshTokenEnv ? fromEnv(opts.refreshTokenEnv) : getSecret('pinterest-ads-refresh-token')
  if (!secret || !refresh) throw new CliError('Pinterest Ads credentials are missing.', PINTEREST_ADS_NEXT, 'missing_secret')
  const token = await pinterestAccessToken(opts.clientId, secret, refresh, fetcher)
  const a = await new PinterestAds(token.accessToken, account, fetcher).check()
  const newest = token.refreshToken ?? refresh
  const keys: [SecretName, string][] = []
  if (opts.secretEnv) keys.push(['pinterest-ads-client-secret', secret])
  if (opts.refreshTokenEnv) keys.push(['pinterest-ads-refresh-token', newest])
  const kept = keys.length ? keepKeys(keys) : NO_KEYS
  if (!opts.refreshTokenEnv) keepRotatedPinterest(token.refreshToken, refresh)
  writeConfig({ ...readConfig(), 'pinterest-ads': { account, clientId: opts.clientId, name: a.name, currency: a.currency, timezone: a.timezone } })
  return { connected: true, account, name: a.name, currency: a.currency, timezone: a.timezone, refreshTokenRotated: newest !== refresh, ...kept }
}
