export const CATALOG = [
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
];
// Connected means configured with a key present. lastSync comes from the database when it is reachable.
export async function sourceStatus(config, hasKey, db) {
    const last = new Map();
    if (db) {
        try {
            const rows = await db.query(`SELECT DISTINCT ON (source) source, status, coalesce(finished_at, started_at) AS at FROM meta_sync_run ORDER BY source, started_at DESC`);
            for (const r of rows)
                last.set(String(r.source), { at: new Date(String(r.at)).toISOString(), status: String(r.status) });
        }
        catch {
            // No sync table yet: nothing has synced.
        }
    }
    const native = CATALOG.map((s) => {
        const configured = Boolean(config?.[s.slug]);
        const connected = configured && hasKey(s.slug);
        const l = last.get(s.slug);
        return {
            slug: s.slug,
            name: s.name,
            connected,
            lastSync: l?.at ?? null,
            lastStatus: l?.status ?? null,
            next: !config ? 'lifecycle init' : !connected ? s.connect : !l ? 'lifecycle sync' : null,
        };
    });
    // Custom sources exist once a CSV has been imported, and are refreshed by importing again.
    const custom = [...last.entries()]
        .filter(([source]) => source.startsWith('custom:'))
        .map(([source, l]) => ({ slug: source, name: `${source.slice(7)} (custom CSV)`, connected: true, lastSync: l.at, lastStatus: l.status, next: null }));
    return [...native, ...custom];
}
// Any tool not in the catalog can still be brought in as daily totals.
export const CUSTOM_SOURCE_NOTE = 'Any other source: export daily totals to CSV, then lifecycle sources import NAME --csv FILE. Columns that look like personal data are refused.';
// The repo is private, so there is no public install or llms.txt link to hand out.
// The setup playbook ships inside the CLI.
export const QUICKSTART_COMMAND = 'lifecycle docs quickstart';
// The text a person pastes into Claude Code, Cursor or Codex to have their agent run a kit.
export function kitPrompt(kit) {
    return [
        `Run the Cosmic Lifecycle "${kit.title}" kit for my store.`,
        `If \`lifecycle\` is not set up yet, follow the output of \`${QUICKSTART_COMMAND}\` first, connecting ${kit.needs.join(' and ')}. The CLI ships inside the Cosmic AI app and Cosmic Cloud.`,
        `Then run \`lifecycle kits add ${kit.name}\` and follow lifecycle-kits/${kit.name}/AGENT.md in order, including the Verify checklist.`,
        'Never ask me to paste a key into this chat. Use environment variables.',
    ].join(' ');
}
