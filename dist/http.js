import { CliError } from './errors.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class HttpError extends CliError {
    status;
    body;
    constructor(label, status, body) {
        super(`${label} failed with status ${status}.`, status === 401 || status === 403 ? 'lifecycle doctor' : 'Run the command again, then lifecycle doctor.', 'http_error');
        this.status = status;
        this.body = body;
    }
}
// Retries only what a retry can fix. Rate limits honor Retry-After, because
// Klaviyo's report endpoints allow just 2 calls a minute.
export async function fetchJson(url, init, label, opts = {}) {
    const wait = opts.wait ?? sleep;
    const retries = opts.retries ?? 4;
    for (let attempt = 0;; attempt++) {
        const res = await fetch(url, init);
        const text = await res.text();
        if (res.ok)
            return text ? JSON.parse(text) : {};
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
            const after = Number(res.headers.get('retry-after'));
            await wait(Number.isFinite(after) && after > 0 ? after * 1000 : 2 ** attempt * 1000);
            continue;
        }
        throw new HttpError(label, res.status, text.slice(0, 400));
    }
}
