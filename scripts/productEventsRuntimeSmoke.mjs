import assert from 'node:assert/strict'

delete process.env.DATABASE_URL

const { recordProductEvent, validateProductEvent } = await import('../server/productEventsRuntime.mjs')

const now = Date.UTC(2026, 6, 14, 12)
const occurredAt = new Date(now).toISOString()

const allowed = validateProductEvent({
  eventName: 'ticker_searched',
  ticker: 'nvda',
  occurredAt,
  properties: {
    source: 'search',
    range: '1m',
    statusCode: 200,
    prompt: 'raw user prompt',
    message: 'secret message',
    response: 'raw model response',
    URL: 'https://example.com/token',
    query: 'token=secret',
    userId: 'spoofed-user',
  },
}, now)
assert.equal(allowed.eventName, 'ticker_searched')
assert.equal(allowed.ticker, 'NVDA')
assert.deepEqual(allowed.properties, { source: 'search', range: '1m', statusCode: 200 })

assert.throws(
  () => validateProductEvent({ eventName: 'free_form_event', occurredAt }, now),
  /Event name is not allowed/,
)
assert.throws(
  () => validateProductEvent({ eventName: 'ticker_searched', ticker: '$NVDA', occurredAt }, now),
  /Ticker is invalid/,
)
assert.throws(
  () => validateProductEvent({ eventName: 'ticker_searched', occurredAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString() }, now),
  /older than 30 days/,
)
assert.throws(
  () => validateProductEvent({ eventName: 'ticker_searched', occurredAt: new Date(now + 6 * 60 * 1000).toISOString() }, now),
  /more than 5 minutes in the future/,
)

const disabled = await recordProductEvent({ eventName: 'education_viewed', occurredAt }, { sub: 'oauth-user-1' }, now)
assert.deepEqual(disabled, { accepted: true, storage: 'disabled' })

console.log('product events runtime smoke passed')
