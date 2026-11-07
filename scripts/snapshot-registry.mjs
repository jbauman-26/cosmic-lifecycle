// Copies the kit registry into registry-snapshot/, the offline copy that ships in the package.
// Usage: node scripts/snapshot-registry.mjs [registry-folder]   (default: ../cosmic-registry)
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const src = resolve(process.argv[2] ?? process.env.LIFECYCLE_REGISTRY ?? '../cosmic-registry')
const out = resolve('registry-snapshot')
if (!existsSync(join(src, 'index.json'))) {
  console.error(`No index.json in ${src}`)
  process.exit(1)
}
rmSync(out, { recursive: true, force: true })
for (const part of ['index.json', 'kits', 'shared', 'LICENSE']) {
  if (existsSync(join(src, part))) cpSync(join(src, part), join(out, part), { recursive: true })
}
console.log(`Snapshot of ${src} written to ${out}`)
