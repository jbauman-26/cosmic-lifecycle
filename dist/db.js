import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { MIGRATIONS } from './schema.js';
import { localDbPath } from './paths.js';
import { readConfig } from './config.js';
import { getSecret } from './secrets.js';
import { CliError } from './errors.js';
export function wrapPglite(client) {
    return {
        query: async (sql, params) => (await client.query(sql, params)).rows,
        transaction: async (fn) => {
            const out = await client.transaction((tx) => fn({ query: async (sql, params) => (await tx.query(sql, params)).rows }));
            return out;
        },
        readOnly: async (sql) => {
            await client.exec('BEGIN READ ONLY');
            try {
                return (await client.query(sql)).rows;
            }
            finally {
                await client.exec('ROLLBACK');
            }
        },
        close: () => client.close(),
    };
}
function wrapPg(pool) {
    return {
        query: async (sql, params) => (await pool.query(sql, params)).rows,
        transaction: async (fn) => {
            const c = await pool.connect();
            try {
                await c.query('BEGIN');
                const out = await fn({ query: async (sql, params) => (await c.query(sql, params)).rows });
                await c.query('COMMIT');
                return out;
            }
            catch (e) {
                await c.query('ROLLBACK');
                throw e;
            }
            finally {
                c.release();
            }
        },
        readOnly: async (sql) => {
            const c = await pool.connect();
            try {
                await c.query('BEGIN READ ONLY');
                await c.query(`SET LOCAL statement_timeout = '15s'`);
                await c.query(`SET LOCAL search_path = public`);
                return (await c.query(sql)).rows;
            }
            finally {
                await c.query('ROLLBACK').catch(() => { });
                c.release();
            }
        },
        close: () => pool.end(),
    };
}
export async function migrate(db) {
    for (const m of MIGRATIONS)
        await db.query(m);
}
export async function openDb() {
    const config = readConfig();
    if (config.database.kind === 'local') {
        mkdirSync(localDbPath(), { recursive: true, mode: 0o700 });
        const client = new PGlite(localDbPath());
        await client.waitReady;
        return wrapPglite(client);
    }
    const url = getSecret('database-url');
    if (!url)
        throw new CliError('No database URL saved.', 'Set LIFECYCLE_DATABASE_URL or run lifecycle init --local.', 'no_database');
    return wrapPg(new pg.Pool({ connectionString: url, max: 2 }));
}
