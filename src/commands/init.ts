import { existsSync, readFileSync } from 'node:fs'
import { writeConfig } from '../config.js'
import { openDb, migrate } from '../db.js'
import { configPath } from '../paths.js'
import { setSecret } from '../secrets.js'
import { CliError } from '../errors.js'

export async function init(opts: { databaseUrlEnv?: string }) {
  const existing = existsSync(configPath()) ? JSON.parse(readFileSync(configPath(), 'utf8')) : {}
  let kind: 'local' | 'postgres' = 'local'
  if (opts.databaseUrlEnv) {
    const url = process.env[opts.databaseUrlEnv]
    if (!url) throw new CliError(`Environment variable ${opts.databaseUrlEnv} is empty.`, 'Export your Postgres URL, then pass the variable name.', 'missing_secret')
    if (!process.env.LIFECYCLE_DATABASE_URL) setSecret('database-url', url)
    kind = 'postgres'
  }
  writeConfig({ ...existing, database: { kind } })
  const db = await openDb()
  await migrate(db)
  await db.close()
  return { database: kind }
}
