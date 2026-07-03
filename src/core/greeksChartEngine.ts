import { strategyTheoreticalValue } from './simulatorEngine.ts'
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
  panels: GreeksChartPanel[]
  warnings: string[]
}

function round(value: number, digits = 4) {
  return Number(value.toFixed(digits))
}

function withIvShift(legs: StrategyLeg[], shift: number) {
  return legs.map((leg) => ({
    ...leg,
    impliedVolatility: Math.max((leg.impliedVolatility ?? 0.35) + shift, 0.01),
  }))
}

function greeksAt(legs: StrategyLeg[], price: number, daysLeft: number) {
  const step = Math.max(price * 0.01, 0.5)
  const value = strategyTheoreticalValue(legs, price, daysLeft)
  const up = strategyTheoreticalValue(legs, price + step, daysLeft)
  const down = strategyTheoreticalValue(legs, Math.max(price - step, 0.01), daysLeft)
  return {
    delta: round((up - down) / (2 * step)),
    gamma: round((up - 2 * value + down) / (step * step)),
    theta: round(daysLeft > 0 ? strategyTheoreticalValue(legs, price, daysLeft - 1) - value : 0),
    vega: round(strategyTheoreticalValue(withIvShift(legs, 0.01), price, daysLeft) - value),
  }
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
  return {
    source: 'model',
    underlyingPrice: round(underlyingPrice, 2),
    daysLeft: Math.max(0, daysLeft),
    panels: [
      panel('delta', 'Delta', '$ P/L per $1 move'),
      panel('gamma', 'Gamma', 'delta change per $1 move'),
      panel('theta', 'Theta', '$ P/L per day'),
      panel('vega', 'Vega', '$ P/L per +1 IV point'),
    ],
    warnings: ['Model-based estimate for UI testing; replace with Qveris/Theta Greeks when available.'],
  }
}
