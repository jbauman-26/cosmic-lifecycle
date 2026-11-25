import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { WAREHOUSE_CATALOG } from '../src/warehouse-catalog.js'

// Recorded responses, one file per connector added in 0.12.0, in the shape each vendor's
// API docs give. The bodies go through the runner's own personal-data filter (the Python
// that runs before anything is written), exactly as a sync would send them, and the test
// proves that no name, email, phone or address comes out the other side.

const FIXTURES = join('test', 'fixtures', 'connectors')
const slugs = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()

// A person block added to every recorded row, so each connector is also proven against
// the fields a vendor might add later, not only the ones in today's docs.
const PERSON = {
  first_name: 'Ines',
  lastName: 'Varga',
  customer_name: 'Ines Varga',
  email: 'ines.varga@example.org',
  phone: '+15555550199',
  mobile_number: '+15555550188',
  billing_address: { address1: '9 Quarry Row', zip: '60614' },
  shipping: { name: 'Ines Q. Varga', line1: '12 Tannery Yard', postal_code: '60615' },
  customer: { name: 'I. Varga-Customer', username: 'inesv88', email: 'second.ines@example.org' },
  note: 'Call ines.note@example.org about the order',
}
const INJECTED = ['Ines', 'Varga', 'ines.varga@example.org', '+15555550199', '+15555550188', '9 Quarry Row', '60614', 'Ines Q. Varga', '12 Tannery Yard', '60615', 'I. Varga-Customer', 'inesv88', 'second.ines@example.org', 'ines.note@example.org']

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
    out[name] = [run.strip_personal({**row, 'injected_person': job['person'], **job['person']}, extra) for row in rows]
print(json.dumps(out))
`

type Fixture = { source: string; resources: Record<string, { response: unknown }>; personal: string[]; kept: string[] }

function stripWithRunner(slug: string) {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, `${slug}.json`), 'utf8')) as Fixture
  const source = WAREHOUSE_CATALOG.find((s) => s.slug === slug)!
  const resources = (source.config as { resources: { name: string; endpoint: { data_selector?: string } }[] }).resources
  const job = {
    strip_fields: source.stripFields ?? [],
    person: PERSON,
    resources: Object.fromEntries(resources.map((r) => [r.name, { selector: r.endpoint.data_selector ?? '', response: fixture.resources[r.name]?.response }])),
  }
  const res = spawnSync('python3', ['-c', STRIP], { input: JSON.stringify(job), encoding: 'utf8' })
  if (res.status !== 0) throw new Error(res.stderr)
  return { fixture, resources, out: JSON.parse(res.stdout) as Record<string, Record<string, unknown>[]> }
}

describe('connectors added in 0.12.0 strip personal data from recorded responses', () => {
  it('has a recorded response for every connector added in this release', () => {
    expect(slugs).toEqual(['brevo', 'fairing', 'loox', 'okendo', 'privy'])
    for (const slug of slugs) expect(WAREHOUSE_CATALOG.find((s) => s.slug === slug)?.readiness, slug).toBe('built')
  })

  for (const slug of slugs) {
    it(`${slug}: names, emails, phones and addresses are gone, and the useful fields stay`, () => {
      const { fixture, resources, out } = stripWithRunner(slug)
      expect(fixture.source, slug).toMatch(/https:\/\//)
      // Every resource in the spec has a recorded body with at least one row.
      for (const r of resources) expect(out[r.name]?.length, `${slug}.${r.name}`).toBeGreaterThan(0)
      const text = JSON.stringify(out)
      for (const value of [...fixture.personal, ...INJECTED]) expect(text.includes(value), `${slug} still holds ${value}`).toBe(false)
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
      for (const value of fixture.kept) expect(text.includes(value), `${slug} lost ${value}`).toBe(true)
      // The recorded bodies really did hold the personal values before the filter ran.
      const before = JSON.stringify(fixture.resources)
      for (const value of fixture.personal) expect(before.includes(value), `${slug} fixture never held ${value}`).toBe(true)
    })
  }

  it('removes a bare name inside a person object and keeps a product or campaign name', () => {
    const res = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, 'connectors')
import run
row = {'name': 'Spring Sale', 'product': {'name': 'Linen Shirt'}, 'reviewer': {'name': 'Ines Varga', 'verified': True, 'city': 'Chicago'}, 'recipients': [{'name': 'Ines', 'tier': 'gold'}], 'nickname': 'ines_v', 'badge': 'ines_badge'}
print(json.dumps([run.strip_personal(row), run.strip_personal(row, frozenset(['badge']))]))
`], { encoding: 'utf8' })
    expect(res.status, res.stderr).toBe(0)
    const [plain, withExtra] = JSON.parse(res.stdout)
    expect(plain).toEqual({ name: 'Spring Sale', product: { name: 'Linen Shirt' }, reviewer: { verified: true, city: 'Chicago' }, recipients: [{ tier: 'gold' }], badge: 'ines_badge' })
    // 0.13.2: a nickname is a person's name wherever it sits, so it no longer needs a spec's stripFields.
    expect(plain.nickname).toBeUndefined()
    expect(withExtra.badge).toBeUndefined()
  })
})
