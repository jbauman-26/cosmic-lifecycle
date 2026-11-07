import { spawnSync } from 'node:child_process'
import { CliError } from './errors.js'

const SERVICE = 'lifecycle-cli'
export type SecretName = 'klaviyo-read-key' | 'shopify-client-secret' | 'database-url' | 'klaviyo-write-key' | 'ga4-client-secret' | 'ga4-refresh-token'

const ENV: Record<SecretName, string> = {
  'klaviyo-read-key': 'LIFECYCLE_KLAVIYO_READ_KEY',
  'klaviyo-write-key': 'LIFECYCLE_KLAVIYO_WRITE_KEY',
  'shopify-client-secret': 'LIFECYCLE_SHOPIFY_CLIENT_SECRET',
  'database-url': 'LIFECYCLE_DATABASE_URL',
  'ga4-client-secret': 'LIFECYCLE_GA4_CLIENT_SECRET',
  'ga4-refresh-token': 'LIFECYCLE_GA4_REFRESH_TOKEN',
}

const useKeychain = () => process.platform === 'darwin' && !process.env.LIFECYCLE_NO_KEYCHAIN

// `security -i` reads the command from stdin, so the secret never appears in
// the process list the way a -w argument would.
export function setSecret(name: SecretName, value: string) {
  if (!useKeychain()) {
    throw new CliError(`No keychain here. Set ${ENV[name]} in the environment instead.`, `export ${ENV[name]}=...`, 'no_keychain')
  }
  if (/["\\\n]/.test(value)) throw new CliError('That value has characters a key should not contain.', 'Check the value and try again.')
  const res = spawnSync('security', ['-i'], {
    input: `add-generic-password -U -s ${SERVICE} -a ${name} -w "${value}"\n`,
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new CliError('Could not save to the macOS keychain.', 'Unlock your keychain and run the command again.')
}

export function getSecret(name: SecretName): string | undefined {
  const fromEnv = process.env[ENV[name]]
  if (fromEnv) return fromEnv
  if (!useKeychain()) return undefined
  const res = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], { encoding: 'utf8' })
  return res.status === 0 ? res.stdout.trim() : undefined
}
