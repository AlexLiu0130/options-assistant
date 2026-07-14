export type AuthUser = { sub: string; email: string; name?: string; picture?: string }

export async function getCurrentUser(): Promise<{ user: AuthUser | null; registerUrl: string }> {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  return { user: response.ok ? body.user : null, registerUrl: body.registerUrl || 'https://qveris.ai/sign-up' }
}

export async function beginLogin() {
  const response = await fetch('/api/auth/login-url', { credentials: 'same-origin', cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.authorizeUrl) throw new Error(body.error || 'Unable to start QVeris login.')
  window.location.assign(body.authorizeUrl)
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
}
