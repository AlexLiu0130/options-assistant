import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateKeyPairSync, sign } from 'node:crypto'

import { createAuthRuntime } from '../server/auth.mjs'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const kid = 'smoke-key'
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }
let expectedNonce = ''
let tokenRequest = null

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')
  return `${header}.${body}.${signature}`
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

const oauthServer = createServer(async (req, res) => {
  if (req.url === '/.well-known/openid-configuration') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({
      issuer: authBaseUrl,
      authorization_endpoint: `${authBaseUrl}/oauth/authorize-v2`,
      token_endpoint: `${authBaseUrl}/oauth/token-v2`,
      userinfo_endpoint: `${authBaseUrl}/oauth/userinfo-v2`,
      jwks_uri: `${authBaseUrl}/oauth/jwks-v2`,
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    }))
  }
  if (req.url === '/oauth/jwks-v2') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ keys: [jwk] }))
  }
  if (req.url === '/oauth/token-v2') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    tokenRequest = {
      authorization: req.headers.authorization,
      body: new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
    }
    const now = Math.floor(Date.now() / 1000)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({
      access_token: 'access-token',
      expires_in: 120,
      id_token: jwt({ iss: authBaseUrl, aud: 'options-smoke', sub: 'user-1', email: 'user@example.com', name: 'Test User', nonce: expectedNonce, token_use: 'id', app_access: { client_id: 'options-smoke', status: 'active' }, iat: now, exp: now + 300 }),
    }))
  }
  if (req.url === '/oauth/userinfo-v2') {
    assert.equal(req.headers.authorization, 'Bearer access-token')
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({
      sub: 'user-1',
      email: 'user@example.com',
      name: 'Test User',
      app_access: { client_id: 'options-smoke', status: 'active' },
    }))
  }
  res.writeHead(404).end()
})
const oauthPort = await listen(oauthServer)
const authBaseUrl = `http://127.0.0.1:${oauthPort}`

let runtime
const appServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const json = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  if (!await runtime.handle(req, res, url, json)) json(res, 404, { error: 'not found' })
})
const appPort = await listen(appServer)
const appBaseUrl = `http://127.0.0.1:${appPort}`
runtime = createAuthRuntime({
  authBaseUrl,
  clientId: 'options-smoke',
  clientSecret: 'secret',
  sessionSecret: 'session-secret-for-smoke-tests-32-bytes',
  redirectUri: `${appBaseUrl}/auth/callback`,
  resource: `${authBaseUrl}/account`,
  scopes: 'openid profile email',
})

const loginResponse = await fetch(`${appBaseUrl}/api/auth/login-url`)
assert.equal(loginResponse.status, 200)
const transactionCookie = loginResponse.headers.get('set-cookie').split(';', 1)[0]
const login = await loginResponse.json()
const authorizeUrl = new URL(login.authorizeUrl)
assert.equal(authorizeUrl.pathname, '/oauth/authorize-v2')
assert.equal(authorizeUrl.searchParams.get('resource'), `${authBaseUrl}/account`)
assert.equal(authorizeUrl.searchParams.get('scope'), 'openid profile email')
assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256')
expectedNonce = authorizeUrl.searchParams.get('nonce')
const state = authorizeUrl.searchParams.get('state')

const invalidState = await fetch(`${appBaseUrl}/auth/callback?code=valid-code&state=wrong`, { redirect: 'manual', headers: { cookie: transactionCookie } })
assert.equal(invalidState.status, 302)
assert.equal(invalidState.headers.get('location'), '/?auth_error=invalid_state')
const callback = await fetch(`${appBaseUrl}/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: { cookie: transactionCookie } })
assert.equal(callback.status, 302)
assert.equal(tokenRequest.authorization, `Basic ${Buffer.from('options-smoke:secret').toString('base64')}`)
assert.equal(tokenRequest.body.get('grant_type'), 'authorization_code')
assert.equal(tokenRequest.body.get('redirect_uri'), `${appBaseUrl}/auth/callback`)
assert.ok(tokenRequest.body.get('code_verifier'))
const cookie = callback.headers.getSetCookie().find((value) => value.startsWith('options_session=')).split(';', 1)[0]
assert.match(callback.headers.getSetCookie().find((value) => value.startsWith('options_session=')), /Max-Age=120/)
const me = await fetch(`${appBaseUrl}/api/auth/me`, { headers: { cookie } })
assert.equal(me.status, 200)
assert.equal((await me.json()).user.sub, 'user-1')
const tamperedCookie = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`
assert.equal((await fetch(`${appBaseUrl}/api/auth/me`, { headers: { cookie: tamperedCookie } })).status, 401)
const logout = await fetch(`${appBaseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } })
assert.equal(logout.status, 200)
assert.match(logout.headers.get('set-cookie'), /Max-Age=0/)
assert.equal((await fetch(`${appBaseUrl}/api/auth/me`)).status, 401)

await Promise.all([new Promise((resolve) => appServer.close(resolve)), new Promise((resolve) => oauthServer.close(resolve))])
console.log('OAuth runtime smoke checks passed.')
