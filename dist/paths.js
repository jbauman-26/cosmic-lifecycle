import { homedir } from 'node:os';
import { join } from 'node:path';
// LIFECYCLE_HOME keeps tests and demos away from a user's real config.
export const appHome = () => process.env.LIFECYCLE_HOME ?? join(homedir(), '.lifecycle');
export const configPath = () => join(appHome(), 'config.json');
export const localDbPath = () => join(appHome(), 'pgdata');
