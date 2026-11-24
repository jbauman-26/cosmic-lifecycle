import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { dateChunks, MetaAds, normalizeAccountId, purchaseStat, toDaily, type RawInsight } from '../src/sources/meta.js'
import { syncMeta, writeMeta } from '../src/sync.js'
import { runMetric, sinceDate } from '../src/metrics.js'
import { workflowYaml } from '../src/deploy.js'
import { HttpError } from '../src/http.js'

const row = (date: string, campaign: string, spend: string, extra: Partial<RawInsight> = {}): RawInsight => ({ campaign_id: campaign, campaign_name: `Campaign ${campaign}`, date_start: date, spend, impressions: '1000', clicks: '20', ...extra })

type Call = { path: string; params: Record<string, string>; auth: string }
// Answers each request in order, and records the path, the query and the auth header.
function fake(answers: unknown[]) {
  const calls: Call[] = []
  const queue = [...answers]
  const fetcher = (async (url: string, init: RequestInit) => {
    const u = new URL(url)
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), auth: (init.headers as Record<string, string>).authorization! })
    const next = queue.shift()
    if (next === undefined) throw new Error(`unexpected request to ${u.pathname}`)
    if (next instanceof Error) throw next
    return next
  }) as any
  return { calls, fetcher }
}

describe('account ids', () => {
  it('accepts the number with or without act_', () => {
    expect(normalizeAccountId('1234567890')).toBe('act_1234567890')
    expect(normalizeAccountId(' act_1234567890 ')).toBe('act_1234567890')
  })
  it('refuses anything that is not a number', () => {
    for (const bad of ['', 'act_', 'my-account', '123/insights', 'act_12?x=1']) expect(() => normalizeAccountId(bad)).toThrow(/not a Meta ad account id/)
  })
})

describe('purchases', () => {
  it('reads one purchase type and never adds the overlapping ones', () => {
    const stats = [{ action_type: 'link_click', value: '90' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '7' }, { action_type: 'purchase', value: '7' }, { action_type: 'omni_purchase', value: '8' }]
    expect(purchaseStat(stats)).toBe(8)
    expect(purchaseStat(stats.filter((s) => s.action_type !== 'omni_purchase'))).toBe(7)
    expect(purchaseStat([{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' }])).toBe(3)
    expect(purchaseStat([{ action_type: 'link_click', value: '90' }])).toBe(0)
    expect(purchaseStat(undefined)).toBe(0)
  })

  it('turns Meta string numbers into daily rows', () => {
    const d = toDaily([
      row('2026-11-01', 'c1', '120.456', { actions: [{ action_type: 'omni_purchase', value: '4' }], action_values: [{ action_type: 'omni_purchase', value: '399.999' }] }),
      row('2026-11-01', 'c2', '', { impressions: undefined, clicks: undefined, campaign_name: undefined }),
      { date_start: '2026-11-01' } as RawInsight,
    ])
    expect(d).toEqual([
      { date: '2026-11-01', campaignId: 'c1', campaignName: 'Campaign c1', spend: 120.46, impressions: 1000, clicks: 20, purchases: 4, purchaseValue: 400 },
      { date: '2026-11-01', campaignId: 'c2', campaignName: '', spend: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0 },
    ])
  })
})

describe('date chunks', () => {
  it('covers every day once, in ranges of at most 30 days', () => {
    expect(dateChunks('2026-08-27', '2026-11-24')).toEqual([{ since: '2026-08-27', until: '2026-09-25' }, { since: '2026-09-26', until: '2026-10-25' }, { since: '2026-10-26', until: '2026-11-24' }])
    expect(dateChunks('2026-11-24', '2026-11-24')).toEqual([{ since: '2026-11-24', until: '2026-11-24' }])
    expect(dateChunks('2026-11-01', '2026-12-01')).toEqual([{ since: '2026-11-01', until: '2026-11-30' }, { since: '2026-12-01', until: '2026-12-01' }])
    expect(dateChunks('2026-11-25', '2026-11-24')).toEqual([])
  })
})

describe('MetaAds client', () => {
  it('asks for daily campaign rows and walks pages with the after cursor', async () => {
    const { calls, fetcher } = fake([
      { data: [row('2026-11-20', 'c1', '10')], paging: { cursors: { after: 'CUR1' }, next: 'https://graph.facebook.com/v27.0/act_1/insights?access_token=SECRET&after=CUR1' } },
      { data: [row('2026-11-21', 'c1', '12')], paging: { cursors: { after: 'CUR2' } } },
    ])
    const rows = await new MetaAds('tok', '1234567890', fetcher).insights('2026-11-20', '2026-11-24')
    expect(rows.map((r) => r.spend)).toEqual(['10', '12'])
    expect(calls).toHaveLength(2)
    expect(calls[0]!.path).toBe('/v27.0/act_1234567890/insights')
    expect(calls[0]!.params).toMatchObject({ level: 'campaign', time_increment: '1', limit: '500', time_range: '{"since":"2026-11-20","until":"2026-11-24"}' })
    expect(calls[0]!.params.fields).toContain('action_values')
    expect(calls[1]!.params.after).toBe('CUR1')
  })

  it('sends the token in the header and never in a URL', async () => {
    const { calls, fetcher } = fake([{ data: [], paging: {} }])
    await new MetaAds('tok-123', 'act_1234567890', fetcher).insights('2026-11-24', '2026-11-24')
    expect(calls[0]!.auth).toBe('Bearer tok-123')
    expect(JSON.stringify(calls[0]!.params)).not.toContain('tok-123')
    expect(calls[0]!.params.access_token).toBeUndefined()
  })

  it('makes one request per 30-day chunk and stops when a cursor repeats', async () => {
    const page = { data: [row('2026-09-01', 'c1', '1')], paging: { cursors: { after: 'SAME' }, next: 'x' } }
    const { calls, fetcher } = fake([page, page, { data: [] }, { data: [] }])
    await new MetaAds('tok', '1234567890', fetcher).insights('2026-08-27', '2026-11-24')
    expect(calls).toHaveLength(4)
  })

  it('asks once more after a full page with no next link, so rows are never dropped', async () => {
    const full = Array.from({ length: 500 }, (_, i) => row('2026-11-24', `c${i}`, '1'))
    const { calls, fetcher } = fake([{ data: full, paging: { cursors: { after: 'A' } } }, { data: [row('2026-11-24', 'last', '1')], paging: { cursors: { after: 'B' } } }])
    expect(await new MetaAds('tok', '1234567890', fetcher).insights('2026-11-24', '2026-11-24')).toHaveLength(501)
    expect(calls[1]!.params.after).toBe('A')
  })

  it('checks the account and its insights before a connect is saved', async () => {
    const { calls, fetcher } = fake([{ name: 'Acme Store', currency: 'usd', timezone_name: 'America/New_York' }, { data: [] }])
    expect(await new MetaAds('tok', '1234567890', fetcher).check()).toEqual({ id: 'act_1234567890', name: 'Acme Store', currency: 'USD', timezone: 'America/New_York' })
    expect(calls.map((c) => c.path)).toEqual(['/v27.0/act_1234567890', '/v27.0/act_1234567890/insights'])
  })

  it('explains an expired token, a missing permission and a bad account in plain words', async () => {
    const err = (status: number, code: number, message: string) => new HttpError('Meta', status, JSON.stringify({ error: { message, code } }))
    const client = (e: Error) => new MetaAds('tok', '1234567890', fake([e]).fetcher)
    await expect(client(err(400, 190, 'Error validating access token: Session has expired')).check()).rejects.toMatchObject({ code: 'key_rejected', next: expect.stringMatching(/ads_read/) })
    await expect(client(err(403, 200, 'Ad account owner has NOT grant ads_read permission')).check()).rejects.toMatchObject({ code: 'meta_permission' })
    await expect(client(err(400, 100, 'Unsupported get request. Object with ID act_1 does not exist')).check()).rejects.toMatchObject({ code: 'meta_error', message: expect.stringMatching(/does not exist/) })
    await expect(client(new HttpError('Meta', 500, '<html>')).check()).rejects.toBeInstanceOf(HttpError)
  })
})

describe('sync', () => {
  let db: Db
  beforeEach(async () => {
    db = wrapPglite(await PGlite.create())
    await migrate(db)
  })
  afterEach(async () => db.close())

  const spend = async () => (await db.query(`SELECT date::text AS date, campaign_id, spend::float AS spend, purchases::float AS purchases, currency FROM fact_meta_ads_daily ORDER BY date, campaign_id`))

  it('pulls a 90-day window ending today and writes daily campaign rows', async () => {
    const asked: string[] = []
    const r = await syncMeta(db, async (since, until) => { asked.push(`${since}..${until}`); return [row('2026-11-23', 'c1', '50', { actions: [{ action_type: 'omni_purchase', value: '2' }] }), row('2026-11-24', 'c1', '60')] }, { today: '2026-11-24', currency: 'USD' })
    expect(asked).toEqual(['2026-08-26..2026-11-24'])
    expect(sinceDate(90, Date.parse('2026-11-24T12:00:00Z'))).toBe('2026-08-26')
    expect(r).toMatchObject({ source: 'meta', status: 'ok', rows: 2 })
    expect(await spend()).toEqual([{ date: '2026-11-23', campaign_id: 'c1', spend: 50, purchases: 2, currency: 'USD' }, { date: '2026-11-24', campaign_id: 'c1', spend: 60, purchases: 0, currency: 'USD' }])
  })

  it('replaces the window so restated and removed rows do not linger, and keeps older days', async () => {
    await writeMeta(db, [row('2026-07-01', 'old', '5'), row('2026-11-23', 'c1', '50'), row('2026-11-23', 'gone', '9')], '2026-07-01', 'USD')
    await syncMeta(db, async () => [row('2026-11-23', 'c1', '55')], { today: '2026-11-24', currency: 'USD' })
    expect((await spend()).map((r) => `${r.date} ${r.campaign_id} ${r.spend}`)).toEqual(['2026-07-01 old 5', '2026-11-23 c1 55'])
  })

  it('drops another ad account\'s history when the account changes', async () => {
    await writeMeta(db, [row('2026-05-01', 'a-old', '70'), row('2026-11-20', 'a-new', '30')], '2026-05-01', 'EUR', 'act_111')
    await syncMeta(db, async () => [row('2026-11-23', 'b1', '40')], { today: '2026-11-24', currency: 'USD', account: 'act_222' })
    expect((await spend()).map((r) => `${r.date} ${r.campaign_id} ${r.currency}`)).toEqual(['2026-11-23 b1 USD'])
    // The same account keeps its own older days.
    await writeMeta(db, [row('2026-05-01', 'b-old', '5')], '2026-05-01', 'USD', 'act_222')
    await syncMeta(db, async () => [row('2026-11-23', 'b1', '41')], { today: '2026-11-24', currency: 'USD', account: 'act_222' })
    expect((await spend()).map((r) => r.campaign_id)).toEqual(['b-old', 'b1'])
  })

  it('counts revenue for the efficiency ratio only from the first day Meta data exists', async () => {
    await db.query(`INSERT INTO fact_meta_ads_daily VALUES (CURRENT_DATE - 10, 'c1', 'Prospecting', 100, 1, 1, 0, 0, 'USD', 'act_1', now())`)
    const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'fact_orders_daily' ORDER BY ordinal_position`)).map((c) => String(c.column_name))
    const insert = (daysAgo: number, net: number) => db.query(`INSERT INTO fact_orders_daily (${cols.join(', ')}) VALUES (${cols.map((c) => (c === 'date' ? `CURRENT_DATE - ${daysAgo}` : c === 'net_revenue' ? String(net) : c === 'source_synced_at' ? 'now()' : '0')).join(', ')})`)
    await insert(5, 400)
    await insert(150, 9000)
    const mer = await runMetric(db, 'marketing_efficiency_ratio', 365)
    expect(Number(mer.value)).toBe(4)
    expect(Number(mer.numerator)).toBe(400)
  })

  it('warns when Meta returns nothing, and records a failure with its reason', async () => {
    expect(await syncMeta(db, async () => [], { today: '2026-11-24' })).toMatchObject({ status: 'warning', rows: 0, detail: expect.stringMatching(/no campaign activity/) })
    const failed = await syncMeta(db, async () => { throw new Error('Meta refused the token') }, { today: '2026-11-24' })
    expect(failed).toMatchObject({ source: 'meta', status: 'failed', detail: 'Meta refused the token' })
  })

  it('feeds the spend and ratio metrics, and says when Meta is missing', async () => {
    expect(await runMetric(db, 'meta_ad_spend', 30)).toMatchObject({ status: 'no_data', missing: ['meta'] })
    await db.query(`INSERT INTO fact_meta_ads_daily VALUES (CURRENT_DATE - 2, 'c1', 'Prospecting', 200, 5000, 100, 5, 900, 'USD', 'act_1', now())`)
    expect(Number((await runMetric(db, 'meta_ad_spend', 30)).value)).toBe(200)
    expect(Number((await runMetric(db, 'meta_reported_roas', 30)).value)).toBe(4.5)
    const roas = await runMetric(db, 'meta_reported_roas', 30)
    expect(roas.notes?.join(' ')).toMatch(/claim, not orders/)
  })
})

describe('daily sync', () => {
  it('passes the Meta token to the workflow only when Meta is connected', () => {
    expect(workflowYaml(false, false, [], false, true)).toContain('LIFECYCLE_META_ADS_TOKEN: ${{ secrets.LIFECYCLE_META_ADS_TOKEN }}')
    expect(workflowYaml(false, true)).not.toContain('LIFECYCLE_META_ADS_TOKEN')
  })
})
