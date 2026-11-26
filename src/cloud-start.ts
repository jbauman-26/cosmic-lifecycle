import { clean, type CloudConnection } from './cloud.js'

// Only recommend reads in the terminal. Adding a source happens in the signed-in browser.
export function cloudNextSteps(url: string, storeId: string, connections: CloudConnection[]): string[] {
  const tutorial = `${url}/tutorial${storeId ? `?workspace=${encodeURIComponent(storeId)}` : ''}`
  const guide = `Workspace tutorial: ${tutorial}`
  if (!connections.length) return [
    'No sources are connected on Cosmic Cloud yet.',
    'Open the tutorial to choose your first source, or run cosmic demo for a local walkthrough with sample data.',
    guide,
  ]

  const count = `${connections.length} ${connections.length === 1 ? 'connection' : 'connections'} on Cosmic Cloud.`
  const attention = connections.find((c) => c.status === 'failed' || c.status === 'warning' || c.freshness === 'stale')
  if (attention) {
    const name = clean(String(attention.source_name ?? attention.source_id), 80)
    return [count, `${name} needs attention. Inspect recent sync runs: cosmic logs --cloud --limit 5`, guide]
  }

  const pending = connections.find((c) => !c.last_success_at || c.status !== 'working')
  if (pending) {
    const name = clean(String(pending.source_name ?? pending.source_id), 80)
    return [count, `Check the sync status for ${name}: cosmic sources list --cloud`, guide]
  }

  return [count, 'Browse the metrics available in this workspace: cosmic metrics list --cloud', guide]
}
