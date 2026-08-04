import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agentFallbackResponse,
  buildAssistantPlan,
  classifyAssistantIntent,
  enforceAgentResponse,
  guardAssistantText,
} from './assistantAgent.mjs'
import {
  buildExplanationPrompt,
  buildExtractionPrompt,
  isPromptInjection,
  mergeAgentProfile,
  nextRequiredProfileField,
  normalizeExtraction,
  parsedViewInput,
  profileFromMarketContext,
  profileQuestion,
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
  normalizeFiuCandles,
  normalizeFiuExpirations,
  normalizeFiuOptionChain,
  normalizeFiuQuote,
  pruneFiuOptionContracts,
  volatilityFromContracts,
} from './fiuData.mjs'
import { createAuthRuntime } from './auth.mjs'
import { parseUserView } from '../src/core/parseUserView.ts'
import { fiuQuoteSessionId, isUsOptionsRegularTradingHours as isUsRegularMarketOpen } from '../src/core/paperTradeEngine.ts'
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
const optionsRefreshMs = Number(process.env.QVERIS_OPTIONS_REFRESH_MS || 10000)
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
  liveQuote: 'fiu_mcp_server.postv1stockquote.create.v2.1790f84e',
  candles: 'fiu_mcp_server.postv1chartklinelist.create.v2.41a84fef',
  optionExpirations: 'fiu_mcp_server.postoprav1chainexpiration.create.v2.708b0fcc',
  optionChain: 'fiu_mcp_server.postoprav1chainquery.create.v2.d591d0f8',
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

function stockQuoteParameters(tickers, now = Date.now()) {
  return { fields: ['snapshot'], symbols: tickers.map((ticker) => `${ticker}.US`), timeMode: 0, sessionId: fiuQuoteSessionId(now) }
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
  const result = payload.result?.data ?? payload.result
  if (result && typeof result === 'object' && 'code' in result && Number(result.code) !== 200) {
    throw safeError(`QVeris provider rejected the request: ${result.msg || result.message || toolId}`, 502)
  }
  return result
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

async function canonicalAssistantContext(profile, selectedStrategyId) {
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
    return {
      ticker,
      market,
      options,
      strategies: [],
      selectedStrategy: undefined,
      parsedView: undefined,
      snapshotId: `${ticker}:${options.asOf || market?.asOf || 'unavailable'}`,
      generatedAt: options.asOf || market?.asOf || new Date().toISOString(),
      dataGaps,
      recommendable: false,
    }
  }
  const parsedView = parseUserView(parsedViewInput(profile, spot))
  const strategies = recommendStrategyTypes(parsedView, options, undefined, { rank: true })
  const selectedStrategy = strategies.find((strategy) => strategy.id === selectedStrategyId)
  const orderedStrategies = selectedStrategy
    ? [selectedStrategy, ...strategies.filter((strategy) => strategy.id !== selectedStrategy.id)]
    : strategies
  return {
    ticker,
    market,
    options,
    strategies: orderedStrategies,
    selectedStrategy,
    parsedView,
    snapshotId: `${ticker}:${options.asOf || market?.asOf}`,
    generatedAt: options.asOf || market?.asOf || new Date().toISOString(),
    dataGaps,
    recommendable: orderedStrategies.some((strategy) => strategy.status === 'contract_ready' && strategy.legs.length > 0),
  }
}

async function deepseekChat(messages, systemExtra = '') {
  let response
  try {
    response = await fetch(`${deepseekBaseUrl}/chat/completions`, {
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
    '15m': { kind: 'intraday', fiuType: 7, pageSize: 140 },
    '30m': { kind: 'intraday', fiuType: 8, pageSize: 140 },
    '1h': { kind: 'intraday', fiuType: 9, pageSize: 160 },
    '4h': { kind: 'intraday', fiuType: 12, pageSize: 160 },
    '1d': { kind: 'daily', fiuType: 0, pageSize: 252 },
    '5d': { kind: 'intraday', fiuType: 8, pageSize: 140 },
    '1m': { kind: 'intraday', fiuType: 9, pageSize: 160 },
    daily: { kind: 'daily', fiuType: 0, pageSize: 126 },
    '3m': { kind: 'daily', fiuType: 0, pageSize: 66 },
    '1y': { kind: 'daily', fiuType: 0, pageSize: 252 },
    '5y': { kind: 'daily', fiuType: 1, pageSize: 260 },
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
  const quote = normalizeFiuQuote(ticker, result)
  return quote.price && quote.timestamp ? quote : null
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
      if (isPromptInjection(userMessage) || isOutOfScopeAssistantMessage(userMessage)) {
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
      const clientContext = body.marketContext ?? {}
      const history = Array.isArray(body.history) ? body.history : []
      const systemExtra = isZh
        ? 'CRITICAL LANGUAGE RULE: You MUST write every word of your response in Simplified Chinese (简体中文). Do not use any English words except stock tickers, option Greeks, and technical abbreviations (e.g. NVDA, IV, ATM).'
        : ''

      const currentProfile = profileFromMarketContext(clientContext)
      const parserFallback = buildAssistantPlan({
        userMessage,
        marketContext: { parsedView: clientContext.parsedView ?? {} },
        history,
        isZh,
      })
      let extraction = normalizeExtraction(undefined, {
        intent: classifyAssistantIntent(userMessage),
        profilePatch: parserFallback.structuredUpdates,
      })
      try {
        const extractionResponse = await deepseekChat([
          {
            role: 'user',
            content: JSON.stringify(buildExtractionPrompt({
              userMessage,
              history,
              currentProfile,
              language: isZh ? 'zh' : 'en',
            })),
          },
        ], systemExtra)
        extraction = normalizeExtraction(safeParseAssistantJson(extractionResponse.text), extraction)
      } catch {
        // Deterministic parsing keeps the assistant usable when the model is unavailable.
      }
      const profile = mergeAgentProfile(currentProfile, {
        ...extraction.profilePatch,
        ...extraction.requestedAdjustment,
      })
      const structuredUpdates = profileUpdatesForClient(extraction.profilePatch)
      const missingField = nextRequiredProfileField(extraction.intent, profile)
      if (missingField) {
        const question = profileQuestion(missingField, isZh)
        return json(res, 200, {
          intent: 'clarify',
          answer: question,
          followUpQuestion: question,
          structuredUpdates,
          referencedStrategyIds: [],
          warnings: [],
          dataGaps: [],
          agentState: { status: 'collecting', profile, missingFields: [missingField] },
        })
      }

      const needsEngine = ['recommend', 'compare', 'adjust', 'risk_check', 'explain'].includes(extraction.intent)
      const selectedStrategyId = String(clientContext.selectedStrategy?.id ?? clientContext.selectedStrategyId ?? '') || undefined
      const canonicalContext = needsEngine
        ? await canonicalAssistantContext(profile, selectedStrategyId)
        : {
            ticker: profile.ticker,
            market: undefined,
            options: undefined,
            strategies: [],
            selectedStrategy: undefined,
            parsedView: clientContext.parsedView ?? {},
            snapshotId: undefined,
            generatedAt: new Date().toISOString(),
            dataGaps: [],
            recommendable: false,
          }

      if (needsEngine && !canonicalContext.recommendable) {
        const answer = isZh
          ? '当前行情或期权链不足以生成合约级推荐，我只能提供策略教学说明。'
          : 'The current market or option-chain snapshot is insufficient for a contract-level recommendation; I can provide strategy education only.'
        return json(res, 200, {
          intent: 'clarify',
          answer,
          followUpQuestion: isZh ? '是否先了解适合当前观点的策略类型？' : 'Would you like an educational overview of strategy types for this view?',
          structuredUpdates,
          referencedStrategyIds: [],
          warnings: [answer],
          dataGaps: canonicalContext.dataGaps,
          agentState: { status: 'degraded', profile, snapshotId: canonicalContext.snapshotId },
        })
      }

      const agentPlanBase = buildAssistantPlan({ userMessage, marketContext: canonicalContext, history, isZh })
      const agentPlan = {
        ...agentPlanBase,
        intent: extraction.intent,
        structuredUpdates,
        agentState: {
          status: needsEngine ? 'recommended' : 'ready',
          profile,
          snapshotId: canonicalContext.snapshotId,
          missingFields: [],
        },
      }
      if (agentPlan.directResponse) {
        return json(res, 200, {
          ...agentPlan.directResponse,
          structuredUpdates,
          agentState: agentPlan.agentState,
        })
      }

      let parsed
      try {
        const response = await deepseekChat([
          {
            role: 'user',
            content: JSON.stringify(buildExplanationPrompt({
              userMessage,
              history,
              profile,
              plan: agentPlan,
              marketContext: canonicalContext,
              language: isZh ? 'zh' : 'en',
            })),
          },
        ], systemExtra)
        parsed = safeParseAssistantJson(response.text)
      } catch {
        parsed = null
      }
      if (!parsed || unknownFinancialNumbers(parsed, { profile, agentPlan, canonicalContext }).length) {
        const fallback = agentFallbackResponse(agentPlan, isZh)
        return json(res, 200, {
          ...fallback,
          structuredUpdates,
          agentState: agentPlan.agentState,
        })
      }
      return json(res, 200, {
        ...enforceAgentResponse(parsed, canonicalContext, agentPlan, isZh),
        structuredUpdates,
        agentState: agentPlan.agentState,
      })
    }

    if (url.pathname.startsWith('/api/quote/')) {
      const ticker = tickerFromPath(url.pathname, '/api/quote/')
      if (!ticker) throw safeError('Ticker is required.', 400)
      const cacheKey = `fiu-quote-v1:${ticker}`
      const cachedBody = cached(quoteCache, 'quote', cacheKey)
      if (cachedBody) return json(res, 200, cachedBody)
      const quote = validLiveQuote(ticker, await qverisExecute(tools.liveQuote, stockQuoteParameters([ticker])))
      if (!quote) throw safeError('FIU realtime quote is unavailable.')
      return json(res, 200, cacheSet(quoteCache, 'quote', cacheKey, quote, quoteRefreshMs))
    }

    if (url.pathname.startsWith('/api/market/')) {
      const ticker = tickerFromPath(url.pathname, '/api/market/')
      if (!ticker) throw safeError('Ticker is required.', 400)
      const range = url.searchParams.get('range') || '1h'
      const cacheKey = `fiu-market-v2:${ticker}:${range}:${isUsRegularMarketOpen() ? 'open' : 'closed'}`
      const cachedBody = cached(marketCache, 'market', cacheKey)
      if (cachedBody) return json(res, 200, cachedBody)
      const rangeParams = marketRangeParams(range)
      const date = new Date().toISOString().slice(0, 10)
      const [liveQuoteResult, candlesResult] = await Promise.allSettled([
        qverisExecute(tools.liveQuote, stockQuoteParameters([ticker])),
        qverisExecute(tools.candles, {
          candleMode: 1,
          timeMode: 0,
          type: rangeParams.fiuType,
          date: rangeParams.kind === 'daily' ? date : `${date} 23:59:59`,
          symbol: `${ticker}.US`,
          pageNum: 1,
          pageSize: rangeParams.pageSize,
        }, 100000),
      ])
      const dataGaps = []
      const liveQuote = liveQuoteResult.status === 'fulfilled' ? validLiveQuote(ticker, liveQuoteResult.value) : null
      if (!liveQuote) dataGaps.push(`QVERIS_MARKET_GAP: realtime quote snapshot unavailable (${liveQuoteResult.reason?.message ?? 'empty response'}).`)
      const candles = candlesResult.status === 'fulfilled' ? normalizeFiuCandles(candlesResult.value) : []
      if (candlesResult.status === 'rejected' || !candles.length) dataGaps.push(`QVERIS_MARKET_GAP: FIU OHLCV unavailable (${candlesResult.reason?.message ?? 'empty response'}).`)
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
        message: dataGaps.length ? 'FIU market data loaded with explicit gaps.' : 'FIU realtime quote and OHLCV loaded through QVeris.',
      }, marketRefreshMs))
    }

    if (url.pathname.startsWith('/api/options/')) {
      const ticker = tickerFromPath(url.pathname, '/api/options/')
      if (!ticker) throw safeError('Ticker is required.', 400)
      const marketOpen = isUsRegularMarketOpen()
      const cacheKey = `fiu-opra-v4:${ticker}:${marketOpen ? 'open' : 'closed'}`
      const cachedBody = cached(optionsCache, 'options', cacheKey)
      if (cachedBody) return json(res, 200, cachedBody)
      try {
        const [liveQuoteResult, expirationResult] = await Promise.allSettled([
          qverisExecute(tools.liveQuote, stockQuoteParameters([ticker])),
          qverisExecute(tools.optionExpirations, { requestBody: { root: ticker } }, 30000),
        ])
        const liveQuote = liveQuoteResult.status === 'fulfilled' ? validLiveQuote(ticker, liveQuoteResult.value) : null
        const quoteSpot = liveQuote?.price ?? null
        if (!quoteSpot) throw safeError('FIU underlying quote is unavailable.')
        if (expirationResult.status === 'rejected') throw expirationResult.reason
        const today = new Date().toISOString().slice(0, 10)
        const expirations = selectUsefulExpirations(normalizeFiuExpirations(expirationResult.value), today)
        const chains = await Promise.all(expirations.map(async (expiration) => normalizeFiuOptionChain(
          ticker,
          expiration,
          await qverisExecute(tools.optionChain, { requestBody: { root: ticker, type: 0, expiration } }, 1000000),
        )))
        const rawContracts = chains.flatMap((chain) => chain.contracts)
        const contracts = pruneFiuOptionContracts(rawContracts, quoteSpot)
        const issues = chains.reduce((sum, chain) => ({
          invalidMarkets: sum.invalidMarkets + chain.issues.invalidMarkets,
          invalidGamma: sum.invalidGamma + chain.issues.invalidGamma,
          invalidDelta: sum.invalidDelta + chain.issues.invalidDelta,
          invalidValues: sum.invalidValues + chain.issues.invalidValues,
        }), { invalidMarkets: 0, invalidGamma: 0, invalidDelta: 0, invalidValues: 0 })
        const status = contracts.length ? 'available' : 'unavailable'
        const spotGaps = []
        if (!liveQuote) spotGaps.push(`QVERIS_DATA_GAP: realtime stock quote unavailable (${liveQuoteResult.reason?.message ?? 'empty response'}).`)
        if (issues.invalidMarkets) spotGaps.push(`QVERIS_DATA_QUALITY: ${issues.invalidMarkets} crossed markets were excluded.`)
        if (issues.invalidGamma) spotGaps.push(`QVERIS_DATA_QUALITY: ${issues.invalidGamma} negative Gamma values were excluded.`)
        if (issues.invalidDelta) spotGaps.push(`QVERIS_DATA_QUALITY: ${issues.invalidDelta} invalid Delta values were excluded.`)
        if (issues.invalidValues) spotGaps.push(`QVERIS_DATA_QUALITY: ${issues.invalidValues} negative OPRA quote, size, volume, open interest, or Vega values were isolated.`)
        return json(res, 200, cacheSet(optionsCache, 'options', cacheKey, {
          ticker,
          status,
          mode: 'live',
          dataSource: 'fiu_opra',
          contracts,
          market: liveQuote ?? undefined,
          asOf: new Date().toISOString(),
          openInterestCadence: 'OPRA open interest is a daily field and may represent the previous trading day.',
          message: contracts.length
            ? 'FIU OPRA option chain normalized through QVeris.'
            : 'FIU OPRA returned no normalized US option contracts.',
          dataGaps: [
            ...spotGaps,
            'QVERIS_DATA_GAP: OPRA quote timestamps and timezone are not exposed by the chain response.',
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
        dataGaps: ['QVERIS_EVENTS_GAP: FIU does not currently expose a verified US earnings calendar or SEC filings endpoint.'],
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

if (process.argv.includes('--quote-refresh-self-check')) {
  const checks = [
    [Date.UTC(2026, 6, 6, 12), -1], // 08:00 ET premarket
    [Date.UTC(2026, 6, 6, 14), 1], // 10:00 ET regular session
    [Date.UTC(2026, 6, 6, 21), -2], // 17:00 ET postmarket
    [Date.UTC(2026, 6, 4, 16), -2], // Saturday: last postmarket snapshot
  ]
  for (const [now, expectedSessionId] of checks) {
    const parameters = stockQuoteParameters(['MU', 'AAPL'], now)
    if (JSON.stringify(parameters) !== JSON.stringify({ fields: ['snapshot'], symbols: ['MU.US', 'AAPL.US'], timeMode: 0, sessionId: expectedSessionId })) {
      throw new Error('FIU quote parameters self-check failed.')
    }
  }
  console.log('FIU quote parameters self-check passed.')
} else if (process.argv.includes('--smoke')) {
  const ticker = process.argv.at(-1)?.startsWith('--') ? 'NVDA' : process.argv.at(-1) || 'NVDA'
  const market = await qverisExecute(tools.liveQuote, stockQuoteParameters([ticker.toUpperCase()]))
  console.log(JSON.stringify({ ok: true, ticker: ticker.toUpperCase(), price: normalizeFiuQuote(ticker.toUpperCase(), market).price }, null, 2))
} else {
  createServer(handle).listen(port, host, () => {
    const origin = `http://${host}:${port}`
    console.log(`QVeris API listening on ${origin}`)
  })
}
