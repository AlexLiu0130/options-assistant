import type { QverisCandle, QverisMarketSnapshot, QverisOptionContract } from '../types/optionTypes'
import type { StrategyCandidate } from '../types/strategyTypes'
import { payoffSeries, strategyExpirationPayoff } from './payoffEngine.ts'
import { riskRows } from './riskChecklistEngine.ts'
import { scenarioRows } from './scenarioEngine.ts'

export function money(value?: number | null) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Pending'
  return `$${value.toFixed(2)}`
}

export function price(value?: number | null) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-'
  return value.toFixed(2)
}

export function strike(value?: number | null) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export function number(value?: number | null) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Pending'
  return value.toLocaleString()
}

export function percent(value?: number | null) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Pending'
  return `${value.toFixed(2)}%`
}

export { payoffSeries, riskRows, scenarioRows }

export function strategyPayoff(strategy: StrategyCandidate, underlyingPrice: number) {
  return strategyExpirationPayoff(strategy.legs, underlyingPrice)
}

function hasUsableQuote(contract: QverisOptionContract) {
  return (
    (typeof contract.bid === 'number' &&
      typeof contract.ask === 'number' &&
      contract.ask > 0 &&
      contract.ask >= contract.bid) ||
    (typeof contract.last === 'number' && contract.last > 0)
  )
}

export function optionExpirations(contracts: QverisOptionContract[]) {
  const quoted = contracts.filter(hasUsableQuote)
  const source = quoted.length ? quoted : contracts
  return [...new Set(source.map((contract) => contract.expiration).filter(Boolean))].sort()
}

export function optionChainRows(
  contracts: QverisOptionContract[],
  expiration?: string,
  selectedStrategy?: StrategyCandidate,
) {
  const expirations = [...new Set(contracts.map((contract) => contract.expiration))].sort()
  const expiry = expiration ?? expirations[0]
  if (!expiry) return []
  const calls = contracts.filter((item) => item.expiration === expiry && item.right === 'call')
  const puts = contracts.filter((item) => item.expiration === expiry && item.right === 'put')
  const strikes = [...new Set([...calls, ...puts].map((item) => item.strike).filter(Boolean))].sort(
    (a, b) => (a ?? 0) - (b ?? 0),
  )

  return strikes.map((strike) => {
    const call = calls.find((item) => item.strike === strike)
    const put = puts.find((item) => item.strike === strike)
    const callLeg = selectedStrategy?.legs.find(
      (leg) => leg.expiration === expiry && leg.right === 'call' && leg.strike === strike,
    )
    const putLeg = selectedStrategy?.legs.find(
      (leg) => leg.expiration === expiry && leg.right === 'put' && leg.strike === strike,
    )
    return {
      strike,
      selectedStrike: Boolean(callLeg || putLeg),
      callBid: call?.bid,
      callAsk: call?.ask,
      callDelta: call?.delta,
      callIv: call?.impliedVolatility ? call.impliedVolatility * 100 : null,
      callVolume: call?.volume,
      callOi: call?.openInterest,
      callBidAction: callLeg?.action === 'sell' ? 'sell' : undefined,
      callAskAction: callLeg?.action === 'buy' ? 'buy' : undefined,
      putBid: put?.bid,
      putAsk: put?.ask,
      putDelta: put?.delta,
      putIv: put?.impliedVolatility ? put.impliedVolatility * 100 : null,
      putVolume: put?.volume,
      putOi: put?.openInterest,
      putBidAction: putLeg?.action === 'sell' ? 'sell' : undefined,
      putAskAction: putLeg?.action === 'buy' ? 'buy' : undefined,
    }
  })
}

export function marketCandles(market?: QverisMarketSnapshot): QverisCandle[] {
  if (market?.candles?.length) return market.candles
  if (
    typeof market?.price === 'number' &&
    typeof market.open === 'number' &&
    typeof market.high === 'number' &&
    typeof market.low === 'number'
  ) {
    return [
      {
        time: market.asOf.slice(0, 10),
        open: market.open,
        high: market.high,
        low: market.low,
        close: market.price,
        volume: market.volume,
      },
    ]
  }
  return []
}
