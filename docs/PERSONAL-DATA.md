# Personal data

The promise: customer names, emails, phone numbers and street addresses never enter the warehouse.

One rule list decides what counts as personal: `PERSONAL_RULES` in `src/personal.ts`. Four things read it, so they cannot disagree:

| Where | What it does with the list |
|---|---|
| The loader (`connectors/run.py`) | Drops personal fields from every row before anything is written. |
| `lifecycle schema`, `lifecycle warehouse schema` | Marks every column `personal: true|false` and `freeText: true|false`. |
| `lifecycle query`, `lifecycle warehouse query`, saved metrics, the MCP `query` tool | Refuses SQL that could return a personal column, with code `personal_column`. |
| `lifecycle warehouse scrub` | Empties personal columns an older version stored. |

The loader is Python. `npm run build` writes the list to `connectors/personal-rules.json`, and the CLI also sends it with every loader job. A loader with no list stops and loads nothing.

## The rules

A field is a key in a row (the loader) or a column in a table (schema, query, scrub). Keys are compared as lowercase words, so `firstName`, `first_name` and `first-name` are one key. A nested key is walked from the outside in: the column `customer__first_name` is `customer`, then `first_name`. The first rule that fits decides.

1. **Per source.** A source in the catalog can name a table and a key and say `personal`, `free_text` or `keep`. This is for fields a vendor names in its own way: Recharge's customer `hash`, Zendesk's `user_fields`, Shippo's `label_url`. The list is `PERSONAL_RULES.sources`.
2. **Always personal.** A key with one of these words, wherever it sits: email, phone, mobile, telephone, fax, address, street, zip, postal, postcode, birthday, birth, dob, ssn, ip, latitude, longitude, lat, lng, password, token, secret. Also first name, last name, full name, given name, family name, nickname and username written as one word. Plurals count.
3. **A named person.** A key with the word `name` and one of: first, last, full, middle, given, family, legal, display, nick, customer, billing, shipping, contact, recipient, sender, author, reviewer, buyer, user, person, profile, subscriber, member, owner, assignee, requester, submitter, agent. So `reviewer_name`, `authorName`, `requester_name` and `assignee_name` are personal. An assignee is usually staff. Their name is removed too, because the rule cannot tell staff from a customer.
4. **People.** A table whose rows are people (users, customers, contacts, members, subscribers, profiles, recipients, agents, reviewers, buyers, authors, leads), and a nested object that holds a person (customer, reviewer, author, recipient, ship_to, bill_to, created_by, assigned_to and the like). Inside either, these are personal: name, alias, handle, initials, signature, avatar, photo, picture, social handles, street lines. A product, tier or company name inside a person is removed as well. Losing a label is the safe direction.
5. **A person as text.** Text stored directly under `author`, `reviewer`, `customer`, `recipient`, `user`, `owner`, `agent` and the like is that person's name or handle. A number there is an id and is kept.
6. **A review's writer.** In a reviews table, a top-level `name` or `nickname` is the writer.
7. **Kept.** Ids, counts, amounts, timestamps, statuses, product and campaign names. Region is kept, also inside a person: country, state, province, region, city, time zone, locale, language, currency. A whole address object is removed, city and country with it.
8. **Free text.** See below.

An email address inside any kept text is replaced by `[removed]`, whatever the field is called. So is a value that is nothing but a phone number starting with `+`.

## Free text

A ticket subject, a message body, a review or a note can hold anything a customer typed, including a name. No rule can find a name inside a sentence, so this is a known risk and the owner chooses:

```
lifecycle config set warehouse.free_text keep    # the default
lifecycle config set warehouse.free_text drop
```

- `keep`: free text is loaded with email addresses and phone numbers replaced by `[removed]`. A name inside the text stays.
- `drop`: free text is not loaded at all.

A field is free text when it holds text and its last word is one of: subject, body, message, comment, comments, note, notes, description, content, excerpt, preview, snippet, summary, feedback, transcript, details, reply, answer, instructions. So are `body_html` and `description_text`, and a review's `title`. Text the store wrote itself is not free text: campaigns, flows, automations, lists, segments, coupons and the CLI's own tables.

Open-ended fields are free text as a whole: any key with the word custom, metadata or properties (`custom_fields`, `customAttributes`, `metadata`, line item `properties`). With `keep`, every text inside has emails and phone numbers replaced, and keys that are personal by the rules above are still removed. Inside a person these fields are removed outright, along with `traits`, `fields` and `extra`.

A phone number is `+` followed by at least eight digits in groups, or ten digits written as 3-3-4 with spaces, dots, dashes or brackets. A date, a time, a price and a 13 digit timestamp are left alone. A bare ten digit number is replaced. A seven digit local number is not found.

## What schema says

```
lifecycle schema --format json
{ "dim_flow": [ { "column": "name", "type": "text", "personal": false, "freeText": false } ] }

lifecycle warehouse schema --format json
{ "src_zendesk.users": [ { "column": "name", "type": "VARCHAR", "personal": true, "freeText": false } ] }
```

`lifecycle schema --cloud` adds `personal` to every column Cosmic Cloud returns: Cloud's own flag when it sends one, else what this list says about the name.

A warehouse loaded by 0.13.2 has no personal columns, because the loader drops the fields before the table is made. `personal: true` shows up only in a warehouse an older version filled, or for a source connected with `--keep-personal-data`.

## What query refuses

When no column is marked personal, nothing is refused. When a table has one, SQL that names that table must follow these rules, and anything else is refused with `personal_column`:

1. No personal column of that table is named anywhere, quoted or not, in any case. That covers an alias, a cast, a function, a filter, a sort, a subquery and a CTE.
2. No star. `count(*)` is the one star allowed. Multiplication is refused too, because the check cannot tell it from a star.
3. The table comes right after `FROM` or `JOIN`, or is the qualifier in `table.column`. Anywhere else it is a whole row: `row_to_json(users)`, `TABLE users`.
4. Its alias is used only as `alias.column`, and the column has to be a real column of the table. A bare alias is a whole row: `SELECT u`, `to_jsonb(u)`, `u::text`. So is `u.row_to_json`, which Postgres reads as a function on the row.
5. No column list on an alias, `users AS u(a, b, c)`, which renames columns by position.
6. No positional column (`#2`), no `COLUMNS(...)`, no `FROM` without a `SELECT` before it, no string where a table name goes.
7. No form the check cannot read exactly as the database does: `E'..'` strings, `U&".."` names, dollar quotes, a backslash before a closing quote, a comment inside a comment, and any character outside plain ASCII that is not inside a string or a quoted name.

The check reads the SQL into tokens exactly. It is not a full parser, so it allows only what it can prove safe. A safe statement can be refused. An unsafe one should never pass.

The answer is cleaned on the way out as well: an email address or a phone number in returned text is replaced by `[removed]`, and the JSON carries `redacted` with the number of cells changed. A name inside free text still comes back, which is the known risk above.

Always refused, with `blocked_object`: functions that run SQL given as text or read the database's own statistics (`query_to_xml`, `ts_stat`, `query()`, `query_table()`, anything starting `pg_` or `duckdb_`).

## An older warehouse

```
lifecycle warehouse scrub              # counts per table and column, changes nothing
lifecycle warehouse scrub --confirm    # empties them
```

- A personal column is set to null. One that may not be empty gets `removed-` plus the row's own id. One that is not text and may not be empty is left alone and reported as `blocked`.
- Free text: with `warehouse.free_text drop` it is emptied. With `keep`, email addresses and phone numbers inside it are replaced.
- The report holds table names, column names and counts. It never holds a stored value.
- The columns stay, empty, so `schema` still marks them and `query` still refuses them.
- The loader's own folder is cleaned too. Before 0.13.2 the loader kept a copy of every row it loaded under `~/.lifecycle/dlt/*/load/loaded`, so a name stored then is still in those files. `scrub` counts them, and `--confirm` removes them. From 0.13.2 on the loader keeps no copy.
- A local warehouse file is rebuilt after the columns are emptied, so the old values are gone from the bytes of the file and not only from queries. The report says `rebuilt: true`. If the copy fails the emptied warehouse stays in place and the report says `rebuilt: false`.
- On Postgres the values are gone from every query. Postgres keeps old row versions until it vacuums the table.

## What this does not cover

- A name inside free text that is kept.
- A phone number inside text that is not free text, unless it is the whole value and starts with `+`.
- A field a vendor names in a way no rule expects. The 25 connectors were written from API docs and none has run on a real account. Report one with `lifecycle feedback`.
- A view someone made in the database by hand over a personal column.
- A source connected with `--keep-personal-data`. That is the owner's choice. Its columns are marked personal and `query` refuses them.
