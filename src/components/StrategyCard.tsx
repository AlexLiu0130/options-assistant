import { useState, useMemo } from 'react'
import type { MouseEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { money } from '../core/dashboardData'
import { submitPaperOrder } from '../core/paperTradeApi'
import { recordProductEvent } from '../core/productEventsApi'
import { buildRiskChecklist } from '../core/riskChecklistEngine'
import { assistantBriefText } from '../core/assistantPolicy'
import { adjustStrategyLegs, type StrategyLegAdjustment } from '../core/strategyAdjustmentEngine'
import { buildPaperTradeCostBreakdown } from '../core/paperTradeEngine'
import { useT } from '../i18n'
import type { StrategyCandidate } from '../types/strategyTypes'
import type { QverisOptionsResponse, QverisOptionContract } from '../types/optionTypes'
import type { ParsedView } from '../types/strategyTypes'
import type { ActiveSimulatorState } from '../core/simulatorChartEngine'
import { BriefContent } from './AssistantExplanationPanel'
import { StrategySimulator } from './PaperPlanTicket'
import { GreeksQuadChart } from './GreeksQuadChart'
type CardTab = 'overview' | 'adjust' | 'sim' | 'greeks' | 'explain'

function tileVal(value: number) {
  const n = Math.round(value)
  return `$${n.toLocaleString('en-US')}`
}

function rankText(text: string, lang: string) {
  if (lang !== 'zh') return text
  const zh: Record<string, string> = {
    'Matches selected market direction.': '符合当前方向判断',
    'Max loss fits the stated risk budget.': '最大亏损符合风险预算',
    'Defined maximum loss.': '最大亏损明确',
    'Positive estimated P/L at the target price.': '目标价下预计收益为正',
    'Expiration matches the stated horizon.': '到期日匹配持仓周期',
    'Higher probability-of-profit estimate.': '盈利概率估算较高',
    'Tighter quoted bid/ask spread.': '买卖价差较窄',
    'Max loss is slightly above the stated risk budget.': '最大亏损略高于风险预算',
    'Max loss is above the stated risk budget.': '最大亏损高于风险预算',
    'Risk is uncapped or variable and needs manual review.': '风险无上限或收益结构可变',
    'Estimated P/L is negative at the target price.': '目标价下预计亏损',
    'Conditional strategy benefits from a clearer target price.': '需要更明确的目标价',
    'Expiration is away from the stated horizon.': '到期日偏离持仓周期',
    'Low probability-of-profit estimate.': '盈利概率估算偏低',
    'Wide quoted bid/ask spread.': '买卖价差较宽',
    'Multi-leg structure may be harder for beginners.': '多腿结构对新手更复杂',
    'Assignment-related strategy; user is not willing to be assigned.': '含指派风险，但用户未接受指派',
    'Short call requires covered-share or margin review.': '卖出看涨需要持股或保证金检查',
  }
  return zh[text] ?? text
}

function mid(c: QverisOptionContract) {
  if (typeof c.bid === 'number' && typeof c.ask === 'number' && c.bid >= 0 && c.ask > 0 && c.ask >= c.bid)
    return (c.bid + c.ask) / 2
  return typeof c.last === 'number' && c.last > 0 ? c.last : undefined
}

function signedCashFlow(value: number) {
  return `${value >= 0 ? '+' : '−'}${money(Math.abs(value))}`
}

function TradeCostSheet({ strategy, ticker, lang }: { strategy: StrategyCandidate; ticker?: string; lang: string }) {
  const breakdown = useMemo(() => buildPaperTradeCostBreakdown(strategy.legs), [strategy.legs])
  const zh = lang === 'zh'
  const openingIsDebit = breakdown.openingCashImpact >= 0
  const currency = (value: number) => money(value)
  const contractName = (row: typeof breakdown.rows[number]) =>
    `${(ticker ?? row.symbol?.replace(/\d.*$/, '') ?? '').toUpperCase()} ${row.expiration} ${row.strike} ${row.right.toUpperCase()}`.trim()

  return (
    <section className="trade-cost-sheet" aria-label={zh ? '交易费用明细' : 'Trade cost breakdown'}>
      <div className="trade-cost-head">
        <div>
          <strong>{zh ? '交易费用明细' : 'Trade cost breakdown'}</strong>
          <span>{zh ? `${breakdown.contractCount} 张合约 · 每张 100 股` : `${breakdown.contractCount} contracts · 100 shares each`}</span>
        </div>
        <em>{zh ? '开仓估算' : 'Opening estimate'}</em>
      </div>

      <div className="trade-cost-table" role="table">
        <div className="trade-cost-row trade-cost-labels" role="row">
          <span>{zh ? '方向' : 'Action'}</span>
          <span>{zh ? '合约' : 'Contract'}</span>
          <span>{zh ? '报价' : 'Quote'}</span>
          <span>{zh ? '现金流' : 'Cash flow'}</span>
        </div>
        {breakdown.rows.map((row) => (
          <div className="trade-cost-row" key={row.id} role="row">
            <span className={row.action === 'buy' ? 'buy-tag' : 'sell-tag'}>
              {row.action === 'buy' ? (zh ? '买入开仓' : 'Buy to open') : (zh ? '卖出开仓' : 'Sell to open')}
            </span>
            <strong>{contractName(row)} <em>× {row.quantity}</em></strong>
            <span className="trade-cost-quote">
              {row.priceSource === 'ask' ? (zh ? '卖一' : 'Ask') : row.priceSource === 'bid' ? (zh ? '买一' : 'Bid') : (zh ? '中间价' : 'Mid')}
              <b>{currency(row.price)}</b>
            </span>
            <b className={row.cashFlow > 0 ? 'cash-debit' : 'cash-credit'}>{signedCashFlow(row.cashFlow)}</b>
          </div>
        ))}
      </div>

      <div className="trade-cost-summary">
        <div><span>{zh ? '买入权利金' : 'Buy premium'}</span><strong>{currency(breakdown.grossDebit)}</strong></div>
        <div><span>{zh ? '卖出权利金' : 'Sell credit'}</span><strong className="cash-credit">−{currency(breakdown.grossCredit)}</strong></div>
        <div><span>{zh ? '净权利金' : 'Net premium'}</span><strong className={breakdown.netPremium >= 0 ? 'cash-debit' : 'cash-credit'}>{signedCashFlow(breakdown.netPremium)}</strong></div>
      </div>

      <div className="trade-fee-list">
        <div><span>{zh ? '佣金' : 'Commission'}</span><strong>{currency(breakdown.fees.commission)}</strong></div>
        <div><span>{zh ? 'ORF 监管费' : 'ORF'}</span><strong>{currency(breakdown.fees.optionsRegulatoryFee)}</strong></div>
        <div><span>{zh ? 'OCC 清算费' : 'OCC clearing'}</span><strong>{currency(breakdown.fees.occClearingFee)}</strong></div>
        <div><span>{zh ? 'CAT 审计费' : 'CAT'}</span><strong>{currency(breakdown.fees.catFee)}</strong></div>
        <div><span>{zh ? '卖出方 SEC / FINRA' : 'Sell-side SEC / FINRA'}</span><strong>{currency(breakdown.fees.secTransactionFee + breakdown.fees.finraTradingActivityFee)}</strong></div>
      </div>

      <div className={`trade-cost-total ${openingIsDebit ? 'debit' : 'credit'}`}>
        <span>{openingIsDebit ? (zh ? '预计开仓总支出' : 'Est. opening cash required') : (zh ? '预计开仓净收款' : 'Est. opening net credit')}</span>
        <strong>{currency(Math.abs(breakdown.openingCashImpact))}</strong>
      </div>
      <p className="trade-cost-note">
        {breakdown.usedMidpointFallback
          ? (zh ? '部分腿缺少有效 Bid/Ask，已用中间价估算。实际成交价和交易所路由费用可能不同。' : 'Some legs lack a usable bid/ask, so midpoint pricing is used. Actual fills and venue fees may differ.')
          : (zh ? '买入按 Ask、卖出按 Bid 估算。交易所路由费、返佣与滑点不在此模型中。' : 'Buys use Ask and sells use Bid. Venue routing fees, rebates, and slippage are not modeled.')}
      </p>
    </section>
  )
}

function LegEditor({
  strategy,
  optionChain,
  parsedView,
  onAdjusted,
}: {
  strategy: StrategyCandidate
  optionChain: QverisOptionsResponse
  parsedView: ParsedView
  onAdjusted: (s: StrategyCandidate) => void
}) {
  const { t } = useT()
  const le = t.legEditor

  // local copy of adjustments, indexed by legIndex
  const [local, setLocal] = useState<StrategyLegAdjustment[]>(() =>
    strategy.legs.map((leg, i) => ({ legIndex: i, expiration: leg.expiration, strike: leg.strike, quantity: leg.quantity ?? 1 }))
  )
  const [errors, setErrors] = useState<string[]>([])

  const expirations = useMemo(
    () => [...new Set(optionChain.contracts.filter(c => mid(c) !== undefined).map(c => c.expiration))].sort(),
    [optionChain.contracts]
  )

  function strikesFor(right: string, expiry: string) {
    return [...new Set(
      optionChain.contracts
        .filter(c => c.right === right && c.expiration === expiry && typeof c.strike === 'number' && mid(c) !== undefined)
        .map(c => c.strike as number)
    )].sort((a, b) => a - b)
  }

  function apply(next: StrategyLegAdjustment[]) {
    setLocal(next)
    const result = adjustStrategyLegs({ baseStrategy: strategy, optionChain, view: parsedView, adjustments: next })
    if (result.errors.length) {
      setErrors(result.errors)
    } else {
      setErrors([])
      if (result.strategy) onAdjusted(result.strategy)
    }
  }

  function update(legIndex: number, patch: Partial<Omit<StrategyLegAdjustment, 'legIndex'>>) {
    const next = local.map(a => a.legIndex === legIndex ? { ...a, ...patch } : a)
    // if expiry changed, reset strike to first available
    if ('expiration' in patch) {
      const leg = strategy.legs[legIndex]
      const strikes = strikesFor(leg.right, patch.expiration!)
      next[legIndex] = { ...next[legIndex], strike: strikes[0] ?? leg.strike }
    }
    apply(next)
  }

  const formatError = (err: string) => {
    if (err === 'OPTION_CHAIN_UNAVAILABLE') return le.errChainUnavailable
    const notFound = err.match(/^CONTRACT_NOT_FOUND:(\d+)$/)
    if (notFound) return `${le.errContractNotFound} ${Number(notFound[1]) + 1}`
    const badQty = err.match(/^INVALID_QUANTITY:(\d+)$/)
    if (badQty) return `${le.errInvalidQty} ${Number(badQty[1]) + 1}`
    return err
  }

  return (
    <div className="le-wrap">
      <div className="le-title">{le.title}</div>
      {strategy.legs.map((leg, i) => {
        const adj = local[i]
        const strikes = strikesFor(leg.right, adj?.expiration ?? leg.expiration)
        return (
          <div key={i} className="le-row">
            <span className={`le-action ${leg.action === 'buy' ? 'buy-tag' : 'sell-tag'}`}>
              {leg.action === 'buy' ? 'B' : 'S'} {leg.right.toUpperCase()}
            </span>
            <select
              className="le-select"
              value={adj?.expiration ?? leg.expiration}
              onChange={e => update(i, { expiration: e.target.value })}
            >
              {expirations.map(exp => <option key={exp} value={exp}>{exp}</option>)}
            </select>
            <select
              className="le-select le-select-strike"
              value={adj?.strike ?? leg.strike}
              onChange={e => update(i, { strike: Number(e.target.value) })}
            >
              {strikes.map(s => <option key={s} value={s}>${s}</option>)}
            </select>
            <div className="le-qty">
              <button type="button" onClick={() => update(i, { quantity: Math.max(1, (adj?.quantity ?? 1) - 1) })}>−</button>
              <span>{adj?.quantity ?? 1}</span>
              <button type="button" onClick={() => update(i, { quantity: Math.min(20, (adj?.quantity ?? 1) + 1) })}>+</button>
            </div>
          </div>
        )
      })}
      {errors.length > 0 && (
        <div className="le-errors">
          {errors.map(e => <span key={e}>{formatError(e)}</span>)}
        </div>
      )}
    </div>
  )
}

export function StrategyCard({
  strategy,
  selected,
  onSelect,
  underlyingPrice,
  onProjectionChange,
  onAdjusted,
  onPaperOrderFilled,
  ticker,
  optionChain,
  parsedView,
}: {
  strategy: StrategyCandidate
  selected?: boolean
  onSelect?: (strategy: StrategyCandidate) => void
  underlyingPrice?: number
  onProjectionChange?: (state: ActiveSimulatorState) => void
  onAdjusted?: (baseId: string, strategy: StrategyCandidate) => void
  onPaperOrderFilled?: () => void
  ticker?: string
  optionChain?: QverisOptionsResponse
  parsedView?: ParsedView
}) {
  const { t, lang } = useT()
  const [saveLabel, setSaveLabel] = useState('')
  const [explanation, setExplanation] = useState('')
  const [explainState, setExplainState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [activeTab, setActiveTab] = useState<CardTab>('overview')
  // null = no user adjustment yet → always use latest strategy prop
  const [adjustedStrategy, setAdjustedStrategy] = useState<StrategyCandidate | null>(null)
  const displayStrategy = adjustedStrategy ?? strategy

  const canAdjust = !!optionChain && !!parsedView && optionChain.status === 'available' && strategy.legs.length > 0

  function select() {
    if (!selected) {
      recordProductEvent({
        eventName: 'strategy_opened',
        ticker,
        properties: { strategyId: strategy.id, strategyName: strategy.name, source: 'strategy_card' },
      })
    }
    onSelect?.(strategy)
  }

  async function save(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation()
    setSaveLabel('Submitting…')
    try {
      const inferredTicker = ticker || displayStrategy.legs[0]?.symbol?.replace(/\d.*$/, '') || 'TST'
      await submitPaperOrder({ ticker: inferredTicker, strategy: displayStrategy, underlyingPrice })
      setSaveLabel('Opened')
      onPaperOrderFilled?.()
      setTimeout(() => setSaveLabel(''), 8000)
    } catch (error) {
      setSaveLabel(error instanceof Error ? error.message : 'Unavailable')
    }
  }

  async function explain(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation()
    setActiveTab('explain')
    setExplainState('loading')
    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userMessage: `Explain the selected ${displayStrategy.name} strategy for ${(ticker ?? '').toUpperCase()}.`,
          language: lang,
          mode: 'strategy_explanation',
          marketContext: {
            ticker: ticker?.toUpperCase(),
            underlyingPrice,
            selectedStrategy: displayStrategy,
            strategies: [displayStrategy],
            scenarios: displayStrategy.scenarioRows,
            risks: buildRiskChecklist(displayStrategy),
          },
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Explanation failed')
      setExplanation(assistantBriefText(body))
      setExplainState('idle')
    } catch (error) {
      setExplanation(error instanceof Error ? error.message : 'Explanation failed')
      setExplainState('error')
    }
  }

  const isLoading = strategy.maxLoss === undefined && strategy.maxProfit === undefined

  const maxGainLabel =
    typeof displayStrategy.maxProfit === 'number'
      ? tileVal(displayStrategy.maxProfit)
      : displayStrategy.maxProfit === 'variable'
        ? t.card.variable
        : '∞'
  const maxLossLabel =
    typeof displayStrategy.maxLoss === 'number'
      ? tileVal(displayStrategy.maxLoss)
      : displayStrategy.maxLoss === 'unlimited'
        ? '∞'
        : displayStrategy.maxLoss === 'variable'
          ? t.card.variable
          : '—'

  const pop =
    typeof displayStrategy.probabilityOfProfit === 'number'
      ? `${displayStrategy.probabilityOfProfit.toFixed(0)}%`
      : 'N/A'
  const tabs: Array<{ id: CardTab; label: string; disabled?: boolean }> = [
    { id: 'overview', label: lang === 'zh' ? '概览' : 'Overview' },
    { id: 'adjust', label: lang === 'zh' ? '调整' : 'Adjust', disabled: !canAdjust },
    { id: 'sim', label: lang === 'zh' ? '模拟' : 'Simulate' },
    { id: 'greeks', label: 'Greeks' },
    { id: 'explain', label: lang === 'zh' ? '解释' : 'Explain' },
  ]

  return (
    <article
      className={`strategy-tile${selected ? ' selected' : ''}`}
      onClick={select}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') select() }}
      role="button"
      tabIndex={0}
    >
      <div className="tile-head">
        <span className="tile-name">{t.strategyName[strategy.name] ?? strategy.name}</span>
        <svg className="tile-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3 5L7 9L11 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {isLoading ? (
        <div className="tile-metrics tile-metrics-loading">
          <div><div className="tile-skel tile-skel-val" /><div className="tile-skel tile-skel-lbl" /></div>
          <div><div className="tile-skel tile-skel-val" /><div className="tile-skel tile-skel-lbl" /></div>
          <div><div className="tile-skel tile-skel-val" /><div className="tile-skel tile-skel-lbl" /></div>
        </div>
      ) : (
        <div className="tile-metrics">
          <div>
            <strong className={`loss${maxLossLabel === '∞' ? ' infinity' : ''}`}>{maxLossLabel}</strong>
            <span>{t.card.maxLoss}</span>
          </div>
          <div>
            <strong className={`profit${maxGainLabel === '∞' ? ' infinity' : ''}`}>{maxGainLabel}</strong>
            <span>{t.card.maxGain}</span>
          </div>
          <div>
            <strong className={(displayStrategy.probabilityOfProfit ?? 0) >= 50 ? 'pop-good' : ''}>{pop}</strong>
            <span>{t.card.pop}</span>
          </div>
        </div>
      )}

      {selected && (
        <div className="tile-expanded" onClick={(event) => event.stopPropagation()}>
          <div className="tile-tabs">
            {tabs.map((tab) => (
              <button
                className={activeTab === tab.id ? 'active' : ''}
                disabled={tab.disabled}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>
          {activeTab === 'overview' && (
            <>
              {(strategy.rankReasons?.length || strategy.rankWarnings?.length) ? (
                <div className="rank-reasons">
                  {strategy.rankReasons?.map((reason) => <span key={reason}>{rankText(reason, lang)}</span>)}
                  {strategy.rankWarnings?.map((warning) => <em key={warning}>{rankText(warning, lang)}</em>)}
                </div>
              ) : null}
              <TradeCostSheet strategy={displayStrategy} ticker={ticker} lang={lang} />
            </>
          )}
          {activeTab === 'adjust' && canAdjust && (
            <LegEditor
              strategy={strategy}
              optionChain={optionChain!}
              parsedView={parsedView!}
              onAdjusted={(next) => {
                setAdjustedStrategy(next)
                onAdjusted?.(strategy.id, next)
              }}
            />
          )}
          {activeTab === 'sim' && <StrategySimulator strategy={displayStrategy} ticker={ticker} onProjectionChange={onProjectionChange} />}
          {activeTab === 'greeks' && <GreeksQuadChart strategy={displayStrategy} underlyingPrice={underlyingPrice} />}
          {activeTab === 'explain' && explanation ? <BriefContent text={explanation} isError={explainState === 'error'} lang={lang} ticker={ticker} /> : null}
          <div className="tile-actions">
            {saveLabel === 'Opened' ? (
              <button type="button" className="pp-view-link" onClick={() => { window.location.hash = '#/paper' }}>
                View Paper Portfolio →
              </button>
            ) : (
              <button type="button" onClick={save}>{saveLabel || t.card.paperTrade}</button>
            )}
            <button disabled={explainState === 'loading'} type="button" onClick={explain}>
              {explainState === 'loading' ? <Loader2 size={13} /> : null}
              {t.card.explain}
            </button>
          </div>
        </div>
      )}
    </article>
  )
}
