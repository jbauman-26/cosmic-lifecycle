import { expect, it } from 'vitest'
import { cloudNextSteps } from '../src/cloud-start.js'
import type { CloudConnection } from '../src/cloud.js'

const url = 'https://example.com/cloud'
const connection: CloudConnection = {
  id: 'c_example', source_id: 'stripe', source_name: 'Stripe', status: 'working',
  freshness: 'fresh', last_success_at: '2026-11-26T10:00:00Z',
}

it('opens the tutorial for the selected store and offers an explicitly local sample for an empty workspace', () => {
  const text = cloudNextSteps(url, 'shop A&b', []).join('\n')
  expect(text).toContain('local walkthrough with sample data')
  expect(text).toContain('https://example.com/cloud/tutorial?workspace=shop%20A%26b')
})

it.each([
  ['working', 'fresh', connection.last_success_at, 'cosmic metrics list --cloud'],
  ['working', 'stale', connection.last_success_at, 'cosmic logs --cloud --limit 5'],
  ['unverified', 'never', null, 'cosmic sources list --cloud'],
  ['syncing', 'never', null, 'cosmic sources list --cloud'],
  ['warning', 'fresh', connection.last_success_at, 'cosmic logs --cloud --limit 5'],
] as const)('suggests a read for %s / %s', (status, freshness, last_success_at, next) => {
  const lines = cloudNextSteps(url, 'store', [{ ...connection, status, freshness, last_success_at }])
  expect(lines[1]).toContain(next)
})

it('prioritizes an unhealthy source in mixed workspaces', () => {
  const lines = cloudNextSteps(url, 'store', [connection, { ...connection, status: 'failed', source_name: 'Meta Ads' }])
  expect(lines[0]).toBe('2 connections on Cosmic Cloud.')
  expect(lines[1]).toContain('Meta Ads needs attention.')
})
