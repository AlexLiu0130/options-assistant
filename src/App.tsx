import { useEffect, useMemo, useState } from 'react'
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
  Sun,
  Waves,
  Zap,
} from 'lucide-react'
import { AssistantExplanationPanel } from './components/AssistantExplanationPanel'
import { AssistantBot } from './components/AssistantBot'
import { HomePage } from './components/HomePage'
import { OptionChainTable } from './components/OptionChainTable'
import { PaperPortfolioPage } from './components/PaperPortfolioPage'
import { StrategyCard } from './components/StrategyCard'
import { StrategyEducationPage } from './components/StrategyEducationPage'
import { UnderlyingPriceChart } from './components/UnderlyingPriceChart'
import type { AssistantStructuredUpdates } from './core/assistantPolicy'
import type { ActiveSimulatorState } from './core/simulatorChartEngine'
import { optionExpirations } from './core/dashboardData'
import { selectDefaultExpiration } from './core/expirationEngine'
import { parseUserView } from './core/parseUserView'
import { recommendStrategyTypes } from './core/strategyRecommendationEngine'
import { isSupportedUnderlying } from './core/supportedUnderlyings'
import { useT } from './i18n'
import type { QverisMarketSnapshot, QverisOptionsResponse } from './types/optionTypes'
import type { Direction, ExperienceLevel, Strength } from './types/strategyTypes'
import './App.css'

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

type PriceRange = '1d' | '5d' | '1m' | 'daily' | '3m' | '1y' | '5y'
type StrategyFilter = Direction | 'all'
const fetchCache = new Map<string, { expires: number; data: unknown }>()
const fetchInflight = new Map<string, Promise<unknown>>()
const fetchCacheMs = 60000

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

async function fetchJson<T>(path: string): Promise<T> {
  const hit = fetchCache.get(path)
  if (hit && hit.expires > Date.now()) return hit.data as T
  try {
    const stored = JSON.parse(localStorage.getItem(`qveris:${path}`) || 'null')
    if (stored?.expires > Date.now()) return stored.data as T
  } catch {}
  if (fetchInflight.has(path)) return fetchInflight.get(path) as Promise<T>
  const run = fetch(path)
    .then(async (response) => {
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || `Request failed: ${path}`)
      fetchCache.set(path, { data: body, expires: Date.now() + fetchCacheMs })
      try {
        localStorage.setItem(`qveris:${path}`, JSON.stringify({ data: body, expires: Date.now() + fetchCacheMs }))
      } catch {}
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

const directionCardDefs: Array<{ value: Direction; key: 'bullish' | 'neutral' | 'bearish' | 'volatile'; icon: typeof ArrowUpRight }> = [
  { value: 'bullish', key: 'bullish', icon: ArrowUpRight },
  { value: 'neutral', key: 'neutral', icon: Waves },
  { value: 'bearish', key: 'bearish', icon: ArrowDownRight },
  { value: 'volatile', key: 'volatile', icon: Zap },
]

const priceRanges: PriceRange[] = ['daily', '1d', '5d', '1m', '3m', '1y', '5y']

function priceRangeLabel(range: PriceRange, lang: string) {
  return range === 'daily' ? (lang === 'zh' ? '日线' : 'D') : range
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

function App() {
  const hash = useHash()
  if (hash === '#/paper') {
    return <PaperPortfolioPage />
  }
  if (hash === '#/learn') {
    return <StrategyEducationPage />
  }
  if (hash.startsWith('#/trade')) {
    const params = new URLSearchParams(hash.split('?')[1] ?? '')
    return <TradingPage initialTicker={(params.get('ticker') ?? '').trim().toUpperCase()} />
  }

  return <HomePage />
}

function TradingPage({ initialTicker }: { initialTicker: string }) {
  const { t, lang, setLang } = useT()
  const [startForm] = useState<FormState>(() => ({
    ...initialForm,
    ticker: initialTicker,
    prompt: initialTicker ? `I am moderately bullish on ${initialTicker} for the next month.` : '',
  }))
  const [form, setForm] = useState<FormState>(startForm)
  const [submitted, setSubmitted] = useState<FormState>(startForm)
  const [profileApplied, setProfileApplied] = useState(false)
  const [priceRange, setPriceRange] = useState<PriceRange>('1m')
  const [selectedExpiration, setSelectedExpiration] = useState<string>()
  const [expirationTouched, setExpirationTouched] = useState(false)
  const [chainExpiration, setChainExpiration] = useState<string>()
  const [strategyFilter, setStrategyFilter] = useState<StrategyFilter>(initialForm.view)
  const [selectedStrategyId, setSelectedStrategyId] = useState<string>()
  const [activeSimulator, setActiveSimulator] = useState<ActiveSimulatorState>()
  const ticker = submitted.ticker.trim().toUpperCase()
  const unsupportedTicker = Boolean(ticker && !isSupportedUnderlying(ticker))
  const [market, setMarket] = useState<LoadState<QverisMarketSnapshot>>({})
  const [options, setOptions] = useState<LoadState<QverisOptionsResponse>>({})
  const dataIssues = dataIssueMessages({ market, options })

  useEffect(() => {
    if (!ticker || unsupportedTicker) { setMarket({}); return }
    let cancelled = false
    const load = () => fetchJson<QverisMarketSnapshot>(`/api/market/${ticker}?range=${priceRange}`)
      .then((data) => { if (!cancelled) setMarket({ data }) })
      .catch((error: Error) => { if (!cancelled) setMarket({ error: error.message }) })
    setMarket({})
    void load()
    const timer = window.setInterval(() => void load(), fetchCacheMs)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [priceRange, ticker, unsupportedTicker])

  useEffect(() => {
    if (!ticker || unsupportedTicker) { setOptions({}); return }
    let cancelled = false
    const load = () => fetchJson<QverisOptionsResponse>(`/api/options/${ticker}`)
      .then((data) => { if (!cancelled) setOptions({ data }) })
      .catch((error: Error) => { if (!cancelled) setOptions({ error: error.message }) })
    setOptions({})
    void load()
    const timer = window.setInterval(() => void load(), fetchCacheMs)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [ticker, unsupportedTicker])

  const displayedMarket = market.data
    ? {
        ...market.data,
        candles: market.data.candles?.length ? market.data.candles : options.data?.market?.candles,
      }
    : options.data?.market

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
  const selectedStrategy = selectedStrategyId ? strategies.find((strategy) => strategy.id === selectedStrategyId) : undefined
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

  return (
    <main className="oa-shell">
      <header className="oa-topbar">
        <div className="oa-brand">
          <strong>Qveris</strong>
          <span>AI</span>
        </div>
        <span className="data-source-badge">{t.topbar.qveris}</span>
        <div className="oa-top-spacer" />
        <Sun size={18} />
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
        <button className="active" type="button" title={t.nav.trade}><LineChart size={20} /></button>
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
                {priceRangeLabel(range, lang)}
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

          <section className="oa-chart-card">
            <UnderlyingPriceChart
              market={displayedMarket}
              isLoadingCandles={!market.data && !market.error && !displayedMarket}
              selectedStrategy={selectedStrategy}
              simulatorProjection={selectedProjection}
            />
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
