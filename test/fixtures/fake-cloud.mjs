// A stand-in for Cosmic Cloud API v1, for tests and for trying commands by hand.
// It holds invented data only and listens on this machine only.
//   node test/fixtures/fake-cloud.mjs [port] [token] [missing,routes]
import { createServer } from 'node:http'

export const FAKE_TOKEN = 'cck_0123456789ab_fake-token-for-tests-only-0000000000000000000'

const STORE = {
  contract_version: '1.2.0',
  store: { id: 'sample_store', name: 'Sample store', domain: 'example.myshopify.com', keep_syncing_when_closed: true },
  connections: [
    { id: 'c_klaviyo000001', source_id: 'klaviyo', source_name: 'Klaviyo', status: 'working', last_success_at: '2026-11-24T14:00:41.512Z', freshness: 'fresh', next_sync_at: '2026-11-25T14:00:00.000Z' },
    { id: 'c_meta00000001', source_id: 'meta', source_name: 'Meta Ads', status: 'failed', status_code: 'key_rejected', last_success_at: '2026-11-22T14:00:12.000Z', freshness: 'stale', next_sync_at: null },
  ],
}
const SCHEMA = { schemas: [{ name: 'public', tables: [{ name: 'fact_orders_daily', rows: 90, columns: [{ name: 'date', type: 'date' }, { name: 'orders', type: 'integer' }] }, { name: 'fact_flow_daily', rows: 12, columns: [{ name: 'date', type: 'date' }, { name: 'revenue', type: 'numeric' }] }] }] }
const METRICS = [
  { name: 'shopify_orders', title: 'Shopify orders', description: 'Orders placed.', unit: 'count', needs: ['shopify'], saved: false },
  { name: 'repeat_orders', title: 'Repeat orders', unit: 'count', needs: [], saved: true },
]

// opts.missing: route prefixes that answer 404 not_found, as a Cloud that has not built them yet does.
export function startFakeCloud(opts = {}) {
  const token = opts.token ?? FAKE_TOKEN
  const missing = opts.missing ?? []
  const requests = []
  const skills = new Map(Object.entries(opts.skills ?? {}))
  const toolRuns = []
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
    res.end(JSON.stringify(body))
  }
  const error = (res, status, code, message, headers) => send(res, status, { error: { code, message } }, headers)
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const path = url.pathname.replace(/^\/api\/v1/, '')
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        return error(res, 400, 'invalid_request', 'Body is not JSON.')
      }
      requests.push({ method: req.method, path, query: url.search, authorization: req.headers.authorization ?? null, body })
      if (!url.pathname.startsWith('/api/v1/')) return error(res, 404, 'not_found', 'No such route.')
      if (req.headers.authorization !== `Bearer ${token}`) return error(res, 401, 'unauthorized', 'Send a Cosmic Cloud API token as Authorization: Bearer.', { 'www-authenticate': 'Bearer realm="Cosmic Cloud"' })
      if (opts.respond) {
        const custom = opts.respond({ method: req.method, path, body })
        if (custom) return send(res, custom.status, custom.body, custom.headers)
      }
      if (missing.some((m) => path === m || path.startsWith(`${m}/`))) return error(res, 404, 'not_found', 'No such route.')
      const m = req.method
      if (m === 'GET' && path === '/store') return send(res, 200, STORE)
      if (m === 'GET' && path === '/schema') return send(res, 200, SCHEMA)
      if (m === 'POST' && path === '/query') {
        if (typeof body?.sql !== 'string') return error(res, 400, 'invalid_request', 'sql must be a string.')
        if (!/^\s*(select|with)\b/i.test(body.sql)) return error(res, 422, 'read_only', 'Only SELECT queries are allowed.')
        return send(res, 200, { columns: ['date', 'orders'], rows: [['2026-11-23', 14], ['2026-11-24', 9]], truncated: false })
      }
      if (m === 'GET' && path === '/metrics') return send(res, 200, { metrics: METRICS })
      if (m === 'GET' && path.startsWith('/metrics/')) {
        const name = decodeURIComponent(path.slice('/metrics/'.length))
        const def = METRICS.find((x) => x.name === name)
        if (!def) return error(res, 404, 'unknown_metric', `No metric named ${name}.`)
        const days = Number(url.searchParams.get('days') ?? 90)
        return send(res, 200, { metric: name, title: def.title, unit: def.unit, days, value: 412, notes: [], saved: def.saved, trust: { status: 'passed', line: 'Numbers passed reconciliation, with 4 checks skipped.' }, status: 'ok', detail: '' })
      }
      if (m === 'GET' && path === '/runs') {
        const runs = [
          { source_id: 'klaviyo', started_at: '2026-11-24T14:00:32.100Z', finished_at: '2026-11-24T14:00:41.512Z', status: 'ok', rows: 412, code: null },
          { source_id: 'meta', started_at: '2026-11-24T14:00:02.000Z', finished_at: '2026-11-24T14:00:03.300Z', status: 'failed', rows: 0, code: 'key_rejected' },
        ]
        return send(res, 200, { runs: runs.slice(0, Number(url.searchParams.get('limit') ?? 20)) })
      }
      if (m === 'POST' && path === '/sync') return send(res, 202, { started: body?.connection_id ? [body.connection_id] : STORE.connections.map((c) => c.id), already_running: [] })
      if (m === 'GET' && path === '/skills') return send(res, 200, { skills: [...skills.entries()].map(([slug, files]) => ({ slug, files })) })
      if (path.startsWith('/skills/')) {
        const slug = decodeURIComponent(path.slice('/skills/'.length))
        if (m === 'PUT') {
          if (!Array.isArray(body?.files)) return error(res, 400, 'invalid_request', 'files must be a list.')
          const created = !skills.has(slug)
          skills.set(slug, body.files)
          return send(res, created ? 201 : 200, { slug, files: body.files.length, created })
        }
        if (m === 'DELETE') {
          if (!skills.delete(slug)) return error(res, 404, 'not_found', 'No such skill.')
          return send(res, 200, { deleted: true })
        }
      }
      if (m === 'GET' && path === '/tools/runs') return send(res, 200, { runs: toolRuns })
      if (m === 'POST' && path === '/tools/runs') {
        toolRuns.push(body)
        return send(res, 201, { saved: true })
      }
      return error(res, 404, 'not_found', 'No such route.')
    })
  })
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, token, requests, skills, toolRuns, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeCloud({ port: Number(process.argv[2] ?? 4599), token: process.argv[3], missing: (process.argv[4] ?? '').split(',').filter(Boolean) })
  console.log(`Fake Cosmic Cloud on ${fake.url}`)
}
