import { randomUUID } from 'node:crypto'
import { CliError } from './errors.js'
import { fetchJson, HttpError } from './http.js'
import { envName, getSecret, type SecretName } from './secrets.js'
import { saveRun, type ToolRun } from './tools.js'

// Open tools: any model, actor or path from four providers, run on your own account with them.
// `kie:<model>`, `fal:<endpoint_id>`, `apify:<owner~actor>` and `scrapecreators:<path>` all work
// without a row in a catalog, because each provider has one way to start a job and one way to read it.
//
// Three rules hold for every provider here:
// 1. Starting a job is never retried. A retry can start, and bill, a second job.
// 2. A wait that times out leaves the run saved as running. `tools get` picks it up later.
// 3. Your key only ever goes to that provider's own host.
//
// Unlike the built-in tools, these can return public profiles and other personal data.

export type Provider = 'kie' | 'fal' | 'apify' | 'scrapecreators'

export const OPEN_PROVIDERS: Record<Provider, { name: string; secret: SecretName; ref: string; example: string; catalog: string; billing: string }> = {
  kie: { name: 'Kie', secret: 'kie-api-key', ref: 'kie:<model>', example: 'kie:gpt-image-2-text-to-image', catalog: 'https://kie.ai/market', billing: 'Kie credits on your Kie account. A finished run reports the credits it used.' },
  fal: { name: 'fal', secret: 'fal-key', ref: 'fal:<endpoint_id>', example: 'fal:fal-ai/minimax/voice-clone', catalog: 'https://fal.ai/models', billing: 'Billed by fal to your fal account. fal does not report the cost in the result.' },
  apify: { name: 'Apify', secret: 'apify-token', ref: 'apify:<owner~actor>', example: 'apify:apimaestro~linkedin-profile-posts', catalog: 'https://apify.com/store', billing: 'Billed by Apify to your Apify account. A finished run reports its cost in US dollars.' },
  scrapecreators: { name: 'ScrapeCreators', secret: 'scrapecreators-key', ref: 'scrapecreators:<path>', example: 'scrapecreators:v1/reddit/search', catalog: 'https://docs.scrapecreators.com', billing: 'ScrapeCreators credits on your account. Each call reports the credits it charged.' },
}

export type Http = (url: string, init: RequestInit, label: string, opts?: { retries?: number }) => Promise<any>
export type OpenContext = { key: (p: Provider) => string; http: Http }

export function parseRef(ref: string): { provider: Provider; id: string } | null {
  const at = ref.indexOf(':')
  const provider = at > 0 ? ref.slice(0, at) : ''
  if (!(provider in OPEN_PROVIDERS)) return null
  let id = ref.slice(at + 1).replace(/^\/+|\/+$/g, '')
  const p = OPEN_PROVIDERS[provider as Provider]
  // The id becomes part of a URL, so it may only hold the characters these providers use in ids.
  if (!id || !/^[\w.~/-]+$/.test(id) || id.split('/').includes('..')) throw new CliError(`${ref} is not a valid ${p.name} ref.`, `Use ${p.ref}, such as ${p.example}. Ids are listed at ${p.catalog}`, 'bad_ref')
  if (provider === 'apify') id = id.replace('/', '~')
  return { provider: provider as Provider, id }
}

export function openProviders(hasKey: (s: SecretName) => boolean = (s) => Boolean(getSecret(s))) {
  return (Object.keys(OPEN_PROVIDERS) as Provider[]).map((provider) => {
    const p = OPEN_PROVIDERS[provider]
    return { provider, name: p.name, ref: p.ref, example: p.example, catalog: p.catalog, billing: p.billing, secret: p.secret, env: envName(p.secret), connected: hasKey(p.secret) }
  })
}

export function defaultOpenContext(): OpenContext {
  return {
    key: (provider) => {
      const p = OPEN_PROVIDERS[provider]
      const key = getSecret(p.secret)
      if (!key) throw new CliError(`No ${p.name} key yet.`, `lifecycle secrets set ${p.secret} --from-env YOUR_VAR, or export ${envName(p.secret)}`, 'missing_secret')
      return key
    },
    http: fetchJson,
  }
}

const json = { 'content-type': 'application/json' }
const once = { retries: 0 }
const KIE = 'https://api.kie.ai/api/v1/jobs'
const APIFY = 'https://api.apify.com/v2'
const FAL = 'https://queue.fal.run/'

type Remote = Record<string, string>
type Outcome = { status: ToolRun['status']; output?: unknown; error?: string; cost?: ToolRun['cost'] }

// Kie answers HTTP 200 even when it refuses, and puts the real result in `code`.
function kieData(r: any, what: string) {
  if (r?.code !== 200) throw new CliError(`Kie refused to ${what}: ${r?.msg ?? 'no reason given'} (code ${r?.code}).`, r?.code === 401 ? 'Check the key: lifecycle secrets list' : r?.code === 402 ? 'Add credits at https://kie.ai' : `Check the input against the model's page at ${OPEN_PROVIDERS.kie.catalog}`, 'provider_refused')
  return r.data ?? {}
}

async function start(provider: Provider, id: string, body: unknown, ctx: OpenContext, method: string): Promise<{ remote: Remote; done?: Outcome }> {
  const key = ctx.key(provider)
  if (provider === 'kie') {
    const d = kieData(await ctx.http(`${KIE}/createTask`, { method: 'POST', headers: { ...json, authorization: `Bearer ${key}` }, body: JSON.stringify({ model: id, input: body }) }, 'Kie create task', once), 'start the task')
    if (!d.taskId) throw new CliError('Kie did not return a task id.', 'Chat models answer directly and are not supported here. Pick an image, video or audio model.', 'provider_refused')
    return { remote: { taskId: String(d.taskId) } }
  }
  if (provider === 'fal') {
    const r = await ctx.http(`${FAL}${id}`, { method: 'POST', headers: { ...json, authorization: `Key ${key}` }, body: JSON.stringify(body) }, 'fal submit', once)
    // fal builds these from the owner and app only, so they are read from its answer, not rebuilt here.
    for (const u of [r?.status_url, r?.response_url]) if (typeof u !== 'string' || !u.startsWith(FAL)) throw new CliError('fal returned a status link outside queue.fal.run.', 'Nothing more was sent. Check the request in your fal dashboard.', 'provider_refused')
    return { remote: { requestId: String(r.request_id ?? ''), statusUrl: r.status_url, responseUrl: r.response_url } }
  }
  if (provider === 'apify') {
    const r = await ctx.http(`${APIFY}/actors/${id}/runs`, { method: 'POST', headers: { ...json, authorization: `Bearer ${key}` }, body: JSON.stringify(body) }, 'Apify run actor', once)
    if (!r?.data?.id) throw new CliError('Apify did not return a run id.', 'Check the actor id at https://apify.com/store', 'provider_refused')
    return { remote: { runId: String(r.data.id), datasetId: String(r.data.defaultDatasetId ?? '') } }
  }
  // ScrapeCreators answers in the same call, so there is nothing to poll.
  const url = new URL(`https://api.scrapecreators.com/${id}`)
  const post = method === 'POST'
  if (!post) for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v))
  const r = await ctx.http(url.toString(), { method: post ? 'POST' : 'GET', headers: { ...(post ? json : {}), 'x-api-key': key }, ...(post ? { body: JSON.stringify(body) } : {}) }, 'ScrapeCreators call', once)
  return { remote: {}, done: { status: 'succeeded', output: r, cost: typeof r?.credits_charged === 'number' ? { amount: r.credits_charged, unit: 'credits' } : undefined } }
}

async function poll(provider: Provider, remote: Remote, ctx: OpenContext): Promise<Outcome> {
  const key = ctx.key(provider)
  if (provider === 'kie') {
    const d = kieData(await ctx.http(`${KIE}/recordInfo?taskId=${encodeURIComponent(remote.taskId!)}`, { headers: { authorization: `Bearer ${key}` } }, 'Kie task status'), 'read the task')
    const cost = typeof d.creditsConsumed === 'number' ? { amount: d.creditsConsumed, unit: 'credits' } : undefined
    if (d.state === 'fail') return { status: 'failed', error: `${d.failMsg || 'Kie reported a failure.'}${d.failCode ? ` (code ${d.failCode})` : ''}`, cost }
    if (d.state !== 'success') return { status: 'running' }
    let output: unknown = d.resultJson
    try {
      output = JSON.parse(d.resultJson)
    } catch {
      // Keep the raw text when it is not JSON.
    }
    return { status: 'succeeded', output, cost }
  }
  if (provider === 'fal') {
    const headers = { authorization: `Key ${key}` }
    const s = await ctx.http(remote.statusUrl!, { headers }, 'fal status')
    if (s?.status !== 'COMPLETED') return { status: 'running' }
    if (s.error) return { status: 'failed', error: String(s.error) }
    try {
      return { status: 'succeeded', output: await ctx.http(remote.responseUrl!, { headers }, 'fal result') }
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return { status: 'failed', error: `fal returned ${e.status}: ${e.body}` }
      throw e
    }
  }
  if (provider === 'apify') {
    const headers = { authorization: `Bearer ${key}` }
    const d = (await ctx.http(`${APIFY}/actor-runs/${remote.runId}`, { headers }, 'Apify run status'))?.data ?? {}
    const cost = typeof d.usageTotalUsd === 'number' ? { amount: d.usageTotalUsd, unit: 'usd' } : undefined
    if (['FAILED', 'TIMED-OUT', 'ABORTED'].includes(d.status)) return { status: 'failed', error: `Apify run ${d.status}${d.statusMessage ? `: ${d.statusMessage}` : ''}`, cost }
    if (d.status !== 'SUCCEEDED') return { status: 'running' }
    const items = await ctx.http(`${APIFY}/datasets/${remote.datasetId || d.defaultDatasetId}/items?clean=true&limit=${APIFY_ITEM_CAP}`, { headers }, 'Apify dataset items')
    return { status: 'succeeded', output: Array.isArray(items) && items.length === APIFY_ITEM_CAP ? { items, note: `First ${APIFY_ITEM_CAP} items. The rest are in dataset ${remote.datasetId} on Apify.` } : items, cost }
  }
  return { status: 'running' }
}

export const APIFY_ITEM_CAP = 1000

function apply(run: ToolRun, o: Outcome, now: () => Date) {
  run.status = o.status
  if (o.cost) run.cost = o.cost
  if (o.status === 'running') return run
  if (o.status === 'succeeded') run.output = o.output
  else run.error = o.error
  run.finishedAt = now().toISOString()
  return run
}

// Starts the job and saves the run at once, so a crash or a timeout after this point can never lose the id.
export async function startOpenTool(ref: string, body: unknown, ctx: OpenContext, opts: { method?: string; now?: () => Date } = {}): Promise<ToolRun> {
  const parsed = parseRef(ref)
  if (!parsed) throw new CliError(`${ref} is not an open tool ref.`, 'lifecycle tools providers', 'bad_ref')
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new CliError('Tool input must be a JSON object.', `lifecycle tools run ${ref} --input '{"prompt":"..."}'`, 'bad_input')
  const now = opts.now ?? (() => new Date())
  const p = OPEN_PROVIDERS[parsed.provider]
  let started: Awaited<ReturnType<typeof start>>
  try {
    started = await start(parsed.provider, parsed.id, body, ctx, (opts.method ?? 'GET').toUpperCase())
  } catch (e) {
    if (e instanceof CliError) throw e
    // The request left this machine and no answer came back, so the job may exist.
    throw new CliError(`No answer from ${p.name}: ${e instanceof Error ? e.message : String(e)}`, `Look in your ${p.name} dashboard before running this again. The job may have started.`, 'provider_unreachable')
  }
  const run: ToolRun = { id: randomUUID().slice(0, 8), tool: `${parsed.provider}:${parsed.id}`, input: body, status: 'running', startedAt: now().toISOString(), finishedAt: '', provider: parsed.provider, remote: started.remote }
  if (started.done) apply(run, started.done, now)
  return saveRun(run)
}

// Asks the provider once. A finished run is returned as it was saved, with no call.
export async function refreshRun(run: ToolRun, ctx: OpenContext, now: () => Date = () => new Date()): Promise<ToolRun> {
  if (run.status !== 'running' || !run.provider || !run.remote) return run
  return saveRun(apply(run, await poll(run.provider as Provider, run.remote, ctx), now))
}

// Polls until the run ends or the time is up. On a timeout the run comes back still running: it was not stopped.
export async function waitForRun(run: ToolRun, ctx: OpenContext, opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<unknown>; now?: () => Date } = {}): Promise<ToolRun> {
  const now = opts.now ?? (() => new Date())
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const deadline = now().getTime() + (opts.timeoutMs ?? 300_000)
  for (let delay = 2000; run.status === 'running'; delay = Math.min(delay + 1000, 10_000)) {
    run = await refreshRun(run, ctx, now)
    if (run.status !== 'running' || now().getTime() + delay > deadline) break
    await sleep(delay)
  }
  return run
}

export const costLine = (run: ToolRun) => (run.cost ? `Cost: ${run.cost.unit === 'usd' ? `$${run.cost.amount.toFixed(4)}` : `${run.cost.amount} ${OPEN_PROVIDERS[run.provider as Provider]?.name ?? ''} credits`.replace('  ', ' ')}` : '')
