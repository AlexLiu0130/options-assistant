import { useState, useMemo } from 'react'
import { buildGreeksQuadChart, type GreeksChartPanel } from '../core/greeksChartEngine'
import { useT } from '../i18n'
import type { StrategyCandidate } from '../types/strategyTypes'

const W = 220
const H = 96
const PAD = { top: 8, right: 8, bottom: 20, left: 36 }
const INNER_W = W - PAD.left - PAD.right
const INNER_H = H - PAD.top - PAD.bottom

const PANEL_COLORS: Record<string, string> = {
  delta: '#3b82f6',
  gamma: '#8b5cf6',
  theta: '#ef4444',
  vega: '#10b981',
}

// Catmull-Rom → cubic Bezier for smooth curves
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return ''
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(i + 2, pts.length - 1)]
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
  }
  return d
}

function MiniChart({
  panel,
  spotPrice,
  color,
  gradId,
}: {
  panel: GreeksChartPanel
  spotPrice: number
  color: string
  gradId: string
}) {
  const pts = panel.points
  if (!pts.length) return null

  const xs = pts.map((p) => p.underlyingPrice)
  const ys = pts.map((p) => p.value)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const sortedY = [...ys].sort((a, b) => a - b)
  const pick = (p: number) => sortedY[Math.min(sortedY.length - 1, Math.max(0, Math.floor((sortedY.length - 1) * p)))]
  const yP08 = pick(0.08)
  const yP92 = pick(0.92)
  const crossesZero = yP08 < 0 && yP92 > 0
  const minY = Math.min(yP08, panel.currentValue, crossesZero ? 0 : yP08)
  const maxY = Math.max(yP92, panel.currentValue, crossesZero ? 0 : yP92)
  const rangeX = maxX - minX || 1
  const rawRangeY = maxY - minY
  // Add 8% padding to Y so line doesn't hug edges
  const pad = rawRangeY * 0.08 || 0.1
  const yLo = minY - pad
  const yHi = maxY + pad
  const rangeY = yHi - yLo

  const toX = (x: number) => PAD.left + ((x - minX) / rangeX) * INNER_W
  const toY = (y: number) => PAD.top + INNER_H - ((y - yLo) / rangeY) * INNER_H

  const svgPts = pts.map((p) => ({ x: toX(p.underlyingPrice), y: toY(p.value) }))
  const linePath = smoothPath(svgPts)

  const zeroY = toY(0)
  const spotX = toX(Math.max(minX, Math.min(maxX, spotPrice)))
  const spotY = toY(panel.currentValue)

  const fmt = (v: number) => {
    const a = Math.abs(v)
    if (a >= 1000) return `${(v / 1000).toFixed(1)}k`
    if (a >= 100) return v.toFixed(0)
    if (a >= 10) return v.toFixed(1)
    return v.toFixed(2)
  }

  const yTicks = [yLo + rangeY * 0.1, yLo + rangeY * 0.5, yLo + rangeY * 0.9]
  const xLabels = [minX, spotPrice, maxX]

  const fillPath = `${linePath} L${toX(maxX).toFixed(1)},${(PAD.top + INNER_H).toFixed(1)} L${PAD.left},${(PAD.top + INNER_H).toFixed(1)} Z`

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <filter id={`glow-${gradId}`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* zero line */}
      {zeroY >= PAD.top && zeroY <= PAD.top + INNER_H && (
        <line x1={PAD.left} y1={zeroY} x2={PAD.left + INNER_W} y2={zeroY}
          stroke="var(--border)" strokeWidth="0.75" strokeDasharray="3 3" />
      )}

      {/* y-axis ticks */}
      {yTicks.map((v, i) => (
        <text key={i} x={PAD.left - 5} y={toY(v) + 3.5}
          fontSize="7.5" fill="var(--muted)" textAnchor="end" fontFamily="var(--font-mono)" opacity="0.75">
          {fmt(v)}
        </text>
      ))}

      {/* x-axis labels */}
      {xLabels.map((v, i) => {
        const cx = toX(Math.max(minX, Math.min(maxX, v)))
        const anchor = i === 0 ? 'start' : i === 2 ? 'end' : 'middle'
        return (
          <text key={i} x={i === 0 ? PAD.left : i === 2 ? PAD.left + INNER_W : cx}
            y={H - 3} fontSize="7" fill="var(--muted)" textAnchor={anchor}
            fontFamily="var(--font-mono)" opacity="0.65">
            ${Math.round(v)}
          </text>
        )
      })}

      {/* gradient fill */}
      <path d={fillPath} fill={`url(#${gradId})`} />

      {/* main curve */}
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.2"
        strokeLinejoin="round" strokeLinecap="round"
        filter={`url(#glow-${gradId})`} />

      {/* spot price hairline */}
      <line x1={spotX} y1={PAD.top} x2={spotX} y2={PAD.top + INNER_H}
        stroke="var(--muted)" strokeWidth="0.6" strokeDasharray="2 3" opacity="0.6" />

      {/* current value dot — ring style */}
      <circle cx={spotX} cy={spotY} r="4.5" fill="none" stroke={color} strokeWidth="1.5" opacity="0.4" />
      <circle cx={spotX} cy={spotY} r="2.5" fill={color} />
    </svg>
  )
}

export function GreeksQuadChart({
  strategy,
  underlyingPrice,
  expandable = true,
}: {
  strategy: StrategyCandidate
  underlyingPrice?: number
  expandable?: boolean
}) {
  const { t } = useT()
  const g = t.greeks
  const [showSecondary, setShowSecondary] = useState(!expandable)

  const spot = underlyingPrice ?? strategy.expectedMove?.high ?? 100
  const daysLeft = strategy.expectedMove?.dte ?? 30

  const chart = useMemo(() => {
    if (!strategy.legs.length) return null
    return buildGreeksQuadChart({ strategy, underlyingPrice: spot, daysLeft })
  }, [strategy, spot, daysLeft])

  if (!strategy.legs.length) {
    return <p className="gq-no-legs">{g.noLegs}</p>
  }
  if (!chart) return null

  const primary = chart.panels.filter((p) => p.metric === 'delta' || p.metric === 'theta')
  const secondary = chart.panels.filter((p) => p.metric === 'gamma' || p.metric === 'vega')

  const labelFor = (metric: string) =>
    g[metric as 'delta' | 'gamma' | 'theta' | 'vega'] ?? metric.toUpperCase()
  const descFor = (metric: string) =>
    g[`${metric}Desc` as 'deltaDesc' | 'gammaDesc' | 'thetaDesc' | 'vegaDesc'] ?? ''

  const fmtCurrent = (v: number) => {
    const sign = v >= 0 ? '+' : ''
    const a = Math.abs(v)
    if (a >= 1000) return `${sign}${(v / 1000).toFixed(2)}k`
    if (a >= 100) return `${sign}${v.toFixed(1)}`
    return `${sign}${v.toFixed(3)}`
  }

  function PanelCard({ panel, idx }: { panel: GreeksChartPanel; idx: number }) {
    const color = PANEL_COLORS[panel.metric]
    const gradId = `gq-grad-${panel.metric}-${idx}`
    return (
      <div className="gq-panel" style={{ '--panel-color': color } as React.CSSProperties}>
        <div className="gq-panel-head">
          <span className="gq-metric-name" style={{ color }}>{labelFor(panel.metric)}</span>
          <span className="gq-current-val" style={{ color }}>{fmtCurrent(panel.currentValue)}</span>
        </div>
        <div className="gq-desc">{descFor(panel.metric)}</div>
        <MiniChart panel={panel} spotPrice={spot} color={color} gradId={gradId} />
      </div>
    )
  }

  return (
    <div className="gq-wrap">
      <div className="gq-header">
        <span className="gq-title">{g.title}</span>
        <span className="gq-model-badge">{g.modelBadge}</span>
      </div>
      <div className="gq-grid">
        {primary.map((p, i) => <PanelCard key={p.metric} panel={p} idx={i} />)}
        {showSecondary && secondary.map((p, i) => <PanelCard key={p.metric} panel={p} idx={i + 2} />)}
      </div>
      {expandable && (
        <button type="button" className="gq-toggle" onClick={() => setShowSecondary((v) => !v)}>
          {showSecondary ? g.hideAll : g.showAll}
        </button>
      )}
    </div>
  )
}
