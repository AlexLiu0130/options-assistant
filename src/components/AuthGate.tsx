import { useEffect, useState } from 'react'
import { LogIn, LogOut, ShieldCheck } from 'lucide-react'
import { beginLogin, getCurrentUser, logout, type AuthUser } from '../core/authApi'

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined)
  const [registerUrl, setRegisterUrl] = useState('https://qveris.ai/sign-up')
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get('auth_error') || '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void getCurrentUser().then((result) => {
      setUser(result.user)
      setRegisterUrl(result.registerUrl)
    }).catch(() => setUser(null))
    if (new URLSearchParams(window.location.search).has('auth_error')) {
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`)
    }
  }, [])

  if (user === undefined) return <main className="auth-gate"><p>Checking QVeris session...</p></main>
  if (!user) {
    return (
      <main className="auth-gate">
        <section className="auth-panel">
          <span className="auth-mark"><ShieldCheck size={26} /></span>
          <p className="auth-kicker">OPTIONS ASSISTANT PRIVATE BETA</p>
          <h1>Sign in with QVeris</h1>
          <p>Use your qveris.ai account. Access is currently limited to invited users.</p>
          {error ? <p className="auth-error">{error}</p> : null}
          <button disabled={busy} onClick={() => {
            setBusy(true)
            setError('')
            void beginLogin().catch((reason) => { setError(reason.message); setBusy(false) })
          }} type="button"><LogIn size={17} />{busy ? 'Redirecting...' : 'Continue with QVeris'}</button>
          <a href={registerUrl}>No QVeris account? Create one</a>
        </section>
      </main>
    )
  }

  return <><div className="auth-user"><span>{user.name || user.email}</span><button aria-label="Sign out" onClick={() => void logout().then(() => setUser(null))} title="Sign out" type="button"><LogOut size={15} /></button></div>{children}</>
}
