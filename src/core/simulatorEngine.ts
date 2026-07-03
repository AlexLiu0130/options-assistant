import { OPTION_MULTIPLIER, strategyEntryValue } from './payoffEngine.ts'
import type { StrategyCandidate, StrategyLeg } from '../types/strategyTypes'

function normCdf(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989423 * Math.exp((-x * x) / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return x > 0 ? 1 - p : p
}

export function optionTheoreticalPrice(
  leg: StrategyLeg,
  underlyingPrice: number,
  yearsToExpiry: number,
  riskFreeRate = 0.045,
  dividendYield = 0,
) {
  const iv = Math.max(leg.impliedVolatility ?? 0.35, 0)
  const spot = Math.max(underlyingPrice, 0.01)
  const strike = Math.max(leg.strike, 0.01)

  if (yearsToExpiry <= 0) {
    return leg.right === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0)
  }

  const years = Math.max(yearsToExpiry, 1 / 3650)
  if (iv === 0) {
    const discountedSpot = spot * Math.exp(-dividendYield * years)
    const discountedStrike = strike * Math.exp(-riskFreeRate * years)
    return leg.right === 'call'
      ? Math.max(discountedSpot - discountedStrike, 0)
      : Math.max(discountedStrike - discountedSpot, 0)
  }

  const sigma = iv * Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + (riskFreeRate - dividendYield + (iv * iv) / 2) * years) / sigma
  const d2 = d1 - sigma
  if (leg.right === 'call') {
    return spot * Math.exp(-dividendYield * years) * normCdf(d1) - strike * Math.exp(-riskFreeRate * years) * normCdf(d2)
  }
  return strike * Math.exp(-riskFreeRate * years) * normCdf(-d2) - spot * Math.exp(-dividendYield * years) * normCdf(-d1)
}

export function strategyTheoreticalValue(
  legs: StrategyLeg[],
  underlyingPrice: number,
  daysLeft: number,
  multiplier = OPTION_MULTIPLIER,
) {
  const firstExpiry = legs
    .map((leg) => new Date(`${leg.expiration}T21:00:00Z`).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0]
  return Number(
    legs
      .reduce((sum, leg) => {
        const legExpiry = new Date(`${leg.expiration}T21:00:00Z`).getTime()
        const legOffset = firstExpiry && Number.isFinite(legExpiry)
          ? Math.max(0, Math.round((legExpiry - firstExpiry) / 86_400_000))
          : 0
        const years = Math.max(daysLeft + legOffset, 0) / 365
        const value = optionTheoreticalPrice(leg, underlyingPrice, years) * leg.quantity * multiplier
        return sum + (leg.action === 'buy' ? value : -value)
      }, 0)
      .toFixed(2),
  )
}

export function simulateStrategy(strategy: StrategyCandidate, underlyingPrice: number, daysLeft: number) {
  const theoreticalValue = strategyTheoreticalValue(strategy.legs, underlyingPrice, daysLeft)
  const entryValue = strategyEntryValue(strategy.legs)
  return {
    theoreticalValue,
    entryValue,
    pl: Number((theoreticalValue - entryValue).toFixed(2)),
  }
}
