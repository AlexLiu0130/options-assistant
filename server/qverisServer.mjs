import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agentFallbackResponse,
  buildAssistantPlan,
  enforceAgentResponse,
  guardAssistantText,
} from './assistantAgent.mjs'
import {
  closePaperPositionById,
  getPaperAccount,
  listPaperOrders,
  listPaperPositions,
  resetPaperAccount,
  submitPaperOrder,
} from './paperTradeRuntime.mjs'
import {
  isSupportedUnderlying,
  supportedUniversePayload,
} from './supportedUnderlyings.mjs'

const envPath = new URL('../.env.local', import.meta.url)
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
}

const baseUrl = process.env.QVERIS_BASE_URL || 'https://qveris.ai/api/v1'
const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
const sessionId = process.env.QVERIS_SESSION_ID || 'options-assistant-local'
const port = Number(process.env.API_PORT || 8787)
const host = process.env.API_HOST || '127.0.0.1'
const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173'
const serveStatic = process.env.SERVE_STATIC !== 'false'
const refreshMs = Number(process.env.QVERIS_REFRESH_MS || 60000)
const closedCacheMs = Number(process.env.QVERIS_CLOSED_CACHE_MS || 6 * 60 * 60 * 1000)
const heavyLimit = Number(process.env.QVERIS_HEAVY_CONCURRENCY || 4)
const marketCache = new Map()
const optionsCache = new Map()
const qverisInflight = new Map()
const cacheDir = new URL('../.cache/qveris/', import.meta.url)
const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url))
let heavyActive = 0
const heavyQueue = []

// QVeris tool IDs. These are executed only through the QVeris gateway, never by direct vendor API calls.
const tools = {
  quote: 'finnhub_io_api.stock.quote',
  ohlcv: 'eodhd.live_data.real_time.retrieve.v1.b60a4285',
  intraday: 'alphavantage.time-series.intraday.v1',
  dailyAdjusted: 'alphavantage.time-series.daily-adjusted.v1',
  options: 'qveris_finance.opt_chain',
  earnings: 'finnhub.calendar.earnings.retrieve.v1',
  filings: 'finnhub.stock.filings.retrieve.v1',
  volatility: 'flashalpha_historical.surface.retrieve.v1.a7f0f499',
}

function json(res, status, body) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
  }
  if (corsOrigin) {
    headers['access-control-allow-origin'] = corsOrigin
    headers['access-control-allow-methods'] = 'GET,POST,OPTIONS'
    headers['access-control-allow-headers'] = 'content-type,authorization'
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

function sendFile(req, res, file, cacheControl = 'no-store') {
  const types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
  }
  res.writeHead(200, {
    'content-type': types[extname(file)] || 'application/octet-stream',
    'cache-control': cacheControl,
  })
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file))
}

function tryStatic(req, res, url) {
  if (!serveStatic || (req.method !== 'GET' && req.method !== 'HEAD')) return false
  const pathname = decodeURIComponent(url.pathname)
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const normalized = normalize(requested)
  if (normalized.startsWith('..') || normalized.includes(`..${sep}`)) return false
  const file = join(staticRoot, normalized)
  const rel = relative(staticRoot, file)
  if (rel.startsWith('..') || rel === '') return false
  if (existsSync(file) && statSync(file).isFile()) {
    sendFile(req, res, file, pathname.startsWith('/assets/') ? 'public, max-age=604800, immutable' : 'no-store')
    return true
  }
  const index = join(staticRoot, 'index.html')
  if (!existsSync(index) || !statSync(index).isFile()) return false
  sendFile(req, res, index)
  return true
}

function safeError(message = 'QVeris request failed.', status = 502) {
  const error = new Error(message)
  error.status = status
  error.expose = true
  return error
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function tickerFromPath(pathname, prefix) {
  return decodeURIComponent(pathname.slice(prefix.length)).trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '')
}

function requireKey() {
  if (!process.env.QVERIS_API_KEY) {
    throw safeError('QVERIS_API_KEY is not configured. Copy .env.example to .env.local and set the key.', 500)
  }
  return process.env.QVERIS_API_KEY
}

function requireDeepSeekKey() {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw safeError('DEEPSEEK_API_KEY is not configured. Copy .env.example to .env.local and set the key.', 500)
  }
  return process.env.DEEPSEEK_API_KEY
}

function requireSupportedTicker(ticker) {
  if (!isSupportedUnderlying(ticker)) {
    throw safeError('UNSUPPORTED_UNDERLYING: Qveris currently supports 100 high-option-volume stocks and 20 ETFs.', 400)
  }
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw safeError('Request body must be valid JSON.', 400)
  }
}

async function qverisExecuteNow(toolId, parameters, maxResponseSize = 20000) {
  const response = await fetch(`${baseUrl}/tools/execute?tool_id=${encodeURIComponent(toolId)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requireKey()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      session_id: sessionId,
      model: 'options-assistant-local',
      parameters,
      max_response_size: maxResponseSize,
    }),
  })
  let payload
  try {
    payload = await response.json()
  } catch {
    throw safeError('QVeris returned an unreadable response.', 502)
  }
  if (!response.ok || payload.success === false) {
    throw safeError(`QVeris tool execution failed: ${toolId}`, payload?.result?.status_code || response.status || 502)
  }
  return payload.result?.data ?? payload.result
}

async function qverisExecute(toolId, parameters, maxResponseSize = 20000) {
  const key = `${toolId}:${maxResponseSize}:${JSON.stringify(parameters)}`
  if (qverisInflight.has(key)) return qverisInflight.get(key)
  const run = qverisExecuteNow(toolId, parameters, maxResponseSize).finally(() => qverisInflight.delete(key))
  qverisInflight.set(key, run)
  return run
}

async function qverisHeavyExecute(toolId, parameters, maxResponseSize = 20000) {
  const key = `${toolId}:${maxResponseSize}:${JSON.stringify(parameters)}`
  if (qverisInflight.has(key)) return qverisInflight.get(key)
  if (heavyActive >= heavyLimit) await new Promise((resolve) => heavyQueue.push(resolve))
  heavyActive += 1
  try {
    return await qverisExecute(toolId, parameters, maxResponseSize)
  } finally {
    heavyActive -= 1
    heavyQueue.shift()?.()
  }
}

function cached(cache, bucket, key) {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.body
  const file = cacheFile(bucket, key)
  if (!existsSync(file)) return undefined
  try {
    const entry = JSON.parse(readFileSync(file, 'utf8'))
    if (entry.expires <= Date.now()) return undefined
    cache.set(key, entry)
    return entry.body
  } catch {
    return undefined
  }
}

function cacheSet(cache, bucket, key, body) {
  const entry = { body, expires: Date.now() + (isUsRegularMarketOpen() ? refreshMs : closedCacheMs) }
  cache.set(key, entry)
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cacheFile(bucket, key), JSON.stringify(entry))
  } catch {}
  return body
}

function cacheFile(bucket, key) {
  return new URL(`${bucket}-${encodeURIComponent(key)}.json`, cacheDir)
}

function isUsRegularMarketOpen(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]))
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60
}

async function deepseekChat(messages, systemExtra = '') {
  const response = await fetch(`${deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requireDeepSeekKey()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: deepseekModel,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            [
              'You are Qveris AI, a US options research assistant for paper-trade education.',
              'Use only the JSON marketContext supplied by Qveris. Never invent prices, Greeks, probabilities, expirations, strikes, costs, or data sources.',
              'Deterministic calculations such as payoff, scenario P/L, max loss, max profit, breakeven, and simulator values are already computed by Qveris engines; explain them, do not recalculate or override them.',
              'Strategy rankDetails and playbook are deterministic Qveris engine outputs. Use them for suitability, exit, adjustment, and risk-management explanations; do not invent different rules.',
              'When discussing a strategy, explain why the DTE and strikes fit the user view, risk budget, and experience level. If the user asks to adjust DTE or strikes, explain the trade-off in risk, cost/credit, breakeven, theta, gamma, IV/event risk, and assignment risk when relevant.',
              'Use Qveris defaults: option buyers generally need more time; short premium defaults around 30-45 DTE; long directional trades default around 30-60 DTE; DTE under 7 is high risk for beginners unless explicitly requested.',
              'Do not give personalized investment advice. Do not say buy, sell, hold, enter, exit, should, must, guaranteed, safe, or risk-free.',
              'If data is missing, explicitly say it is missing and keep the answer conditional.',
              'Keep answers concise, beginner-friendly, and clearly label scenarios as scenarios, not predictions.',
              systemExtra,
            ].filter(Boolean).join(' '),
        },
        ...messages,
      ],
    }),
  })
  let payload
  try {
    payload = await response.json()
  } catch {
    throw safeError('DeepSeek returned an unreadable response.', 502)
  }
  if (!response.ok) throw safeError('DeepSeek request failed.', response.status || 502)
  return {
    model: payload.model ?? deepseekModel,
    text: payload.choices?.[0]?.message?.content ?? '',
  }
}

function safeParseAssistantJson(text) {
  try {
    return JSON.parse(String(text || '').replace(/^```json\s*|\s*```$/g, '').trim())
  } catch {
    return null
  }
}

function isOutOfScopeAssistantMessage(message) {
  const text = message.toLowerCase()
  const allowed = [
    'option', 'call', 'put', 'spread', 'strike', 'expiry', 'expiration', 'payoff', 'risk',
    'profit', 'loss', 'breakeven', 'delta', 'theta', 'vega', 'iv', 'volatility', 'stock',
    'ticker', 'strategy', 'paper', 'trade', 'bullish', 'bearish', 'neutral', 'shares',
    'price', 'target', 'budget', 'portfolio', 'beginner', 'explain', 'compare',
  ]
  const blocked = ['joke', 'politic', 'weather', 'recipe', 'movie', 'song', 'dating', '笑话', '天气', '菜谱', '电影', '歌曲', '约会', '政治']
  return blocked.some((word) => text.includes(word)) && !allowed.some((word) => text.includes(word))
}

function parseMaybeTruncated(result) {
  if (result?.truncated_content) {
    try {
      return JSON.parse(result.truncated_content)
    } catch {
      return []
    }
  }
  return result
}

function parseJsonQuery(value) {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

async function parseToolContent(result) {
  if (result?.full_content_file_url) {
    const response = await fetch(result.full_content_file_url)
    if (response.ok) return response.json()
  }
  return parseMaybeTruncated(result)
}

function marketRangeParams(range) {
  const normalized = String(range || '1m').toLowerCase()
  const table = {
    '1d': { range: '1d', period: '1d', from: daysAgo(2), kind: 'intraday', interval: '5min', tradingDays: 1 },
    '5d': { range: '5d', period: '5d', from: daysAgo(8), kind: 'intraday', interval: '30min', tradingDays: 5 },
    '1m': { range: '1m', period: '1m', from: daysAgo(35), kind: 'intraday', interval: '60min', tradingDays: 22 },
    daily: { range: '6m', period: 'd', from: daysAgo(190), kind: 'daily', candles: 126, outputsize: 'compact' },
    '3m': { range: '3m', period: '3m', from: daysAgo(100), kind: 'daily', candles: 66, outputsize: 'compact' },
    '1y': { range: '1y', period: '1y', from: daysAgo(370), kind: 'daily', candles: 252, outputsize: 'full' },
    '5y': { range: '5y', period: '5y', from: daysAgo(370 * 5), kind: 'daily', candles: 1260, outputsize: 'full', weekly: true },
  }
  return table[normalized] ?? table['1m']
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function normalizeCandles(result) {
  const rows = Array.isArray(result)
    ? result
    : result?.candles ?? result?.data ?? result?.historical ?? result?.prices ?? result?.values ?? []
  if (!Array.isArray(rows)) return []
  return rows
    .map((row) => {
      const time = String(row.time ?? row.date ?? row.datetime ?? row.timestamp ?? '').slice(0, 10)
      const open = toNumber(row.open ?? row.o)
      const high = toNumber(row.high ?? row.h)
      const low = toNumber(row.low ?? row.l)
      const close = toNumber(row.close ?? row.c ?? row.adjusted_close)
      if (!time || open === null || high === null || low === null || close === null) return null
      return {
        time,
        open,
        high,
        low,
        close,
        volume: toNumber(row.volume ?? row.v),
      }
    })
    .filter(Boolean)
}

function normalizeQuote(ticker, quoteResult, ohlcvResult) {
  const quote = quoteResult || {}
  const ohlcv = ohlcvResult || {}
  const candles = normalizeCandles(ohlcv)
  const timestamp = Number(quote.t ?? ohlcv.timestamp ?? 0)
  return {
    ticker,
    price: toNumber(quote.c ?? ohlcv.close),
    open: toNumber(quote.o ?? ohlcv.open),
    high: toNumber(quote.h ?? ohlcv.high),
    low: toNumber(quote.l ?? ohlcv.low),
    previousClose: toNumber(quote.pc ?? ohlcv.previousClose),
    change: toNumber(quote.d ?? ohlcv.change),
    changePercent: toNumber(quote.dp ?? ohlcv.change_p),
    volume: toNumber(ohlcv.volume),
    timestamp,
    asOf: timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString(),
    source: 'QVeris',
    candles,
  }
}

async function normalizeDailyCandles(result, limit) {
  const parsed = await parseToolContent(result)
  const series = parsed?.['Time Series (Daily)'] ?? {}
  const candles = Object.entries(series)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-limit)
    .map(([time, row]) => {
      const open = toNumber(row['1. open'])
      const high = toNumber(row['2. high'])
      const low = toNumber(row['3. low'])
      const close = toNumber(row['5. adjusted close'] ?? row['4. close'])
      if (open === null || high === null || low === null || close === null) return null
      return {
        time,
        open,
        high,
        low,
        close,
        volume: toNumber(row['6. volume']),
      }
    })
    .filter(Boolean)
  return candles
}

async function normalizeIntradayCandles(result, tradingDays) {
  const parsed = await parseToolContent(result)
  const key = Object.keys(parsed ?? {}).find((name) => name.startsWith('Time Series'))
  const series = key ? parsed[key] : {}
  const rows = Object.entries(series).sort(([a], [b]) => a.localeCompare(b))
  const dates = [...new Set(rows.map(([time]) => time.slice(0, 10)))].slice(-tradingDays)
  const keep = new Set(dates)
  return rows
    .filter(([time]) => keep.has(time.slice(0, 10)))
    .map(([time, row]) => {
      const open = toNumber(row['1. open'])
      const high = toNumber(row['2. high'])
      const low = toNumber(row['3. low'])
      const close = toNumber(row['4. close'])
      if (open === null || high === null || low === null || close === null) return null
      return {
        time: Math.floor(Date.parse(`${time.replace(' ', 'T')}-04:00`) / 1000),
        open,
        high,
        low,
        close,
        volume: toNumber(row['5. volume']),
      }
    })
    .filter(Boolean)
}

function weeklyCandles(candles) {
  const result = []
  for (let i = 0; i < candles.length; i += 5) {
    const chunk = candles.slice(i, i + 5)
    result.push({
      time: chunk.at(-1).time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((candle) => candle.high)),
      low: Math.min(...chunk.map((candle) => candle.low)),
      close: chunk.at(-1).close,
      volume: chunk.reduce((sum, candle) => sum + (candle.volume ?? 0), 0),
    })
  }
  return result
}

function normalizeOptions(ticker, result, spot) {
  const rows = Array.isArray(result) ? result : parseMaybeTruncated(result)
  if (!Array.isArray(rows)) return []
  const today = new Date().toISOString().slice(0, 10)
  const normalized = rows
    .map((row) => {
      const right = String(row.option_type ?? row.type ?? '').toLowerCase()
      if (right !== 'call' && right !== 'put') return null
      const expiration = String(row.expiry ?? row.expiration ?? '')
      return {
        quoteDate: String(row.date ?? ''),
        symbol: String(row.name ?? row.contractID ?? row.contract_id ?? row.symbol ?? ''),
        underlying: ticker,
        expiration,
        strike: toNumber(row.strike),
        right,
        bid: toNumber(row.bid),
        ask: toNumber(row.ask),
        last: toNumber(row.price ?? row.last ?? row.mark),
        bidSize: toNumber(row.bid_size),
        askSize: toNumber(row.ask_size),
        volume: toNumber(row.volume),
        openInterest: toNumber(row.open_interest),
        impliedVolatility: toNumber(row.iv ?? row.implied_volatility),
        delta: toNumber(row.delta),
        gamma: toNumber(row.gamma),
        theta: toNumber(row.theta),
        vega: toNumber(row.vega),
      }
    })
    .filter(Boolean)
    .filter((contract) => contract.expiration >= today)
    .sort((a, b) =>
      String(a.expiration).localeCompare(String(b.expiration)) ||
      (a.strike ?? 0) - (b.strike ?? 0) ||
      String(a.right).localeCompare(String(b.right)),
    )
  const effectiveSpot = typeof spot === 'number' && Number.isFinite(spot)
    ? spot
    : estimateSpotFromOptions(normalized)
  if (typeof effectiveSpot !== 'number' || !Number.isFinite(effectiveSpot)) return normalized.slice(0, 500)
  const byExpiry = new Map()
  for (const contract of normalized) {
    const list = byExpiry.get(contract.expiration) ?? []
    list.push(contract)
    byExpiry.set(contract.expiration, list)
  }
  const pruned = []
  for (const expiry of selectUsefulExpirations([...byExpiry.keys()], today)) {
    const contracts = byExpiry.get(expiry) ?? []
    const strikes = [...new Set(contracts.map((contract) => contract.strike).filter((strike) => typeof strike === 'number'))]
      .sort((a, b) => Math.abs(a - effectiveSpot) - Math.abs(b - effectiveSpot))
      .slice(0, 25)
    const keep = new Set(strikes)
    pruned.push(...contracts.filter((contract) => keep.has(contract.strike)))
  }
  return pruned.slice(0, 600)
}

function estimateSpotFromOptions(contracts) {
  const contract = contracts
    .filter((item) => typeof item.delta === 'number' && typeof item.strike === 'number')
    .sort((a, b) => Math.abs(Math.abs(a.delta) - 0.5) - Math.abs(Math.abs(b.delta) - 0.5))[0]
  return contract?.strike
}

function selectUsefulExpirations(expirations, today) {
  const rows = expirations
    .map((expiration) => ({
      expiration,
      dte: Math.ceil((Date.parse(`${expiration}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000),
    }))
    .filter((row) => row.dte >= 7)
    .sort((a, b) => a.dte - b.dte)
  const selected = new Set()
  if (rows[0]) selected.add(rows[0].expiration)
  for (const target of [14, 30, 45, 60, 90, 120, 180]) {
    const row = rows.filter((item) => item.dte <= target + 21).sort((a, b) => Math.abs(a.dte - target) - Math.abs(b.dte - target))[0]
    if (row) selected.add(row.expiration)
  }
  return [...selected].sort()
}

function unavailableOptions(ticker, message) {
  return {
    ticker,
    status: 'unavailable',
    contracts: [],
    asOf: new Date().toISOString(),
    message,
    dataGaps: [
      'QVERIS_DATA_GAP: Live US options chain unavailable; contract-level strategy recommendations are pending.',
      'QVERIS_DATA_GAP: gamma/theta/vega/rho unavailable without a stable normalized options chain.',
      'QVERIS_DATA_GAP: option reference master unavailable; US equity multiplier 100 remains an assumption.',
    ],
  }
}

function normalizeEvents(ticker, earningsResult, filingsResult) {
  const filings = parseMaybeTruncated(filingsResult)
  return {
    ticker,
    earnings: (earningsResult?.earningsCalendar || []).slice(0, 8).map((row) => ({
      symbol: String(row.symbol ?? ticker),
      date: String(row.date ?? ''),
      hour: String(row.hour ?? ''),
      quarter: toNumber(row.quarter),
      year: toNumber(row.year),
      epsEstimate: row.epsEstimate ?? null,
      epsActual: row.epsActual ?? null,
      revenueEstimate: row.revenueEstimate ?? null,
      revenueActual: row.revenueActual ?? null,
    })),
    filings: (Array.isArray(filings) ? filings : []).slice(0, 12).map((row) => ({
      accessNumber: String(row.accessNumber ?? ''),
      symbol: String(row.symbol ?? ticker),
      cik: String(row.cik ?? ''),
      form: String(row.form ?? ''),
      filedDate: String(row.filedDate ?? ''),
      acceptedDate: String(row.acceptedDate ?? ''),
      reportUrl: String(row.reportUrl ?? ''),
      filingUrl: String(row.filingUrl ?? ''),
    })),
  }
}

function normalizeVolatility(ticker, result) {
  const surface = parseMaybeTruncated(result)
  const hasSurface = Array.isArray(surface?.tenors) && Array.isArray(surface?.moneyness) && Array.isArray(surface?.iv)
  return {
    ticker,
    spot: toNumber(surface?.spot),
    asOf: String(surface?.as_of ?? ''),
    tenors: Array.isArray(surface?.tenors) ? surface.tenors.slice(0, 40).map(toNumber) : [],
    moneyness: Array.isArray(surface?.moneyness) ? surface.moneyness.slice(0, 60).map(toNumber) : [],
    iv: Array.isArray(surface?.iv) ? surface.iv.slice(0, 20).map((row) => row.slice(0, 30).map(toNumber)) : [],
    dataGaps: [
      'QVERIS_DATA_GAP: IV Rank/Percentile unavailable; using volatility surface only.',
      ...(hasSurface ? [] : ['QVERIS_DATA_GAP: volatility surface grid unavailable for this symbol/tool response.']),
    ],
  }
}

async function handle(req, res) {
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {})
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    if (url.pathname === '/api/health') return json(res, 200, { ok: true })

    if (url.pathname === '/api/supported-underlyings') {
      return json(res, 200, supportedUniversePayload())
    }

    if (url.pathname === '/api/paper/orders' && req.method === 'POST') {
      const result = submitPaperOrder(await readJson(req))
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/api/paper/orders' && req.method === 'GET') {
      const result = listPaperOrders()
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/api/paper/account' && req.method === 'GET') {
      const result = getPaperAccount({
        currentUnderlyingPrice: url.searchParams.get('currentUnderlyingPrice') ?? url.searchParams.get('currentPrice'),
        prices: parseJsonQuery(url.searchParams.get('prices')),
      })
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/api/paper/account/mark' && req.method === 'POST') {
      const result = getPaperAccount(await readJson(req))
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/api/paper/account/reset' && req.method === 'POST') {
      const result = resetPaperAccount(await readJson(req))
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/api/paper/positions' && req.method === 'GET') {
      const result = listPaperPositions({
        status: url.searchParams.get('status') || 'open',
        currentUnderlyingPrice: url.searchParams.get('currentUnderlyingPrice') ?? url.searchParams.get('currentPrice'),
      })
      return json(res, result.status, result.body)
    }

    const closeMatch = url.pathname.match(/^\/api\/paper\/positions\/([^/]+)\/close$/)
    if (closeMatch && req.method === 'POST') {
      const result = closePaperPositionById(decodeURIComponent(closeMatch[1]), await readJson(req))
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/api/assistant' && req.method === 'POST') {
      const body = await readJson(req)
      const prompt = String(body.prompt ?? '').trim()
      if (!prompt) throw safeError('Prompt is required.', 400)
      const marketContext = body.marketContext ?? {}
      const isZh = body.language === 'zh'
      const systemExtra = isZh
        ? 'CRITICAL LANGUAGE RULE: You MUST write every word of your response in Simplified Chinese (简体中文). Do not use any English words except stock tickers, option Greeks, and technical abbreviations (e.g. NVDA, IV, ATM).'
        : ''
      const agentPlan = buildAssistantPlan({ userMessage: prompt, marketContext, history: [], isZh })
      const content = JSON.stringify({ prompt, marketContext })
      const modelResponse = await deepseekChat([{ role: 'user', content }], systemExtra)
      const guarded = guardAssistantText(modelResponse.text, { marketContext, plan: agentPlan, isZh })
      return json(res, 200, {
        ...modelResponse,
        text: guarded.warnings.length ? `${guarded.warnings[0]}\n\n${guarded.answer}` : guarded.answer,
        warnings: guarded.warnings,
        dataGaps: guarded.dataGaps,
      })
    }

    if (url.pathname === '/api/assistant/chat' && req.method === 'POST') {
      const body = await readJson(req)
      const userMessage = String(body.userMessage ?? '').trim()
      if (!userMessage) throw safeError('userMessage is required.', 400)
      const isZh = body.language === 'zh'
      if (isOutOfScopeAssistantMessage(userMessage)) {
        return json(res, 200, {
          intent: 'refuse',
          answer: isZh
            ? '我只能协助期权策略、风险、收益分析及市场观点收集，请在此范围内提问。'
            : 'I can only help with options strategy, risk, payoff, paper-trade scenarios, and collecting your market view.',
          referencedStrategyIds: [],
          warnings: ['Out-of-scope question refused.'],
          dataGaps: [],
        })
      }
      const marketContext = body.marketContext ?? {}
      const history = Array.isArray(body.history) ? body.history : []
      const agentPlan = buildAssistantPlan({ userMessage, marketContext, history, isZh })
      if (agentPlan.directResponse) return json(res, 200, agentPlan.directResponse)
      const langRule = isZh
        ? 'All answer, followUpQuestion, and warnings values in the JSON must be in Simplified Chinese.'
        : 'Respond in English.'
      const systemExtra = isZh
        ? 'CRITICAL LANGUAGE RULE: You MUST write every word of your response in Simplified Chinese (简体中文). Do not use any English words except stock tickers, option Greeks, and technical abbreviations (e.g. NVDA, IV, ATM).'
        : ''
      const response = await deepseekChat([
        {
          role: 'user',
          content: JSON.stringify({
            instruction:
              [
                'Return JSON only.',
                'Schema: {intent, title, answer, sections, followUpQuestion, structuredUpdates, referencedStrategyIds, warnings, dataGaps}. Intent must be one of clarify, recommend, explain, compare, educate, adjust, risk_check, refuse.',
                'sections must be an array of 2-4 objects shaped {title, body}. Use these section titles when relevant: Strategy structure, Why it fits, Key risks, Possible adjustments.',
                'Follow agentPlan exactly. If agentPlan has topStrategies, recommend or compare only those strategies unless the user is only asking a general education question.',
                'Use agentPlan.agentState as the current user profile and agentPlan.toolPlan as the deterministic tool result. Do not invent additional tools or strategy legs.',
                'structuredUpdates may include ticker, direction, strength, horizon, riskBudget, targetPrice, ownsShares, sharesCount, willingToBeAssigned, experienceLevel.',
                'Use exact values when possible: direction one of bullish, bearish, neutral, volatile; strength one of mild, moderate, strong; experienceLevel one of beginner, intermediate, advanced.',
                'When the user supplies a clear market view field, put it in structuredUpdates.',
                'Ask exactly one follow-up question when a key field is missing: direction, strength, horizon, riskBudget, targetPrice, ownsShares, or assignment willingness.',
                'Keep answer to one concise summary sentence. Put details in sections. Do not use Markdown, bullets, asterisks, or leading colons.',
                'Stay within US options strategy education, structured intake, payoff/scenario/risk explanation, and Qveris-provided strategy candidates.',
                'For recommendations, include the reason for DTE and strike selection using supplied strategy legs, expectedMove, rankReasons, rankDetails, rankWarnings, riskChecklist, and playbook. If the user wants to adjust a strike or DTE, explain the likely trade-off and ask one clarifying question before changing structured fields.',
                'Warn that DTE under 7 is high risk for beginners, short premium is normally managed around 30-45 DTE, long directional trades normally need 30-60 DTE, and event dates can cause IV crush or gap risk.',
                'Refuse unrelated topics.',
                'If maxLoss exceeds riskBudget, say the strategy does not fit the risk budget and do not describe it as suitable.',
                langRule,
              ].join(' '),
            userMessage,
            history,
            agentPlan,
            marketContext,
          }),
        },
      ], systemExtra)
      const parsed = safeParseAssistantJson(response.text)
      if (!parsed) {
        return json(res, 200, agentFallbackResponse(agentPlan, isZh))
      }
      return json(res, 200, enforceAgentResponse(parsed, marketContext, agentPlan, isZh))
    }

    if (url.pathname.startsWith('/api/market/')) {
      const ticker = tickerFromPath(url.pathname, '/api/market/')
      if (!ticker) throw safeError('Ticker is required.', 400)
      requireSupportedTicker(ticker)
      const range = url.searchParams.get('range') || '1m'
      const cacheKey = `${ticker}:${range}`
      const cachedBody = cached(marketCache, 'market', cacheKey)
      if (cachedBody) return json(res, 200, cachedBody)
      const rangeParams = marketRangeParams(range)
      const [quoteResult, ohlcvResult, historyResult] = await Promise.allSettled([
        qverisExecute(tools.quote, { symbol: ticker }),
        qverisExecute(tools.ohlcv, {
          symbol: `${ticker}.US`,
          fmt: 'json',
          range: rangeParams.range,
          period: rangeParams.period,
          from: rangeParams.from,
          to: new Date().toISOString().slice(0, 10),
        }),
        rangeParams.kind === 'intraday' ? qverisExecute(tools.intraday, {
            function: 'TIME_SERIES_INTRADAY',
            symbol: ticker,
            interval: rangeParams.interval,
            adjusted: true,
            extended_hours: false,
            outputsize: 'full',
            datatype: 'json',
          }, 50000)
        : qverisExecute(tools.dailyAdjusted, {
            function: 'TIME_SERIES_DAILY_ADJUSTED',
            symbol: ticker,
            outputsize: rangeParams.outputsize,
            datatype: 'json',
          }, rangeParams.outputsize === 'full' ? 50000 : 60000),
      ])
      const dataGaps = []
      const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : {}
      const ohlcv = ohlcvResult.status === 'fulfilled' ? ohlcvResult.value : {}
      if (quoteResult.status === 'rejected') dataGaps.push(`QVERIS_MARKET_GAP: quote unavailable (${quoteResult.reason.message}).`)
      if (ohlcvResult.status === 'rejected') dataGaps.push(`QVERIS_MARKET_GAP: realtime OHLC unavailable (${ohlcvResult.reason.message}).`)
      const snapshot = normalizeQuote(ticker, quote, ohlcv)
      const rawCandles = historyResult.status === 'fulfilled'
        ? rangeParams.kind === 'intraday'
          ? await normalizeIntradayCandles(historyResult.value, rangeParams.tradingDays)
          : await normalizeDailyCandles(historyResult.value, rangeParams.candles)
        : []
      if (historyResult.status === 'rejected') dataGaps.push(`QVERIS_MARKET_GAP: historical candles unavailable (${historyResult.reason.message}).`)
      const candles = rangeParams.weekly ? weeklyCandles(rawCandles) : rawCandles
      const finalCandles = candles.length ? candles : snapshot.candles
      const lastCandle = finalCandles?.at(-1)
      return json(res, 200, cacheSet(marketCache, 'market', cacheKey, {
        ...snapshot,
        price: snapshot.price ?? lastCandle?.close ?? null,
        open: snapshot.open ?? lastCandle?.open ?? null,
        high: snapshot.high ?? lastCandle?.high ?? null,
        low: snapshot.low ?? lastCandle?.low ?? null,
        volume: snapshot.volume ?? lastCandle?.volume ?? null,
        candles: finalCandles,
        dataGaps,
        message: dataGaps.length ? 'QVeris market data loaded with partial fallback.' : 'QVeris market data loaded.',
      }))
    }

    if (url.pathname.startsWith('/api/options/')) {
      const ticker = tickerFromPath(url.pathname, '/api/options/')
      if (!ticker) throw safeError('Ticker is required.', 400)
      requireSupportedTicker(ticker)
      const cachedBody = cached(optionsCache, 'options', ticker)
      if (cachedBody) return json(res, 200, cachedBody)
      try {
        const raw = await qverisHeavyExecute(tools.options, { symbol: ticker, market: 'US' }, 24000)
        const result = await parseToolContent(raw)
        const contracts = normalizeOptions(ticker, result)
        return json(res, 200, cacheSet(optionsCache, 'options', ticker, {
          ticker,
          status: contracts.length ? 'available' : 'unavailable',
          mode: 'live',
          contracts,
          asOf: new Date().toISOString(),
          message: contracts.length ? 'QVeris US options chain normalized.' : 'QVeris returned no normalized US option contracts.',
          dataGaps: [
            'QVERIS_DATA_GAP: theta/gamma/vega may be absent when the routed provider does not return them.',
            'QVERIS_DATA_GAP: option reference master unavailable; US equity multiplier 100 remains an assumption.',
          ],
        }))
      } catch (error) {
        return json(
          res,
          200,
          unavailableOptions(
            ticker,
            error.expose ? error.message : 'QVeris US options chain is currently unavailable.',
          ),
        )
      }
    }

    if (url.pathname.startsWith('/api/events/')) {
      const ticker = tickerFromPath(url.pathname, '/api/events/')
      if (!ticker) throw safeError('Ticker is required.', 400)
      requireSupportedTicker(ticker)
      const today = new Date().toISOString().slice(0, 10)
      const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const earnings = await qverisExecute(tools.earnings, { symbol: ticker, from: today, to: future })
      const filings = await qverisExecute(tools.filings, { symbol: ticker, form: '8-K', from: today.slice(0, 4) + '-01-01', to: today }, 30000)
      return json(res, 200, normalizeEvents(ticker, earnings, filings))
    }

    if (url.pathname.startsWith('/api/volatility/')) {
      const ticker = tickerFromPath(url.pathname, '/api/volatility/')
      if (!ticker) throw safeError('Ticker is required.', 400)
      requireSupportedTicker(ticker)
      const result = await qverisHeavyExecute(tools.volatility, { symbol: ticker }, 16000)
      return json(res, 200, normalizeVolatility(ticker, result))
    }

    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/') && tryStatic(req, res, url)) return

    json(res, 404, { error: 'Not found' })
  } catch (error) {
    json(res, error.status || 500, { error: error.expose ? error.message : 'Server error' })
  }
}

if (process.argv.includes('--smoke')) {
  const ticker = process.argv.at(-1)?.startsWith('--') ? 'NVDA' : process.argv.at(-1) || 'NVDA'
  const market = await qverisExecute(tools.quote, { symbol: ticker.toUpperCase() })
  console.log(JSON.stringify({ ok: true, ticker: ticker.toUpperCase(), fields: Object.keys(market).sort() }, null, 2))
} else {
  createServer(handle).listen(port, host, () => {
    console.log(`QVeris API listening on http://${host}:${port}`)
  })
}
