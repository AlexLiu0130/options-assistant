import { query } from './database.mjs'

function analyticsDays(value) {
  const days = Number(value)
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    const error = new Error('days must be an integer from 1 to 90.')
    error.status = 400
    error.expose = true
    throw error
  }
  return days
}

export async function getAdminAnalytics(inputDays = 7) {
  const days = analyticsDays(inputDays)
  const [overview, daily, events, tickers, strategies] = await Promise.all([
    query(
      `SELECT count(*)::int AS event_count,
              count(DISTINCT user_id)::int AS active_users,
              count(DISTINCT user_id) FILTER (WHERE event_name = 'paper_order_created')::int AS paper_users,
              count(*) FILTER (WHERE event_name = 'paper_order_created')::int AS paper_orders,
              count(*) FILTER (WHERE event_name = 'data_request_failed')::int AS data_failures
       FROM product_events
       WHERE occurred_at >= now() - ($1::int * interval '1 day')`,
      [days],
    ),
    query(
      `WITH calendar AS (
         SELECT generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date AS day
       )
       SELECT to_char(calendar.day, 'MM-DD') AS day,
              count(product_events.id)::int AS event_count,
              count(DISTINCT product_events.user_id)::int AS active_users
       FROM calendar
       LEFT JOIN product_events
         ON product_events.occurred_at >= calendar.day
        AND product_events.occurred_at < calendar.day + interval '1 day'
       GROUP BY calendar.day
       ORDER BY calendar.day`,
      [days],
    ),
    query(
      `SELECT event_name, count(*)::int AS count
       FROM product_events
       WHERE occurred_at >= now() - ($1::int * interval '1 day')
       GROUP BY event_name
       ORDER BY count DESC, event_name ASC`,
      [days],
    ),
    query(
      `SELECT ticker, count(*)::int AS count
       FROM product_events
       WHERE occurred_at >= now() - ($1::int * interval '1 day')
         AND ticker IS NOT NULL
       GROUP BY ticker
       ORDER BY count DESC, ticker ASC
       LIMIT 12`,
      [days],
    ),
    query(
      `SELECT coalesce(nullif(properties ->> 'strategyName', ''), properties ->> 'strategyId') AS strategy,
              count(*)::int AS count
       FROM product_events
       WHERE occurred_at >= now() - ($1::int * interval '1 day')
         AND properties ? 'strategyId'
       GROUP BY strategy
       ORDER BY count DESC, strategy ASC
       LIMIT 12`,
      [days],
    ),
  ])

  return {
    asOf: new Date().toISOString(),
    windowDays: days,
    overview: overview.rows[0],
    daily: daily.rows,
    events: events.rows,
    tickers: tickers.rows,
    strategies: strategies.rows,
  }
}
