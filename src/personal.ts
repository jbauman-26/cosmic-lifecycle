// The one rule list for personal data. Everything that decides whether a field is personal reads it:
//
//   the loader (connectors/run.py)  drops or scrubs fields before anything is written
//   lifecycle schema                marks each column `personal: true|false`
//   lifecycle query                 refuses a statement that reads a personal column
//   lifecycle warehouse scrub       nulls personal columns an older version stored
//
// The loader is Python, so `npm run build` writes PERSONAL_RULES to connectors/personal-rules.json and
// the CLI also sends it with every loader job. The Python side holds the same small algorithm and no
// word lists of its own. test/release-0132.test.ts runs both sides over the same keys and fails when
// they disagree.
//
// THE RULES, in the order they are applied to one field. A field is a key in a row (the loader) or a
// column in a table (schema, query, scrub). Nested keys are walked from the outside in; a column such
// as customer__first_name is the path customer > first_name. Keys are compared as lowercase words:
// firstName, first_name and first-name are the same key.
//
//  1. Per source.   `sources` names a table and a key path for a source in the catalog and says
//                   personal, free_text or keep. It wins over every rule below.
//  2. Always.       A key with a word from `always` is personal wherever it sits: email, phone, mobile,
//                   address, street, zip, postal, birthday, ip, latitude, longitude, password, token and
//                   the like. Plurals count (emails, phones).
//  3. Named person. A key with the word `name` and a word from `nameOwners` is personal: first_name,
//                   reviewer_name, authorName, assignee_name, requester_name, display_name.
//  4. People rows.  A table in `peopleTables` (users, customers, contacts ...) holds one person per row,
//                   and a key with a word from `personWords` (customer, reviewer, ship_to ...) holds a
//                   person. Inside either, a key with a word from `inPersonWords` is personal: name,
//                   alias, handle, avatar, signature, social handles, street lines.
//  5. Person text.  A text value stored directly under a key from `personScalars` is that person's
//                   name or handle: author, reviewer, customer, recipient. Numbers are kept (an id).
//  6. Authored.     In a table from `authoredTables` (reviews), a top-level key from `authoredKeys`
//                   (name, nickname) is the writer's name.
//  7. Region stays. country, state, province, region, city, time zone, locale, language and currency
//                   are kept, also inside a person. Street lines, postal codes and coordinates are not.
//  8. Free text.    A text key whose last word is in `freeTextWords` (subject, body, message, comment,
//                   note ...) is free text, except in a table the store wrote itself (`storeTables`:
//                   campaigns, flows, segments ...). Free text can hold anything a customer typed,
//                   including a name. `warehouse.free_text keep` (the default) keeps it with email
//                   addresses and phone numbers replaced by [removed]. `drop` removes the field.
//     A key with a word from `freeTextContainers` (custom_fields, metadata, properties) holds open-ended
//     fields: everything under it is free text. Inside a person such a key is removed (rule 4).
//  9. Everything else is kept: ids, counts, amounts, timestamps, statuses, product and campaign names.
//     An email address inside any kept text is still replaced by [removed], and so is a value that is
//     nothing but a phone number starting with +.

export type FieldClass = 'personal' | 'free_text' | 'keep'
export type FreeTextMode = 'keep' | 'drop'

export const PERSONAL_RULES = {
  version: 1,
  always: [
    'email', 'phone', 'mobile', 'telephone', 'tel', 'fax', 'firstname', 'lastname', 'fullname', 'surname', 'fname', 'lname',
    'givenname', 'familyname', 'middlename', 'maidenname', 'nickname', 'username', 'screenname', 'signedby',
    'address', 'address1', 'address2', 'address3', 'street', 'street1', 'street2', 'zip', 'zipcode', 'postcode', 'postal',
    'birthday', 'birthdate', 'birth', 'dob', 'ssn', 'ip', 'ipaddress', 'latitude', 'longitude', 'lat', 'lng', 'lon', 'geolocation',
    'smses', 'msisdn', 'cellphone', 'landline', 'password', 'token', 'secret',
  ],
  nameOwners: [
    'first', 'last', 'full', 'middle', 'given', 'family', 'legal', 'maiden', 'nick', 'screen', 'customer', 'billing', 'shipping',
    'contact', 'recipient', 'sender', 'author', 'reviewer', 'buyer', 'user', 'display', 'person', 'profile', 'subscriber',
    'member', 'owner', 'assignee', 'requester', 'submitter', 'agent', 'shopper', 'respondent', 'receiver', 'cardholder', 'payer',
  ],
  personWords: [
    'customer', 'billing', 'shipping', 'contact', 'recipient', 'sender', 'author', 'reviewer', 'buyer', 'user', 'person',
    'profile', 'subscriber', 'member', 'owner', 'assignee', 'requester', 'submitter', 'agent', 'shopper', 'respondent',
    'receiver', 'addressee', 'consignee', 'cardholder', 'payer', 'asker',
  ],
  // Whole keys that hold a person, written without separators: ship_to is shipto.
  personKeys: [
    'shipto', 'shipfrom', 'returnto', 'billto', 'soldto', 'sendto', 'deliverto', 'createdby', 'updatedby', 'modifiedby', 'deletedby', 'approvedby',
    'closedby', 'assignedto', 'assignedby', 'repliedby', 'submittedby', 'postedby', 'writtenby', 'reportedby', 'requestedby', 'ownedby',
  ],
  peopleTables: [
    'user', 'customer', 'contact', 'member', 'subscriber', 'profile', 'people', 'person', 'recipient', 'agent', 'reviewer',
    'shopper', 'buyer', 'author', 'requester', 'assignee', 'respondent', 'lead',
  ],
  authoredTables: ['review', 'testimonial'],
  inPersonWords: [
    'name', 'alias', 'handle', 'initials', 'signature', 'avatar', 'photo', 'picture', 'gravatar', 'bio',
    'twitter', 'facebook', 'instagram', 'linkedin', 'tiktok', 'whatsapp', 'telegram', 'skype', 'social',
    // Open-ended fields about the person: anything can be in them.
    'custom', 'metadata', 'properties', 'traits', 'fields', 'extra',
  ],
  inPersonKeys: ['first', 'last', 'line1', 'line2', 'line3'],
  personScalars: [
    'customer', 'contact', 'recipient', 'sender', 'author', 'reviewer', 'buyer', 'user', 'person', 'subscriber', 'member',
    'owner', 'assignee', 'requester', 'submitter', 'agent', 'shopper', 'respondent', 'receiver', 'addressee', 'consignee', 'asker',
    'createdby', 'updatedby', 'modifiedby', 'deletedby', 'approvedby', 'closedby', 'assignedto', 'assignedby', 'repliedby', 'submittedby',
    'postedby', 'writtenby', 'reportedby', 'requestedby', 'ownedby',
  ],
  authoredKeys: ['name', 'nickname', 'displayname'],
  authoredFreeText: ['title'],
  region: [
    'country', 'countrycode', 'countryname', 'state', 'statecode', 'statename', 'province', 'provincecode', 'provincename',
    'region', 'regioncode', 'regionname', 'city', 'cityname', 'timezone', 'ianatimezone', 'locale', 'language', 'currency',
  ],
  freeTextWords: [
    'subject', 'body', 'message', 'comment', 'comments', 'note', 'notes', 'description', 'content', 'excerpt', 'preview',
    'snippet', 'summary', 'feedback', 'transcript', 'details', 'reply', 'answer', 'instructions',
  ],
  // A key with one of these words holds open-ended fields (custom_fields, metadata, properties). Everything
  // under it is free text, whatever its type.
  freeTextContainers: ['custom', 'metadata', 'properties'],
  // A last word that says "this is text" when another word is a free text word: body_html, description_text.
  freeTextTails: ['html', 'text', 'plain', 'raw'],
  storeTables: [
    'campaign', 'emailcampaign', 'smscampaign', 'flowcampaign', 'flow', 'automation', 'list', 'segment', 'folder', 'display',
    'coupon', 'viptier', 'loyaltyreward', 'courier', 'shopinfo', 'campaignreport', 'inventorylevel', 'invoice',
    'campaignperformance30d', 'flowperformance30d', 'displayperformance30d', 'transactionalemaildailystat', 'adsdaily',
    'pixelattributiondaily', 'csatsurvey',
  ],
  // The CLI's own tables hold totals and names the store wrote: flows, campaigns, segments, checks.
  storePrefixes: ['dim_', 'fact_', 'meta_', 'custom_'],
  // Per source, from each vendor's API reference: table, then key path (nested keys joined by __), then the decision.
  sources: {
    zendesk: {
      users: { user_fields: 'personal', notes: 'free_text', details: 'free_text' },
      tickets: { via__source: 'personal', custom_fields: 'free_text', fields: 'free_text' },
    },
    gorgias: {
      customers: { data: 'personal', meta: 'personal', note: 'free_text' },
      tickets: { meta: 'free_text' },
    },
    recharge: {
      customers: { hash: 'personal' },
      subscriptions: { customer__hash: 'personal' },
      charges: { customer__hash: 'personal', note_attributes: 'free_text' },
      orders: { customer__hash: 'personal', note_attributes: 'free_text' },
    },
    omnisend: { contacts: { identifiers: 'personal', custom_properties: 'personal' } },
    privy: { contacts: { custom_fields: 'personal' } },
    loyaltylion: { customers: { properties: 'personal', metadata: 'personal' } },
    kustomer: {
      customers: { attributes__socials: 'personal', attributes__shared_socials: 'personal', attributes__urls: 'personal', attributes__custom: 'personal' },
      conversations: { attributes__name: 'free_text', attributes__custom: 'free_text' },
      messages: { attributes__meta: 'personal', attributes__custom: 'free_text' },
    },
    freshdesk: {
      contacts: { twitter_id: 'personal', facebook_id: 'personal', custom_fields: 'personal' },
      tickets: { name: 'personal', twitter_id: 'personal', facebook_id: 'personal', custom_fields: 'free_text' },
    },
    're-amaze': { conversations: { author__data: 'personal' }, messages: { user__data: 'personal' } },
    'yotpo-reviews': { reviews: { custom_fields: 'free_text' }, questions: { name: 'personal', title: 'free_text' } },
    'judge-me': { reviews: { reviewer__tags: 'personal' } },
    okendo: { reviews: { reviewer__location: 'personal' } },
    fairing: { responses: { response: 'keep', other_response: 'free_text' } },
    'aftership-tracking': {
      trackings: { destination_raw_location: 'personal', origin_raw_location: 'personal', custom_fields: 'free_text' },
    },
    shippo: {
      transactions: { label_url: 'personal', commercial_invoice_url: 'personal', qr_code_url: 'personal', metadata: 'free_text' },
      orders: { notes: 'free_text' },
    },
    shipstation: {
      labels: { label_download: 'personal', form_download: 'personal', paperless_download: 'personal' },
    },
  },
} as const

export type PersonalRules = typeof PERSONAL_RULES

// One sentence per rule, for docs and for `lifecycle docs warehouse`.
export const RULE_SUMMARY = [
  'Removed everywhere: email, phone, mobile, fax, street address, postal code, birthday, IP address, coordinates, passwords and tokens.',
  "Removed everywhere: a person's name (first, last, full, given, family, display, nick, user, reviewer, author, requester, assignee, customer, recipient, sender).",
  'Removed in a table of people (users, customers, contacts, members, subscribers ...) and inside a person object (customer, reviewer, ship_to ...): name, alias, handle, initials, avatar, photo, signature, social handles and street lines.',
  "Removed: text stored directly under author, reviewer, customer, recipient and the like, and a review's own name or nickname field.",
  'Kept: ids, counts, amounts, timestamps, statuses, product and campaign names, and country, state or province, region, city, time zone, locale, language and currency.',
  'Free text (subject, body, message, comment, note, description ...) is kept with email addresses and phone numbers replaced by [removed], or dropped when warehouse.free_text is drop.',
]

const set = (list: readonly string[]) => new Set<string>(list)
const ALWAYS = set(PERSONAL_RULES.always)
const NAME_OWNERS = set(PERSONAL_RULES.nameOwners)
const PERSON_WORDS = set(PERSONAL_RULES.personWords)
const PERSON_KEYS = set(PERSONAL_RULES.personKeys)
const PEOPLE_TABLES = set(PERSONAL_RULES.peopleTables)
const AUTHORED_TABLES = set(PERSONAL_RULES.authoredTables)
const IN_PERSON_WORDS = set(PERSONAL_RULES.inPersonWords)
const IN_PERSON_KEYS = set(PERSONAL_RULES.inPersonKeys)
const PERSON_SCALARS = set(PERSONAL_RULES.personScalars)
const AUTHORED_KEYS = set(PERSONAL_RULES.authoredKeys)
const AUTHORED_FREE_TEXT = set(PERSONAL_RULES.authoredFreeText)
const REGION = set(PERSONAL_RULES.region)
const FREE_TEXT_WORDS = set(PERSONAL_RULES.freeTextWords)
const FREE_TEXT_TAILS = set(PERSONAL_RULES.freeTextTails)
const FREE_TEXT_CONTAINERS = set(PERSONAL_RULES.freeTextContainers)
const STORE_TABLES = set(PERSONAL_RULES.storeTables)

/** A key as lowercase words: firstName, first_name and first-name are all [first, name]. */
export function words(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}
/** A key with its separators gone: ship_to is shipto. */
export const norm = (key: string) => words(key).join('')

// A word is in a list as written or as a plural of a listed word: emails, addresses.
const has = (list: Set<string>, w: string) => list.has(w) || (w.endsWith('s') && list.has(w.slice(0, -1))) || (w.endsWith('es') && list.has(w.slice(0, -2)))

export function isPersonalKey(key: string): boolean {
  const ws = words(key)
  if (has(ALWAYS, ws.join('')) || ws.some((w) => has(ALWAYS, w))) return true
  return ws.includes('name') && ws.some((w) => NAME_OWNERS.has(w))
}
export const isRegionKey = (key: string) => REGION.has(norm(key))
export function ownsPerson(key: string): boolean {
  return has(PERSON_KEYS, norm(key)) || words(key).some((w) => has(PERSON_WORDS, w))
}
export function inPersonKey(key: string): boolean {
  if (isRegionKey(key)) return false
  return IN_PERSON_KEYS.has(norm(key)) || words(key).some((w) => has(IN_PERSON_WORDS, w))
}
export const personScalarKey = (key: string) => has(PERSON_SCALARS, norm(key))
export function freeTextKey(key: string): boolean {
  const ws = words(key)
  const last = ws.at(-1)
  if (!last) return false
  return FREE_TEXT_WORDS.has(last) || (FREE_TEXT_TAILS.has(last) && ws.some((w) => FREE_TEXT_WORDS.has(w)))
}

export const freeTextContainer = (key: string) => words(key).some((w) => FREE_TEXT_CONTAINERS.has(w))

const lastWord = (table: string) => words(table).at(-1) ?? ''
/** The table a child table hangs from: customers__addresses is customers. */
export const rootTable = (table: string) => table.split('__')[0] ?? table
export const isPeopleTable = (table: string) => has(PEOPLE_TABLES, lastWord(rootTable(table)))
export const isAuthoredTable = (table: string) => has(AUTHORED_TABLES, lastWord(rootTable(table)))
export function isStoreTable(table: string): boolean {
  const root = rootTable(table).toLowerCase()
  return PERSONAL_RULES.storePrefixes.some((p) => root.startsWith(p)) || has(STORE_TABLES, norm(root))
}

type Overrides = Record<string, FieldClass>
/** The per-source decisions for one table, keyed by normalized key path. */
export function overridesFor(source: string | undefined, table: string): Overrides {
  const tables = source ? (PERSONAL_RULES.sources as Record<string, Record<string, Record<string, string>>>)[source] : undefined
  const mine = tables?.[rootTable(table)]
  if (!mine) return {}
  return Object.fromEntries(Object.entries(mine).map(([path, v]) => [path.split('__').map(norm).join('__'), v as FieldClass]))
}

const TEXT_TYPE = /char|text|string|json|clob|unknown|variant|struct|map|list|array|\[\]/i

/**
 * What one column is. `table` is the table's own name (no schema), `column` the column as the database
 * names it. `type` is the database type when known: a number under `author` is an id, text is a name.
 */
export function classifyColumn(c: { source?: string; table: string; column: string; type?: string }): FieldClass {
  const nested = c.table.split('__').slice(1)
  const segs = [...nested, ...c.column.split('__')].filter(Boolean)
  if (!segs.length) return 'keep'
  const overrides = overridesFor(c.source, c.table)
  let inPerson = isPeopleTable(c.table)
  const store = isStoreTable(c.table)
  // Inside open-ended fields everything is free text, unless a rule below says personal.
  let free = false
  const path: string[] = []
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    const leaf = i === segs.length - 1
    path.push(norm(seg))
    const o = overrides[path.join('__')]
    if (o === 'personal') return 'personal'
    if (o === 'free_text') {
      if (leaf) return 'free_text'
      free = true
    } else if (o === 'keep') {
      if (leaf) return free ? 'free_text' : 'keep'
    } else {
      if (isPersonalKey(seg)) return 'personal'
      if (inPerson && inPersonKey(seg)) return 'personal'
      if (!store && freeTextContainer(seg)) free = true
    }
    if (!leaf) inPerson = inPerson || ownsPerson(seg)
  }
  const leaf = segs.at(-1)!
  const texty = c.type === undefined || TEXT_TYPE.test(c.type)
  const top = segs.length === 1
  const authored = isAuthoredTable(c.table)
  if (texty && personScalarKey(leaf)) return 'personal'
  if (texty && authored && top && AUTHORED_KEYS.has(norm(leaf))) return 'personal'
  if (free) return 'free_text'
  if (texty && !store && (freeTextKey(leaf) || (authored && top && AUTHORED_FREE_TEXT.has(norm(leaf))))) return 'free_text'
  return 'keep'
}

export const isPersonalColumn = (c: { source?: string; table: string; column: string; type?: string }) => classifyColumn(c) === 'personal'

// ---- Text: what is taken out of free text that is kept ----

/** An email address anywhere in a string. The same pattern runs in the loader, in Postgres and here. */
export const EMAIL_PATTERN = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'
/**
 * A phone number: + and at least eight digits in groups, or ten digits written as 3-3-4 with
 * optional spaces, dots, dashes or brackets. A date (2026-11-24), a time, a price, an order number of
 * another length and a 13 digit timestamp do not match. A bare ten digit number does: in free text
 * that is far more often a phone than anything else.
 */
export const PHONE_PATTERN = '(?<![\\w+])(?:\\+(?=(?:[ .()-]*\\d){8})\\d{1,3}(?:[ .-]?\\(?\\d{1,4}\\)?){1,4}[ .-]?\\d{3,4}|\\(?\\d{3}\\)?[ .-]?\\d{3}[ .-]?\\d{4})(?!\\d)'
export const REMOVED = '[removed]'

const EMAIL_RE = new RegExp(EMAIL_PATTERN, 'g')
const PHONE_RE = new RegExp(PHONE_PATTERN, 'g')
export const scrubEmails = (text: string) => text.replace(EMAIL_RE, REMOVED)
/** Free text as it is kept: no email address and no phone number. */
export const scrubFreeText = (text: string) => text.replace(EMAIL_RE, REMOVED).replace(PHONE_RE, REMOVED)

// ---- A query's answer: the last check before text leaves the CLI ----

const WHOLE_PHONE_RE = /^\s*\+\d[\d ().-]{6,}\d\s*$/

function scrubCell(v: unknown, count: { n: number }): unknown {
  if (typeof v === 'string') {
    // A sentence gets the full free text treatment. A single word or code keeps its digits, so an id
    // or a SKU that looks like a phone number is not touched.
    const out = WHOLE_PHONE_RE.test(v) ? REMOVED : /\s/.test(v) ? scrubFreeText(v) : scrubEmails(v)
    if (out !== v) count.n++
    return out
  }
  if (Array.isArray(v)) return v.map((x) => scrubCell(x, count))
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubCell(x, count)]))
  return v
}

/**
 * Replaces email addresses and phone numbers in the text a query returns. Free text an older version
 * stored can still hold them until `warehouse scrub` has run. `redacted` counts the cells changed.
 */
export function scrubRows<T extends Record<string, unknown>>(rows: T[]): { rows: T[]; redacted: number } {
  const count = { n: 0 }
  const out = rows.map((r) => scrubCell(r, count) as T)
  return { rows: count.n ? out : rows, redacted: count.n }
}
