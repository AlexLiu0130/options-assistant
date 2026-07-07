import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { GraduationCap, Briefcase, CandlestickChart, Search, Sparkles } from 'lucide-react'
import { isSupportedUnderlying } from '../core/supportedUnderlyings'
import { useT } from '../i18n'

function navigate(path: string) { window.location.hash = path }

const QUICK_TICKERS = ['NVDA', 'TSLA', 'AAPL', 'SPY', 'MU']

// Decorative product mockup: payoff-zone chart with a floating AI-brief card.
// All numbers are illustrative — nothing here fetches data.
function HeroVisual() {
  const { t } = useT()
  const h = t.home
  return (
    <div aria-hidden="true" className="home-hero-visual">
      <svg className="home-visual-chart" viewBox="0 0 480 420">
        <defs>
          <pattern height="48" id="hv-grid" patternUnits="userSpaceOnUse" width="48">
            <path d="M48 0H0V48" fill="none" stroke="var(--border)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect fill="url(#hv-grid)" height="420" opacity="0.6" rx="16" width="480" />

        {/* profit / loss zones */}
        <rect fill="var(--profit)" height="128" opacity="0.1" rx="8" width="244" x="216" y="72" />
        <rect fill="var(--loss)" height="104" opacity="0.08" rx="8" width="244" x="216" y="204" />
        <line stroke="var(--muted)" strokeDasharray="4 5" strokeWidth="1" opacity="0.4" x1="24" x2="460" y1="202" y2="202" />

        {/* small price sparkline */}
        <path
          d="M36,318 L60,300 L76,312 L96,282 L112,296 L134,262 L150,274 L172,244 L190,254 L212,224"
          fill="none" opacity="0.65" stroke="#2563eb" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"
        />

        {/* ascending projection dots (profit path) */}
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <circle cx={228 + i * 38} cy={188 - i * 22} fill="var(--profit)" key={`p${i}`} opacity="0.85" r="3.4" />
        ))}
        <circle cx="446" cy="66" fill="none" r="8" stroke="var(--profit)" strokeWidth="2" opacity="0.7" />

        {/* descending projection dots (loss path) */}
        {[0, 1, 2, 3, 4].map((i) => (
          <circle cx={244 + i * 42} cy={224 + i * 24} fill="var(--loss)" key={`l${i}`} opacity="0.75" r="3.2" />
        ))}
        <circle cx="440" cy="330" fill="none" r="8" stroke="var(--loss)" strokeWidth="2" opacity="0.6" />
      </svg>

      <span className="home-anno home-anno-blue" style={{ top: '14%', right: '-2%' }}>{h.mockBreakeven}</span>
      <span className="home-anno home-anno-chip profit" style={{ top: '44%', right: '6%', animationDelay: '0.8s' }}>Δ +0.45</span>
      <span className="home-anno home-anno-chip loss" style={{ bottom: '12%', right: '14%', animationDelay: '1.6s' }}>Θ −0.12</span>

      <div className="home-mock-card">
        <div className="home-mock-head">
          <span className="home-mock-ai"><Sparkles size={12} /></span>
          <strong>{h.mockTitle}</strong>
        </div>
        <span className="home-mock-label">{h.mockPosition}</span>
        <strong className="home-mock-strategy">{h.mockStrategy}</strong>
        <div className="home-mock-stats">
          <div><strong className="loss">$300</strong><span>{t.card.maxLoss}</span></div>
          <div><strong className="profit">$700</strong><span>{t.card.maxGain}</span></div>
          <div><strong>63%</strong><span>{t.card.pop}</span></div>
        </div>
        <span className="home-mock-bubble">{h.mockQ}</span>
        <p className="home-mock-answer">{h.mockA}</p>
        <span className="home-mock-bubble home-mock-bubble-soft">{h.mockAction}</span>
      </div>
    </div>
  )
}

export function HomePage() {
  const { t, lang, setLang } = useT()
  const h = t.home
  const [ticker, setTicker] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const tag = (event.target as HTMLElement)?.tagName
      if (event.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function go(value: string) {
    const v = value.trim().toUpperCase()
    if (!v) return
    if (!isSupportedUnderlying(v)) {
      setError(h.unsupported(v))
      return
    }
    setError('')
    navigate(`#/trade?ticker=${encodeURIComponent(v)}`)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    go(ticker)
  }

  const features = [
    { icon: <CandlestickChart size={20} />, title: h.featMarket, desc: h.featMarketDesc, color: '#0b7a3b', onClick: () => inputRef.current?.focus() },
    { icon: <GraduationCap size={20} />, title: h.featLearn, desc: h.featLearnDesc, color: '#2563eb', onClick: () => navigate('#/learn') },
    { icon: <Briefcase size={20} />, title: h.featPaper, desc: h.featPaperDesc, color: '#b45309', onClick: () => navigate('#/paper') },
  ]

  return (
    <main className="home-shell">
      <header className="home-topbar">
        <button className="oa-brand oa-brand-button" type="button" onClick={() => navigate('#/')} aria-label="Qveris home"><strong>Qveris</strong><span>AI</span></button>
        <div className="oa-top-spacer" />
        <div className="lang-toggle">
          <button className={lang === 'en' ? 'active' : ''} type="button" onClick={() => setLang('en')}>EN</button>
          <button className={lang === 'zh' ? 'active' : ''} type="button" onClick={() => setLang('zh')}>中</button>
        </div>
      </header>

      <section className="home-hero">
        <div className="home-hero-copy">
          <h1 className="home-anim" style={{ animationDelay: '0ms' }}>
            {h.headlinePre}<span className="home-headline-accent">{h.headlineAccent}</span>{h.headlinePost}
          </h1>
          <p className="home-anim" style={{ animationDelay: '80ms' }}>{h.subtext}</p>

          <form className="home-search home-anim" style={{ animationDelay: '160ms' }} onSubmit={submit}>
            <Search size={18} />
            <input
              aria-label="Search ticker"
              autoFocus
              onChange={(event) => {
                setTicker(event.target.value)
                if (error) setError('')
              }}
              placeholder={h.placeholder}
              ref={inputRef}
              value={ticker}
            />
            <kbd className="home-search-kbd">/</kbd>
            <button type="submit">{h.cta}</button>
          </form>
          {error ? <p className="home-search-error">{error}</p> : null}

          <div className="home-quick home-anim" style={{ animationDelay: '240ms' }}>
            <span>{h.tryLabel}</span>
            {QUICK_TICKERS.map((symbol) => (
              <button key={symbol} type="button" onClick={() => go(symbol)}>{symbol}</button>
            ))}
          </div>
        </div>

        <div className="home-anim home-hero-right" style={{ animationDelay: '200ms' }}>
          <HeroVisual />
        </div>
      </section>

      <section className="home-features home-anim" style={{ animationDelay: '320ms' }}>
        {features.map((f) => (
          <button
            className="home-feature-card"
            key={f.title}
            style={{ '--fc': f.color } as CSSProperties}
            type="button"
            onClick={f.onClick}
          >
            <span className="home-feature-icon">{f.icon}</span>
            <strong>{f.title}</strong>
            <p>{f.desc}</p>
          </button>
        ))}
      </section>

      <footer className="home-footer home-anim" style={{ animationDelay: '400ms' }}>{h.disclaimer}</footer>
    </main>
  )
}
