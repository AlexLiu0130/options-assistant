import assert from 'node:assert/strict'
import {
  aggregateCandles,
  impliedSpotFromChain,
  normalizeAlphaVantageCandles,
  normalizeAlphaVantageOptionChain,
  normalizeAlphaVantageQuote,
  pruneOptionContracts,
} from '../server/alphaVantageData.mjs'

const quote = normalizeAlphaVantageQuote('MU', { 'Global Quote': {
  '02. open': '100', '03. high': '105', '04. low': '99', '05. price': '104', '06. volume': '1000',
  '07. latest trading day': '2026-10-07', '08. previous close': '101', '09. change': '3', '10. change percent': '2.97%',
} }, { marketOpen: false, now: Date.UTC(2026, 9, 8, 15) })
assert.equal(quote.price, 104)
assert.equal(quote.changePercent, 2.97)
assert.equal(quote.asOf, '2026-10-07T20:00:00.000Z')
assert.equal(quote.marketDataType, 'last_close_quote')
assert.equal(normalizeAlphaVantageQuote('MU', { Information: 'limit' }).price, null)

const intraday = normalizeAlphaVantageCandles({ 'Time Series (60min)': {
  '2026-10-07 11:00:00': { '1. open': '2', '2. high': '3', '3. low': '1', '4. close': '2.5', '5. volume': '10' },
  '2026-10-07 10:00:00': { '1. open': '1', '2. high': '2', '3. low': '0.5', '4. close': '2', '5. volume': '5' },
  '2026-10-07 12:00:00': { '1. open': '5', '2. high': '1', '3. low': '1', '4. close': '1', '5. volume': '1' },
} })
assert.equal(intraday.length, 2)
assert.equal(intraday[0].time, Date.UTC(2026, 9, 7, 14) / 1000)
assert.deepEqual(aggregateCandles(intraday, 4), [{ time: intraday[0].time, open: 1, high: 3, low: 0.5, close: 2.5, volume: 15 }])
assert.equal(normalizeAlphaVantageCandles({ 'Time Series (Daily)': { '2026-10-07': { '1. open': '1', '2. high': '2', '3. low': '1', '4. close': '2', '5. volume': '9' } } })[0].time, '2026-10-07')

const row = (type, strike, bid, ask, extra = {}) => ({
  contractID: `MU261120${type[0].toUpperCase()}${strike}`, expiration: '2026-11-20', strike: String(strike), type,
  bid: String(bid), ask: String(ask), last: '1', bid_size: '1', ask_size: '1', volume: '1', open_interest: '1',
  implied_volatility: '0.5', delta: type === 'call' ? '0.5' : '-0.5', gamma: '0.01', vega: '0.2', theta: '-0.1', date: '2026-10-07', ...extra,
})
const chain = normalizeAlphaVantageOptionChain('MU', { data: [
  row('call', 100, 6, 6.2), row('put', 100, 2, 2.2), row('call', 120, 1, 1.2), row('put', 120, 3, 2, { gamma: '-1' }),
  { contractID: 'bad', expiration: 'bad', strike: '1', type: 'call' },
] })
assert.equal(chain.contracts.length, 4)
assert.equal(chain.contracts[0].impliedVolatility, 0.5)
assert.equal(chain.issues.invalidMarkets, 1)
assert.equal(chain.issues.invalidGamma, 1)
assert.equal(impliedSpotFromChain(chain.contracts, '2026-10-08'), 104)
assert.equal(pruneOptionContracts(chain.contracts, 104, 1).length, 2)

console.log('Alpha Vantage data adapter self-check passed.')
