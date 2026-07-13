import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto'

const transactionTtlMs = 10 * 60 * 1000
const maximumSessionTtlMs = 60 * 60 * 1000
const metadataTtlMs = 5 * 60 * 1000

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function randomToken(bytes = 32) {
  return base64url(randomBytes(bytes))
}

function parseCookies(req) {
  const cookies = {}
  for (const rawPart of String(req.headers.cookie || '').split(';')) {
    const part = rawPart.trim()
    const index = part.indexOf('=')
    if (index <= 0) continue
    try {
      cookies[decodeURIComponent(part.slice(0, index))] = decodeURIComponent(part.slice(index + 1))
    } catch {
      // Ignore malformed cookies rather than failing the request.
    }
  }
  return cookies
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
    pragma: 'no-cache',
    ...(cookies.length ? { 'set-cookie': cookies } : {}),
  })
  res.end()
}

function publicAuthError(error) {
  const allowed = new Set([
    'access_denied',
    'access_revoked',
    'beta_full',
    'invalid_invitation',
    'invitation_required',
  ])
  return allowed.has(error) ? error : 'authorization_failed'
}

async function readJsonResponse(response, fallback) {
  try {
    return await response.json()
  } catch {
    throw new Error(fallback)
  }
}

function validateMetadata(metadata, authBaseUrl) {
  const required = ['issuer', 'authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri']
  if (required.some((key) => !metadata?.[key])) throw new Error('QVeris discovery metadata is incomplete.')
  if (metadata.issuer !== authBaseUrl) throw new Error('QVeris discovery issuer does not match QVERIS_AUTH_BASE_URL.')
  if (!metadata.grant_types_supported?.includes('authorization_code')) throw new Error('QVeris authorization_code flow is unavailable.')
  if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('QVeris S256 PKCE is unavailable.')
  if (!metadata.token_endpoint_auth_methods_supported?.includes('client_secret_basic')) throw new Error('QVeris client_secret_basic is unavailable.')
  return metadata
}

async function verifyIdToken(token, { clientId, issuer, jwksUri, nonce, jwksCache }) {
  const [encodedHeader, encodedPayload, encodedSignature] = String(token).split('.')
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error('ID token is malformed.')
  const header = decodeSegment(encodedHeader)
  const payload = decodeSegment(encodedPayload)
  if (header.alg !== 'RS256' || !header.kid) throw new Error('ID token algorithm is not allowed.')
  let keys = jwksCache.value
  if (!keys || jwksCache.expires <= Date.now()) {
    const response = await fetch(jwksUri, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error('Unable to load QVeris signing keys.')
    keys = await readJsonResponse(response, 'QVeris signing keys are unreadable.')
    jwksCache.value = keys
    jwksCache.expires = Date.now() + metadataTtlMs
  }
  const jwk = keys.keys?.find((item) => item.kid === header.kid && item.alg === 'RS256')
  if (!jwk) throw new Error('QVeris signing key is unknown.')
  const valid = verify(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(encodedSignature, 'base64url'),
  )
  if (!valid) throw new Error('ID token signature is invalid.')
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (payload.iss !== issuer || !audiences.includes(clientId)) throw new Error('ID token issuer or audience is invalid.')
  const now = Date.now()
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now) throw new Error('ID token has expired.')
  if (payload.nbf && payload.nbf * 1000 > now + 60000) throw new Error('ID token is not active.')
  if (!Number.isFinite(payload.iat) || payload.iat * 1000 > now + 60000) throw new Error('ID token issued-at time is invalid.')
  if (!safeEqual(payload.nonce, nonce) || payload.token_use !== 'id') throw new Error('ID token nonce or type is invalid.')
  if (payload.app_access?.client_id !== clientId || payload.app_access?.status !== 'active') throw new Error('Application access is not active.')
  return payload
}

export function createAuthRuntime({
  authBaseUrl,
  clientId,
  clientSecret,
  redirectUri,
  resource,
  scopes = 'openid profile email',
  sessionSecret,
  secureCookie = false,
}) {
  const normalizedAuthBaseUrl = String(authBaseUrl || '').replace(/\/$/, '')
  const accountResource = resource || `${normalizedAuthBaseUrl}/account`
  const metadataCache = { value: null, expires: 0 }
  const jwksCache = { value: null, expires: 0 }
  const internalToken = randomToken()
  const cookieName = 'options_session'
  const transactionCookieName = 'options_oauth_tx'

  const required = () => {
    if (!normalizedAuthBaseUrl || !clientId || !clientSecret || !redirectUri || !accountResource || !sessionSecret) {
      throw new Error('QVeris OAuth is not fully configured.')
    }
    if (sessionSecret.length < 32) throw new Error('QVERIS_OAUTH_SESSION_SECRET must contain at least 32 characters.')
    if (!String(scopes).split(/\s+/).includes('openid')) throw new Error('QVERIS_OAUTH_SCOPES must include openid.')
    if (secureCookie && new URL(normalizedAuthBaseUrl).protocol !== 'https:') {
      throw new Error('QVERIS_AUTH_BASE_URL must use HTTPS when secure cookies are enabled.')
    }
    if (secureCookie && new URL(redirectUri).protocol !== 'https:') {
      throw new Error('QVERIS_OAUTH_REDIRECT_URI must use HTTPS when secure cookies are enabled.')
    }
  }

  const cookie = (name, value, maxAge, path) => `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`
  const sessionCookie = (id, maxAge) => cookie(cookieName, id, maxAge, '/')
  const transactionCookie = (value, maxAge = Math.floor(transactionTtlMs / 1000)) => cookie(transactionCookieName, value, maxAge, '/auth/callback')

  function createSignedPayload(kind, value) {
    const payload = base64url(JSON.stringify({ kind, ...value }))
    const signature = base64url(createHmac('sha256', sessionSecret).update(payload).digest())
    return `${payload}.${signature}`
  }

  function readSignedPayload(value, expectedKind) {
    const [payload, signature] = String(value || '').split('.')
    if (!payload || !signature) return null
    const expected = base64url(createHmac('sha256', sessionSecret).update(payload).digest())
    if (!safeEqual(signature, expected)) return null
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      return decoded.kind === expectedKind && decoded.exp > Date.now() ? decoded : null
    } catch {
      return null
    }
  }

  async function metadata() {
    if (metadataCache.value && metadataCache.expires > Date.now()) return metadataCache.value
    const response = await fetch(`${normalizedAuthBaseUrl}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error('Unable to load QVeris discovery metadata.')
    metadataCache.value = validateMetadata(
      await readJsonResponse(response, 'QVeris discovery metadata is unreadable.'),
      normalizedAuthBaseUrl,
    )
    metadataCache.expires = Date.now() + metadataTtlMs
    return metadataCache.value
  }

  function currentUser(req) {
    if (req.headers['x-options-internal-token'] === internalToken) return { sub: 'system-prewarm', internal: true }
    return readSignedPayload(parseCookies(req)[cookieName], 'session')?.user || null
  }

  async function handle(req, res, url, json) {
    if (url.pathname === '/api/auth/login-url' && req.method === 'GET') {
      res.setHeader('cache-control', 'no-store')
      res.setHeader('pragma', 'no-cache')
      try {
        required()
        const discovery = await metadata()
        const state = randomToken()
        const nonce = randomToken()
        const verifier = randomToken(48)
        const challenge = base64url(createHash('sha256').update(verifier).digest())
        const transaction = createSignedPayload('transaction', {
          state,
          nonce,
          verifier,
          exp: Date.now() + transactionTtlMs,
        })
        res.setHeader('set-cookie', transactionCookie(transaction))
        const params = new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: scopes,
          resource: accountResource,
          state,
          nonce,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })
        json(res, 200, {
          authorizeUrl: `${discovery.authorization_endpoint}?${params}`,
          registerUrl: `${normalizedAuthBaseUrl}/sign-up`,
        })
      } catch (error) {
        json(res, 500, { error: error.message })
      }
      return true
    }

    if (url.pathname === '/auth/callback' && req.method === 'GET') {
      const clearTransaction = transactionCookie('', 0)
      const transaction = readSignedPayload(parseCookies(req)[transactionCookieName], 'transaction')
      const state = url.searchParams.get('state') || ''
      if (!transaction || !safeEqual(transaction.state, state)) {
        redirect(res, '/?auth_error=invalid_state', [clearTransaction])
        return true
      }
      if (url.searchParams.get('error')) {
        redirect(res, `/?auth_error=${publicAuthError(url.searchParams.get('error'))}`, [clearTransaction])
        return true
      }
      try {
        const code = url.searchParams.get('code')
        if (!code) throw new Error('Authorization code is missing.')
        const discovery = await metadata()
        const response = await fetch(discovery.token_endpoint, {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            code_verifier: transaction.verifier,
          }),
        })
        const tokens = await readJsonResponse(response, 'QVeris token response is unreadable.')
        if (!response.ok || !tokens.id_token || !tokens.access_token) {
          throw new Error(tokens?.error_description || 'QVeris token exchange failed.')
        }
        const claims = await verifyIdToken(tokens.id_token, {
          clientId,
          issuer: discovery.issuer,
          jwksUri: discovery.jwks_uri,
          nonce: transaction.nonce,
          jwksCache,
        })
        const userinfoResponse = await fetch(discovery.userinfo_endpoint, {
          headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
        })
        const userinfo = await readJsonResponse(userinfoResponse, 'QVeris UserInfo response is unreadable.')
        if (!userinfoResponse.ok || userinfo.sub !== claims.sub) throw new Error('QVeris UserInfo validation failed.')
        if (userinfo.app_access?.client_id !== clientId || userinfo.app_access?.status !== 'active') {
          throw new Error('Application access is not active.')
        }
        const idTokenTtlSeconds = Math.floor((claims.exp * 1000 - Date.now()) / 1000)
        const tokenTtlSeconds = Math.max(
          1,
          Math.min(
            Number(tokens.expires_in) || 3600,
            idTokenTtlSeconds,
            maximumSessionTtlMs / 1000,
          ),
        )
        const sessionId = createSignedPayload('session', {
          user: {
            sub: userinfo.sub,
            email: userinfo.email,
            name: userinfo.name,
            picture: userinfo.picture,
          },
          exp: Date.now() + tokenTtlSeconds * 1000,
        })
        redirect(res, '/', [sessionCookie(sessionId, tokenTtlSeconds), clearTransaction])
      } catch {
        redirect(res, '/?auth_error=authorization_failed', [clearTransaction])
      }
      return true
    }

    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      res.setHeader('cache-control', 'no-store')
      const user = currentUser(req)
      json(
        res,
        user && !user.internal ? 200 : 401,
        user && !user.internal
          ? { user, registerUrl: `${normalizedAuthBaseUrl}/sign-up` }
          : { error: 'Authentication required.', registerUrl: `${normalizedAuthBaseUrl}/sign-up` },
      )
      return true
    }

    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('cache-control', 'no-store')
      res.setHeader('set-cookie', sessionCookie('', 0))
      json(res, 200, { ok: true })
      return true
    }
    return false
  }

  return { currentUser, handle, internalToken }
}
