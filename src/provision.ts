import { CliError } from './errors.js'
import { fetchJson } from './http.js'

// Provision: create the managed Postgres for you, in your own Neon account, from your own
// API key. Graphed hosts a warehouse for its customers; this gives the same one-command
// managed database without the data leaving your account.

export const NEON_API = 'https://console.neon.tech/api/v2'

export function neonPlan(name: string, region: string) {
  return {
    provider: 'neon',
    creates: [`A Neon project named ${name} in ${region}, in your own Neon account`, 'Its default database becomes this CLI\'s database'],
    cost: 'Neon Free covers a small brand\'s daily totals. Check your plan for your size.',
    next: 'Add --yes to create it.',
  }
}

export async function provisionNeon(key: string, name: string, region: string, fetcher: typeof fetchJson = fetchJson) {
  if (!/^[a-z0-9-]{1,63}$/.test(name)) throw new CliError('Use lowercase letters, numbers and dashes for the name.', 'lifecycle provision neon --name lifecycle --yes', 'bad_name')
  const body = await fetcher(`${NEON_API}/projects`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ project: { name, region_id: region } }),
  }, 'Neon project creation')
  const uri: string | undefined = body?.connection_uris?.[0]?.connection_uri
  if (!uri) throw new CliError('Neon created the project but returned no connection string.', 'Copy it from the Neon console, then lifecycle init --database-url-env NAME', 'no_uri')
  return { projectId: String(body?.project?.id ?? ''), region, uri }
}
