// Loaded with --import into a CLI run. Answers the Pinterest and Microsoft token requests with a new
// refresh token, as both may do, so a sync can be run end to end without the network. Pinterest gets an
// account with no campaigns. Every other request is refused with a 400, which ends that source's sync.
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input) => {
  const url = String(input)
  if (url === 'https://api.pinterest.com/v5/oauth/token') {
    return json(200, { access_token: 'pina_fakeaccess', refresh_token: process.env.FAKE_PINTEREST_ROTATED, response_type: 'refresh_token', token_type: 'bearer', expires_in: 2592000, scope: 'ads:read' })
  }
  if (url.startsWith('https://api.pinterest.com/v5/ad_accounts/') && url.includes('/campaigns?')) return json(200, { items: [], bookmark: null })
  if (url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
    return json(200, { token_type: 'Bearer', scope: 'https://ads.microsoft.com/msads.manage', expires_in: 3599, access_token: 'EwB.fake', refresh_token: process.env.FAKE_MICROSOFT_ROTATED })
  }
  return json(400, { error: 'not in this fake' })
}
