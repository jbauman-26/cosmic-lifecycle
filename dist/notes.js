import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { appHome } from './paths.js';
import { CliError } from './errors.js';
const MAX_NOTES = 200;
const MAX_TEXT = 500;
export const notesPath = () => join(appHome(), 'notes.json');
export function readNotes() {
    const p = notesPath();
    if (!existsSync(p))
        return [];
    try {
        const data = JSON.parse(readFileSync(p, 'utf8'));
        return Array.isArray(data?.notes) ? data.notes.filter((n) => n && typeof n.text === 'string' && typeof n.id === 'string') : [];
    }
    catch {
        throw new CliError(`notes.json is not valid JSON: ${p}`, 'Fix or delete the file, then run lifecycle notes list', 'bad_value');
    }
}
function writeNotes(notes) {
    const p = notesPath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ notes }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, p);
}
export function addNote(text, metric) {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t)
        throw new CliError('A note needs some text.', 'lifecycle notes add "Exclude wholesale orders from revenue"', 'bad_value');
    if (t.length > MAX_TEXT)
        throw new CliError(`A note is at most ${MAX_TEXT} characters. This one is ${t.length}.`, 'Split it into two notes', 'bad_value');
    const m = metric?.trim() || null;
    if (m && !/^[a-z][a-z0-9_]{2,63}$/.test(m))
        throw new CliError(`Not a metric name: ${m}`, 'lifecycle metrics list', 'bad_value');
    const notes = readNotes();
    const same = notes.find((n) => n.text.toLowerCase() === t.toLowerCase() && n.metric === m);
    if (same)
        throw new CliError(`That note is already saved as ${same.id}.`, 'lifecycle notes list', 'duplicate');
    if (notes.length >= MAX_NOTES)
        throw new CliError(`This workspace already has ${MAX_NOTES} notes.`, 'lifecycle notes remove <id>', 'bad_value');
    const note = { id: randomBytes(3).toString('hex'), text: t, metric: m, added: new Date().toISOString() };
    writeNotes([...notes, note]);
    return note;
}
export function removeNote(id) {
    const notes = readNotes();
    const hit = notes.find((n) => n.id === id);
    if (!hit)
        throw new CliError(`No note with id ${id}.`, 'lifecycle notes list', 'not_found');
    writeNotes(notes.filter((n) => n.id !== id));
    return hit;
}
// The notes an agent must read before quoting a number: every note for the whole workspace,
// plus the ones tied to this metric.
export function notesFor(metric) {
    return readNotes().filter((n) => n.metric === null || (metric != null && n.metric === metric));
}
export const NOTES_RULE = 'These are the owner\'s notes and past corrections. Apply them when you explain this number, and say which note you applied. They do not change the SQL.';
// What the MCP server adds to a result. Empty when there are no notes, so results stay as before.
export function withNotes(result, metric) {
    const notes = notesFor(metric);
    return notes.length ? { ...result, owner_notes: { rule: NOTES_RULE, notes } } : result;
}
