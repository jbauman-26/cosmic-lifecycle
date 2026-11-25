import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { configPath } from './paths.js'
import { CliError } from './errors.js'

const Config = z
  .object({
    database: z.object({ kind: z.enum(['local', 'postgres']) }),
    shopify: z.object({ store: z.string(), clientId: z.string() }).optional(),
    klaviyo: z.object({ connected: z.literal(true) }).optional(),
    ga4: z.object({ property: z.string(), clientId: z.string() }).optional(),
    stripe: z.object({ mode: z.enum(['test', 'live']), subscriptions: z.boolean() }).optional(),
    meta: z.object({ account: z.string(), name: z.string(), currency: z.string(), timezone: z.string() }).optional(),
    registry: z.object({ uri: z.string() }).partial().optional(),
    deploy: z.object({ repo: z.string() }).partial().optional(),
    update: z.object({ check: z.boolean() }).partial().optional(),
    // Where Cosmic Cloud lives. The store token is in the keychain, never here.
    cloud: z.object({ url: z.string() }).partial().optional(),
    // Warehouse sources: settings only. Their keys live in the keychain or the environment.
    warehouse: z
      .object({
        sources: z.record(
          z.string(),
          z.object({
            params: z.record(z.string(), z.string()).default({}),
            personalData: z.enum(['strip', 'keep']).default('strip'),
            connectedAt: z.string(),
          }),
        ),
      })
      .optional(),
  })
  // Keep keys this version does not know, so an older CLI never deletes a newer one's settings.
  .passthrough()
export type Config = z.infer<typeof Config>

export function readRawConfig(): Record<string, any> {
  if (!existsSync(configPath())) return {}
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    throw new CliError(`${configPath()} is not valid JSON.`, 'Fix or delete it, then lifecycle init', 'bad_config')
  }
}

function writeRaw(data: Record<string, unknown>) {
  mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 })
  // Config holds no secrets, but it does name the store.
  writeFileSync(configPath(), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

export function readConfig(): Config {
  const raw = readRawConfig()
  const parsed = Config.safeParse(raw)
  if (!parsed.success) throw new CliError('Not set up yet.', 'lifecycle init', 'not_initialized')
  return parsed.data
}

export function writeConfig(config: Config) {
  writeRaw({ ...readRawConfig(), ...config })
}

// Settings a person may change with `lifecycle config`. Sources and the database
// are set by init and connect, which validate them first. A setting with a default
// reads as that default until someone sets it, so an unset key changes nothing.
const numberIn = (key: string, min: number, max: number, opts: { whole?: boolean; example: string }) => (v: string) => {
  const n = Number(v)
  if (v.trim() === '' || !Number.isFinite(n) || n < min || n > max || (opts.whole && !Number.isInteger(n))) {
    throw new CliError(`Use ${opts.whole ? 'a whole number' : 'a number'} from ${min} to ${max}.`, `lifecycle config set ${key} ${opts.example}`, 'bad_value')
  }
  return n
}

type Setting = { description: string; parse: (v: string) => unknown; default?: number }

export const SETTINGS = {
  'registry.uri': { description: 'Kit registry: a local folder or a git URL', parse: (v: string) => v },
  'deploy.repo': { description: 'GitHub repo that runs the daily sync, OWNER/NAME', parse: (v: string) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(v)) throw new CliError('Use OWNER/NAME.', 'lifecycle config set deploy.repo you/lifecycle-sync', 'bad_value')
    return v
  } },
  'update.check': { description: 'Check GitHub for a newer release (true or false)', parse: (v: string) => {
    if (v !== 'true' && v !== 'false') throw new CliError('Use true or false.', 'lifecycle config set update.check false', 'bad_value')
    return v === 'true'
  } },
  'cloud.url': { description: 'Cosmic Cloud address. lifecycle login sets it', parse: (v: string) => {
    let u: URL | null = null
    try {
      u = new URL(v)
    } catch {
      u = null
    }
    const local = u !== null && u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    if (!u || (u.protocol !== 'https:' && !local)) throw new CliError('Use an https address.', 'lifecycle config set cloud.url https://cosmic-cloud.vercel.app', 'bad_value')
    return v.replace(/\/+$/, '')
  } },
  'reconcile.tolerance.klaviyo_orders': { description: 'Percent Klaviyo Placed Order may differ from Shopify orders before the check fails', default: 3, parse: numberIn('reconcile.tolerance.klaviyo_orders', 0, 100, { example: '3' }) },
  'reconcile.tolerance.ga4_purchases': { description: 'Percent GA4 purchases may differ from Shopify orders before the check fails', default: 15, parse: numberIn('reconcile.tolerance.ga4_purchases', 0, 100, { example: '15' }) },
  'reconcile.attributed_share_flag': { description: 'Warn when Klaviyo credits flows with more than this percent of Shopify net revenue', default: 60, parse: numberIn('reconcile.attributed_share_flag', 0, 100, { example: '60' }) },
  'reconcile.freshness_days': { description: 'Days since a source last synced before the freshness check fails', default: 2, parse: numberIn('reconcile.freshness_days', 0.5, 365, { example: '2' }) },
  'query.row_cap': { description: 'Most rows lifecycle query returns', default: 1000, parse: numberIn('query.row_cap', 1, 100000, { whole: true, example: '1000' }) },
  'metrics.default_days': { description: 'Window in days for metrics, reports and sync pulls when none is given', default: 90, parse: numberIn('metrics.default_days', 1, 730, { whole: true, example: '90' }) },
} satisfies Record<string, Setting>
export type SettingKey = keyof typeof SETTINGS

function assertKey(key: string): asserts key is SettingKey {
  if (!(key in SETTINGS)) throw new CliError(`Unknown setting ${key}.`, `Settings: ${Object.keys(SETTINGS).join(', ')}`, 'unknown_setting')
}

const pathOf = (key: string) => key.split('.')

// The value written in the config file, or undefined when it was never set.
export function getSetting(key: string): unknown {
  assertKey(key)
  let node: any = readRawConfig()
  for (const part of pathOf(key)) node = node?.[part]
  return node
}

export const defaultOf = (key: SettingKey): number | undefined => (SETTINGS[key] as Setting).default

// What the CLI uses: the set value, else the default. A value someone typed into
// the file by hand that is out of range falls back to the default too.
export function settingValue(key: SettingKey): number {
  const d = defaultOf(key)
  if (d === undefined) throw new Error(`${key} has no default`)
  let raw: unknown
  try {
    raw = getSetting(key)
  } catch {
    return d
  }
  if (raw === undefined || raw === null) return d
  try {
    return SETTINGS[key].parse(String(raw)) as number
  } catch {
    return d
  }
}

export function setSetting(key: string, value: string) {
  assertKey(key)
  const parsed = SETTINGS[key].parse(value)
  const raw = readRawConfig()
  const parts = pathOf(key)
  let node: any = raw
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {}
    node = node[part]
  }
  node[parts.at(-1)!] = parsed
  writeRaw(raw)
  return parsed
}

export function unsetSetting(key: string) {
  assertKey(key)
  const raw = readRawConfig()
  const parts = pathOf(key)
  const chain: any[] = [raw]
  for (const part of parts.slice(0, -1)) {
    const next = chain.at(-1)?.[part]
    if (typeof next !== 'object' || next === null) return
    chain.push(next)
  }
  delete chain.at(-1)[parts.at(-1)!]
  // Drop parents left empty, so the file reads the same as before the setting existed.
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length) break
    delete chain[i - 1][parts[i - 1]!]
  }
  writeRaw(raw)
}

export function listSettings() {
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => ({ key, value: getSetting(key) ?? null, default: defaultOf(key) ?? null, description: SETTINGS[key].description }))
}

// Removes a whole top-level section, such as a native source a person disconnected.
export function removeConfigSection(name: string) {
  const raw = readRawConfig()
  if (!(name in raw)) return false
  delete raw[name]
  writeRaw(raw)
  return true
}
