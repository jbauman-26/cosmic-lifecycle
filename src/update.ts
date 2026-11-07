import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appHome } from './paths.js'
import { readRawConfig } from './config.js'
import { compareVersions } from './registry.js'
import { VERSION } from './version.js'

const RELEASES = 'https://api.github.com/repos/jbauman-26/cosmic-lifecycle/releases/latest'
const DAY = 24 * 60 * 60 * 1000

export type UpdateInfo = { current: string; latest: string | null; newer: boolean; checkedAt: string | null; skipped?: string }

// Asks GitHub for the latest release at most once a day. Sends nothing about you or your store.
export async function checkForUpdate(opts: { force?: boolean; fetcher?: typeof fetch; now?: number } = {}): Promise<UpdateInfo> {
  const now = opts.now ?? Date.now()
  if (process.env.LIFECYCLE_NO_UPDATE_CHECK) return { current: VERSION, latest: null, newer: false, checkedAt: null, skipped: 'LIFECYCLE_NO_UPDATE_CHECK is set' }
  if (readRawConfig()?.update?.check === false) return { current: VERSION, latest: null, newer: false, checkedAt: null, skipped: 'update.check is false' }

  const cache = join(appHome(), 'update-check.json')
  if (!opts.force && existsSync(cache)) {
    try {
      const c = JSON.parse(readFileSync(cache, 'utf8'))
      if (now - Date.parse(c.checkedAt) < DAY) return { current: VERSION, latest: c.latest, newer: !!c.latest && compareVersions(c.latest, VERSION) > 0, checkedAt: c.checkedAt }
    } catch {
      // Unreadable cache: check again.
    }
  }
  try {
    const res = await (opts.fetcher ?? fetch)(RELEASES, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'cosmic-lifecycle-cli' }, signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(String(res.status))
    const latest = String(((await res.json()) as { tag_name?: string }).tag_name ?? '').replace(/^v/, '') || null
    const checkedAt = new Date(now).toISOString()
    mkdirSync(appHome(), { recursive: true })
    writeFileSync(cache, JSON.stringify({ latest, checkedAt }))
    return { current: VERSION, latest, newer: !!latest && compareVersions(latest, VERSION) > 0, checkedAt }
  } catch {
    return { current: VERSION, latest: null, newer: false, checkedAt: null, skipped: 'GitHub could not be reached' }
  }
}

export const UPDATE_COMMAND = 'npm install -g https://github.com/jbauman-26/cosmic-lifecycle/releases/latest/download/cosmic-lifecycle.tgz'
