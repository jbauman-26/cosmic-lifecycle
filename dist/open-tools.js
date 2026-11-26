import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';
import { fetchJson, HttpError } from './http.js';
import { envName, getSecret } from './secrets.js';
import { redactSecrets, saveRun, toolRequest } from './tools.js';
export const OPEN_PROVIDERS = {
    kie: { name: 'Kie', secret: 'kie-api-key', ref: 'kie:<model>', example: 'kie:gpt-image-2-text-to-image', catalog: 'https://kie.ai/market', billing: 'Kie credits on your Kie account. A finished run reports the credits it used.' },
    fal: { name: 'fal', secret: 'fal-key', ref: 'fal:<endpoint_id>', example: 'fal:fal-ai/minimax/voice-clone', catalog: 'https://fal.ai/models', billing: 'Billed by fal to your fal account. fal does not report the cost in the result.' },
    apify: { name: 'Apify', secret: 'apify-token', ref: 'apify:<owner~actor>', example: 'apify:apimaestro~linkedin-profile-posts', catalog: 'https://apify.com/store', billing: 'Billed by Apify to your Apify account. A finished run reports its cost in US dollars.' },
    scrapecreators: { name: 'ScrapeCreators', secret: 'scrapecreators-key', ref: 'scrapecreators:<path>', example: 'scrapecreators:v1/reddit/search', catalog: 'https://docs.scrapecreators.com', billing: 'ScrapeCreators credits on your account. Each call reports the credits it charged.' },
};
// A rate limit or a server error says nothing about the job. It is still there to ask about later.
const transient = (e) => !(e instanceof CliError) || (e instanceof HttpError && (e.status === 408 || e.status === 429 || e.status >= 500));
export function parseRef(ref) {
    const at = ref.indexOf(':');
    const provider = at > 0 ? ref.slice(0, at) : '';
    if (!(provider in OPEN_PROVIDERS))
        return null;
    let id = ref.slice(at + 1).replace(/^\/+|\/+$/g, '');
    const p = OPEN_PROVIDERS[provider];
    // The id becomes part of a URL, so it may only hold the characters these providers use in ids.
    if (!id || !/^[\w.~/-]+$/.test(id) || id.split('/').includes('..'))
        throw new CliError(`${ref} is not a valid ${p.name} ref.`, `Use ${p.ref}, such as ${p.example}. Ids are listed at ${p.catalog}`, 'bad_ref');
    if (provider === 'apify')
        id = id.replace('/', '~');
    return { provider: provider, id };
}
export function openProviders(hasKey = (s) => Boolean(getSecret(s))) {
    return Object.keys(OPEN_PROVIDERS).map((provider) => {
        const p = OPEN_PROVIDERS[provider];
        return { provider, name: p.name, ref: p.ref, example: p.example, catalog: p.catalog, billing: p.billing, secret: p.secret, env: envName(p.secret), connected: hasKey(p.secret) };
    });
}
export function defaultOpenContext() {
    return {
        key: (provider) => {
            const p = OPEN_PROVIDERS[provider];
            const key = getSecret(p.secret);
            if (!key)
                throw new CliError(`No ${p.name} key yet.`, `cosmic secrets set ${p.secret} --from-env YOUR_VAR, or export ${envName(p.secret)}`, 'missing_secret');
            return key;
        },
        http: fetchJson,
    };
}
const json = { 'content-type': 'application/json' };
const once = { retries: 0 };
const KIE = 'https://api.kie.ai/api/v1/jobs';
const APIFY = 'https://api.apify.com/v2';
const FAL = 'https://queue.fal.run/';
// Kie answers HTTP 200 even when it refuses, and puts the real result in `code`.
function kieData(r, what) {
    if (r?.code !== 200)
        throw new CliError(`Kie refused to ${what}: ${r?.msg ?? 'no reason given'} (code ${r?.code}).`, r?.code === 401 ? 'Check the key: cosmic secrets list' : r?.code === 402 ? 'Add credits at https://kie.ai' : `Check the input against the model's page at ${OPEN_PROVIDERS.kie.catalog}`, 'provider_refused');
    return r.data ?? {};
}
async function start(provider, id, body, ctx, method) {
    const key = ctx.key(provider);
    if (provider === 'kie') {
        const d = kieData(await ctx.http(`${KIE}/createTask`, { method: 'POST', headers: { ...json, authorization: `Bearer ${key}` }, body: JSON.stringify({ model: id, input: body }) }, 'Kie create task', once), 'start the task');
        if (!d.taskId)
            throw new CliError('Kie did not return a task id.', 'Chat models answer directly and are not supported here. Pick an image, video or audio model.', 'provider_refused');
        return { remote: { taskId: String(d.taskId) } };
    }
    if (provider === 'fal') {
        const r = await ctx.http(`${FAL}${id}`, { method: 'POST', headers: { ...json, authorization: `Key ${key}` }, body: JSON.stringify(body) }, 'fal submit', once);
        // fal builds these from the owner and app only, so they are read from its answer, not rebuilt here.
        for (const u of [r?.status_url, r?.response_url])
            if (typeof u !== 'string' || !u.startsWith(FAL))
                throw new CliError('fal returned a status link outside queue.fal.run.', 'Nothing more was sent. Check the request in your fal dashboard.', 'provider_refused');
        return { remote: { requestId: String(r.request_id ?? ''), statusUrl: r.status_url, responseUrl: r.response_url, ...(typeof r.cancel_url === 'string' && r.cancel_url.startsWith(FAL) ? { cancelUrl: r.cancel_url } : {}) } };
    }
    if (provider === 'apify') {
        const r = await ctx.http(`${APIFY}/actors/${id}/runs`, { method: 'POST', headers: { ...json, authorization: `Bearer ${key}` }, body: JSON.stringify(body) }, 'Apify run actor', once);
        if (!r?.data?.id)
            throw new CliError('Apify did not return a run id.', 'Check the actor id at https://apify.com/store', 'provider_refused');
        return { remote: { runId: String(r.data.id), datasetId: String(r.data.defaultDatasetId ?? '') } };
    }
    // ScrapeCreators answers in the same call, so there is nothing to poll.
    const url = new URL(`https://api.scrapecreators.com/${id}`);
    const post = method === 'POST';
    if (!post)
        for (const [k, v] of Object.entries((body ?? {})))
            url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    const r = await ctx.http(url.toString(), { method: post ? 'POST' : 'GET', headers: { ...(post ? json : {}), 'x-api-key': key }, ...(post ? { body: JSON.stringify(body) } : {}) }, 'ScrapeCreators call', once);
    return { remote: {}, done: { status: 'succeeded', output: r, cost: typeof r?.credits_charged === 'number' ? { amount: r.credits_charged, unit: 'credits' } : undefined } };
}
async function poll(provider, remote, ctx) {
    const key = ctx.key(provider);
    if (provider === 'kie') {
        const d = kieData(await ctx.http(`${KIE}/recordInfo?taskId=${encodeURIComponent(remote.taskId)}`, { headers: { authorization: `Bearer ${key}` } }, 'Kie task status'), 'read the task');
        const cost = typeof d.creditsConsumed === 'number' ? { amount: d.creditsConsumed, unit: 'credits' } : undefined;
        if (d.state === 'fail')
            return { status: 'failed', error: `${d.failMsg || 'Kie reported a failure.'}${d.failCode ? ` (code ${d.failCode})` : ''}`, cost };
        if (d.state !== 'success')
            return { status: 'running' };
        let output = d.resultJson;
        try {
            output = JSON.parse(d.resultJson);
        }
        catch {
            // Keep the raw text when it is not JSON.
        }
        return { status: 'succeeded', output, cost };
    }
    if (provider === 'fal') {
        const headers = { authorization: `Key ${key}` };
        const s = await ctx.http(remote.statusUrl, { headers }, 'fal status');
        if (s?.status !== 'COMPLETED')
            return { status: 'running' };
        if (s.error)
            return { status: 'failed', error: String(s.error) };
        try {
            return { status: 'succeeded', output: await ctx.http(remote.responseUrl, { headers }, 'fal result') };
        }
        catch (e) {
            // Only an answer that says the request itself was bad ends the run. A rate limit, a server error or a
            // rejected key leaves it running, so the result that was already paid for can still be fetched later.
            if (e instanceof HttpError && (e.status === 400 || e.status === 422))
                return { status: 'failed', error: `fal returned ${e.status}: ${e.body}` };
            throw e;
        }
    }
    if (provider === 'apify') {
        const headers = { authorization: `Bearer ${key}` };
        const d = (await ctx.http(`${APIFY}/actor-runs/${remote.runId}`, { headers }, 'Apify run status'))?.data ?? {};
        const cost = typeof d.usageTotalUsd === 'number' ? { amount: d.usageTotalUsd, unit: 'usd' } : undefined;
        if (['FAILED', 'TIMED-OUT', 'ABORTED'].includes(d.status))
            return { status: 'failed', error: `Apify run ${d.status}${d.statusMessage ? `: ${d.statusMessage}` : ''}`, cost };
        if (d.status !== 'SUCCEEDED')
            return { status: 'running' };
        const items = await ctx.http(`${APIFY}/datasets/${remote.datasetId || d.defaultDatasetId}/items?clean=true&limit=${APIFY_ITEM_CAP}`, { headers }, 'Apify dataset items');
        return { status: 'succeeded', output: Array.isArray(items) && items.length === APIFY_ITEM_CAP ? { items, note: `First ${APIFY_ITEM_CAP} items. The rest are in dataset ${remote.datasetId} on Apify.` } : items, cost };
    }
    return { status: 'running' };
}
export const APIFY_ITEM_CAP = 1000;
function apply(run, o, now) {
    run.status = o.status;
    if (o.cost)
        run.cost = o.cost;
    if (o.status === 'running')
        return run;
    if (o.status === 'succeeded')
        run.output = o.output;
    else
        run.error = o.error;
    run.finishedAt = now().toISOString();
    return run;
}
// Starts the job and saves the run at once, so a crash or a timeout after this point can never lose the id.
export async function startOpenTool(ref, body, ctx, opts = {}) {
    const parsed = parseRef(ref);
    if (!parsed)
        throw new CliError(`${ref} is not an open tool ref.`, 'cosmic tools providers', 'bad_ref');
    if (body === null || typeof body !== 'object' || Array.isArray(body))
        throw new CliError('Tool input must be a JSON object.', `cosmic tools run ${ref} --input '{"prompt":"..."}'`, 'bad_input');
    const now = opts.now ?? (() => new Date());
    const p = OPEN_PROVIDERS[parsed.provider];
    let started;
    try {
        started = await start(parsed.provider, parsed.id, body, ctx, (opts.method ?? 'GET').toUpperCase());
    }
    catch (e) {
        // No answer, or a server or gateway error: the request left this machine and nothing says the job was turned down.
        if (transient(e) && !(e instanceof HttpError && e.status === 429))
            throw new CliError(e instanceof HttpError ? `${p.name} answered with status ${e.status}, which does not say whether the job started.` : `No answer from ${p.name}: ${e instanceof Error ? e.message : String(e)}`, `Look in your ${p.name} dashboard before running this again. The job may have started.`, 'provider_unreachable');
        // A 4xx is a clear no. Nothing started and nothing was billed.
        if (e instanceof HttpError)
            throw new CliError(`${p.name} turned the request down with status ${e.status}: ${e.body}`, e.status === 401 || e.status === 403 ? `Check the key: cosmic secrets set ${p.secret} --from-env YOUR_VAR` : e.status === 429 ? `${p.name} is rate limiting this key. Nothing started. Wait a minute, then run it again.` : `Nothing started. Check the id and input against ${p.catalog}`, 'provider_refused');
        throw e;
    }
    const method = (opts.method ?? 'GET').toUpperCase();
    const run = { id: randomUUID().slice(0, 8), tool: `${parsed.provider}:${parsed.id}`, input: redactSecrets(body), status: 'running', startedAt: now().toISOString(), finishedAt: '', request: toolRequest(parsed.provider, parsed.id, body, parsed.provider === 'scrapecreators' ? method : undefined), provider: parsed.provider, remote: started.remote };
    if (started.done)
        apply(run, started.done, now);
    return saveRun(run);
}
// Asks the provider once. A finished run is returned as it was saved, with no call.
export async function refreshRun(run, ctx, now = () => new Date()) {
    if (run.status !== 'running' || !run.provider || !run.remote)
        return run;
    return saveRun(apply(run, await poll(run.provider, run.remote, ctx), now));
}
// Asks the provider to stop a run that is still going. The run is only marked aborted once the provider agrees.
// Apify and fal can stop a job. Kie cannot, and ScrapeCreators answers at once, so there is nothing to stop.
// A stopped job may still be billed for the work it did.
export async function abortRun(run, ctx, now = () => new Date()) {
    if (run.status !== 'running')
        throw new CliError(`Run ${run.id} is not running. It ${run.status === 'aborted' ? 'was already stopped' : run.status}.`, `cosmic tools get ${run.id}`, 'not_running');
    const provider = run.provider;
    if (!provider || !run.remote || !(provider in OPEN_PROVIDERS))
        throw new CliError(`Run ${run.id} cannot be stopped from here.`, `cosmic tools get ${run.id}`, 'cannot_abort');
    // It may have finished since the last look. A finished run is saved as it ended, not as aborted.
    try {
        run = await refreshRun(run, ctx, now);
    }
    catch (e) {
        if (!transient(e))
            throw e;
    }
    if (run.status !== 'running')
        return { run, aborted: false };
    const remote = run.remote ?? {};
    const p = OPEN_PROVIDERS[provider];
    const key = ctx.key(provider);
    if (provider === 'apify') {
        await ctx.http(`${APIFY}/actor-runs/${encodeURIComponent(remote.runId ?? '')}/abort`, { method: 'POST', headers: { authorization: `Bearer ${key}` } }, 'Apify abort run', once);
    }
    else if (provider === 'fal') {
        const url = remote.cancelUrl ?? remote.statusUrl?.replace(/\/status$/, '/cancel');
        if (!url || !url.startsWith(FAL) || !url.endsWith('/cancel'))
            throw new CliError('This fal run has no cancel link saved.', 'Stop it in your fal dashboard.', 'cannot_abort');
        try {
            await ctx.http(url, { method: 'PUT', headers: { authorization: `Key ${key}` } }, 'fal cancel request', once);
        }
        catch (e) {
            // fal answers 400 when the job already finished. Read the result instead of calling it stopped.
            if (e instanceof HttpError && e.status === 400)
                return { run: await refreshRun(run, ctx, now), aborted: false };
            throw e;
        }
    }
    else {
        throw new CliError(`${p.name} has no way to stop a job once it starts. It will finish and bill as usual.`, `Check it with: cosmic tools get ${run.id}`, 'cannot_abort');
    }
    run.status = 'aborted';
    run.error = `Stopped with cosmic tools abort. ${p.name} may still bill for the work done before it stopped.`;
    run.finishedAt = now().toISOString();
    return { run: saveRun(run), aborted: true };
}
// Polls until the run ends or the time is up. On a timeout the run comes back still running: it was not stopped.
// Each status request is cut off at the deadline and is not retried inside the HTTP helper, so a slow or
// rate-limited provider cannot hold the command past --timeout. This loop is the retry.
export async function waitForRun(run, ctx, opts = {}) {
    const now = opts.now ?? (() => new Date());
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = now().getTime() + (opts.timeoutMs ?? 300_000);
    for (let delay = 2000; run.status === 'running'; delay = Math.min(delay + 1000, 10_000)) {
        const signal = AbortSignal.timeout(Math.max(1, deadline - now().getTime()));
        const bounded = { key: ctx.key, http: (url, init, label) => ctx.http(url, { ...init, signal }, label, { retries: 0 }) };
        try {
            run = await refreshRun(run, bounded, now);
        }
        catch (e) {
            if (!transient(e))
                throw e;
        }
        if (run.status !== 'running' || now().getTime() + delay > deadline)
            break;
        await sleep(delay);
    }
    return run;
}
export const costLine = (run) => (run.cost ? `Cost: ${run.cost.unit === 'usd' ? `$${run.cost.amount.toFixed(4)}` : `${run.cost.amount} ${OPEN_PROVIDERS[run.provider]?.name ?? ''} credits`.replace('  ', ' ')}` : '');
