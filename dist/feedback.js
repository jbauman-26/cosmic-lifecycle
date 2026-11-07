import { spawnSync } from 'node:child_process';
import { platform, release } from 'node:os';
import { VERSION } from './version.js';
export const ISSUES_URL = 'https://github.com/jbauman-26/cosmic-lifecycle/issues/new';
// Builds a prefilled GitHub issue. It carries versions only: no keys, no store name, no data.
export function feedbackUrl(message) {
    const title = message.split('\n')[0].slice(0, 80);
    const body = [message, '', '---', `lifecycle ${VERSION}`, `node ${process.version}`, `${platform()} ${release()}`].join('\n');
    return `${ISSUES_URL}?${new URLSearchParams({ title, body, labels: 'feedback' })}`;
}
export function openUrl(url) {
    const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'explorer' : 'xdg-open';
    return spawnSync(cmd, [url], { stdio: 'ignore' }).status === 0;
}
