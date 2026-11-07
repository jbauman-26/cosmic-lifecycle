import { existsSync } from 'node:fs';
import { configPath } from '../paths.js';
import { readConfig } from '../config.js';
import { getSecret } from '../secrets.js';
import { openDb } from '../db.js';
import { Klaviyo, reportsVerified } from '../sources/klaviyo.js';
import { shopifyToken } from '../sources/shopify.js';
import { Stripe } from '../sources/stripe.js';
export async function doctor() {
    const checks = [];
    if (!existsSync(configPath())) {
        return { healthy: false, checks: [{ name: 'setup', ok: false, detail: 'Not set up.', next: 'lifecycle init' }] };
    }
    const config = readConfig();
    checks.push({ name: 'setup', ok: true, detail: `Database: ${config.database.kind}` });
    const klaviyoKey = getSecret('klaviyo-read-key');
    if (!klaviyoKey)
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
    if (!config.shopify || !secret)
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
