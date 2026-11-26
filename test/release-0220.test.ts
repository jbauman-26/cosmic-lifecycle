import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { WAREHOUSE_CATALOG } from '../src/warehouse-catalog.js'

// The connectors added in 0.22.0 go through the runner's own personal-data filter, as the 0.14.0 ones do.
// The table name is passed in, so the people-table rules apply exactly as they do in a real sync.
const FIXTURES = join('test', 'fixtures', 'connectors-0220')
const BUILT = ['activecampaign', 'beehiiv', 'calendly', 'intercom', 'kit', 'microsoft-clarity', 'ordergroove', 'seal-subscriptions', 'stay-ai']

const STRIP = `
import json, sys
sys.path.insert(0, 'connectors')
import run
job = json.loads(sys.stdin.read())
extra = frozenset(job['strip_fields'])
out = {}
for name, body in job['resources'].items():
    rows = body['response']
    for part in [p for p in (body['selector'] or '').split('.') if p and p != '$']:
        rows = rows[part]
    rows = rows if isinstance(rows, list) else [rows]
    out[name] = [run.strip_personal(row, extra, None, job['slug'], name, 'keep') for row in rows]
print(json.dumps(out, indent=1))
`

describe('connectors added in 0.22.0', () => {
  it('has a spec and a recorded response for every built connector, and no stray fixture', () => {
    const slugs = readdirSync(FIXTURES).map((f) => f.replace(/\.json$/, '')).sort()
    expect(slugs).toEqual([...BUILT].sort())
  })

  it('leaves the four that need other runner work as planned, with a reason a buyer can read', () => {
    for (const slug of ['posthog', 'mixpanel', 'typeform', 'amplitude']) {
      const entry = WAREHOUSE_CATALOG.find((x) => x.slug === slug)
      expect(entry, slug).toBeDefined()
      expect(entry?.readiness, slug).toBe('planned')
      expect((entry?.notes ?? '').length, slug).toBeGreaterThan(60)
    }
  })

  for (const slug of BUILT) {
    it(`${slug}: no name, email, phone or address comes out, and the useful fields stay`, () => {
      const fixture = JSON.parse(readFileSync(join(FIXTURES, `${slug}.json`), 'utf8'))
      const source = WAREHOUSE_CATALOG.find((s) => s.slug === slug)!
      expect(source.readiness, slug).toBe('built')
      const cfg = source.config as {
        resources: { name: string; endpoint: { data_selector?: string; path: string; params?: Record<string, unknown> } }[]
        resource_defaults?: { endpoint?: { data_selector?: string } }
      }
      const job = {
        slug,
        strip_fields: source.stripFields ?? [],
        resources: Object.fromEntries(
          cfg.resources.map((r) => [
            r.name,
            {
              selector: r.endpoint.data_selector ?? cfg.resource_defaults?.endpoint?.data_selector ?? '',
              response: fixture.resources[r.name]?.response,
            },
          ]),
        ),
      }
      for (const r of cfg.resources) {
        expect(fixture.resources[r.name], `${slug}.${r.name} has no recorded body`).toBeDefined()
        // Read only: a connector may not ask a vendor to change anything.
        expect((r.endpoint as { method?: string }).method ?? 'GET', `${slug}.${r.name}`).toBe('GET')
      }
      const res = spawnSync('python3', ['-c', STRIP], { input: JSON.stringify(job), encoding: 'utf8' })
      expect(res.status, res.stderr).toBe(0)
      const text = res.stdout
      for (const v of fixture.personal) {
        expect(JSON.stringify(fixture.resources).includes(v), `${slug} fixture never held ${v}`).toBe(true)
        expect(text.includes(v), `${slug} still holds ${v}`).toBe(false)
      }
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
      for (const v of fixture.kept) expect(text.replace(/\s+/g, ' ').includes(v), `${slug} lost ${v}`).toBe(true)
    })
  }
})