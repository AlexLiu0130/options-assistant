const intents = new Set(['clarify', 'recommend', 'explain', 'compare', 'educate', 'adjust', 'risk_check', 'refuse'])
const directions = new Set(['bullish', 'bearish', 'neutral', 'volatile'])
const strengths = new Set(['mild', 'moderate', 'strong'])
const experienceLevels = new Set(['beginner', 'intermediate', 'advanced'])
const eventContexts = new Set(['earnings', 'none', 'macro', 'unknown'])

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function booleanValue(value) {
  return typeof value === 'boolean' ? value : undefined
}

function enumValue(value, allowed) {
  const normalized = cleanString(value)?.toLowerCase()
  return normalized && allowed.has(normalized) ? normalized : undefined
}

export function normalizeAgentProfile(value = {}) {
  const raw = value && typeof value === 'object' ? value : {}
  const ticker = cleanString(raw.ticker)?.toUpperCase().replace(/[^A-Z0-9.-]/g, '')
  const profile = {
    ticker: ticker || undefined,
    direction: enumValue(raw.direction ?? raw.view, directions),
    strength: enumValue(raw.strength, strengths),
    horizon: cleanString(raw.horizon ?? raw.time_horizon),
    targetPrice: positiveNumber(raw.targetPrice ?? raw.target_price),
    riskBudget: positiveNumber(raw.riskBudget ?? raw.risk_budget),
    experienceLevel: enumValue(raw.experienceLevel ?? raw.experience_level, experienceLevels),
    ownsShares: booleanValue(raw.ownsShares ?? raw.owns_shares),
    sharesCount: positiveNumber(raw.sharesCount ?? raw.shares_count),
    acceptsAssignment: booleanValue(raw.acceptsAssignment ?? raw.willingToBeAssigned ?? raw.willing_to_be_assigned),
    eventContext: enumValue(raw.eventContext ?? raw.event_context, eventContexts),
  }
  return Object.fromEntries(Object.entries(profile).filter(([, item]) => item !== undefined))
}

export function profileFromMarketContext(marketContext = {}) {
  const parsed = marketContext?.parsedView && typeof marketContext.parsedView === 'object'
    ? marketContext.parsedView
    : {}
  return normalizeAgentProfile({
    ...parsed,
    ticker: marketContext?.ticker ?? parsed.ticker,
  })
}

export function mergeAgentProfile(current, patch) {
  return normalizeAgentProfile({ ...normalizeAgentProfile(current), ...normalizeAgentProfile(patch) })
}

export function profileUpdatesForClient(value) {
  const profile = normalizeAgentProfile(value)
  return Object.fromEntries(Object.entries({
    ticker: profile.ticker,
    direction: profile.direction,
    strength: profile.strength,
    horizon: profile.horizon,
    targetPrice: profile.targetPrice,
    riskBudget: profile.riskBudget,
    experienceLevel: profile.experienceLevel,
    ownsShares: profile.ownsShares,
    sharesCount: profile.sharesCount,
    willingToBeAssigned: profile.acceptsAssignment,
  }).filter(([, item]) => item !== undefined))
}

export function normalizeExtraction(payload, fallback = {}) {
  const raw = payload && typeof payload === 'object' ? payload : {}
  const fallbackIntent = intents.has(fallback.intent) ? fallback.intent : 'clarify'
  const modelIntent = intents.has(raw.intent) ? raw.intent : fallbackIntent
  const confidence = raw.confidence && typeof raw.confidence === 'object'
    ? Object.fromEntries(
        Object.entries(raw.confidence)
          .map(([key, value]) => [key, Math.max(0, Math.min(1, Number(value)))])
          .filter(([, value]) => Number.isFinite(value)),
      )
    : {}
  return {
    intent: modelIntent === 'clarify' && fallbackIntent !== 'clarify' ? fallbackIntent : modelIntent,
    profilePatch: mergeAgentProfile(fallback.profilePatch, raw.profilePatch),
    requestedAdjustment: normalizeAgentProfile(raw.requestedAdjustment),
    ambiguousFields: Array.isArray(raw.ambiguousFields)
      ? raw.ambiguousFields.map(String).filter(Boolean).slice(0, 8)
      : [],
    confidence,
  }
}

export function buildExtractionPrompt({ userMessage, history = [], currentProfile = {}, language = 'en' }) {
  return {
    instruction: [
      'Return JSON only with schema {intent, profilePatch, requestedAdjustment, ambiguousFields, confidence}.',
      'Intent must be clarify, recommend, explain, compare, educate, adjust, risk_check, or refuse.',
      'Extract only facts explicitly stated or clearly confirmed by the user.',
      'profilePatch may contain ticker, direction, strength, horizon, targetPrice, riskBudget, experienceLevel, ownsShares, sharesCount, acceptsAssignment, eventContext.',
      'Direction must be bullish, bearish, neutral, or volatile. Strength must be mild, moderate, or strong.',
      'Experience level must be beginner, intermediate, or advanced.',
      'Do not recommend a strategy, select contracts, or calculate financial values.',
      'Leave uncertain fields absent and list them in ambiguousFields.',
      language === 'zh' ? 'Interpret the user message in Simplified Chinese.' : 'Interpret the user message in English.',
    ].join(' '),
    userMessage,
    history: history.slice(-8),
    currentProfile: normalizeAgentProfile(currentProfile),
  }
}

const requiredByIntent = {
  recommend: ['ticker', 'direction', 'horizon', 'riskBudget', 'experienceLevel'],
  compare: ['ticker', 'direction', 'horizon', 'riskBudget', 'experienceLevel'],
  adjust: ['ticker', 'direction', 'horizon', 'riskBudget', 'experienceLevel'],
  risk_check: ['ticker', 'direction', 'horizon', 'riskBudget', 'experienceLevel'],
  explain: ['ticker'],
}

export function nextRequiredProfileField(intent, profile) {
  return (requiredByIntent[intent] ?? []).find((field) => profile[field] === undefined)
}

export function profileQuestion(field, isZh = false) {
  const questions = {
    ticker: ['您想分析哪个美股 ticker？', 'Which US ticker do you want to analyze?'],
    direction: ['您对标的更偏看多、看空、中性还是波动？', 'Is your view bullish, bearish, neutral, or volatility-focused?'],
    horizon: ['您希望分析的大致周期是多久？', 'What time horizon do you want to analyze?'],
    riskBudget: ['这笔模拟交易最多愿意亏损多少美元？', 'What is the most you are willing to lose on this paper trade?'],
    experienceLevel: ['您的期权经验是新手、进阶还是高级？', 'What is your options experience level: beginner, intermediate, or advanced?'],
  }
  return questions[field]?.[isZh ? 0 : 1]
}

export function parsedViewInput(profile, currentPrice) {
  return {
    ticker: profile.ticker,
    current_price: currentPrice,
    view: profile.direction,
    strength: profile.strength,
    time_horizon: profile.horizon,
    target_price: profile.targetPrice,
    risk_budget: profile.riskBudget,
    owns_shares: profile.ownsShares,
    shares_count: profile.sharesCount,
    willing_to_be_assigned: profile.acceptsAssignment,
    experience_level: profile.experienceLevel,
    event_context: profile.eventContext,
  }
}

export function buildExplanationPrompt({ userMessage, history, profile, plan, marketContext, language = 'en' }) {
  return {
    instruction: [
      'Return JSON only.',
      'Schema: {intent, title, answer, sections, followUpQuestion, referencedStrategyIds, warnings, dataGaps}.',
      'Explain only the deterministic candidates in agentPlan.topStrategies.',
      'referencedStrategyIds must be a subset of agentPlan.referencedStrategyIds.',
      'Copy prices, strikes, expirations, probabilities, fees, P/L and DTE exactly; never calculate or invent a number.',
      'Never add, remove, reverse, resize, or replace a strategy leg.',
      'Explain why supplied DTE and strikes fit the profile, the main trade-off, and the most important risk.',
      'Clearly distinguish expiration payoff from pre-expiration theoretical value.',
      'If dataGaps are present, state the limitation and keep the explanation conditional.',
      'Ask at most one follow-up question.',
      'Do not use Markdown, bullets, asterisks, leading colons, personalized investment advice, or guaranteed-return language.',
      language === 'zh'
        ? 'All prose must be concise Simplified Chinese except tickers, Greeks, and standard abbreviations.'
        : 'All prose must be concise English.',
    ].join(' '),
    userMessage,
    history: history.slice(-8),
    profile: normalizeAgentProfile(profile),
    agentPlan: plan,
    market: marketContext.market,
    optionChainStatus: marketContext.options?.status,
    snapshotId: marketContext.snapshotId,
    generatedAt: marketContext.generatedAt,
    dataGaps: marketContext.dataGaps ?? [],
  }
}

export function isPromptInjection(message) {
  return /ignore (?:all |the )?(?:previous|system|developer)|reveal (?:the )?(?:system|developer) prompt|show (?:your )?(?:hidden|system) instructions|忽略(?:之前|以上|系统|开发者)|显示(?:系统|隐藏)提示词|泄露(?:系统|开发者)指令/i.test(String(message))
}

function collectNumbers(value, numbers = new Set()) {
  if (typeof value === 'number' && Number.isFinite(value)) numbers.add(Number(value.toFixed(4)))
  else if (Array.isArray(value)) value.forEach((item) => collectNumbers(item, numbers))
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectNumbers(item, numbers))
  return numbers
}

function financialNumbers(text) {
  const matches = String(text).matchAll(/\$\s*([0-9][0-9,]*(?:\.\d+)?)|([0-9]+(?:\.\d+)?)\s*%|([0-9]+)\s*DTE/gi)
  return [...matches].map((match) => Number(String(match[1] ?? match[2] ?? match[3]).replaceAll(',', '')))
}

export function unknownFinancialNumbers(payload, trustedContext) {
  const allowed = collectNumbers(trustedContext)
  ;[7, 14, 30, 45, 60, 100].forEach((number) => allowed.add(number))
  const prose = [
    payload?.answer,
    payload?.followUpQuestion,
    ...(Array.isArray(payload?.sections) ? payload.sections.flatMap((section) => [section?.title, section?.body]) : []),
  ].filter(Boolean).join(' ')
  return financialNumbers(prose).filter((number) => ![...allowed].some((allowedNumber) => Math.abs(allowedNumber - number) < 0.0001))
}
