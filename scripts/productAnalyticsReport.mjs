import { closeDatabase, query } from '../server/database.mjs'

const input = process.argv.find((value) => value.startsWith('--days='))
const days = input ? Number(input.slice('--days='.length)) : 7

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the product analytics report.')
}

if (!Number.isInteger(days) || days < 1 || days > 90) {
  throw new Error('--days must be an integer from 1 to 90.')
}

try {
  const [events, tickers, strategies] = await Promise.all([
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
       LIMIT 20`,
      [days],
    ),
    query(
      `SELECT properties ->> 'strategyId' AS strategy_id,
              max(properties ->> 'strategyName') AS strategy_name,
              count(*)::int AS count
       FROM product_events
       WHERE occurred_at >= now() - ($1::int * interval '1 day')
         AND properties ? 'strategyId'
       GROUP BY properties ->> 'strategyId'
       ORDER BY count DESC, strategy_id ASC
       LIMIT 20`,
      [days],
    ),
  ])

  console.log(JSON.stringify({
    windowDays: days,
    eventCounts: events.rows,
    topTickers: tickers.rows,
    topStrategies: strategies.rows,
  }, null, 2))
} finally {
  await closeDatabase()
}
