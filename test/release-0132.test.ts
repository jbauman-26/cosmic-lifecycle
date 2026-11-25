import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { migrate, wrapPglite, type Db } from '../src/db.js'
import { CliError } from '../src/errors.js'
import { getSetting, readRawConfig, setSetting, writeConfig } from '../src/config.js'
import { DOCS } from '../src/docs.js'
import { PERSONAL_RULES, classifyColumn, isPeopleTable, isAuthoredTable, norm, scrubFreeText, words, type FieldClass } from '../src/personal.js'
import { runQuery } from '../src/query.js'
import { MIGRATIONS, PUBLIC_TABLES } from '../src/schema.js'
import { assertNoPersonalColumns, markCatalog, tokenize, type CatalogColumn } from '../src/sql-guard.js'
import { VERSION } from '../src/version.js'
import { WAREHOUSE_CATALOG } from '../src/warehouse-catalog.js'
import { addCustomSource, connectSource, duckQuery, duckSchema, freeTextMode, markColumns, runRunner, scrubPlan, scrubWarehouse, syncSources, uvAvailable } from '../src/warehouse.js'
import { CloudClient } from '../src/cloud.js'
import { PEOPLE_FIXTURES } from './fixtures/people-rows.js'

const codeOf = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    return e instanceof CliError ? e.code : `not a CliError: ${e}`
  }
  return 'ok'
}

const python = (script: string, input: unknown) => {
  const res = spawnSync('python3', ['-c', script], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(res.stderr)
  return JSON.parse(res.stdout)
}

describe('the rule list', () => {
  const kind = (table: string, column: string, type = 'text', source?: string) => classifyColumn({ source, table, column, type })

  it('marks names of people, emails, phones, street addresses and IPs personal', () => {
    for (const c of [
      'first_name', 'lastName', 'full_name', 'display_name', 'reviewer_name', 'authorName', 'requester_name', 'assignee_name', 'customer_name', 'given_name', 'family_name',
      'nickname', 'username', 'email', 'email_address', 'customer_email', 'cc_emails', 'phone', 'phone_number', 'mobile', 'phones', 'fax', 'address', 'address1', 'street',
      'shipping_address__city', 'billing_address__country', 'zip', 'postal_code', 'ip', 'ip_address', 'last_login_ip', 'latitude', 'longitude', 'birthday', 'date_of_birth',
      'customer__name', 'reviewer__display_name', 'ship_to__name', 'recipient__address__address1', 'author', 'reviewer', 'recipient',
    ]) expect(kind('orders', c), c).toBe('personal')
  })

  it('keeps ids, counts, timestamps, statuses, labels and region', () => {
    for (const c of [
      'id', 'customer_id', 'requester_id', 'assignee_id', 'reviewer__id', 'order_count', 'orders_count', 'created_at', 'updated_at', 'status', 'state', 'total_price', 'currency',
      'name', 'product_name', 'campaign_name', 'product__name', 'title', 'sku', 'rating', 'country', 'country_code', 'province', 'region', 'city', 'customer__city', 'customer__country',
      'time_zone', 'locale', 'tags', 'score', 'tracking_number', 'ticket_id', 'message_id', 'comment_count',
    ]) expect(kind('orders', c), c).toBe('keep')
    // A number under a person key is an id, text is a name.
    expect(kind('orders', 'author', 'bigint')).toBe('keep')
    expect(kind('orders', 'author', 'VARCHAR')).toBe('personal')
  })

  it('knows a row of a people table is a person, and a review has a writer', () => {
    for (const t of ['users', 'customers', 'contacts', 'members', 'subscribers', 'profiles', 'store_customers', 'customers__orders']) {
      expect(isPeopleTable(t), t).toBe(true)
      expect(kind(t, 'name'), t).toBe('personal')
      expect(kind(t, 'alias'), t).toBe('personal')
      expect(kind(t, 'city'), t).toBe('keep')
      expect(kind(t, 'id', 'bigint'), t).toBe('keep')
    }
    for (const t of ['tickets', 'orders', 'campaigns', 'vip_tiers', 'dim_flow', 'products']) {
      expect(isPeopleTable(t), t).toBe(false)
      expect(kind(t, 'name'), t).toBe('keep')
    }
    expect(isAuthoredTable('product_reviews')).toBe(true)
    expect(kind('reviews', 'name')).toBe('personal')
    expect(kind('reviews', 'product__name')).toBe('keep')
    expect(kind('reviews', 'title')).toBe('free_text')
  })

  it('calls customer writing free text, and leaves what the store wrote alone', () => {
    for (const c of ['subject', 'body', 'body_html', 'message', 'comment', 'note', 'notes', 'description', 'description_text', 'content', 'excerpt', 'raw_subject', 'gift_message']) expect(kind('tickets', c), c).toBe('free_text')
    for (const c of ['subject', 'description', 'content', 'name']) expect(kind('campaigns', c), c).toBe('keep')
    expect(kind('tickets', 'comment_count', 'bigint')).toBe('keep')
    expect(kind('tickets', 'comments', 'bigint')).toBe('keep')
    expect(kind('meta_sync_run', 'detail')).toBe('keep')
    expect(kind('meta_saved_metric', 'title')).toBe('keep')
  })

  it('applies a per-source decision before the general rules', () => {
    expect(kind('customers', 'hash', 'text', 'recharge')).toBe('personal')
    expect(kind('customers', 'hash', 'text')).toBe('keep')
    expect(kind('tickets', 'name', 'text', 'freshdesk')).toBe('personal')
    expect(kind('tickets', 'via__source__from__name', 'text', 'zendesk')).toBe('personal')
    expect(kind('tickets', 'via__channel', 'text', 'zendesk')).toBe('keep')
    expect(kind('responses', 'other_response', 'text', 'fairing')).toBe('free_text')
    expect(kind('contacts__identifiers', 'id', 'text', 'omnisend')).toBe('personal')
    for (const [slug, tables] of Object.entries(PERSONAL_RULES.sources)) {
      const source = WAREHOUSE_CATALOG.find((s) => s.slug === slug)
      expect(source, `${slug} is in the catalog`).toBeDefined()
      const resources = ((source!.config as { resources: { name: string }[] }).resources ?? []).map((r) => r.name)
      for (const t of Object.keys(tables)) expect(resources, `${slug}.${t}`).toContain(t)
    }
  })

  it('finds no personal column in the tables this CLI creates itself', () => {
    const ddl = MIGRATIONS.join('\n')
    for (const t of PUBLIC_TABLES) {
      const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(([\\s\\S]*?)\\)(?:\`|$|\\n)`).exec(ddl)
      const cols = (m?.[1] ?? '').split(',').map((c) => c.trim().split(/\s+/)).filter((c) => c[0] && !/^(PRIMARY|UNIQUE)$/.test(c[0]))
      expect(cols.length, t).toBeGreaterThan(0)
      for (const [name, type] of cols) expect(classifyColumn({ table: t, column: name!, type }), `${t}.${name}`).toBe('keep')
    }
  })

  it('never marks a primary key or a sync cursor of a catalog source personal or free text', () => {
    for (const s of WAREHOUSE_CATALOG.filter((x) => x.config)) {
      const config = s.config as { resource_defaults?: { primary_key?: string | string[] }; resources: { name: string; primary_key?: string | string[]; endpoint?: { params?: Record<string, unknown>; incremental?: { cursor_path?: string } } }[] }
      for (const r of config.resources) {
        const keys = [r.primary_key ?? config.resource_defaults?.primary_key ?? []].flat()
        const cursors = [r.endpoint?.incremental?.cursor_path, ...Object.values(r.endpoint?.params ?? {}).map((p) => (p as { cursor_path?: string } | null)?.cursor_path)].filter((x): x is string => typeof x === 'string')
        for (const k of [...keys, ...cursors]) expect(classifyColumn({ source: s.slug, table: r.name, column: k.replace(/\./g, '__') }), `${s.slug}.${r.name}.${k}`).toBe('keep')
      }
    }
  })

  it('writes the same list to the file the loader reads', () => {
    expect(JSON.parse(readFileSync(join('connectors', 'personal-rules.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(PERSONAL_RULES)))
  })
})

// The loader is Python and the schema, query and scrub are TypeScript. Both read one rule list.
// This runs the same keys through both and fails on any difference.
describe('the loader and the CLI agree', () => {
  const KEYS = [
    'id', 'name', 'Name', 'title', 'email', 'Email', 'emails', 'e_mail', 'email_address', 'phone', 'phones', 'phoneNumber', 'mobile', 'first_name', 'firstName', 'lastname', 'full_name', 'fname', 'LNAME',
    'display_name', 'displayName', 'nickname', 'username', 'user_name', 'handle', 'alias', 'initials', 'avatar_url', 'avatarUrl', 'photo', 'signature', 'twitter', 'twitter_id', 'reviewer_name', 'author_name',
    'requester_name', 'assignee_name', 'author', 'reviewer', 'customer', 'recipient', 'recipients', 'user', 'owner', 'agent', 'user_agent', 'customer_id', 'requester_id', 'assignee_id', 'address', 'addresses',
    'address1', 'address_line1', 'line1', 'street', 'zip', 'zip_code', 'postal_code', 'postcode', 'city', 'city_locality', 'state', 'province', 'country', 'country_code', 'country_name', 'region', 'time_zone',
    'locale', 'language', 'latitude', 'lng', 'ip', 'ip_address', 'birthday', 'birth_date', 'date_of_birth', 'dob', 'gender', 'subject', 'raw_subject', 'body', 'body_html', 'html_body', 'body_text', 'message',
    'message_id', 'comment', 'comments', 'comment_count', 'note', 'notes', 'description', 'description_text', 'content', 'content_type', 'excerpt', 'preview', 'summary', 'feedback', 'details', 'answer', 'reply',
    'instructions', 'gift_message', 'status', 'created_at', 'total', 'score', 'rating', 'sku', 'product_name', 'product_title', 'company', 'company_name', 'job_title', 'tags', 'hash', 'token', 'password',
    'custom_fields', 'user_fields', 'data', 'meta', 'metadata', 'properties', 'identifiers', 'label_url', 'signed_by', 'smses', 'ship_to', 'shipTo', 'billing', 'shipping', 'other_response', 'response',
  ]
  const TABLES = ['orders', 'tickets', 'users', 'customers', 'contacts', 'reviews', 'product_reviews', 'campaigns', 'questions', 'messages', 'conversations', 'trackings', 'labels', 'responses', 'dim_flow']
  const SOURCES = [undefined, 'zendesk', 'gorgias', 'recharge', 'freshdesk', 'kustomer', 'omnisend', 'yotpo-reviews', 'fairing', 'shippo', 'aftership-tracking']
  const PARENTS = [[], ['customer'], ['reviewer'], ['product'], ['ship_to'], ['attributes'], ['via', 'source'], ['billing_address'], ['author'], ['message']]

  it('classifies every key the same way in Python and in TypeScript', () => {
    const cases: { source?: string; table: string; path: string[] }[] = []
    for (const source of SOURCES) for (const table of TABLES) for (const parents of PARENTS) for (const k of KEYS) cases.push({ source, table, path: [...parents, k] })
    const got = python(`
import json, sys
sys.path.insert(0, 'connectors')
import run
out = []
for c in json.loads(sys.stdin.read()):
    row = 'x'
    for k in reversed(c['path']):
        row = {k: row}
    def there(mode):
        v = run.strip_personal(row, frozenset(), False, c.get('source'), c['table'], mode)
        for k in c['path']:
            if not isinstance(v, dict) or k not in v:
                return False
            v = v[k]
        return True
    out.append('personal' if not there('keep') else ('free_text' if not there('drop') else 'keep'))
print(json.dumps(out))
`, cases) as FieldClass[]
    expect(got.length).toBe(cases.length)
    const wrong: string[] = []
    cases.forEach((c, i) => {
      const want = classifyColumn({ source: c.source, table: c.table, column: c.path.join('__') })
      if (want !== got[i]) wrong.push(`${c.source ?? '-'} ${c.table} ${c.path.join('.')}: loader ${got[i]}, CLI ${want}`)
    })
    expect(wrong.slice(0, 20)).toEqual([])
  }, 60_000)

  it('takes the same emails and phone numbers out of text in Python and in TypeScript', () => {
    const texts = [
      'write to someone.fixture@example.org today', 'call +1 555 010 0199', 'call +15550100199 now', 'ring (555) 010-0142.', 'ring 555-010-0142', 'ring 555.010.0142', 'mobile 5550100142',
      'UK line +44 20 7946 0958', 'AU +61 2 9374 4000 ok', 'order 2026-11-24 arrived', 'at 2026-11-24T10:30:00Z', 'order #1001 late', 'paid $1,234,567.89', 'ms 1732492800123', 'id 550e8400-e29b-41d4-a716-446655440000',
      'tracking 9400111899223197428490', 'size 10 12 14', 'v1.2.3', 'no personal details here', '3 x 100g + 2', 'ref AB1234567890', 'won +10000 points', 'at 10:30:00+0100', 'in +5 days',
    ]
    const py = python(`
import json, sys
sys.path.insert(0, 'connectors')
import run
print(json.dumps([run.scrub_free_text(t) for t in json.loads(sys.stdin.read())]))
`, texts) as string[]
    expect(py).toEqual(texts.map(scrubFreeText))
    const out = Object.fromEntries(texts.map((t, i) => [t, py[i]]))
    for (const t of texts.slice(0, 9)) {
      expect(out[t], t).toContain('[removed]')
      expect(out[t], t).not.toMatch(/\d{4}|@/)
    }
    for (const t of texts.slice(9)) expect(out[t], t).toBe(t)
  })
})

// dlt names a nested key parent__child and puts a list in a child table. This does the same, so a
// fixture row can be checked column by column against the schema marks.
type Leaf = { table: string; column: string; value: unknown }
const snake = (k: string) => words(k).join('_')
function flatten(table: string, row: Record<string, unknown>, prefix = '', out: Leaf[] = []): Leaf[] {
  for (const [k, v] of Object.entries(row)) {
    const col = prefix ? `${prefix}__${snake(k)}` : snake(k)
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object') flatten(`${table}__${col}`, item as Record<string, unknown>, '', out)
        else out.push({ table: `${table}__${col}`, column: 'value', value: item })
      }
    } else if (v && typeof v === 'object') flatten(table, v as Record<string, unknown>, col, out)
    else out.push({ table, column: col, value: v })
  }
  return out
}

describe('every source that loads people, row by row', () => {
  const cases = Object.entries(PEOPLE_FIXTURES).flatMap(([slug, tables]) => Object.entries(tables).map(([table, f]) => ({ slug, table, ...f, strip: WAREHOUSE_CATALOG.find((s) => s.slug === slug)?.stripFields ?? [] })))
  let kept: Record<string, unknown>[] = []
  let dropped: Record<string, unknown>[] = []

  beforeAll(() => {
    const out = python(`
import json, sys
sys.path.insert(0, 'connectors')
import run
cases = json.loads(sys.stdin.read())
print(json.dumps([[run.strip_personal(c['row'], frozenset(c['strip']), False, c['slug'], c['table'], mode) for c in cases] for mode in ('keep', 'drop')]))
`, cases)
    kept = out[0]
    dropped = out[1]
  })

  it('has a fixture for every table of people in the catalog', () => {
    const missing: string[] = []
    for (const s of WAREHOUSE_CATALOG.filter((x) => x.config)) {
      for (const r of (s.config as { resources: { name: string }[] }).resources) {
        if ((isPeopleTable(r.name) || isAuthoredTable(r.name)) && !PEOPLE_FIXTURES[s.slug]?.[r.name]) missing.push(`${s.slug}.${r.name}`)
      }
    }
    // Loox's two review tables share one shape; the product one stands for both.
    expect(missing).toEqual(['loox.store_reviews'])
    for (const c of cases) expect((WAREHOUSE_CATALOG.find((s) => s.slug === c.slug)?.config as { resources: { name: string }[] }).resources.map((r) => r.name), `${c.slug}.${c.table}`).toContain(c.table)
  })

  for (const [i, c] of cases.entries()) {
    it(`${c.slug}.${c.table}: the person is gone and the useful fields stay`, () => {
      const before = JSON.stringify(c.row)
      for (const v of c.gone) expect(before.includes(v), `fixture never held ${v}`).toBe(true)
      for (const [mode, rows] of [['keep', kept], ['drop', dropped]] as const) {
        const text = JSON.stringify(rows[i])
        for (const v of c.gone) expect(text.includes(v), `${mode}: still holds ${v}`).toBe(false)
        expect(text, mode).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
      }
      const freeText = c.freeText ?? []
      for (const v of c.kept) expect(JSON.stringify(kept[i]).includes(v), `lost ${v}`).toBe(true)
      for (const v of c.kept.filter((x) => !freeText.includes(x))) expect(JSON.stringify(dropped[i]).includes(v), `drop lost ${v}`).toBe(true)
      for (const v of freeText) expect(JSON.stringify(dropped[i]).includes(v), `drop kept ${v}`).toBe(false)
    })

    it(`${c.slug}.${c.table}: schema marks every column that held the person`, () => {
      for (const leaf of flatten(c.table, c.row)) {
        if (typeof leaf.value !== 'string' || !c.gone.some((v) => (leaf.value as string).includes(v))) continue
        const kind = classifyColumn({ source: c.slug, table: leaf.table, column: leaf.column, type: 'text' })
        const exact = c.gone.includes(leaf.value)
        // A whole value that is personal must sit in a personal column, or one a spec strips by name. Text that only carries one is free text.
        const stripped = c.strip.some((k) => leaf.column.split('__').includes(snake(k)) || leaf.table.split('__').includes(snake(k)))
        expect(exact ? kind === 'personal' || stripped : kind !== 'keep' || stripped, `${leaf.table}.${leaf.column} is ${kind}`).toBe(true)
      }
    })
  }
})

// ---- query: getting a personal column out of a warehouse an older version filled ----

const NAME = 'Zed Fixtureperson'
const ALLOWED = [
  `select id, role from src_zendesk.users order by id`,
  `select u.id from src_zendesk.users u join src_zendesk.tickets t on t.requester_id = u.id`,
  `select count(*) from src_zendesk.users`,
  `select count(*) as n from src_zendesk.users u where u.role = 'admin'`,
  `select name from dim_flow`,
  `select * from dim_flow`,
  `select 'name' as label, id from src_zendesk.users`,
  `select extract(year from created_at) as y from src_zendesk.users`,
  `with c as (select id from src_zendesk.users) select count(*) from c`,
  `select id from src_zendesk.users where role is distinct from 'x'`,
  `select t.subject from src_zendesk.tickets t`,
  `select cast(id as numeric(10, 2)) as n from src_zendesk.users`,
  `select trim(both 'x' from 'xax') as t, id from src_zendesk.users`,
  `select id from src_zendesk.users -- a comment about name\n where role = 'admin'`,
  `select id /* name */ from src_zendesk.users`,
  `select t.id, t.id * 2 as twice from src_zendesk.tickets t`,
  `select (select max(id) from src_zendesk.users) as top, count(*) from src_zendesk.tickets`,
  `select u.id, u.role, u.created_at from src_zendesk.users u, src_zendesk.tickets t where 'caf\u00e9' <> 'x' and t.requester_id = u.id`,
]
const REFUSED: [string, string][] = [
  ['the column', `select name from src_zendesk.users`],
  ['an alias', `select name as x from src_zendesk.users`],
  ['a quoted name', `select "name" from src_zendesk.users`],
  ['mixed case', `select NaMe from src_zendesk.users`],
  ['quoted upper case', `select "NAME" from src_zendesk.users`],
  ['a star', `select * from src_zendesk.users`],
  ['a table star', `select u.* from src_zendesk.users u`],
  ['a table star without an alias', `select users.* from src_zendesk.users`],
  ['a subquery', `select x from (select name as x from src_zendesk.users) q`],
  ['a nested subquery', `select y from (select x as y from (select name as x from src_zendesk.users) a) b`],
  ['a CTE', `with c as (select name n from src_zendesk.users) select n from c`],
  ['row_to_json', `select row_to_json(u) from src_zendesk.users u`],
  ['to_jsonb', `select to_jsonb(u) from src_zendesk.users u`],
  ['to_jsonb of the table', `select to_jsonb(users) from src_zendesk.users`],
  ['a json key', `select to_jsonb(u)->>'name' from src_zendesk.users u`],
  ['a row cast', `select u::text from src_zendesk.users u`],
  ['a cast function', `select cast(u as text) from src_zendesk.users u`],
  ['a column cast', `select name::text from src_zendesk.users`],
  ['cast()', `select cast(name as varchar) from src_zendesk.users`],
  ['a function', `select upper(name) from src_zendesk.users`],
  ['a slice', `select substr(name, 1, 3) from src_zendesk.users`],
  ['a hash', `select md5(email) from src_zendesk.users`],
  ['a whole row', `select u from src_zendesk.users u`],
  ['the table as a row', `select users from src_zendesk.users`],
  ['order by', `select id from src_zendesk.users order by name`],
  ['a filter', `select id from src_zendesk.users where name like 'Z%'`],
  ['a column list on the alias', `select b from src_zendesk.users as u(a, b, c)`],
  ['a column list without AS', `select b from src_zendesk.users u(a, b, c)`],
  ['TABLE', `select q.b from (table src_zendesk.users) q(a, b, c)`],
  ['a field of a row', `select (u).name from src_zendesk.users u`],
  ['a comma join', `select t.id from src_zendesk.tickets t, src_zendesk.users`],
  ['a positional column', `select #2 from src_zendesk.users`],
  ['COLUMNS()', `select columns('na.*') from src_zendesk.users`],
  ['FROM first', `with c as (from src_zendesk.users) select id from c`],
  ['a nested comment', `select id /* /* */ from src_zendesk.users`],
  ['an escape string', `select E'\\'', id from src_zendesk.users`],
  ['a Unicode escape', `select U&"n\\0061me" from src_zendesk.users`],
  ['a dollar quote', `select $$x$$, id from src_zendesk.users`],
  ['a backslash before a quote', `select 'a\\' , name from src_zendesk.users --'`],
  ['an inner query', `select id from src_zendesk.users where exists (select 1 from src_zendesk.users u2 where u2.name = 'x')`],
  ['an aggregate', `select max(u.name) from src_zendesk.users u`],
  ['json_agg', `select json_agg(u) from src_zendesk.users u`],
  ['array_agg', `select array_agg(u) from src_zendesk.users u`],
  ['a quoted mixed case column', `select u.id, u."Email" from src_zendesk.users u`],
  ['a union', `select role from src_zendesk.users union select name from src_zendesk.users`],
  ['a star in a join', `select id from src_zendesk.users natural join (select * from src_zendesk.users) x`],
  ['count(distinct *)', `select count(distinct u.*) from src_zendesk.users u`],
  ['the staging copy', `select name from src_zendesk_staging.users`],
  ['a number glued to the name', `select 1name from src_zendesk.users`],
  ['the alias column', `select u.alias from src_zendesk.users u`],
  ['DISTINCT ON with a star', `select distinct on (id) * from src_zendesk.users`],
  ['a lateral row', `select x.* from src_zendesk.users u, lateral (select u) x`],
  ['SUMMARIZE', `select * from (summarize src_zendesk.users)`],
  ['PIVOT', `select id from (pivot src_zendesk.users on role using count(*))`],
  ['a function written like a column', `select u.row_to_json from src_zendesk.users u`],
  ['a method on the row', `select u.to_json() from src_zendesk.users u`],
  ['a function on the table written like a column', `select users.to_jsonb from src_zendesk.users`],
  ['a cast written like a column', `select u.text from src_zendesk.users u`],
  ['a no-break space', `select\u00a0name from src_zendesk.users`],
  ['a no-break space after a dot', `select u.\u00a0name from src_zendesk.users u`],
  ['an alias behind TABLESAMPLE', `select u from src_zendesk.users tablesample bernoulli (10) u`],
  ['a zero width space', `select na\u200bme from src_zendesk.users`],
  ['count of the row', `select u.count from src_zendesk.users u`],
  ['a string for a table', `select t.id from src_zendesk.tickets t join 'users' on true where exists (select 1 from src_zendesk.users)`],
]
const BLOCKED = [
  `select query_to_xml('select name from src_zendesk.users', true, false, '')`,
  `select most_common_vals::text from pg_stats`,
  `select word from ts_stat('select to_tsvector(name) from src_zendesk.users')`,
  `select * from query('select name from src_zendesk.users')`,
  `select * from query_table('users')`,
  `select set_config('search_path', 'src_zendesk', true)`,
  `select * from duckdb_columns()`,
]

const CATALOG: CatalogColumn[] = markCatalog([
  ...['id:bigint', 'name:text', 'email:text', 'alias:text', 'role:text', 'notes:text', 'created_at:timestamp', '_dlt_id:text'].map((c) => ({ schema: 'src_zendesk', table: 'users', column: c.split(':')[0]!, type: c.split(':')[1]! })),
  ...['id:bigint', 'name:text', 'email:text', '_dlt_id:text'].map((c) => ({ schema: 'src_zendesk_staging', table: 'users', column: c.split(':')[0]!, type: c.split(':')[1]! })),
  ...['id:bigint', 'subject:text', 'requester_id:bigint', 'status:text'].map((c) => ({ schema: 'src_zendesk', table: 'tickets', column: c.split(':')[0]!, type: c.split(':')[1]! })),
  ...['flow_id:text', 'name:text'].map((c) => ({ schema: 'public', table: 'dim_flow', column: c.split(':')[0]!, type: c.split(':')[1]! })),
], (s) => (s.startsWith('src_zendesk') ? 'zendesk' : undefined))

describe('the query check, statement by statement', () => {
  it('marks the fixture catalog the way schema would', () => {
    expect(CATALOG.filter((c) => c.personal).map((c) => `${c.schema}.${c.table}.${c.column}`).sort()).toEqual([
      'src_zendesk.users.alias', 'src_zendesk.users.email', 'src_zendesk.users.name', 'src_zendesk_staging.users.email', 'src_zendesk_staging.users.name',
    ])
  })

  for (const sql of ALLOWED) it(`allows: ${sql.replace(/\s+/g, ' ')}`, () => expect(() => assertNoPersonalColumns(sql, CATALOG)).not.toThrow())
  for (const [what, sql] of REFUSED) it(`refuses ${what}: ${sql}`, async () => expect(await codeOf(() => assertNoPersonalColumns(sql, CATALOG))).toBe('personal_column'))
  for (const sql of BLOCKED) it(`blocks: ${sql}`, async () => expect(await codeOf(() => assertNoPersonalColumns(sql, CATALOG))).toBe('blocked_object'))

  it('judges a table by its own schema, so a clean table of the same name is not held back', async () => {
    const two = [...CATALOG, ...markCatalog(['id:bigint', 'role:text', 'plan:text'].map((c) => ({ schema: 'src_new_desk', table: 'users', column: c.split(':')[0]!, type: c.split(':')[1]! })))]
    for (const sql of ['select * from src_new_desk.users', 'select u.*, u.plan from src_new_desk.users u', 'select id * 2 from src_new_desk.users']) expect(() => assertNoPersonalColumns(sql, two), sql).not.toThrow()
    // Without a schema it could be either table, so it is treated as the one with personal columns.
    for (const sql of ['select * from users', 'select name from users', 'select users from src_new_desk.users', 'select * from src_new_desk.users n join src_zendesk.users o on o.id = n.id', 'select o.name from src_new_desk.users n join src_zendesk.users o on o.id = n.id', 'select n.id from src_new_desk.users n, src_zendesk.users']) {
      expect(await codeOf(() => assertNoPersonalColumns(sql, two)), sql).toBe('personal_column')
    }
    expect(() => assertNoPersonalColumns('select n.plan, o.role from src_new_desk.users n join src_zendesk.users o on o.id = n.id', two)).not.toThrow()
    // DuckDB reads a string after FROM as a table name, whatever the string holds.
    expect(await codeOf(() => assertNoPersonalColumns(`select * from 'users'`, two))).toBe('personal_column')
    expect(await codeOf(() => assertNoPersonalColumns(`select * from src_new_desk.users n join 'x' on true`, two))).toBe('personal_column')
  })

  it('refuses multiplication beside a table with personal columns, because it cannot tell it from a star', async () => {
    expect(await codeOf(() => assertNoPersonalColumns('select id * 2 from src_zendesk.users', CATALOG))).toBe('personal_column')
  })

  it('has nothing to refuse when no column is personal, and still blocks the dynamic functions', async () => {
    const clean = CATALOG.filter((c) => !c.personal)
    expect(() => assertNoPersonalColumns(`select * from src_zendesk.users`, clean)).not.toThrow()
    expect(() => assertNoPersonalColumns(`select E'a', $$b$$`, clean)).not.toThrow()
    expect(await codeOf(() => assertNoPersonalColumns(BLOCKED[0]!, clean))).toBe('blocked_object')
  })

  it('reads strings, quoted names and comments as the database does', () => {
    expect(tokenize(`select 'it''s -- not a comment', "Na""me" /* c */ from t -- end`).map((t) => t.value)).toEqual(['select', "it's -- not a comment", ',', 'na"me', 'from', 't'])
    expect(tokenize('select $1, a$b').map((t) => `${t.kind}:${t.value}`)).toEqual(['ident:select', 'param:$1', 'op:,', 'ident:a$b'])
  })

  it('says which column, in one plain sentence with a next step', () => {
    try {
      assertNoPersonalColumns('select name from src_zendesk.users', CATALOG)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(CliError)
      expect((e as CliError).code).toBe('personal_column')
      expect((e as CliError).message).toMatch(/users\.name is marked personal/)
      expect((e as CliError).next).toMatch(/lifecycle schema --format json/)
    }
  })
})

// A real Postgres (PGlite) holding what an older version stored: a Zendesk user's name and email.
describe('query, schema and scrub on a Postgres warehouse', () => {
  let home: string
  let client: PGlite
  let db: Db

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'lc-0132-pg-'))
    process.env.LIFECYCLE_HOME = home
    process.env.LIFECYCLE_NO_KEYCHAIN = '1'
    writeConfig({ database: { kind: 'postgres' } })
    client = new PGlite()
    await client.waitReady
    db = wrapPglite(client)
    await migrate(db)
    await db.query(`INSERT INTO dim_flow (flow_id, name, source_synced_at) VALUES ('f1', 'Welcome series', now())`)
    await client.exec(`
      CREATE SCHEMA src_zendesk;
      CREATE TABLE src_zendesk.users (id BIGINT, name TEXT, email TEXT, alias TEXT, role TEXT, notes TEXT, created_at TIMESTAMPTZ, _dlt_id TEXT NOT NULL);
      INSERT INTO src_zendesk.users VALUES (1, '${NAME}', 'zed.fixture@example.org', 'zedfx', 'admin', 'call (555) 010-0142 or zed.notes@example.org', now(), 'row1'), (2, 'Yan Fixtureperson', NULL, NULL, 'end-user', 'nothing here', now(), 'row2');
      CREATE TABLE src_zendesk.tickets (id BIGINT, subject TEXT, requester_id BIGINT, status TEXT, _dlt_id TEXT NOT NULL);
      INSERT INTO src_zendesk.tickets VALUES (10, 'Where is order 1001', 1, 'open', 't1');
      CREATE SCHEMA src_judge_me;
      CREATE TABLE src_judge_me.reviews (id BIGINT, reviewer_name TEXT, reviewer__email TEXT NOT NULL, body TEXT, rating BIGINT, _dlt_id TEXT NOT NULL);
      INSERT INTO src_judge_me.reviews VALUES (5, '${NAME}', 'zed.fixture@example.org', 'Lovely, mail zed.review@example.org', 5, 'r1');
      CREATE TABLE src_judge_me.shop_info (id BIGINT, lat DOUBLE PRECISION NOT NULL, name TEXT);
      INSERT INTO src_judge_me.shop_info VALUES (1, 1.5, 'Fixture Shop');
    `)
  })
  afterAll(async () => {
    await client.close()
    rmSync(home, { recursive: true, force: true })
    delete process.env.LIFECYCLE_HOME
    delete process.env.LIFECYCLE_NO_KEYCHAIN
  })

  it('marks the stored name, email and alias personal, and the notes free text', async () => {
    const rows = await db.query(`SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema LIKE 'src\\_%'`)
    const marked = markColumns(rows.map((r) => ({ schema: String(r.table_schema), table: String(r.table_name), column: String(r.column_name), type: String(r.data_type) })))
    const of = (t: string, c: string) => marked.find((m) => `${m.schema}.${m.table}` === t && m.column === c)!
    for (const c of ['name', 'email', 'alias']) expect(of('src_zendesk.users', c)).toMatchObject({ personal: true, freeText: false })
    for (const c of ['id', 'role', 'created_at']) expect(of('src_zendesk.users', c)).toMatchObject({ personal: false, freeText: false })
    expect(of('src_zendesk.users', 'notes')).toMatchObject({ personal: false, freeText: true })
    expect(of('src_judge_me.reviews', 'reviewer_name').personal).toBe(true)
    expect(of('src_judge_me.reviews', 'reviewer__email').personal).toBe(true)
    expect(of('src_judge_me.shop_info', 'name').personal).toBe(false)
  })

  it('answers every allowed statement without the name in it', async () => {
    for (const sql of ALLOWED) {
      const r = await runQuery(db, sql)
      expect(JSON.stringify(r.rows), sql).not.toContain('Fixtureperson')
    }
    expect((await runQuery(db, 'select name from dim_flow')).rows).toEqual([{ name: 'Welcome series' }])
  })

  it('refuses every statement that could carry the name out, before it runs', async () => {
    for (const [what, sql] of REFUSED) expect(await codeOf(runQuery(db, sql)), `${what}: ${sql}`).toBe('personal_column')
    for (const sql of BLOCKED) expect(await codeOf(runQuery(db, sql)), sql).toBe('blocked_object')
    expect(await codeOf(runQuery(db, 'select reviewer_name from src_judge_me.reviews'))).toBe('personal_column')
    expect(await codeOf(runQuery(db, 'select * from src_judge_me.reviews'))).toBe('personal_column')
  })

  it('scrub shows counts first and changes nothing without --confirm', async () => {
    const r = await scrubWarehouse({ db })
    expect(r).toMatchObject({ applied: false, database: 'postgres', freeText: 'keep' })
    const users = r.tables.find((t) => t.table === 'src_zendesk.users')!
    expect(users.columns).toEqual([
      { column: 'name', why: 'personal', action: 'null', rows: 2, status: 'planned' },
      { column: 'email', why: 'personal', action: 'null', rows: 1, status: 'planned' },
      { column: 'alias', why: 'personal', action: 'null', rows: 1, status: 'planned' },
      { column: 'notes', why: 'free_text', action: 'rewrite', rows: 1, status: 'planned' },
    ])
    const reviews = r.tables.find((t) => t.table === 'src_judge_me.reviews')!
    expect(reviews.columns.find((c) => c.column === 'reviewer__email')).toMatchObject({ action: 'replace', rows: 1 })
    expect(r.tables.find((t) => t.table === 'src_judge_me.shop_info')!.columns).toEqual([{ column: 'lat', why: 'personal', action: 'blocked', rows: 0, status: 'blocked' }])
    expect(r.next).toBe('lifecycle warehouse scrub --confirm')
    // The report holds counts and column names, never a stored value.
    expect(JSON.stringify(r)).not.toMatch(/Fixtureperson|example\.org|zedfx|010-0142/)
    expect((await db.query(`SELECT count(name) AS n FROM src_zendesk.users`))[0]!.n).toBe(2)
  })

  it('scrub --confirm empties the personal columns and rewrites kept free text', async () => {
    const r = await scrubWarehouse({ confirm: true, db })
    expect(r.applied).toBe(true)
    expect(r.totals).toMatchObject({ blocked: 1, failed: 0 })
    expect(JSON.stringify(r)).not.toMatch(/Fixtureperson|example\.org|zedfx|010-0142/)
    const all = JSON.stringify([await db.query('SELECT * FROM src_zendesk.users ORDER BY id'), await db.query('SELECT * FROM src_judge_me.reviews')])
    expect(all).not.toMatch(/Fixtureperson|example\.org|zedfx|010-0142/)
    expect((await db.query('SELECT notes FROM src_zendesk.users ORDER BY id')).map((x) => x.notes)).toEqual(['call [removed] or [removed]', 'nothing here'])
    expect((await db.query('SELECT reviewer__email, body FROM src_judge_me.reviews'))[0]).toEqual({ reviewer__email: 'removed-r1', body: 'Lovely, mail [removed]' })
    expect((await db.query('SELECT id, role FROM src_zendesk.users ORDER BY id'))).toEqual([{ id: 1, role: 'admin' }, { id: 2, role: 'end-user' }])
    // A second run finds nothing left to do.
    expect((await scrubWarehouse({ db })).totals.values).toBe(0)
    // The columns are still there, still marked, and still refused.
    expect(await codeOf(runQuery(db, 'select name from src_zendesk.users'))).toBe('personal_column')
  })

  it('scrub empties free text too when warehouse.free_text is drop', async () => {
    setSetting('warehouse.free_text', 'drop')
    try {
      const r = await scrubWarehouse({ confirm: true, db })
      expect(r.freeText).toBe('drop')
      expect((await db.query('SELECT count(notes) AS n FROM src_zendesk.users'))[0]!.n).toBe(0)
      expect((await db.query('SELECT count(subject) AS n FROM src_zendesk.tickets'))[0]!.n).toBe(0)
      expect((await db.query('SELECT count(body) AS n FROM src_judge_me.reviews'))[0]!.n).toBe(0)
    } finally {
      setSetting('warehouse.free_text', 'keep')
    }
  })
})

describe('warehouse.free_text', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lc-0132-cfg-'))
    process.env.LIFECYCLE_HOME = home
    process.env.LIFECYCLE_NO_KEYCHAIN = '1'
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'LIFECYCLE_UV_PATH', 'LIFECYCLE_SRC_GORGIAS_API_KEY', 'JOB_OUT']) delete process.env[k]
  })

  it('is keep unless set to drop, takes nothing else, and survives a config with no warehouse sources', async () => {
    writeConfig({ database: { kind: 'local' } })
    expect(freeTextMode()).toBe('keep')
    expect(await codeOf(() => setSetting('warehouse.free_text', 'sometimes'))).toBe('bad_value')
    setSetting('warehouse.free_text', 'drop')
    expect(getSetting('warehouse.free_text')).toBe('drop')
    expect(freeTextMode()).toBe('drop')
    expect(readRawConfig().warehouse).toEqual({ free_text: 'drop' })
    // A value typed into the file by hand that this version does not know reads as keep.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ database: { kind: 'local' }, warehouse: { free_text: 'maybe' } }))
    expect(freeTextMode()).toBe('keep')
  })

  it('sends the rule list and the setting with every loader job, and keeps the setting when a source connects', async () => {
    const params = Object.fromEntries(WAREHOUSE_CATALOG.find((s) => s.slug === 'gorgias')!.params.map((p) => [p.name, 'fixture']))
    writeConfig({ database: { kind: 'local' }, warehouse: { free_text: 'drop', sources: { gorgias: { params, personalData: 'strip', connectedAt: '2026-11-24T00:00:00.000Z' } } } })
    // A stand-in for uv that saves the job it was handed and answers like a finished load.
    const uv = join(home, 'uv')
    writeFileSync(uv, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "uv 0.0.0"; exit 0; fi\ncat > "$JOB_OUT"\necho '{"ok": true, "rows": 0, "tables": {}}'\n`, { mode: 0o755 })
    process.env.LIFECYCLE_UV_PATH = uv
    process.env.JOB_OUT = join(home, 'job.json')
    process.env.LIFECYCLE_SRC_GORGIAS_API_KEY = 'fixture-key'
    expect((await syncSources(undefined))[0]).toMatchObject({ source: 'gorgias', status: 'ok' })
    const job = JSON.parse(readFileSync(join(home, 'job.json'), 'utf8'))
    expect(job).toMatchObject({ action: 'sync', personal_data: 'strip', free_text: 'drop' })
    expect(job.rules).toEqual(JSON.parse(JSON.stringify(PERSONAL_RULES)))
    expect(JSON.stringify(job)).not.toContain('fixture-key')
    await connectSource('gorgias', { skipCheck: true })
    expect(readRawConfig().warehouse.free_text).toBe('drop')
  })

  it('stops a load that has no rule list, in place of loading unfiltered rows', () => {
    const res = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, 'connectors')
import run
run.RULES_FILE = '/nonexistent/personal-rules.json'
try:
    run.rules({})
    print('loaded')
except ValueError as e:
    print('stopped:', e)
`], { encoding: 'utf8' })
    expect(res.stdout).toMatch(/^stopped: The personal data rules are missing/)
  })
})

describe('schema marks every column', () => {
  it('adds personal to Cloud columns: Cloud\'s own flag when it sends one, else the rule list', async () => {
    const reply = { schemas: [{ name: 'store_x', tables: [{ name: 'fact_orders_daily', rows: 3, columns: [{ name: 'date', type: 'date' }, { name: 'orders', type: 'bigint' }] }, { name: 'users', columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'text' }, { name: 'plan', type: 'text', personal: true }] }] }] }
    const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply)))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const s = await new CloudClient({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: 'fixture-token' }).schema()
      expect(s.schemas[0]!.tables[0]!.columns).toEqual([{ name: 'date', type: 'date', personal: false }, { name: 'orders', type: 'bigint', personal: false }])
      expect(s.schemas[0]!.tables[1]!.columns).toEqual([{ name: 'id', type: 'bigint', personal: false }, { name: 'name', type: 'text', personal: true }, { name: 'plan', type: 'text', personal: true }])
    } finally {
      server.close()
    }
  })
})

// The real CLI in its own process, on a fresh local store.
describe('through the real CLI', () => {
  let home: string
  const cli = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, [resolve('node_modules', 'tsx', 'dist', 'cli.mjs'), resolve('src', 'cli.ts'), '--format', 'json', ...args], { env: { ...process.env, LIFECYCLE_HOME: home, HOME: home, LIFECYCLE_NO_KEYCHAIN: '1', LIFECYCLE_NO_UPDATE_CHECK: '1' } })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (status) => done({ status, stdout, stderr }))
    })
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'lc-0132-cli-'))
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('prints personal on every column of schema, refuses a blocked function, and lists the new setting', async () => {
    expect((await cli(['init'])).status).toBe(0)
    const schema = JSON.parse((await cli(['schema'])).stdout) as Record<string, { column: string; type: string; personal: boolean; freeText: boolean }[]>
    expect(Object.keys(schema)).toContain('dim_flow')
    for (const [t, cols] of Object.entries(schema)) for (const c of cols) expect(c, `${t}.${c.column}`).toMatchObject({ personal: false, freeText: false })
    expect(schema.dim_flow!.find((c) => c.column === 'name')).toEqual({ column: 'name', type: 'text', personal: false, freeText: false })
    const ok = await cli(['query', 'select count(*) as n from dim_flow'])
    expect(JSON.parse(ok.stdout).rows).toEqual([{ n: 0 }])
    const blocked = await cli(['query', 'select most_common_vals::text from pg_stats'])
    expect(blocked.status).toBe(1)
    expect(JSON.parse(blocked.stderr.trim().split('\n').pop()!)).toMatchObject({ code: 'blocked_object' })
    const settings = JSON.parse((await cli(['config', 'list'])).stdout) as { key: string; default: unknown }[]
    expect(settings.find((s) => s.key === 'warehouse.free_text')).toMatchObject({ default: 'keep', value: null })
    const scrub = JSON.parse((await cli(['warehouse', 'scrub'])).stdout)
    expect(scrub).toMatchObject({ applied: false, database: 'local', tables: [], totals: { values: 0 } })
  }, 120_000)
})

// End to end through uv, dlt and DuckDB against a local stand-in API. Skipped where uv is not installed.
describe.skipIf(!uvAvailable())('a local warehouse, end to end', () => {
  let home: string
  let server: Server
  const PERSON = { name: NAME, email: 'zed.fixture@example.org', phone: '+1 555 010 0177' }
  const raw = async (sql: string) => {
    const r = await runRunner({ action: 'query', sql, limit: 1000, destination: { kind: 'duckdb', path: join(home, 'warehouse.duckdb') } }, {})
    if (!r.ok) throw new Error(r.error)
    return r.rows as Record<string, unknown>[]
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'lc-0132-wh-'))
    process.env.LIFECYCLE_HOME = home
    process.env.LIFECYCLE_NO_KEYCHAIN = '1'
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const page = Number(url.searchParams.get('page') ?? '1')
      const rows: Record<string, unknown[]> = {
        '/users': [
          { id: 1, name: PERSON.name, alias: 'zedfx', email: PERSON.email, phone: PERSON.phone, role: 'admin', time_zone: 'UTC', notes: `Likes a call on ${PERSON.phone}`, photo: { content_url: 'https://example.org/zed.png' }, organization: { id: 9, name: 'Fixture Org' } },
          { id: 2, name: 'Yan Fixtureperson', role: 'end-user', time_zone: 'UTC', notes: 'nothing here' },
        ],
        '/tickets': [{ id: 10, subject: `Order late, write ${PERSON.email}`, status: 'open', requester_id: 1, requester: { id: 1, name: PERSON.name }, author: PERSON.name, product: { name: 'Fixture Mug' } }],
        '/reviews': [{ id: 5, name: PERSON.name, reviewer_name: PERSON.name, title: 'Lovely', body: `Great mug. ${PERSON.phone}`, rating: 5, product_name: 'Fixture Mug' }],
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: page > 1 ? [] : rows[url.pathname] ?? [] }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    writeConfig({ database: { kind: 'local' } })
    const resource = (name: string) => ({ name, endpoint: { path: name, data_selector: 'data', paginator: { type: 'page_number', page_param: 'page', base_page: 1, total_path: null } } })
    writeFileSync(join(home, 'spec.json'), JSON.stringify({
      name: 'Mock Desk', category: 'helpdesk', credentials: [{ name: 'api_key', label: 'API key' }],
      config: { client: { base_url: `http://127.0.0.1:${port}/`, auth: { type: 'bearer', token: '{secret:api_key}' } }, resource_defaults: { primary_key: 'id', write_disposition: 'merge' }, resources: ['users', 'tickets', 'reviews'].map(resource) },
    }))
    for (const slug of ['new-desk', 'old-desk', 'quiet-desk']) {
      addCustomSource(slug, join(home, 'spec.json'))
      process.env[`LIFECYCLE_SRC_${slug.toUpperCase().replace('-', '_')}_API_KEY`] = 'fixture-key'
    }
  }, 60_000)

  afterAll(() => {
    server?.close()
    rmSync(home, { recursive: true, force: true })
    for (const k of ['LIFECYCLE_HOME', 'LIFECYCLE_NO_KEYCHAIN', 'LIFECYCLE_SRC_NEW_DESK_API_KEY', 'LIFECYCLE_SRC_OLD_DESK_API_KEY', 'LIFECYCLE_SRC_QUIET_DESK_API_KEY']) delete process.env[k]
  })

  it('loads a people table with no name, email, phone, alias or photo, and keeps the rest', async () => {
    await connectSource('new-desk', {})
    expect((await syncSources(['new-desk']))[0]).toMatchObject({ status: 'ok', rows: 4 })
    const cols = await duckSchema('new-desk')
    const names = (t: string) => cols.filter((c) => c.table === t).map((c) => c.column).sort()
    expect(names('users')).toEqual(['id', 'notes', 'organization__id', 'role', 'time_zone'])
    expect(names('tickets')).toEqual(['id', 'product__name', 'requester__id', 'requester_id', 'status', 'subject'])
    expect(names('reviews')).toEqual(['body', 'id', 'product_name', 'rating', 'title'])
    expect(cols.every((c) => c.personal === false)).toBe(true)
    expect(cols.filter((c) => c.freeText).map((c) => `${c.table}.${c.column}`).sort()).toEqual(['reviews.body', 'reviews.title', 'tickets.subject', 'users.notes'])
    // Nothing personal is stored anywhere in the file, so a star is fine here.
    const everything = JSON.stringify([await duckQuery('select * from src_new_desk.users'), await duckQuery('select * from src_new_desk.tickets'), await duckQuery('select * from src_new_desk.reviews')])
    expect(everything).not.toMatch(/Fixtureperson|example\.org|zedfx|555 010/)
    expect(everything).toContain('Likes a call on [removed]')
    expect(everything).toContain('Order late, write [removed]')
    expect(everything).toContain('Great mug. [removed]')
    expect(everything).toContain('Fixture Mug')
  }, 240_000)

  it('leaves free text out when warehouse.free_text is drop', async () => {
    setSetting('warehouse.free_text', 'drop')
    try {
      await connectSource('quiet-desk', {})
      expect((await syncSources(['quiet-desk']))[0]).toMatchObject({ status: 'ok' })
    } finally {
      setSetting('warehouse.free_text', 'keep')
    }
    const cols = (await duckSchema('quiet-desk')).map((c) => `${c.table}.${c.column}`).sort()
    expect(cols).toEqual(['reviews.id', 'reviews.product_name', 'reviews.rating', 'tickets.id', 'tickets.product__name', 'tickets.requester__id', 'tickets.requester_id', 'tickets.status', 'users.id', 'users.organization__id', 'users.role', 'users.time_zone'])
  }, 240_000)

  it('marks, refuses and scrubs what an older version stored', async () => {
    // --keep-personal-data loads every field, which is what a warehouse filled before this release can hold.
    await connectSource('old-desk', { keepPersonalData: true })
    expect((await syncSources(['old-desk']))[0]).toMatchObject({ status: 'ok' })
    expect(JSON.stringify(await raw('select name, email from src_old_desk.users order by id'))).toContain(NAME)

    const cols = await duckSchema('old-desk')
    const personal = cols.filter((c) => c.personal).map((c) => `${c.table}.${c.column}`).sort()
    expect(personal).toEqual(['reviews.name', 'reviews.reviewer_name', 'tickets.author', 'tickets.requester__name', 'users.alias', 'users.email', 'users.name', 'users.organization__name', 'users.phone', 'users.photo__content_url'])

    for (const [what, sql] of REFUSED.filter(([, s]) => !/judge_me|staging/.test(s))) {
      expect(await codeOf(duckQuery(sql.replace(/src_zendesk/g, 'src_old_desk'))), `${what}`).toBe('personal_column')
    }
    expect(await codeOf(duckQuery(`select * from query('select name from src_old_desk.users')`))).toBe('blocked_object')
    expect((await duckQuery('select id, role from src_old_desk.users order by id')).rows).toEqual([{ id: 1, role: 'admin' }, { id: 2, role: 'end-user' }])
    expect((await duckQuery('select count(*) as n from src_old_desk.users')).rows).toEqual([{ n: 2 }])

    // Before this release the loader kept a copy of every loaded row in its working folder. This one does not.
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]))
    expect(walk(join(home, 'dlt')).filter((f) => /completed_jobs/.test(f))).toEqual([])
    const stale = join(home, 'dlt', 'lifecycle_old_desk', 'load', 'loaded', '1700000000.1', 'completed_jobs')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'users.abc.0.insert_values'), `1,'${NAME}'`)

    const dry = await scrubWarehouse()
    expect(dry.applied).toBe(false)
    expect(dry.loaderFiles.files).toBeGreaterThan(0)
    expect(dry.loaderFiles.removed).toBe(false)
    expect(existsSync(join(stale, 'users.abc.0.insert_values'))).toBe(true)
    expect(readFileSync(join(home, 'warehouse.duckdb')).includes(Buffer.from(NAME))).toBe(true)
    expect(JSON.stringify(dry)).not.toMatch(/Fixtureperson|example\.org|zedfx|555 010/)
    const users = dry.tables.find((t) => t.table === 'src_old_desk.users')!
    expect(users.columns.find((c) => c.column === 'name')).toEqual({ column: 'name', why: 'personal', action: 'null', rows: 2, status: 'planned' })
    expect(users.columns.find((c) => c.column === 'notes')).toEqual({ column: 'notes', why: 'free_text', action: 'rewrite', rows: 1, status: 'planned' })
    expect(JSON.stringify(await raw('select name from src_old_desk.users'))).toContain(NAME)

    const done = await scrubWarehouse({ confirm: true })
    expect(done.applied).toBe(true)
    expect(done.totals.failed).toBe(0)
    const after = JSON.stringify([await raw('select * from src_old_desk.users'), await raw('select * from src_old_desk.tickets'), await raw('select * from src_old_desk.reviews'), await raw('select * from src_old_desk_staging.users')])
    expect(after).not.toMatch(/Fixtureperson|example\.org|zedfx|555 010/)
    expect(after).toContain('Likes a call on [removed]')
    expect(after).toContain('Fixture Mug')
    // Gone from the loader's folder and from the bytes of the database file, not only from queries.
    expect(done.loaderFiles.removed).toBe(true)
    expect(existsSync(stale)).toBe(false)
    expect(done.rebuilt).toBe(true)
    for (const text of [NAME, 'zed.fixture@example.org', 'zedfx']) expect(readFileSync(join(home, 'warehouse.duckdb')).includes(Buffer.from(text)), text).toBe(false)
    expect(walk(home).filter((f) => !f.endsWith('spec.json') && readFileSync(f).includes(Buffer.from('Fixtureperson')))).toEqual([])
    const again = await scrubWarehouse()
    expect(again.totals.values).toBe(0)
    expect(again.loaderFiles.files).toBe(0)
    // The rebuilt file still takes a load: the source that removes personal data syncs into it again.
    expect((await syncSources(['new-desk']))[0]).toMatchObject({ status: 'ok', rows: 4 })
    expect((await duckQuery('select count(*) as n from src_new_desk.users')).rows).toEqual([{ n: 2 }])
  }, 360_000)
})

describe('docs and release', () => {
  it('is version 0.13.2 everywhere a version is written', () => {
    expect(VERSION).toBe('0.13.2')
    expect(JSON.parse(readFileSync('package-lock.json', 'utf8')).version).toBe('0.13.2')
    expect(readFileSync('CHANGELOG.md', 'utf8')).toMatch(/^## 0\.13\.2 \(2026-11-24\)/m)
  })

  it('documents the command, the code, the setting and the rules', () => {
    expect(DOCS.commands).toContain('scrub')
    expect(DOCS.warehouse).toContain('lifecycle warehouse scrub')
    expect(DOCS.warehouse).toContain('warehouse.free_text')
    for (const c of ['personal_column', 'scrub_failed']) expect(DOCS.troubleshooting, c).toMatch(new RegExp(`^  ${c}\\s`, 'm'))
    const changelog = readFileSync('CHANGELOG.md', 'utf8')
    for (const c of ['`personal_column`', '`warehouse.free_text`', '`lifecycle warehouse scrub [--confirm]`', '`personal`', '`scrub_failed`']) expect(changelog, c).toContain(c)
    expect(readFileSync(join('docs', 'COMMANDS.md'), 'utf8')).toContain('warehouse scrub')
    expect(existsSync(join('docs', 'PERSONAL-DATA.md'))).toBe(true)
  })

  it('has no em or en dash in anything this release wrote', () => {
    for (const f of ['CHANGELOG.md', 'README.md', 'docs/COMMANDS.md', 'docs/PERSONAL-DATA.md', 'src/personal.ts', 'src/sql-guard.ts', 'src/warehouse.ts', 'src/warehouse-names.ts', 'src/query.ts', 'src/cli.ts', 'src/docs.ts', 'connectors/run.py', 'connectors/personal-rules.json', 'test/release-0132.test.ts', 'test/fixtures/people-rows.ts']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/[\u2013\u2014]/)
    }
  })

  it('ships the rule file the loader reads', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).files).toContain('connectors/personal-rules.json')
    expect(norm('ship_to')).toBe('shipto')
  })
})
