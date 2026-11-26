import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { writeConfig } from '../config.js';
import { openDb, migrate } from '../db.js';
import { configPath } from '../paths.js';
import { setSecret } from '../secrets.js';
import { CliError } from '../errors.js';
import { TYPES, WORKSPACE_TYPES, readWorkspace } from '../workspace.js';
// `type` is written only when given, so `cosmic init` on an install from before 0.14.0
// leaves the config exactly as it was and the workspace keeps reading as shopify.
export async function init(opts) {
    const existing = existsSync(configPath()) ? JSON.parse(readFileSync(configPath(), 'utf8')) : {};
    let kind = 'local';
    if (opts.databaseUrlEnv) {
        const url = process.env[opts.databaseUrlEnv];
        if (!url)
            throw new CliError(`Environment variable ${opts.databaseUrlEnv} is empty.`, 'Export your Postgres URL, then pass the variable name.', 'missing_secret');
        if (!process.env.LIFECYCLE_DATABASE_URL)
            setSecret('database-url', url);
        kind = 'postgres';
    }
    const next = { ...existing, database: { kind } };
    if (opts.type || opts.reference) {
        const ws = { ...(existing.workspace ?? {}) };
        if (opts.type)
            ws.type = opts.type;
        // A new type brings its own reference unless one is given with it.
        if (opts.type && !opts.reference && existing.workspace?.type !== opts.type)
            delete ws.reference;
        if (opts.reference)
            ws.reference = opts.reference;
        next.workspace = ws;
    }
    writeConfig(next);
    const db = await openDb();
    await migrate(db);
    await db.close();
    const w = readWorkspace();
    return { database: kind, type: w.type, reference: w.reference };
}
// The picker `cosmic init` shows in a terminal when no --type is given on a new workspace.
// Anything that is not a terminal (the app, a script, CI) never sees it and gets shopify.
export async function pickType(io = { input: process.stdin, output: process.stdout }) {
    const rl = createInterface({ input: io.input, output: io.output });
    try {
        io.output.write('What kind of business is this workspace for?\n');
        WORKSPACE_TYPES.forEach((t, i) => io.output.write(`  ${i + 1}. ${TYPES[t].title}: ${TYPES[t].forWhom}\n`));
        for (let tries = 0; tries < 3; tries++) {
            const a = (await rl.question('Pick a number (Enter for 1): ')).trim().toLowerCase();
            if (!a)
                return 'shopify';
            const n = Number(a);
            if (Number.isInteger(n) && n >= 1 && n <= WORKSPACE_TYPES.length)
                return WORKSPACE_TYPES[n - 1];
            const byName = WORKSPACE_TYPES.find((t) => t === a);
            if (byName)
                return byName;
            io.output.write(`Type a number from 1 to ${WORKSPACE_TYPES.length}.\n`);
        }
        throw new CliError('No workspace type picked.', `cosmic init --type ${WORKSPACE_TYPES.join('|')}`, 'bad_type');
    }
    finally {
        rl.close();
    }
}
