import { strategyEntryValue, strategyExpirationPayoff } from './payoffEngine.ts'
import { strategyTheoreticalValue } from './simulatorEngine.ts'
import type { PaperOrder, PaperPosition, PaperPositionMark, PaperTradeFillSnapshot } from '../types/paperTradeTypes'
import type { StrategyCandidate, StrategyLeg } from '../types/strategyTypes'

const PAPER_TRADE_WARNING = 'This is a simulated paper trade, not a real brokerage order.'
const PAPER_TRADE_THEORETICAL_MARK_WARNING =
  'Paper positions are marked with a theoretical model from the underlying price, not live tradable option quotes.'
const PAPER_TRADE_FEE_DISCLOSURE =
  'IBKR Pro-like U.S. options estimate for a customer account with <=10,000 monthly contracts. It uses buy-at-ask and sell-at-bid when available, plus ORF/OCC/CAT and sell-side SEC/TAF. Exchange routing fees, rebates, and slippage are not modeled.'
const OPTION_MIN_COMMISSION_PER_ORDER = 1
const ORF_PER_CONTRACT = 0.02295
const OCC_PER_CONTRACT = 0.025
const CAT_PER_CONTRACT = 0.0003
const SEC_SALE_RATE = 0.0000206
const FINRA_TAF_PER_SELL_CONTRACT = 0.00329

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

function commissionRate(premium: number) {
  if (premium < 0.05) return 0.25
  if (premium < 0.1) return 0.5
  return 0.65
}

function executionAction(leg: StrategyLeg, side: 'open' | 'close') {
  if (side === 'open') return leg.action
  return leg.action === 'buy' ? 'sell' : 'buy'
}

export function executableLegPremium(leg: StrategyLeg, side: 'open' | 'close' = 'open') {
  const action = executionAction(leg, side)
  const quote = action === 'buy' ? leg.ask : leg.bid
  if (typeof quote === 'number' && Number.isFinite(quote) && quote > 0) {
    return { premium: quote, source: action === 'buy' ? 'ask' as const : 'bid' as const }
  }
  return { premium: leg.premium ?? 0, source: 'midpoint_fallback' as const }
}

export function priceStrategyForExecution(legs: StrategyLeg[], side: 'open' | 'close' = 'open') {
  return legs.map((leg) => ({ ...leg, premium: executableLegPremium(leg, side).premium }))
}

function isoNow(now = Date.now()) {
  return new Date(now).toISOString()
}

function easternParts(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(now))
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function observedDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day))
  const weekday = date.getUTCDay()
  if (weekday === 6) date.setUTCDate(date.getUTCDate() - 1)
  if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1)
  return date
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, ordinal: number) {
  const date = new Date(Date.UTC(year, month - 1, 1))
  date.setUTCDate(1 + ((weekday - date.getUTCDay() + 7) % 7) + (ordinal - 1) * 7)
  return date
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number) {
  const date = new Date(Date.UTC(year, month, 0))
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - weekday + 7) % 7))
  return date
}

function easterSunday(year: number) {
  const goldenNumber = year % 19
  const century = Math.floor(year / 100)
  const yearOfCentury = year % 100
  const leapCenturies = Math.floor(century / 4)
  const remainingCenturies = century % 4
  const correction = Math.floor((century + 8) / 25)
  const adjustedCentury = Math.floor((century - correction + 1) / 3)
  const epact = (19 * goldenNumber + century - leapCenturies - adjustedCentury + 15) % 30
  const leapYears = Math.floor(yearOfCentury / 4)
  const remainingYears = yearOfCentury % 4
  const weekdayCorrection = (32 + 2 * remainingCenturies + 2 * leapYears - epact - remainingYears) % 7
  const monthCorrection = Math.floor((goldenNumber + 11 * epact + 22 * weekdayCorrection) / 451)
  const month = Math.floor((epact + weekdayCorrection - 7 * monthCorrection + 114) / 31)
  const day = (epact + weekdayCorrection - 7 * monthCorrection + 114) % 31 + 1
  return new Date(Date.UTC(year, month - 1, day))
}

function priorWeekday(date: Date) {
  const previous = new Date(date)
  previous.setUTCDate(previous.getUTCDate() - 1)
  while (previous.getUTCDay() === 0 || previous.getUTCDay() === 6) previous.setUTCDate(previous.getUTCDate() - 1)
  return previous
}

function nyseHolidayKeys(year: number) {
  const holidays = new Set<string>()
  for (const calendarYear of [year - 1, year, year + 1]) {
    const goodFriday = easterSunday(calendarYear)
    goodFriday.setUTCDate(goodFriday.getUTCDate() - 2)
    const dates = [
      observedDate(calendarYear, 1, 1),
      nthWeekdayOfMonth(calendarYear, 1, 1, 3),
      nthWeekdayOfMonth(calendarYear, 2, 1, 3),
      goodFriday,
      lastWeekdayOfMonth(calendarYear, 5, 1),
      observedDate(calendarYear, 7, 4),
      nthWeekdayOfMonth(calendarYear, 9, 1, 1),
      nthWeekdayOfMonth(calendarYear, 11, 4, 4),
      observedDate(calendarYear, 12, 25),
    ]
    if (calendarYear >= 2022) dates.push(observedDate(calendarYear, 6, 19))
    for (const date of dates) holidays.add(dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()))
  }
  return holidays
}

function nyseEarlyCloseKeys(year: number) {
  const thanksgiving = nthWeekdayOfMonth(year, 11, 4, 4)
  const independenceObserved = observedDate(year, 7, 4)
  const christmasObserved = observedDate(year, 12, 25)
  const dates = [
    priorWeekday(independenceObserved),
    new Date(Date.UTC(year, 10, thanksgiving.getUTCDate() + 1)),
    priorWeekday(christmasObserved),
  ]
  const holidays = nyseHolidayKeys(year)
  return new Set(
    dates
      .filter((date) => !holidays.has(dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())))
      .map((date) => dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())),
  )
}

export function isUsOptionsRegularTradingHours(now = Date.now()) {
  const parts = easternParts(now)
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  const key = dateKey(year, month, day)
  if (nyseHolidayKeys(year).has(key)) return false
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  const closeMinutes = nyseEarlyCloseKeys(year).has(key) ? 13 * 60 : 16 * 60
  return minutes >= 9 * 60 + 30 && minutes < closeMinutes
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
  const pricedLegs = priceStrategyForExecution(legs, side)
  const contractCount = pricedLegs.reduce((sum, leg) => sum + leg.quantity * quantity, 0)
  const commissionBeforeMinimum = pricedLegs.reduce(
    (sum, leg) => sum + commissionRate(leg.premium ?? 0) * leg.quantity * quantity,
    0,
  )
  const commission = Math.max(OPTION_MIN_COMMISSION_PER_ORDER, commissionBeforeMinimum)
  const sellValue = pricedLegs
    .filter((leg) => executionAction(leg, side) === 'sell')
    .reduce((sum, leg) => sum + (leg.premium ?? 0) * leg.quantity * quantity * 100, 0)
  const sellContracts = pricedLegs
    .filter((leg) => executionAction(leg, side) === 'sell')
    .reduce((sum, leg) => sum + leg.quantity * quantity, 0)
  const optionsRegulatoryFee = contractCount * ORF_PER_CONTRACT
  const occClearingFee = contractCount * OCC_PER_CONTRACT
  const catFee = contractCount * CAT_PER_CONTRACT
  const secTransactionFee = sellValue * SEC_SALE_RATE
  const finraTradingActivityFee = sellContracts * FINRA_TAF_PER_SELL_CONTRACT
  const thirdParty = optionsRegulatoryFee + occClearingFee + catFee + secTransactionFee + finraTradingActivityFee
  return {
    commission: roundMoney(commission),
    thirdParty: roundMoney(thirdParty),
    total: roundMoney(commission + thirdParty),
    contractCount,
    commissionBeforeMinimum: roundMoney(commissionBeforeMinimum),
    commissionMinimumApplied: commissionBeforeMinimum < OPTION_MIN_COMMISSION_PER_ORDER,
    optionsRegulatoryFee: roundMoney(optionsRegulatoryFee),
    occClearingFee: roundMoney(occClearingFee),
    catFee: roundMoney(catFee),
    secTransactionFee: roundMoney(secTransactionFee),
    finraTradingActivityFee: roundMoney(finraTradingActivityFee),
    model: 'ibkr_us_options_estimate' as const,
    disclosure: PAPER_TRADE_FEE_DISCLOSURE,
  }
}

export function buildPaperTradeCostBreakdown(legs: StrategyLeg[], quantity = 1) {
  const pricedLegs = priceStrategyForExecution(legs)
  const rows = pricedLegs.map((leg, index) => {
    const price = leg.premium ?? 0
    const cashFlow = roundMoney((leg.action === 'buy' ? 1 : -1) * price * leg.quantity * quantity * 100)
    return {
      id: `${leg.action}-${leg.right}-${leg.expiration}-${leg.strike}-${index}`,
      action: leg.action,
      right: leg.right,
      expiration: leg.expiration,
      strike: leg.strike,
      quantity: leg.quantity * quantity,
      price,
      priceSource: executableLegPremium(legs[index]).source,
      cashFlow,
      symbol: leg.symbol,
    }
  })
  const grossDebit = roundMoney(rows.filter((row) => row.cashFlow > 0).reduce((sum, row) => sum + row.cashFlow, 0))
  const grossCredit = roundMoney(Math.abs(rows.filter((row) => row.cashFlow < 0).reduce((sum, row) => sum + row.cashFlow, 0)))
  const netPremium = roundMoney(grossDebit - grossCredit)
  const fees = estimateIbkrUsOptionsFees(legs, quantity)
  const openingCashImpact = roundMoney(netPremium + fees.total)
  return {
    rows,
    contractCount: rows.reduce((sum, row) => sum + row.quantity, 0),
    grossDebit,
    grossCredit,
    netPremium,
    fees,
    openingCashImpact,
    usedMidpointFallback: rows.some((row) => row.priceSource === 'midpoint_fallback'),
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
  const executionLegs = priceStrategyForExecution(strategy.legs)
  const daysLeft = daysUntilEarliestLegExpiration(executionLegs, now)
  const risk = estimateExpirationRisk(executionLegs)
  return {
    asOf: isoNow(now),
    underlyingPrice: roundMoney(underlyingPrice),
    daysLeft,
    strategyValue: strategyEntryValue(executionLegs),
    fees: estimateIbkrUsOptionsFees(executionLegs, quantity),
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

  const executionStrategy = { ...strategy, legs: priceStrategyForExecution(strategy.legs) }
  const fillSnapshot = buildPaperFillSnapshot({ strategy: executionStrategy, underlyingPrice, quantity, now })
  const order: PaperOrder = { ...orderBase, status: 'filled', filledAt: submittedAt, fillSnapshot, strategySnapshot: executionStrategy }
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
    strategySnapshot: executionStrategy,
    legsSnapshot: executionStrategy.legs,
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
