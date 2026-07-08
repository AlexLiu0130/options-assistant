import type { QverisOptionContract, QverisOptionsResponse } from '../types/optionTypes'
import type { ParsedView, StrategyCandidate, StrategyLeg } from '../types/strategyTypes'
import { strategyExpirationPayoff, strategyEntryValue } from './payoffEngine.ts'
import { buildScenarioRows, scenarioTargetPrice } from './scenarioEngine.ts'
import { buildSimulatorChartProjection, type SimulatorChartProjection } from './simulatorChartEngine.ts'
import { buildGreeksQuadChart, type GreeksQuadChart } from './greeksChartEngine.ts'
import { buildRiskChecklist, type RiskChecklistRow } from './riskChecklistEngine.ts'
import { probabilityOfProfit } from './strategyRecommendationEngine.ts'

export type StrategyLegAdjustment = {
  legIndex: number
  expiration?: string
  strike?: number
  quantity?: number
}

export type StrategyAdjustmentResult = {
  strategy?: StrategyCandidate
  riskChecklist?: RiskChecklistRow[]
  simulatorProjection?: SimulatorChartProjection
  greeksQuadChart?: GreeksQuadChart
  errors: string[]
  warnings: string[]
}

function mid(contract: QverisOptionContract) {
  if (
    typeof contract.bid === 'number' &&
    typeof contract.ask === 'number' &&
    contract.bid >= 0 &&
    contract.ask > 0 &&
    contract.ask >= contract.bid
  ) {
    return Number(((contract.bid + contract.ask) / 2).toFixed(2))
  }
  return typeof contract.last === 'number' && contract.last > 0 ? contract.last : undefined
}

function contractFor(options: QverisOptionsResponse, leg: StrategyLeg) {
  return options.contracts.find(
    (contract) =>
      contract.right === leg.right &&
      contract.expiration === leg.expiration &&
      contract.strike === leg.strike &&
      mid(contract) !== undefined,
  )
}

function withContract(leg: StrategyLeg, contract: QverisOptionContract): StrategyLeg {
  return {
    ...leg,
    premium: mid(contract),
    impliedVolatility: contract.impliedVolatility ?? leg.impliedVolatility,
    symbol: contract.symbol,
  }
}

function payoffBounds(legs: StrategyLeg[], spot: number, base: StrategyCandidate) {
  const strikes = legs.map((leg) => leg.strike).filter(Number.isFinite)
  const high = Math.max(spot * 2, ...(strikes.map((strike) => strike * 1.5)))
  const prices = [...new Set([0.01, spot, high, ...strikes])].sort((a, b) => a - b)
  const payoffs = prices.map((price) => strategyExpirationPayoff(legs, price))
  const min = Math.min(...payoffs)
  const max = Math.max(...payoffs)
  return {
    maxLoss: base.maxLoss === 'unlimited' || base.maxLoss === 'variable' ? base.maxLoss : Number(Math.max(0, -min).toFixed(0)),
    maxProfit: base.maxProfit === 'unlimited' || base.maxProfit === 'variable' ? base.maxProfit : Number(Math.max(0, max).toFixed(0)),
  }
}

function breakevens(legs: StrategyLeg[], spot: number) {
  const strikes = legs.map((leg) => leg.strike).filter(Number.isFinite)
  const low = 0.01
  const high = Math.max(spot * 2, ...(strikes.map((strike) => strike * 1.5)))
  const count = 300
  const results: number[] = []
  let previousPrice = low
  let previousPayoff = strategyExpirationPayoff(legs, previousPrice)
  for (let index = 1; index <= count; index += 1) {
    const price = low + ((high - low) * index) / count
    const payoff = strategyExpirationPayoff(legs, price)
    if (previousPayoff === 0) results.push(previousPrice)
    if (previousPayoff * payoff < 0) {
      const ratio = Math.abs(previousPayoff) / (Math.abs(previousPayoff) + Math.abs(payoff))
      results.push(previousPrice + (price - previousPrice) * ratio)
    }
    previousPrice = price
    previousPayoff = payoff
  }
  return [...new Set(results.map((price) => Number(price.toFixed(2))))].slice(0, 4)
}

function daysToEarliestExpiry(legs: StrategyLeg[]) {
  const expiries = legs
    .map((leg) => new Date(`${leg.expiration}T21:00:00Z`).getTime())
    .filter(Number.isFinite)
  if (!expiries.length) return 30
  return Math.max(1, Math.round((Math.min(...expiries) - Date.now()) / 86_400_000))
}

function averageIv(legs: StrategyLeg[], fallback: number) {
  const ivs = legs.map((leg) => leg.impliedVolatility).filter((iv): iv is number => typeof iv === 'number' && iv > 0)
  return ivs.length ? ivs.reduce((sum, iv) => sum + iv, 0) / ivs.length : fallback
}

function expectedMoveFor(spot: number, iv: number, dte: number) {
  const move = spot * iv * Math.sqrt(dte / 365)
  return {
    low: Number((spot - move).toFixed(2)),
    high: Number((spot + move).toFixed(2)),
    impliedVolatility: Number(iv.toFixed(4)),
    dte,
  }
}

export function adjustStrategyLegs({
  baseStrategy,
  optionChain,
  view,
  adjustments,
}: {
  baseStrategy: StrategyCandidate
  optionChain: QverisOptionsResponse
  view: ParsedView
  adjustments: StrategyLegAdjustment[]
}): StrategyAdjustmentResult {
  const errors: string[] = []
  const warnings: string[] = []
  if (optionChain.status !== 'available') errors.push('OPTION_CHAIN_UNAVAILABLE')
  const nextLegs = baseStrategy.legs.map((leg) => ({ ...leg }))

  for (const adjustment of adjustments) {
    const leg = nextLegs[adjustment.legIndex]
    if (!leg) {
      errors.push(`INVALID_LEG_INDEX:${adjustment.legIndex}`)
      continue
    }
    if (adjustment.quantity !== undefined && (!Number.isInteger(adjustment.quantity) || adjustment.quantity < 1 || adjustment.quantity > 20)) {
      errors.push(`INVALID_QUANTITY:${adjustment.legIndex}`)
      continue
    }
    nextLegs[adjustment.legIndex] = {
      ...leg,
      expiration: adjustment.expiration ?? leg.expiration,
      strike: adjustment.strike ?? leg.strike,
      quantity: adjustment.quantity ?? leg.quantity,
    }
  }

  const pricedLegs = nextLegs.map((leg, index) => {
    const contract = contractFor(optionChain, leg)
    if (!contract) {
      errors.push(`CONTRACT_NOT_FOUND:${index}`)
      return leg
    }
    return withContract(leg, contract)
  })
  if (errors.length) return { errors, warnings }

  const netDebitCredit = Number((strategyEntryValue(pricedLegs) / 100).toFixed(2))
  const bounds = payoffBounds(pricedLegs, view.current_price, baseStrategy)
  const nextBreakevens = breakevens(pricedLegs, view.current_price)
  const primaryBreakeven = nextBreakevens[0]
  const daysLeft = daysToEarliestExpiry(pricedLegs)
  const impliedVolatility = averageIv(pricedLegs, baseStrategy.expectedMove?.impliedVolatility ?? 0.35)
  if (!nextBreakevens.length) warnings.push('NO_BREAKEVEN_IN_MODELED_RANGE')

  const strategy: StrategyCandidate = {
    ...baseStrategy,
    legs: pricedLegs,
    netDebitCredit,
    maxLoss: bounds.maxLoss,
    maxProfit: bounds.maxProfit,
    breakeven: primaryBreakeven,
    breakevens: nextBreakevens,
    probabilityOfProfit: probabilityOfProfit(pricedLegs, view.current_price, impliedVolatility, daysLeft),
    expectedMove: expectedMoveFor(view.current_price, impliedVolatility, daysLeft),
    targetPricePl: strategyExpirationPayoff(pricedLegs, scenarioTargetPrice(view)),
    scenarioRows: buildScenarioRows(view, pricedLegs, primaryBreakeven),
  }
  return {
    strategy,
    riskChecklist: buildRiskChecklist(strategy),
    simulatorProjection: buildSimulatorChartProjection({ strategy, underlyingPrice: view.current_price, daysLeft }),
    greeksQuadChart: buildGreeksQuadChart({ strategy, underlyingPrice: view.current_price, daysLeft }),
    errors,
    warnings,
  }
}
