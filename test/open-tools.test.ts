import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpError } from '../src/http.js'
import { getRun, listRuns } from '../src/tools.js'
import { APIFY_ITEM_CAP, costLine, openProviders, parseRef, refreshRun, startOpenTool, waitForRun, type OpenContext } from '../src/open-tools.js'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lc-open-'))
  process.env.LIFECYCLE_HOME = home
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.LIFECYCLE_HOME
})

type Call = { url: string; method: string; headers: Record<string, string>; body: any; retries: number | undefined }

// Answers each request from a list of [url fragment, response or error] pairs, and records what was sent.
function fake(answers: [string, unknown][]) {
  const calls: Call[] = []
  const queue = [...answers]
  const ctx: OpenContext = {
    key: (p) => `key-for-${p}`,
    http: async (url, init, _label, opts) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined, retries: opts?.retries })
      const at = queue.findIndex(([frag]) => url.includes(frag))
      if (at < 0) throw new Error(`unexpected request to ${url}`)
      const [, answer] = queue.splice(at, 1)[0]!
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { ctx, calls }
}

const hosts = (calls: Call[]) => [...new Set(calls.map((c) => new URL(c.url).host))]

describe('refs', () => {
  it('reads the four provider prefixes and leaves built-in ids alone', () => {
    expect(parseRef('kie:bytedance/seedance-2-5')).toEqual({ provider: 'kie', id: 'bytedance/seedance-2-5' })
    expect(parseRef('fal:fal-ai/minimax/voice-clone')).toEqual({ provider: 'fal', id: 'fal-ai/minimax/voice-clone' })
    expect(parseRef('apify:apimaestro/linkedin-profile-posts')).toEqual({ provider: 'apify', id: 'apimaestro~linkedin-profile-posts' })
    expect(parseRef('scrapecreators:/v1/reddit/search')).toEqual({ provider: 'scrapecreators', id: 'v1/reddit/search' })
    expect(parseRef('klaviyo.flows')).toBeNull()
    expect(parseRef('openrouter:chat')).toBeNull()
  })

  it('refuses ids that could change the URL', () => {
    for (const bad of ['kie:', 'kie:a?x=1', 'fal:a/../b', 'apify:a b', 'scrapecreators:v1/x#y', 'fal:https://evil.example/x']) expect(() => parseRef(bad)).toThrow(/not a valid/)
  })

  it('lists providers with the key each needs and never a key value', () => {
    const p = openProviders((s) => s === 'fal-key')
    expect(p.map((x) => x.provider)).toEqual(['kie', 'fal', 'apify', 'scrapecreators'])
    expect(p.find((x) => x.provider === 'fal')!.connected).toBe(true)
    expect(p.find((x) => x.provider === 'kie')).toMatchObject({ connected: false, secret: 'kie-api-key', env: 'LIFECYCLE_KIE_API_KEY' })
  })
})

describe('kie', () => {
  it('starts once, saves the run at once, then reads the result and the credits', async () => {
    const { ctx, calls } = fake([
      ['createTask', { code: 200, msg: 'success', data: { taskId: 't1' } }],
      ['recordInfo', { code: 200, data: { state: 'generating' } }],
      ['recordInfo', { code: 200, data: { state: 'success', resultJson: '{"resultUrls":["https://example.invalid/a.png"]}', creditsConsumed: 50 } }],
    ])
    let run = await startOpenTool('kie:gpt-image-2-text-to-image', { prompt: 'a red shoe' }, ctx)
    expect(run.status).toBe('running')
    expect(getRun(run.id).remote).toEqual({ taskId: 't1' })
    expect(calls[0]).toMatchObject({ method: 'POST', body: { model: 'gpt-image-2-text-to-image', input: { prompt: 'a red shoe' } }, retries: 0 })
    expect(calls[0]!.headers.authorization).toBe('Bearer key-for-kie')

    run = await waitForRun(run, ctx, { sleep: async () => {} })
    expect(run.status).toBe('succeeded')
    expect(run.output).toEqual({ resultUrls: ['https://example.invalid/a.png'] })
    expect(costLine(run)).toBe('Cost: 50 Kie credits')
    expect(hosts(calls)).toEqual(['api.kie.ai'])
    expect(listRuns()[0]).toMatchObject({ id: run.id, tool: 'kie:gpt-image-2-text-to-image', status: 'succeeded' })
  })

  it('treats a 200 answer with an error code as a refusal and saves no run', async () => {
    const { ctx } = fake([['createTask', { code: 402, msg: 'Insufficient credits' }]])
    await expect(startOpenTool('kie:nano-banana-2', { prompt: 'x' }, ctx)).rejects.toThrow(/Insufficient credits/)
    expect(listRuns()).toEqual([])
  })

  it('reports a failed task with its reason', async () => {
    const { ctx } = fake([['createTask', { code: 200, data: { taskId: 't2' } }], ['recordInfo', { code: 200, data: { state: 'fail', failMsg: 'Prompt was blocked', failCode: '501' } }]])
    const run = await refreshRun(await startOpenTool('kie:nano-banana-2', { prompt: 'x' }, ctx), ctx)
    expect(run).toMatchObject({ status: 'failed', error: 'Prompt was blocked (code 501)' })
  })
})

describe('never pay twice', () => {
  it('leaves a run running when the wait times out, and does not start it again', async () => {
    const { ctx, calls } = fake([['createTask', { code: 200, data: { taskId: 't3' } }], ...Array.from({ length: 9 }, () => ['recordInfo', { code: 200, data: { state: 'queuing' } }] as [string, unknown])])
    let clock = 0
    const now = () => new Date(clock)
    const run = await waitForRun(await startOpenTool('kie:bytedance/seedance-2-5', { prompt: 'x' }, ctx, { now }), ctx, { timeoutMs: 10_000, now, sleep: async (ms) => { clock += ms } })
    expect(run.status).toBe('running')
    expect(getRun(run.id).status).toBe('running')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('says the job may have started when the start request gets no answer', async () => {
    const { ctx } = fake([['createTask', new Error('socket hang up')]])
    await expect(startOpenTool('kie:nano-banana-2', { prompt: 'x' }, ctx)).rejects.toMatchObject({ code: 'provider_unreachable', next: expect.stringMatching(/dashboard before running this again/) })
  })

  it('makes no request for a run that already finished', async () => {
    const { ctx, calls } = fake([['scrapecreators', { success: true, credits_charged: 1 }]])
    const run = await startOpenTool('scrapecreators:v1/reddit/search', { query: 'welcome flow' }, ctx)
    await refreshRun(run, ctx)
    await waitForRun(run, ctx)
    expect(calls).toHaveLength(1)
  })
})

describe('fal', () => {
  it('follows the status and response links fal returns, on fal only', async () => {
    const base = 'https://queue.fal.run/fal-ai/minimax/requests/r1'
    const { ctx, calls } = fake([
      ['queue.fal.run/fal-ai/minimax/voice-clone', { request_id: 'r1', status_url: `${base}/status`, response_url: base }],
      ['/status', { status: 'IN_PROGRESS' }],
      ['/status', { status: 'COMPLETED' }],
      [base, { voice_id: 'v1' }],
    ])
    const run = await waitForRun(await startOpenTool('fal:fal-ai/minimax/voice-clone', { audio_url: 'https://example.invalid/a.mp3' }, ctx), ctx, { sleep: async () => {} })
    expect(run).toMatchObject({ status: 'succeeded', output: { voice_id: 'v1' } })
    expect(calls[0]).toMatchObject({ method: 'POST', retries: 0 })
    expect(calls.every((c) => c.headers.authorization === 'Key key-for-fal')).toBe(true)
    expect(hosts(calls)).toEqual(['queue.fal.run'])
    expect(costLine(run)).toBe('')
  })

  it('will not send the key to a link on another host', async () => {
    const { ctx, calls } = fake([['queue.fal.run', { request_id: 'r2', status_url: 'https://evil.example/status', response_url: 'https://queue.fal.run/x' }]])
    await expect(startOpenTool('fal:fal-ai/flux/schnell', { prompt: 'x' }, ctx)).rejects.toThrow(/outside queue.fal.run/)
    expect(calls).toHaveLength(1)
  })

  it('marks the run failed when fal rejects the result', async () => {
    const base = 'https://queue.fal.run/fal-ai/flux/requests/r3'
    const { ctx } = fake([['fal-ai/flux/schnell', { request_id: 'r3', status_url: `${base}/status`, response_url: base }], ['/status', { status: 'COMPLETED' }], [base, new HttpError('fal result', 422, '{"detail":"bad prompt"}')]])
    const run = await refreshRun(await startOpenTool('fal:fal-ai/flux/schnell', { prompt: 'x' }, ctx), ctx)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/422.*bad prompt/)
  })
})

describe('apify', () => {
  it('runs an actor, reads its dataset and reports the dollar cost', async () => {
    const { ctx, calls } = fake([
      ['/actors/apimaestro~linkedin-profile-posts/runs', { data: { id: 'run1', status: 'READY', defaultDatasetId: 'ds1' } }],
      ['/actor-runs/run1', { data: { status: 'RUNNING' } }],
      ['/actor-runs/run1', { data: { status: 'SUCCEEDED', usageTotalUsd: 0.0123 } }],
      ['/datasets/ds1/items', [{ text: 'post one' }]],
    ])
    const run = await waitForRun(await startOpenTool('apify:apimaestro/linkedin-profile-posts', { username: 'someone' }, ctx), ctx, { sleep: async () => {} })
    expect(run).toMatchObject({ status: 'succeeded', output: [{ text: 'post one' }], cost: { amount: 0.0123, unit: 'usd' } })
    expect(costLine(run)).toBe('Cost: $0.0123')
    expect(calls[0]).toMatchObject({ method: 'POST', body: { username: 'someone' }, retries: 0 })
    expect(calls.at(-1)!.url).toContain(`limit=${APIFY_ITEM_CAP}`)
    expect(hosts(calls)).toEqual(['api.apify.com'])
  })

  it('reports a run that timed out on Apify as failed', async () => {
    const { ctx } = fake([['/runs', { data: { id: 'run2', defaultDatasetId: 'ds2' } }], ['/actor-runs/run2', { data: { status: 'TIMED-OUT', statusMessage: 'Actor timed out' } }]])
    const run = await refreshRun(await startOpenTool('apify:a~b', {}, ctx), ctx)
    expect(run).toMatchObject({ status: 'failed', error: 'Apify run TIMED-OUT: Actor timed out' })
  })
})

describe('scrapecreators', () => {
  it('sends input as query parameters and finishes in one call', async () => {
    const { ctx, calls } = fake([['api.scrapecreators.com', { success: true, credits_charged: 1, posts: [] }]])
    const run = await startOpenTool('scrapecreators:v1/reddit/search', { query: 'klaviyo flows', trim: true }, ctx)
    expect(run.status).toBe('succeeded')
    expect(run.finishedAt).not.toBe('')
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/v1/reddit/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: 'klaviyo flows', trim: 'true' })
    expect(calls[0]).toMatchObject({ method: 'GET', body: undefined, retries: 0 })
    expect(calls[0]!.headers['x-api-key']).toBe('key-for-scrapecreators')
    expect(costLine(run)).toBe('Cost: 1 ScrapeCreators credits')
  })

  it('posts a JSON body when asked', async () => {
    const { ctx, calls } = fake([['api.scrapecreators.com', { success: true }]])
    await startOpenTool('scrapecreators:v1/facebook/adLibrary/company/ads', { pageId: '123' }, ctx, { method: 'post' })
    expect(calls[0]).toMatchObject({ method: 'POST', body: { pageId: '123' } })
    expect(new URL(calls[0]!.url).search).toBe('')
  })
})

describe('input', () => {
  it('needs a JSON object and a key', async () => {
    const { ctx } = fake([])
    await expect(startOpenTool('kie:nano-banana-2', ['x'], ctx)).rejects.toThrow(/JSON object/)
    await expect(startOpenTool('klaviyo.flows', {}, ctx)).rejects.toThrow(/not an open tool ref/)
    const noKey: OpenContext = { ...ctx, key: () => { throw new Error('No Kie key yet.') } }
    await expect(startOpenTool('kie:nano-banana-2', {}, noKey)).rejects.toThrow(/No answer from Kie|No Kie key/)
  })
})
