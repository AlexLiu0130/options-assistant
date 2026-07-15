import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  Briefcase,
  GraduationCap,
  LineChart,
  MoreHorizontal,
  RotateCcw,
  Search,
  Moon,
  Sun,
  Waves,
  Zap,
} from 'lucide-react'
import { AssistantExplanationPanel } from './components/AssistantExplanationPanel'
import { AuthGate } from './components/AuthGate'
import { AssistantBot } from './components/AssistantBot'
import { HomePage } from './components/HomePage'
import { OptionChainTable } from './components/OptionChainTable'
import { StrategyCard } from './components/StrategyCard'
import type { AssistantStructuredUpdates } from './core/assistantPolicy'
import type { ActiveSimulatorState } from './core/simulatorChartEngine'
import { optionExpirations } from './core/dashboardData'
import { selectDefaultExpiration } from './core/expirationEngine'
import { parseUserView } from './core/parseUserView'
import { recordProductEvent } from './core/productEventsApi'
import { recommendStrategyTypes } from './core/strategyRecommendationEngine'
import { isSupportedUnderlying } from './core/supportedUnderlyings'
import { useT } from './i18n'
import type { QverisMarketSnapshot, QverisOptionsResponse } from './types/optionTypes'
import type { Direction, ExperienceLevel, StrategyCandidate, Strength } from './types/strategyTypes'
import './App.css'

const PaperPortfolioPage = lazy(() =>
  import('./components/PaperPortfolioPage').then((module) => ({ default: module.PaperPortfolioPage })),
)
const StrategyEducationPage = lazy(() =>
  import('./components/StrategyEducationPage').then((module) => ({ default: module.StrategyEducationPage })),
)
const AdminDashboardPage = lazy(() =>
  import('./components/AdminDashboardPage').then((module) => ({ default: module.AdminDashboardPage })),
)
const UnderlyingPriceChart = lazy(() =>
  import('./components/UnderlyingPriceChart').then((module) => ({ default: module.UnderlyingPriceChart })),
)

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return hash
}

function navigate(path: string) { window.location.hash = path }

type LoadState<T> = {
  data?: T
  error?: string
}

type FormState = {
  ticker: string
  prompt: string
  view: Direction
  strength: Strength
  time_horizon: string
  target_price: string
  risk_budget: string
  owns_shares: boolean
  shares_count: string
  willing_to_be_assigned: boolean
  experience_level: ExperienceLevel
}

type PriceRange = '15m' | '30m' | '1h' | '4h' | '1d'
type StrategyFilter = Direction | 'all'
const lastTickerKey = 'qveris-last-ticker'
const fetchCache = new Map<string, { expires: number; data: unknown }>()
const fetchInflight = new Map<string, Promise<unknown>>()
const fetchCacheMs = 60000
const quotePollMs = 5000
const marketPollMs = 60000
const optionsPollMs = 60000

const initialForm: FormState = {
  ticker: '',
  prompt: '',
  view: 'bullish',
  strength: 'moderate',
  time_horizon: '1 month',
  target_price: '',
  risk_budget: '',
  owns_shares: false,
  shares_count: '',
  willing_to_be_assigned: false,
  experience_level: 'beginner',
}

async function fetchJson<T>(path: string, options: { force?: boolean; persist?: boolean } = {}): Promise<T> {
  const hit = fetchCache.get(path)
  if (!options.force && hit && hit.expires > Date.now()) return hit.data as T
  if (!options.force) {
    try {
      const stored = JSON.parse(localStorage.getItem(`qveris:${path}`) || 'null')
      if (stored?.expires > Date.now()) return stored.data as T
    } catch {}
  }
  if (fetchInflight.has(path)) return fetchInflight.get(path) as Promise<T>
  const run = fetch(path)
    .then(async (response) => {
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || `Request failed: ${path}`)
      fetchCache.set(path, { data: body, expires: Date.now() + fetchCacheMs })
      if (options.persist) {
        try {
          localStorage.setItem(`qveris:${path}`, JSON.stringify({ data: body, expires: Date.now() + fetchCacheMs }))
        } catch {}
      }
      return body as T
    })
    .finally(() => fetchInflight.delete(path))
  fetchInflight.set(path, run)
  return run
}

function numberOrUndefined(value: string) {
  const number = Number(value)
  return Number.isFinite(number) && value.trim() ? number : undefined
}

function formatMoney(value?: number | null) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Pending'
  return `$${value.toFixed(2)}`
}

function formatPct(value?: number | null) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Pending'
  return `${value.toFixed(2)}%`
}

function dataIssueMessages({ market, options }: { market: LoadState<QverisMarketSnapshot>; options: LoadState<QverisOptionsResponse> }) {
  return [
    market.error ? `QVERIS_MARKET_ERROR: ${market.error}` : '',
    options.error ? `QVERIS_OPTIONS_ERROR: ${options.error}` : '',
    ...(options.data?.status !== 'available' && options.data?.message ? [options.data.message] : []),
    ...(options.data?.dataGaps ?? []),
  ].filter(Boolean)
}

function DataStatusChips({
  market,
  options,
  lang,
  pulseKey,
}: {
  market: LoadState<QverisMarketSnapshot>
  options: LoadState<QverisOptionsResponse>
  lang: 'en' | 'zh'
  pulseKey: number
}) {
  const chips = [
    market.data
      ? (lang === 'zh' ? '行情已更新' : 'Market updated')
      : market.error
        ? (lang === 'zh' ? '行情失败' : 'Market failed')
        : (lang === 'zh' ? '行情加载中' : 'Market loading'),
    options.data?.status === 'available'
      ? (lang === 'zh' ? '期权链可用' : 'Chain available')
      : options.error
        ? (lang === 'zh' ? '期权链失败' : 'Chain failed')
        : (lang === 'zh' ? '期权链加载中' : 'Chain loading'),
    options.data?.contracts.some((c) => typeof c.openInterest === 'number')
      ? (lang === 'zh' ? 'OI 日更' : 'OI daily')
      : '',
    options.data?.contracts.some((c) => typeof c.delta === 'number')
      ? (lang === 'zh' ? 'Greeks 链路' : 'Greeks in chain')
      : (lang === 'zh' ? 'Greeks 模型' : 'Greeks model'),
  ].filter(Boolean)

  return (
    <div className="data-status-chips" aria-label={lang === 'zh' ? '数据状态' : 'Data status'} key={pulseKey}>
      {chips.map((chip) => <span key={chip}>{chip}</span>)}
    </div>
  )
}

const directionCardDefs: Array<{ value: Direction; key: 'bullish' | 'neutral' | 'bearish' | 'volatile'; icon: typeof ArrowUpRight }> = [
  { value: 'bullish', key: 'bullish', icon: ArrowUpRight },
  { value: 'neutral', key: 'neutral', icon: Waves },
  { value: 'bearish', key: 'bearish', icon: ArrowDownRight },
  { value: 'volatile', key: 'volatile', icon: Zap },
]

const priceRanges: PriceRange[] = ['15m', '30m', '1h', '4h', '1d']

function priceRangeLabel(range: PriceRange) {
  if (range === '15m') return '15min'
  if (range === '30m') return '30min'
  return range
}

function saveLastTicker(ticker: string) {
  try { localStorage.setItem(lastTickerKey, ticker) } catch {}
}

function lastTradePath(fallback?: string) {
  try {
    const ticker = (fallback || localStorage.getItem(lastTickerKey) || '').trim().toUpperCase()
    return ticker ? `#/trade?ticker=${encodeURIComponent(ticker)}` : '#/trade'
  } catch {
    return fallback ? `#/trade?ticker=${encodeURIComponent(fallback)}` : '#/trade'
  }
}

function shortDate(value: string) {
  if (!value) return 'Pending'
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return 'Pending'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function normalizeDirection(value?: string): Direction | undefined {
  if (value === 'bullish' || value === 'bearish' || value === 'neutral' || value === 'volatile') return value
  return undefined
}

function normalizeStrength(value?: string): Strength | undefined {
  if (value === 'mild' || value === 'moderate' || value === 'strong') return value
  return undefined
}

function normalizeExperience(value?: string): ExperienceLevel | undefined {
  if (value === 'beginner' || value === 'intermediate' || value === 'advanced') return value
  return undefined
}

function AuthenticatedApp() {
  const { t } = useT()
  const hash = useHash()
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { return localStorage.getItem('qveris-theme') === 'dark' ? 'dark' : 'light' } catch { return 'light' }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('qveris-theme', theme) } catch {}
  }, [theme])
  const toggleTheme = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  if (hash === '#/paper') {
    return <Suspense fallback={<div className="app-loading">{t.builder.pending}</div>}><PaperPortfolioPage theme={theme} onToggleTheme={toggleTheme} /></Suspense>
  }
  if (hash === '#/learn') {
    return <Suspense fallback={<div className="app-loading">{t.builder.pending}</div>}><StrategyEducationPage theme={theme} onToggleTheme={toggleTheme} /></Suspense>
  }
  if (hash === '#/admin') {
    return <Suspense fallback={<div className="app-loading">{t.builder.pending}</div>}><AdminDashboardPage theme={theme} onToggleTheme={toggleTheme} /></Suspense>
  }
  if (hash.startsWith('#/trade')) {
    const params = new URLSearchParams(hash.split('?')[1] ?? '')
    return <TradingPage initialTicker={(params.get('ticker') ?? '').trim().toUpperCase()} theme={theme} onToggleTheme={toggleTheme} />
  }

  return <HomePage theme={theme} onToggleTheme={toggleTheme} />
}

function App() {
  return <AuthGate><AuthenticatedApp /></AuthGate>
}

function TradingPage({ initialTicker, theme, onToggleTheme }: { initialTicker: string; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const { t, lang, setLang } = useT()
  const [startForm] = useState<FormState>(() => ({
    ...initialForm,
    ticker: initialTicker,
    prompt: initialTicker ? `I am moderately bullish on ${initialTicker} for the next month.` : '',
  }))
  const [form, setForm] = useState<FormState>(startForm)
  const [submitted, setSubmitted] = useState<FormState>(startForm)
  const [profileApplied, setProfileApplied] = useState(false)
  const [priceRange, setPriceRange] = useState<PriceRange>('1h')
  const [selectedExpiration, setSelectedExpiration] = useState<string>()
  const [expirationTouched, setExpirationTouched] = useState(false)
  const [chainExpiration, setChainExpiration] = useState<string>()
  const [strategyFilter, setStrategyFilter] = useState<StrategyFilter>(initialForm.view)
  const [selectedStrategyId, setSelectedStrategyId] = useState<string>()
  const [activeSimulator, setActiveSimulator] = useState<ActiveSimulatorState>()
  const [dataPulse, setDataPulse] = useState(0)
  const [strategyOverrides, setStrategyOverrides] = useState<Record<string, StrategyCandidate>>({})
  const ticker = submitted.ticker.trim().toUpperCase()
  const unsupportedTicker = Boolean(ticker && !isSupportedUnderlying(ticker))
  const [market, setMarket] = useState<LoadState<QverisMarketSnapshot>>({})
  const [options, setOptions] = useState<LoadState<QverisOptionsResponse>>({})
  const recordedDataFailures = useRef(new Set<string>())
  const dataIssues = dataIssueMessages({ market, options })

  useEffect(() => {
    recordedDataFailures.current.clear()
    if (ticker && !unsupportedTicker) saveLastTicker(ticker)
  }, [ticker, unsupportedTicker])

  const recordDataFailure = useCallback((errorCategory: 'QVERIS_MARKET_ERROR' | 'QVERIS_OPTIONS_ERROR') => {
    const key = `${ticker}:${errorCategory}`
    if (recordedDataFailures.current.has(key)) return
    recordedDataFailures.current.add(key)
    recordProductEvent({ eventName: 'data_request_failed', ticker, errorCategory })
  }, [ticker])

  useEffect(() => {
    if (!ticker || unsupportedTicker) { setMarket({}); return }
    let cancelled = false
    const load = () => fetchJson<QverisMarketSnapshot>(`/api/market/${ticker}?range=${priceRange}`, { force: true })
      .then((data) => { if (!cancelled) { setMarket({ data }); setDataPulse((n) => n + 1) } })
      .catch((error: Error) => { if (!cancelled) { setMarket({ error: error.message }); recordDataFailure('QVERIS_MARKET_ERROR') } })
    setMarket({})
    void load()
    const timer = window.setInterval(() => void load(), marketPollMs)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [priceRange, ticker, unsupportedTicker, recordDataFailure])

  useEffect(() => {
    if (!ticker || unsupportedTicker) return
    let cancelled = false
    const load = () => fetchJson<QverisMarketSnapshot>(`/api/quote/${ticker}`, { force: true })
      .then((quote) => {
        if (cancelled) return
        setMarket((current) => ({ data: { ...current.data, ...quote, candles: current.data?.candles ?? quote.candles } }))
        setDataPulse((n) => n + 1)
      })
      .catch(() => {})
    void load()
    const timer = window.setInterval(() => void load(), quotePollMs)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [ticker, unsupportedTicker])

  useEffect(() => {
    if (!ticker || unsupportedTicker) { setOptions({}); return }
    let cancelled = false
    const load = () => fetchJson<QverisOptionsResponse>(`/api/options/${ticker}`, { force: true })
      .then((data) => { if (!cancelled) { setOptions({ data }); setDataPulse((n) => n + 1) } })
      .catch((error: Error) => { if (!cancelled) { setOptions({ error: error.message }); recordDataFailure('QVERIS_OPTIONS_ERROR') } })
    setOptions({})
    void load()
    const timer = window.setInterval(() => void load(), optionsPollMs)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [ticker, unsupportedTicker, recordDataFailure])

  useEffect(() => {
    setStrategyOverrides({})
  }, [selectedExpiration, ticker])

  const displayedMarket = market.data
    ? {
        ...market.data,
        candles: market.data.candles?.length ? market.data.candles : options.data?.market?.candles,
      }
    : options.data?.market
  const chartMarket = displayedMarket?.candles?.length ? displayedMarket : undefined

  // Fallback: estimate price from deep-ITM calls when market data is unavailable
  const chainPrice = useMemo(() => {
    const chain = options.data
    if (!chain?.contracts.length) return undefined
    const estimates = chain.contracts
      .filter(c => c.right === 'call' && typeof c.delta === 'number' && (c.delta as number) > 0.95
        && typeof c.strike === 'number'
        && typeof c.bid === 'number' && typeof c.ask === 'number'
        && (c.bid as number) > 0 && (c.ask as number) > (c.bid as number))
      .map(c => (c.strike as number) + ((c.bid as number) + (c.ask as number)) / 2)
    return estimates.length ? Math.round(estimates.reduce((s, v) => s + v, 0) / estimates.length) : undefined
  }, [options.data])

  const parsedView = useMemo(
    () =>
      parseUserView({
        ticker,
        current_price: displayedMarket?.price ?? chainPrice ?? 0,
        view: submitted.view,
        strength: submitted.strength,
        time_horizon: submitted.time_horizon,
        target_price: numberOrUndefined(submitted.target_price),
        risk_budget: numberOrUndefined(submitted.risk_budget),
        owns_shares: submitted.owns_shares,
        shares_count: numberOrUndefined(submitted.shares_count),
        willing_to_be_assigned: submitted.willing_to_be_assigned,
        experience_level: submitted.experience_level,
      }),
    [displayedMarket?.price, chainPrice, submitted, ticker],
  )

  const chainExpirations = useMemo(() => optionExpirations(options.data?.contracts ?? []), [options.data])
  const strategyExpirationOverride = selectedExpiration
  const strategies = useMemo(() => {
    if (strategyFilter !== 'all') {
      return recommendStrategyTypes({ ...parsedView, view: strategyFilter }, options.data, strategyExpirationOverride, { rank: profileApplied })
    }
    const seen = new Set<string>()
    return (['bullish', 'neutral', 'bearish', 'volatile'] as Direction[])
      .flatMap((direction) =>
        recommendStrategyTypes({ ...parsedView, view: direction }, options.data, strategyExpirationOverride, { rank: profileApplied }),
      )
      .filter((strategy) => {
        if (seen.has(strategy.id)) return false
        seen.add(strategy.id)
        return true
      })
  }, [options.data, parsedView, profileApplied, strategyExpirationOverride, strategyFilter])
  const selectedBaseStrategy = selectedStrategyId ? strategies.find((strategy) => strategy.id === selectedStrategyId) : undefined
  const selectedStrategy = selectedBaseStrategy ? (strategyOverrides[selectedBaseStrategy.id] ?? selectedBaseStrategy) : undefined
  const selectedProjection =
    activeSimulator && activeSimulator.strategyId === selectedStrategy?.id ? activeSimulator.projection : undefined
  const referenceStrategy = selectedStrategy ?? strategies[0]

  useEffect(() => {
    if (!chainExpirations.length) {
      setSelectedExpiration(undefined)
      setExpirationTouched(false)
      setChainExpiration(undefined)
      return
    }
    const defaultExpiration = selectDefaultExpiration(chainExpirations, parsedView)
    if (!expirationTouched || !selectedExpiration || !chainExpirations.includes(selectedExpiration)) {
      setSelectedExpiration(defaultExpiration)
      if (expirationTouched && selectedExpiration && !chainExpirations.includes(selectedExpiration)) setExpirationTouched(false)
    }
    setChainExpiration((cur) => (cur && chainExpirations.includes(cur) ? cur : selectDefaultExpiration(chainExpirations, parsedView)))
  }, [chainExpirations, expirationTouched, parsedView, selectedExpiration])

  useEffect(() => {
    if (!strategies.length) {
      setSelectedStrategyId(undefined)
      return
    }
    if (selectedStrategyId && !strategies.some((strategy) => strategy.id === selectedStrategyId)) {
      setSelectedStrategyId(undefined)
    }
  }, [selectedStrategyId, strategies])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function updatePreference<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function unappliedProfile(current: FormState): FormState {
    return { ...current, risk_budget: '', willing_to_be_assigned: false, experience_level: 'beginner' }
  }

  function applyProfile() {
    setProfileApplied(true)
    setSubmitted((current) => ({ ...current, ...form, ticker: form.ticker.trim().toUpperCase() }))
  }

  function clearProfile() {
    setProfileApplied(false)
    setSubmitted((current) => unappliedProfile(current))
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const next = { ...form, ticker: form.ticker.trim().toUpperCase() }
    if (next.ticker) {
      navigate(lastTradePath(next.ticker))
      if (isSupportedUnderlying(next.ticker)) {
        recordProductEvent({
          eventName: 'ticker_searched',
          ticker: next.ticker,
          properties: { source: 'topbar', page: 'trade' },
        })
      }
    }
    setSubmitted(profileApplied ? next : unappliedProfile(next))
  }

  function selectDirection(direction: Direction) {
    setStrategyFilter(direction)
    setForm((current) => ({ ...current, view: direction }))
    setSubmitted((current) => ({ ...current, view: direction }))
  }

  function applyAssistantUpdates(updates: AssistantStructuredUpdates) {
    const direction = normalizeDirection(updates.direction)
    const strength = normalizeStrength(updates.strength)
    const experience = normalizeExperience(updates.experienceLevel)
    const patch: Partial<FormState> = {
      ...(updates.ticker ? { ticker: updates.ticker } : {}),
      ...(direction ? { view: direction } : {}),
      ...(strength ? { strength } : {}),
      ...(updates.horizon ? { time_horizon: updates.horizon } : {}),
      ...(typeof updates.riskBudget === 'number' ? { risk_budget: String(updates.riskBudget) } : {}),
      ...(typeof updates.targetPrice === 'number' ? { target_price: String(updates.targetPrice) } : {}),
      ...(typeof updates.ownsShares === 'boolean' ? { owns_shares: updates.ownsShares } : {}),
      ...(typeof updates.sharesCount === 'number' ? { shares_count: String(updates.sharesCount) } : {}),
      ...(typeof updates.willingToBeAssigned === 'boolean'
        ? { willing_to_be_assigned: updates.willingToBeAssigned }
        : {}),
      ...(experience ? { experience_level: experience } : {}),
    }
    if (!Object.keys(patch).length) return
    if (direction) setStrategyFilter(direction)
    setForm((current) => ({ ...current, ...patch }))
    setSubmitted((current) => ({
      ...current,
      ...patch,
      ticker: (patch.ticker ?? current.ticker).trim().toUpperCase(),
    }))
  }

  function updateAdjustedStrategy(baseId: string, adjusted: StrategyCandidate) {
    setStrategyOverrides((current) => ({ ...current, [baseId]: adjusted }))
    setSelectedStrategyId(baseId)
    const expiry = adjusted.legs[0]?.expiration
    if (expiry) setChainExpiration(expiry)
  }

  return (
    <main className="oa-shell">
      <header className="oa-topbar">
        <button className="oa-brand oa-brand-button" type="button" onClick={() => navigate('#/')} aria-label="Qveris home">
          <strong>Qveris</strong>
          <span>AI</span>
        </button>
        <div className="oa-top-spacer" />
        <button className="theme-toggle" type="button" onClick={onToggleTheme} aria-label="Toggle dark mode">
          {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        <div className="lang-toggle">
          <button className={lang === 'en' ? 'active' : ''} type="button" onClick={() => setLang('en')}>EN</button>
          <button className={lang === 'zh' ? 'active' : ''} type="button" onClick={() => setLang('zh')}>中</button>
        </div>
        <form className="oa-search" onSubmit={submit}>
          <Search size={19} />
          <input
            aria-label="Search ticker"
            value={form.ticker}
            onChange={(event) => update('ticker', event.target.value)}
            placeholder={t.topbar.searchPlaceholder}
          />
        </form>
      </header>

      <aside className="oa-rail">
        <button className="active" type="button" title={t.nav.trade} onClick={() => navigate(lastTradePath(ticker))}><LineChart size={20} /></button>
        <button type="button" title={t.nav.learn} onClick={() => navigate('#/learn')}><GraduationCap size={20} /></button>
        <button type="button" title={t.nav.paper} onClick={() => navigate('#/paper')}><Briefcase size={20} /></button>
      </aside>

      {!ticker || unsupportedTicker ? (
        <section className="oa-trade-empty">
          <Search size={32} />
          <h2>{unsupportedTicker ? t.tradeEmpty.unsupportedTitle : t.tradeEmpty.title}</h2>
          <p>{unsupportedTicker ? t.tradeEmpty.unsupportedSubtitle(ticker) : t.tradeEmpty.subtitle}</p>
        </section>
      ) : (
      <>
      <section className="oa-trade-page">
        <section className="oa-left-pane">
          <div className="asset-header">
            <div className="asset-logo">{ticker.slice(0, 1)}</div>
            <div>
              <h1>{ticker}</h1>
              <span>{ticker === 'NVDA' ? 'NVIDIA Corporation' : 'US Equity'}</span>
            </div>
            <div className="asset-price">
              <strong>{formatMoney(displayedMarket?.price)}</strong>
              <em className={(displayedMarket?.change ?? 0) >= 0 ? 'profit' : 'loss'}>
                {formatMoney(displayedMarket?.change)} ({formatPct(displayedMarket?.changePercent)})
              </em>
            </div>
          </div>

          <div className="range-row">
            {priceRanges.map((range) => (
              <button
                className={range === priceRange ? 'active' : ''}
                key={range}
                onClick={() => setPriceRange(range)}
                type="button"
              >
                {priceRangeLabel(range)}
              </button>
            ))}
            <span>
              {shortDate(selectedExpiration ?? chainExpirations[0] ?? '')} Expected Move:{' '}
              {referenceStrategy?.expectedMove
                ? `${formatPct(referenceStrategy.expectedMove.impliedVolatility * Math.sqrt(referenceStrategy.expectedMove.dte / 365) * 100)}`
                : 'Pending'}
            </span>
            <b className="profit">{formatMoney(referenceStrategy?.expectedMove?.high)}</b>
            <b className="loss">{formatMoney(referenceStrategy?.expectedMove?.low)}</b>
          </div>

          <DataStatusChips market={market} options={options} lang={lang} pulseKey={dataPulse} />

          <section className="oa-chart-card">
            <Suspense fallback={<div className="chart-skeleton" aria-label={t.chart.loadingCandles} />}>
              <UnderlyingPriceChart
                market={chartMarket}
                isLoadingCandles={!chartMarket && !market.error}
                selectedStrategy={selectedStrategy}
                simulatorProjection={selectedProjection}
              />
            </Suspense>
          </section>

          <div className="chain-toolbar">
            <select
              className="expiry-select"
              value={chainExpiration ?? ''}
              onChange={(e) => setChainExpiration(e.target.value)}
              aria-label="Chain expiration"
            >
              {chainExpirations.map((exp) => (
                <option key={exp} value={exp}>{shortDate(exp)}</option>
              ))}
            </select>
            <button type="button">{selectedStrategy?.name ?? 'Select Strategy'}</button>
            {selectedStrategy?.legs.map((leg, index) => (
              <button className={leg.action === 'buy' ? 'buy-chip' : 'sell-chip'} key={`${leg.action}-${leg.symbol}-${index}`} type="button">
                {leg.action} {leg.strike} {leg.right}
              </button>
            ))}
            <span />
            <button type="button">Buy Stock</button>
            <button type="button">Price Alerts</button>
          </div>

          <section className="oa-chain-card">
            <OptionChainTable
              contracts={options.data?.contracts ?? []}
              expiration={chainExpiration}
              isLoading={!options.data && !options.error}
              error={options.error}
              status={options.data?.status}
              underlyingPrice={displayedMarket?.price ?? undefined}
              selectedStrategy={selectedStrategy}
            />
          </section>
        </section>

        <aside className="oa-builder">
          <div className="builder-title">
            <div>
              <span className="builder-icon"><ArrowUpRight size={17} /></span>
              <h2>{t.builder.title}</h2>
            </div>
            <button type="button">{t.builder.reset} <RotateCcw size={14} /></button>
          </div>

          <div className="expiry-tabs">
            <select
              className="expiry-select"
              value={selectedExpiration ?? ''}
              onChange={(e) => {
                setSelectedExpiration(e.target.value)
                setExpirationTouched(true)
              }}
              aria-label="Strategy expiration"
            >
              {chainExpirations.map((exp) => (
                <option key={exp} value={exp}>{shortDate(exp)}</option>
              ))}
            </select>
          </div>

          <div className="direction-cards">
            {directionCardDefs.map(({ value, key, icon: Icon }) => (
              <button
                className={`dir-${value}${value === strategyFilter ? ' active' : ''}`}
                key={value}
                onClick={() => selectDirection(value)}
                type="button"
              >
                <span><Icon size={20} /></span>
                {t.direction[key]}
              </button>
            ))}
            <button
              className={`dir-all${strategyFilter === 'all' ? ' active' : ''}`}
              onClick={() => setStrategyFilter('all')}
              type="button"
            >
              <span><MoreHorizontal size={20} /></span>{t.direction.all}
            </button>
          </div>

          <details className="preference-panel">
            <summary className="preference-summary">
              <span>{lang === 'zh' ? '推荐设置' : 'Recommendation settings'}</span>
              <em>
                {profileApplied
                  ? `${form.risk_budget ? `$${Number(form.risk_budget).toLocaleString('en-US')}` : (lang === 'zh' ? '预算待填' : 'No budget')} · ${
                      lang === 'zh'
                        ? ({ beginner: '新手', intermediate: '进阶', advanced: '熟练' }[form.experience_level])
                        : form.experience_level
                    } · ${
                      form.willing_to_be_assigned
                        ? (lang === 'zh' ? '可指派' : 'Assignment OK')
                        : (lang === 'zh' ? '不接受指派' : 'No assignment')
                    }`
                  : (lang === 'zh' ? '未设置画像 · 展示全部策略' : 'No profile · show all strategies')}
              </em>
            </summary>
            <div className="preference-strip" aria-label={lang === 'zh' ? '推荐偏好' : 'Recommendation preferences'}>
              <label className="preference-field">
                <span>{lang === 'zh' ? '风险预算' : 'Risk budget'}</span>
                <input
                  inputMode="decimal"
                  min="0"
                  onChange={(event) => updatePreference('risk_budget', event.target.value)}
                  placeholder="500"
                  type="number"
                  value={form.risk_budget}
                />
              </label>
              <label className="preference-field">
                <span>{lang === 'zh' ? '期权经验' : 'Options level'}</span>
                <select
                  onChange={(event) => updatePreference('experience_level', event.target.value as ExperienceLevel)}
                  value={form.experience_level}
                >
                  <option value="beginner">{lang === 'zh' ? '新手' : 'Beginner'}</option>
                  <option value="intermediate">{lang === 'zh' ? '进阶' : 'Intermediate'}</option>
                  <option value="advanced">{lang === 'zh' ? '熟练' : 'Advanced'}</option>
                </select>
              </label>
              <label className="preference-check">
                <input
                  checked={form.willing_to_be_assigned}
                  onChange={(event) => updatePreference('willing_to_be_assigned', event.target.checked)}
                  type="checkbox"
                />
                <span>{lang === 'zh' ? '可接受指派' : 'Assignment OK'}</span>
              </label>
              <div className="preference-actions">
                <button type="button" onClick={applyProfile}>{lang === 'zh' ? '应用画像排序' : 'Apply profile ranking'}</button>
                <button type="button" onClick={clearProfile}>{lang === 'zh' ? '不使用画像' : 'Show all'}</button>
              </div>
            </div>
          </details>

          <AssistantExplanationPanel
            dataGaps={dataIssues}
            parsedView={parsedView}
            strategy={referenceStrategy}
            ticker={ticker}
            underlyingPrice={displayedMarket?.price ?? undefined}
          />

          <div className="candidate-list" data-view={strategyFilter}>
            {strategies.map((strategy) => (
              <StrategyCard
                key={strategy.id}
                onSelect={(item) => setSelectedStrategyId((current) => (current === item.id ? undefined : item.id))}
                onProjectionChange={setActiveSimulator}
                onAdjusted={updateAdjustedStrategy}
                onPaperOrderFilled={() => {}}
                selected={strategy.id === selectedStrategy?.id}
                strategy={strategy}
                ticker={ticker}
                underlyingPrice={displayedMarket?.price ?? undefined}
                optionChain={options.data}
                parsedView={parsedView}
              />
            ))}
          </div>
        </aside>
      </section>
      <AssistantBot
        market={displayedMarket}
        onStructuredUpdates={applyAssistantUpdates}
        options={options.data}
        parsedView={parsedView}
        selectedStrategy={selectedStrategy}
        strategies={strategies}
        ticker={ticker}
      />
      </>
      )}
    </main>
  )
}

export default App
