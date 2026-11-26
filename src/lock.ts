import { linkSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { appHome } from './paths.js'
import { readRawConfig } from './config.js'
import { CliError } from './errors.js'

// One writer per home folder. The local database is a PGlite folder, and two
// processes writing it at once corrupt each other: one dies with "File exists"
// while the other carries on with a stale view. A write command takes this lock
// first, waits a short while for the holder, then fails with code `busy`.
//
// The lock is a file holding the holder's process id. A lock whose process is
// gone is cleared, so a crash or Ctrl+C never blocks the next run.

export const lockPath = () => join(appHome(), 'write.lock')

const DEFAULT_WAIT_MS = 10_000
// A lock this old is treated as abandoned even if its process id is alive again
// under another program. No write command runs for half a day.
const MAX_AGE_MS = 12 * 60 * 60 * 1000

export type LockInfo = { pid: number; command: string; startedAt: string }
export type LockOptions = { waitMs?: number; pollMs?: number; force?: boolean }

export function lockWaitMs(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.LIFECYCLE_LOCK_WAIT_MS)
  return env.LIFECYCLE_LOCK_WAIT_MS !== undefined && Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAIT_MS
}

// A Postgres store does its own locking, so only a local store (or one not set up yet) needs the file.
export function lockNeeded() {
  try {
    return readRawConfig()?.database?.kind !== 'postgres'
  } catch {
    return true
  }
}

export function readLock(): LockInfo | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath(), 'utf8'))
    if (typeof raw?.pid !== 'number') return null
    return { pid: raw.pid, command: String(raw.command ?? ''), startedAt: String(raw.startedAt ?? '') }
  } catch {
    return null
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isStale(info: LockInfo | null) {
  if (!info) {
    // Unreadable: either half written this instant, or left behind. Give a writer a moment.
    try {
      return Date.now() - statSync(lockPath()).mtimeMs > 2000
    } catch {
      return false
    }
  }
  if (!alive(info.pid)) return true
  const age = Date.now() - Date.parse(info.startedAt)
  return Number.isFinite(age) && age > MAX_AGE_MS
}

// Moves a stale lock aside rather than deleting it in place, so two processes
// clearing the same stale lock cannot delete each other's fresh one.
function clearStale(judged: LockInfo | null) {
  const aside = `${lockPath()}.stale-${process.pid}-${Date.now()}`
  try {
    renameSync(lockPath(), aside)
  } catch {
    return
  }
  let moved: LockInfo | null = null
  try {
    const raw = JSON.parse(readFileSync(aside, 'utf8'))
    moved = typeof raw?.pid === 'number' ? raw : null
  } catch {
    moved = null
  }
  if (moved && (!judged || moved.pid !== judged.pid || moved.startedAt !== judged.startedAt) && alive(moved.pid)) {
    // Someone took the lock between our look and our move. Put it back.
    try {
      linkSync(aside, lockPath())
    } catch {
      // A third process holds it now; the moved holder will find out on release.
    }
  }
  rmSync(aside, { force: true })
}

function tryCreate(command: string): boolean {
  mkdirSync(appHome(), { recursive: true, mode: 0o700 })
  let fd: number
  try {
    fd = openSync(lockPath(), 'wx', 0o600)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() } satisfies LockInfo))
  } finally {
    closeSync(fd)
  }
  return true
}

let depth = 0
let exitHook = false

function release() {
  if (depth === 0) return
  depth -= 1
  if (depth > 0) return
  if (readLock()?.pid === process.pid) rmSync(lockPath(), { force: true })
}

function held() {
  depth += 1
  if (!exitHook) {
    exitHook = true
    // process.exit() inside a command skips finally blocks; this still frees the lock.
    process.on('exit', () => {
      if (depth > 0 && readLock()?.pid === process.pid) rmSync(lockPath(), { force: true })
    })
  }
  return release
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function busyError(info: LockInfo | null) {
  const who = info ? ` (${info.command || 'a command'}, started ${info.startedAt.slice(11, 19)} UTC, process ${info.pid})` : ''
  return new CliError(
    `Another lifecycle command is writing to this store${who}.`,
    'Wait for it to finish, then run this again. Reading commands such as cosmic metrics run still work.',
    'busy',
  )
}

// Takes the lock without waiting. Returns the release function, or null when someone else holds it.
export function tryWriteLock(command: string, opts: { force?: boolean } = {}): (() => void) | null {
  if (!opts.force && !lockNeeded()) return () => {}
  if (depth > 0) return held()
  if (tryCreate(command)) return held()
  const info = readLock()
  if (isStale(info)) {
    clearStale(info)
    if (tryCreate(command)) return held()
  }
  return null
}

// Takes the lock, waiting up to waitMs (default 10 seconds, LIFECYCLE_LOCK_WAIT_MS) for the holder to finish.
export async function acquireWriteLock(command: string, opts: LockOptions = {}): Promise<() => void> {
  const waitMs = opts.waitMs ?? lockWaitMs()
  const pollMs = opts.pollMs ?? 100
  const deadline = Date.now() + waitMs
  for (;;) {
    const got = tryWriteLock(command, opts)
    if (got) return got
    if (Date.now() >= deadline) throw busyError(readLock())
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

export async function withWriteLock<T>(command: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const done = await acquireWriteLock(command, opts)
  try {
    return await fn()
  } finally {
    done()
  }
}
