import { strategyEntryValue, strategyExpirationPayoff } from './payoffEngine.ts'
import { strategyTheoreticalValue } from './simulatorEngine.ts'
import type { PaperOrder, PaperPosition, PaperPositionMark, PaperTradeFillSnapshot } from '../types/paperTradeTypes'
import type { StrategyCandidate, StrategyLeg } from '../types/strategyTypes'

const PAPER_TRADE_WARNING = 'This is a simulated paper trade, not a real brokerage order.'
const PAPER_TRADE_THEORETICAL_MARK_WARNING =
  'Paper positions are marked with a theoretical model from the underlying price, not live tradable option quotes.'
const PAPER_TRADE_FEE_DISCLOSURE =
  'IBKR-like US options fee estimate: $0.65/contract with $1.00 minimum, plus estimated ORF/OCC/CAT/SEC/TAF where applicable. Slippage is not modeled.'
const OPTION_COMMISSION_PER_CONTRACT = 0.65
const OPTION_MIN_COMMISSION_PER_ORDER = 1
const ORF_PER_CONTRACT = 0.02295
const OCC_PER_CONTRACT = 0.025
const CAT_PER_CONTRACT = 0.0003
const SEC_SALE_RATE = 0.0000206
const FINRA_TAF_PER_SELL_CONTRACT = 0.00329

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

function isoNow(now = Date.now()) {
  return new Date(now).toISOString()
}

function easternParts(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(now))
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

export function isUsOptionsRegularTradingHours(now = Date.now()) {
  const parts = easternParts(now)
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60
}

function daysUntil(expiration: string, now = Date.now()) {
  const end = new Date(`${expiration}T21:00:00Z`).getTime()
  if (!Number.isFinite(end)) return 0
  return Math.max(0, Math.ceil((end - now) / (24 * 60 * 60 * 1000)))
}

export function daysUntilEarliestLegExpiration(legs: StrategyLeg[], now = Date.now()) {
  if (!legs.length) return 0
  return Math.min(...legs.map((leg) => daysUntil(leg.expiration, now)))
}

function breakevens(strategy: StrategyCandidate) {
  return strategy.breakevens?.length
    ? strategy.breakevens
    : typeof strategy.breakeven === 'number'
      ? [strategy.breakeven]
      : []
}

function paperId(_prefix: string, _now: number) {
  return crypto.randomUUID()
}

function estimateExpirationRisk(legs: StrategyLeg[]) {
  const expirations = new Set(legs.map((leg) => leg.expiration))
  if (expirations.size !== 1) return { maxLoss: 'variable' as const, maxProfit: 'variable' as const }
  const callSlope = legs
    .filter((leg) => leg.right === 'call')
    .reduce((sum, leg) => sum + (leg.action === 'buy' ? 1 : -1) * leg.quantity, 0)
  const strikes = [...new Set(legs.map((leg) => leg.strike).filter(Number.isFinite))]
    .sort((a, b) => a - b)
  const payoffs = [0, ...strikes].map((price) => strategyExpirationPayoff(legs, price))
  const minPayoff = Math.min(...payoffs)
  const maxPayoff = Math.max(...payoffs)
  return {
    maxLoss: callSlope < 0 ? 'unlimited' as const : roundMoney(Math.max(0, -minPayoff)),
    maxProfit: callSlope > 0 ? 'unlimited' as const : roundMoney(Math.max(0, maxPayoff)),
  }
}

function capitalBase(position: PaperPosition) {
  const maxLoss = position.entrySnapshot.maxLoss
  if (typeof maxLoss === 'number' && maxLoss > 0) return maxLoss * position.quantity
  return Math.abs(position.entrySnapshot.strategyValue * position.quantity) || Math.abs(strategyEntryValue(position.legsSnapshot))
}

export function estimateIbkrUsOptionsFees(legs: StrategyLeg[], quantity = 1, side: 'open' | 'close' = 'open') {
  const contractCount = legs.reduce((sum, leg) => sum + leg.quantity * quantity, 0)
  const sellValue = legs
    .filter((leg) => (side === 'open' ? leg.action === 'sell' : leg.action === 'buy'))
    .reduce((sum, leg) => sum + (leg.premium ?? 0) * leg.quantity * quantity * 100, 0)
  const sellContracts = legs
    .filter((leg) => (side === 'open' ? leg.action === 'sell' : leg.action === 'buy'))
    .reduce((sum, leg) => sum + leg.quantity * quantity, 0)
  const commission = Math.max(OPTION_MIN_COMMISSION_PER_ORDER, contractCount * OPTION_COMMISSION_PER_CONTRACT)
  const thirdParty =
    contractCount * (ORF_PER_CONTRACT + OCC_PER_CONTRACT + CAT_PER_CONTRACT) +
    sellValue * SEC_SALE_RATE +
    sellContracts * FINRA_TAF_PER_SELL_CONTRACT
  return {
    commission: roundMoney(commission),
    thirdParty: roundMoney(thirdParty),
    total: roundMoney(commission + thirdParty),
    model: 'ibkr_us_options_estimate' as const,
    disclosure: PAPER_TRADE_FEE_DISCLOSURE,
  }
}

export function validatePaperStrategy(strategy: StrategyCandidate, underlyingPrice?: number, now = Date.now()) {
  const gaps: string[] = []
  if (!isUsOptionsRegularTradingHours(now)) {
    gaps.push('PAPER_TRADE_MARKET_CLOSED: US equity options paper orders are limited to regular trading hours, 09:30-16:00 ET on weekdays.')
  }
  if (!strategy.legs.length) gaps.push('PAPER_TRADE_DATA_GAP: strategy has no legs.')
  if (typeof underlyingPrice !== 'number' || !Number.isFinite(underlyingPrice) || underlyingPrice <= 0) {
    gaps.push('PAPER_TRADE_DATA_GAP: current underlying price is missing.')
  }
  for (const leg of strategy.legs) {
    if (leg.action !== 'buy' && leg.action !== 'sell') gaps.push('PAPER_TRADE_INVALID_CONTRACT: leg action must be buy or sell.')
    if (leg.right !== 'call' && leg.right !== 'put') gaps.push('PAPER_TRADE_INVALID_CONTRACT: leg right must be call or put.')
    if (!Number.isInteger(leg.quantity) || leg.quantity < 1) gaps.push(`PAPER_TRADE_INVALID_CONTRACT: ${leg.right} ${leg.strike} quantity must be a positive integer.`)
    if (typeof leg.strike !== 'number' || !Number.isFinite(leg.strike) || leg.strike <= 0) gaps.push('PAPER_TRADE_INVALID_CONTRACT: leg strike must be a positive number.')
    if (typeof leg.premium !== 'number' || !Number.isFinite(leg.premium) || leg.premium <= 0) {
      gaps.push(`PAPER_TRADE_DATA_GAP: ${leg.right} ${leg.strike} premium is missing.`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(leg.expiration)) gaps.push(`PAPER_TRADE_DATA_GAP: ${leg.right} ${leg.strike} expiration is missing.`)
    if (leg.expiration && daysUntil(leg.expiration, now) <= 0) {
      gaps.push(`PAPER_TRADE_INVALID_CONTRACT: ${leg.right} ${leg.strike} is expired.`)
    }
  }
  return gaps
}

export function buildPaperFillSnapshot({
  strategy,
  underlyingPrice,
  quantity = 1,
  now = Date.now(),
}: {
  strategy: StrategyCandidate
  underlyingPrice: number
  quantity?: number
  now?: number
}): PaperTradeFillSnapshot {
  const daysLeft = daysUntilEarliestLegExpiration(strategy.legs, now)
  const risk = estimateExpirationRisk(strategy.legs)
  return {
    asOf: isoNow(now),
    underlyingPrice: roundMoney(underlyingPrice),
    daysLeft,
    strategyValue: strategyEntryValue(strategy.legs),
    fees: estimateIbkrUsOptionsFees(strategy.legs, quantity),
    maxLoss: risk.maxLoss,
    maxProfit: risk.maxProfit,
    breakevens: breakevens(strategy),
    dataGaps: [...(strategy.dataGaps ?? []), PAPER_TRADE_WARNING, PAPER_TRADE_FEE_DISCLOSURE, PAPER_TRADE_THEORETICAL_MARK_WARNING],
    valueMethod: 'quoted_mid',
  }
}

export function fillPaperOrder({
  userId,
  accountId,
  ticker,
  strategy,
  underlyingPrice,
  quantity = 1,
  now = Date.now(),
}: {
  userId: string
  accountId: string
  ticker: string
  strategy: StrategyCandidate
  underlyingPrice: number
  quantity?: number
  now?: number
}) {
  const submittedAt = isoNow(now)
  const validationGaps = validatePaperStrategy(strategy, underlyingPrice, now)
  const orderBase = {
    id: paperId('paper-order', now),
    userId,
    accountId,
    side: 'open' as const,
    ticker,
    strategyId: strategy.id,
    strategyName: strategy.name,
    quantity,
    orderType: 'simulated_market' as const,
    submittedAt,
    strategySnapshot: strategy,
  }

  if (validationGaps.length || !Number.isInteger(quantity) || quantity < 1) {
    const order: PaperOrder = {
      ...orderBase,
      status: 'rejected',
      rejectReason: validationGaps[0] ?? 'PAPER_TRADE_INVALID_REQUEST: quantity must be a positive integer.',
    }
    return { order, position: undefined, warnings: validationGaps }
  }

  const fillSnapshot = buildPaperFillSnapshot({ strategy, underlyingPrice, quantity, now })
  const order: PaperOrder = { ...orderBase, status: 'filled', filledAt: submittedAt, fillSnapshot }
  const position: PaperPosition = {
    id: paperId('paper-position', now),
    userId,
    accountId,
    status: 'open',
    ticker,
    strategyId: strategy.id,
    strategyName: strategy.name,
    quantity,
    openedAt: submittedAt,
    entrySnapshot: fillSnapshot,
    strategySnapshot: strategy,
    legsSnapshot: strategy.legs,
  }
  return { order, position, warnings: fillSnapshot.dataGaps }
}

export function markPaperPosition(position: PaperPosition, currentUnderlyingPrice: number, now = Date.now()): PaperPositionMark {
  const currentDaysLeft = daysUntilEarliestLegExpiration(position.legsSnapshot, now)
  const currentStrategyValue = strategyTheoreticalValue(position.legsSnapshot, currentUnderlyingPrice, currentDaysLeft)
  const entryFees = position.entrySnapshot.fees?.total ?? 0
  const unrealizedPnL = roundMoney((currentStrategyValue - position.entrySnapshot.strategyValue) * position.quantity - entryFees)
  const base = capitalBase(position)
  return {
    positionId: position.id,
    asOf: isoNow(now),
    currentUnderlyingPrice: roundMoney(currentUnderlyingPrice),
    currentDaysLeft,
    currentStrategyValue,
    unrealizedPnL,
    unrealizedPnLPct: base ? roundMoney((unrealizedPnL / base) * 100) : 0,
    dataGaps: [PAPER_TRADE_WARNING, PAPER_TRADE_THEORETICAL_MARK_WARNING],
  }
}

export function closePaperPosition(position: PaperPosition, currentUnderlyingPrice: number, now = Date.now()) {
  const mark = markPaperPosition(position, currentUnderlyingPrice, now)
  const closeFees = estimateIbkrUsOptionsFees(position.legsSnapshot, position.quantity, 'close')
  const closeSnapshot: PaperTradeFillSnapshot = {
    asOf: mark.asOf,
    underlyingPrice: mark.currentUnderlyingPrice,
    daysLeft: mark.currentDaysLeft,
    strategyValue: mark.currentStrategyValue,
    fees: closeFees,
    maxLoss: position.entrySnapshot.maxLoss,
    maxProfit: position.entrySnapshot.maxProfit,
    breakevens: position.entrySnapshot.breakevens,
    dataGaps: mark.dataGaps,
    valueMethod: 'theoretical_mid',
  }
  const closed: PaperPosition = {
    ...position,
    status: 'closed',
    closedAt: mark.asOf,
    closeSnapshot,
    realizedPnL: roundMoney(mark.unrealizedPnL - closeFees.total),
  }
  return { position: closed, closeSnapshot, realizedPnL: closed.realizedPnL, warnings: mark.dataGaps }
}
