import { useEffect, useState } from 'react'
import type React from 'react'
import { Briefcase, GraduationCap, LineChart, RefreshCw, RotateCcw, X } from 'lucide-react'
import { closePaperPosition, getPaperAccountWithMarketPrices, resetPaperAccount } from '../core/paperTradeApi'
import type { PaperAccountResponse, PaperPositionRow } from '../core/paperTradeApi'
import type { PaperPosition } from '../types/paperTradeTypes'
import { useT } from '../i18n'

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n)
}
function fmtSigned(n: number) {
  return `${n >= 0 ? '+' : ''}${fmt(n)}`
}
function fmtPct(n: number, base: number) {
  if (!base) return '—'
  return `${((n / base) * 100 >= 0 ? '+' : '')}${((n / base) * 100).toFixed(2)}%`
}
function fmtDate(iso?: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
}
function fmtDateShort(iso?: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function navigate(path: string) { window.location.hash = path }

// ─── P/L cell ─────────────────────────────────────────────────────────────────

function PnL({ value, pct }: { value: number; pct?: string }) {
  return (
    <span className={value >= 0 ? 'pp-profit' : 'pp-loss'}>
      {fmtSigned(value)}{pct ? <em> {pct}</em> : null}
    </span>
  )
}

// ─── Summary strip ────────────────────────────────────────────────────────────

function SummaryStrip({ summary, onReset }: {
  summary: PaperAccountResponse['summary']
  onReset: () => void
}) {
  const { t } = useT()
  const p = t.paper
  const netPct = summary.initialCash ? ((summary.netPnL / summary.initialCash) * 100) : 0
  const items = [
    { label: p.summary.startingCash,  value: fmt(summary.initialCash),         plain: true },
    { label: p.summary.cashBalance,   value: fmt(summary.cashBalance),         plain: true },
    { label: 'Reserved Risk',         value: fmt(summary.reservedRisk),        plain: true },
    { label: 'Buying Power',          value: fmt(summary.buyingPower),         plain: true },
    { label: p.summary.equity,        value: fmt(summary.equity),              plain: true },
    { label: p.summary.netPnl,        value: fmtSigned(summary.netPnL),        pnl: summary.netPnL, sub: `${netPct >= 0 ? '+' : ''}${netPct.toFixed(2)}%`, highlight: true },
    { label: p.summary.unrealizedPnl, value: fmtSigned(summary.unrealizedPnL), pnl: summary.unrealizedPnL },
    { label: p.summary.realizedPnl,   value: fmtSigned(summary.realizedPnL),   pnl: summary.realizedPnL },
    { label: p.summary.open,          value: String(summary.openCount),        plain: true },
    { label: p.summary.closed,        value: String(summary.closedCount),      plain: true },
  ]
  return (
    <div className="pp-strip">
      <div className="pp-strip-items">
        {items.map((item) => (
          <div key={item.label} className={`pp-strip-item${item.highlight ? ' pp-strip-highlight' : ''}`}>
            <span className="pp-strip-label">{item.label}</span>
            <strong className={item.plain ? '' : (item.pnl ?? 0) >= 0 ? 'pp-profit' : 'pp-loss'}>
              {item.value}
            </strong>
            {item.sub && <em className={(item.pnl ?? 0) >= 0 ? 'pp-profit' : 'pp-loss'}>{item.sub}</em>}
          </div>
        ))}
      </div>
      <div className="pp-strip-actions">
        {summary.dataGaps.length > 0 && (
          <span className="pp-data-gap">{summary.dataGaps.join(' · ')}</span>
        )}
        <button className="pp-reset-btn" type="button" onClick={onReset}>
          <RotateCcw size={12} /> {p.reset}
        </button>
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LABEL_CLS: Record<string, string> = {
  best_fit: 'pp-label-best', aggressive: 'pp-label-aggr',
  conservative: 'pp-label-cons', conditional: 'pp-label-cond',
}

function fmtMaxVal(v?: number | 'unlimited' | 'variable') {
  if (v === 'unlimited') return '∞'
  if (v === 'variable')  return 'Var'
  if (typeof v === 'number') return fmt(v)
  return '—'
}

function StrategyCell({ pos }: { pos: { strategyName: string; strategySnapshot?: { label?: string } } }) {
  const { t } = useT()
  const label = pos.strategySnapshot?.label
  const cls = label ? LABEL_CLS[label] : null
  const text = label ? (t.paper.labels[label] ?? label) : null
  return (
    <div className="pp-strat-cell-inner">
      <span className="pp-strat-name-text">{pos.strategyName}</span>
      {cls && text && <span className={`pp-strat-label ${cls}`}>{text}</span>}
    </div>
  )
}

function DetailRow({ pos, colSpan }: { pos: PaperPosition | PaperPositionRow; colSpan: number }) {
  const { t } = useT()
  const pd = t.paper.detail
  const ss = pos.strategySnapshot
  const be = pos.entrySnapshot.breakevens
  return (
    <tr className="pp-detail-row">
      <td colSpan={colSpan}>
        <div className="pp-detail-inner">
          {ss.whyItFits && (
            <div className="pp-detail-why">
              <span className="pp-detail-label">{pd.whyItFits}</span>
              <span>{ss.whyItFits}</span>
            </div>
          )}
          {ss.beginnerNote && (
            <div className="pp-detail-why">
              <span className="pp-detail-label">{pd.note}</span>
              <span>{ss.beginnerNote}</span>
            </div>
          )}
          <div className="pp-detail-legs-row">
            <span className="pp-detail-label">{pd.legs}</span>
            <div className="pp-legs-inline">
              {pos.legsSnapshot.map((leg, i) => (
                <span key={i} className={leg.action === 'buy' ? 'pp-leg-buy' : 'pp-leg-sell'}>
                  {leg.action === 'buy' ? 'Buy' : 'Sell'} {leg.quantity} {leg.right?.toUpperCase()} ${leg.strike} {fmtDateShort(leg.expiration)}
                  {leg.premium != null ? ` @ $${leg.premium.toFixed(2)}` : ''}
                </span>
              ))}
            </div>
          </div>
          {be.length > 0 && (
            <div className="pp-detail-why">
              <span className="pp-detail-label">{be.length > 1 ? pd.breakevenPlural : pd.breakeven}</span>
              <span>{be.map((v) => fmt(v)).join(' / ')}</span>
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

// ─── Open positions table ─────────────────────────────────────────────────────

function OpenTable({ positions, onClose }: { positions: PaperPositionRow[]; onClose: () => void }) {
  const { t } = useT()
  const pc = t.paper.cols
  const pa = t.paper.actions
  const [closing, setClosing] = useState<string>('')
  const [err, setErr] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<string>('')

  function toggle(id: string) { setExpanded((cur) => cur === id ? '' : id) }

  async function close(e: React.MouseEvent, pos: PaperPositionRow) {
    e.stopPropagation()
    if (!pos.mark?.currentUnderlyingPrice || pos.mark.dataGaps.some((gap) => gap.startsWith('PAPER_TRADE_MARK_GAP'))) {
      setErr((prev) => ({ ...prev, [pos.id]: pa.needsPrice }))
      return
    }
    setClosing(pos.id)
    try {
      await closePaperPosition(pos.id, pos.mark.currentUnderlyingPrice)
      onClose()
    } catch (ex) {
      setErr((prev) => ({ ...prev, [pos.id]: ex instanceof Error ? ex.message : 'Close failed' }))
      setClosing('')
    }
  }

  if (!positions.length) {
    return <p className="pp-empty">{t.paper.empty.open}</p>
  }

  const COLS = 9
  return (
    <div className="pp-table-wrap">
      <table className="pp-table">
        <thead>
          <tr>
            <th>{pc.ticker}</th>
            <th>{pc.strategy}</th>
            <th>{pc.qty}</th>
            <th>{pc.opened}</th>
            <th>{pc.entryValue}</th>
            <th>{pc.currentValue}</th>
            <th>{pc.unrealizedPnl}</th>
            <th>{pc.dte}</th>
            <th>{pc.maxRisk}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {positions.map((pos) => (
            <>
              <tr key={pos.id} className="pp-main-row" onClick={() => toggle(pos.id)}>
                <td><strong className="pp-ticker-sm">{pos.ticker}</strong></td>
                <td><StrategyCell pos={pos} /></td>
                <td>{pos.quantity}</td>
                <td>{fmtDate(pos.openedAt)}</td>
                <td>{fmt(pos.entrySnapshot.strategyValue)}</td>
                <td>{pos.mark ? fmt(pos.mark.currentStrategyValue) : <em className="pp-no-price">—</em>}</td>
                <td>
                  {pos.mark
                    ? <PnL value={pos.mark.unrealizedPnL} pct={`${pos.mark.unrealizedPnLPct >= 0 ? '+' : ''}${pos.mark.unrealizedPnLPct.toFixed(2)}%`} />
                    : <em className="pp-no-price">{pa.needsPrice}</em>}
                </td>
                <td>{pos.mark ? pos.mark.currentDaysLeft : pos.entrySnapshot.daysLeft}</td>
                <td>
                  <span className="pp-risk-trio">
                    <span className="pp-loss">{fmtMaxVal(pos.entrySnapshot.maxLoss)}</span>
                    <span className="pp-muted-sep">/</span>
                    <span className="pp-profit">{fmtMaxVal(pos.strategySnapshot?.maxProfit)}</span>
                    <span className="pp-muted-sep">/</span>
                    <span>{pos.strategySnapshot?.probabilityOfProfit != null ? `${pos.strategySnapshot.probabilityOfProfit.toFixed(0)}%` : '—'}</span>
                  </span>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {err[pos.id] && <span className="pp-inline-error">{err[pos.id]}</span>}
                  <button className="pp-close-btn-sm" type="button" disabled={closing === pos.id || pos.mark?.dataGaps.some((gap) => gap.startsWith('PAPER_TRADE_MARK_GAP'))} onClick={(e) => close(e, pos)}>
                    {closing === pos.id ? '…' : pa.close}
                  </button>
                </td>
              </tr>
              {expanded === pos.id && <DetailRow key={`${pos.id}-detail`} pos={pos} colSpan={COLS + 1} />}
            </>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Closed positions table ───────────────────────────────────────────────────

function ClosedTable({ positions }: { positions: PaperPosition[] }) {
  const { t } = useT()
  const pc = t.paper.cols
  const [expanded, setExpanded] = useState<string>('')
  function toggle(id: string) { setExpanded((cur) => cur === id ? '' : id) }

  if (!positions.length) {
    return <p className="pp-empty">{t.paper.empty.closed}</p>
  }

  const COLS = 8
  return (
    <div className="pp-table-wrap">
      <table className="pp-table">
        <thead>
          <tr>
            <th>{pc.ticker}</th>
            <th>{pc.strategy}</th>
            <th>{pc.qty}</th>
            <th>{pc.opened}</th>
            <th>{pc.closed}</th>
            <th>{pc.entryValue}</th>
            <th>{pc.closeValue}</th>
            <th>{pc.realizedPnl}</th>
            <th>{pc.maxRisk}</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((pos) => (
            <>
              <tr key={pos.id} className="pp-main-row" onClick={() => toggle(pos.id)}>
                <td><strong className="pp-ticker-sm">{pos.ticker}</strong></td>
                <td><StrategyCell pos={pos} /></td>
                <td>{pos.quantity}</td>
                <td>{fmtDate(pos.openedAt)}</td>
                <td>{fmtDate(pos.closedAt)}</td>
                <td>{fmt(pos.entrySnapshot.strategyValue)}</td>
                <td>{pos.closeSnapshot ? fmt(pos.closeSnapshot.strategyValue) : '—'}</td>
                <td>
                  {typeof pos.realizedPnL === 'number'
                    ? <PnL value={pos.realizedPnL} pct={fmtPct(pos.realizedPnL, pos.entrySnapshot.strategyValue)} />
                    : '—'}
                </td>
                <td>
                  <span className="pp-risk-trio">
                    <span className="pp-loss">{fmtMaxVal(pos.entrySnapshot.maxLoss)}</span>
                    <span className="pp-muted-sep">/</span>
                    <span className="pp-profit">{fmtMaxVal(pos.strategySnapshot?.maxProfit)}</span>
                    <span className="pp-muted-sep">/</span>
                    <span>{pos.strategySnapshot?.probabilityOfProfit != null ? `${pos.strategySnapshot.probabilityOfProfit.toFixed(0)}%` : '—'}</span>
                  </span>
                </td>
              </tr>
              {expanded === pos.id && <DetailRow key={`${pos.id}-detail`} pos={pos} colSpan={COLS + 1} />}
            </>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Reset modal ──────────────────────────────────────────────────────────────

function ResetModal({ onConfirm, onCancel }: { onConfirm: (cash: number) => void; onCancel: () => void }) {
  const { t } = useT()
  const p = t.paper
  const [value, setValue] = useState('1000000')
  const num = Number(value.replace(/,/g, ''))
  const invalid = !Number.isFinite(num) || num <= 0
  return (
    <div className="pp-modal-backdrop" onClick={onCancel}>
      <div className="pp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pp-modal-head">
          <h3>{p.resetTitle}</h3>
          <button type="button" onClick={onCancel}><X size={16} /></button>
        </div>
        <p className="pp-modal-warn">{p.resetWarn}</p>
        <label className="pp-modal-label">{p.resetLabel}</label>
        <input className="pp-modal-input" type="number" min="1" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="pp-modal-actions">
          <button type="button" className="pp-modal-cancel" onClick={onCancel}>{p.cancel}</button>
          <button type="button" className="pp-modal-confirm" disabled={invalid} onClick={() => onConfirm(num)}>{p.confirmReset}</button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function PaperPortfolioPage() {
  const { t } = useT()
  const p = t.paper
  const [data, setData] = useState<PaperAccountResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showReset, setShowReset] = useState(false)
  const [tab, setTab] = useState<'open' | 'closed'>('open')

  async function load() {
    setLoading(true); setError('')
    try { setData(await getPaperAccountWithMarketPrices()) }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  async function handleReset(cash: number) {
    setShowReset(false)
    try { await resetPaperAccount(cash); await load() }
    catch (e) { setError(e instanceof Error ? e.message : 'Reset failed') }
  }

  const openPositions  = data?.positions.filter((p) => p.status === 'open')  ?? []
  const closedPositions = data?.positions.filter((p) => p.status === 'closed') ?? []

  return (
    <main className="oa-shell pp-shell">
      <header className="oa-topbar pp-topbar-inner">
        <div className="oa-brand"><strong>Qveris</strong><span>AI</span></div>
        <h2 className="pp-page-title">{p.title}</h2>
        <div className="oa-top-spacer" />
        <button className="pp-refresh-btn" type="button" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'pp-spin' : ''} />
        </button>
      </header>

      <aside className="oa-rail">
        <button type="button" title={t.nav.trade} onClick={() => navigate('')}><LineChart size={20} /></button>
        <button type="button" title={t.nav.learn} onClick={() => navigate('#/learn')}><GraduationCap size={20} /></button>
        <button type="button" className="active" title={t.nav.paper}><Briefcase size={20} /></button>
      </aside>

      <div className="pp-content-area">
        {error && <div className="pp-error-banner">{error}</div>}

        {loading && !data ? (
          <div className="pp-skeleton-wrap">
            {[44, 300, 300].map((h, i) => <div key={i} className="pp-skeleton" style={{ height: h }} />)}
          </div>
        ) : data ? (
          <>
            <SummaryStrip summary={data.summary} onReset={() => setShowReset(true)} />

            <div className="pp-tabs">
              <button className={tab === 'open' ? 'active' : ''} type="button" onClick={() => setTab('open')}>
                {p.tabs.open} <span className="pp-tab-count">{openPositions.length}</span>
              </button>
              <button className={tab === 'closed' ? 'active' : ''} type="button" onClick={() => setTab('closed')}>
                {p.tabs.closed} <span className="pp-tab-count">{closedPositions.length}</span>
              </button>
            </div>

            {tab === 'open'   && <OpenTable  positions={openPositions}  onClose={load} />}
            {tab === 'closed' && <ClosedTable positions={closedPositions as PaperPosition[]} />}
          </>
        ) : null}
      </div>

      {showReset && <ResetModal onConfirm={handleReset} onCancel={() => setShowReset(false)} />}
    </main>
  )
}
