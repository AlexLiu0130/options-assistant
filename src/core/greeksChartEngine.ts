import { OPTION_MULTIPLIER } from './payoffEngine.ts'
import type { StrategyCandidate, StrategyLeg } from '../types/strategyTypes'

export type GreeksMetric = 'delta' | 'gamma' | 'theta' | 'vega'

export type GreeksChartPoint = {
  underlyingPrice: number
  value: number
}

export type GreeksChartPanel = {
  metric: GreeksMetric
  label: string
  unit: string
  currentValue: number
  points: GreeksChartPoint[]
}

export type GreeksQuadChart = {
  source: 'model'
  underlyingPrice: number
  daysLeft: number
  marketMetrics: GreeksMetric[]
  panels: GreeksChartPanel[]
  warnings: string[]
}

function round(value: number, digits = 4) {
  return Number(value.toFixed(digits))
}

function normPdf(x: number) {
  return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI)
}

function normCdf(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989423 * Math.exp((-x * x) / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return x > 0 ? 1 - p : p
}

function firstExpirationMs(legs: StrategyLeg[]) {
  return legs
    .map((leg) => new Date(`${leg.expiration}T21:00:00Z`).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0]
}

function legDaysLeft(leg: StrategyLeg, baseDaysLeft: number, firstExpiry?: number) {
  const legExpiry = new Date(`${leg.expiration}T21:00:00Z`).getTime()
  const offset = firstExpiry && Number.isFinite(legExpiry)
    ? Math.max(0, Math.round((legExpiry - firstExpiry) / 86_400_000))
    : 0
  return Math.max(1, baseDaysLeft + offset)
}

function legGreeks(leg: StrategyLeg, price: number, daysLeft: number) {
  const spot = Math.max(price, 0.01)
  const strike = Math.max(leg.strike, 0.01)
  const iv = Math.max(leg.impliedVolatility ?? 0.35, 0.01)
  const years = Math.max(daysLeft, 1) / 365
  const sqrtYears = Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + (iv * iv * years) / 2) / (iv * sqrtYears)
  const delta = leg.right === 'call' ? normCdf(d1) : normCdf(d1) - 1
  const gamma = normPdf(d1) / (spot * iv * sqrtYears)
  const theta = -(spot * normPdf(d1) * iv) / (2 * sqrtYears) / 365
  const vega = spot * normPdf(d1) * sqrtYears * 0.01
  const sign = leg.action === 'buy' ? 1 : -1
  const scale = sign * leg.quantity * OPTION_MULTIPLIER
  return {
    delta: delta * scale,
    gamma: gamma * scale,
    theta: theta * scale,
    vega: vega * scale,
  }
}

function greeksAt(legs: StrategyLeg[], price: number, daysLeft: number) {
  const firstExpiry = firstExpirationMs(legs)
  const totals = legs.reduce(
    (sum, leg) => {
      const g = legGreeks(leg, price, legDaysLeft(leg, daysLeft, firstExpiry))
      return {
        delta: sum.delta + g.delta,
        gamma: sum.gamma + g.gamma,
        theta: sum.theta + g.theta,
        vega: sum.vega + g.vega,
      }
    },
    { delta: 0, gamma: 0, theta: 0, vega: 0 },
  )
  return {
    delta: round(totals.delta),
    gamma: round(totals.gamma),
    theta: round(totals.theta),
    vega: round(totals.vega),
  }
}

function hasMarketGreek(legs: StrategyLeg[], metric: GreeksMetric) {
  const values = legs.map((leg) => leg[metric])
  return values.length > 0 && values.every((value) => typeof value === 'number' && Number.isFinite(value))
}

export function buildGreeksQuadChart({
  strategy,
  underlyingPrice,
  daysLeft,
  minPrice,
  maxPrice,
  samples = 61,
}: {
  strategy: StrategyCandidate
  underlyingPrice: number
  daysLeft: number
  minPrice?: number
  maxPrice?: number
  samples?: number
}): GreeksQuadChart {
  const low = Math.min(minPrice ?? strategy.expectedMove?.low ?? underlyingPrice * 0.8, maxPrice ?? strategy.expectedMove?.high ?? underlyingPrice * 1.2)
  const high = Math.max(minPrice ?? strategy.expectedMove?.low ?? underlyingPrice * 0.8, maxPrice ?? strategy.expectedMove?.high ?? underlyingPrice * 1.2)
  const count = Math.max(5, samples)
  const rows = Array.from({ length: count }, (_, index) => {
    const price = low + ((high - low) * index) / (count - 1)
    return { price: round(price, 2), greeks: greeksAt(strategy.legs, price, Math.max(0, daysLeft)) }
  })
  const current = greeksAt(strategy.legs, underlyingPrice, Math.max(0, daysLeft))
  const panel = (metric: GreeksMetric, label: string, unit: string): GreeksChartPanel => ({
    metric,
    label,
    unit,
    currentValue: current[metric],
    points: rows.map((row) => ({ underlyingPrice: row.price, value: row.greeks[metric] })),
  })
  const metrics: GreeksMetric[] = ['delta', 'gamma', 'theta', 'vega']
  return {
    source: 'model',
    underlyingPrice: round(underlyingPrice, 2),
    daysLeft: Math.max(0, daysLeft),
    marketMetrics: metrics.filter((metric) => hasMarketGreek(strategy.legs, metric)),
    panels: [
      panel('delta', 'Delta', '$ P/L per $1 move'),
      panel('gamma', 'Gamma', 'delta change per $1 move'),
      panel('theta', 'Theta', '$ P/L per day'),
      panel('vega', 'Vega', '$ P/L per +1 IV point'),
    ],
    warnings: ['Model-based teaching estimate; replace with Qveris/Theta Greeks when available.'],
  }
}
