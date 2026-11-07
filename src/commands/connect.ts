import { readConfig, writeConfig } from '../config.js'
import { setSecret, getSecret } from '../secrets.js'
import { CliError } from '../errors.js'
import { Klaviyo } from '../sources/klaviyo.js'
import { shopifyToken } from '../sources/shopify.js'
import { ga4AccessToken, fetchGa4Daily } from '../sources/ga4.js'
import { Stripe, isRestrictedKey, stripeMode } from '../sources/stripe.js'

const fromEnv = (name?: string) => {
  const value = name ? process.env[name] : undefined
  if (!value) throw new CliError(`Environment variable ${name ?? '(none given)'} is empty.`, 'Export the key, then pass its variable name. Do not paste keys into a chat.', 'missing_secret')
  return value
}

export async function connectKlaviyo(opts: { keyEnv?: string }) {
  const key = opts.keyEnv ? fromEnv(opts.keyEnv) : getSecret('klaviyo-read-key')
  if (!key) throw new CliError('No Klaviyo key given.', 'lifecycle connect klaviyo --key-env NAME', 'missing_secret')
  const account = await new Klaviyo(key).account()
  if (opts.keyEnv) setSecret('klaviyo-read-key', key)
  writeConfig({ ...readConfig(), klaviyo: { connected: true } })
  return { connected: true, account: account.name ?? account.id }
}

export async function connectShopify(opts: { store?: string; clientId?: string; secretEnv?: string }) {
  if (!opts.store || !opts.clientId) throw new CliError('Store and client ID are required.', 'lifecycle connect shopify --store NAME.myshopify.com --client-id ID --secret-env NAME')
  const secret = opts.secretEnv ? fromEnv(opts.secretEnv) : getSecret('shopify-client-secret')
  if (!secret) throw new CliError('No Shopify client secret given.', 'lifecycle connect shopify --secret-env NAME', 'missing_secret')
  await shopifyToken(opts.store, opts.clientId, secret)
  if (opts.secretEnv) setSecret('shopify-client-secret', secret)
  writeConfig({ ...readConfig(), shopify: { store: opts.store, clientId: opts.clientId } })
  return { connected: true, store: opts.store }
}

export async function connectGa4(opts: { property?: string; clientId?: string; secretEnv?: string; refreshTokenEnv?: string }) {
  if (!opts.property || !opts.clientId) throw new CliError('Property and client ID are required.', 'lifecycle connect ga4 --property ID --client-id ID --secret-env NAME --refresh-token-env NAME')
  const secret = opts.secretEnv ? fromEnv(opts.secretEnv) : getSecret('ga4-client-secret')
  const refresh = opts.refreshTokenEnv ? fromEnv(opts.refreshTokenEnv) : getSecret('ga4-refresh-token')
  if (!secret || !refresh) throw new CliError('GA4 credentials are missing.', 'lifecycle docs troubleshooting', 'missing_secret')
  const token = await ga4AccessToken(opts.clientId, secret, refresh)
  const today = new Date().toISOString().slice(0, 10)
  await fetchGa4Daily(opts.property, token, today, today)
  if (opts.secretEnv) setSecret('ga4-client-secret', secret)
  if (opts.refreshTokenEnv) setSecret('ga4-refresh-token', refresh)
  writeConfig({ ...readConfig(), ga4: { property: opts.property, clientId: opts.clientId } })
  return { connected: true, property: opts.property }
}

export async function connectStripe(opts: { keyEnv?: string }) {
  const key = opts.keyEnv ? fromEnv(opts.keyEnv) : getSecret('stripe-read-key')
  if (!key) throw new CliError('No Stripe key given.', 'lifecycle connect stripe --key-env STRIPE_READ_KEY', 'missing_secret')
  if (!/^(sk|rk)_(test|live)_/.test(key)) throw new CliError('That is not a Stripe secret or restricted key.', 'Use a restricted key that starts with rk_live_ or rk_test_.', 'stripe_key')
  const { subscriptions } = await new Stripe(key).check()
  const mode = stripeMode(key)
  if (opts.keyEnv) setSecret('stripe-read-key', key)
  writeConfig({ ...readConfig(), stripe: { mode, subscriptions } })
  return {
    connected: true,
    mode,
    subscriptions,
    note: isRestrictedKey(key) ? null : 'This is a full secret key, which can also write. A restricted key with Read on Charges and Subscriptions is safer.',
  }
}
