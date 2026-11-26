import { existsSync } from 'node:fs';
import { configPath } from '../paths.js';
import { readConfig } from '../config.js';
import { getSecret, keepRotated } from '../secrets.js';
import { openDb } from '../db.js';
import { Klaviyo, reportsVerified } from '../sources/klaviyo.js';
import { shopifyToken } from '../sources/shopify.js';
import { Stripe } from '../sources/stripe.js';
import { MetaAds } from '../sources/meta.js';
import { HubSpot } from '../sources/hubspot.js';
import { readWorkspace, REFERENCE_NAME } from '../workspace.js';
import { GoogleAds, googleAdsAccessToken } from '../sources/google-ads.js';
import { MerchantCenter, merchantAccessToken } from '../sources/google-merchant-center.js';
import { MicrosoftAds, microsoftAdsAccessToken } from '../sources/microsoft-ads.js';
import { LinkedinAds, linkedinAccessToken } from '../sources/linkedin-ads.js';
import { RedditAds, redditAccessToken } from '../sources/reddit-ads.js';
import { SnapchatAds, snapAccessToken } from '../sources/snapchat-ads.js';
import { TikTokAds } from '../sources/tiktok-ads.js';
import { PinterestAds, pinterestAccessToken } from '../sources/pinterest-ads.js';
import { CliError } from '../errors.js';
export async function doctor() {
    const checks = [];
    if (!existsSync(configPath())) {
        return { healthy: false, checks: [{ name: 'setup', ok: false, detail: 'Not set up.', next: 'lifecycle init' }] };
    }
    const config = readConfig();
    checks.push({ name: 'setup', ok: true, detail: `Database: ${config.database.kind}` });
    // A store needs Klaviyo and Shopify, as in 0.13. Any other workspace needs its source of truth,
    // and Klaviyo and Shopify are checked only once connected.
    const ws = readWorkspace();
    const store = ws.type === 'shopify' && ws.reference === 'shopify';
    if (!store) {
        // 0.19.0: a source read from the person's own Fivetran or Airbyte tables counts as connected.
        const piped = Boolean(config.pipeline?.sources?.[ws.reference]);
        const has = ws.reference === 'none' ? false : piped || (ws.reference === 'shopify' ? Boolean(config.shopify) : Boolean(config[ws.reference]));
        if (ws.reference === 'none')
            checks.push({ name: 'reference', ok: true, detail: 'No source of truth set, so numbers are not checked against one.', next: 'lifecycle config set workspace.reference stripe (or hubspot, shopify, ga4)' });
        else
            checks.push({ name: 'reference', ok: has, detail: has ? `${REFERENCE_NAME[ws.reference]} is connected as the source of truth.` : `${REFERENCE_NAME[ws.reference]} is this workspace's source of truth and is not connected.`, ...(has ? {} : { next: `lifecycle connect ${ws.reference}` }) });
    }
    const klaviyoKey = getSecret('klaviyo-read-key');
    if (!klaviyoKey && !store) {
        // Optional outside a store.
    }
    else if (!klaviyoKey)
        checks.push({ name: 'klaviyo', ok: false, detail: 'Not connected.', next: 'lifecycle connect klaviyo --key-env NAME' });
    else {
        try {
            const a = await new Klaviyo(klaviyoKey).account();
            checks.push({ name: 'klaviyo', ok: true, detail: `Key works for ${a.name ?? a.id}` });
        }
        catch {
            checks.push({ name: 'klaviyo', ok: false, detail: 'Key was refused.', next: 'Create a Read-Only key, then lifecycle connect klaviyo --key-env NAME' });
        }
        if (!reportsVerified)
            checks.push({ name: 'klaviyo-reports', ok: true, detail: 'Warning: flow report parsing is untested on real sends.' });
    }
    const secret = getSecret('shopify-client-secret');
    if (!store && !config.shopify) {
        // Optional outside a store.
    }
    else if (!config.shopify || !secret)
        checks.push({ name: 'shopify', ok: false, detail: 'Not connected.', next: 'lifecycle connect shopify --store NAME.myshopify.com --client-id ID --secret-env NAME' });
    else {
        try {
            await shopifyToken(config.shopify.store, config.shopify.clientId, secret);
            checks.push({ name: 'shopify', ok: true, detail: `Token works for ${config.shopify.store}` });
        }
        catch {
            checks.push({ name: 'shopify', ok: false, detail: 'Token request failed.', next: 'Check the app is installed, then lifecycle connect shopify' });
        }
    }
    // Stripe is optional, so it is only checked once connected.
    // Meta Ads is optional too.
    const metaToken = getSecret('meta-ads-token');
    if (config.meta && !metaToken)
        checks.push({ name: 'meta', ok: false, detail: 'Connected, but the token is missing.', next: 'lifecycle connect meta --account ID --token-env NAME' });
    else if (config.meta && metaToken) {
        try {
            const a = await new MetaAds(metaToken, config.meta.account).check();
            checks.push({ name: 'meta', ok: true, detail: `Token reads insights for ${a.name || a.id} in ${a.currency}` });
        }
        catch (e) {
            checks.push({ name: 'meta', ok: false, detail: e instanceof Error ? e.message : 'Token was refused.', next: 'Create a new system user token with ads_read, then lifecycle connect meta --account ID --token-env NAME' });
        }
    }
    const gads = config['google-ads'];
    const gadsSecret = getSecret('google-ads-client-secret');
    const gadsRefresh = getSecret('google-ads-refresh-token');
    if (gads && (!gadsSecret || !gadsRefresh))
        checks.push({ name: 'google-ads', ok: false, detail: 'Connected, but the client secret or refresh token is missing.', next: 'lifecycle connect google-ads --customer ID --client-id ID --secret-env NAME --refresh-token-env NAME' });
    else if (gads && gadsSecret && gadsRefresh) {
        try {
            const a = await new GoogleAds(await googleAdsAccessToken(gads.clientId, gadsSecret, gadsRefresh), gads.customer, gads.loginCustomer).check();
            checks.push({ name: 'google-ads', ok: true, detail: `Sign-in reads ${a.name || a.customer} in ${a.currency}${a.testAccount ? ' (a test account)' : ''}` });
        }
        catch (e) {
            checks.push({ name: 'google-ads', ok: false, detail: e instanceof Error ? e.message : 'Sign-in was refused.', next: e instanceof CliError ? e.next : 'lifecycle connect google-ads' });
        }
    }
    const msads = config['microsoft-ads'];
    const msSecret = getSecret('microsoft-ads-client-secret');
    const msRefresh = getSecret('microsoft-ads-refresh-token');
    const msDeveloper = getSecret('microsoft-ads-developer-token');
    if (msads && (!msSecret || !msRefresh || !msDeveloper))
        checks.push({ name: 'microsoft-ads', ok: false, detail: 'Connected, but the client secret, refresh token or developer token is missing.', next: 'lifecycle connect microsoft-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME --developer-token-env NAME' });
    else if (msads && msSecret && msRefresh && msDeveloper) {
        try {
            const t = await microsoftAdsAccessToken(msads.clientId, msSecret, msRefresh);
            keepRotated('microsoft-ads-refresh-token', t.refreshToken, msRefresh);
            const a = await new MicrosoftAds(t.accessToken, msDeveloper, msads.account, msads.customer).check();
            checks.push({ name: 'microsoft-ads', ok: true, detail: `Sign-in reads ${a.name || a.account} in ${a.currency}` });
        }
        catch (e) {
            checks.push({ name: 'microsoft-ads', ok: false, detail: e instanceof Error ? e.message : 'Sign-in was refused.', next: e instanceof CliError ? e.next : 'lifecycle connect microsoft-ads' });
        }
    }
    const liads = config['linkedin-ads'];
    const liSecret = getSecret('linkedin-ads-client-secret');
    const liRefresh = getSecret('linkedin-ads-refresh-token');
    if (liads && (!liSecret || !liRefresh))
        checks.push({ name: 'linkedin-ads', ok: false, detail: 'Connected, but the client secret or refresh token is missing.', next: 'lifecycle connect linkedin-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME' });
    else if (liads && liSecret && liRefresh) {
        try {
            const a = await new LinkedinAds(await linkedinAccessToken(liads.clientId, liSecret, liRefresh), liads.account).check();
            checks.push({ name: 'linkedin-ads', ok: true, detail: `Sign-in reads ${a.name || a.account} in ${a.currency}${a.test ? ' (a test account, which LinkedIn reports nothing for)' : ''}` });
        }
        catch (e) {
            checks.push({ name: 'linkedin-ads', ok: false, detail: e instanceof Error ? e.message : 'Sign-in was refused.', next: e instanceof CliError ? e.next : 'lifecycle connect linkedin-ads' });
        }
    }
    const rads = config['reddit-ads'];
    const radsSecret = getSecret('reddit-ads-client-secret');
    const radsRefresh = getSecret('reddit-ads-refresh-token');
    if (rads && (!radsSecret || !radsRefresh))
        checks.push({ name: 'reddit-ads', ok: false, detail: 'Connected, but the app secret or refresh token is missing.', next: 'lifecycle connect reddit-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME' });
    else if (rads && radsSecret && radsRefresh) {
        try {
            const a = await new RedditAds(await redditAccessToken(rads.clientId, radsSecret, radsRefresh), rads.account).check();
            checks.push({ name: 'reddit-ads', ok: true, detail: `Sign-in reads ${a.name || a.account} in ${a.currency}` });
        }
        catch (e) {
            checks.push({ name: 'reddit-ads', ok: false, detail: e instanceof Error ? e.message : 'Sign-in was refused.', next: e instanceof CliError ? e.next : 'lifecycle connect reddit-ads' });
        }
    }
    const sads = config['snapchat-ads'];
    const sadsSecret = getSecret('snapchat-ads-client-secret');
    const sadsRefresh = getSecret('snapchat-ads-refresh-token');
    if (sads && (!sadsSecret || !sadsRefresh))
        checks.push({ name: 'snapchat-ads', ok: false, detail: 'Connected, but the client secret or refresh token is missing.', next: 'lifecycle connect snapchat-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME' });
    else if (sads && sadsSecret && sadsRefresh) {
        try {
            const a = await new SnapchatAds(await snapAccessToken(sads.clientId, sadsSecret, sadsRefresh), sads.account).check();
            checks.push({ name: 'snapchat-ads', ok: true, detail: `Sign-in reads ${a.name || a.account} in ${a.currency}` });
        }
        catch (e) {
            checks.push({ name: 'snapchat-ads', ok: false, detail: e instanceof Error ? e.message : 'Sign-in was refused.', next: e instanceof CliError ? e.next : 'lifecycle connect snapchat-ads' });
        }
    }
    const tiktok = config['tiktok-ads'];
    const tiktokToken = getSecret('tiktok-ads-access-token');
    if (tiktok && !tiktokToken)
        checks.push({ name: 'tiktok-ads', ok: false, detail: 'Connected, but the access token is missing.', next: 'lifecycle connect tiktok-ads --account ID --app-id ID --token-env NAME' });
    else if (tiktok && tiktokToken) {
        try {
            const a = await new TikTokAds(tiktokToken, tiktok.account).check();
            checks.push({ name: 'tiktok-ads', ok: true, detail: `Token reads ${a.name || a.account} in ${a.currency}` });
        }
        catch (e) {
            checks.push({ name: 'tiktok-ads', ok: false, detail: e instanceof Error ? e.message : 'Token was refused.', next: e instanceof CliError ? e.next : 'lifecycle connect tiktok-ads' });
        }
    }
    const pins = config['pinterest-ads'];
    const pinsSecret = getSecret('pinterest-ads-client-secret');
    const pinsRefresh = getSecret('pinterest-ads-refresh-token');
    if (pins && (!pinsSecret || !pinsRefresh))
        checks.push({ name: 'pinterest-ads', ok: false, detail: 'Connected, but the client secret or refresh token is missing.', next: 'lifecycle connect pinterest-ads --account ID --client-id ID --secret-env NAME --refresh-token-env NAME' });
    else if (pins && pinsSecret && pinsRefresh) {
        try {
            const t = await pinterestAccessToken(pins.clientId, pinsSecret, pinsRefresh);
            keepRotated('pinterest-ads-refresh-token', t.refreshToken, pinsRefresh);
            const a = await new PinterestAds(t.accessToken, pins.account).check();
            checks.push({ name: 'pinterest-ads', ok: true, detail: `Sign-in reads ${a.name || a.account} in ${a.currency}` });
        }
        catch (e) {
            checks.push({ name: 'pinterest-ads', ok: false, detail: e instanceof Error ? e.message : 'Sign-in was refused.', next: e instanceof CliError ? e.next : 'lifecycle connect pinterest-ads' });
        }
    }
    const stripeKey = getSecret('stripe-read-key');
    if (config.stripe && !stripeKey)
        checks.push({ name: 'stripe', ok: false, detail: 'Connected, but the key is missing.', next: 'lifecycle connect stripe --key-env NAME' });
    else if (config.stripe && stripeKey) {
        try {
            const r = await new Stripe(stripeKey).check();
            checks.push({ name: 'stripe', ok: true, detail: `Key reads charges in ${config.stripe.mode} mode${r.subscriptions ? ' and subscriptions' : ', not subscriptions'}` });
        }
        catch {
            checks.push({ name: 'stripe', ok: false, detail: 'Key was refused.', next: 'Create a restricted key with Read on Charges and Subscriptions, then lifecycle connect stripe --key-env NAME' });
        }
    }
    const gmc = config['google-merchant-center'];
    const gmcSecret = getSecret('google-merchant-center-client-secret');
    const gmcRefresh = getSecret('google-merchant-center-refresh-token');
    if (gmc && (!gmcSecret || !gmcRefresh))
        checks.push({ name: 'google-merchant-center', ok: false, detail: 'Connected, but the client secret or refresh token is missing.', next: 'lifecycle connect google-merchant-center --account ID --client-id ID --secret-env NAME --refresh-token-env NAME' });
    else if (gmc && gmcSecret && gmcRefresh) {
        try {
            const a = await new MerchantCenter(await merchantAccessToken(gmc.clientId, gmcSecret, gmcRefresh), gmc.account).check();
            checks.push({ name: 'google-merchant-center', ok: true, detail: `Sign-in reads reports for ${a.name || a.account}` });
        }
        catch (e) {
            checks.push({ name: 'google-merchant-center', ok: false, detail: e instanceof Error ? e.message : 'Sign-in was refused.', next: e instanceof CliError ? e.next : 'lifecycle connect google-merchant-center' });
        }
    }
    const hubspotToken = getSecret('hubspot-token');
    if (config.hubspot && !hubspotToken)
        checks.push({ name: 'hubspot', ok: false, detail: 'Connected, but the token is missing.', next: 'lifecycle connect hubspot --token-env NAME' });
    else if (config.hubspot && hubspotToken) {
        try {
            await new HubSpot(hubspotToken).check();
            checks.push({ name: 'hubspot', ok: true, detail: 'Token reads deals and contacts' });
        }
        catch (e) {
            checks.push({ name: 'hubspot', ok: false, detail: e instanceof Error ? e.message : 'Token was refused.', next: 'lifecycle connect hubspot --token-env NAME' });
        }
    }
    let db;
    try {
        db = await openDb();
        const last = await db.query(`SELECT DISTINCT ON (source) source, status, finished_at, detail FROM meta_sync_run ORDER BY source, started_at DESC`);
        if (!last.length)
            checks.push({ name: 'sync', ok: false, detail: 'Nothing synced yet.', next: 'lifecycle sync' });
        for (const r of last) {
            const age = r.finished_at ? (Date.now() - new Date(r.finished_at).getTime()) / 86400000 : Infinity;
            const fresh = age < 2;
            checks.push({
                name: `sync:${r.source}`,
                ok: r.status !== 'failed' && fresh,
                detail: `${r.status}${r.detail ? `: ${r.detail}` : ''}${fresh ? '' : ' (more than 2 days old)'}`,
                ...(r.status === 'failed' || !fresh ? { next: 'lifecycle sync' } : {}),
            });
        }
    }
    catch (e) {
        checks.push({ name: 'database', ok: false, detail: e instanceof Error ? e.message : String(e), next: 'lifecycle init' });
    }
    finally {
        await db?.close();
    }
    return { healthy: checks.every((c) => c.ok), checks };
}
