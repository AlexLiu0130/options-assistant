function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function providerData(result) {
  return result?.data ?? result?.body?.data ?? result?.body ?? result
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

function positiveOrNull(value) {
  const number = numberOrNull(value)
  return number !== null && number > 0 ? number : null
}

function nonNegativeValueOrNull(value) {
  const number = numberOrNull(value)
  return number !== null && number >= 0 ? number : null
}

export function fiuNewYorkEpochSeconds(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null
  const wallTime = Date.UTC(...match.slice(1).map(Number).map((part, index) => index === 1 ? part - 1 : part))
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

export function normalizeFiuCandles(result) {
  const body = result?.body ?? result
  const rows = Array.isArray(body?.list) ? body.list : []
  return rows
    .map((row) => {
      const open = positiveOrNull(row?.open)
      const high = positiveOrNull(row?.high)
      const low = positiveOrNull(row?.low)
      const close = positiveOrNull(row?.close)
      if (!row?.date || [open, high, low, close].some((value) => value === null)) return null
      if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null
      const date = String(row.date)
      const time = date.includes(' ') ? fiuNewYorkEpochSeconds(date) : date
      if (time === null) return null
      return {
        time,
        open,
        high,
        low,
        close,
        volume: nonNegativeValueOrNull(row.volume),
      }
    })
    .filter(Boolean)
    .reverse()
}

export function normalizeFiuQuote(ticker, result) {
  const fiuRow = Array.isArray(result?.body)
    ? result.body.find((item) => String(item?.symbol ?? '').toUpperCase() === `${ticker}.US`)
    : undefined
  const data = fiuRow?.snapshot ?? result?.data?.[`${ticker}.US`] ?? result?.data?.[ticker] ?? result?.[`${ticker}.US`] ?? result?.[ticker] ?? result?.data ?? result
  const rawTime = numberOrNull(data?.lastTradeTime ?? data?.timestamp)
    ?? (data?.time ? (fiuNewYorkEpochSeconds(data.time) ?? 0) * 1000 : null)
  const timestamp = rawTime && rawTime > 0
    ? Math.floor(rawTime > 1e12 ? rawTime / 1000 : rawTime)
    : 0
  const price = positiveOrNull(data?.lastTradePrice ?? data?.price ?? data?.last ?? data?.close ?? data?.ethPrice)
  const previousClose = positiveOrNull(data?.previousClosePrice ?? data?.previousClose ?? data?.preClose)
  const change = numberOrNull(data?.change) ?? (price !== null && previousClose !== null ? price - previousClose : null)
  return {
    ticker,
    price,
    open: positiveOrNull(data?.open),
    high: positiveOrNull(data?.high),
    low: positiveOrNull(data?.low),
    previousClose,
    change,
    changePercent: numberOrNull(data?.changePercent ?? data?.changeRate),
    volume: nonNegativeValueOrNull(data?.volume ?? data?.size),
    timestamp,
    asOf: timestamp ? new Date(timestamp * 1000).toISOString() : '',
    source: 'QVeris',
    marketDataType: fiuRow ? 'realtime_quote' : 'delayed_quote',
    candles: [],
  }
}

export function normalizeFiuExpirations(result) {
  const rows = providerData(result)
  return (Array.isArray(rows) ? rows : [])
    .map((row) => String(Array.isArray(row) ? row[0] : row?.expiration ?? ''))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
}

function normalizeLeg(ticker, expiration, strike, right, leg, issues) {
  if (!leg || typeof leg !== 'object') return null
  const array = Array.isArray(leg)
  const symbol = array ? leg[0] : leg.symbol
  if (!symbol) return null
  let bid = nonNegativeOrNull(array ? leg[1] : leg.bidPrice, issues)
  let ask = nonNegativeOrNull(array ? leg[3] : leg.askPrice, issues)
  const gammaValue = numberOrNull(array ? leg[17] : leg.gamma)
  if (bid !== null && ask !== null && bid > ask) {
    bid = null
    ask = null
    issues.invalidMarkets += 1
  }
  const deltaValue = numberOrNull(array ? leg[16] : leg.delta)
  const ivPercent = numberOrNull(array ? leg[15] : leg.iv)
  const gamma = gammaValue !== null && gammaValue >= 0 ? gammaValue : null
  if (gammaValue !== null && gamma === null) issues.invalidGamma += 1
  const delta = deltaValue !== null && deltaValue >= -1 && deltaValue <= 1 ? deltaValue : null
  if (deltaValue !== null && delta === null) issues.invalidDelta += 1
  return {
    quoteDate: '',
    symbol: String(symbol),
    underlying: ticker,
    expiration,
    strike,
    right,
    bid,
    ask,
    last: nonNegativeOrNull(array ? leg[5] : leg.last, issues),
    bidSize: nonNegativeOrNull(array ? leg[2] : leg.bidVol, issues),
    askSize: nonNegativeOrNull(array ? leg[4] : leg.askVol, issues),
    volume: nonNegativeOrNull(array ? leg[8] : leg.volume, issues),
    openInterest: nonNegativeOrNull(array ? leg[14] : leg.position, issues),
    impliedVolatility: ivPercent !== null && ivPercent >= 0 ? ivPercent / 100 : null,
    delta,
    gamma,
    vega: nonNegativeOrNull(array ? leg[18] : leg.vega, issues),
    theta: numberOrNull(array ? leg[19] : leg.theta),
  }
}

export function normalizeFiuOptionChain(ticker, expiration, result) {
  const rows = providerData(result)
  const issues = { invalidMarkets: 0, invalidGamma: 0, invalidDelta: 0, invalidValues: 0 }
  const contracts = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const strike = numberOrNull(Array.isArray(row) ? row[0] : row?.strikePrice)
    if (strike === null || strike <= 0) continue
    const call = normalizeLeg(ticker, expiration, strike, 'call', Array.isArray(row) ? row[1] : row.call, issues)
    const put = normalizeLeg(ticker, expiration, strike, 'put', Array.isArray(row) ? row[2] : row.put, issues)
    if (call) contracts.push(call)
    if (put) contracts.push(put)
  }
  return { contracts, issues }
}

export function pruneFiuOptionContracts(contracts, spot, strikesPerExpiration = 25) {
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
    dataGaps: ['QVERIS_DATA_GAP: IV Rank/Percentile unavailable; surface is derived from live OPRA contract IV.'],
  }
}
