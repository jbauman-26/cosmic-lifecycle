import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHome } from './paths.js';
import { readRawConfig } from './config.js';
import { compareVersions } from './registry.js';
import { VERSION } from './version.js';
const RELEASES = 'https://api.github.com/repos/jbauman-26/cosmic-lifecycle/releases/latest';
const DAY = 24 * 60 * 60 * 1000;
// Asks GitHub for the latest release at most once a day. Sends nothing about you or your store.
// When GitHub cannot be reached or answers "not found", that is expected:
// the check stays quiet, remembers the miss for a day, and the CLI is updated with the
// Cosmic AI app or Cosmic Cloud that carries it.
export const UNREACHABLE = 'The release list is private or offline. Nothing to do: the Cosmic AI app and Cosmic Cloud update the CLI they carry.';
export async function checkForUpdate(opts = {}) {
    const now = opts.now ?? Date.now();
    if (process.env.LIFECYCLE_NO_UPDATE_CHECK)
        return { current: VERSION, latest: null, newer: false, checkedAt: null, skipped: 'LIFECYCLE_NO_UPDATE_CHECK is set' };
    if (readRawConfig()?.update?.check === false)
        return { current: VERSION, latest: null, newer: false, checkedAt: null, skipped: 'update.check is false' };
    const cache = join(appHome(), 'update-check.json');
    if (!opts.force && existsSync(cache)) {
        try {
            const c = JSON.parse(readFileSync(cache, 'utf8'));
            if (now - Date.parse(c.checkedAt) < DAY) {
                if (!c.latest)
                    return { current: VERSION, latest: null, newer: false, checkedAt: c.checkedAt, skipped: UNREACHABLE };
                return { current: VERSION, latest: c.latest, newer: compareVersions(c.latest, VERSION) > 0, checkedAt: c.checkedAt };
            }
        }
        catch {
            // Unreadable cache: check again.
        }
    }
    try {
        const res = await (opts.fetcher ?? fetch)(RELEASES, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'cosmic-lifecycle-cli' }, signal: AbortSignal.timeout(3000) });
        if (!res.ok)
            throw new Error(String(res.status));
        const latest = String((await res.json()).tag_name ?? '').replace(/^v/, '') || null;
        const checkedAt = new Date(now).toISOString();
        mkdirSync(appHome(), { recursive: true });
        writeFileSync(cache, JSON.stringify({ latest, checkedAt }));
        return { current: VERSION, latest, newer: !!latest && compareVersions(latest, VERSION) > 0, checkedAt };
    }
    catch {
        // Remember the miss, so a private or offline release list costs one short request a day, not one per command.
        const checkedAt = new Date(now).toISOString();
        try {
            mkdirSync(appHome(), { recursive: true });
            writeFileSync(cache, JSON.stringify({ latest: null, checkedAt }));
        }
        catch {
            // A read-only home: check again next time.
        }
        return { current: VERSION, latest: null, newer: false, checkedAt, skipped: UNREACHABLE };
    }
}
// There is no public download link. The steps live in the built-in docs.
export const UPDATE_HINT = 'update the Cosmic AI app, or see lifecycle docs quickstart';
