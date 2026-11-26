import { homedir } from 'node:os'
import { join } from 'node:path'

import { CliError } from './errors.js'

// LIFECYCLE_HOME keeps tests and demos away from a user's real config.
const baseHome = () => process.env.LIFECYCLE_HOME ?? join(homedir(), '.lifecycle')

// LIFECYCLE_WORKSPACE (or --workspace NAME) picks a named workspace: its own config, database,
// files and keychain entries under workspaces/NAME. An agency keeps one per client. Unset, the
// home folder itself is the workspace, as in every release before 0.14.0.
export function workspaceName(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.LIFECYCLE_WORKSPACE?.trim()
  if (!v) return null
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(v)) throw new CliError('A workspace name is 1 to 40 lowercase letters, numbers and dashes.', 'cosmic --workspace acme-co status', 'bad_value')
  return v
}
export const appHome = () => {
  const ws = workspaceName()
  return ws ? join(baseHome(), 'workspaces', ws) : baseHome()
}
export const workspacesDir = () => join(baseHome(), 'workspaces')
export const configPath = () => join(appHome(), 'config.json')
export const localDbPath = () => join(appHome(), 'pgdata')
