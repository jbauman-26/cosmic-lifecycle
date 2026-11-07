import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { appHome } from './paths.js';
import { CliError } from './errors.js';
// Files: every report, dashboard and plan the CLI writes is also kept here, by date,
// so an agent can find last week's audit. `files pull` downloads the dashboard the daily
// GitHub Actions sync builds, from your own private repo. Graphed keeps files on its servers;
// these stay on your machine and in your GitHub account.
export const filesDir = () => join(appHome(), 'files');
function safePath(rel) {
    const root = resolve(filesDir());
    const p = resolve(root, rel);
    if (p !== root && !p.startsWith(root + sep))
        throw new CliError('That path is outside the files folder.', 'lifecycle files ls', 'bad_path');
    return p;
}
export function saveArtifact(name, content, now = new Date()) {
    const dir = join(filesDir(), now.toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const p = join(dir, basename(name));
    writeFileSync(p, content);
    return relative(filesDir(), p);
}
export function putFile(local, name, now = new Date()) {
    if (!existsSync(local))
        throw new CliError(`${local} does not exist.`, 'Check the path.', 'missing_file');
    return saveArtifact(name ?? basename(local), readFileSync(local, 'utf8'), now);
}
export function listFiles(sub = '') {
    const start = safePath(sub);
    if (!existsSync(start))
        return [];
    const out = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory())
                walk(p);
            else {
                const s = statSync(p);
                out.push({ path: relative(filesDir(), p), bytes: s.size, modified: s.mtime.toISOString() });
            }
        }
    };
    walk(start);
    return out.sort((a, b) => b.modified.localeCompare(a.modified));
}
export function readFile(rel) {
    const p = safePath(rel);
    if (!existsSync(p) || statSync(p).isDirectory())
        throw new CliError(`No file ${rel}.`, 'lifecycle files ls', 'missing_file');
    return readFileSync(p, 'utf8');
}
export function getFile(rel, dir) {
    const p = safePath(rel);
    if (!existsSync(p))
        throw new CliError(`No file ${rel}.`, 'lifecycle files ls', 'missing_file');
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, basename(p));
    copyFileSync(p, dest);
    return dest;
}
export const CLOUD_ARTIFACT = 'lifecycle-dashboard';
// Downloads the dashboard artifact from the latest successful daily sync in your repo.
export function pullCloud(repo) {
    if (!repo)
        throw new CliError('No sync repo is set.', 'lifecycle config set deploy.repo OWNER/NAME', 'no_repo');
    const list = spawnSync('gh', ['run', 'list', '--repo', repo, '--workflow', 'sync.yml', '--status', 'success', '--limit', '1', '--json', 'databaseId,createdAt'], { encoding: 'utf8' });
    if (list.status !== 0)
        throw new CliError(`Could not read runs for ${repo}.`, 'gh auth login, then lifecycle jobs list', 'gh_runs');
    const run = JSON.parse(list.stdout || '[]')[0];
    if (!run)
        throw new CliError('No successful run yet.', 'lifecycle jobs run', 'no_runs');
    const dest = join(filesDir(), 'cloud', String(run.databaseId));
    mkdirSync(dest, { recursive: true });
    const dl = spawnSync('gh', ['run', 'download', String(run.databaseId), '--repo', repo, '--name', CLOUD_ARTIFACT, '--dir', dest], { encoding: 'utf8' });
    if (dl.status !== 0)
        throw new CliError('That run has no dashboard file.', 'Redeploy with lifecycle 0.5.0 or newer, which uploads one every run.', 'no_artifact');
    return { run: run.databaseId, createdAt: run.createdAt, files: listFiles(relative(filesDir(), dest)).map((f) => f.path) };
}
