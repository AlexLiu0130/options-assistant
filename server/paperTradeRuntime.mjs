import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  closePaperPosition as closeEnginePosition,
  fillPaperOrder,
  isUsOptionsRegularTradingHours,
  markPaperPosition,
} from '../src/core/paperTradeEngine.ts'

const storePath =
  process.env.PAPER_TRADE_STORE_PATH ||
  fileURLToPath(new URL('../.qveris-paper-trades.json', import.meta.url))
const userId = 'local-user'
const accountId = 'local-paper'
const defaultInitialCash = 1_000_000

function isoNow(now = Date.now()) {
  return new Date(now).toISOString()
}

function roundMoney(value) {
  return Number(value.toFixed(2))
}

function defaultAccount(now = Date.now()) {
  return {
    id: accountId,
    userId,
    currency: 'USD',
    initialCash: defaultInitialCash,
    cashBalance: defaultInitialCash,
    updatedAt: isoNow(now),
  }
}

function readStore() {
  if (!existsSync(storePath)) return { account: defaultAccount(), orders: [], positions: [] }
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'))
    const store = {
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
      account: parsed.account && typeof parsed.account === 'object' ? parsed.account : undefined,
    }
    return { ...store, account: store.account ?? legacyAccount(store.positions) }
  } catch {
    return { account: defaultAccount(), orders: [], positions: [] }
  }
}

function writeStore(store) {
  writeFileSync(storePath, JSON.stringify({ account: store.account ?? defaultAccount(), orders: store.orders, positions: store.positions }, null, 2))
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function response(status, body) {
  return { status, body }
}

function legacyAccount(positions) {
  const account = defaultAccount()
  account.cashBalance = roundMoney(
    account.initialCash +
      positions.reduce((sum, position) => {
        if (position.status === 'closed') return sum + (position.realizedPnL ?? 0)
        return sum - (position.entrySnapshot?.strategyValue ?? 0) * (position.quantity ?? 1)
      }, 0),
  )
  return account
}

function riskReserveForPosition(position) {
  const maxLoss = position.entrySnapshot?.maxLoss
  if (typeof maxLoss !== 'number' || maxLoss <= 0) return 0
  const entryDebit = Math.max(0, (position.entrySnapshot?.strategyValue ?? 0) * (position.quantity ?? 1))
  return roundMoney(Math.max(0, maxLoss * (position.quantity ?? 1) - entryDebit))
}

function priceForPosition(position, { currentUnderlyingPrice, prices } = {}) {
  const byTicker = prices && typeof prices === 'object' ? numberOrNull(prices[position.ticker]) : null
  return byTicker ?? numberOrNull(currentUnderlyingPrice)
}

function positionsWithMarks(store, markInput = {}, now = Date.now()) {
  return store.positions.map((position) => {
    const price = priceForPosition(position, markInput)
    return {
      ...position,
      mark: position.status === 'open'
        ? price !== null
          ? markPaperPosition(position, price, now)
          : entryFallbackMark(position, now)
        : undefined,
    }
  })
}

function entryFallbackMark(position, now = Date.now()) {
  const entryFees = position.entrySnapshot.fees?.total ?? 0
  const base = Math.abs(position.entrySnapshot.strategyValue * position.quantity) || 1
  return {
    positionId: position.id,
    asOf: isoNow(now),
    currentUnderlyingPrice: position.entrySnapshot.underlyingPrice,
    currentDaysLeft: position.entrySnapshot.daysLeft,
    currentStrategyValue: position.entrySnapshot.strategyValue,
    unrealizedPnL: roundMoney(-entryFees),
    unrealizedPnLPct: roundMoney((-entryFees / base) * 100),
    dataGaps: [
      'PAPER_TRADE_MARK_GAP: current underlying price was not supplied; open position is marked at entry value.',
      ...(position.entrySnapshot.fees ? [position.entrySnapshot.fees.disclosure] : []),
    ],
  }
}

function accountSummary(store, markInput = {}, now = Date.now()) {
  const positions = positionsWithMarks(store, markInput, now)
  const openPositions = positions.filter((position) => position.status === 'open')
  const closedPositions = positions.filter((position) => position.status === 'closed')
  const openValue = openPositions.reduce(
    (sum, position) =>
      sum +
      ((position.mark?.currentStrategyValue ?? position.entrySnapshot.strategyValue) * position.quantity),
    0,
  )
  const unrealizedPnL = openPositions.reduce((sum, position) => sum + (position.mark?.unrealizedPnL ?? 0), 0)
  const realizedPnL = closedPositions.reduce((sum, position) => sum + (position.realizedPnL ?? 0), 0)
  const reservedRisk = openPositions.reduce((sum, position) => sum + riskReserveForPosition(position), 0)
  const equity = roundMoney(store.account.cashBalance + openValue)
  return {
    account: store.account,
    summary: {
      asOf: isoNow(now),
      currency: store.account.currency,
      initialCash: store.account.initialCash,
      cashBalance: store.account.cashBalance,
      openValue: roundMoney(openValue),
      reservedRisk: roundMoney(reservedRisk),
      buyingPower: roundMoney(equity - reservedRisk),
      equity,
      netPnL: roundMoney(equity - store.account.initialCash),
      unrealizedPnL: roundMoney(unrealizedPnL),
      realizedPnL: roundMoney(realizedPnL),
      openCount: openPositions.length,
      closedCount: closedPositions.length,
      dataGaps: openPositions.some((position) => position.mark?.dataGaps?.some((gap) => gap.startsWith('PAPER_TRADE_MARK_GAP')))
        ? ['PAPER_TRADE_MARK_GAP: some open positions were valued at entry because current price was not supplied.']
        : [],
    },
    positions,
    storage: 'local_file',
  }
}

export function submitPaperOrder(body, now = Date.now()) {
  const strategy = body.strategySnapshot ?? body.strategy
  if (!strategy || !Array.isArray(strategy.legs)) {
    return response(400, { error: 'strategySnapshot.legs is required.' })
  }

  const ticker = String(body.ticker ?? strategy.ticker ?? '').trim().toUpperCase()
  if (!ticker) return response(400, { error: 'ticker is required.' })

  const underlyingPrice = numberOrNull(body.underlyingPrice ?? body.marketSnapshot?.price)
  const quantity = numberOrNull(body.quantity ?? 1) ?? 1
  const result = fillPaperOrder({ userId, accountId, ticker, strategy, underlyingPrice, quantity, now })
  const store = readStore()
  if (result.position) {
    const fees = result.position.entrySnapshot.fees?.total ?? 0
    const cashAfter = roundMoney(store.account.cashBalance - result.position.entrySnapshot.strategyValue * quantity - fees)
    const equityAfter = roundMoney(cashAfter + result.position.entrySnapshot.strategyValue * quantity)
    const riskReserve = riskReserveForPosition(result.position)
    if (
      cashAfter < 0 ||
      equityAfter < riskReserve ||
      result.position.entrySnapshot.maxLoss === 'unlimited' ||
      result.position.entrySnapshot.maxLoss === 'variable'
    ) {
      result.order.status = 'rejected'
      result.order.rejectReason = result.position.entrySnapshot.maxLoss === 'unlimited' || result.position.entrySnapshot.maxLoss === 'variable'
        ? 'PAPER_TRADE_MARGIN_UNMODELED: unlimited or variable max loss strategies are not supported by the current paper margin model.'
        : cashAfter < 0
          ? 'PAPER_TRADE_INSUFFICIENT_CASH: simulated cash balance is not enough for this order.'
          : 'PAPER_TRADE_RISK_RESERVE_INSUFFICIENT: simulated cash balance must cover the remaining defined max loss after opening premium and fees.'
      store.orders.unshift(result.order)
      writeStore(store)
      return response(422, { order: result.order, warnings: [result.order.rejectReason], storage: 'local_file' })
    }
  }
  store.orders.unshift(result.order)
  if (result.position) {
    store.positions.unshift(result.position)
    store.account.cashBalance = roundMoney(store.account.cashBalance - result.position.entrySnapshot.strategyValue * quantity - (result.position.entrySnapshot.fees?.total ?? 0))
    store.account.updatedAt = isoNow(now)
  }
  writeStore(store)
  return response(result.order.status === 'filled' ? 201 : 422, { ...result, storage: 'local_file' })
}

export function listPaperOrders() {
  return response(200, { orders: readStore().orders, storage: 'local_file' })
}

export function listPaperPositions({ status = 'open', currentUnderlyingPrice, now = Date.now() } = {}) {
  const store = readStore()
  const positions = positionsWithMarks(store, { currentUnderlyingPrice }, now)
    .filter((position) => status === 'all' || position.status === status)
  return response(200, { positions, storage: 'local_file' })
}

export function closePaperPositionById(positionId, body, now = Date.now()) {
  const price = numberOrNull(body.currentUnderlyingPrice ?? body.currentPrice ?? body.marketSnapshot?.price)
  if (price === null) return response(400, { error: 'currentUnderlyingPrice is required.' })
  if (!isUsOptionsRegularTradingHours(now)) {
    return response(422, { error: 'PAPER_TRADE_MARKET_CLOSED: US equity options paper orders are limited to regular trading hours, 09:30-16:00 ET on weekdays.' })
  }

  const store = readStore()
  const index = store.positions.findIndex((position) => position.id === positionId)
  if (index < 0) return response(404, { error: 'Paper position not found.' })
  if (store.positions[index].status !== 'open') return response(409, { error: 'Paper position is already closed.' })

  const result = closeEnginePosition(store.positions[index], price, now)
  store.positions[index] = result.position
  store.account.cashBalance = roundMoney(store.account.cashBalance + result.closeSnapshot.strategyValue * result.position.quantity - (result.closeSnapshot.fees?.total ?? 0))
  store.account.updatedAt = isoNow(now)
  writeStore(store)
  return response(200, { ...result, storage: 'local_file' })
}

export function getPaperAccount(body = {}, now = Date.now()) {
  return response(200, accountSummary(readStore(), body, now))
}

export function resetPaperAccount(body = {}, now = Date.now()) {
  const amount = numberOrNull(body.initialCash ?? body.cash ?? body.amount) ?? defaultInitialCash
  if (amount <= 0) return response(400, { error: 'initialCash must be positive.' })
  const account = { ...defaultAccount(now), initialCash: roundMoney(amount), cashBalance: roundMoney(amount) }
  const store = { account, orders: [], positions: [] }
  writeStore(store)
  return response(200, { account, summary: accountSummary(store, {}, now).summary, positions: [], storage: 'local_file' })
}
