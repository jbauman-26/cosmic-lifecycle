import { spawnSync } from 'node:child_process';
import { CliError } from './errors.js';
const SERVICE = 'lifecycle-cli';
const ENV = {
    'klaviyo-read-key': 'LIFECYCLE_KLAVIYO_READ_KEY',
    'klaviyo-write-key': 'LIFECYCLE_KLAVIYO_WRITE_KEY',
    'shopify-client-secret': 'LIFECYCLE_SHOPIFY_CLIENT_SECRET',
    'database-url': 'LIFECYCLE_DATABASE_URL',
    'ga4-client-secret': 'LIFECYCLE_GA4_CLIENT_SECRET',
    'ga4-refresh-token': 'LIFECYCLE_GA4_REFRESH_TOKEN',
    'stripe-read-key': 'LIFECYCLE_STRIPE_READ_KEY',
};
const useKeychain = () => process.platform === 'darwin' && !process.env.LIFECYCLE_NO_KEYCHAIN;
// `security -i` reads the command from stdin, so the secret never appears in
// the process list the way a -w argument would.
export function setSecret(name, value) {
    if (!useKeychain()) {
        throw new CliError(`No keychain here. Set ${ENV[name]} in the environment instead.`, `export ${ENV[name]}=...`, 'no_keychain');
    }
    if (/["\\\n]/.test(value))
        throw new CliError('That value has characters a key should not contain.', 'Check the value and try again.');
    const res = spawnSync('security', ['-i'], {
        input: `add-generic-password -U -s ${SERVICE} -a ${name} -w "${value}"\n`,
        encoding: 'utf8',
    });
    if (res.status !== 0)
        throw new CliError('Could not save to the macOS keychain.', 'Unlock your keychain and run the command again.');
}
export const SECRET_NAMES = Object.keys(ENV);
export const envName = (name) => ENV[name];
export function deleteSecret(name) {
    if (!useKeychain())
        return { name, removed: false, note: `No keychain here. Unset ${ENV[name]} in your environment.` };
    const res = spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', name], { encoding: 'utf8' });
    return { name, removed: res.status === 0, note: res.status === 0 ? 'Removed from the keychain.' : 'It was not in the keychain.' };
}
// Where each secret comes from. Never returns a value.
export function secretStatus() {
    return SECRET_NAMES.map((name) => {
        const fromEnv = Boolean(process.env[ENV[name]]);
        const inKeychain = !fromEnv && useKeychain() && spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', name], { encoding: 'utf8' }).status === 0;
        return { name, env: ENV[name], source: fromEnv ? 'env' : inKeychain ? 'keychain' : 'missing' };
    });
}
export function getSecret(name) {
    const fromEnv = process.env[ENV[name]];
    if (fromEnv)
        return fromEnv;
    if (!useKeychain())
        return undefined;
    const res = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], { encoding: 'utf8' });
    return res.status === 0 ? res.stdout.trim() : undefined;
}
