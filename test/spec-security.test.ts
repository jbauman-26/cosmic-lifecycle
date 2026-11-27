import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The credential help is the only guidance a customer reads while making a key.
// If it does not ask for read-only scope, the connection they create can usually
// change their data too, which is a blast radius problem we can prevent in text.
const SPECS = join(process.cwd(), 'connectors', 'specs')

type Credential = { name: string; help?: string }
type Spec = { slug: string; credentials: Credential[]; config: { client: { base_url: string } } }

const specs: Spec[] = readdirSync(SPECS)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(SPECS, f), 'utf8')) as Spec)

describe('connector specs ask for the smallest credential that works', () => {
  it('has specs to check', () => {
    expect(specs.length).toBeGreaterThan(30)
  })

  it('every spec asks for read-only scope in its credential help', () => {
    const missing = specs
      .filter((s) => {
        const help = (s.credentials ?? []).map((c) => c.help ?? '').join(' ')
        return !/read[\s-]?only|view[\s-]?only|least privilege/i.test(help)
      })
      .map((s) => s.slug)
    expect(missing, `specs whose help never asks for read-only scope: ${missing.join(', ')}`).toEqual([])
  })

  it('every spec talks to https', () => {
    const plain = specs.filter((s) => !/^https:\/\//.test(s.config?.client?.base_url ?? '')).map((s) => s.slug)
    expect(plain, `specs with a non-https base url: ${plain.join(', ')}`).toEqual([])
  })

  // Some providers issue keys that carry the creating user's own access, and
  // there is no read-only option. That is allowed only when the help says so
  // and gives the customer a way to limit the damage: a dedicated account,
  // deletion after use, or rotation.
  it('a high-privilege key is disclosed together with a mitigation', () => {
    const risky = specs
      .filter((s) => {
        const help = (s.credentials ?? []).map((c) => c.help ?? '').join(' ')
        const highPrivilege = /\b(use|create|paste|generate)\b[^.]{0,40}\b(admin|administrator|owner|super ?user)\b/i.test(help)
        if (!highPrivilege) return false
        return !/dedicated|read[\s-]?only|delete it|rotate|least privilege|minimal/i.test(help)
      })
      .map((s) => s.slug)
    expect(risky, `specs naming a high-privilege key without a mitigation: ${risky.join(', ')}`).toEqual([])
  })
})
