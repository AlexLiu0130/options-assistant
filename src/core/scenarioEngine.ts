import { strategyExpirationPayoff } from './payoffEngine.ts'
import type { ParsedView, ScenarioRow, StrategyCandidate, StrategyLeg } from '../types/strategyTypes'

export function scenarioTargetPrice(view: ParsedView) {
  if (view.target_price && view.view === 'bullish' && view.target_price > view.current_price) {
    return view.target_price
  }
  if (view.target_price && view.view === 'bearish' && view.target_price < view.current_price) {
    return view.target_price
  }
  if (view.target_price && (view.view === 'neutral' || view.view === 'volatile')) return view.target_price
  if (view.view === 'bearish') return Number((view.current_price * 0.93).toFixed(2))
  if (view.view === 'bullish') return Number((view.current_price * 1.07).toFixed(2))
  return view.current_price
}

export function buildScenarioRows(
  view: ParsedView,
  legs: StrategyLeg[],
  breakeven?: number,
): ScenarioRow[] {
  const target = scenarioTargetPrice(view)
  const prices = [
    { label: 'Below plan', price: view.current_price * 0.92, meaning: 'Stress case below the current setup.' },
    {
      label: 'Near breakeven',
      price: breakeven ?? view.current_price,
      meaning: 'Area where payoff turns from loss to profit at expiration.',
    },
    { label: 'Target case', price: target, meaning: 'User target or generated base scenario.' },
  ]

  return prices.map((row) => ({
    label: row.label,
    underlyingPrice: Number(row.price.toFixed(2)),
    estimatedPl: strategyExpirationPayoff(legs, row.price),
    meaning: row.meaning,
  }))
}

export function scenarioRows(strategies: StrategyCandidate[]) {
  return strategies.flatMap((strategy) =>
    (strategy.scenarioRows ?? []).map((row) => ({
      strategy: strategy.name,
      scenario: row.label,
      underlyingPrice: row.underlyingPrice,
      estimatedPl: row.estimatedPl,
      meaning: row.meaning,
    })),
  )
}
