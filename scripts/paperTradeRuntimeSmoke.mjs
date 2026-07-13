import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.PAPER_TRADE_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'qveris-paper-')), 'paper.json')

const {
  closePaperPositionById,
  getPaperAccount,
  listPaperOrders,
  listPaperPositions,
  resetPaperAccount,
  submitPaperOrder,
} = await import('../server/paperTradeRuntime.mjs')

const strategy = {
  id: 'smoke-call',
  name: 'Smoke Call',
  fit: 'high',
  maxLoss: 500,
  maxProfit: 'unlimited',
  legs: [{ action: 'buy', right: 'call', strike: 100, expiration: '2026-07-17', quantity: 1, premium: 5 }],
  guardrails: [],
}

const fresh = getPaperAccount()
assert.equal(fresh.body.account.initialCash, 1_000_000)
assert.equal(fresh.body.summary.equity, 1_000_000)

const opened = submitPaperOrder({ ticker: 'TST', strategySnapshot: strategy, underlyingPrice: 100 }, Date.UTC(2026, 6, 1, 14))
assert.equal(opened.status, 201)
assert.equal(opened.body.order.status, 'filled')
assert.ok(opened.body.position?.id)
const entryValue = opened.body.position.entrySnapshot.strategyValue
const entryFee = opened.body.position.entrySnapshot.fees.total
const unmarkedAccount = getPaperAccount()
assert.equal(unmarkedAccount.body.positions[0].mark.currentStrategyValue, entryValue)
assert.equal(unmarkedAccount.body.positions[0].mark.unrealizedPnL, -entryFee)
assert.equal(unmarkedAccount.body.account.cashBalance, Number((1_000_000 - entryValue - entryFee).toFixed(2)))
const entryRiskReserve = Number(Math.max(0, strategy.maxLoss - entryValue).toFixed(2))
assert.equal(unmarkedAccount.body.summary.reservedRisk, entryRiskReserve)
assert.equal(unmarkedAccount.body.summary.buyingPower, Number((unmarkedAccount.body.summary.equity - entryRiskReserve).toFixed(2)))

const orders = listPaperOrders()
assert.equal(orders.body.orders.length, 1)

const marked = listPaperPositions({
  status: 'open',
  currentUnderlyingPrice: 120,
  now: Date.UTC(2026, 6, 2, 14),
})
assert.equal(marked.body.positions.length, 1)
assert.ok(marked.body.positions[0].mark.unrealizedPnL > 0)
const markedAccount = getPaperAccount({ prices: { TST: 120 } }, Date.UTC(2026, 6, 2, 14))
assert.equal(markedAccount.body.summary.equity, Number((1_000_000 + marked.body.positions[0].mark.unrealizedPnL).toFixed(2)))
assert.equal(markedAccount.body.summary.unrealizedPnL, marked.body.positions[0].mark.unrealizedPnL)

const closed = closePaperPositionById(
  opened.body.position.id,
  { currentUnderlyingPrice: 120 },
  Date.UTC(2026, 6, 2, 14),
)
assert.equal(closed.status, 200)
assert.equal(closed.body.position.status, 'closed')
assert.equal(closed.body.position.realizedPnL, Number((marked.body.positions[0].mark.unrealizedPnL - closed.body.closeSnapshot.fees.total).toFixed(2)))
const afterClose = getPaperAccount()
assert.equal(afterClose.body.account.cashBalance, Number((1_000_000 + closed.body.realizedPnL).toFixed(2)))
assert.equal(afterClose.body.summary.realizedPnL, closed.body.realizedPnL)

const closedMarket = submitPaperOrder({ ticker: 'TST', strategySnapshot: strategy, underlyingPrice: 100 }, Date.UTC(2026, 6, 1, 2))
assert.equal(closedMarket.status, 422)
assert.match(closedMarket.body.order.rejectReason, /MARKET_CLOSED/)

resetPaperAccount({ initialCash: 100 })
const creditRisk = submitPaperOrder(
  {
    ticker: 'TST',
    strategySnapshot: {
      id: 'cash-risk',
      name: 'Cash Risk',
      fit: 'medium',
      maxLoss: 1000,
      maxProfit: 100,
      legs: [{ action: 'sell', right: 'put', strike: 100, expiration: '2026-07-17', quantity: 1, premium: 1 }],
      guardrails: [],
    },
    underlyingPrice: 100,
  },
  Date.UTC(2026, 6, 1, 14),
)
assert.equal(creditRisk.status, 422)
assert.match(creditRisk.body.order.rejectReason, /RISK_RESERVE/)

const fractional = submitPaperOrder({ ticker: 'TST', strategySnapshot: strategy, underlyingPrice: 100, quantity: 1.5 }, Date.UTC(2026, 6, 1, 14))
assert.equal(fractional.status, 422)
assert.match(fractional.body.order.rejectReason, /positive integer/)

const badLeg = submitPaperOrder(
  {
    ticker: 'TST',
    strategySnapshot: { ...strategy, legs: [{ ...strategy.legs[0], quantity: -1 }] },
    underlyingPrice: 100,
  },
  Date.UTC(2026, 6, 1, 14),
)
assert.equal(badLeg.status, 422)
assert.match(badLeg.body.order.rejectReason, /quantity must be a positive integer/)

resetPaperAccount({ initialCash: 2000 })
const spoofedRisk = submitPaperOrder(
  {
    ticker: 'TST',
    strategySnapshot: {
      id: 'spoof-risk',
      name: 'Spoof Risk',
      fit: 'medium',
      maxLoss: 1,
      maxProfit: 100,
      legs: [{ action: 'sell', right: 'put', strike: 100, expiration: '2026-07-17', quantity: 1, premium: 1 }],
      guardrails: [],
    },
    underlyingPrice: 100,
  },
  Date.UTC(2026, 6, 1, 14),
)
assert.equal(spoofedRisk.status, 422)
assert.match(spoofedRisk.body.order.rejectReason, /RISK_RESERVE/)

const reset = resetPaperAccount({ initialCash: 250000 })
assert.equal(reset.body.account.initialCash, 250000)
assert.equal(reset.body.positions.length, 0)
assert.equal(listPaperOrders().body.orders.length, 0)

resetPaperAccount({ initialCash: 111111 }, Date.now(), 'oauth-user-a')
resetPaperAccount({ initialCash: 222222 }, Date.now(), 'oauth-user-b')
assert.equal(getPaperAccount({}, Date.now(), 'oauth-user-a').body.account.initialCash, 111111)
assert.equal(getPaperAccount({}, Date.now(), 'oauth-user-b').body.account.initialCash, 222222)

console.log('paper trade runtime smoke passed')
