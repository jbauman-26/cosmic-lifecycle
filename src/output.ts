import { CliError } from './errors.js'

export type Format = 'text' | 'json'

export function emit(format: Format, data: unknown, text: () => string) {
  console.log(format === 'json' ? JSON.stringify(data, null, 2) : text())
}

export function emitError(format: Format, err: unknown) {
  const e = err instanceof CliError ? err : new CliError(err instanceof Error ? err.message : String(err), 'lifecycle doctor')
  if (format === 'json') console.error(JSON.stringify({ error: e.message, code: e.code, next: e.next }))
  else console.error(`Error: ${e.message}\nNext: ${e.next}`)
  process.exitCode = 1
}
