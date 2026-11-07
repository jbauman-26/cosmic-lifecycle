import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureRegistry, validateRegistry } from '../src/registry.js'
import { skillsStatus, syncSkills, targetDir, uninstallSkills } from '../src/skills.js'

let tmp: string
const realHome = process.env.HOME

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lc-skills-'))
  process.env.HOME = tmp
})
afterEach(() => {
  process.env.HOME = realHome
  rmSync(tmp, { recursive: true, force: true })
})

const reg = () => ensureRegistry({ uri: resolve('registry-snapshot') })
const dir = () => targetDir('claude')

describe('skills sync', () => {
  it('installs a router, a plugin manifest and one skill per kit under the fake home', () => {
    const [r] = syncSkills(reg(), { targets: ['claude'] })
    expect(dir().startsWith(tmp)).toBe(true)
    expect(r!.written).toContain('SKILL.md')
    expect(r!.written).toContain('.claude-plugin/plugin.json')
    const kit = readFileSync(join(dir(), 'skills', 'kit-flow-audit', 'SKILL.md'), 'utf8')
    expect(kit).toMatch(/name: "kits:flow-audit"/)
    expect(kit).toMatch(/lifecycle kits add flow-audit/)
    expect(readFileSync(join(dir(), 'SKILL.md'), 'utf8')).toMatch(/\/lifecycle:kits:winback-segment/)
  })

  it('is a no-op the second time', () => {
    syncSkills(reg(), { targets: ['claude'] })
    const [r] = syncSkills(reg(), { targets: ['claude'] })
    expect(r!.written).toEqual([])
  })

  it('keeps a file the user edited, unless forced', () => {
    syncSkills(reg(), { targets: ['claude'] })
    const p = join(dir(), 'SKILL.md')
    writeFileSync(p, 'my notes')
    expect(syncSkills(reg(), { targets: ['claude'] })[0]!.kept).toEqual(['SKILL.md'])
    expect(readFileSync(p, 'utf8')).toBe('my notes')
    // Still treated as edited on the next run, so it stays kept.
    expect(syncSkills(reg(), { targets: ['claude'] })[0]!.kept).toEqual(['SKILL.md'])
    syncSkills(reg(), { targets: ['claude'], force: true })
    expect(readFileSync(p, 'utf8')).toMatch(/Cosmic Lifecycle/)
  })

  it('does not overwrite a skill folder it never wrote', () => {
    writeFileSync(join(tmp, 'x'), '')
    const p = join(dir(), 'SKILL.md')
    cpSync(join(tmp, 'x'), p, { recursive: true })
    writeFileSync(p, 'someone else')
    expect(syncSkills(reg(), { targets: ['claude'] })[0]!.kept).toContain('SKILL.md')
  })

  it('removes the skill of a kit that left the registry', () => {
    syncSkills(reg(), { targets: ['claude'] })
    const r2 = join(tmp, 'reg')
    cpSync(resolve('registry-snapshot'), r2, { recursive: true })
    rmSync(join(r2, 'kits', 'revenue-per-flow'), { recursive: true })
    validateRegistry(r2, { writeIndex: true })
    const [r] = syncSkills(ensureRegistry({ uri: r2 }), { targets: ['claude'] })
    expect(r!.removed).toEqual(['skills/kit-revenue-per-flow/SKILL.md'])
    expect(existsSync(join(dir(), 'skills', 'kit-revenue-per-flow'))).toBe(false)
  })

  it('writes nothing on a dry run', () => {
    const [r] = syncSkills(reg(), { targets: ['claude'], dryRun: true })
    expect(r!.written.length).toBeGreaterThan(0)
    expect(existsSync(dir())).toBe(false)
  })
})

describe('status and uninstall', () => {
  it('reports new kits, then removes only what it installed', () => {
    expect(skillsStatus(reg(), ['claude'])[0]).toMatchObject({ installed: false })
    syncSkills(reg(), { targets: ['claude'] })
    expect(skillsStatus(reg(), ['claude'])[0]).toMatchObject({ installed: true, newKits: [] })
    writeFileSync(join(dir(), 'README.md'), 'edited')
    const [u] = uninstallSkills(['claude'])
    expect(u!.kept).toEqual(['README.md'])
    expect(existsSync(join(dir(), 'README.md'))).toBe(true)
    expect(existsSync(join(dir(), 'SKILL.md'))).toBe(false)
  })
})
