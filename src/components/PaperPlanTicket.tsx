import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronUp, Sparkles } from 'lucide-react'
import { money } from '../core/dashboardData'
import { strategyEntryValue } from '../core/payoffEngine'
import { recordProductEvent } from '../core/productEventsApi'
import { buildSimulatorChartProjection, type ActiveSimulatorState } from '../core/simulatorChartEngine'
import { simulateStrategy } from '../core/simulatorEngine'
import { useT } from '../i18n'
import type { StrategyCandidate } from '../types/strategyTypes'

function signedMoney(value: number) {
  return `${value >= 0 ? '+' : '-'}${money(Math.abs(value))}`
}

function signedPercent(value: number) {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(2)}%`
}

function metricValue(value: number | 'unlimited' | 'variable' | undefined, t: ReturnType<typeof useT>['t']) {
  if (typeof value === 'number') return money(value)
  if (value === 'unlimited') return t.card.unlimited
  if (value === 'variable') return t.card.variable
  return 'Pending'
}

export function PaperPlanTicket({ strategy }: { strategy?: StrategyCandidate }) {
  return <PaperPlanTicketInner strategy={strategy} />
}

export function StrategySimulator({
  strategy,
  ticker,
  onProjectionChange,
}: {
  strategy: StrategyCandidate
  ticker?: string
  onProjectionChange?: (state: ActiveSimulatorState) => void
}) {
  const { t, lang } = useT()
  const [pricePct, setPricePct] = useState(50)
  const [dayPct, setDayPct] = useState(0)
  const reportedStrategyId = useRef<string | undefined>(undefined)
  const spot = strategy.expectedMove
    ? strategy.expectedMove.low + ((strategy.expectedMove.high - strategy.expectedMove.low) * pricePct) / 100
    : strategy.legs[0]?.strike ?? 0
  const baseSpot = strategy.expectedMove
    ? (strategy.expectedMove.low + strategy.expectedMove.high) / 2
    : spot
  const underlyingChange = spot - baseSpot
  const underlyingChangePct = baseSpot ? (underlyingChange / baseSpot) * 100 : 0
  const dte = strategy.expectedMove?.dte ?? 30
  const daysElapsed = Math.round((dte * dayPct) / 100)
  const daysLeft = Math.max(0, dte - daysElapsed)
  const { pl } = simulateStrategy(strategy, spot, daysLeft)
  const capitalBase = typeof strategy.maxLoss === 'number' && strategy.maxLoss > 0
    ? strategy.maxLoss
    : Math.abs(strategyEntryValue(strategy.legs))
  const strategyReturnPct = capitalBase ? (pl / capitalBase) * 100 : 0
  const date = new Date()
  date.setDate(date.getDate() + daysElapsed)

  useEffect(() => {
    if (!onProjectionChange) return
    const projection = buildSimulatorChartProjection({ strategy, underlyingPrice: spot, daysLeft, daysElapsed })
    onProjectionChange({ strategyId: strategy.id, projection })
  }, [strategy, spot, daysLeft, daysElapsed, onProjectionChange])

  function recordSimulatorUse() {
    if (reportedStrategyId.current === strategy.id) return
    reportedStrategyId.current = strategy.id
    recordProductEvent({
      eventName: 'simulator_used',
      ticker: ticker ?? strategy.legs[0]?.symbol?.replace(/\d.*$/, ''),
      properties: { strategyId: strategy.id, strategyName: strategy.name, source: 'simulator' },
    })
  }

  return (
    <div className="ticket-simulator">
      <h3><Sparkles size={16} /> {t.simulator.title}</h3>
      <p>{t.simulator.help}</p>
      <strong>
        {((strategy.legs[0]?.symbol ?? '').replace(/\d.*$/, '') || strategy.legs[0]?.symbol?.slice(0, 4)) ?? ''} {money(spot)}
        <em className={underlyingChange >= 0 ? 'profit' : 'loss'}>
          {signedMoney(underlyingChange)} ({signedPercent(underlyingChangePct)})
        </em>
      </strong>
      <input value={pricePct} onChange={(event) => { recordSimulatorUse(); setPricePct(Number(event.target.value)) }} type="range" min="0" max="100" style={{ '--pct': `${pricePct}%` } as CSSProperties} />
      <strong>
        {date.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        <em>{daysLeft} DTE</em>
      </strong>
      <input value={dayPct} onChange={(event) => { recordSimulatorUse(); setDayPct(Number(event.target.value)) }} type="range" min="0" max="100" style={{ '--pct': `${dayPct}%` } as CSSProperties} />
      <div className="sim-value">
        <span>{t.simulator.estimatedPl}</span>
        <strong className={pl >= 0 ? 'profit' : 'loss'}>
          {signedMoney(pl)} ({signedPercent(strategyReturnPct)})
        </strong>
      </div>
    </div>
  )
}

function PaperPlanTicketInner({ strategy }: { strategy?: StrategyCandidate }) {
  const { t } = useT()

  if (!strategy) {
    return (
      <section className="terminal-section ticket-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Paper Plan</p>
            <h2>Select A Strategy</h2>
          </div>
          <Sparkles size={18} />
        </div>
        <p className="muted-copy">Choose a candidate to generate a structured paper plan.</p>
      </section>
    )
  }

  return (
    <section className="terminal-section ticket-panel">
      <div className="section-head">
        <div>
          <p className="eyebrow">{strategy.legs[0]?.right ?? 'Plan'}</p>
          <h2>{strategy.name}</h2>
        </div>
        <Sparkles size={18} />
      </div>
      <div className="ticket-metrics">
        <div><span>Max Loss</span><strong className="loss">{metricValue(strategy.maxLoss, t)}</strong></div>
        <div>
          <span>Max Gain</span>
          <strong className="profit">
            {metricValue(strategy.maxProfit, t)}
          </strong>
        </div>
        <div>
          <span>PoP</span>
          <strong className={(strategy.probabilityOfProfit ?? 0) >= 50 ? 'profit' : 'loss'}>
            {typeof strategy.probabilityOfProfit === 'number' ? `${strategy.probabilityOfProfit.toFixed(1)}%` : 'Pending'}
          </strong>
        </div>
      </div>
      <div className="ticket-legs">
        {strategy.legs.map((leg) => (
          <div key={`${leg.action}-${leg.symbol}`}>
            <strong>{leg.quantity} {leg.right} {money(leg.strike)}</strong>
            <span>{leg.action === 'buy' ? 'Buy to Open' : 'Sell to Open'} <b>{money(leg.premium)}</b></span>
            <em>{leg.expiration}</em>
          </div>
        ))}
      </div>
      <div className="ticket-cost">
        <span>Approx. Cost {strategy.maxLoss ? '(Max Loss)' : ''}</span>
        <strong>{money(Math.abs(strategyEntryValue(strategy.legs)))}</strong>
      </div>
      <div className="strike-toggle">
        <ChevronDown size={16} />
        <span>Strike</span>
        <ChevronUp size={16} />
      </div>
      <div className="ticket-checklist">
        {strategy.guardrails.map((guardrail) => (
          <span key={guardrail}>{guardrail}</span>
        ))}
      </div>
      <button type="button">Save Paper Plan</button>
    </section>
  )
}
