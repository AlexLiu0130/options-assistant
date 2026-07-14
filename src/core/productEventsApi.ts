const eventNames = new Set<ProductEventName>([
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
const propertyKeys = new Set<ProductEventPropertyKey>([
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

export type ProductEventName =
  | 'ticker_searched'
  | 'strategy_opened'
  | 'simulator_used'
  | 'assistant_used'
  | 'paper_order_created'
  | 'paper_position_closed'
  | 'paper_account_reset'
  | 'education_viewed'
  | 'data_request_failed'

export type ProductEventPropertyKey =
  | 'source'
  | 'strategyId'
  | 'strategyName'
  | 'range'
  | 'page'
  | 'action'
  | 'dataSource'
  | 'storage'
  | 'statusCode'

export type ProductEventProperties = Partial<Record<ProductEventPropertyKey, string | number | boolean>>

export type ProductEventInput = {
  eventName: ProductEventName
  ticker?: string
  errorCategory?: string
  occurredAt?: string
  properties?: ProductEventProperties
}

function safeProperties(properties: ProductEventProperties | undefined) {
  if (!properties) return undefined
  const entries: [ProductEventPropertyKey, string | number | boolean][] = []
  for (const [key, value] of Object.entries(properties) as [ProductEventPropertyKey, unknown][]) {
    if (!propertyKeys.has(key) || entries.length >= 12) continue
    if (typeof value === 'string') entries.push([key, value.slice(0, 120)])
    else if (typeof value === 'number' && Number.isFinite(value)) entries.push([key, value])
    else if (typeof value === 'boolean') entries.push([key, value])
  }
  return entries.length ? Object.fromEntries(entries) : undefined
}

function eventPayload(event: ProductEventInput) {
  if (!eventNames.has(event.eventName)) return null
  return {
    eventName: event.eventName,
    ticker: event.ticker?.trim().toUpperCase(),
    errorCategory: event.errorCategory?.trim(),
    occurredAt: event.occurredAt,
    properties: safeProperties(event.properties),
  }
}

export function recordProductEvent(event: ProductEventInput) {
  try {
    const payload = eventPayload(event)
    if (!payload) return
    void fetch('/api/events', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {})
  } catch {
    // Fire-and-forget telemetry must never break the UI.
  }
}
