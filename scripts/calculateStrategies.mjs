import { readFileSync } from 'node:fs'
import { parseUserView } from '../src/core/parseUserView.ts'
import { recommendStrategyTypes } from '../src/core/strategyRecommendationEngine.ts'

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function expiration(value) {
  const text = String(value ?? '')
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  if (/^\d{6}$/.test(text)) return `20${text.slice(0, 2)}-${text.slice(2, 4)}-${text.slice(4, 6)}`
  return text.slice(0, 10)
}

function right(value) {
  const text = String(value ?? '').toLowerCase()
  if (text === 'c' || text === 'call') return 'call'
  if (text === 'p' || text === 'put') return 'put'
  return undefined
}

function normalizeIbkrLike(input) {
  if (Array.isArray(input.contracts)) return input

  const underlying = input.underlying ?? input.market ?? {}
  const ticker = String(input.ticker ?? input.symbol ?? underlying.symbol ?? underlying.ticker ?? 'NVDA').toUpperCase()
  const contracts = input.options ?? input.optionChain ?? input.chain ?? []

  return {
    ticker,
    status: contracts.length ? 'available' : 'unavailable',
    mode: input.mode ?? 'ibkr_like',
    asOf: input.asOf ?? new Date().toISOString(),
    dataGaps: [],
    contracts: contracts
      .map((contract) => {
        const contractRight = right(contract.right ?? contract.putCall ?? contract.cp)
        const strike = num(contract.strike)
        const expiry = expiration(contract.expiration ?? contract.expiry ?? contract.lastTradeDateOrContractMonth)
        if (!contractRight || !strike || !expiry) return undefined
        return {
          symbol: String(contract.symbol ?? contract.localSymbol ?? contract.contractSymbol ?? ''),
          underlying: ticker,
          expiration: expiry,
          strike,
          right: contractRight,
          bid: num(contract.bid ?? contract.marketData?.bid ?? contract.marketData?.['84']),
          ask: num(contract.ask ?? contract.marketData?.ask ?? contract.marketData?.['86']),
          last: num(contract.last ?? contract.lastPrice ?? contract.marketData?.last ?? contract.marketData?.['31']),
          bidSize: num(contract.bidSize),
          askSize: num(contract.askSize),
          openInterest: num(contract.openInterest ?? contract.oi),
          volume: num(contract.volume),
          impliedVolatility: num(contract.impliedVolatility ?? contract.iv ?? contract.modelGreeks?.iv),
          delta: num(contract.delta ?? contract.modelGreeks?.delta ?? contract.greeks?.delta),
        }
      })
      .filter(Boolean),
  }
}

function priceFrom(input) {
  const underlying = input.underlying ?? input.market ?? {}
  return num(input.spot ?? input.price ?? underlying.price ?? underlying.last ?? underlying.lastPrice)
}

function summarize(strategy) {
  return {
    id: strategy.id,
    name: strategy.name,
    fit: strategy.fit,
    maxLoss: strategy.maxLoss,
    maxProfit: strategy.maxProfit,
    breakevens: strategy.breakevens ?? (strategy.breakeven ? [strategy.breakeven] : []),
    probabilityOfProfit: strategy.probabilityOfProfit,
    expectedMove: strategy.expectedMove,
    targetPricePl: strategy.targetPricePl,
    legs: strategy.legs,
    guardrails: strategy.guardrails,
  }
}

function calculate(input, view = 'bullish', preferredExpiration) {
  const chain = normalizeIbkrLike(input)
  const spot = priceFrom(input)
  if (!spot) throw new Error('Missing underlying price. Provide market.price, underlying.last, price, or spot.')
  const parsed = parseUserView({
    ticker: chain.ticker,
    current_price: spot,
    view,
    strength: 'moderate',
    time_horizon: '1 month',
    risk_budget: 500,
    experience_level: 'beginner',
  })
  return {
    ticker: chain.ticker,
    spot,
    view,
    expiration: preferredExpiration,
    status: chain.status,
    strategies: recommendStrategyTypes(parsed, chain, preferredExpiration).map(summarize),
  }
}

function runCheck(input) {
  for (const view of ['bullish', 'bearish', 'neutral', 'volatile']) {
    const result = calculate(input, view)
    if (!result.strategies.length) throw new Error(`No strategies for ${view}`)
    if (result.strategies.some((strategy) => typeof strategy.probabilityOfProfit !== 'number')) {
      throw new Error(`Missing PoP for ${view}`)
    }
  }
  process.stdout.write('strategy calculator check passed\n')
}

const args = process.argv.slice(2)
if (args.includes('--check')) {
  const inputPath = args.find((arg) => arg !== '--check')
  if (!inputPath) throw new Error('Usage: npm run calc:strategies -- --check <ibkr-options.json>')
  runCheck(JSON.parse(readFileSync(inputPath === '-' ? 0 : inputPath, 'utf8')))
} else {
  const inputPath = args[0]
  if (!inputPath) throw new Error('Usage: npm run calc:strategies -- <ibkr-options.json|-> [view] [expiration]')
  const view = args[1] ?? 'bullish'
  const preferredExpiration = args[2]
  const input = JSON.parse(readFileSync(inputPath === '-' ? 0 : inputPath, 'utf8'))
  process.stdout.write(`${JSON.stringify(calculate(input, view, preferredExpiration), null, 2)}\n`)
}
