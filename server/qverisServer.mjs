import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adviceBoundaryAnswer,
  buildAssistantPlan,
  canonicalHorizon,
  deterministicAnswer,
  guardAssistantText,
  directionalClaimIssue,
  horizonDays,
  horizonZh,
  isAdviceRequest,
  nextAgentState,
  normalizeAgentState,
  parseAssistantTurn,
  profileQuestion,
  resolveContractAdjustment,
  resolveIntent,
  sanitizeModelPatch,
  scopeStateToTicker,
  shiftHorizon,
  strategyReference,
  targetSanity,
  withoutTickerScoped,
  replyLanguage,
} from './assistantAgent.mjs'
import { assistantToolSpecs, createAssistantTools, volatilitySummary } from './assistantTools.mjs'
import { adjustStrategyLegs } from '../src/core/strategyAdjustmentEngine.ts'
import {
  buildExplanationPrompt,
  buildExtractionPrompt,
  isPromptInjection,
  mergeAgentProfile,
  normalizeAgentProfile,
  normalizeExtraction,
  parsedViewInput,
  profileFromMarketContext,
  profileUpdatesForClient,
  unknownFinancialNumbers,
} from './assistantHarness.mjs'
import {
  closePaperPositionById,
  getPaperAccount,
  listPaperOrders,
  listPaperPositions,
  resetPaperAccount,
  submitPaperOrder,
} from './paperTradeRuntime.mjs'
import { recordProductEvent } from './productEventsRuntime.mjs'
import { getAdminAnalytics } from './adminAnalyticsRuntime.mjs'
import {
  aggregateCandles,
  impliedSpotFromChain,
  normalizeAlphaVantageCandles,
  normalizeAlphaVantageOptionChain,
  normalizeAlphaVantageQuote,
  optionExpirations,
  pruneOptionContracts,
  volatilityFromContracts,
} from './alphaVantageData.mjs'
import { createAuthRuntime } from './auth.mjs'
import { selectDefaultExpiration } from '../src/core/expirationEngine.ts'
import { parseUserView } from '../src/core/parseUserView.ts'
import { isUsOptionsRegularTradingHours as isUsRegularMarketOpen } from '../src/core/paperTradeEngine.ts'
import { recommendStrategyTypes } from '../src/core/strategyRecommendationEngine.ts'

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
const quoteRefreshMs = Number(process.env.QVERIS_QUOTE_REFRESH_MS || 5000)
const marketRefreshMs = Number(process.env.QVERIS_MARKET_REFRESH_MS || 15000)
const optionsRefreshMs = Number(process.env.QVERIS_OPTIONS_REFRESH_MS || 60000)
const closedCacheMs = Number(process.env.QVERIS_CLOSED_CACHE_MS || 6 * 60 * 60 * 1000)
const upstreamTimeoutMs = Math.max(1000, Number(process.env.QVERIS_UPSTREAM_TIMEOUT_MS || 20000))
const maxJsonBodyBytes = 1_000_000
const authBaseUrl = String(process.env.QVERIS_AUTH_BASE_URL || 'https://qveris.ai').replace(/\/$/, '')
const adminEmails = new Set(
  String(process.env.OPTIONS_ASSISTANT_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
)
const authRuntime = createAuthRuntime({
  authBaseUrl,
  clientId: process.env.QVERIS_OAUTH_CLIENT_ID || '',
  clientSecret: process.env.QVERIS_OAUTH_CLIENT_SECRET || '',
  sessionSecret: process.env.QVERIS_OAUTH_SESSION_SECRET || '',
  redirectUri: process.env.QVERIS_OAUTH_REDIRECT_URI || `http://${host}:${port}/auth/callback`,
  resource: process.env.QVERIS_OAUTH_RESOURCE || `${authBaseUrl}/account`,
  scopes: process.env.QVERIS_OAUTH_SCOPES || 'openid profile email',
  secureCookie: process.env.QVERIS_OAUTH_SECURE_COOKIE === 'true',
})
const localAuthBypass = process.env.OPTIONS_ASSISTANT_LOCAL_AUTH_BYPASS === 'true'
const localAuthUser = {
  sub: 'local-dev-user',
  email: 'local-dev@qveris.test',
  name: 'Local Dev',
}
const marketCache = new Map()
const quoteCache = new Map()
const optionsCache = new Map()
const qverisInflight = new Map()
const cacheDir = new URL('../.cache/qveris/', import.meta.url)
const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url))

// QVeris tool IDs. These are executed only through the QVeris gateway, never by direct vendor API calls.
const tools = {
  liveQuote: 'alphavantage.global_quote.retrieve.v1.9b8a7c6d',
  intradayCandles: 'alphavantage.time_series_intraday.retrieve.v1.1e18340d',
  dailyCandles: 'alphavantage.time-series.daily.v1',
  weeklyCandles: 'alphavantage.time_series_weekly.retrieve.v1.9b8a7c6d',
  optionChain: 'alphavantage.realtime_options.retrieve.v1.7aca3c4a',
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

function isAdmin(user) {
  const email = String(typeof user === 'object' && user ? user.email : '').trim().toLowerCase()
  return Boolean(email && adminEmails.has(email))
}

function requireAdmin(user) {
  if (!isAdmin(user)) throw safeError('Administrator access is required.', 403)
}

function tickerFromPath(pathname, prefix) {
  return decodeURIComponent(pathname.slice(prefix.length)).trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '')
}

function stockQuoteParameters(ticker) {
  return { function: 'GLOBAL_QUOTE', symbol: ticker, entitlement: 'realtime' }
}

function candleParameters(ticker, rangeParams) {
  if (rangeParams.kind === 'intraday') {
    return {
      function: 'TIME_SERIES_INTRADAY',
      symbol: ticker,
      interval: rangeParams.interval,
      outputsize: 'full',
      extended_hours: 'false',
      entitlement: 'realtime',
    }
  }
  if (rangeParams.kind === 'weekly') return { function: 'TIME_SERIES_WEEKLY', symbol: ticker }
  return { function: 'TIME_SERIES_DAILY', symbol: ticker, outputsize: rangeParams.pageSize > 100 ? 'full' : 'compact' }
}

function candleTool(rangeParams) {
  if (rangeParams.kind === 'intraday') return tools.intradayCandles
  return rangeParams.kind === 'weekly' ? tools.weeklyCandles : tools.dailyCandles
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

async function readJson(req) {
  const declaredLength = Number(req.headers['content-length'] || 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxJsonBodyBytes) {
    throw safeError('Request body is too large.', 413)
  }
  const chunks = []
  let totalBytes = 0
  for await (const chunk of req) {
    totalBytes += chunk.length
    if (totalBytes > maxJsonBodyBytes) throw safeError('Request body is too large.', 413)
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw safeError('Request body must be valid JSON.', 400)
  }
}

async function qverisExecuteNow(toolId, parameters, maxResponseSize = 20000) {
  let response
  try {
    response = await fetch(`${baseUrl}/tools/execute?tool_id=${encodeURIComponent(toolId)}`, {
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
      signal: AbortSignal.timeout(upstreamTimeoutMs),
    })
  } catch {
    throw safeError('QVeris request timed out or failed.', 502)
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw safeError('QVeris returned an unreadable response.', 502)
  }
  if (!response.ok || payload.success === false) {
    throw safeError(`QVeris tool execution failed: ${toolId}`, payload?.result?.status_code || response.status || 502)
  }
  const result = payload.result?.full_content_file_url
    ? await qverisFullContent(payload.result.full_content_file_url)
    : payload.result?.data ?? payload.result
  if (result && typeof result === 'object' && 'code' in result && Number(result.code) !== 200) {
    throw safeError(`QVeris provider rejected the request: ${result.msg || result.message || toolId}`, 502)
  }
  // Alpha Vantage reports quota and parameter problems as HTTP 200 bodies with only a notice field.
  const notice = result && typeof result === 'object' && !Array.isArray(result)
    ? result['Error Message'] || result.Note || (Object.keys(result).length <= 2 ? result.Information : undefined)
    : undefined
  if (notice) throw safeError(`QVeris provider rejected the request: ${String(notice).slice(0, 160)}`, 502)
  return result
}

// Oversized tool results are parked in QVeris storage; the signed URL is fetched here and never forwarded.
async function qverisFullContent(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(upstreamTimeoutMs, 30_000)) })
    if (!response.ok) throw new Error(String(response.status))
    return await response.json()
  } catch {
    throw safeError('QVeris full tool result could not be downloaded.', 502)
  }
}

async function qverisExecute(toolId, parameters, maxResponseSize = 20000) {
  const key = `${toolId}:${maxResponseSize}:${JSON.stringify(parameters)}`
  if (qverisInflight.has(key)) return qverisInflight.get(key)
  const run = qverisExecuteNow(toolId, parameters, maxResponseSize).finally(() => qverisInflight.delete(key))
  qverisInflight.set(key, run)
  return run
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

function cacheSet(cache, bucket, key, body, ttlMs) {
  const entry = { body, expires: Date.now() + ttlMs }
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

async function assistantApiJson(pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { 'x-options-internal-token': authRuntime.internalToken },
    signal: AbortSignal.timeout(Math.max(upstreamTimeoutMs, 30_000)),
  })
  const body = await response.json()
  if (!response.ok) throw safeError(body?.error || `Assistant tool request failed: ${pathname}`, response.status)
  return body
}

// Chat-made contract edits are absolute leg values; the engine re-prices them on every turn's fresh chain.
function applyContractOverrides(strategies, overrides, options, parsedView) {
  const applied = {}
  const result = strategies.map((strategy) => {
    const adjustments = overrides?.[strategy.id]
    if (!adjustments?.length || !strategy.legs?.length) return strategy
    const adjusted = adjustStrategyLegs({ baseStrategy: strategy, optionChain: options, view: parsedView, adjustments })
    if (!adjusted.strategy) return strategy
    applied[strategy.id] = adjustments
    return adjusted.strategy
  })
  return { strategies: result, applied }
}

// A strategy the user edited on the page arrives with its legs; same structure as the engine's base means it is an edit.
function pageOverride(clientStrategy, baseStrategies) {
  const base = baseStrategies.find((strategy) => strategy.id === clientStrategy?.id)
  const legs = Array.isArray(clientStrategy?.legs) ? clientStrategy.legs : []
  if (!base?.legs?.length || legs.length !== base.legs.length) return undefined
  if (legs.some((leg, index) => leg?.action !== base.legs[index].action || leg?.right !== base.legs[index].right)) return undefined
  const adjustments = legs.map((leg, legIndex) => ({ legIndex, strike: Number(leg.strike), expiration: String(leg.expiration), quantity: Number(leg.quantity ?? 1) }))
  const same = adjustments.every((item, index) => item.strike === base.legs[index].strike && item.expiration === base.legs[index].expiration && item.quantity === (base.legs[index].quantity ?? 1))
  if (same) return null
  return adjustments.every((item) => item.strike > 0 && /^\d{4}-\d{2}-\d{2}$/.test(item.expiration) && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 20) ? adjustments : undefined
}

async function canonicalAssistantContext(profile, selectedStrategyId, overrides = {}, clientStrategy) {
  const ticker = profile.ticker
  const [optionsResult, quoteResult] = await Promise.allSettled([
    assistantApiJson(`/api/options/${encodeURIComponent(ticker)}`),
    assistantApiJson(`/api/quote/${encodeURIComponent(ticker)}`),
  ])
  const options = optionsResult.status === 'fulfilled'
    ? optionsResult.value
    : unavailableOptions(ticker, optionsResult.reason?.message || 'The option chain is unavailable.')
  const market = quoteResult.status === 'fulfilled' ? quoteResult.value : options.market
  const spot = Number(market?.price)
  const dataGaps = [
    ...(Array.isArray(options.dataGaps) ? options.dataGaps : []),
    ...(quoteResult.status === 'rejected' ? [`QVERIS_MARKET_GAP: stock quote unavailable (${quoteResult.reason?.message || 'unknown error'}).`] : []),
  ]
  if (!Number.isFinite(spot) || spot <= 0 || options.status !== 'available') {
    let strategies = []
    try {
      strategies = recommendStrategyTypes(parseUserView(parsedViewInput(profile, Number.isFinite(spot) && spot > 0 ? spot : undefined)), undefined)
        .slice(0, 4)
    } catch (error) {
      console.warn('[assistant] education candidates failed:', error?.message)
    }
    return {
      ticker,
      market,
      options,
      strategies,
      selectedStrategy: undefined,
      parsedView: undefined,
      snapshotId: `${ticker}:${options.asOf || market?.asOf || 'unavailable'}`,
      generatedAt: options.asOf || market?.asOf || new Date().toISOString(),
      dataGaps,
      recommendable: false,
    }
  }
  const parsedView = parseUserView(parsedViewInput(profile, spot))
  // Same expiration choice as the trade page, so chat answers match the strategy panel.
  const preferredExpiration = selectDefaultExpiration(optionExpirations(options.contracts ?? []), parsedView)
  const baseStrategies = recommendStrategyTypes(parsedView, options, preferredExpiration, { rank: true })
  const wanted = { ...overrides }
  const fromPage = pageOverride(clientStrategy, baseStrategies)
  if (fromPage) wanted[clientStrategy.id] = fromPage
  else if (fromPage === null) delete wanted[clientStrategy.id]
  const { strategies, applied } = applyContractOverrides(baseStrategies, wanted, options, parsedView)
  // Keep the engine's ranking order; the selection only decides what "this one" refers to.
  const selectedStrategy = strategies.find((strategy) => strategy.id === selectedStrategyId)
  return {
    ticker,
    market,
    options,
    strategies,
    baseStrategies,
    appliedOverrides: applied,
    selectedStrategy,
    parsedView,
    snapshotId: `${ticker}:${options.asOf || market?.asOf}`,
    generatedAt: options.asOf || market?.asOf || new Date().toISOString(),
    dataGaps,
    recommendable: strategies.some((strategy) => strategy.status === 'contract_ready' && strategy.legs.length > 0),
  }
}

async function deepseekRequest(body) {
  let response
  try {
    response = await fetch(`${deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${requireDeepSeekKey()}`,
        'content-type': 'application/json',
        // 模型网关按 X-Qveris-Source 聚合各产品调用；DEEPSEEK_BASE_URL 指向
        // aigateway.qveris.ai/v1 时该来源会记录到网关统计。
        'x-qveris-source': 'options-assistant',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(upstreamTimeoutMs),
    })
  } catch {
    throw safeError('DeepSeek request timed out or failed.', 502)
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw safeError('DeepSeek returned an unreadable response.', 502)
  }
  if (!response.ok) throw safeError('DeepSeek request failed.', response.status || 502)
  return payload
}

// With tools, the model may call read-only data tools for a few rounds before it writes the final JSON answer.
async function deepseekChat(messages, systemExtra = '', { tools, runTool, maxRounds = 3, maxCallsPerRound = 4 } = {}) {
  const conversation = [
    {
      role: 'system',
      content:
        [
          'You are Qveris AI, a US options research assistant for paper-trade education.',
          'Use only the JSON marketContext supplied by Qveris and the results of the Qveris data tools you are given. Never invent prices, Greeks, probabilities, expirations, strikes, costs, or data sources.',
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
  ]
  for (let round = 0; ; round += 1) {
    const offerTools = Boolean(tools?.length && runTool && round < maxRounds)
    const payload = await deepseekRequest({
      model: deepseekModel,
      temperature: 0.2,
      messages: conversation,
      ...(offerTools ? { tools, tool_choice: 'auto' } : {}),
    })
    const message = payload.choices?.[0]?.message ?? {}
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    if (!offerTools || !calls.length) {
      return { model: payload.model ?? deepseekModel, text: message.content ?? '' }
    }
    conversation.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls })
    // Every tool_call id needs an answer, even the ones over the per-round cap.
    for (const [index, call] of calls.entries()) {
      let content
      if (index >= maxCallsPerRound) {
        content = { error: 'Too many tool calls in one round; ask again if still needed.' }
      } else {
        let args = {}
        try {
          args = JSON.parse(call.function?.arguments || '{}')
        } catch {
          args = {}
        }
        content = await runTool(call.function?.name, args)
      }
      conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(content).slice(0, 6000) })
    }
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
    '期权', '策略', '股票', '股价', '风险', '行权', '价差', '看涨', '看跌', '波动', '财报', '美股', '合约', '到期', '亏损', '收益',
  ]
  const blocked = ['joke', 'politic', 'weather', 'recipe', 'movie', 'song', 'dating', '笑话', '天气', '菜谱', '电影', '歌曲', '约会', '政治']
  return blocked.some((word) => text.includes(word)) && !allowed.some((word) => text.includes(word))
}

function parseJsonQuery(value) {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function marketRangeParams(range) {
  const normalized = String(range || '1h').toLowerCase()
  const table = {
    '15m': { kind: 'intraday', interval: '15min', pageSize: 140 },
    '30m': { kind: 'intraday', interval: '30min', pageSize: 140 },
    '1h': { kind: 'intraday', interval: '60min', pageSize: 160 },
    '4h': { kind: 'intraday', interval: '60min', group: 4, pageSize: 160 },
    '1d': { kind: 'daily', pageSize: 252 },
    '5d': { kind: 'intraday', interval: '30min', pageSize: 140 },
    '1m': { kind: 'intraday', interval: '60min', pageSize: 160 },
    daily: { kind: 'daily', pageSize: 126 },
    '3m': { kind: 'daily', pageSize: 66 },
    '1y': { kind: 'daily', pageSize: 252 },
    '5y': { kind: 'weekly', pageSize: 260 },
  }
  return table[normalized] ?? table['1h']
}

function emptyQuote(ticker) {
  return {
    ticker,
    price: null,
    open: null,
    high: null,
    low: null,
    previousClose: null,
    change: null,
    changePercent: null,
    volume: null,
    timestamp: 0,
    asOf: new Date().toISOString(),
    source: 'QVeris',
    candles: [],
  }
}

function validLiveQuote(ticker, result) {
  const quote = normalizeAlphaVantageQuote(ticker, result, { marketOpen: isUsRegularMarketOpen() })
  return quote.price && quote.timestamp ? quote : null
}

function newYorkToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
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
      'QVERIS_DATA_GAP: option reference master unavailable; US equity multiplier 100 remains an assumption.',
    ],
  }
}

async function handle(req, res) {
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {})
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    if (localAuthBypass && url.pathname === '/api/auth/me' && req.method === 'GET') {
      return json(res, 200, { user: localAuthUser, registerUrl: `${authBaseUrl}/sign-up` })
    }
    if (localAuthBypass && url.pathname === '/api/auth/logout' && req.method === 'POST') return json(res, 200, { ok: true })
    if (!localAuthBypass && await authRuntime.handle(req, res, url, json)) return
    if (url.pathname === '/api/health') return json(res, 200, { ok: true })

    const authUser = localAuthBypass ? localAuthUser : authRuntime.currentUser(req)
    if (url.pathname.startsWith('/api/') && !authUser) {
      return json(res, 401, { error: 'Authentication required.' })
    }

    if (url.pathname === '/api/admin/analytics' && req.method === 'GET') {
      requireAdmin(authUser)
      return json(res, 200, await getAdminAnalytics(url.searchParams.get('days') || 7))
    }

    if (url.pathname === '/api/paper/orders' && req.method === 'POST') {
      const result = await submitPaperOrder(await readJson(req), Date.now(), authUser)
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/api/events' && req.method === 'POST') {
      return json(res, 200, await recordProductEvent(await readJson(req), authUser))
    }

    if (url.pathname === '/api/paper/orders' && req.method === 'GET') {
      const result = await listPaperOrders(authUser)
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/api/paper/account' && req.method === 'GET') {
      const result = await getPaperAccount({
        currentUnderlyingPrice: url.searchParams.get('currentUnderlyingPrice') ?? url.searchParams.get('currentPrice'),
        prices: parseJsonQuery(url.searchParams.get('prices')),
      }, Date.now(), authUser)
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/api/paper/account/mark' && req.method === 'POST') {
      const result = await getPaperAccount(await readJson(req), Date.now(), authUser)
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/api/paper/account/reset' && req.method === 'POST') {
      const result = await resetPaperAccount(await readJson(req), Date.now(), authUser)
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/api/paper/positions' && req.method === 'GET') {
      const result = await listPaperPositions({
        status: url.searchParams.get('status') || 'open',
        currentUnderlyingPrice: url.searchParams.get('currentUnderlyingPrice') ?? url.searchParams.get('currentPrice'),
      }, authUser)
      return json(res, result.status, result.body)
    }

    const closeMatch = url.pathname.match(/^\/api\/paper\/positions\/([^/]+)\/close$/)
    if (closeMatch && req.method === 'POST') {
      const result = await closePaperPositionById(decodeURIComponent(closeMatch[1]), await readJson(req), Date.now(), authUser)
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
      const content = JSON.stringify({ prompt, marketContext })
      const modelResponse = await deepseekChat([{ role: 'user', content }], systemExtra)
      const guarded = guardAssistantText(modelResponse.text, { isZh })
      return json(res, 200, {
        ...modelResponse,
        text: guarded.warnings.length ? `${guarded.warnings[0]}\n\n${guarded.answer}` : guarded.answer,
        warnings: guarded.warnings,
        dataGaps: Array.isArray(marketContext.dataGaps) ? marketContext.dataGaps : [],
      })
    }

    if (url.pathname === '/api/assistant/chat' && req.method === 'POST') {
      const body = await readJson(req)
      const userMessage = String(body.userMessage ?? '').trim().slice(0, 2000)
      if (!userMessage) throw safeError('userMessage is required.', 400)
      // Page buttons (strategy_explanation) send a templated prompt, so the UI language decides; typed chat follows the user.
      const isZh = body.mode === 'strategy_explanation'
        ? body.language === 'zh'
        : replyLanguage(userMessage, Array.isArray(body.history) ? body.history : [], body.language) === 'zh'
      const rawPrior = normalizeAgentState(body.agentState, normalizeAgentProfile)
      const clientContext = body.marketContext ?? {}
      const pageTicker = profileFromMarketContext(clientContext).ticker
      if (isPromptInjection(userMessage) || isOutOfScopeAssistantMessage(userMessage) || isAdviceRequest(userMessage)) {
        const advice = isAdviceRequest(userMessage) && !isPromptInjection(userMessage)
        return json(res, 200, {
          intent: advice ? 'clarify' : 'refuse',
          mode: advice ? 'boundary' : 'refuse',
          answer: advice
            ? adviceBoundaryAnswer(rawPrior.profile.ticker ?? pageTicker, isZh)
            : isZh
              ? '我专注于期权策略、风险收益分析和模拟交易学习。可以告诉我你关注的标的和看法，我来帮你筛选和解释策略。'
              : 'I focus on options strategies, risk/payoff analysis, and paper-trading education. Tell me a ticker and your view and I can screen and explain strategies.',
          sections: [],
          referencedStrategyIds: [],
          warnings: [],
          dataGaps: [],
          // Off-topic turns do not consume the open follow-up question.
          agentState: rawPrior,
        })
      }
      const history = (Array.isArray(body.history) ? body.history : [])
        .filter((item) => item && ['user', 'assistant'].includes(item.role))
        .slice(-8)
        .map((item) => ({ role: item.role, content: String(item.content ?? '').slice(0, 1200) }))
      const systemExtra = isZh
        ? 'CRITICAL LANGUAGE RULE: You MUST write every word of your response in Simplified Chinese (简体中文). Do not use any English words except stock tickers, option Greeks, strategy names, and technical abbreviations (e.g. NVDA, IV, ATM).'
        : 'CRITICAL LANGUAGE RULE: The user is writing in English. Write the whole response in English, even if earlier turns were in Chinese.'

      // 1. Understand the turn: deterministic rules first, the model fills semantic gaps.
      const turn = parseAssistantTurn(userMessage, rawPrior)
      const formProfile = profileFromMarketContext(clientContext)
      let modelExtraction = { intent: 'clarify', profilePatch: {} }
      try {
        const extractionResponse = await deepseekChat([{
          role: 'user',
          content: JSON.stringify(buildExtractionPrompt({
            userMessage,
            history,
            currentProfile: mergeAgentProfile(formProfile, rawPrior.profile),
            pendingField: rawPrior.pending?.field,
            language: isZh ? 'zh' : 'en',
          })),
        }], systemExtra)
        const parsedExtraction = safeParseAssistantJson(extractionResponse.text)
        if (parsedExtraction) modelExtraction = normalizeExtraction(parsedExtraction)
        else console.warn('[assistant] extraction returned non-JSON')
      } catch (error) {
        console.warn('[assistant] extraction failed:', error?.message)
      }
      const modelPatch = sanitizeModelPatch(
        mergeAgentProfile(modelExtraction.profilePatch, modelExtraction.requestedAdjustment),
        userMessage,
        { ...turn, pendingField: rawPrior.pending?.field },
      )
      const patch = mergeAgentProfile(modelPatch, turn.patch)
      // The engine only understands canonical horizons; free-form model output is discarded.
      if (patch.horizon && !turn.patch.horizon) {
        const horizon = canonicalHorizon(patch.horizon)
        if (horizon) patch.horizon = horizon
        else delete patch.horizon
      }

      // 2. Memory: a new ticker drops ticker-specific facts; the page form supplies defaults for the rest.
      const { prior, tickerChanged } = scopeStateToTicker(rawPrior, patch.ticker, formProfile.ticker)
      const activeTicker = patch.ticker ?? prior.profile.ticker ?? formProfile.ticker
      const pageProfile = formProfile.ticker && formProfile.ticker !== activeTicker
        ? withoutTickerScoped(Object.fromEntries(Object.entries(formProfile).filter(([key]) => key !== 'ticker')))
        : formProfile
      // "before" is what the user was looking at, so a ticker switch counts as a change.
      const before = mergeAgentProfile(prior.profile, pageProfile)
      const previousTicker = rawPrior.profile.ticker ?? formProfile.ticker
      if (previousTicker) before.ticker = previousTicker
      else delete before.ticker

      let intent = resolveIntent(turn.intent, { prior, patch, skippedField: turn.skippedField, message: userMessage, forecast: turn.forecast })
      if (intent === 'clarify' && !turn.forecast && modelExtraction.intent !== 'refuse') intent = modelExtraction.intent
      if (intent === 'adjust' && !patch.horizon) {
        const shifted = shiftHorizon(before.horizon, userMessage)
        if (shifted) patch.horizon = shifted
      }
      let changes = []
      let memoryProfile
      let profile
      let structuredUpdates
      const settle = () => {
        changes = Object.keys(patch).filter((key) => JSON.stringify(patch[key]) !== JSON.stringify(before[key]))
        // Memory always records which ticker the conversation is about, even when it came from the page.
        memoryProfile = mergeAgentProfile({ ...prior.profile, ticker: activeTicker }, patch)
        profile = mergeAgentProfile({ ...before, ticker: activeTicker }, patch)
        structuredUpdates = profileUpdatesForClient(patch)
      }
      settle()
      // Fields the user settled on the page form count as answered; the chat does not ask for them again.
      const formConfirmed = (Array.isArray(clientContext.confirmedFields) ? clientContext.confirmedFields : [])
        .map(String)
        .filter((field) => ['riskBudget', 'experienceLevel', 'acceptsAssignment', 'direction', 'horizon', 'targetPrice'].includes(field) && formProfile[field] !== undefined)
      const confirmed = new Set([...Object.keys(prior.profile), ...Object.keys(patch), ...formConfirmed, ...turn.confirmedFields])
      const asked = [...new Set([...prior.asked, ...(turn.skippedField ? [turn.skippedField] : [])])]

      // 3. Ground the turn in live data. A strategy the user just picked on the page wins over the chat focus;
      //    otherwise "this one" keeps meaning the strategy the conversation was about.
      const reference = turn.reference ?? strategyReference(userMessage, prior)
      const clientSelectedId = String(clientContext.selectedStrategy?.id ?? clientContext.selectedStrategyId ?? '') || undefined
      const pageSelectionChanged = Boolean(!tickerChanged && clientSelectedId && clientSelectedId !== prior.clientSelectedId)
      const selectedStrategyId = pageSelectionChanged ? clientSelectedId : prior.focusStrategyId ?? (tickerChanged ? undefined : clientSelectedId)
      // A new view re-screens from scratch, so contract edits made for the old screen no longer apply.
      const rescreened = tickerChanged || changes.some((field) => ['direction', 'horizon', 'strength', 'targetPrice'].includes(field))
      let contractOverrides = rescreened ? {} : prior.contractOverrides
      const clientStrategy = !rescreened && pageTicker === activeTicker ? clientContext.selectedStrategy : undefined
      const loadContext = () => canonicalAssistantContext(profile, selectedStrategyId, contractOverrides, clientStrategy).catch((error) => {
        console.warn('[assistant] market context failed:', error?.message)
        return { strategies: [], dataGaps: [`QVERIS_MARKET_GAP: ${error?.message || 'market context unavailable'}`] }
      })
      let context = profile.ticker && intent !== 'refuse' ? await loadContext() : { strategies: [], dataGaps: [] }
      if (context.appliedOverrides) contractOverrides = context.appliedOverrides
      const spot = Number(context.market?.price) || undefined
      const contracts = Array.isArray(context.options?.contracts) ? context.options.contracts : []
      const leadExpiration = (context.selectedStrategy ?? context.strategies?.find((strategy) => strategy.legs?.length))?.legs?.[0]?.expiration
      const volatility = spot && contracts.length ? volatilitySummary(contracts, spot, leadExpiration) : undefined

      // A target that contradicts the view or sits far outside the priced range is confirmed before it is used.
      let targetIssue
      if (patch.targetPrice !== undefined && changes.includes('targetPrice') && !turn.confirmedFields.includes('targetPrice') && spot) {
        const days = horizonDays(profile.horizon)
        const iv = (spot && contracts.length ? volatilitySummary(contracts, spot, new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)) : undefined)?.impliedVolatility
        targetIssue = targetSanity({ target: patch.targetPrice, spot, impliedVolatility: iv, days, direction: profile.direction })
        if (targetIssue) {
          delete patch.targetPrice
          settle()
        }
      }

      // Contract-level edits ("行权价换成 1150", "宽一点", "2 张") re-price the focus strategy's legs on the live chain.
      let contractResult
      if (intent === 'adjust' && turn.contract && !targetIssue && !turn.invalid.length) {
        const focusId = reference?.id
          ?? (pageSelectionChanged ? clientSelectedId : undefined)
          ?? prior.focusStrategyId
          ?? clientSelectedId
          ?? prior.lastReferencedIds?.[0]
        const current = context.strategies?.find((strategy) => strategy.id === focusId && strategy.legs?.length)
        const base = context.baseStrategies?.find((strategy) => strategy.id === focusId)
        if (!current || !base) {
          contractResult = { status: 'error', error: focusId ? 'no_legs' : 'no_focus' }
        } else {
          const resolution = resolveContractAdjustment(current, turn.contract, contracts)
          const adjusted = resolution.error
            ? undefined
            : adjustStrategyLegs({ baseStrategy: base, optionChain: context.options, view: context.parsedView, adjustments: resolution.adjustments })
          if (resolution.error) contractResult = { status: 'error', ...resolution, strategy: current }
          else if (!adjusted?.strategy) contractResult = { status: 'error', error: 'strike_missing', legs: resolution.adjustments, strategy: current }
          else {
            contractResult = { status: 'ok', before: current, after: adjusted.strategy, resolution }
            contractOverrides = { ...contractOverrides, [base.id]: resolution.adjustments }
            context = {
              ...context,
              strategies: context.strategies.map((strategy) => (strategy.id === base.id ? adjusted.strategy : strategy)),
              selectedStrategy: context.selectedStrategy?.id === base.id ? adjusted.strategy : context.selectedStrategy,
            }
          }
        }
      }

      const plan = buildAssistantPlan({
        intent,
        message: userMessage,
        profile,
        confirmed,
        context,
        prior: { ...prior, asked },
        reference,
        references: turn.references,
        changes,
        forecast: turn.forecast,
        missingOrdinals: turn.missingOrdinals,
        invalid: turn.invalid,
        declinedField: turn.declinedField,
        targetIssue,
        contractResult,
        scenarioPrice: turn.scenarioPrice,
        scenario: turn.scenario,
        volatility,
        isZh,
      })
      // The narrator states adjustments as from -> to instead of guessing their direction from history.
      const shown = (field, value) => {
        if (value === undefined || value === null) return null
        if (!isZh) return value
        if (field === 'horizon') return horizonZh[value] ?? value
        if (field === 'direction') return { bullish: '看涨', bearish: '看跌', neutral: '中性', volatile: '大波动' }[value] ?? value
        if (field === 'strength') return { mild: '温和', moderate: '中等', strong: '强烈' }[value] ?? value
        if (field === 'experienceLevel') return { beginner: '新手', intermediate: '有一定经验', advanced: '熟练' }[value] ?? value
        return value
      }
      if (changes.length) plan.changed = changes.map((field) => before[field] == null
        ? { field, newlySet: shown(field, patch[field]) }
        : { field, from: shown(field, before[field]), to: shown(field, patch[field]) })
      const nextState = nextAgentState({ prior, plan, intent, memoryProfile, asked, changes, clientSelectedId: tickerChanged ? undefined : clientSelectedId, contractOverrides })
      const responseBase = {
        intent,
        mode: plan.mode,
        sections: plan.cards,
        referencedStrategyIds: plan.referencedStrategyIds,
        assumptions: plan.assumptions,
        dataGaps: plan.dataGaps,
        structuredUpdates,
        agentState: nextState,
        snapshotId: context.snapshotId,
        ...(plan.contractAdjustment ? { contractAdjustment: plan.contractAdjustment } : {}),
      }
      const deterministic = deterministicAnswer(plan, isZh)
      const defaultFollowUp = plan.followUpText ?? (plan.followUpField ? profileQuestion(plan.followUpField, isZh) : undefined)

      if (['ask', 'adjust_unsupported', 'ordinal_missing', 'invalid_input', 'target_check', 'contract_clarify'].includes(plan.mode)) {
        return json(res, 200, { ...responseBase, answer: deterministic, followUpQuestion: undefined, warnings: [], source: 'deterministic' })
      }

      // 4. The model narrates the deterministic plan and may look up extra facts with read-only data tools.
      //    Any number that is not from the plan, the user's message or a tool result falls back to deterministic text.
      const toolbox = context.market?.price
        ? createAssistantTools({ ticker: profile.ticker, context, fetchJson: assistantApiJson, focusStrategyId: plan.focusStrategyId })
        : undefined
      let narrated
      try {
        const response = await deepseekChat([{
          role: 'user',
          content: JSON.stringify(buildExplanationPrompt({ userMessage, history, plan, language: isZh ? 'zh' : 'en', tools: Boolean(toolbox) })),
        }], systemExtra, toolbox ? { tools: assistantToolSpecs, runTool: toolbox.run } : {})
        narrated = safeParseAssistantJson(response.text)
        if (!narrated) console.warn('[assistant] explanation returned non-JSON')
      } catch (error) {
        console.warn('[assistant] explanation failed:', error?.message)
      }
      if (toolbox?.calls.length) console.log(`[assistant] tools used: ${toolbox.calls.join(', ')}`)
      const messageNumbers = [...userMessage.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => Number(match[0].replaceAll(',', ''))).filter(Number.isFinite)
      const trusted = { plan, extra: [profile.riskBudget, profile.targetPrice, ...messageNumbers, ...(toolbox?.outputs ?? [])] }
      const unknownNumbers = (sentence) => unknownFinancialNumbers({ answer: sentence }, trusted)
      // Single-strategy answers are checked for IV / time / price claims that contradict the repriced position.
      const effects = ['explain', 'risk_check', 'contract_adjust'].includes(plan.mode) ? plan.focus?.sensitivity?.effects : undefined
      const claimIssue = (sentence) => directionalClaimIssue(sentence, effects)
      const answerGuard = guardAssistantText(narrated?.answer, { isZh, unknownNumbers, claimIssue })
      const followGuard = guardAssistantText(narrated?.followUpQuestion, { isZh, unknownNumbers, claimIssue })
      // The lead sentence carries the conclusion; without it the remainder reads as a fragment.
      const useModel = answerGuard.answer.length > 0 && !answerGuard.firstDropped && answerGuard.dropped <= Math.floor(answerGuard.total / 2)
      if (answerGuard.dropped) console.warn(`[assistant] narration dropped ${answerGuard.dropped}/${answerGuard.total} sentences: ${answerGuard.reasons.join('; ')}`)
      if (narrated && !useModel) console.warn('[assistant] narration rejected, using deterministic answer')
      const followUpQuestion = (plan.followUpField ? followGuard.answer || defaultFollowUp : followGuard.answer) || undefined
      let answer = useModel ? answerGuard.answer : deterministic
      // The follow-up is shown on its own line; a question repeated at the end of the answer reads twice.
      if (useModel && followUpQuestion) answer = answer.replace(/[^。！？!?\n]*[？?]\s*$/, '').trim() || answer
      return json(res, 200, {
        ...responseBase,
        answer,
        followUpQuestion,
        warnings: [...answerGuard.warnings],
        source: useModel ? 'model' : 'deterministic',
        ...(toolbox?.calls.length ? { toolCalls: toolbox.calls } : {}),
      })
    }

    if (url.pathname.startsWith('/api/quote/')) {
      const ticker = tickerFromPath(url.pathname, '/api/quote/')
      if (!ticker) throw safeError('Ticker is required.', 400)
      const cacheKey = `av-quote-v1:${ticker}`
      const cachedBody = cached(quoteCache, 'quote', cacheKey)
      if (cachedBody) return json(res, 200, cachedBody)
      const quote = validLiveQuote(ticker, await qverisExecute(tools.liveQuote, stockQuoteParameters(ticker)))
      if (!quote) throw safeError('Alpha Vantage quote is unavailable.')
      return json(res, 200, cacheSet(quoteCache, 'quote', cacheKey, quote, quoteRefreshMs))
    }

    if (url.pathname.startsWith('/api/market/')) {
      const ticker = tickerFromPath(url.pathname, '/api/market/')
      if (!ticker) throw safeError('Ticker is required.', 400)
      const range = url.searchParams.get('range') || '1h'
      const cacheKey = `av-market-v1:${ticker}:${range}:${isUsRegularMarketOpen() ? 'open' : 'closed'}`
      const cachedBody = cached(marketCache, 'market', cacheKey)
      if (cachedBody) return json(res, 200, cachedBody)
      const rangeParams = marketRangeParams(range)
      const [liveQuoteResult, candlesResult] = await Promise.allSettled([
        qverisExecute(tools.liveQuote, stockQuoteParameters(ticker)),
        qverisExecute(candleTool(rangeParams), candleParameters(ticker, rangeParams), 200000),
      ])
      const dataGaps = []
      const liveQuote = liveQuoteResult.status === 'fulfilled' ? validLiveQuote(ticker, liveQuoteResult.value) : null
      if (!liveQuote) dataGaps.push(`QVERIS_MARKET_GAP: quote snapshot unavailable (${liveQuoteResult.reason?.message ?? 'empty response'}).`)
      const candles = candlesResult.status === 'fulfilled'
        ? aggregateCandles(normalizeAlphaVantageCandles(candlesResult.value), rangeParams.group ?? 1).slice(-rangeParams.pageSize)
        : []
      if (candlesResult.status === 'rejected' || !candles.length) dataGaps.push(`QVERIS_MARKET_GAP: Alpha Vantage OHLCV unavailable (${candlesResult.reason?.message ?? 'empty response'}).`)
      const snapshot = liveQuote ?? emptyQuote(ticker)
      const lastCandle = candles.at(-1)
      return json(res, 200, cacheSet(marketCache, 'market', cacheKey, {
        ...snapshot,
        price: snapshot.price ?? lastCandle?.close ?? null,
        open: snapshot.open ?? lastCandle?.open ?? null,
        high: snapshot.high ?? lastCandle?.high ?? null,
        low: snapshot.low ?? lastCandle?.low ?? null,
        volume: snapshot.volume ?? lastCandle?.volume ?? null,
        candles,
        dataGaps,
        message: dataGaps.length ? 'Alpha Vantage market data loaded with explicit gaps.' : 'Alpha Vantage quote and OHLCV loaded through QVeris.',
      }, marketRefreshMs))
    }

    if (url.pathname.startsWith('/api/options/')) {
      const ticker = tickerFromPath(url.pathname, '/api/options/')
      if (!ticker) throw safeError('Ticker is required.', 400)
      const marketOpen = isUsRegularMarketOpen()
      const cacheKey = `av-options-v1:${ticker}:${marketOpen ? 'open' : 'closed'}`
      const cachedBody = cached(optionsCache, 'options', cacheKey)
      if (cachedBody) return json(res, 200, cachedBody)
      try {
        const [liveQuoteResult, chainResult] = await Promise.allSettled([
          qverisExecute(tools.liveQuote, stockQuoteParameters(ticker)),
          qverisExecute(tools.optionChain, { function: 'REALTIME_OPTIONS', symbol: ticker, require_greeks: 'true' }, 20000),
        ])
        if (chainResult.status === 'rejected') throw chainResult.reason
        const today = newYorkToday()
        const chain = normalizeAlphaVantageOptionChain(ticker, chainResult.value)
        const liveQuote = liveQuoteResult.status === 'fulfilled' ? validLiveQuote(ticker, liveQuoteResult.value) : null
        const spot = liveQuote?.price ?? impliedSpotFromChain(chain.contracts, today)
        if (!spot) throw safeError('Underlying price is unavailable for the option chain.')
        const expirations = new Set(selectUsefulExpirations(optionExpirations(chain.contracts), today))
        const contracts = pruneOptionContracts(chain.contracts.filter((row) => expirations.has(row.expiration)), spot)
        const { issues } = chain
        const status = contracts.length ? 'available' : 'unavailable'
        const spotGaps = []
        if (!liveQuote) spotGaps.push(`QVERIS_DATA_GAP: stock quote unavailable (${liveQuoteResult.reason?.message ?? 'empty response'}); spot is implied from put-call parity.`)
        if (issues.invalidMarkets) spotGaps.push(`QVERIS_DATA_QUALITY: ${issues.invalidMarkets} crossed markets were excluded.`)
        if (issues.invalidGamma) spotGaps.push(`QVERIS_DATA_QUALITY: ${issues.invalidGamma} negative Gamma values were excluded.`)
        if (issues.invalidDelta) spotGaps.push(`QVERIS_DATA_QUALITY: ${issues.invalidDelta} invalid Delta values were excluded.`)
        if (issues.invalidValues) spotGaps.push(`QVERIS_DATA_QUALITY: ${issues.invalidValues} negative quote, size, volume, open interest, or Vega values were isolated.`)
        const market = liveQuote ?? { ...emptyQuote(ticker), price: spot, marketDataType: 'implied_from_options' }
        return json(res, 200, cacheSet(optionsCache, 'options', cacheKey, {
          ticker,
          status,
          mode: 'live',
          dataSource: 'alphavantage',
          contracts,
          market,
          asOf: new Date().toISOString(),
          openInterestCadence: 'Open interest is a daily field and may represent the previous trading day.',
          message: contracts.length
            ? 'Alpha Vantage option chain normalized through QVeris.'
            : 'Alpha Vantage returned no normalized US option contracts.',
          dataGaps: [
            ...spotGaps,
            'QVERIS_DATA_GAP: per-contract quote timestamps are not exposed by the chain response.',
            'QVERIS_DATA_GAP: US equity option multiplier 100 remains a product assumption.',
          ],
        }, marketOpen ? optionsRefreshMs : closedCacheMs))
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
      return json(res, 200, {
        ticker,
        earnings: [],
        filings: [],
        dataGaps: ['QVERIS_EVENTS_GAP: the data provider does not currently expose a verified US earnings calendar or SEC filings endpoint.'],
      })
    }

    if (url.pathname.startsWith('/api/volatility/')) {
      const ticker = tickerFromPath(url.pathname, '/api/volatility/')
      if (!ticker) throw safeError('Ticker is required.', 400)
      const options = await assistantApiJson(`/api/options/${encodeURIComponent(ticker)}`)
      if (options.status !== 'available' || !options.market?.price) {
        return json(res, 200, { ticker, spot: null, asOf: options.asOf, tenors: [], moneyness: [], iv: [], dataGaps: options.dataGaps ?? [] })
      }
      return json(res, 200, volatilityFromContracts(ticker, options.market.price, options.contracts, options.asOf))
    }

    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/') && tryStatic(req, res, url)) return

    json(res, 404, { error: 'Not found' })
  } catch (error) {
    json(res, error.status || 500, { error: error.expose ? error.message : 'Server error' })
  }
}

if (process.argv.includes('--smoke')) {
  const ticker = process.argv.at(-1)?.startsWith('--') ? 'NVDA' : process.argv.at(-1) || 'NVDA'
  const market = await qverisExecute(tools.liveQuote, stockQuoteParameters(ticker.toUpperCase()))
  console.log(JSON.stringify({ ok: true, ticker: ticker.toUpperCase(), price: normalizeAlphaVantageQuote(ticker.toUpperCase(), market).price }, null, 2))
} else {
  createServer(handle).listen(port, host, () => {
    const origin = `http://${host}:${port}`
    console.log(`QVeris API listening on ${origin}`)
  })
}
