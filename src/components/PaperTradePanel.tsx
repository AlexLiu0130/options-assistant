import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { money } from '../core/dashboardData'
import { closePaperPosition, listPaperPositions, type PaperPositionRow } from '../core/paperTradeApi'

function dt(value?: string) {
  return value ? new Date(value).toLocaleString() : 'Pending'
}

function pnlClass(value?: number) {
  return (value ?? 0) >= 0 ? 'profit' : 'loss'
}

function returnPct(position: PaperPositionRow) {
  if (typeof position.mark?.unrealizedPnLPct === 'number') return position.mark.unrealizedPnLPct
  if (typeof position.realizedPnL !== 'number') return undefined
  const maxLoss = position.entrySnapshot.maxLoss
  const base = typeof maxLoss === 'number' && maxLoss > 0
    ? maxLoss * position.quantity
    : Math.abs(position.entrySnapshot.strategyValue * position.quantity)
  return base ? (position.realizedPnL / base) * 100 : undefined
}

export function PaperTradePanel({
  open,
  onClose,
  currentPrice,
  refreshKey = 0,
}: {
  open: boolean
  onClose: () => void
  currentPrice?: number
  refreshKey?: number
}) {
  const [positions, setPositions] = useState<PaperPositionRow[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    setStatus('loading')
    try {
      const body = await listPaperPositions(currentPrice)
      setPositions(body.positions)
      setMessage('')
      setStatus('idle')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Paper positions unavailable.')
      setStatus('error')
    }
  }, [currentPrice])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh, refreshKey])

  async function close(id: string) {
    if (typeof currentPrice !== 'number') {
      setMessage('Current price is required to close a paper position.')
      return
    }
    setStatus('loading')
    try {
      await closePaperPosition(id, currentPrice)
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Close failed.')
      setStatus('error')
    }
  }

  if (!open) return null

  const openPositions = positions.filter((position) => position.status === 'open')
  const closedPositions = positions.filter((position) => position.status === 'closed')

  return (
    <section className="paper-panel" aria-label="Paper trade positions">
      <header>
        <div>
          <strong>Paper Trade</strong>
          <span>{openPositions.length} open · {closedPositions.length} closed</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close Paper Trade"><X size={17} /></button>
      </header>

      <div className="paper-panel-actions">
        <span>{typeof currentPrice === 'number' ? `Mark ${money(currentPrice)}` : 'Mark price pending'}</span>
        <button disabled={status === 'loading'} type="button" onClick={() => void refresh()}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {message ? <p className={`paper-message ${status === 'error' ? 'error' : ''}`}>{message}</p> : null}

      <div className="paper-list">
        <PaperPositionSection
          currentPrice={currentPrice}
          onClosePosition={close}
          positions={openPositions}
          title="Open positions"
        />
        <PaperPositionSection
          currentPrice={currentPrice}
          onClosePosition={close}
          positions={closedPositions}
          title="Closed positions"
        />
        {!positions.length && status !== 'loading' ? (
          <p className="paper-empty">No paper positions yet. Expand a strategy and submit a paper trade.</p>
        ) : null}
        {status === 'loading' && !positions.length ? <p className="paper-empty">Loading paper positions…</p> : null}
      </div>
    </section>
  )
}

function PaperPositionSection({
  title,
  positions,
  currentPrice,
  onClosePosition,
}: {
  title: string
  positions: PaperPositionRow[]
  currentPrice?: number
  onClosePosition: (id: string) => void
}) {
  if (!positions.length) return null
  return (
    <section className="paper-position-section">
      <h3>{title}</h3>
      {positions.map((position) => {
        const pnl = position.status === 'closed' ? position.realizedPnL : position.mark?.unrealizedPnL
        const pct = returnPct(position)
        return (
          <article key={position.id}>
            <div>
              <strong>{position.strategyName}</strong>
              <span>{position.ticker} · {position.quantity}x · {dt(position.openedAt)}</span>
            </div>
            <dl>
              <div><dt>Entry</dt><dd>{money(position.entrySnapshot.strategyValue)}</dd></div>
              <div><dt>{position.status === 'closed' ? 'Realized' : 'Est. P/L'}</dt><dd className={pnlClass(pnl)}>{typeof pnl === 'number' ? money(pnl) : 'Pending'}</dd></div>
              <div><dt>Return</dt><dd className={pnlClass(pct)}>{typeof pct === 'number' ? `${pct.toFixed(2)}%` : '-'}</dd></div>
            </dl>
            <ul>
              {position.legsSnapshot.map((leg) => (
                <li key={`${position.id}-${leg.action}-${leg.right}-${leg.strike}`}>
                  {leg.action} {leg.quantity} {leg.right} {money(leg.strike)} · {leg.expiration} · {money(leg.premium)}
                </li>
              ))}
            </ul>
            <div className="paper-position-foot">
              <span>
                {position.status === 'closed'
                  ? `Closed ${dt(position.closedAt)}`
                  : typeof currentPrice === 'number'
                    ? `Marked at ${money(currentPrice)}`
                    : 'Current mark pending'}
              </span>
              {position.status === 'open' ? (
                <button type="button" onClick={() => onClosePosition(position.id)}>Close</button>
              ) : null}
            </div>
          </article>
        )
      })}
    </section>
  )
}
