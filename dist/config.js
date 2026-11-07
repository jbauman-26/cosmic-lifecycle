import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { configPath } from './paths.js';
import { CliError } from './errors.js';
const Config = z.object({
    database: z.object({ kind: z.enum(['local', 'postgres']) }),
    shopify: z.object({ store: z.string(), clientId: z.string() }).optional(),
    klaviyo: z.object({ connected: z.literal(true) }).optional(),
    ga4: z.object({ property: z.string(), clientId: z.string() }).optional(),
});
export function readConfig() {
    if (!existsSync(configPath()))
        throw new CliError('Not set up yet.', 'lifecycle init', 'not_initialized');
    return Config.parse(JSON.parse(readFileSync(configPath(), 'utf8')));
}
export function writeConfig(config) {
    mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 });
    // Config holds no secrets, but it does name the store.
    writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
