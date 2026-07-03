import { simulateStrategy } from './simulatorEngine.ts'
import { strategyEntryValue } from './payoffEngine.ts'
import type { StrategyCandidate } from '../types/strategyTypes'

export type SimulatorChartPoint = {
  underlyingPrice: number
  daysLeft: number
  daysElapsed: number
  theoreticalValue: number
  entryValue: number
  estimatedPnL: number
  estimatedPnLPct: number
}

export type SimulatorPriceSample = {
  underlyingPrice: number
  estimatedPnL: number
  status: 'profit' | 'loss'
}

export type SimulatorProfitZone = {
  fromPrice: number
  toPrice: number
  status: 'profit' | 'loss'
}

export type SimulatorChartProjection = {
  point: SimulatorChartPoint
  samples: SimulatorPriceSample[]
  zones: SimulatorProfitZone[]
}

export type ActiveSimulatorState = {
  strategyId: string
  projection: SimulatorChartProjection
}

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

function capitalBase(strategy: StrategyCandidate) {
  if (typeof strategy.maxLoss === 'number' && strategy.maxLoss > 0) return strategy.maxLoss
  return Math.abs(strategyEntryValue(strategy.legs))
}

export function buildSimulatorChartProjection({
  strategy,
  underlyingPrice,
  daysLeft,
  daysElapsed = 0,
  minPrice,
  maxPrice,
  samples = 81,
}: {
  strategy: StrategyCandidate
  underlyingPrice: number
  daysLeft: number
  daysElapsed?: number
  minPrice?: number
  maxPrice?: number
  samples?: number
}): SimulatorChartProjection {
  const safeDaysLeft = Math.max(0, daysLeft)
  const safeDaysElapsed = Math.max(0, daysElapsed)
  const base = capitalBase(strategy)
  const pointValue = simulateStrategy(strategy, underlyingPrice, safeDaysLeft)
  const point = {
    underlyingPrice: roundMoney(underlyingPrice),
    daysLeft: safeDaysLeft,
    daysElapsed: safeDaysElapsed,
    theoreticalValue: pointValue.theoreticalValue,
    entryValue: pointValue.entryValue,
    estimatedPnL: pointValue.pl,
    estimatedPnLPct: base ? roundMoney((pointValue.pl / base) * 100) : 0,
  }

  const rawLow = minPrice ?? strategy.expectedMove?.low ?? underlyingPrice * 0.8
  const rawHigh = maxPrice ?? strategy.expectedMove?.high ?? underlyingPrice * 1.2
  const low = Math.min(rawLow, rawHigh)
  const high = Math.max(rawLow, rawHigh)
  const count = Math.max(3, samples)
  const priceSamples = Array.from({ length: count }, (_, index) => {
    const price = low + ((high - low) * index) / (count - 1)
    const estimatedPnL = simulateStrategy(strategy, price, safeDaysLeft).pl
    return {
      underlyingPrice: roundMoney(price),
      estimatedPnL,
      status: estimatedPnL >= 0 ? 'profit' as const : 'loss' as const,
    }
  })

  const zones = priceSamples.reduce<SimulatorProfitZone[]>((items, sample) => {
    const last = items.at(-1)
    if (last && last.status === sample.status) {
      last.toPrice = sample.underlyingPrice
    } else {
      items.push({ fromPrice: sample.underlyingPrice, toPrice: sample.underlyingPrice, status: sample.status })
    }
    return items
  }, [])

  return { point, samples: priceSamples, zones }
}
