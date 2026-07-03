import type { StrategyCandidate, StrategyLeg } from '../types/strategyTypes'

export const OPTION_MULTIPLIER = 100

export function legIntrinsicValue(leg: StrategyLeg, underlyingPrice: number) {
  if (leg.right === 'call') return Math.max(underlyingPrice - leg.strike, 0)
  return Math.max(leg.strike - underlyingPrice, 0)
}

export function legExpirationPayoff(
  leg: StrategyLeg,
  underlyingPrice: number,
  multiplier = OPTION_MULTIPLIER,
) {
  const intrinsic = legIntrinsicValue(leg, underlyingPrice)
  const premium = leg.premium ?? 0
  const signed = leg.action === 'buy' ? intrinsic - premium : premium - intrinsic
  return signed * leg.quantity * multiplier
}

export function strategyExpirationPayoff(
  legs: StrategyLeg[],
  underlyingPrice: number,
  multiplier = OPTION_MULTIPLIER,
) {
  return Number(
    legs.reduce((sum, leg) => sum + legExpirationPayoff(leg, underlyingPrice, multiplier), 0).toFixed(2),
  )
}

export function strategyEntryValue(legs: StrategyLeg[], multiplier = OPTION_MULTIPLIER) {
  return Number(
    legs
      .reduce((sum, leg) => {
        const value = (leg.premium ?? 0) * leg.quantity * multiplier
        return sum + (leg.action === 'buy' ? value : -value)
      }, 0)
      .toFixed(2),
  )
}

export function payoffSeries(strategies: StrategyCandidate[], spot: number) {
  if (!spot) return []
  const min = spot * 0.78
  const max = spot * 1.22
  return strategies.flatMap((strategy) =>
    Array.from({ length: 64 }, (_, index) => {
      const underlyingPrice = min + ((max - min) * index) / 63
      return {
        strategy: strategy.name,
        underlyingPrice: Number(underlyingPrice.toFixed(2)),
        pl: strategy.legs.length ? strategyExpirationPayoff(strategy.legs, underlyingPrice) : 0,
      }
    }),
  )
}
