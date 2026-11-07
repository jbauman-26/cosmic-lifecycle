import type { Config } from './config.js'
import type { Tx } from './db.js'

// What this CLI can connect today. Only sources with a working connector are listed:
// a source that is planned but not built is not in the catalog.
export type CatalogSource = {
  slug: 'klaviyo' | 'shopify' | 'ga4'
  name: string
  syncs: string
  credential: string
  setupMinutes: number
  connect: string
  tested: string
}

export const CATALOG: CatalogSource[] = [
  {
    slug: 'klaviyo',
    name: 'Klaviyo',
    syncs: 'Flows, flow messages, campaigns, segments, daily flow results, Placed Order counts',
    credential: 'Private API key, Read-Only. No profiles scope.',
    setupMinutes: 2,
    connect: 'lifecycle connect klaviyo --key-env KLAVIYO_READ_KEY',
    tested: 'Access and the flow report tested on one real send. Revenue on real conversions not yet seen.',
  },
  {
    slug: 'shopify',
    name: 'Shopify',
    syncs: 'Daily order totals, new and returning orders, monthly repeat-purchase cohorts. No customer records.',
    credential: 'Custom app with read_orders and Level 1 protected customer data (Analytics only).',
    setupMinutes: 15,
    connect: 'lifecycle connect shopify --store NAME.myshopify.com --client-id ID --secret-env SHOPIFY_SECRET',
    tested: 'Tested on a dev store with 150 labeled sample orders. Not yet on a production store.',
  },
  {
    slug: 'ga4',
    name: 'Google Analytics 4',
    syncs: 'Daily sessions, purchases and revenue by channel',
    credential: 'OAuth client id and secret, plus a refresh token with analytics.readonly',
    setupMinutes: 15,
    connect: 'lifecycle connect ga4 --property ID --client-id ID --secret-env NAME --refresh-token-env NAME',
    tested: 'Built and unit tested. Not yet run on live data.',
  },
]

export type SourceStatus = { slug: string; name: string; connected: boolean; lastSync: string | null; lastStatus: string | null; next: string | null }

// Connected means configured with a key present. lastSync comes from the database when it is reachable.
export async function sourceStatus(config: Config | null, hasKey: (slug: string) => boolean, db: Tx | null): Promise<SourceStatus[]> {
  const last = new Map<string, { at: string; status: string }>()
  if (db) {
    try {
      const rows = await db.query(`SELECT DISTINCT ON (source) source, status, coalesce(finished_at, started_at) AS at FROM meta_sync_run ORDER BY source, started_at DESC`)
      for (const r of rows) last.set(String(r.source), { at: new Date(String(r.at)).toISOString(), status: String(r.status) })
    } catch {
      // No sync table yet: nothing has synced.
    }
  }
  return CATALOG.map((s) => {
    const configured = s.slug === 'klaviyo' ? Boolean(config?.klaviyo) : s.slug === 'shopify' ? Boolean(config?.shopify) : Boolean(config?.ga4)
    const connected = configured && hasKey(s.slug)
    const l = last.get(s.slug)
    return {
      slug: s.slug,
      name: s.name,
      connected,
      lastSync: l?.at ?? null,
      lastStatus: l?.status ?? null,
      next: !config ? 'lifecycle init' : !connected ? s.connect : !l ? 'lifecycle sync' : null,
    }
  })
}

export const INSTALL_URL = 'https://github.com/jbauman-26/cosmic-lifecycle/releases/latest/download/cosmic-lifecycle.tgz'
export const LLMS_URL = 'https://raw.githubusercontent.com/jbauman-26/cosmic-lifecycle/main/llms.txt'

// The text a person pastes into Claude Code, Cursor or Codex to have their agent run a kit.
export function kitPrompt(kit: { name: string; title: string; needs: string[] }) {
  return [
    `Run the Cosmic Lifecycle "${kit.title}" kit for my store.`,
    `If \`lifecycle\` is not installed, follow ${LLMS_URL} first, connecting ${kit.needs.join(' and ')}.`,
    `Then run \`lifecycle kits add ${kit.name}\` and follow lifecycle-kits/${kit.name}/AGENT.md in order, including the Verify checklist.`,
    'Never ask me to paste a key into this chat. Use environment variables.',
  ].join(' ')
}
