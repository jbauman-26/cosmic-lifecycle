import type { Config } from './config.js'
import type { Tx } from './db.js'
import { noun, readWorkspace } from './workspace.js'

// What this CLI can connect today. Only sources with a working connector are listed:
// a source that is planned but not built is not in the catalog.
export type CatalogSource = {
  slug: 'klaviyo' | 'shopify' | 'ga4' | 'stripe' | 'meta' | 'hubspot' | 'google-ads' | 'tiktok-ads' | 'pinterest-ads'
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
  {
    slug: 'stripe',
    name: 'Stripe',
    syncs: 'Daily charges, refunds, failed payments, new and repeat paying customers, subscription starts and ends, MRR. No customer records.',
    credential: 'Restricted key with Read on Charges and Subscriptions. Nothing else.',
    setupMinutes: 3,
    connect: 'lifecycle connect stripe --key-env STRIPE_READ_KEY',
    tested: 'Run live on a Stripe test-mode account, and every total matched the Stripe API. Refunds and several currencies are unit tested only. Not yet run on a live account.',
  },
  {
    slug: 'meta',
    name: 'Meta Ads',
    syncs: 'Daily spend, impressions, clicks, and the purchases and purchase value Meta attributes to its ads, by campaign. No audiences, people or creative.',
    credential: 'System user access token with ads_read only, plus the ad account id.',
    setupMinutes: 10,
    connect: 'lifecycle connect meta --account ID --token-env META_ADS_TOKEN',
    tested: 'Written from the Ads Insights API docs (v27.0) and tested against recorded answers. Not yet run on a live ad account.',
  },
  {
    slug: 'google-ads',
    name: 'Google Ads',
    syncs: 'Daily cost, impressions, clicks, and the conversions and conversion value Google attributes to its ads, by campaign and by ad group. No audiences, keywords, search terms, people or creative.',
    credential: 'OAuth client id and secret, plus a refresh token from Google sign-in with the adwords scope. Only read calls are made.',
    setupMinutes: 10,
    connect: 'lifecycle connect google-ads --customer 123-456-7890 --client-id ID --secret-env NAME --refresh-token-env NAME',
    tested: 'Written from the Google Ads API docs (v26) and tested against recorded answers. Not yet run on a live or test account.',
  },
  {
    slug: 'tiktok-ads',
    name: 'TikTok Ads',
    syncs: 'Daily spend, impressions, clicks, and the website purchases and purchase value TikTok attributes to its ads, by campaign. No audiences, creatives or people.',
    credential: 'Long-term advertiser access token from an app with the Reporting permission, plus the advertiser id and app id. Only read calls are made.',
    setupMinutes: 10,
    connect: 'lifecycle connect tiktok-ads --account ADVERTISER_ID --app-id ID --token-env NAME',
    tested: 'Written from the TikTok API for Business docs (v1.3) and tested against recorded answers. Not yet run on a live ad account.',
  },
  {
    slug: 'pinterest-ads',
    name: 'Pinterest Ads',
    syncs: 'Daily spend, impressions, clicks, and the checkouts and checkout value Pinterest attributes to its ads, by campaign. No audiences, pins, creatives or people.',
    credential: 'Pinterest app id and secret, plus a refresh token from Pinterest sign-in with the ads:read scope. Only read calls are made.',
    setupMinutes: 10,
    connect: 'lifecycle connect pinterest-ads --account AD_ACCOUNT_ID --client-id ID --secret-env NAME --refresh-token-env NAME',
    tested: 'Written from the Pinterest API v5 docs (spec 5.32.0) and tested against recorded answers. Not yet run on a live ad account.',
  },
]

// Built in from 0.14.0. Kept out of CATALOG, the list Shopify stores have always seen first,
// and shown after it everywhere: sources catalog, sources list, the MCP catalog.
export const HUBSPOT: CatalogSource = {
  slug: 'hubspot',
  name: 'HubSpot',
  syncs: 'Daily deals created, won and lost with amounts, open pipeline by stage, and new contacts by original source and lifecycle stage. Counts only: no contact, company or deal record, and no name, email or phone is ever requested.',
  credential: 'Private app access token with crm.objects.deals.read and crm.objects.contacts.read. Nothing else.',
  setupMinutes: 5,
  connect: 'lifecycle connect hubspot --token-env HUBSPOT_TOKEN',
  tested: 'Written from the HubSpot CRM API v3 docs and tested against recorded answers. Not yet run on a real portal.',
}
export const ALL_NATIVE: CatalogSource[] = [...CATALOG, HUBSPOT]

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
  // A store sees the 0.13 list until it connects HubSpot.
  const list = readWorkspace().type === 'shopify' && !config?.hubspot ? CATALOG : ALL_NATIVE
  const native = list.map((s) => {
    const configured = Boolean(config?.[s.slug])
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
  // Custom sources exist once a CSV has been imported, and are refreshed by importing again.
  const custom = [...last.entries()]
    .filter(([source]) => source.startsWith('custom:'))
    .map(([source, l]) => ({ slug: source, name: `${source.slice(7)} (custom CSV)`, connected: true, lastSync: l.at, lastStatus: l.status, next: null }))
  return [...native, ...custom]
}

// Any tool not in the catalog can still be brought in as daily totals.
export const CUSTOM_SOURCE_NOTE = 'Any other source: export daily totals to CSV, then lifecycle sources import NAME --csv FILE. Columns that look like personal data are refused.'

// The repo is private, so there is no public install or llms.txt link to hand out.
// The setup playbook ships inside the CLI.
export const QUICKSTART_COMMAND = 'lifecycle docs quickstart'

// The text a person pastes into Claude Code, Cursor or Codex to have their agent run a kit.
export function kitPrompt(kit: { name: string; title: string; needs: string[] }) {
  return [
    `Run the Cosmic Lifecycle "${kit.title}" kit for my ${noun()}.`,
    `If \`lifecycle\` is not set up yet, follow the output of \`${QUICKSTART_COMMAND}\` first, connecting ${kit.needs.join(' and ')}. The CLI ships inside the Cosmic AI app and Cosmic Cloud.`,
    `Then run \`lifecycle kits add ${kit.name}\` and follow lifecycle-kits/${kit.name}/AGENT.md in order, including the Verify checklist.`,
    'Never ask me to paste a key into this chat. Use environment variables.',
  ].join(' ')
}
