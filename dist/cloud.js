import { CliError } from './errors.js';
import { isPersonalColumn } from './personal.js';
import { sourceOfSchema } from './warehouse-names.js';
import { getSetting } from './config.js';
import { envName, getSecret } from './secrets.js';
// Cosmic Cloud: the hosted copy of a store's warehouse. `cosmic login` saves the Cloud
// address in config.json and the store token in the keychain. From then on `--cloud` on a
// read command asks Cloud instead of this machine's database.
//
// Three rules hold for every call here:
// 1. The token goes in the Authorization header and nowhere else. It is never printed,
//    logged or put in a URL, and any error text that repeats it is scrubbed.
// 2. The token is only sent over https, or to this machine (localhost) for tests.
// 3. A route Cloud does not have yet answers 404. That becomes code `not_built` with a
//    plain sentence, so an agent knows to wait for Cloud rather than retry.
// 4. The token only goes to an address the owner chose: LIFECYCLE_CLOUD_URL or the one `login`
//    saved. With neither (after `logout`, say), a token left in the environment is not sent to
//    the public address: the command stops with `not_logged_in` before anything leaves.
export const DEFAULT_CLOUD_URL = 'https://cloud.cosmicai.tech';
export const CLOUD_URL_ENV = 'LIFECYCLE_CLOUD_URL';
export const CLOUD_TOKEN_ENV = envName('cloud-token');
const TIMEOUT_MS = 30_000;
const LOGIN_NEXT = 'cosmic login --token-env YOUR_VAR';
const isLoopback = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
// Accepts the site address with or without /api/v1 on the end, and returns it without.
export function normalizeCloudUrl(raw) {
    let u;
    try {
        u = new URL(raw.trim());
    }
    catch {
        throw new CliError('That is not a web address.', `cosmic login --url ${DEFAULT_CLOUD_URL} --token-env YOUR_VAR`, 'bad_url');
    }
    if (u.username || u.password || u.search || u.hash)
        throw new CliError('The Cloud address must be a plain address, with no sign-in, query or fragment in it.', `cosmic login --url ${DEFAULT_CLOUD_URL} --token-env YOUR_VAR`, 'bad_url');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) {
        throw new CliError('The Cloud address must start with https, so the workspace token is never sent in the clear.', `cosmic login --url ${DEFAULT_CLOUD_URL} --token-env YOUR_VAR`, 'bad_url');
    }
    const path = u.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    return `${u.origin}${path}`;
}
// Priority: LIFECYCLE_CLOUD_URL, then the address login saved, then the public address.
export function cloudUrl() {
    const fromEnv = process.env[CLOUD_URL_ENV];
    if (fromEnv)
        return { url: normalizeCloudUrl(fromEnv), source: 'env' };
    let saved;
    try {
        saved = getSetting('cloud.url');
    }
    catch {
        saved = undefined;
    }
    if (typeof saved === 'string' && saved)
        return { url: normalizeCloudUrl(saved), source: 'config' };
    return { url: DEFAULT_CLOUD_URL, source: 'default' };
}
export const cloudToken = () => getSecret('cloud-token');
// Where a --cloud command would send the token, or null when the owner never chose an address.
export function chosenCloudUrl() {
    try {
        const u = cloudUrl();
        return u.source === 'default' ? null : u.url;
    }
    catch {
        return null;
    }
}
// Logged in means a token and an address the owner chose. A token alone is not enough.
export const loggedIn = () => Boolean(cloudToken()) && chosenCloudUrl() !== null;
export const cloudTokenSource = () => (process.env[CLOUD_TOKEN_ENV] ? 'env' : cloudToken() ? 'keychain' : 'missing');
// Text that came from the server is shown to a person or an agent: one line, no control characters, not too long.
export const clean = (text, max = 300) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, max);
const list = (body, key) => (Array.isArray(body) ? body : Array.isArray(body?.[key]) ? body[key] : []);
export class CloudClient {
    url;
    token;
    fetchFn;
    timeoutMs;
    constructor(opts = {}) {
        const token = opts.token ?? cloudToken();
        if (!token)
            throw new CliError('Not logged in to Cosmic Cloud.', LOGIN_NEXT, 'not_logged_in');
        if (opts.url) {
            this.url = normalizeCloudUrl(opts.url);
        }
        else {
            // Never fall back to the public address: a token kept after logout must not go anywhere.
            if (cloudUrl().source === 'default')
                throw new CliError('Not logged in to Cosmic Cloud.', LOGIN_NEXT, 'not_logged_in');
            this.url = cloudUrl().url;
        }
        // A token is plain printable text. Anything else cannot go in a header, and is not a token.
        if (!/^[\x21-\x7e]+$/.test(token))
            throw new CliError('That token has spaces, line breaks or other characters a token never has.', 'Copy the token again from Cosmic Cloud under Settings, export it, then run cosmic login again.', 'bad_token');
        this.token = token;
        this.fetchFn = opts.fetch ?? fetch;
        this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    }
    // Never let the token out in a message, even if the server echoes it back.
    scrub(text) {
        return clean(text.split(this.token).join('[token]'));
    }
    async call(c) {
        const route = `${c.method} ${c.path.split('?')[0]}`;
        let res;
        try {
            res = await this.fetchFn(`${this.url}/api/v1${c.path}`, {
                method: c.method,
                headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(c.body === undefined ? {} : { 'content-type': 'application/json' }) },
                ...(c.body === undefined ? {} : { body: JSON.stringify(c.body) }),
                // A redirect could carry the request to another host. Stop instead of following it.
                redirect: 'manual',
                signal: AbortSignal.timeout(c.timeoutMs ?? this.timeoutMs),
            });
        }
        catch (e) {
            const why = e instanceof Error && e.name === 'TimeoutError' ? 'it did not answer in time' : 'it could not be reached';
            throw new CliError(`Cosmic Cloud did not answer: ${why}.`, 'Check the network and the address in cosmic cloud status, then run this again.', 'cloud_unreachable');
        }
        const text = await res.text().catch(() => '');
        let body = null;
        try {
            body = text ? JSON.parse(text) : null;
        }
        catch {
            body = null;
        }
        if (res.ok)
            return body ?? {};
        if (res.status >= 300 && res.status < 400)
            throw new CliError('Cosmic Cloud answered with a redirect, which this CLI does not follow.', 'Check the address: cosmic cloud status', 'bad_url');
        const err = body?.error && typeof body.error === 'object' ? body.error : {};
        const code = typeof err.code === 'string' ? err.code : '';
        const message = typeof err.message === 'string' ? this.scrub(err.message) : '';
        const retry = Number(res.headers.get('retry-after') ?? err.retry_after_seconds);
        const wait = Number.isFinite(retry) && retry > 0 ? `Wait ${Math.ceil(retry)} seconds, then run this again.` : 'Wait a minute, then run this again.';
        if (res.status === 401)
            throw new CliError('Cosmic Cloud refused the workspace token. It may have been revoked.', `Create a new token in Cosmic Cloud under Settings, then ${LOGIN_NEXT}`, 'unauthorized');
        // Cloud answers 404 not_found for a route it does not have. Named 404s, such as unknown_metric, pass through.
        if (res.status === 404 && (!code || code === 'not_found'))
            throw new CliError(`Cosmic Cloud does not have this yet (${route}).`, 'It is being built. Until then, run the command without --cloud to use the data on this machine.', 'not_built');
        if (res.status === 405)
            throw new CliError(`Cosmic Cloud does not take ${route} yet.`, 'It is being built. Until then, run the command without --cloud to use the data on this machine.', 'not_built');
        if (res.status === 429)
            throw new CliError(message || 'Cosmic Cloud is getting too many calls from this workspace token.', wait, 'rate_limited');
        if (res.status === 503 && (!code || code === 'busy'))
            throw new CliError(message || 'Another change to this store is running on Cosmic Cloud.', wait, 'busy');
        if (code)
            throw new CliError(message || `Cosmic Cloud refused the request (${code}).`, res.status >= 500 ? 'Run this again in a moment.' : 'Fix the request, then run this again.', code);
        throw new CliError(`Cosmic Cloud answered with status ${res.status}.`, 'Run this again in a moment, then cosmic cloud status.', 'cloud_error');
    }
    store() {
        return this.call({ method: 'GET', path: '/store' });
    }
    async schema() {
        const r = await this.call({ method: 'GET', path: '/schema' });
        return { schemas: list(r, 'schemas').map((s) => ({ name: String(s.name), tables: (s.tables ?? []).map((t) => ({ name: String(t.name), columns: (t.columns ?? []).map((c) => ({ name: String(c.name), type: String(c.type), personal: c.personal === true || isPersonalColumn({ source: sourceOfSchema(String(s.name)), table: String(t.name), column: String(c.name), type: String(c.type) }) })), rows: typeof t.rows === 'number' ? t.rows : null })) })) };
    }
    // Rows come back as objects keyed by column, whether Cloud sends objects or arrays.
    async query(sql) {
        const r = await this.call({ method: 'POST', path: '/query', body: { sql } });
        const raw = Array.isArray(r.rows) ? r.rows : [];
        const first = raw.find((x) => x !== null && x !== undefined);
        const columns = Array.isArray(r.columns) ? r.columns.map((c) => (typeof c === 'string' ? c : String(c?.name ?? ''))) : first && !Array.isArray(first) ? Object.keys(first) : [];
        const rows = raw.map((row) => (Array.isArray(row) ? Object.fromEntries(columns.map((c, i) => [c, row[i] ?? null])) : row));
        return { columns, rows, rowCount: rows.length, truncated: Boolean(r.truncated) };
    }
    async metrics() {
        return list(await this.call({ method: 'GET', path: '/metrics' }), 'metrics');
    }
    metric(name, days) {
        return this.call({ method: 'GET', path: `/metrics/${encodeURIComponent(name)}${days === undefined ? '' : `?days=${days}`}` });
    }
    async runs(limit = 20) {
        return list(await this.call({ method: 'GET', path: `/runs?limit=${limit}` }), 'runs');
    }
    // Starting a sync is never retried here: a retry could start it twice.
    async sync(connectionId) {
        const r = await this.call({ method: 'POST', path: '/sync', ...(connectionId ? { body: { connection_id: connectionId } } : {}) });
        return { started: list(r.started, ''), already_running: list(r.already_running, '') };
    }
    // The list names each skill and its files. Cloud leaves the file text out of it, so the list stays small.
    async skills() {
        return list(await this.call({ method: 'GET', path: '/skills' }), 'skills');
    }
    async skill(slug) {
        const r = await this.call({ method: 'GET', path: `/skills/${encodeURIComponent(slug)}` });
        return (r?.skill ?? r);
    }
    // Every skill with its file text, for `skills sync`. A skill the list sent whole is not asked for
    // again. One deleted between the list and the read is left out.
    async skillsWithFiles() {
        const out = [];
        for (const s of await this.skills()) {
            const files = Array.isArray(s?.files) ? s.files : [];
            if (files.length && files.every((f) => typeof f?.content === 'string')) {
                out.push(s);
                continue;
            }
            if (typeof s?.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(s.slug)) {
                out.push(s);
                continue;
            }
            try {
                out.push(await this.skill(s.slug));
            }
            catch (e) {
                if (e instanceof CliError && e.code === 'unknown_skill')
                    continue;
                throw e;
            }
        }
        return out;
    }
    putSkill(slug, files) {
        return this.call({ method: 'PUT', path: `/skills/${encodeURIComponent(slug)}`, body: { files } });
    }
    deleteSkill(slug) {
        return this.call({ method: 'DELETE', path: `/skills/${encodeURIComponent(slug)}` });
    }
    async toolRuns() {
        return list(await this.call({ method: 'GET', path: '/tools/runs' }), 'runs');
    }
    postToolRun(record, timeoutMs = 5000) {
        return this.call({ method: 'POST', path: '/tools/runs', body: record, timeoutMs });
    }
}
// One place that decides whether a failed Cloud call was "not built yet".
export const isNotBuilt = (e) => e instanceof CliError && e.code === 'not_built';
// Signs in: checks the token with GET /store before anything is saved.
export async function verifyLogin(url, token, fetchFn) {
    const client = new CloudClient({ url, token, fetch: fetchFn });
    const r = await client.store();
    if (!r?.store || typeof r.store.name !== 'string')
        throw new CliError('That address answered, but not like Cosmic Cloud.', 'Check the address, then run cosmic login again.', 'bad_url');
    return { url: client.url, store: { id: clean(String(r.store.id ?? ''), 80), name: clean(r.store.name, 120) }, connections: Array.isArray(r.connections) ? r.connections.length : 0 };
}
