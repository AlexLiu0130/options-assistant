import assert from 'node:assert/strict'
import {
  normalizeFiuCandles,
  normalizeFiuExpirations,
  normalizeFiuOptionChain,
  normalizeFiuQuote,
  pruneFiuOptionContracts,
} from '../server/fiuData.mjs'

assert.deepEqual(normalizeFiuExpirations({ data: [['2026-08-21', null], ['bad', 'W']] }), ['2026-08-21'])
assert.equal(normalizeFiuCandles({ body: { list: [
  { date: '2026-07-20', open: 2, high: 3, low: 1, close: 2.5, volume: 10 },
  { date: '2026-07-17', open: 1, high: 2, low: 0.5, close: 1.5, volume: 8 },
] } })[0].time, '2026-07-17')
assert.equal(normalizeFiuCandles({ body: { list: [
  { date: '2026-07-20 10:00:00', open: 2, high: 3, low: 1, close: 2.5, volume: 10 },
] } })[0].time, Date.parse('2026-07-20T14:00:00Z') / 1000)
assert.equal(normalizeFiuCandles({ body: { list: [
  { date: '2026-01-20 10:00:00', open: 2, high: 3, low: 1, close: 2.5, volume: 10 },
] } })[0].time, Date.parse('2026-01-20T15:00:00Z') / 1000)
const candlesWithBadRows = normalizeFiuCandles({ body: { list: [
  { date: '2026-07-22', open: 4, high: 5, low: 3, close: 4.5, volume: -1 },
  { date: '2026-07-21', open: -4, high: 5, low: 3, close: 4.5, volume: 1 },
  { date: '2026-07-20', open: 4, high: 3.5, low: 3, close: 4.5, volume: 1 },
  { date: '2026-07-17', open: 4, high: 5, low: 4.2, close: 4.1, volume: 1 },
] } })
assert.equal(candlesWithBadRows.length, 1)
assert.equal(candlesWithBadRows[0].time, '2026-07-22')
assert.equal(candlesWithBadRows[0].volume, null)

const quote = normalizeFiuQuote('AAPL', { body: [{ symbol: 'AAPL.US', snapshot: {
  lastTradePrice: 101,
  open: -100,
  high: -102,
  low: -99,
  previousClosePrice: -100,
  change: -1.25,
  changePercent: -1.22,
  volume: -50,
  time: '2026-07-20 10:00:00',
} }] })
assert.equal(quote.price, 101)
assert.equal(quote.open, null)
assert.equal(quote.high, null)
assert.equal(quote.low, null)
assert.equal(quote.previousClose, null)
assert.equal(quote.volume, null)
assert.equal(quote.change, -1.25)
assert.equal(quote.changePercent, -1.22)
assert.equal(quote.timestamp, Date.parse('2026-07-20T14:00:00Z') / 1000)
assert.equal(normalizeFiuQuote('AAPL', { data: { price: 101 } }).asOf, '')

const chain = normalizeFiuOptionChain('AAPL', '2026-08-21', { data: [[
  300,
  ['C', -10, -2, 11, 3, -10.5, 0, 0, -20, 0, 0, 11, 9, 10, -100, 40, 0.55, 0.01, -0.2, -0.1],
  ['P', 8, 2, 9, -3, 8.5, 0, 0, 30, 0, 0, 9, 7, 8, 200, 45, -0.45, -0.01, 0.25, -0.12],
]] })
assert.equal(chain.contracts.length, 2)
assert.equal(chain.contracts[0].impliedVolatility, 0.4)
assert.equal(chain.contracts[0].bid, null)
assert.equal(chain.contracts[0].bidSize, null)
assert.equal(chain.contracts[0].last, null)
assert.equal(chain.contracts[0].volume, null)
assert.equal(chain.contracts[0].openInterest, null)
assert.equal(chain.contracts[0].vega, null)
assert.equal(chain.contracts[0].theta, -0.1)
assert.equal(chain.contracts[1].askSize, null)
assert.equal(chain.contracts[1].gamma, null)
assert.equal(chain.issues.invalidGamma, 1)
assert.equal(chain.issues.invalidValues, 7)
assert.equal(pruneFiuOptionContracts(chain.contracts, 305).length, 2)

const objectChain = normalizeFiuOptionChain('NVDA', '2026-08-21', { data: [{
  strikePrice: 210,
  call: { symbol: 'NVDA260821C00210000', bidPrice: 9.1, bidVol: 3, askPrice: 9.3, askVol: 4, last: 9.2, volume: 12, position: 34, iv: 42, delta: 0.48, gamma: 0.02, vega: 0.15, theta: -0.08 },
  put: { symbol: 'NVDA260821P00210000', bidPrice: 10, bidVol: 5, askPrice: 10.2, askVol: 6, last: 10.1, volume: 21, position: 43, iv: 44, delta: -0.52, gamma: 0.02, vega: 0.16, theta: -0.09 },
}] })
assert.equal(objectChain.contracts.length, 2)
assert.equal(objectChain.contracts[0].impliedVolatility, 0.42)
assert.equal(objectChain.contracts[0].openInterest, 34)
assert.equal(objectChain.contracts[1].delta, -0.52)
console.log('FIU data adapter self-check passed.')
