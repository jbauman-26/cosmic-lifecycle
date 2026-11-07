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
    registry: z.object({ uri: z.string() }).partial().optional(),
    deploy: z.object({ repo: z.string() }).partial().optional(),
    update: z.object({ check: z.boolean() }).partial().optional(),
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
// are set by init and connect, which validate them first.
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
} as const
export type SettingKey = keyof typeof SETTINGS

function assertKey(key: string): asserts key is SettingKey {
  if (!(key in SETTINGS)) throw new CliError(`Unknown setting ${key}.`, `Settings: ${Object.keys(SETTINGS).join(', ')}`, 'unknown_setting')
}

export function getSetting(key: string): unknown {
  assertKey(key)
  const [a, b] = key.split('.') as [string, string]
  return readRawConfig()[a]?.[b]
}

export function setSetting(key: string, value: string) {
  assertKey(key)
  const parsed = SETTINGS[key].parse(value)
  const [a, b] = key.split('.') as [string, string]
  const raw = readRawConfig()
  writeRaw({ ...raw, [a]: { ...(raw[a] ?? {}), [b]: parsed } })
  return parsed
}

export function unsetSetting(key: string) {
  assertKey(key)
  const [a, b] = key.split('.') as [string, string]
  const raw = readRawConfig()
  if (raw[a]) {
    delete raw[a][b]
    if (!Object.keys(raw[a]).length) delete raw[a]
    writeRaw(raw)
  }
}

export function listSettings() {
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => ({ key, value: getSetting(key) ?? null, description: SETTINGS[key].description }))
}
