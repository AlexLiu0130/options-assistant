import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  closePaperPosition as closeEnginePosition,
  fillPaperOrder,
  isUsOptionsRegularTradingHours,
  markPaperPosition,
} from '../src/core/paperTradeEngine.ts'
import { query, transaction } from './database.mjs'
import { recordProductEvent } from './productEventsRuntime.mjs'

const storePath =
  process.env.PAPER_TRADE_STORE_PATH ||
  fileURLToPath(new URL('../.qveris-paper-trades.json', import.meta.url))
const legacyUserId = 'local-user'
const defaultInitialCash = 1_000_000
const postgresStorage = 'postgres'
const localStorage = 'local_file'

function isoNow(now = Date.now()) {
  return new Date(now).toISOString()
}

function roundMoney(value) {
  return Number(value.toFixed(2))
}

function defaultAccount(now = Date.now(), userId = legacyUserId) {
  return {
    id: `paper-${userId}`,
    userId,
    currency: 'USD',
    initialCash: defaultInitialCash,
    cashBalance: defaultInitialCash,
    updatedAt: isoNow(now),
  }
}

function readRootStore() {
  if (!existsSync(storePath)) return { accounts: {} }
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'))
    if (parsed.accounts && typeof parsed.accounts === 'object') return parsed
    const legacy = {
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
      account: parsed.account && typeof parsed.account === 'object' ? parsed.account : undefined,
    }
    return { accounts: { [legacyUserId]: { ...legacy, account: legacy.account ?? legacyAccount(legacy.positions, legacyUserId) } } }
  } catch {
    return { accounts: {} }
  }
}

function readStore(userId = legacyUserId) {
  const store = readRootStore().accounts[userId]
  return store ?? { account: defaultAccount(Date.now(), userId), orders: [], positions: [] }
}

function writeStore(store, userId = legacyUserId) {
  const root = readRootStore()
  root.accounts[userId] = { account: store.account ?? defaultAccount(Date.now(), userId), orders: store.orders, positions: store.positions }
  writeFileSync(storePath, JSON.stringify(root, null, 2))
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function response(status, body) {
  return { status, body }
}

function isPostgresEnabled() {
  return Boolean(process.env.DATABASE_URL)
}

async function recordPaperTradeEvent(eventName, authUser, now, { ticker, strategyId, strategyName, action } = {}) {
  const properties = { source: 'paper_trade', storage: postgresStorage }
  if (strategyId) properties.strategyId = strategyId
  if (strategyName) properties.strategyName = strategyName
  if (action) properties.action = action
  try {
    await recordProductEvent({ eventName, ticker, properties }, authUser, now)
  } catch {
    // Telemetry is best-effort and must not expose paper-trade payloads.
  }
}

function authSubject(user) {
  return String(typeof user === 'object' && user ? user.sub : user || legacyUserId).trim() || legacyUserId
}

function authEmail(user) {
  const value = typeof user === 'object' && user ? user.email : null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function authDisplayName(user) {
  const value = typeof user === 'object' && user ? user.name ?? user.displayName : null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function pgTime(value) {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function pgNumber(value) {
  if (value === null || value === undefined) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function pgJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  return typeof value === 'string' ? JSON.parse(value) : value
}

function publicDbError() {
  return response(500, { error: 'Paper trade storage is unavailable.', storage: postgresStorage })
}

async function withPostgres(handler) {
  try {
    return await handler()
  } catch (error) {
    console.error('[paper-trade-db]', error?.code || error?.name || 'Error')
    return publicDbError()
  }
}

async function ensurePostgresUser(client, authUser) {
  const sub = authSubject(authUser)
  const result = await client.query(
    `INSERT INTO users (oauth_sub, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (oauth_sub) DO UPDATE
       SET email = COALESCE(EXCLUDED.email, users.email),
           display_name = COALESCE(EXCLUDED.display_name, users.display_name)
     RETURNING id`,
    [sub, authEmail(authUser), authDisplayName(authUser)],
  )
  return { id: result.rows[0].id, oauthSub: sub }
}

async function ensurePostgresAccount(client, userId, now = Date.now()) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId])
  const existing = await client.query(
    `SELECT id, user_id, currency, initial_cash, cash_balance, updated_at
     FROM paper_accounts
     WHERE user_id = $1
     ORDER BY created_at ASC, id ASC
     LIMIT 1
     FOR UPDATE`,
    [userId],
  )
  if (existing.rows[0]) return mapAccount(existing.rows[0])
  const inserted = await client.query(
    `INSERT INTO paper_accounts (id, user_id, currency, initial_cash, cash_balance, updated_at)
     VALUES ($1, $2, 'USD', $3, $3, $4)
     RETURNING id, user_id, currency, initial_cash, cash_balance, updated_at`,
    [randomUUID(), userId, defaultInitialCash, isoNow(now)],
  )
  return mapAccount(inserted.rows[0])
}

function mapAccount(row) {
  return {
    id: row.id,
    userId: row.user_id,
    currency: row.currency || 'USD',
    initialCash: pgNumber(row.initial_cash) ?? defaultInitialCash,
    cashBalance: pgNumber(row.cash_balance) ?? defaultInitialCash,
    updatedAt: pgTime(row.updated_at) ?? isoNow(),
  }
}

function mapOrder(row) {
  const positionEffect = row.position_effect === 'close' ? 'close' : 'open'
  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    status: row.status,
    side: positionEffect,
    ticker: row.ticker,
    strategyId: row.strategy_id,
    strategyName: row.strategy_name,
    quantity: pgNumber(row.quantity) ?? 1,
    orderType: 'simulated_market',
    submittedAt: pgTime(row.submitted_at),
    filledAt: pgTime(row.filled_at),
    rejectReason: row.reject_reason ?? undefined,
    strategySnapshot: pgJson(row.strategy_snapshot, {}),
    fillSnapshot: pgJson(row.fill_snapshot, undefined),
  }
}

function mapPosition(row) {
  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    status: row.status,
    ticker: row.ticker,
    strategyId: row.strategy_id,
    strategyName: row.strategy_name,
    quantity: pgNumber(row.quantity) ?? 1,
    openedAt: pgTime(row.opened_at),
    closedAt: pgTime(row.closed_at),
    entrySnapshot: pgJson(row.entry_snapshot, {}),
    closeSnapshot: pgJson(row.close_snapshot, undefined),
    realizedPnL: pgNumber(row.realized_pnl),
    strategySnapshot: pgJson(row.strategy_snapshot, {}),
    legsSnapshot: pgJson(row.legs_snapshot, []),
    userNotes: row.user_notes ?? undefined,
  }
}

async function loadPostgresStore(userId, account) {
  const positions = await query(
    `SELECT id, user_id, account_id, status, ticker, strategy_id, strategy_name, quantity,
            opened_at, closed_at, entry_snapshot, close_snapshot, realized_pnl,
            strategy_snapshot, legs_snapshot, user_notes
     FROM paper_positions
     WHERE user_id = $1 AND account_id = $2
     ORDER BY opened_at DESC, created_at DESC`,
    [userId, account.id],
  )
  return { account, positions: positions.rows.map(mapPosition), orders: [] }
}

async function postgresAccountFor(authUser, now = Date.now()) {
  return transaction(async (client) => {
    const user = await ensurePostgresUser(client, authUser)
    const account = await ensurePostgresAccount(client, user.id, now)
    return { user, account }
  })
}

function dbSideFromStrategy(strategy, quantity = 1) {
  const net = strategy.legs.reduce((sum, leg) => {
    const value = (leg.premium ?? 0) * leg.quantity * quantity * 100
    return sum + (leg.action === 'buy' ? value : -value)
  }, 0)
  return net >= 0 ? 'buy' : 'sell'
}

function closeDbSideFromPosition(position) {
  return dbSideFromStrategy({
    legs: position.legsSnapshot.map((leg) => ({
      ...leg,
      action: leg.action === 'buy' ? 'sell' : 'buy',
    })),
  }, position.quantity)
}

async function insertPostgresOrder(client, order, { dbSide, positionEffect, positionId } = {}) {
  const inserted = await client.query(
    `INSERT INTO paper_orders (
       id, user_id, account_id, status, side, position_effect, ticker, strategy_id,
       strategy_name, quantity, order_type, submitted_at, filled_at, reject_reason,
       strategy_snapshot, fill_snapshot, position_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'market', $11, $12, $13, $14::jsonb, $15::jsonb, $16)
     RETURNING id, user_id, account_id, status, side, position_effect, ticker,
               strategy_id, strategy_name, quantity, order_type, submitted_at,
               filled_at, reject_reason, strategy_snapshot, fill_snapshot, position_id`,
    [
      order.id,
      order.userId,
      order.accountId,
      order.status,
      dbSide ?? dbSideFromStrategy(order.strategySnapshot, order.quantity),
      positionEffect ?? order.side,
      order.ticker,
      order.strategyId,
      order.strategyName,
      Number.isInteger(order.quantity) ? order.quantity : null,
      order.submittedAt,
      order.filledAt ?? null,
      order.rejectReason ?? null,
      JSON.stringify(order.strategySnapshot ?? {}),
      order.fillSnapshot ? JSON.stringify(order.fillSnapshot) : null,
      positionId ?? null,
    ],
  )
  return mapOrder(inserted.rows[0])
}

async function insertPostgresPosition(client, position) {
  const inserted = await client.query(
    `INSERT INTO paper_positions (
       id, user_id, account_id, status, ticker, strategy_id, strategy_name, quantity,
       opened_at, closed_at, entry_snapshot, close_snapshot, realized_pnl,
       strategy_snapshot, legs_snapshot, user_notes, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14::jsonb, $15::jsonb, $16, $17)
     RETURNING id, user_id, account_id, status, ticker, strategy_id, strategy_name,
               quantity, opened_at, closed_at, entry_snapshot, close_snapshot,
               realized_pnl, strategy_snapshot, legs_snapshot, user_notes`,
    [
      position.id,
      position.userId,
      position.accountId,
      position.status,
      position.ticker,
      position.strategyId,
      position.strategyName,
      position.quantity,
      position.openedAt,
      position.closedAt ?? null,
      JSON.stringify(position.entrySnapshot),
      position.closeSnapshot ? JSON.stringify(position.closeSnapshot) : null,
      position.realizedPnL ?? 0,
      JSON.stringify(position.strategySnapshot),
      JSON.stringify(position.legsSnapshot),
      position.userNotes ?? null,
      isoNow(),
    ],
  )
  return mapPosition(inserted.rows[0])
}

function legacyAccount(positions, userId = legacyUserId) {
  const account = defaultAccount(Date.now(), userId)
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

export async function submitPaperOrder(body, now = Date.now(), userId = legacyUserId) {
  if (isPostgresEnabled()) return submitPostgresPaperOrder(body, now, userId)
  return submitLocalPaperOrder(body, now, authSubject(userId))
}

function submitLocalPaperOrder(body, now = Date.now(), userId = legacyUserId) {
  const strategy = body.strategySnapshot ?? body.strategy
  if (!strategy || !Array.isArray(strategy.legs)) {
    return response(400, { error: 'strategySnapshot.legs is required.' })
  }

  const ticker = String(body.ticker ?? strategy.ticker ?? '').trim().toUpperCase()
  if (!ticker) return response(400, { error: 'ticker is required.' })

  const underlyingPrice = numberOrNull(body.underlyingPrice ?? body.marketSnapshot?.price)
  const quantity = numberOrNull(body.quantity ?? 1) ?? 1
  const result = fillPaperOrder({ userId, accountId: `paper-${userId}`, ticker, strategy, underlyingPrice, quantity, now })
  const store = readStore(userId)
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
      writeStore(store, userId)
      return response(422, { order: result.order, warnings: [result.order.rejectReason], storage: localStorage })
    }
  }
  store.orders.unshift(result.order)
  if (result.position) {
    store.positions.unshift(result.position)
    store.account.cashBalance = roundMoney(store.account.cashBalance - result.position.entrySnapshot.strategyValue * quantity - (result.position.entrySnapshot.fees?.total ?? 0))
    store.account.updatedAt = isoNow(now)
  }
  writeStore(store, userId)
  return response(result.order.status === 'filled' ? 201 : 422, { ...result, storage: localStorage })
}

async function submitPostgresPaperOrder(body, now = Date.now(), authUser = legacyUserId) {
  const strategy = body.strategySnapshot ?? body.strategy
  if (!strategy || !Array.isArray(strategy.legs)) {
    return response(400, { error: 'strategySnapshot.legs is required.' })
  }

  const ticker = String(body.ticker ?? strategy.ticker ?? '').trim().toUpperCase()
  if (!ticker) return response(400, { error: 'ticker is required.' })

  const underlyingPrice = numberOrNull(body.underlyingPrice ?? body.marketSnapshot?.price)
  const quantity = numberOrNull(body.quantity ?? 1) ?? 1
  return withPostgres(async () => {
    const tradeResponse = await transaction(async (client) => {
      const user = await ensurePostgresUser(client, authUser)
      const account = await ensurePostgresAccount(client, user.id, now)
      const result = fillPaperOrder({ userId: user.id, accountId: account.id, ticker, strategy, underlyingPrice, quantity, now })
      if (result.position) {
        const fees = result.position.entrySnapshot.fees?.total ?? 0
        const cashAfter = roundMoney(account.cashBalance - result.position.entrySnapshot.strategyValue * quantity - fees)
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
          const order = await insertPostgresOrder(client, result.order, { dbSide: dbSideFromStrategy(strategy, quantity), positionEffect: 'open' })
          return response(422, { order, warnings: [result.order.rejectReason], storage: postgresStorage })
        }
      }

      if (result.position) {
        result.position = await insertPostgresPosition(client, result.position)
        result.order = await insertPostgresOrder(client, result.order, {
          dbSide: dbSideFromStrategy(strategy, quantity),
          positionEffect: 'open',
          positionId: result.position.id,
        })
        const cashBalance = roundMoney(account.cashBalance - result.position.entrySnapshot.strategyValue * quantity - (result.position.entrySnapshot.fees?.total ?? 0))
        await client.query('UPDATE paper_accounts SET cash_balance = $1, updated_at = $2 WHERE id = $3', [cashBalance, isoNow(now), account.id])
      } else {
        await insertPostgresOrder(client, result.order, { dbSide: dbSideFromStrategy(strategy, quantity), positionEffect: 'open' })
        if (result.order.status !== 'filled') return response(422, { ...result, storage: postgresStorage })
      }
      return response(result.order.status === 'filled' ? 201 : 422, { ...result, storage: postgresStorage })
    })
    if (tradeResponse.status === 201 && tradeResponse.body.order?.status === 'filled') {
      await recordPaperTradeEvent('paper_order_created', authUser, now, tradeResponse.body.order)
    }
    return tradeResponse
  })
}

export async function listPaperOrders(userId = legacyUserId) {
  if (!isPostgresEnabled()) return response(200, { orders: readStore(authSubject(userId)).orders, storage: localStorage })
  return withPostgres(async () => {
    const { user, account } = await postgresAccountFor(userId)
    const rows = await query(
      `SELECT id, user_id, account_id, status, side, position_effect, ticker,
              strategy_id, strategy_name, quantity, order_type, submitted_at,
              filled_at, reject_reason, strategy_snapshot, fill_snapshot, position_id
       FROM paper_orders
       WHERE user_id = $1 AND account_id = $2
       ORDER BY submitted_at DESC, created_at DESC`,
      [user.id, account.id],
    )
    return response(200, { orders: rows.rows.map(mapOrder), storage: postgresStorage })
  })
}

export async function listPaperPositions({ status = 'open', currentUnderlyingPrice, now = Date.now() } = {}, userId = legacyUserId) {
  if (isPostgresEnabled()) {
    return withPostgres(async () => {
      const { user, account } = await postgresAccountFor(userId, now)
      const store = await loadPostgresStore(user.id, account)
      const positions = positionsWithMarks(store, { currentUnderlyingPrice }, now)
        .filter((position) => status === 'all' || position.status === status)
      return response(200, { positions, storage: postgresStorage })
    })
  }
  const store = readStore(authSubject(userId))
  const positions = positionsWithMarks(store, { currentUnderlyingPrice }, now)
    .filter((position) => status === 'all' || position.status === status)
  return response(200, { positions, storage: localStorage })
}

export async function closePaperPositionById(positionId, body, now = Date.now(), userId = legacyUserId) {
  if (isPostgresEnabled()) return closePostgresPaperPositionById(positionId, body, now, userId)
  return closeLocalPaperPositionById(positionId, body, now, authSubject(userId))
}

function closeLocalPaperPositionById(positionId, body, now = Date.now(), userId = legacyUserId) {
  const price = numberOrNull(body.currentUnderlyingPrice ?? body.currentPrice ?? body.marketSnapshot?.price)
  if (price === null) return response(400, { error: 'currentUnderlyingPrice is required.' })
  if (!isUsOptionsRegularTradingHours(now)) {
    return response(422, { error: 'PAPER_TRADE_MARKET_CLOSED: US equity options paper orders are limited to regular trading hours, 09:30-16:00 ET on weekdays.' })
  }

  const store = readStore(userId)
  const index = store.positions.findIndex((position) => position.id === positionId)
  if (index < 0) return response(404, { error: 'Paper position not found.' })
  if (store.positions[index].status !== 'open') return response(409, { error: 'Paper position is already closed.' })

  const result = closeEnginePosition(store.positions[index], price, now)
  store.positions[index] = result.position
  store.account.cashBalance = roundMoney(store.account.cashBalance + result.closeSnapshot.strategyValue * result.position.quantity - (result.closeSnapshot.fees?.total ?? 0))
  store.account.updatedAt = isoNow(now)
  writeStore(store, userId)
  return response(200, { ...result, storage: localStorage })
}

async function closePostgresPaperPositionById(positionId, body, now = Date.now(), authUser = legacyUserId) {
  const price = numberOrNull(body.currentUnderlyingPrice ?? body.currentPrice ?? body.marketSnapshot?.price)
  if (price === null) return response(400, { error: 'currentUnderlyingPrice is required.' })
  if (!isUsOptionsRegularTradingHours(now)) {
    return response(422, { error: 'PAPER_TRADE_MARKET_CLOSED: US equity options paper orders are limited to regular trading hours, 09:30-16:00 ET on weekdays.' })
  }

  return withPostgres(async () => {
    const tradeResponse = await transaction(async (client) => {
      const user = await ensurePostgresUser(client, authUser)
      const account = await ensurePostgresAccount(client, user.id, now)
      const locked = await client.query(
        `SELECT id, user_id, account_id, status, ticker, strategy_id, strategy_name, quantity,
                opened_at, closed_at, entry_snapshot, close_snapshot, realized_pnl,
                strategy_snapshot, legs_snapshot, user_notes
         FROM paper_positions
         WHERE id = $1 AND user_id = $2 AND account_id = $3
         FOR UPDATE`,
        [positionId, user.id, account.id],
      )
      if (!locked.rows[0]) return response(404, { error: 'Paper position not found.' })
      const position = mapPosition(locked.rows[0])
      if (position.status !== 'open') return response(409, { error: 'Paper position is already closed.' })

      const result = closeEnginePosition(position, price, now)
      const order = {
        id: randomUUID(),
        userId: user.id,
        accountId: account.id,
        status: 'filled',
        side: 'close',
        ticker: position.ticker,
        strategyId: position.strategyId,
        strategyName: position.strategyName,
        quantity: position.quantity,
        orderType: 'simulated_market',
        submittedAt: result.closeSnapshot.asOf,
        filledAt: result.closeSnapshot.asOf,
        strategySnapshot: position.strategySnapshot,
        fillSnapshot: result.closeSnapshot,
      }
      await insertPostgresOrder(client, order, {
        dbSide: closeDbSideFromPosition(position),
        positionEffect: 'close',
        positionId: position.id,
      })
      const updated = await client.query(
        `UPDATE paper_positions
         SET status = 'closed', closed_at = $1, close_snapshot = $2::jsonb,
             realized_pnl = $3, updated_at = $1
         WHERE id = $4
         RETURNING id, user_id, account_id, status, ticker, strategy_id, strategy_name,
                   quantity, opened_at, closed_at, entry_snapshot, close_snapshot,
                   realized_pnl, strategy_snapshot, legs_snapshot, user_notes`,
        [result.position.closedAt, JSON.stringify(result.closeSnapshot), result.realizedPnL, position.id],
      )
      result.position = mapPosition(updated.rows[0])
      const cashBalance = roundMoney(account.cashBalance + result.closeSnapshot.strategyValue * result.position.quantity - (result.closeSnapshot.fees?.total ?? 0))
      await client.query('UPDATE paper_accounts SET cash_balance = $1, updated_at = $2 WHERE id = $3', [cashBalance, isoNow(now), account.id])
      return response(200, { ...result, storage: postgresStorage })
    })
    if (tradeResponse.status === 200) {
      await recordPaperTradeEvent('paper_position_closed', authUser, now, tradeResponse.body.position)
    }
    return tradeResponse
  })
}

export async function getPaperAccount(body = {}, now = Date.now(), userId = legacyUserId) {
  if (!isPostgresEnabled()) return response(200, accountSummary(readStore(authSubject(userId)), body, now))
  return withPostgres(async () => {
    const { user, account } = await postgresAccountFor(userId, now)
    const store = await loadPostgresStore(user.id, account)
    return response(200, { ...accountSummary(store, body, now), storage: postgresStorage })
  })
}

export async function resetPaperAccount(body = {}, now = Date.now(), userId = legacyUserId) {
  if (isPostgresEnabled()) return resetPostgresPaperAccount(body, now, userId)
  return resetLocalPaperAccount(body, now, authSubject(userId))
}

function resetLocalPaperAccount(body = {}, now = Date.now(), userId = legacyUserId) {
  const amount = numberOrNull(body.initialCash ?? body.cash ?? body.amount) ?? defaultInitialCash
  if (amount <= 0) return response(400, { error: 'initialCash must be positive.' })
  const previous = readStore(userId)
  const account = { ...defaultAccount(now, userId), initialCash: roundMoney(amount), cashBalance: roundMoney(amount) }
  const store = { account, orders: [], positions: [] }
  writeStore(store, userId)
  return response(200, {
    account,
    summary: accountSummary(store, {}, now).summary,
    positions: [],
    clearedOrders: previous.orders.length,
    clearedPositions: previous.positions.length,
    storage: localStorage,
  })
}

async function resetPostgresPaperAccount(body = {}, now = Date.now(), authUser = legacyUserId) {
  const amount = numberOrNull(body.initialCash ?? body.cash ?? body.amount) ?? defaultInitialCash
  if (amount <= 0) return response(400, { error: 'initialCash must be positive.' })
  return withPostgres(async () => {
    const resetResponse = await transaction(async (client) => {
      const user = await ensurePostgresUser(client, authUser)
      const account = await ensurePostgresAccount(client, user.id, now)
      const orderCount = await client.query('SELECT count(*)::int AS count FROM paper_orders WHERE user_id = $1 AND account_id = $2', [user.id, account.id])
      const positionCount = await client.query('SELECT count(*)::int AS count FROM paper_positions WHERE user_id = $1 AND account_id = $2', [user.id, account.id])
      const updated = await client.query(
        `UPDATE paper_accounts
         SET initial_cash = $1, cash_balance = $1, updated_at = $2
         WHERE id = $3
         RETURNING id, user_id, currency, initial_cash, cash_balance, updated_at`,
        [roundMoney(amount), isoNow(now), account.id],
      )
      await client.query('DELETE FROM paper_orders WHERE user_id = $1 AND account_id = $2', [user.id, account.id])
      await client.query('DELETE FROM paper_positions WHERE user_id = $1 AND account_id = $2', [user.id, account.id])
      const resetAccount = mapAccount(updated.rows[0])
      const store = { account: resetAccount, orders: [], positions: [] }
      return response(200, {
        account: resetAccount,
        summary: accountSummary(store, {}, now).summary,
        positions: [],
        clearedOrders: orderCount.rows[0]?.count ?? 0,
        clearedPositions: positionCount.rows[0]?.count ?? 0,
        storage: postgresStorage,
      })
    })
    if (resetResponse.status === 200) {
      await recordPaperTradeEvent('paper_account_reset', authUser, now, { action: 'reset' })
    }
    return resetResponse
  })
}
