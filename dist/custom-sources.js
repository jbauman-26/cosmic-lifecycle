import { readFileSync } from 'node:fs';
import { CliError } from './errors.js';
// Custom sources: bring any other tool's daily totals in from a CSV export.
// Graphed connects 750+ sources into its warehouse. Cosmic connects three natively and
// takes the long tail as daily totals you export, which keeps the no-customer-records
// rule: a column that looks personal, or any value that is not a number, is refused.
export const PII_COLUMN = /(e-?mail|phone|mobile|first.?name|last.?name|full.?name|^name$|customer.?name|address|street|city|zip|postal|postcode|ip.?addr|birth|dob|ssn)/i;
const SLUG = /^[a-z][a-z0-9_]{0,30}$/;
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') {
                cell += '"';
                i++;
            }
            else if (c === '"')
                quoted = false;
            else
                cell += c;
        }
        else if (c === '"')
            quoted = true;
        else if (c === ',') {
            row.push(cell);
            cell = '';
        }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n')
                i++;
            row.push(cell);
            cell = '';
            if (row.some((x) => x.trim() !== ''))
                rows.push(row);
            row = [];
        }
        else
            cell += c;
    }
    row.push(cell);
    if (row.some((x) => x.trim() !== ''))
        rows.push(row);
    return rows;
}
const column = (h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
export function prepareImport(name, text, dateColumn = 'date') {
    if (!SLUG.test(name))
        throw new CliError('Name the source with lowercase letters, numbers and underscores.', 'lifecycle sources import meta_ads --csv FILE', 'bad_name');
    const rows = parseCsv(text);
    if (rows.length < 2)
        throw new CliError('The CSV needs a header row and at least one data row.', 'Check the export.', 'empty_csv');
    const header = rows[0].map(column);
    const dateIdx = header.indexOf(column(dateColumn));
    if (dateIdx < 0)
        throw new CliError(`No "${dateColumn}" column.`, 'Pass --date-column NAME', 'no_date_column');
    const personal = rows[0].filter((h) => PII_COLUMN.test(h));
    if (personal.length)
        throw new CliError(`Refused: ${personal.join(', ')} look like personal data. Import daily totals only.`, 'Export a daily summary without customer columns.', 'personal_data');
    const metrics = header
        .map((h, i) => ({ h: /^[0-9]/.test(h) ? `c_${h}` : h, i }))
        .filter((x) => x.i !== dateIdx);
    if (metrics.some((m) => m.h === 'date' || m.h === 'source_synced_at'))
        throw new CliError('A column is named date or source_synced_at, which this table uses itself.', 'Rename that column in the export.', 'bad_columns');
    if (metrics.some((m) => PII_COLUMN.test(m.h)))
        throw new CliError('A column looks like personal data. Import daily totals only.', 'Export a daily summary without customer columns.', 'personal_data');
    if (!metrics.length)
        throw new CliError('No metric columns besides the date.', 'Export daily totals such as spend, clicks or orders.', 'no_metrics');
    if (new Set(metrics.map((m) => m.h)).size !== metrics.length || metrics.some((m) => !m.h))
        throw new CliError('Column names must be unique and not empty.', 'Rename the columns in the export.', 'bad_columns');
    const byDate = new Map();
    rows.slice(1).forEach((r, n) => {
        const date = (r[dateIdx] ?? '').trim().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
            throw new CliError(`Row ${n + 2}: "${r[dateIdx]}" is not a YYYY-MM-DD date.`, 'Fix the date column.', 'bad_date');
        const values = metrics.map((m) => {
            const raw = (r[m.i] ?? '').trim().replace(/[$,%\s]/g, '');
            if (raw === '')
                return 0;
            const v = Number(raw);
            if (!Number.isFinite(v))
                throw new CliError(`Row ${n + 2}, ${m.h}: "${r[m.i]}" is not a number. Only numeric totals are imported.`, 'Remove text columns from the export.', 'not_numeric');
            return v;
        });
        // Several rows for one day (for example one per campaign) are summed into that day.
        const prev = byDate.get(date);
        byDate.set(date, prev ? prev.map((p, i) => p + values[i]) : values);
    });
    return { table: `custom_${name}`, columns: metrics.map((m) => m.h), days: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)) };
}
export async function importCsv(db, name, file, dateColumn = 'date') {
    const prep = prepareImport(name, readFileSync(file, 'utf8'), dateColumn);
    const started = new Date().toISOString();
    await db.transaction(async (tx) => {
        await tx.query(`CREATE TABLE IF NOT EXISTS ${prep.table} (date DATE PRIMARY KEY, source_synced_at TIMESTAMPTZ NOT NULL)`);
        for (const c of prep.columns)
            await tx.query(`ALTER TABLE ${prep.table} ADD COLUMN IF NOT EXISTS ${c} NUMERIC NOT NULL DEFAULT 0`);
        const cols = prep.columns.join(', ');
        const set = prep.columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
        for (const [date, values] of prep.days) {
            const ph = values.map((_, i) => `$${i + 2}`).join(', ');
            await tx.query(`INSERT INTO ${prep.table} (date, ${cols}, source_synced_at) VALUES ($1, ${ph}, now()) ON CONFLICT (date) DO UPDATE SET ${set}, source_synced_at = now()`, [date, ...values]);
        }
        await tx.query(`INSERT INTO meta_sync_run (run_id, source, started_at, finished_at, status, rows_written, detail) VALUES ($1, $2, $3, now(), 'ok', $4, $5)`, [
            `custom-${name}-${Date.now()}`, `custom:${name}`, started, prep.days.length, `CSV import of ${prep.columns.length} columns`,
        ]);
    });
    return { table: prep.table, columns: prep.columns, days: prep.days.length, from: prep.days[0]?.[0] ?? null, to: prep.days.at(-1)?.[0] ?? null };
}
export async function customTables(db) {
    const rows = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'custom\\_%' AND table_schema = current_schema() ORDER BY table_name`);
    return rows.map((r) => String(r.table_name));
}
