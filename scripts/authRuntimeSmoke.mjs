import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateKeyPairSync, sign } from 'node:crypto'

import { createAuthRuntime } from '../server/auth.mjs'

function signingKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } }
}

const oldSigningKey = signingKey('smoke-key-old')
const newSigningKey = signingKey('smoke-key-new')
let activeSigningKey = oldSigningKey
let expectedNonce = ''
let tokenRequest = null
let tokenSubject = 'user-1'
let userinfoSubject = 'user-1'
let tokenFailure = false
let jwksRequests = 0
const authLogs = []

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: activeSigningKey.jwk.kid })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), activeSigningKey.privateKey).toString('base64url')
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
    jwksRequests += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ keys: [activeSigningKey.jwk] }))
  }
  if (req.url === '/oauth/token-v2') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    tokenRequest = {
      authorization: req.headers.authorization,
      body: new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
    }
    if (tokenFailure) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'access_token=must-not-appear' }))
    }
    const now = Math.floor(Date.now() / 1000)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({
      access_token: 'access-token',
      expires_in: 120,
      id_token: jwt({ iss: authBaseUrl, aud: 'options-smoke', sub: tokenSubject, email: 'user@example.com', name: 'Test User', nonce: expectedNonce, token_use: 'id', app_access: { client_id: 'options-smoke', status: 'active' }, iat: now, exp: now + 300 }),
    }))
  }
  if (req.url === '/oauth/userinfo-v2') {
    assert.equal(req.headers.authorization, 'Bearer access-token')
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({
      sub: userinfoSubject,
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
  logger: { error: (...args) => authLogs.push(args) },
})

async function startLogin() {
  const response = await fetch(`${appBaseUrl}/api/auth/login-url`)
  assert.equal(response.status, 200)
  const transactionCookie = response.headers.get('set-cookie').split(';', 1)[0]
  const login = await response.json()
  const authorizeUrl = new URL(login.authorizeUrl)
  expectedNonce = authorizeUrl.searchParams.get('nonce')
  return { response, transactionCookie, login, authorizeUrl, state: authorizeUrl.searchParams.get('state') }
}

const { transactionCookie, authorizeUrl, state } = await startLogin()
assert.equal(authorizeUrl.pathname, '/oauth/authorize-v2')
assert.equal(authorizeUrl.searchParams.get('resource'), `${authBaseUrl}/account`)
assert.equal(authorizeUrl.searchParams.get('scope'), 'openid profile email')
assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256')
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
assert.match(callback.headers.getSetCookie().find((value) => value.startsWith('options_session=')), /Max-Age=86400/)
const me = await fetch(`${appBaseUrl}/api/auth/me`, { headers: { cookie } })
assert.equal(me.status, 200)
assert.equal((await me.json()).user.sub, 'user-1')
const tamperedCookie = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`
assert.equal((await fetch(`${appBaseUrl}/api/auth/me`, { headers: { cookie: tamperedCookie } })).status, 401)
const logout = await fetch(`${appBaseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } })
assert.equal(logout.status, 200)
assert.match(logout.headers.get('set-cookie'), /Max-Age=0/)
assert.equal((await fetch(`${appBaseUrl}/api/auth/me`)).status, 401)

activeSigningKey = newSigningKey
const rotatedLogin = await startLogin()
const rotatedCallback = await fetch(`${appBaseUrl}/auth/callback?code=rotated-code&state=${encodeURIComponent(rotatedLogin.state)}`, { redirect: 'manual', headers: { cookie: rotatedLogin.transactionCookie } })
assert.equal(rotatedCallback.status, 302)
assert.equal(rotatedCallback.headers.get('location'), '/')
assert.equal(jwksRequests, 2, 'A new signing key should force one JWKS refresh.')

tokenSubject = ''
userinfoSubject = ''
const emptySubjectLogin = await startLogin()
const emptySubjectCallback = await fetch(`${appBaseUrl}/auth/callback?code=empty-subject-code&state=${encodeURIComponent(emptySubjectLogin.state)}`, { redirect: 'manual', headers: { cookie: emptySubjectLogin.transactionCookie } })
assert.equal(emptySubjectCallback.headers.get('location'), '/?auth_error=authorization_failed')
assert.equal(authLogs.at(-1)[1].error_message, 'ID token subject is invalid.')

tokenSubject = 'user-1'
const emptyUserinfoSubjectLogin = await startLogin()
const emptyUserinfoSubjectCallback = await fetch(`${appBaseUrl}/auth/callback?code=empty-userinfo-subject-code&state=${encodeURIComponent(emptyUserinfoSubjectLogin.state)}`, { redirect: 'manual', headers: { cookie: emptyUserinfoSubjectLogin.transactionCookie } })
assert.equal(emptyUserinfoSubjectCallback.headers.get('location'), '/?auth_error=authorization_failed')
assert.equal(authLogs.at(-1)[1].error_message, 'QVeris UserInfo validation failed.')

tokenFailure = true
const failedLogin = await startLogin()
const failedCallback = await fetch(`${appBaseUrl}/auth/callback?code=sensitive-code&state=${encodeURIComponent(failedLogin.state)}`, { redirect: 'manual', headers: { cookie: failedLogin.transactionCookie } })
assert.equal(failedCallback.headers.get('location'), '/?auth_error=authorization_failed')
const serializedLogs = JSON.stringify(authLogs)
assert.doesNotMatch(serializedLogs, /sensitive-code|must-not-appear|access_token/)
assert.match(serializedLogs, /QVeris token exchange failed/)

await Promise.all([new Promise((resolve) => appServer.close(resolve)), new Promise((resolve) => oauthServer.close(resolve))])
console.log('OAuth runtime smoke checks passed.')
