import { CliError } from './errors.js';
import { classifyColumn } from './personal.js';
/** Marks every column of a catalog with the rule list. `sourceOf` gives a schema its source slug. */
export function markCatalog(columns, sourceOf = () => undefined) {
    return columns.map((c) => ({ ...c, personal: classifyColumn({ source: sourceOf(c.schema), table: c.table, column: c.column, type: c.type }) === 'personal' }));
}
// Functions that run SQL given as text, or read the database's own statistics, which hold sample
// values of every column. Refused whatever the statement touches.
const BLOCKED = /\b(query_to_xml\w*|table_to_xml\w*|schema_to_xml\w*|database_to_xml\w*|cursor_to_xml\w*|ts_stat|ts_rewrite|crosstab\w*|connectby|xpath_table|set_config|pg_\w+|duckdb_\w+|pragma_\w+|json_execute_serialized_sql|json_serialize_sql|query_table|getvariable|sniff_csv|sql_auto_complete)\b|\bquery\s*\(/i;
export function assertNoBlockedFunctions(sql) {
    const m = BLOCKED.exec(sql);
    if (m)
        throw new CliError(`${(m[1] ?? 'query()').toLowerCase()} is blocked: it can run other SQL or read system data.`, 'lifecycle schema', 'blocked_object');
}
const refuse = (why) => {
    throw new CliError(`That query was refused because it could return personal details. ${why}`, 'lifecycle schema --format json marks personal columns. Name the other columns you need one by one, each table right after FROM or JOIN.', 'personal_column');
};
const WS = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
const isIdentStart = (c) => /[A-Za-z_]/.test(c);
const isIdentPart = (c) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c) => c >= '0' && c <= '9';
/** Reads SQL into tokens. Refuses any form it cannot be sure the database reads the same way. */
export function tokenize(sql) {
    const out = [];
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const c = sql[i];
        if (WS.has(c)) {
            i++;
            continue;
        }
        if (c.charCodeAt(0) < 0x20 || c === '\x7f')
            refuse('It holds a control character.');
        // Some databases read a no-break space or another Unicode space as a space, and this reader would not.
        if (c.charCodeAt(0) >= 0x80)
            refuse('It holds a character outside plain ASCII that is not inside a string or a quoted name.');
        if (c === '-' && sql[i + 1] === '-') {
            while (i < n && sql[i] !== '\n' && sql[i] !== '\r')
                i++;
            continue;
        }
        if (c === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            if (end < 0)
                refuse('A comment is not closed.');
            if (sql.slice(i + 2, end).includes('/*'))
                refuse('A comment sits inside another comment.');
            i = end + 2;
            continue;
        }
        if (c === "'" || c === '"') {
            const prev = i > 0 ? sql[i - 1] : '';
            // E'..', B'..', X'..', N'..' and U&'..' or U&"..": the database reads escapes inside these.
            if (prev && (isIdentPart(prev) || prev === '&'))
                refuse('It uses a prefixed string or name, such as E\'..\' or U&"..".');
            let j = i + 1;
            let text = '';
            for (;;) {
                if (j >= n)
                    refuse(c === "'" ? 'A string is not closed.' : 'A quoted name is not closed.');
                const ch = sql[j];
                if (ch === c) {
                    if (sql[j + 1] === c) {
                        text += c;
                        j += 2;
                        continue;
                    }
                    break;
                }
                if (ch === '\\' && sql[j + 1] === c)
                    refuse('A backslash sits before a closing quote.');
                text += ch;
                j++;
            }
            out.push(c === "'" ? { kind: 'string', value: text } : { kind: 'ident', value: text.toLowerCase(), quoted: true });
            i = j + 1;
            continue;
        }
        if (c === '$') {
            let j = i + 1;
            while (j < n && isDigit(sql[j]))
                j++;
            if (j === i + 1 || (j < n && isIdentPart(sql[j])))
                refuse('It uses a dollar-quoted string.');
            out.push({ kind: 'param', value: sql.slice(i, j) });
            i = j;
            continue;
        }
        if (isDigit(c)) {
            let j = i + 1;
            while (j < n && isDigit(sql[j]))
                j++;
            out.push({ kind: 'number', value: sql.slice(i, j) });
            i = j;
            continue;
        }
        if (isIdentStart(c)) {
            let j = i + 1;
            while (j < n && isIdentPart(sql[j]))
                j++;
            out.push({ kind: 'ident', value: sql.slice(i, j).toLowerCase() });
            i = j;
            continue;
        }
        out.push({ kind: 'op', value: c });
        i++;
    }
    return out;
}
// A word that can follow a table in FROM without being its alias.
const NOT_ALIAS = new Set([
    'where', 'on', 'using', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural', 'group', 'order', 'having', 'limit', 'offset',
    'fetch', 'union', 'except', 'intersect', 'window', 'for', 'tablesample', 'lateral', 'asof', 'positional', 'anti', 'semi', 'qualify', 'sample',
    'pivot', 'unpivot', 'returning', 'select', 'from', 'with', 'and', 'or', 'not', 'when', 'then', 'else', 'end', 'as', 'is', 'in', 'like', 'between',
]);
// What may come right after a table (and its alias) in FROM.
const AFTER_TABLE = new Set(['where', 'on', 'using', 'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'group', 'order', 'having', 'limit', 'offset', 'fetch', 'union', 'except', 'intersect', 'window', 'qualify', 'asof', 'positional', 'anti', 'semi']);
// A word that can sit between ")" and "(" without naming the thing before it: count(*) OVER (...), x IN (...).
const AFTER_PAREN = new Set([...NOT_ALIAS, 'over', 'filter', 'within', 'values', 'by', 'any', 'all', 'some', 'exists', 'distinct', 'case', 'ilike', 'similar', 'to', 'cast']);
// Type names that take a size after AS inside a cast: CAST(x AS numeric(10, 2)).
const SIZED_TYPES = new Set(['numeric', 'decimal', 'dec', 'varchar', 'char', 'character', 'bpchar', 'nchar', 'bit', 'varbit', 'varying', 'timestamp', 'timestamptz', 'time', 'timetz', 'interval', 'float', 'double', 'precision', 'number']);
// Functions written with FROM inside their brackets: extract(year FROM d).
const FROM_FUNCTIONS = new Set(['extract', 'substring', 'trim', 'overlay', 'ltrim', 'rtrim', 'btrim']);
const is = (t, kind, value) => Boolean(t && t.kind === kind && (value === undefined || t.value === value));
const word = (t, value) => Boolean(t && t.kind === 'ident' && !t.quoted && t.value === value);
/**
 * Throws personal_column when `sql` could return a column the catalog marks personal.
 * `catalog` is every column of every table the statement could reach.
 */
export function assertNoPersonalColumns(sql, catalog) {
    assertNoBlockedFunctions(sql);
    // Every table's own columns, keyed "schema\0table", so a name is checked against the real table.
    const columnsOf = new Map();
    const personalOf = new Map();
    const tablesNamed = new Map(); // table name -> its keys, one per schema
    for (const c of catalog) {
        const t = c.table.toLowerCase();
        const key = `${c.schema.toLowerCase()}\u0000${t}`;
        if (!columnsOf.has(key))
            tablesNamed.set(t, [...(tablesNamed.get(t) ?? []), key]);
        columnsOf.set(key, (columnsOf.get(key) ?? new Set()).add(c.column.toLowerCase()));
        if (c.personal)
            personalOf.set(key, (personalOf.get(key) ?? new Set()).add(c.column.toLowerCase()));
    }
    if (!personalOf.size)
        return;
    // A table name that has a personal column in at least one schema.
    const risky = new Set([...personalOf.keys()].map((k) => k.split('\u0000')[1]));
    const tokens = tokenize(sql);
    // DuckDB reads a string after FROM as a table name, so a table could be named with no name token at all.
    const open = [undefined];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (is(t, 'op', '('))
            open.push(tokens[i - 1]);
        else if (is(t, 'op', ')') && open.length > 1)
            open.pop();
        else if (t.kind === 'string' && (is(tokens[i - 1], 'op', '.') || is(tokens[i + 1], 'op', '.')))
            refuse('It uses a string as part of a table or column name.');
        else if (t.kind === 'string' && (word(tokens[i - 1], 'from') || word(tokens[i - 1], 'join'))) {
            const inFunction = FROM_FUNCTIONS.has(open[open.length - 1]?.value ?? '');
            if (!inFunction && !word(tokens[i - 2], 'distinct'))
                refuse('It names a table with a string after FROM.');
        }
    }
    // A table name or alias -> the tables with personal columns it stands for in this statement.
    const standsFor = new Map();
    const declare = (name, keys) => standsFor.set(name, new Set([...(standsFor.get(name) ?? []), ...keys]));
    const aliases = new Set();
    const fine = new Set(); // token indexes already proven safe
    const qualified = []; // token indexes of "table" in table.column
    const realColumn = (name, column) => [...(standsFor.get(name) ?? [])].every((k) => columnsOf.get(k)?.has(column));
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.kind !== 'ident' || !risky.has(t.value))
            continue;
        const next = tokens[i + 1];
        if (is(next, 'op', '.') && is(tokens[i + 2], 'ident')) {
            qualified.push(i);
            continue;
        }
        // Step back over a schema or database qualifier: src_zendesk.users
        let b = i - 1;
        while (is(tokens[b], 'op', '.') && is(tokens[b - 1], 'ident'))
            b -= 2;
        // With a schema that the database has, this is exactly one table. Without one it could be any table of that name.
        const exact = b < i - 1 ? `${tokens[i - 2].value}\u0000${t.value}` : null;
        const keys = (exact && columnsOf.has(exact) ? [exact] : tablesNamed.get(t.value) ?? []).filter((k) => personalOf.has(k));
        if (!keys.length)
            continue; // a table of the same name, in a schema where it has no personal column
        if (!word(tokens[b], 'from') && !word(tokens[b], 'join'))
            refuse(`The table ${t.value} has personal columns and is used as a whole row, or outside FROM and JOIN.`);
        declare(t.value, keys);
        let a = i + 1;
        if (word(tokens[a], 'as'))
            a++;
        const cand = tokens[a];
        if (cand && cand.kind === 'ident' && (cand.quoted || !NOT_ALIAS.has(cand.value))) {
            aliases.add(cand.value);
            declare(cand.value, keys);
            fine.add(a);
            a++;
        }
        else if (word(tokens[i + 1], 'as'))
            refuse(`The table ${t.value} has personal columns and its alias could not be read.`);
        // Only a plain continuation may follow, so an alias can never hide behind TABLESAMPLE or the like.
        const after = tokens[a];
        const plain = !after || is(after, 'op', ')') || is(after, 'op', ',') || (after.kind === 'ident' && !after.quoted && AFTER_TABLE.has(after.value));
        if (is(after, 'op', '('))
            refuse(`The table ${t.value} has personal columns and is given a column list, which renames them.`);
        if (!plain)
            refuse(`The table ${t.value} has personal columns and is followed by something other than an alias, a join or a clause.`);
    }
    if (!standsFor.size)
        return;
    // table.column: it has to be a real column, and a personal one is refused below.
    for (const i of qualified) {
        const t = tokens[i].value;
        const column = tokens[i + 2].value;
        if (standsFor.has(t) && !realColumn(t, column))
            refuse(`${t}.${column} is not a column of ${t}, so it could be a function on the whole row.`);
    }
    const personal = new Map(); // personal column -> the table it is in
    for (const keys of standsFor.values())
        for (const k of keys)
            for (const c of personalOf.get(k))
                personal.set(c, k.split('\u0000')[1]);
    // Which brackets hold a SELECT, so a FROM with no SELECT before it stands out.
    const selectSeen = [false];
    const opener = [undefined];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const prev = tokens[i - 1];
        const next = tokens[i + 1];
        if (t.kind === 'op') {
            if (t.value === '(') {
                selectSeen.push(false);
                opener.push(prev);
                // ") name (" and "AS name (" give a derived table a column list.
                if (prev && prev.kind === 'ident' && !fine.has(i - 1)) {
                    const before = tokens[i - 2];
                    if (is(before, 'op', ')') && (prev.quoted || !AFTER_PAREN.has(prev.value)))
                        refuse('A subquery or join is given a column list, which renames columns.');
                    if (word(before, 'as') && (prev.quoted || !SIZED_TYPES.has(prev.value)) && !is(tokens[i - 3], 'ident'))
                        refuse('A subquery or join is given a column list, which renames columns.');
                }
            }
            else if (t.value === ')') {
                if (selectSeen.length > 1) {
                    selectSeen.pop();
                    opener.pop();
                }
            }
            else if (t.value === '*') {
                const counted = is(prev, 'op', '(') && word(tokens[i - 2], 'count') && is(next, 'op', ')');
                if (!counted)
                    refuse('It uses * with a table that has personal columns. count(*) is allowed; for anything else name the columns.');
            }
            else if (t.value === '#')
                refuse('It uses a positional column (#).');
            continue;
        }
        if (t.kind !== 'ident')
            continue;
        if (!t.quoted) {
            if (t.value === 'select')
                selectSeen[selectSeen.length - 1] = true;
            else if (t.value === 'union' || t.value === 'except' || t.value === 'intersect')
                selectSeen[selectSeen.length - 1] = false;
            else if (t.value === 'from' && !selectSeen[selectSeen.length - 1]) {
                const inFunction = FROM_FUNCTIONS.has(opener[opener.length - 1]?.value ?? '');
                const distinctFrom = word(prev, 'distinct') && (word(tokens[i - 2], 'is') || word(tokens[i - 2], 'not'));
                if (!inFunction && !distinctFrom)
                    refuse('It has a FROM with no SELECT before it.');
            }
            else if (t.value === 'columns' && is(next, 'op', '('))
                refuse('It uses COLUMNS(...), which picks columns without naming them.');
        }
        if (personal.has(t.value))
            refuse(`${personal.get(t.value)}.${t.value} is marked personal.`);
        if (aliases.has(t.value) && !fine.has(i)) {
            const column = tokens[i + 2];
            if (!(is(next, 'op', '.') && column && column.kind === 'ident'))
                refuse(`${t.value} stands for a whole row of a table that has personal columns. Write ${t.value}.column for each column you need.`);
            else if (!realColumn(t.value, column.value))
                refuse(`${t.value}.${column.value} is not a column of the table ${t.value} stands for, so it could be a function on the whole row.`);
        }
    }
}
