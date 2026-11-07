import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readIndex, type IndexEntry, type Registry } from './registry.js'
import { VERSION } from './version.js'

// Installs one router skill plus one setup skill per kit, the same layout Graphed uses:
// /lifecycle is the router, /lifecycle:kits:<kit> sets up a kit.
// Every file we write is recorded with its hash, so a file the user edited is never overwritten.
export const PLUGIN = 'lifecycle'
const MANAGED = '.lifecycle-managed.json'

export type Target = 'claude' | 'cursor'
export const targetDir = (t: Target) => (t === 'claude' ? join(homedir(), '.claude', 'skills', PLUGIN) : join(homedir(), '.cursor', 'plugins', 'local', PLUGIN))

// Cursor is only touched when it is installed, unless asked for by name.
export function defaultTargets(): Target[] {
  return existsSync(join(homedir(), '.cursor')) ? ['claude', 'cursor'] : ['claude']
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const pluginJson = () =>
  JSON.stringify(
    {
      name: PLUGIN,
      version: VERSION,
      description: 'Cosmic Lifecycle skills. The router is /lifecycle. Kit setup is /lifecycle:kits:<kit>, for example /lifecycle:kits:flow-audit.',
      author: { name: 'Cosmic AI' },
      homepage: 'https://github.com/jbauman-26/cosmic-lifecycle',
      license: 'MIT',
      keywords: ['klaviyo', 'shopify', 'lifecycle'],
    },
    null,
    2,
  ) + '\n'

const routerSkill = (kits: IndexEntry[]) => `---
name: ${PLUGIN}
description: Work with Shopify and Klaviyo numbers through the Cosmic Lifecycle CLI. Use when asked about flow performance, revenue per flow, win-back segments, Klaviyo or Shopify reconciliation, or setting up a lifecycle kit.
---

# Cosmic Lifecycle

This skill is a router. The playbook that matches the installed CLI ships inside it. Load it before any lifecycle work:

\`\`\`sh
lifecycle docs agents
\`\`\`

Then, as the task needs:
- \`lifecycle docs setup\` connects Klaviyo, Shopify and GA4.
- \`lifecycle docs kits\` explains kits.
- \`lifecycle docs commands\` lists every command.

If \`lifecycle\` is not on PATH, stop and ask the user to install it from https://github.com/jbauman-26/cosmic-lifecycle.

Rules:
- Run \`lifecycle reconcile\` before quoting any number. If a check failed, say so first.
- Nothing in this tool sends a message. Never claim attributed revenue proves causation.
- "Audit my flows", "rank my flows" or "build a win-back segment" is a kit task. Prefer the kit skill:
${kits.map((k) => `  - \`/${PLUGIN}:kits:${k.name}\`: ${k.summary}`).join('\n')}
`

const kitSkill = (k: IndexEntry) => `---
name: "kits:${k.name}"
description: "Run the ${k.title} kit from Cosmic Lifecycle. ${k.summary.replace(/"/g, "'")} Use when asked for a ${k.title.toLowerCase()}."
---

# ${k.title}

This skill is generated from the \`${k.name}\` kit at version ${k.version}.

## Steps

1. If \`lifecycle\` is not on PATH, stop and ask the user to install it.
2. Load the playbook:

   \`\`\`sh
   lifecycle docs agents
   lifecycle kits show ${k.name}
   lifecycle doctor --format json
   \`\`\`

3. Connect what the kit needs (${k.needs.join(', ')}) with \`lifecycle docs setup\` if doctor says it is missing.
4. Stage the kit:

   \`\`\`sh
   lifecycle kits add ${k.name} --format json
   \`\`\`

5. Read \`lifecycle-kits/${k.name}/AGENT.md\` and follow it in order, including the Verify checklist at the end.

What it changes: ${k.writes}
`

export function buildFiles(kits: IndexEntry[], target: Target): Record<string, string> {
  const files: Record<string, string> = {
    'SKILL.md': routerSkill(kits),
    'README.md': `# Cosmic Lifecycle skills\n\nInstalled by \`lifecycle skills sync\`. Files you edit here are kept on the next sync. Remove everything with \`lifecycle skills uninstall\`.\n`,
    [target === 'claude' ? '.claude-plugin/plugin.json' : '.cursor-plugin/plugin.json']: pluginJson(),
  }
  for (const k of kits) files[`skills/kit-${k.name}/SKILL.md`] = kitSkill(k)
  return files
}

type Managed = { managedBy: 'lifecycle-cli'; version: string; files: Record<string, string> }

function readManaged(dir: string): Managed {
  const p = join(dir, MANAGED)
  if (!existsSync(p)) return { managedBy: 'lifecycle-cli', version: VERSION, files: {} }
  return JSON.parse(readFileSync(p, 'utf8'))
}

export type SyncResult = { target: Target; dir: string; written: string[]; unchanged: string[]; kept: string[]; removed: string[] }

export function syncSkills(reg: Registry, opts: { targets?: Target[]; dryRun?: boolean; force?: boolean } = {}): SyncResult[] {
  const kits = readIndex(reg)
  return (opts.targets ?? defaultTargets()).map((target) => {
    const dir = targetDir(target)
    const managed = readManaged(dir)
    const files = buildFiles(kits, target)
    const res: SyncResult = { target, dir, written: [], unchanged: [], kept: [], removed: [] }
    const next: Record<string, string> = {}

    for (const [rel, body] of Object.entries(files)) {
      const p = join(dir, rel)
      const want = sha(body)
      if (existsSync(p)) {
        const have = sha(readFileSync(p, 'utf8'))
        if (have === want) {
          res.unchanged.push(rel)
          next[rel] = want
          continue
        }
        // On disk but not what we last wrote: the user edited it, or wrote it themselves.
        if (managed.files[rel] !== have && !opts.force) {
          res.kept.push(rel)
          if (managed.files[rel]) next[rel] = managed.files[rel]!
          continue
        }
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, body)
      }
      res.written.push(rel)
      next[rel] = want
    }

    // Kits that left the registry: remove their skills, unless the user changed them.
    for (const [rel, hash] of Object.entries(managed.files)) {
      if (rel in files) continue
      const p = join(dir, rel)
      if (existsSync(p) && sha(readFileSync(p, 'utf8')) !== hash && !opts.force) {
        res.kept.push(rel)
        continue
      }
      if (!opts.dryRun) removeFile(dir, rel)
      res.removed.push(rel)
    }

    if (!opts.dryRun) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, MANAGED), JSON.stringify({ managedBy: 'lifecycle-cli', version: VERSION, files: next }, null, 2) + '\n')
    }
    return res
  })
}

export function skillsStatus(reg: Registry, targets: Target[] = ['claude', 'cursor']) {
  const kits = readIndex(reg)
  return targets.map((target) => {
    const dir = targetDir(target)
    const installed = existsSync(join(dir, MANAGED))
    const managed = readManaged(dir)
    const have = Object.keys(managed.files)
      .map((f) => f.match(/^skills\/kit-(.+)\/SKILL\.md$/)?.[1])
      .filter((x): x is string => !!x)
    return {
      target,
      dir,
      installed,
      installedVersion: installed ? managed.version : null,
      kits: have,
      newKits: kits.map((k) => k.name).filter((n) => !have.includes(n)),
    }
  })
}

export function uninstallSkills(targets: Target[] = ['claude', 'cursor']) {
  return targets.map((target) => {
    const dir = targetDir(target)
    const managed = readManaged(dir)
    const removed: string[] = []
    const kept: string[] = []
    for (const [rel, hash] of Object.entries(managed.files)) {
      const p = join(dir, rel)
      if (!existsSync(p)) continue
      if (sha(readFileSync(p, 'utf8')) !== hash) {
        kept.push(rel)
        continue
      }
      removeFile(dir, rel)
      removed.push(rel)
    }
    if (existsSync(join(dir, MANAGED))) rmSync(join(dir, MANAGED))
    pruneEmpty(dir)
    return { target, dir, removed, kept }
  })
}

function removeFile(root: string, rel: string) {
  rmSync(join(root, rel), { force: true })
  let d = dirname(join(root, rel))
  while (d.startsWith(root) && d !== root && existsSync(d) && readdirSync(d).length === 0) {
    rmdirSync(d)
    d = dirname(d)
  }
}

function pruneEmpty(dir: string) {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmpty(join(dir, e.name))
  if (readdirSync(dir).length === 0) rmdirSync(dir)
}
