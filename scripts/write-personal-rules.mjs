import { writeFileSync } from 'node:fs'
import { PERSONAL_RULES } from '../dist/personal.js'

// The loader is Python. It reads the rule list from this file, written from src/personal.ts on every
// build, so there is one list and no copy to keep in step by hand.
writeFileSync(new URL('../connectors/personal-rules.json', import.meta.url), JSON.stringify(PERSONAL_RULES, null, 2) + '\n')
