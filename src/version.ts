import { createRequire } from 'node:module'

// Read from package.json so a release can never report an old version.
export const VERSION: string = createRequire(import.meta.url)('../package.json').version
