import { fetchJson, HttpError } from '../http.js'
import { CliError } from '../errors.js'

export type Ga4Day = { date: string; channel: string; sessions: number; purchases: number; revenue: number }

export async function ga4AccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const body = await fetchJson(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
    },
    'Google token request',
  ).catch((e) => {
    // Google answers a revoked refresh token or a wrong client secret with 400 invalid_grant or 401 invalid_client.
    if (e instanceof HttpError && (e.status === 400 || e.status === 401) && /invalid_grant|invalid_client|unauthorized_client/.test(e.body)) {
      throw new CliError('Google rejected the saved GA4 sign-in.', 'Create a new refresh token, then cosmic connect ga4 --property ID --client-id ID --secret-env NAME --refresh-token-env NAME', 'key_rejected')
    }
    throw e
  })
  return body.access_token
}

export function parseGa4Report(body: any): Ga4Day[] {
  return (body?.rows ?? []).map((r: any) => {
    const raw: string = r.dimensionValues[0].value
    return {
      date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
      channel: r.dimensionValues[1].value,
      sessions: Number(r.metricValues[0].value),
      purchases: Number(r.metricValues[1].value),
      revenue: Number(r.metricValues[2].value),
    }
  })
}

export async function fetchGa4Daily(property: string, token: string, start: string, end: string): Promise<Ga4Day[]> {
  const out: Ga4Day[] = []
  const limit = 10000
  for (let offset = 0; ; offset += limit) {
    const body = await fetchJson(
      `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          dateRanges: [{ startDate: start, endDate: end }],
          dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
          metrics: [{ name: 'sessions' }, { name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }],
          limit,
          offset,
        }),
      },
      'GA4 report',
    )
    const page = parseGa4Report(body)
    out.push(...page)
    if (page.length < limit) return out
  }
}
