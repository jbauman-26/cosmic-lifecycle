import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readIndex } from './registry.js';
import { VERSION } from './version.js';
import { CliError } from './errors.js';
import { brandExperienceEditing, brandExperienceSkill } from './brandExperienceSkill.js';
// Installs a router, the Brand Experience skill, and one setup skill per kit:
// /lifecycle is the router, /lifecycle:kits:<kit> sets up a kit.
// The store's own skills, pushed to Cosmic Cloud with `skills push`, install beside them under skills/store-<slug>/.
// Every file we write is recorded with its hash, so a file the user edited is never overwritten.
export const PLUGIN = 'lifecycle';
const MANAGED = '.lifecycle-managed.json';
export const targetDir = (t) => (t === 'claude' ? join(homedir(), '.claude', 'skills', PLUGIN) : join(homedir(), '.cursor', 'plugins', 'local', PLUGIN));
// Cursor is only touched when it is installed, unless asked for by name.
export function defaultTargets() {
    return existsSync(join(homedir(), '.cursor')) ? ['claude', 'cursor'] : ['claude'];
}
const sha = (s) => createHash('sha256').update(s).digest('hex');
const pluginJson = () => JSON.stringify({
    name: PLUGIN,
    version: VERSION,
    description: 'Cosmic Lifecycle skills. The router is /lifecycle. Kit setup is /lifecycle:kits:<kit>, for example /lifecycle:kits:flow-audit.',
    author: { name: 'Cosmic AI' },
    homepage: 'https://github.com/jbauman-26/cosmic-lifecycle',
    license: 'MIT',
    keywords: ['klaviyo', 'shopify', 'lifecycle'],
}, null, 2) + '\n';
const routerSkill = (kits) => `---
name: ${PLUGIN}
description: Work with checked marketing numbers through the Cosmic Lifecycle CLI, for a Shopify store, a SaaS product, a B2B pipeline, an agency client or a creator business. Use when asked about revenue, MRR, churn, pipeline, leads, cost per lead, ad spend, flow performance, reconciling one tool against another, or setting up a lifecycle kit.
---

# Cosmic Lifecycle

This skill is a router. The playbook that matches the installed CLI ships inside it. Load it before any lifecycle work:

\`\`\`sh
cosmic docs agents
\`\`\`

Then, as the task needs:
- \`cosmic workspace show\` says what kind of business this is and which source its numbers are checked against.
- \`cosmic docs workspaces\` explains the workspace types and their metric packs.
- \`cosmic docs setup\` connects Klaviyo, Shopify, GA4, Stripe, Meta Ads and HubSpot.
- \`cosmic docs kits\` explains kits.
- \`cosmic docs commands\` lists every command.

If \`lifecycle\` is not on PATH, stop and ask the user to install it from https://github.com/jbauman-26/cosmic-lifecycle.

Rules:
- Run \`cosmic reconcile\` before quoting any number. If a check failed, say so first. If the trust line says the numbers were not checked against a source of truth, say that first instead.
- Nothing in this tool sends a message. Never claim attributed revenue proves causation.
- For brand positioning, content packaging, onboarding or service recovery, use \`/lifecycle:brand-experience\`. It works with the facts and evidence the owner supplies.
- "Audit my flows", "rank my flows" or "build a win-back segment" is a kit task. Prefer the kit skill:
${kits.map((k) => `  - \`/${PLUGIN}:kits:${k.name}\`: ${k.summary}`).join('\n')}
`;
const kitSkill = (k) => `---
name: "kits:${k.name}"
description: "Run the ${k.title} kit from Cosmic Lifecycle. ${k.summary.replace(/"/g, "'")} Use when asked for a ${k.title.toLowerCase()}."
---

# ${k.title}

This skill is generated from the \`${k.name}\` kit at version ${k.version}.

## Steps

1. If \`lifecycle\` is not on PATH, stop and ask the user to install it.
2. Load the playbook:

   \`\`\`sh
   cosmic docs agents
   cosmic kits show ${k.name}
   cosmic doctor --format json
   \`\`\`

3. Connect what the kit needs (${k.needs.join(', ')}) with \`cosmic docs setup\` if doctor says it is missing.
4. Stage the kit:

   \`\`\`sh
   cosmic kits add ${k.name} --format json
   \`\`\`

5. Read \`lifecycle-kits/${k.name}/AGENT.md\` and follow it in order, including the Verify checklist at the end.

What it changes: ${k.writes}
`;
export function buildFiles(kits, target) {
    const files = {
        'SKILL.md': routerSkill(kits),
        'skills/brand-experience/SKILL.md': brandExperienceSkill,
        'skills/brand-experience/references/editing.md': brandExperienceEditing,
        'README.md': `# Cosmic Lifecycle skills\n\nInstalled by \`cosmic skills sync\`. Files you edit here are kept on the next sync. Remove everything with \`cosmic skills uninstall\`.\n`,
        [target === 'claude' ? '.claude-plugin/plugin.json' : '.cursor-plugin/plugin.json']: pluginJson(),
    };
    for (const k of kits)
        files[`skills/kit-${k.name}/SKILL.md`] = kitSkill(k);
    return files;
}
function readManaged(dir) {
    const p = join(dir, MANAGED);
    if (!existsSync(p))
        return { managedBy: 'lifecycle-cli', version: VERSION, files: {} };
    return JSON.parse(readFileSync(p, 'utf8'));
}
// The store's own skills. Limits match Cosmic Cloud's: 200 KB a skill, plain text files.
export const SKILL_MAX_BYTES = 200 * 1024;
export const STORE_PREFIX = 'skills/store-';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SKIP = new Set(['.git', 'node_modules', '.DS_Store']);
export function assertSlug(slug) {
    if (!SLUG.test(slug))
        throw new CliError(`${JSON.stringify(slug).slice(0, 80)} is not a usable skill name.`, 'Use lowercase letters, numbers and dashes, such as winback-brief. Pass --slug NAME to set it.', 'bad_skill');
    return slug;
}
// A path inside a skill: forward slashes, no parent steps, nothing absolute.
const safePath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 200 && !p.includes('\\') && !p.includes('\0') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
// File names that hold keys by convention, and the shapes real keys take. A match names the file and
// the line, never the value.
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.json)?|secrets?\.(json|ya?ml|toml|txt)|.*\.(pem|key|p12|pfx|keystore))$/i;
const SECRET_SHAPES = [
    ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['a Cosmic Cloud token', /\bcck_[0-9a-f]{12}_[A-Za-z0-9_-]{20,}/],
    ['a Stripe key', /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}/],
    ['a Klaviyo private key', /\bpk_[0-9a-f]{30,}\b/],
    ['a Shopify token', /\bshp(at|ss|ca|pa)_[0-9a-fA-F]{24,}/],
    ['an API key', /\bsk-[A-Za-z0-9_-]{20,}/],
    ['an AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
    ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
    ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
    ['a Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
    ['a signed token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
    ['a bearer token', /\bBearer\s+(?!\$|<|\{|your|xxx|\.\.\.|example)[A-Za-z0-9_\-+/=.]{24,}/],
    ['a sign-in inside a web address', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]{6,}@/i],
    ['a key or password', /(api[_-]?key|secret|token|password|passwd|authorization)["']?\s*[:=]\s*["']?(?!\$|<|\{|your|xxx|\.\.\.|example|changeme)[A-Za-z0-9_\-+/=.]{24,}/i],
];
export function findSecrets(files) {
    const found = [];
    for (const f of files) {
        if (SECRET_FILE.test(f.path)) {
            found.push({ path: f.path, line: null, kind: 'a file that usually holds keys' });
            continue;
        }
        f.content.split('\n').forEach((text, i) => {
            const hit = SECRET_SHAPES.find(([, re]) => re.test(text));
            if (hit)
                found.push({ path: f.path, line: i + 1, kind: hit[0] });
        });
    }
    return found;
}
// Reads a skill folder for `skills push`. Refuses anything Cloud would refuse, before a byte is sent.
export function readSkillDir(dir, slugOpt) {
    const root = resolve(dir);
    if (!existsSync(root) || !lstatSync(root).isDirectory())
        throw new CliError(`${dir} is not a folder.`, 'cosmic skills push DIRECTORY', 'bad_skill');
    const slug = assertSlug(slugOpt ?? basename(root).toLowerCase());
    const files = [];
    const walk = (rel) => {
        for (const e of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (SKIP.has(e.name))
                continue;
            const path = rel ? `${rel}/${e.name}` : e.name;
            // A link could point outside the folder, so links are never followed.
            if (e.isSymbolicLink())
                throw new CliError(`${path} is a link, and links are not pushed.`, 'Replace it with the file itself, then push again.', 'bad_skill');
            if (e.isDirectory())
                walk(path);
            else if (e.isFile()) {
                const buf = readFileSync(join(root, path));
                if (buf.includes(0) || !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf))
                    throw new CliError(`${path} is not a text file. A skill holds text files only.`, 'Remove it from the folder, then push again.', 'bad_skill');
                files.push({ path, content: buf.toString('utf8') });
            }
        }
    };
    walk('');
    if (!files.some((f) => f.path === 'SKILL.md'))
        throw new CliError(`${dir} has no SKILL.md.`, 'A skill is a folder with a SKILL.md at the top. Add one, then push again.', 'bad_skill');
    const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
    if (bytes > SKILL_MAX_BYTES)
        throw new CliError(`This skill is ${Math.ceil(bytes / 1024)} KB. The most a skill can be is 200 KB.`, 'Remove large files from the folder, then push again.', 'too_large');
    const secrets = findSecrets(files);
    if (secrets.length) {
        const where = secrets.slice(0, 5).map((x) => `${x.path}${x.line ? ` line ${x.line}` : ''} looks like ${x.kind}`).join('; ');
        throw new CliError(`Nothing was pushed. ${where}${secrets.length > 5 ? `; and ${secrets.length - 5} more` : ''}.`, 'Take the key out and read it from an environment variable instead, then push again.', 'secret_found');
    }
    return { slug, files, bytes };
}
// Turns the store's skills from Cosmic Cloud into files to install. A skill with an unsafe
// path, a bad name or too much in it is skipped whole and named in `skipped`.
export function accountSkillFiles(skills) {
    const files = {};
    const installed = [];
    const skipped = [];
    for (const s of skills) {
        const list = Array.isArray(s?.files) ? s.files : [];
        const ok = typeof s?.slug === 'string' && SLUG.test(s.slug) && list.length > 0 && list.every((f) => safePath(f?.path) && typeof f.content === 'string') && list.reduce((n, f) => n + Buffer.byteLength(f.content), 0) <= SKILL_MAX_BYTES;
        if (!ok) {
            skipped.push(String(s?.slug ?? '').replace(/[^\w-]/g, '').slice(0, 63) || 'unnamed');
            continue;
        }
        for (const f of list)
            files[`${STORE_PREFIX}${s.slug}/${f.path}`] = f.content;
        installed.push(s.slug);
    }
    return { files, installed, skipped };
}
// `account`: the store's own skills as files, from accountSkillFiles. Left out when not logged in or
// Cloud could not be asked, and then store skills already installed are left exactly as they are.
export function syncSkills(reg, opts = {}) {
    const kits = readIndex(reg);
    return (opts.targets ?? defaultTargets()).map((target) => {
        const dir = targetDir(target);
        const managed = readManaged(dir);
        const files = { ...(opts.account ?? {}), ...buildFiles(kits, target) };
        const res = { target, dir, written: [], unchanged: [], kept: [], removed: [] };
        const next = {};
        for (const [rel, body] of Object.entries(files)) {
            const p = join(dir, rel);
            const want = sha(body);
            if (existsSync(p)) {
                const have = sha(readFileSync(p, 'utf8'));
                if (have === want) {
                    res.unchanged.push(rel);
                    next[rel] = want;
                    continue;
                }
                // On disk but not what we last wrote: the user edited it, or wrote it themselves.
                if (managed.files[rel] !== have && !opts.force) {
                    res.kept.push(rel);
                    if (managed.files[rel])
                        next[rel] = managed.files[rel];
                    continue;
                }
            }
            if (!opts.dryRun) {
                mkdirSync(dirname(p), { recursive: true });
                writeFileSync(p, body);
            }
            res.written.push(rel);
            next[rel] = want;
        }
        // Kits that left the registry: remove their skills, unless the user changed them.
        for (const [rel, hash] of Object.entries(managed.files)) {
            if (rel in files)
                continue;
            if (!opts.account && rel.startsWith(STORE_PREFIX)) {
                next[rel] = hash;
                continue;
            }
            const p = join(dir, rel);
            if (existsSync(p) && sha(readFileSync(p, 'utf8')) !== hash && !opts.force) {
                res.kept.push(rel);
                continue;
            }
            if (!opts.dryRun)
                removeFile(dir, rel);
            res.removed.push(rel);
        }
        if (!opts.dryRun) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, MANAGED), JSON.stringify({ managedBy: 'lifecycle-cli', version: VERSION, files: next }, null, 2) + '\n');
        }
        return res;
    });
}
export function skillsStatus(reg, targets = ['claude', 'cursor']) {
    const kits = readIndex(reg);
    return targets.map((target) => {
        const dir = targetDir(target);
        const installed = existsSync(join(dir, MANAGED));
        const managed = readManaged(dir);
        const have = Object.keys(managed.files)
            .map((f) => f.match(/^skills\/kit-(.+)\/SKILL\.md$/)?.[1])
            .filter((x) => !!x);
        return {
            target,
            dir,
            installed,
            installedVersion: installed ? managed.version : null,
            kits: have,
            newKits: kits.map((k) => k.name).filter((n) => !have.includes(n)),
            storeSkills: [...new Set(Object.keys(managed.files).filter((f) => f.startsWith(STORE_PREFIX)).map((f) => f.slice(STORE_PREFIX.length).split('/')[0]))],
        };
    });
}
export function uninstallSkills(targets = ['claude', 'cursor']) {
    return targets.map((target) => {
        const dir = targetDir(target);
        const managed = readManaged(dir);
        const removed = [];
        const kept = [];
        for (const [rel, hash] of Object.entries(managed.files)) {
            const p = join(dir, rel);
            if (!existsSync(p))
                continue;
            if (sha(readFileSync(p, 'utf8')) !== hash) {
                kept.push(rel);
                continue;
            }
            removeFile(dir, rel);
            removed.push(rel);
        }
        if (existsSync(join(dir, MANAGED)))
            rmSync(join(dir, MANAGED));
        pruneEmpty(dir);
        return { target, dir, removed, kept };
    });
}
function removeFile(root, rel) {
    rmSync(join(root, rel), { force: true });
    let d = dirname(join(root, rel));
    while (d.startsWith(root) && d !== root && existsSync(d) && readdirSync(d).length === 0) {
        rmdirSync(d);
        d = dirname(d);
    }
}
function pruneEmpty(dir) {
    if (!existsSync(dir))
        return;
    for (const e of readdirSync(dir, { withFileTypes: true }))
        if (e.isDirectory())
            pruneEmpty(join(dir, e.name));
    if (readdirSync(dir).length === 0)
        rmdirSync(dir);
}
