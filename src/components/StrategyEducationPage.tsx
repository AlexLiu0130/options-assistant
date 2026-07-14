import { useMemo, useState } from 'react'
import { Briefcase, GraduationCap, LineChart, Moon, Search, Sun } from 'lucide-react'
import {
  educationCategories,
  strategyEducationContent,
  type EducationCategory,
  type EducationLevel,
  type StrategyEducationItem,
} from '../core/strategyEducationContent'
import { recordProductEvent } from '../core/productEventsApi'
import { useT } from '../i18n'
import type { StrategyCandidate } from '../types/strategyTypes'
import { GreeksQuadChart } from './GreeksQuadChart'
import { StrategyPayoffChart } from './StrategyPayoffChart'

function navigate(path: string) { window.location.hash = path }
function lastTradePath() {
  try {
    const ticker = (localStorage.getItem('qveris-last-ticker') || '').trim().toUpperCase()
    return ticker ? `#/trade?ticker=${encodeURIComponent(ticker)}` : '#/trade'
  } catch {
    return '#/trade'
  }
}

const categoryOrder = Object.keys(educationCategories) as EducationCategory[]
const levelOrder: EducationLevel[] = ['beginner', 'intermediate', 'advanced']

// Any leg description that mentions an actual stock position or dynamic hedging
// isn't representable by the option-only sampleLegs used for the payoff/Greeks charts.
const STOCK_OR_HEDGE_PATTERN = /持有[^，]*股|做空[^，]*股|动态对冲/

function isSimplifiedStrategy(item: StrategyEducationItem) {
  return item.legs.some((leg) => STOCK_OR_HEDGE_PATTERN.test(leg))
}

function isVariablePayoffStrategy(item: StrategyEducationItem) {
  return item.category === 'time_spread' || [item.payoff.maxProfit, item.payoff.breakeven, item.payoff.shape]
    .some((text) => /可变|Variable|取决于|路径|动态/.test(text))
}

function directionLabel(direction: string, t: ReturnType<typeof useT>['t']) {
  if (direction === 'income') return t.learn.incomeDirection
  return t.direction[direction as 'bullish' | 'neutral' | 'bearish' | 'volatile'] ?? direction
}

function medianStrike(legs: StrategyEducationItem['sampleLegs']) {
  const strikes = [...legs.map((leg) => leg.strike)].sort((a, b) => a - b)
  if (!strikes.length) return 100
  const mid = strikes.length % 2 === 0
    ? (strikes[strikes.length / 2 - 1] + strikes[strikes.length / 2]) / 2
    : strikes[(strikes.length - 1) / 2]
  return mid
}

function StrategyListItem({ item, active, onSelect }: {
  item: StrategyEducationItem
  active: boolean
  onSelect: () => void
}) {
  const { t } = useT()
  const l = t.learn
  return (
    <button type="button" className={`edu-list-item${active ? ' active' : ''}`} onClick={onSelect}>
      <div className="edu-list-item-top">
        <div className="edu-list-item-titles">
          <strong>{item.zhName}</strong>
          <span>{item.name}</span>
        </div>
        <em className={`edu-level edu-level-${item.level}`}>{l.levelLabel[item.level]}</em>
      </div>
      <p className="edu-list-item-summary">{item.summary}</p>
      <div className="edu-list-item-tags">
        <em className={`edu-direction edu-direction-${item.direction}`}>{directionLabel(item.direction, t)}</em>
        <em className={`edu-support-tag${item.supportedInBuilder ? '' : ' edu-support-off'}`}>
          {item.supportedInBuilder ? l.supportedBadge : l.notSupportedBadge}
        </em>
      </div>
    </button>
  )
}

function DetailPanel({ item }: { item: StrategyEducationItem }) {
  const { t } = useT()
  const l = t.learn
  const isVariable = isVariablePayoffStrategy(item)
  const isSimplified = isSimplifiedStrategy(item)
  const spot = useMemo(() => medianStrike(item.sampleLegs), [item])
  const candidate: StrategyCandidate = useMemo(() => ({
    id: item.id,
    name: item.name,
    legs: item.sampleLegs,
    guardrails: item.keyRisks,
    fit: 'medium',
    status: 'education_only',
  }), [item])

  return (
    <div className="edu-detail">
      <div className="edu-detail-header">
        <div className="edu-detail-titles">
          <h3>{item.zhName}</h3>
          <span>{item.name}</span>
        </div>
        <div className="edu-detail-tags">
          <em className={`edu-level edu-level-${item.level}`}>{l.levelLabel[item.level]}</em>
          <em className={`edu-direction edu-direction-${item.direction}`}>{directionLabel(item.direction, t)}</em>
        </div>
      </div>
      <p className="edu-detail-summary">{item.summary}</p>
      {!item.supportedInBuilder && <p className="edu-not-supported-note">{l.notSupportedNote}</p>}

      <div className="edu-payoff-metrics edu-payoff-metrics-3">
        <div><span>{l.maxLoss}</span><strong className="loss">{item.payoff.maxLoss}</strong></div>
        <div><span>{l.maxProfit}</span><strong className="profit">{item.payoff.maxProfit}</strong></div>
        <div><span>{l.breakeven}</span><strong>{item.payoff.breakeven}</strong></div>
      </div>

      <div className="edu-detail-main">
        <section className="edu-payoff-section">
          <h4>{l.payoffSection}</h4>
          <p className="edu-payoff-shape">{item.payoff.shape}</p>
          <StrategyPayoffChart
            legs={item.sampleLegs}
            isVariable={isVariable}
            isSimplified={isSimplified}
            breakeven={item.payoff.breakeven}
          />
        </section>
        <section className="edu-greeks-section">
          <h4>{l.greeksSection}</h4>
          <p className="edu-greeks-note">{l.greeksSectionNote}</p>
          {item.sampleLegs.length > 0
            ? <GreeksQuadChart strategy={candidate} underlyingPrice={spot} expandable={false} teaching />
            : <p className="edu-greeks-empty">{l.greeksEmptyState}</p>}
        </section>
      </div>

      <div className="edu-detail-sections">
        <div className="edu-detail-col">
          <section>
            <h4>{l.structure}</h4>
            <ul className="edu-legs">
              {item.legs.map((leg, i) => <li key={i}>{leg}</li>)}
            </ul>
            <table className="edu-legs-table">
              <thead>
                <tr>
                  <th>{l.legsTable.action}</th>
                  <th>{l.legsTable.right}</th>
                  <th>{l.legsTable.strike}</th>
                  <th>{l.legsTable.expiration}</th>
                  <th>{l.legsTable.quantity}</th>
                  <th>{l.legsTable.premium}</th>
                </tr>
              </thead>
              <tbody>
                {item.sampleLegs.map((leg, i) => (
                  <tr key={i}>
                    <td className={leg.action === 'buy' ? 'edu-leg-buy' : 'edu-leg-sell'}>
                      {leg.action === 'buy' ? l.actionBuy : l.actionSell}
                    </td>
                    <td>{leg.right === 'call' ? l.rightCall : l.rightPut}</td>
                    <td>${leg.strike}</td>
                    <td>{leg.expiration}</td>
                    <td>{leg.quantity}</td>
                    <td>{leg.premium != null ? `$${leg.premium}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h4>{l.riskSection}</h4>
            <ul className="edu-risks">
              {item.keyRisks.map((risk) => <li key={risk}>{risk}</li>)}
            </ul>
          </section>
        </div>
        <div className="edu-detail-col">
          <section>
            <h4>{l.fitSection}</h4>
            <div className="edu-fit-block">
              <span className="edu-fit-label edu-fit-good">{l.bestFor}</span>
              <ul>{item.bestFor.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </div>
            <div className="edu-fit-block">
              <span className="edu-fit-label edu-fit-bad">{l.avoidWhen}</span>
              <ul>{item.avoidWhen.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </div>
          </section>
          <section>
            <h4>{l.teachingSection}</h4>
            <ul className="edu-teaching">
              {item.teachingNotes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}

export function StrategyEducationPage({ theme, onToggleTheme }: { theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const { t, lang, setLang } = useT()
  const l = t.learn
  const [category, setCategory] = useState<EducationCategory | 'all'>('all')
  const [level, setLevel] = useState<EducationLevel | 'all'>('all')
  const [supportedOnly, setSupportedOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string>()

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase()
    return strategyEducationContent.filter((item) => {
      if (category !== 'all' && item.category !== category) return false
      if (level !== 'all' && item.level !== level) return false
      if (supportedOnly && !item.supportedInBuilder) return false
      if (q && !item.zhName.toLowerCase().includes(q) && !item.name.toLowerCase().includes(q) && !item.summary.toLowerCase().includes(q)) {
        return false
      }
      return true
    })
  }, [category, level, supportedOnly, search])

  const selected = filteredItems.find((item) => item.id === selectedId) ?? filteredItems[0]

  function selectStrategy(item: StrategyEducationItem) {
    if (selected?.id !== item.id) {
      recordProductEvent({
        eventName: 'education_viewed',
        properties: { strategyId: item.id, strategyName: item.name, page: 'education' },
      })
    }
    setSelectedId(item.id)
  }

  return (
    <main className="oa-shell edu-shell">
      <header className="oa-topbar">
        <button className="oa-brand oa-brand-button" type="button" onClick={() => navigate('#/')} aria-label="Qveris home"><strong>Qveris</strong><span>AI</span></button>
        <h2 className="pp-page-title">{l.title}</h2>
        <div className="oa-top-spacer" />
        <button className="theme-toggle" type="button" onClick={onToggleTheme} aria-label="Toggle dark mode">
          {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        <div className="lang-toggle">
          <button className={lang === 'en' ? 'active' : ''} type="button" onClick={() => setLang('en')}>EN</button>
          <button className={lang === 'zh' ? 'active' : ''} type="button" onClick={() => setLang('zh')}>中</button>
        </div>
      </header>

      <aside className="oa-rail">
        <button type="button" title={t.nav.trade} onClick={() => navigate(lastTradePath())}><LineChart size={20} /></button>
        <button type="button" className="active" title={t.nav.learn}><GraduationCap size={20} /></button>
        <button type="button" title={t.nav.paper} onClick={() => navigate('#/paper')}><Briefcase size={20} /></button>
      </aside>

      <div className="edu-workbench">
        <div className="edu-toolbar">
          <div className="edu-toolbar-row1">
            <h2>{l.title} <span className="edu-total-count">{l.totalCount(strategyEducationContent.length)}</span></h2>
            <div className="edu-search-box">
              <Search size={14} />
              <input
                placeholder={l.searchPlaceholder}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="edu-toolbar-row2">
            <div className="edu-category-chips">
              <button className={category === 'all' ? 'active' : ''} type="button" onClick={() => setCategory('all')}>
                {l.allCategories}<span>{strategyEducationContent.length}</span>
              </button>
              {categoryOrder.map((key) => (
                <button className={category === key ? 'active' : ''} key={key} type="button" onClick={() => setCategory(key)}>
                  {educationCategories[key].title}
                  <span>{strategyEducationContent.filter((item) => item.category === key).length}</span>
                </button>
              ))}
            </div>
            <div className="edu-filter-group">
              <div className="edu-level-chips">
                <button className={level === 'all' ? 'active' : ''} type="button" onClick={() => setLevel('all')}>{l.allLevels}</button>
                {levelOrder.map((lv) => (
                  <button className={level === lv ? 'active' : ''} key={lv} type="button" onClick={() => setLevel(lv)}>
                    {l.levelLabel[lv]}
                  </button>
                ))}
              </div>
              <label className="edu-supported-toggle">
                <input type="checkbox" checked={supportedOnly} onChange={(e) => setSupportedOnly(e.target.checked)} />
                {l.supportedOnly}
              </label>
            </div>
          </div>
        </div>

        <div className="edu-body">
          <nav className="edu-list" aria-label={l.title}>
            {filteredItems.length === 0 && <p className="edu-list-empty">{l.noResults}</p>}
            {filteredItems.map((item) => (
              <StrategyListItem
                key={item.id}
                item={item}
                active={selected?.id === item.id}
                onSelect={() => selectStrategy(item)}
              />
            ))}
          </nav>
          <div className="edu-detail-panel">
            {selected && <DetailPanel item={selected} />}
          </div>
        </div>
      </div>

      <p className="edu-disclaimer">{l.disclaimer}</p>
    </main>
  )
}
