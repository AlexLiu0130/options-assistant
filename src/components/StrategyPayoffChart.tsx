import { useMemo } from 'react'
import { strategyExpirationPayoff } from '../core/payoffEngine'
import { useT } from '../i18n'
import type { StrategyLeg } from '../types/strategyTypes'

const W = 420
const H = 180
const PAD = { top: 10, right: 14, bottom: 26, left: 54 }
const INNER_W = W - PAD.left - PAD.right
const INNER_H = H - PAD.top - PAD.bottom
const SAMPLES = 80

function fmt(v: number) {
  const sign = v > 0 ? '+' : v < 0 ? '-' : ''
  const a = Math.abs(v)
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(1)}k`
  return `${sign}$${a.toFixed(0)}`
}

export function StrategyPayoffChart({ legs, isVariable, isSimplified, breakeven }: {
  legs: StrategyLeg[]
  isVariable?: boolean
  isSimplified?: boolean
  breakeven: string
}) {
  const { t } = useT()
  const l = t.learn
  const isStaticPayoffAvailable = legs.length > 0 && !isVariable && !isSimplified

  const chart = useMemo(() => {
    if (!isStaticPayoffAvailable) return null
    const strikes = [...legs.map((leg) => leg.strike)].sort((a, b) => a - b)
    const mid = strikes.length % 2 === 0
      ? (strikes[strikes.length / 2 - 1] + strikes[strikes.length / 2]) / 2
      : strikes[(strikes.length - 1) / 2]
    const minPrice = mid * 0.75
    const maxPrice = mid * 1.25
    const prices = Array.from({ length: SAMPLES }, (_, i) => minPrice + ((maxPrice - minPrice) * i) / (SAMPLES - 1))
    const values = prices.map((price) => strategyExpirationPayoff(legs, price))

    const minY = Math.min(...values, 0)
    const maxY = Math.max(...values, 0)
    const pad = (maxY - minY) * 0.1 || 1
    const yLo = minY - pad
    const yHi = maxY + pad
    const rangeY = yHi - yLo || 1

    const toX = (price: number) => PAD.left + ((price - minPrice) / (maxPrice - minPrice)) * INNER_W
    const toY = (value: number) => PAD.top + INNER_H - ((value - yLo) / rangeY) * INNER_H

    const pts = prices.map((price, i) => ({ x: toX(price), value: values[i] }))
    const zY = toY(0)

    let line = `M${pts[0].x.toFixed(1)},${toY(pts[0].value).toFixed(1)}`
    for (let i = 1; i < pts.length; i++) line += ` L${pts[i].x.toFixed(1)},${toY(pts[i].value).toFixed(1)}`

    function areaPath(sign: 1 | -1) {
      const ys = pts.map((p) => (p.value * sign >= 0 ? toY(p.value) : zY))
      let d = `M${pts[0].x.toFixed(1)},${ys[0].toFixed(1)}`
      for (let i = 1; i < pts.length; i++) d += ` L${pts[i].x.toFixed(1)},${ys[i].toFixed(1)}`
      d += ` L${pts[pts.length - 1].x.toFixed(1)},${zY.toFixed(1)} L${pts[0].x.toFixed(1)},${zY.toFixed(1)} Z`
      return d
    }

    const spotValue = strategyExpirationPayoff(legs, mid)

    return {
      linePath: line,
      greenArea: areaPath(1),
      redArea: areaPath(-1),
      zeroY: zY,
      xLabels: [minPrice, mid, maxPrice].map((price) => ({ price, x: toX(price) })),
      yTicks: [yLo + rangeY * 0.15, 0, yHi - rangeY * 0.15].map((value) => ({ value, y: toY(value) })),
      spotX: toX(mid),
      spotY: toY(spotValue),
      spotPrice: mid,
      spotValue,
    }
  }, [legs, isStaticPayoffAvailable])

  return (
    <div className="payoff-mini">
      {isVariable && <div className="payoff-mini-badge">{l.variableNote}</div>}
      {isSimplified && <div className="payoff-mini-badge payoff-mini-badge-simplified">{l.simplifiedNote}</div>}
      {chart ? (
        <>
          <div className="payoff-mini-head">
            <span className="payoff-mini-model-badge">{l.payoffYAxis}</span>
            <span className={`payoff-mini-current-val ${chart.spotValue >= 0 ? 'profit' : 'loss'}`}>
              {l.payoffAtPrice(Math.round(chart.spotPrice).toString())}: {fmt(chart.spotValue)}
            </span>
          </div>
          <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
            <defs>
              <linearGradient id="payoff-grad-green" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--profit)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--profit)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="payoff-grad-red" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="var(--loss)" stopOpacity="0.24" />
                <stop offset="100%" stopColor="var(--loss)" stopOpacity="0" />
              </linearGradient>
              <filter id="payoff-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="1.6" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            <line x1={PAD.left} y1={chart.zeroY} x2={PAD.left + INNER_W} y2={chart.zeroY}
              stroke="var(--border)" strokeWidth="1" strokeDasharray="3 3" />

            {chart.yTicks.map((tick, i) => (
              <text key={i} x={PAD.left - 8} y={tick.y + 3.5} fontSize="9" fill="var(--muted)"
                textAnchor="end" fontFamily="var(--font-mono)" opacity="0.8">
                {fmt(tick.value)}
              </text>
            ))}

            {chart.xLabels.map((label, i) => (
              <text key={i} x={label.x} y={H - 6} fontSize="9" fill="var(--muted)"
                textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} fontFamily="var(--font-mono)" opacity="0.75">
                ${Math.round(label.price)}
              </text>
            ))}

            <path d={chart.greenArea} fill="url(#payoff-grad-green)" />
            <path d={chart.redArea} fill="url(#payoff-grad-red)" />
            <path d={chart.linePath} fill="none" stroke="var(--accent)" strokeWidth="1.6"
              strokeLinejoin="round" strokeLinecap="round" filter="url(#payoff-glow)" />

            <line x1={chart.spotX} y1={PAD.top} x2={chart.spotX} y2={PAD.top + INNER_H}
              stroke="var(--muted)" strokeWidth="0.6" strokeDasharray="2 3" opacity="0.6" />
            <circle cx={chart.spotX} cy={chart.spotY} r="5" fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.4" />
            <circle cx={chart.spotX} cy={chart.spotY} r="2.8" fill="var(--accent)" />
          </svg>
        </>
      ) : (
        <div className="payoff-mini-placeholder">{l.payoffStaticUnavailable}</div>
      )}
      <div className="payoff-mini-footer">
        <span>{l.payoffXAxis}</span>
        <span className="payoff-mini-breakeven">{l.breakeven}: {breakeven}</span>
      </div>
    </div>
  )
}
