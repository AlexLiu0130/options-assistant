import assert from 'node:assert/strict'
import { closeDatabase, query } from '../server/database.mjs'
import {
  closePaperPositionById,
  getPaperAccount,
  listPaperOrders,
  listPaperPositions,
  resetPaperAccount,
  submitPaperOrder,
} from '../server/paperTradeRuntime.mjs'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the PostgreSQL paper trade smoke test.')
}

if (process.env.DATABASE_SCHEMA !== 'options_assistant_dev') {
  throw new Error('The PostgreSQL paper trade smoke test only runs against DATABASE_SCHEMA=options_assistant_dev.')
}

const subject = `paper-smoke-${crypto.randomUUID()}`
const now = Date.UTC(2026, 6, 1, 14)
const closeNow = Date.UTC(2026, 6, 2, 14)
const strategy = {
  id: 'postgres-smoke-call',
  name: 'Postgres Smoke Call',
  fit: 'high',
  maxLoss: 500,
  maxProfit: 'unlimited',
  legs: [{ action: 'buy', right: 'call', strike: 100, expiration: '2026-07-17', quantity: 1, premium: 5 }],
  guardrails: [],
}

try {
  const fresh = await getPaperAccount({}, now, { sub: subject })
  assert.equal(fresh.status, 200)
  assert.equal(fresh.body.storage, 'postgres')
  assert.equal(fresh.body.account.initialCash, 1_000_000)

  const opened = await submitPaperOrder({ ticker: 'TST', strategySnapshot: strategy, underlyingPrice: 100 }, now, { sub: subject })
  assert.equal(opened.status, 201)
  assert.match(opened.body.position.id, /^[0-9a-f-]{36}$/i)

  const openPositions = await listPaperPositions({ status: 'open', currentUnderlyingPrice: 120, now: closeNow }, { sub: subject })
  assert.equal(openPositions.status, 200)
  assert.equal(openPositions.body.positions.length, 1)
  assert.ok(openPositions.body.positions[0].mark.unrealizedPnL > 0)

  const closed = await closePaperPositionById(opened.body.position.id, { currentUnderlyingPrice: 120 }, closeNow, { sub: subject })
  assert.equal(closed.status, 200)
  assert.equal(closed.body.position.status, 'closed')

  const orders = await listPaperOrders({ sub: subject })
  assert.equal(orders.body.orders.length, 2)

  const reset = await resetPaperAccount({ initialCash: 250_000 }, closeNow, { sub: subject })
  assert.equal(reset.status, 200)
  assert.equal(reset.body.clearedOrders, 2)
  assert.equal(reset.body.clearedPositions, 1)

  const events = await query(
    `SELECT event_name FROM product_events
     WHERE user_id = (SELECT id FROM users WHERE oauth_sub = $1)
     ORDER BY id`,
    [subject],
  )
  assert.deepEqual(events.rows.map((row) => row.event_name), [
    'paper_order_created',
    'paper_position_closed',
    'paper_account_reset',
  ])
  console.log('postgres paper trade smoke passed')
} finally {
  await query('DELETE FROM users WHERE oauth_sub = $1', [subject])
  await closeDatabase()
}
