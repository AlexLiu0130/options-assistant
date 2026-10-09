// Read-only data tools the narrator can call through DeepSeek function calling.
// Every tool answers from the same QVeris snapshot the plan was built on (or the server's own cached
// endpoints), and every number a tool returns is added to the set the response guard trusts.
import { strategyExpirationPayoff } from '../src/core/payoffEngine.ts'
import { netGreeks, premiumPlanFields } from './assistantAgent.mjs'

const MAX_ROWS = 24

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(Number(value).toFixed(digits)) : undefined
}

function daysTo(expiration, now = Date.now()) {
  return Math.max(0, Math.ceil((Date.parse(`${expiration}T21:00:00Z`) - now) / 86_400_000))
}

function mid(row) {
  if (typeof row.bid === 'number' && typeof row.ask === 'number' && row.ask > 0 && row.ask >= row.bid) return round((row.bid + row.ask) / 2)
  return typeof row.last === 'number' && row.last > 0 ? row.last : undefined
}

function expirationsOf(contracts) {
  const today = new Date().toISOString().slice(0, 10)
  return [...new Set(contracts.map((row) => row.expiration))].filter((expiration) => expiration >= today).sort()
}

function closestExpiration(contracts, requested, fallback) {
  const list = expirationsOf(contracts)
  if (!list.length) return undefined
  const target = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : fallback
  if (!target) return list[0]
  const time = Date.parse(`${target}T00:00:00Z`)
  return [...list].sort((a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - time) - Math.abs(Date.parse(`${b}T00:00:00Z`) - time))[0]
}

// ATM IV is the average of the call and put IV at the strike closest to spot.
export function atmImpliedVolatility(contracts = [], spot, expiration) {
  const rows = contracts.filter((row) => row.expiration === expiration && Number.isFinite(row.impliedVolatility) && row.impliedVolatility > 0)
  if (!rows.length || !(spot > 0)) return undefined
  const strike = [...new Set(rows.map((row) => row.strike))].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))[0]
  const atm = rows.filter((row) => row.strike === strike)
  return { strike, impliedVolatility: atm.reduce((sum, row) => sum + row.impliedVolatility, 0) / atm.length }
}

export function volatilitySummary(contracts = [], spot, expiration) {
  const chosen = closestExpiration(contracts, expiration, expiration)
  if (!chosen) return undefined
  const atm = atmImpliedVolatility(contracts, spot, chosen)
  if (!atm) return undefined
  const dte = daysTo(chosen)
  const move = spot * atm.impliedVolatility * Math.sqrt(Math.max(dte, 1) / 365)
  return {
    expiration: chosen,
    dte,
    atmStrike: atm.strike,
    atmImpliedVolatilityPercent: round(atm.impliedVolatility * 100, 1),
    impliedVolatility: round(atm.impliedVolatility, 4),
    expectedMove: round(move),
    expectedMovePercent: round((move / spot) * 100, 1),
    expectedLow: round(spot - move),
    expectedHigh: round(spot + move),
  }
}

export const assistantToolSpecs = [
  {
    type: 'function',
    function: {
      name: 'get_quote',
      description: 'Latest stock quote for the current ticker: price, change, open, high, low, previous close, volume, timestamp.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_expirations',
      description: 'Listed option expirations for the current ticker with days to expiration.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_option_quotes',
      description: 'Option chain rows (bid, ask, mid, IV, delta, gamma, theta, vega, volume, open interest) for one expiration, near the money unless strikes are given.',
      parameters: {
        type: 'object',
        properties: {
          expiration: { type: 'string', description: 'YYYY-MM-DD; the closest listed expiration is used.' },
          right: { type: 'string', enum: ['call', 'put', 'both'] },
          strikes: { type: 'array', items: { type: 'number' }, description: 'Specific strikes to return.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_iv_term_structure',
      description: 'At-the-money implied volatility for each listed expiration.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_expected_move',
      description: 'Market-implied one standard deviation move to an expiration from ATM IV (a priced range, not a forecast).',
      parameters: { type: 'object', properties: { expiration: { type: 'string', description: 'YYYY-MM-DD' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'strategy_pl_at_price',
      description: 'Profit/loss in dollars at expiration of a candidate strategy if the stock ends at the given prices.',
      parameters: {
        type: 'object',
        properties: {
          strategy_id: { type: 'string', description: 'Strategy id from the plan; defaults to the focus strategy.' },
          prices: { type: 'array', items: { type: 'number' }, description: 'Up to 6 stock prices.' },
        },
        required: ['prices'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_strategy_details',
      description: 'Legs, net position Greeks, max loss/profit, breakevens, POP and scenario rows of a candidate strategy.',
      parameters: { type: 'object', properties: { strategy_id: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_price_history',
      description: 'Daily price history summary: period return, high, low, realized volatility.',
      parameters: { type: 'object', properties: { range: { type: 'string', enum: ['3m', '1y'] } } },
    },
  },
]

export function createAssistantTools({ ticker, context, fetchJson, focusStrategyId }) {
  const outputs = []
  const calls = []
  const contracts = Array.isArray(context?.options?.contracts) ? context.options.contracts : []
  const spot = Number(context?.market?.price) || undefined
  const strategies = Array.isArray(context?.strategies) ? context.strategies : []
  const strategyFor = (id) => strategies.find((item) => item.id === id) ?? strategies.find((item) => item.id === focusStrategyId) ?? strategies.find((item) => item.legs?.length)
  const defaultExpiration = () => strategyFor()?.legs?.[0]?.expiration

  const handlers = {
    async get_quote() {
      const quote = context?.market?.price ? context.market : await fetchJson(`/api/quote/${encodeURIComponent(ticker)}`)
      return {
        ticker,
        price: quote.price,
        change: quote.change,
        changePercent: quote.changePercent,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        previousClose: quote.previousClose,
        volume: quote.volume,
        asOf: quote.asOf,
        quoteType: quote.marketDataType,
      }
    },
    async get_expirations() {
      return { ticker, expirations: expirationsOf(contracts).map((expiration) => ({ expiration, dte: daysTo(expiration) })) }
    },
    async get_option_quotes({ expiration, right = 'both', strikes } = {}) {
      const chosen = closestExpiration(contracts, expiration, defaultExpiration())
      if (!chosen) return { error: 'No option chain is available.' }
      let rows = contracts.filter((row) => row.expiration === chosen && (right === 'both' || row.right === right))
      if (Array.isArray(strikes) && strikes.length) {
        const wanted = strikes.map(Number).filter(Number.isFinite).slice(0, 10)
        rows = rows.filter((row) => wanted.includes(row.strike))
      } else if (spot) {
        const near = [...new Set(rows.map((row) => row.strike))].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, right === 'both' ? 6 : 10)
        rows = rows.filter((row) => near.includes(row.strike))
      }
      return {
        ticker,
        spot,
        expiration: chosen,
        dte: daysTo(chosen),
        rows: rows.sort((a, b) => a.strike - b.strike || a.right.localeCompare(b.right)).slice(0, MAX_ROWS).map((row) => ({
          right: row.right,
          strike: row.strike,
          bid: row.bid,
          ask: row.ask,
          mid: mid(row),
          impliedVolatilityPercent: round(row.impliedVolatility * 100, 1),
          delta: round(row.delta, 3),
          gamma: round(row.gamma, 4),
          theta: round(row.theta, 3),
          vega: round(row.vega, 3),
          volume: row.volume,
          openInterest: row.openInterest,
        })),
      }
    },
    async get_iv_term_structure() {
      if (!spot) return { error: 'Spot price unavailable.' }
      return {
        ticker,
        spot,
        termStructure: expirationsOf(contracts).slice(0, 10).map((expiration) => {
          const atm = atmImpliedVolatility(contracts, spot, expiration)
          return { expiration, dte: daysTo(expiration), atmStrike: atm?.strike, atmImpliedVolatilityPercent: atm ? round(atm.impliedVolatility * 100, 1) : undefined }
        }),
      }
    },
    async get_expected_move({ expiration } = {}) {
      if (!spot) return { error: 'Spot price unavailable.' }
      return { ticker, spot, ...(volatilitySummary(contracts, spot, expiration ?? defaultExpiration()) ?? { error: 'No implied volatility available.' }) }
    },
    async strategy_pl_at_price({ strategy_id: id, prices = [] } = {}) {
      const strategy = strategyFor(id)
      if (!strategy?.legs?.length) return { error: 'No strategy with live legs.' }
      const list = (Array.isArray(prices) ? prices : [prices]).map(Number).filter((price) => price > 0).slice(0, 6)
      return {
        strategyId: strategy.id,
        strategyName: strategy.name,
        expiration: strategy.legs[0].expiration,
        results: list.map((price) => ({ price, plAtExpiration: strategyExpirationPayoff(strategy.legs, price) })),
        maxLoss: strategy.maxLoss,
        maxProfit: strategy.maxProfit,
        breakevens: strategy.breakevens ?? (strategy.breakeven ? [strategy.breakeven] : []),
      }
    },
    async get_strategy_details({ strategy_id: id } = {}) {
      const strategy = strategyFor(id)
      if (!strategy) return { error: 'Strategy not found.' }
      return {
        strategyId: strategy.id,
        strategyName: strategy.name,
        legs: (strategy.legs ?? []).map((leg) => ({ action: leg.action, right: leg.right, strike: leg.strike, expiration: leg.expiration, quantity: leg.quantity, premium: leg.premium, impliedVolatilityPercent: round(leg.impliedVolatility * 100, 1), delta: round(leg.delta, 3) })),
        netGreeks: netGreeks(strategy),
        ...premiumPlanFields(strategy),
        maxLoss: strategy.maxLoss,
        maxProfit: strategy.maxProfit,
        breakevens: strategy.breakevens ?? (strategy.breakeven ? [strategy.breakeven] : []),
        probabilityOfProfitPercent: strategy.probabilityOfProfit,
        scenarios: (strategy.scenarioRows ?? []).slice(0, 6),
      }
    },
    async get_price_history({ range = '3m' } = {}) {
      const body = await fetchJson(`/api/market/${encodeURIComponent(ticker)}?range=${range === '1y' ? '1y' : '3m'}`)
      const candles = (body.candles ?? []).filter((candle) => candle.close > 0)
      if (candles.length < 2) return { error: 'Price history unavailable.' }
      const closes = candles.map((candle) => candle.close)
      const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]))
      const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
      const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1)
      return {
        ticker,
        range: range === '1y' ? '1y' : '3m',
        from: String(candles[0].time),
        to: String(candles.at(-1).time),
        tradingDays: candles.length,
        firstClose: closes[0],
        lastClose: closes.at(-1),
        returnPercent: round((closes.at(-1) / closes[0] - 1) * 100, 1),
        high: Math.max(...candles.map((candle) => candle.high)),
        low: Math.min(...candles.map((candle) => candle.low)),
        realizedVolatilityPercent: round(Math.sqrt(variance * 252) * 100, 1),
      }
    },
  }

  async function run(name, args) {
    const handler = handlers[name]
    let result
    try {
      result = handler ? await handler(args && typeof args === 'object' ? args : {}) : { error: `Unknown tool ${name}.` }
    } catch (error) {
      result = { error: `Tool ${name} failed: ${error?.message ?? 'unknown error'}` }
    }
    calls.push(name)
    if (!result?.error) outputs.push(result)
    return result
  }

  return { run, outputs, calls }
}
