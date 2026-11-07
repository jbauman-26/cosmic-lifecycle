import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './errors.js';
const KITS = join(dirname(fileURLToPath(import.meta.url)), '..', 'kits');
export function listKits() {
    return readdirSync(KITS)
        .filter((k) => k !== 'shared' && existsSync(join(KITS, k, 'kit.yaml')))
        .map((name) => {
        const y = readFileSync(join(KITS, name, 'kit.yaml'), 'utf8');
        const field = (f) => y.match(new RegExp(`^${f}: (.*)$`, 'm'))?.[1] ?? '';
        return { name, title: field('title'), summary: field('summary'), writes: field('writes') };
    });
}
// Copies into the folder the user chose. Nothing lands in their skills folder.
export function addKit(name, into = 'lifecycle-kits') {
    if (!listKits().some((k) => k.name === name))
        throw new CliError(`No kit named ${name}.`, 'lifecycle kits list');
    const target = join(into, name);
    if (existsSync(target))
        throw new CliError(`${target} already exists.`, 'Remove it first, or use another folder with --into.');
    mkdirSync(into, { recursive: true });
    cpSync(join(KITS, name), target, { recursive: true });
    cpSync(join(KITS, 'shared'), join(into, 'shared'), { recursive: true });
    return { kit: name, path: target, runbook: join(target, 'AGENT.md') };
}
