import { CliError } from './errors.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The codes the Cosmic AI app and Cosmic Cloud map onto their own messages.
// key_rejected: the source refused the saved key. rate_limited: it asked us to
// slow down and still did after the retries. Anything else stays http_error.
export const httpCode = (status: number) => (status === 401 ? 'key_rejected' : status === 429 ? 'rate_limited' : 'http_error')

const httpMessage = (label: string, status: number) =>
  status === 401 ? `${label} failed: the key was rejected.` : status === 429 ? `${label} failed: the service is rate limiting this key.` : `${label} failed with status ${status}.`

const httpNext = (status: number) =>
  status === 401 || status === 403 ? 'cosmic doctor' : status === 429 ? 'Wait a few minutes, then run the command again.' : 'Run the command again, then cosmic doctor.'

export class HttpError extends CliError {
  constructor(label: string, public status: number, public body: string) {
    super(httpMessage(label, status), httpNext(status), httpCode(status))
  }
}

// Retries only what a retry can fix. Rate limits honor Retry-After, because
// Klaviyo's report endpoints allow just 2 calls a minute.
export async function fetchJson(url: string, init: RequestInit, label: string, opts: { retries?: number; wait?: (ms: number) => Promise<void> } = {}) {
  const wait = opts.wait ?? sleep
  const retries = opts.retries ?? 4
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init)
    const text = await res.text()
    if (res.ok) return text ? JSON.parse(text) : {}
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const after = Number(res.headers.get('retry-after'))
      await wait(Number.isFinite(after) && after > 0 ? after * 1000 : 2 ** attempt * 1000)
      continue
    }
    throw new HttpError(label, res.status, text.slice(0, 400))
  }
}
