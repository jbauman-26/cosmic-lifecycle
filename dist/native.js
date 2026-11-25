import { randomUUID } from 'node:crypto';
import { readRawConfig, removeConfigSection } from './config.js';
import { CliError } from './errors.js';
import { deleteSecret, envName } from './secrets.js';
import { clearState } from './shopify-state.js';
// The sources built into the CLI. Each one has a config section written by
// connect, the keys it saved, and the tables only it fills.
export const NATIVE = ['shopify', 'klaviyo', 'ga4', 'stripe', 'meta', 'hubspot', 'google-ads', 'google-merchant-center', 'reddit-ads', 'snapchat-ads'];
export const NATIVE_SECRETS = {
    // The store key goes with the store: disconnecting Shopify deletes it, and the scrambled ids it made (below).
    shopify: ['shopify-client-secret', 'shopify-customer-key'],
    klaviyo: ['klaviyo-read-key', 'klaviyo-write-key'],
    ga4: ['ga4-client-secret', 'ga4-refresh-token'],
    stripe: ['stripe-read-key'],
    meta: ['meta-ads-token'],
    hubspot: ['hubspot-token'],
    'google-ads': ['google-ads-client-secret', 'google-ads-refresh-token'],
    'google-merchant-center': ['google-merchant-center-client-secret', 'google-merchant-center-refresh-token'],
    'reddit-ads': ['reddit-ads-client-secret', 'reddit-ads-refresh-token'],
    'snapchat-ads': ['snapchat-ads-client-secret', 'snapchat-ads-refresh-token'],
};
// Tables only this source writes. meta_sync_run is kept on purpose: it is the
// history of what ran, and the disconnect is recorded in it.
export const NATIVE_TABLES = {
    shopify: ['fact_orders_daily', 'fact_cohort_monthly'],
    klaviyo: ['dim_flow', 'dim_campaign', 'dim_segment', 'fact_flow_daily', 'fact_flow_window', 'fact_klaviyo_orders_daily'],
    ga4: ['fact_ga4_daily'],
    stripe: ['fact_stripe_daily', 'fact_stripe_subscriptions_daily', 'fact_stripe_mrr'],
    meta: ['fact_meta_ads_daily'],
    hubspot: ['fact_crm_deals_daily', 'fact_crm_pipeline_open', 'fact_crm_contacts_daily'],
    'google-ads': ['fact_google_ads_campaign_daily', 'fact_google_ads_ad_group_daily'],
    'google-merchant-center': ['fact_merchant_performance_daily', 'fact_merchant_products_daily'],
    'reddit-ads': ['fact_reddit_ads_daily'],
    'snapchat-ads': ['fact_snapchat_ads_daily'],
};
export const isNative = (s) => NATIVE.includes(s);
// `--only shopify --only meta` and `--only shopify,meta` mean the same thing.
export function parseOnly(values) {
    if (!values?.length)
        return null;
    const list = [...new Set(values.flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase()).filter(Boolean))];
    if (!list.length)
        return null;
    const unknown = list.filter((s) => !isNative(s));
    if (unknown.length) {
        throw new CliError(`Not a built-in source: ${unknown.join(', ')}.`, `Use one or more of ${NATIVE.join(', ')}. Warehouse sources sync with lifecycle warehouse sync SLUG.`, 'unknown_source');
    }
    return list;
}
// Which sources a sync runs: every connected one, or only the ones asked for.
// Asking for a source that is not connected is an error, so a scheduled
// one-source sync never passes quietly with nothing done.
export function chooseSources(only, connected) {
    if (!only)
        return NATIVE.filter((s) => connected[s]);
    const missing = only.filter((s) => !connected[s]);
    if (missing.length) {
        throw new CliError(`Not connected: ${missing.join(', ')}.`, `lifecycle connect ${missing[0]} (see lifecycle sources list)`, 'not_connected');
    }
    return NATIVE.filter((s) => only.includes(s));
}
// Forgets a native source: its config section and its saved keys. Loaded data is
// kept unless deleteData is set, so a person can reconnect without losing history.
export async function disconnectNative(source, opts = {}) {
    if (!isNative(source)) {
        throw new CliError(`Not a built-in source: ${source}.`, `Use one of ${NATIVE.join(', ')}. For a warehouse source: lifecycle warehouse disconnect SLUG`, 'unknown_source');
    }
    const remove = opts.remove ?? ((name) => deleteSecret(name).removed);
    const hadConfig = source in readRawConfig();
    const keysRemoved = NATIVE_SECRETS[source].filter((name) => remove(name));
    const stillInEnvironment = NATIVE_SECRETS[source].map(envName).filter((env) => Boolean(process.env[env]));
    if (!hadConfig && !keysRemoved.length && !stillInEnvironment.length) {
        throw new CliError(`${source} is not connected.`, 'lifecycle sources list', 'not_connected');
    }
    const configRemoved = removeConfigSection(source);
    const dataDeleted = [];
    if (opts.db) {
        if (opts.deleteData) {
            await opts.db.transaction(async (tx) => {
                for (const t of NATIVE_TABLES[source]) {
                    await tx.query(`DELETE FROM ${t}`);
                    dataDeleted.push(t);
                }
                await tx.query('DELETE FROM meta_source_total WHERE source = $1', [source]);
                await tx.query('DELETE FROM meta_source_window WHERE source = $1', [source]);
            });
        }
        // The scrambled customer ids are only usable with the key, which was just deleted, so they go too, data kept or not.
        if (source === 'shopify')
            await opts.db.transaction((tx) => clearState(tx));
        // Logged as a run, so freshness stops counting this source and the history shows when it left.
        const at = new Date().toISOString();
        await opts.db.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status, rows_written, detail) VALUES ($1, $2, $3, $3, 'disconnected', 0, $4)`, [randomUUID(), source, at, opts.deleteData ? 'Disconnected. Its data was deleted.' : 'Disconnected. Its data was kept.']);
    }
    else if (opts.deleteData) {
        throw new CliError('The database could not be opened, so no data was deleted.', 'lifecycle doctor, then lifecycle disconnect SOURCE --delete-data again', 'no_database');
    }
    const notes = [
        source === 'shopify' && opts.db ? 'Its store key and the scrambled customer ids made with it were deleted.' : '',
        opts.deleteData ? `Deleted its data from ${dataDeleted.join(', ')}.` : `Its data is kept in ${NATIVE_TABLES[source].join(', ')}. Add --delete-data to remove it.`,
        stillInEnvironment.length ? `${stillInEnvironment.join(' and ')} ${stillInEnvironment.length === 1 ? 'is' : 'are'} still set in the environment, so sync will keep using ${stillInEnvironment.length === 1 ? 'it' : 'them'}. Unset ${stillInEnvironment.length === 1 ? 'it' : 'them'} too.` : '',
    ].filter(Boolean);
    return { source, disconnected: true, configRemoved, keysRemoved, stillInEnvironment, dataDeleted, note: notes.join(' ') };
}
