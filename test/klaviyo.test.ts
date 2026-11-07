import { afterEach, describe, expect, it, vi } from 'vitest'
import { Klaviyo, dailyWindows, isNoReportData, parseFlowSeries } from '../src/sources/klaviyo.js'
import { HttpError, fetchJson } from '../src/http.js'

const series = {
  data: { attributes: {
    date_times: ['2026-10-01T00:00:00+00:00', '2026-10-02T00:00:00+00:00'],
    results: [{
      groupings: { flow_id: 'F1', flow_message_id: 'M1', send_channel: 'email' },
      statistics: { recipients: [100, 0], opens_unique: [40, 0], clicks_unique: [5, 0], conversion_uniques: [2, 0], conversion_value: [150.5, 0], unsubscribes: [1, 0], spam_complaints: [0, 0], bounced: [3, 0] },
    }],
  } },
}

afterEach(() => vi.unstubAllGlobals())

describe('parseFlowSeries', () => {
  it('turns the documented shape into one row per active day', () => {
    expect(parseFlowSeries(series)).toEqual([{
      flowId: 'F1', flowMessageId: 'M1', channel: 'email', date: '2026-10-01', recipients: 100, opensUnique: 40,
      clicksUnique: 5, conversions: 2, revenue: 150.5, unsubscribes: 1, spamComplaints: 0, bounces: 3,
    }])
  })
  it('returns nothing for an empty report', () => {
    expect(parseFlowSeries({ data: { attributes: { date_times: [], results: [] } } })).toEqual([])
  })
})

describe('real response captured from a live send', () => {
  it('parses the exact shape Klaviyo returned on 2026-11-06', () => {
    const live = { data: { attributes: {
      date_times: ['2026-11-05T00:00:00+00:00', '2026-11-06T00:00:00+00:00'],
      results: [{ groupings: { flow_id: 'TASX3A', flow_message_id: 'Ym9yWq', send_channel: 'email' }, statistics: { recipients: [0, 0], opens_unique: [1, 0], conversion_value: [0, 0] } }],
    } } }
    expect(parseFlowSeries(live)).toMatchObject([{ flowId: 'TASX3A', flowMessageId: 'Ym9yWq', channel: 'email', date: '2026-11-05', opensUnique: 1 }])
  })
})

describe('fetchJson', () => {
  it('waits out a rate limit, honoring Retry-After', async () => {
    const waits: number[] = []
    const responses = [new Response('{}', { status: 429, headers: { 'retry-after': '31' } }), new Response('{"ok":true}', { status: 200 })]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()))
    const body = await fetchJson('https://x.test', {}, 'test', { wait: async (ms) => void waits.push(ms) })
    expect(body).toEqual({ ok: true })
    expect(waits).toEqual([31000])
  })
  it('does not retry a refused key', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', f)
    await expect(fetchJson('https://x.test', {}, 'test')).rejects.toBeInstanceOf(HttpError)
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('Klaviyo client', () => {
  it('follows pagination links', async () => {
    const pages = [
      { data: [{ id: 'A', attributes: { name: 'One', status: 'live' } }], links: { next: 'https://a.klaviyo.com/api/flows?page=2' } },
      { data: [{ id: 'B', attributes: { name: 'Two', status: 'draft' } }], links: { next: null } },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(pages.shift()))))
    expect((await new Klaviyo('k').flows()).map((f) => f.flowId)).toEqual(['A', 'B'])
  })
  it('recognizes the no-data report error we saw on an empty account', () => {
    expect(isNoReportData(new HttpError('r', 400, 'Passed in conversion metric does not support querying for values data'))).toBe(true)
    expect(isNoReportData(new HttpError('r', 400, 'bad filter'))).toBe(false)
  })
})

describe('dailyWindows', () => {
  it('splits a 90 day range into windows of 60 days or less', () => {
    const w = dailyWindows('2026-01-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z')
    expect(w).toHaveLength(2)
    expect(w[0]?.end).toBe(w[1]?.start)
    expect(w[1]?.end).toBe('2026-04-01T00:00:00.000Z')
  })
})
