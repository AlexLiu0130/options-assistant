// Alpha Vantage payload normalizers. Payloads arrive only through the QVeris gateway.

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(String(value).replace('%', ''))
  return Number.isFinite(number) ? number : null
}

function positiveOrNull(value) {
  const number = numberOrNull(value)
  return number !== null && number > 0 ? number : null
}

function nonNegativeValueOrNull(value) {
  const number = numberOrNull(value)
  return number !== null && number >= 0 ? number : null
}

function nonNegativeOrNull(value, issues) {
  const number = numberOrNull(value)
  if (number === null) return null
  if (number < 0) {
    issues.invalidValues += 1
    return null
  }
  return number
}

export function newYorkEpochSeconds(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null
  const wallTime = Date.UTC(...match.slice(1).map((part) => Number(part ?? 0)).map((part, index) => index === 1 ? part - 1 : part))
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  })
  let instant = wallTime
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(({ type, value: part }) => [type, part]))
    const represented = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    )
    instant += wallTime - represented
  }
  return Math.floor(instant / 1000)
}

function newYorkDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
}

// GLOBAL_QUOTE only exposes the latest trading day, so the timestamp is "now" while that
// session is today and the market is open, otherwise that session's 16:00 ET close.
export function normalizeAlphaVantageQuote(ticker, result, { marketOpen = false, now = Date.now() } = {}) {
  const data = result?.['Global Quote'] ?? result?.globalQuote ?? {}
  const price = positiveOrNull(data['05. price'])
  const previousClose = positiveOrNull(data['08. previous close'])
  const tradingDay = String(data['07. latest trading day'] ?? '')
  const isLive = marketOpen && tradingDay === newYorkDate(now)
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(tradingDay)
    ? (isLive ? Math.floor(now / 1000) : newYorkEpochSeconds(`${tradingDay} 16:00:00`) ?? 0)
    : 0
  return {
    ticker,
    price,
    open: positiveOrNull(data['02. open']),
    high: positiveOrNull(data['03. high']),
    low: positiveOrNull(data['04. low']),
    previousClose,
    change: numberOrNull(data['09. change']) ?? (price !== null && previousClose !== null ? price - previousClose : null),
    changePercent: numberOrNull(data['10. change percent']),
    volume: nonNegativeValueOrNull(data['06. volume']),
    timestamp,
    asOf: timestamp ? new Date(timestamp * 1000).toISOString() : '',
    source: 'QVeris',
    marketDataType: isLive ? 'realtime_quote' : 'last_close_quote',
    candles: [],
  }
}

export function normalizeAlphaVantageCandles(result) {
  const seriesKey = Object.keys(result ?? {}).find((key) => /time series/i.test(key))
  const series = seriesKey ? result[seriesKey] : {}
  return Object.entries(series ?? {})
    .map(([date, row]) => {
      const open = positiveOrNull(row?.['1. open'])
      const high = positiveOrNull(row?.['2. high'])
      const low = positiveOrNull(row?.['3. low'])
      const close = positiveOrNull(row?.['4. close'])
      if ([open, high, low, close].some((value) => value === null)) return null
      if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null
      const time = date.includes(' ') ? newYorkEpochSeconds(date) : date
      if (time === null) return null
      return { time, open, high, low, close, volume: nonNegativeValueOrNull(row?.['5. volume'] ?? row?.['6. volume']) }
    })
    .filter(Boolean)
    .sort((a, b) => (typeof a.time === 'number' ? a.time - b.time : String(a.time).localeCompare(String(b.time))))
}

// Groups consecutive intraday bars of the same session day into larger bars (e.g. 60min -> 4h).
export function aggregateCandles(candles, size) {
  if (size <= 1) return candles
  const groups = []
  for (const candle of candles) {
    const day = newYorkDate(Number(candle.time) * 1000)
    const last = groups.at(-1)
    if (last && last.day === day && last.rows.length < size) last.rows.push(candle)
    else groups.push({ day, rows: [candle] })
  }
  return groups.map(({ rows }) => ({
    time: rows[0].time,
    open: rows[0].open,
    high: Math.max(...rows.map((row) => row.high)),
    low: Math.min(...rows.map((row) => row.low)),
    close: rows.at(-1).close,
    volume: rows.every((row) => row.volume === null) ? null : rows.reduce((sum, row) => sum + (row.volume ?? 0), 0),
  }))
}

export function normalizeAlphaVantageOptionChain(ticker, result) {
  const rows = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : []
  const issues = { invalidMarkets: 0, invalidGamma: 0, invalidDelta: 0, invalidValues: 0 }
  const contracts = []
  for (const row of rows) {
    const strike = positiveOrNull(row?.strike)
    const expiration = String(row?.expiration ?? '')
    const right = String(row?.type ?? '').toLowerCase()
    if (!strike || !/^\d{4}-\d{2}-\d{2}$/.test(expiration) || !['call', 'put'].includes(right) || !row?.contractID) continue
    let bid = nonNegativeOrNull(row.bid, issues)
    let ask = nonNegativeOrNull(row.ask, issues)
    if (bid !== null && ask !== null && bid > ask) {
      bid = null
      ask = null
      issues.invalidMarkets += 1
    }
    const gammaValue = numberOrNull(row.gamma)
    const gamma = gammaValue !== null && gammaValue >= 0 ? gammaValue : null
    if (gammaValue !== null && gamma === null) issues.invalidGamma += 1
    const deltaValue = numberOrNull(row.delta)
    const delta = deltaValue !== null && deltaValue >= -1 && deltaValue <= 1 ? deltaValue : null
    if (deltaValue !== null && delta === null) issues.invalidDelta += 1
    const iv = numberOrNull(row.implied_volatility)
    contracts.push({
      quoteDate: String(row.date ?? ''),
      symbol: String(row.contractID),
      underlying: ticker,
      expiration,
      strike,
      right,
      bid,
      ask,
      last: nonNegativeOrNull(row.last, issues),
      bidSize: nonNegativeOrNull(row.bid_size, issues),
      askSize: nonNegativeOrNull(row.ask_size, issues),
      volume: nonNegativeOrNull(row.volume, issues),
      openInterest: nonNegativeOrNull(row.open_interest, issues),
      impliedVolatility: iv !== null && iv > 0 ? iv : null,
      delta,
      gamma,
      vega: nonNegativeOrNull(row.vega, issues),
      theta: numberOrNull(row.theta),
    })
  }
  return { contracts, issues }
}

export function optionExpirations(contracts) {
  return [...new Set(contracts.map((contract) => contract.expiration))].sort()
}

// Put-call parity on the nearest expiration: spot ~= K + C - P at the strike where C and P mids are closest.
export function impliedSpotFromChain(contracts, today) {
  const mid = (row) => (row?.bid !== null && row?.ask !== null && row?.ask > 0 ? (row.bid + row.ask) / 2 : null)
  for (const expiration of optionExpirations(contracts).filter((value) => value >= today)) {
    const rows = contracts.filter((row) => row.expiration === expiration)
    const pairs = [...new Set(rows.map((row) => row.strike))].map((strike) => {
      const call = mid(rows.find((row) => row.strike === strike && row.right === 'call'))
      const put = mid(rows.find((row) => row.strike === strike && row.right === 'put'))
      return call !== null && put !== null ? { strike, call, put } : null
    }).filter(Boolean)
    if (!pairs.length) continue
    const best = pairs.sort((a, b) => Math.abs(a.call - a.put) - Math.abs(b.call - b.put))[0]
    const spot = best.strike + best.call - best.put
    if (Number.isFinite(spot) && spot > 0) return Number(spot.toFixed(2))
  }
  return null
}

export function pruneOptionContracts(contracts, spot, strikesPerExpiration = 25) {
  if (!Number.isFinite(spot) || spot <= 0) return []
  const byExpiration = new Map()
  for (const contract of contracts) {
    const rows = byExpiration.get(contract.expiration) ?? []
    rows.push(contract)
    byExpiration.set(contract.expiration, rows)
  }
  return [...byExpiration.values()].flatMap((rows) => {
    const strikes = [...new Set(rows.map((row) => row.strike))]
      .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))
      .slice(0, strikesPerExpiration)
    const keep = new Set(strikes)
    return rows.filter((row) => keep.has(row.strike))
  }).sort((a, b) => a.expiration.localeCompare(b.expiration) || a.strike - b.strike || a.right.localeCompare(b.right))
}

export function volatilityFromContracts(ticker, spot, contracts, asOf) {
  const rows = contracts.filter((row) => Number.isFinite(row.impliedVolatility) && Number.isFinite(row.strike))
  const expirations = [...new Set(rows.map((row) => row.expiration))].sort()
  const moneyness = [0.8, 0.9, 1, 1.1, 1.2]
  const iv = expirations.map((expiration) => moneyness.map((ratio) => {
    const target = spot * ratio
    const candidates = rows.filter((row) => row.expiration === expiration)
      .sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))
    return candidates[0]?.impliedVolatility ?? null
  }))
  return {
    ticker,
    spot,
    asOf,
    tenors: expirations.map((expiration) => Math.max(0, Math.ceil((Date.parse(`${expiration}T00:00:00Z`) - Date.now()) / 86_400_000))),
    moneyness,
    iv,
    dataGaps: ['QVERIS_DATA_GAP: IV Rank/Percentile unavailable; surface is derived from live option contract IV.'],
  }
}
