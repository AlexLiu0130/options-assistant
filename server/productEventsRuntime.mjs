import { transaction } from './database.mjs'

const postgresStorage = 'postgres'
const disabledStorage = 'disabled'
const eventNames = new Set([
  'ticker_searched',
  'strategy_opened',
  'simulator_used',
  'assistant_used',
  'paper_order_created',
  'paper_position_closed',
  'paper_account_reset',
  'education_viewed',
  'data_request_failed',
])
const propertyKeys = new Set([
  'source',
  'strategyId',
  'strategyName',
  'range',
  'page',
  'action',
  'dataSource',
  'storage',
  'statusCode',
])
const tickerPattern = /^[A-Z][A-Z0-9.-]{0,9}$/
const errorCategoryPattern = /^[A-Za-z0-9_-]{1,40}$/
const maxFutureMs = 5 * 60 * 1000
const maxPastMs = 30 * 24 * 60 * 60 * 1000

function productEventError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  error.expose = true
  return error
}

function isPostgresEnabled() {
  return Boolean(process.env.DATABASE_URL)
}

function nowMs(now = Date.now()) {
  const value = now instanceof Date ? now.getTime() : Number(now)
  return Number.isFinite(value) ? value : Date.now()
}

function authSubject(user) {
  const sub = String(typeof user === 'object' && user ? user.sub : '').trim()
  if (!sub) throw productEventError('Authentication required.', 401)
  return sub
}

function authEmail(user) {
  const value = typeof user === 'object' && user ? user.email : null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function authDisplayName(user) {
  const value = typeof user === 'object' && user ? user.name ?? user.displayName : null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseOccurredAt(value, now) {
  if (value === undefined || value === null || value === '') return new Date(now).toISOString()
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw productEventError('occurredAt must be a valid ISO timestamp.')
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw productEventError('occurredAt must be a valid ISO timestamp.')
  if (parsed > now + maxFutureMs) throw productEventError('occurredAt cannot be more than 5 minutes in the future.')
  if (parsed < now - maxPastMs) throw productEventError('occurredAt cannot be older than 30 days.')
  return new Date(parsed).toISOString()
}

function safeProperties(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = []
  for (const [key, raw] of Object.entries(value)) {
    if (!propertyKeys.has(key) || entries.length >= 12) continue
    if (typeof raw === 'string') entries.push([key, raw.slice(0, 120)])
    else if (typeof raw === 'number' && Number.isFinite(raw)) entries.push([key, raw])
    else if (typeof raw === 'boolean') entries.push([key, raw])
  }
  return Object.fromEntries(entries)
}

export function validateProductEvent(body = {}, now = Date.now()) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const currentMs = nowMs(now)
  const eventName = String(input.eventName ?? '').trim()
  if (!eventNames.has(eventName)) throw productEventError('Event name is not allowed.')

  const ticker = input.ticker === undefined || input.ticker === null || input.ticker === ''
    ? null
    : String(input.ticker).trim().toUpperCase()
  if (ticker && !tickerPattern.test(ticker)) throw productEventError('Ticker is invalid.')

  const errorCategory = input.errorCategory === undefined || input.errorCategory === null || input.errorCategory === ''
    ? null
    : String(input.errorCategory).trim()
  if (errorCategory && !errorCategoryPattern.test(errorCategory)) {
    throw productEventError('errorCategory is invalid.')
  }

  return {
    eventName,
    ticker,
    errorCategory,
    properties: safeProperties(input.properties),
    occurredAt: parseOccurredAt(input.occurredAt, currentMs),
    createdAt: new Date(currentMs).toISOString(),
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
  return result.rows[0].id
}

export async function recordProductEvent(body, authUser, now = Date.now()) {
  const event = validateProductEvent(body, now)
  authSubject(authUser)
  if (!isPostgresEnabled()) return { accepted: true, storage: disabledStorage }

  try {
    await transaction(async (client) => {
      const userId = await ensurePostgresUser(client, authUser)
      await client.query(
        `INSERT INTO product_events
           (user_id, event_name, ticker, error_category, properties, occurred_at, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          userId,
          event.eventName,
          event.ticker,
          event.errorCategory,
          JSON.stringify(event.properties),
          event.occurredAt,
          event.createdAt,
        ],
      )
    })
    return { accepted: true, storage: postgresStorage }
  } catch (error) {
    console.error('[product-events-db]', error?.code || error?.name || 'Error')
    throw productEventError('Product event storage is unavailable.', 500)
  }
}
