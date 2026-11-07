// Writes llms.txt from the quickstart doc, so the hosted playbook and
// `lifecycle docs quickstart` can never drift apart. Runs after tsc.
import { writeFileSync } from 'node:fs'
import { DOCS } from '../dist/docs.js'

writeFileSync('llms.txt', DOCS.quickstart)
console.log('llms.txt written')
