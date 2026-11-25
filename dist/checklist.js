import { existsSync } from 'node:fs';
import { readConfig } from './config.js';
import { getSecret } from './secrets.js';
import { sourceStatus } from './sources-catalog.js';
import { trustLine } from './reconcile.js';
import { targetDir } from './skills.js';
export const SECRET_FOR = { klaviyo: 'klaviyo-read-key', shopify: 'shopify-client-secret', ga4: 'ga4-client-secret', stripe: 'stripe-read-key', meta: 'meta-ads-token', 'google-ads': 'google-ads-refresh-token' };
// The six steps from an empty machine to a daily sync an agent can use, in the order to do them.
// Each unfinished step names the one command that finishes it.
export function setupChecklist(i) {
    const has = (slug) => i.sources.some((s) => s.slug === slug && s.connected);
    const steps = [
        { step: 'Set up the database', done: i.setUp, next: 'lifecycle init' },
        { step: 'Connect Shopify and Klaviyo', done: has('shopify') && has('klaviyo'), next: 'lifecycle connect' },
        // A failed or still-running attempt leaves a timestamp too, so only a finished sync that loaded data counts.
        { step: 'Run the first sync', done: i.sources.some((s) => s.lastStatus === 'ok' || s.lastStatus === 'warning'), next: 'lifecycle sync' },
        { step: 'Prove the numbers agree', done: i.trust === 'passed', next: i.trust === 'failed' ? 'lifecycle reconcile, then fix the failed checks it names' : 'lifecycle reconcile' },
        { step: 'Install the skills for your agent', done: i.skills, next: 'lifecycle skills sync' },
        { step: 'Deploy the daily sync', done: i.deployed, next: 'lifecycle deploy --repo OWNER/NAME' },
    ].map((s) => ({ ...s, next: s.done ? null : s.next }));
    return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
}
export const checklistLines = (c) => [`Setup: ${c.done} of ${c.total} steps done`, ...c.steps.map((s) => `  ${s.done ? '[x]' : '[ ]'} ${s.step}${s.next ? `. Next: ${s.next}` : ''}`)];
// Reads config, keys and the database. Inside GitHub Actions the daily sync is the thing running, so it counts as deployed.
export async function loadChecklist(db, config) {
    if (config === undefined) {
        try {
            config = readConfig();
        }
        catch {
            config = null;
        }
    }
    const sources = await sourceStatus(config, (slug) => Boolean(getSecret(SECRET_FOR[slug])), db);
    const trust = db ? await trustLine(db).then((t) => t.status).catch(() => null) : null;
    return setupChecklist({
        setUp: Boolean(config),
        sources,
        trust,
        deployed: Boolean(config?.deploy?.repo) || process.env.GITHUB_ACTIONS === 'true',
        skills: existsSync(targetDir('claude')) || existsSync(targetDir('cursor')),
    });
}
