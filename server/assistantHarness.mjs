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

export function buildExtractionPrompt({ userMessage, history = [], currentProfile = {}, pendingField, language = 'en' }) {
  return {
    instruction: [
      'Return JSON only with schema {intent, profilePatch, requestedAdjustment, ambiguousFields, confidence}.',
      'Intent must be clarify, recommend, explain, compare, educate, adjust, risk_check, or refuse.',
      'Use clarify only for greetings or messages with no options task; questions about a strategy are explain, concept questions are educate.',
      'Extract only facts explicitly stated or clearly confirmed by the user in userMessage; never copy values from currentProfile.',
      'profilePatch may contain ticker, direction, strength, horizon, targetPrice, riskBudget, experienceLevel, ownsShares, sharesCount, acceptsAssignment, eventContext.',
      'Direction must be bullish, bearish, neutral, or volatile. Strength must be mild, moderate, or strong.',
      'Horizon must be one of 1 week, 2 weeks, 1 month, 2 months, 3 months, 6 months, 1 year.',
      'Experience level must be beginner, intermediate, or advanced.',
      pendingField ? `The assistant just asked the user for ${pendingField}; a bare value answers that field.` : '',
      'Do not recommend a strategy, select contracts, or calculate financial values.',
      'Leave uncertain fields absent and list them in ambiguousFields.',
      language === 'zh' ? 'Interpret the user message in Simplified Chinese.' : 'Interpret the user message in English.',
    ].filter(Boolean).join(' '),
    userMessage,
    history: history.slice(-8),
    currentProfile: normalizeAgentProfile(currentProfile),
  }
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

const modeGuides = {
  recommend: 'Summarize why the top candidate fits the stated view, horizon and budget, then contrast it in one or two sentences with the other candidates (cost, risk shape, probability). Mention assumptions the user has not confirmed.',
  compare: 'Compare the candidates on cost, max loss, max profit, probability of profit and what market path each needs. Say which profile each suits instead of declaring one the trade to make.',
  adjust: 'Explain what changed after the adjustment (horizon, budget or view) and how the candidates differ from before.',
  explain: 'Explain the focus strategy: how it makes and loses money, what the supplied strikes and expiration imply, breakeven, the main risk, and how it would typically be managed.',
  risk_check: 'Start from agentPlan.verdict, then explain where the max loss comes from and the risks that are not captured by max loss (assignment, liquidity, IV change, early exit).',
  no_fit: 'Explain that nothing fits the risk budget, name the lowest-risk candidate and its max loss from agentPlan.cheapest, and give concrete non-advisory ways to proceed (larger budget, cheaper underlying, different view or horizon).',
  education_only: 'The live option chain is unavailable. Teach the strategy types supplied, without inventing contracts or prices.',
  educate: 'Teach the concept or strategy in agentPlan.concept or agentPlan.education in plain language, then connect it to the current ticker and focus strategy when supplied.',
  chat: 'Answer the question directly using agentPlan.market and agentPlan.focus when relevant, then offer what you can do next.',
  contract_adjust: 'The user edited contracts of agentPlan.focus. State each entry of agentPlan.legChanges (strike, expiration or quantity from -> to), then compare agentPlan.before and agentPlan.after: cost, max loss, max profit, breakeven, probability of profit and net Greeks. For the trade-off, use ONLY agentPlan.changeDirections (higher/lower/unchanged) and agentPlan.before/after.maxProfitZone (price where max profit starts; null = unbounded): e.g. say max profit now needs the price at or above maxProfitZone.from. Do not claim a profit zone got wider/narrower, or that the position got more/less leveraged or sensitive, unless those facts directly say so. If agentPlan.requestedExpiration is present, say the closest listed expiration was used. If agentPlan.budgetProblem is present, state it.',
}

// Situation-specific rules are only sent when they apply; an always-present "if X" rule gets applied anyway.
function situationGuides(plan) {
  return [
    plan.forecastQuestion
      ? 'The user asked whether the price will rise or fall. State clearly that you cannot predict price direction; you may quote agentPlan.expectedMove as the market-implied range from IV (not a forecast), then ask for the user\'s own view.'
      : 'Do not talk about predicting prices unless the user asked.',
    plan.alternativesOnly ? 'The user asked for other options: present only the supplied candidates, which they have not seen yet.' : '',
    plan.offCandidates === true ? 'The named strategy does not fit the current view or live screen: explain it from agentPlan.education only, say so plainly, and never substitute another strategy.' : '',
    Array.isArray(plan.offCandidates) && plan.offCandidates.length ? 'Strategies in agentPlan.offCandidates have no live contracts for this view: describe them only from their education facts and say so.' : '',
    plan.scenario ? 'The user asked a what-if price question. Lead with agentPlan.scenario: the P/L at expiration if the stock ends at that price. It is a scenario, not a forecast and not the user\'s target.' : '',
    plan.whatIf ? 'The user asked a what-if question about price, time and/or implied volatility. Lead with agentPlan.whatIf: changeFromNow is the model change in position value from today, plVsEntry is the P/L versus the entry cost. Say it is a Black-Scholes model estimate, not a quote or a forecast. If ivAssumed is true, say the IV change size was assumed.' : '',
    plan.focus?.sensitivity ? 'Effects of IV, time and price on the position are in agentPlan.focus.sensitivity: effects says whether each move helps or hurts, and the numbers are model P/L changes from today (IV ±5 points, 7 days passing, stock ±5%). Any statement that IV, time decay or a price move helps or hurts must follow effects and cite those numbers; never infer the direction from Greeks or intuition. For a single leg, use ivDown5ByLeg (positive = that leg adds value to the position). Leg delta/theta/vega values are per long contract; a sold leg affects the position with the opposite sign, so never say a sold leg\'s theta or vega works against the position just because its raw value is negative—use netGreeks or the sensitivity numbers for the position. For other sizes of change, call the what_if tool.' : '',
  ].filter(Boolean)
}

export function buildExplanationPrompt({ userMessage, history = [], plan, language = 'en', tools = false }) {
  return {
    instruction: [
      'You are the narrator of an options research and paper-trading assistant. Return JSON only with schema {answer, followUpQuestion}.',
      `Mode ${plan.mode}: ${modeGuides[plan.mode] ?? modeGuides.chat}`,
      ...situationGuides(plan),
      'Strategy contract details (legs, max loss, max profit, breakeven, POP) are shown to the user separately as cards, so do not list legs; refer to strategies by name and quote at most the two or three numbers that matter.',
      'Never mention agentPlan field names (such as estimatedPl or maxLoss); say "estimated P/L", "max loss" in plain words. Write volatility as a percent.',
      tools
        ? 'If the user asks for something agentPlan does not contain (another strike or expiration quote, IV term structure, expected move, P/L at other prices, P/L before expiration or after an IV change, price history, Greeks), call the Qveris data tools first. Use only numbers present in agentPlan, in the user message, or returned by a tool; never calculate, round differently, or invent a price, strike, probability, P/L or date. Tools are read-only and never change the plan or the strategy.'
        : 'Use only numbers present in agentPlan; never calculate, round differently, or invent a price, strike, probability, P/L or date.',
      'probabilityOfProfitPercent is already a percent. maxLoss and maxProfit are dollars per position. netDebitCreditPerSharePerSet is per share for ONE set of the legs; with sets > 1 the position pays/receives positionNetDebitCreditTotal dollars in total. Never call the position total a per-share figure.',
      'Never tell the user to buy or sell, never promise returns. Frame everything as scenario analysis for paper trading.',
      'Mention agentPlan.dataNotes only in education_only mode or when the user asks about data quality.',
      'If agentPlan.changed is present, open by stating each change exactly as given (from -> to for an edit; for a newlySet entry just state the value the user gave, without any "from" wording); never describe a change the plan does not list.',
      'Never ask a question inside answer; any question belongs in followUpQuestion only.',
      'answer: 2 to 5 short sentences, plain text, no Markdown, no bullets. The first sentence must carry the main conclusion on its own.',
      plan.followUpText
        ? `followUpQuestion: ask essentially this, in the response language: ${plan.followUpText}`
        : plan.followUpField
        ? `followUpQuestion: ask the user one natural question to learn their ${plan.followUpField}, explaining briefly how it would refine the result.`
        : 'followUpQuestion: one short optional suggestion of what the user could ask next, or empty string.',
      language === 'zh'
        ? 'Write in concise Simplified Chinese; keep tickers, Greeks, IV, Call/Put and standard abbreviations in English, but translate every other English word (for example playbook, setup, upside, downside) into Chinese.'
        : 'Write in concise English.',
    ].join(' '),
    userMessage,
    history: history.slice(-6),
    agentPlan: plan,
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

const financialNumberPattern = new RegExp([
  /\$\s*([0-9][0-9,]*(?:\.\d+)?)/.source,
  /([0-9]+(?:\.\d+)?)\s*%/.source,
  /([0-9]+)\s*DTE/.source,
  /([0-9][0-9,]*(?:\.\d+)?)\s*(?:美元|美金|dollars?\b|usd\b)/.source,
  // Strikes and price levels written without a currency sign: "1100 Call", "行权价 1100", "breakeven 1,112.5".
  /(?<![\d-])([0-9][0-9,]*(?:\.\d+)?)\s*(?:call|put|c\b|p\b|看涨|看跌)/.source,
  /(?:行权价|执行价|盈亏平衡点?|保本点|strike|breakeven|break-even)\s*(?:price)?\s*(?:为|是|在|约|:|：|at|of|=)?\s*\$?\s*([0-9][0-9,]*(?:\.\d+)?)/.source,
  // Stock price levels in what-if prose: "涨到约 253.53", "股价在 240", "rises to 240".
  /(?:涨到|跌到|升到|回到|落到|股价(?:在|为|是|约|达到)|(?:rises?|drops?|falls?|climbs?|goes) to|stock at)\s*(?:约|大约|about|around)?\s*\$?\s*([0-9][0-9,]*(?:\.\d+)?)(?![\d.,]*\s*(?:%|％|天|日|周|个|days?|weeks?))/.source,
].join('|'), 'gi')

function financialNumbers(text) {
  return [...String(text).matchAll(financialNumberPattern)].map((match) => {
    const index = match.slice(1).findIndex((group) => group !== undefined)
    return { number: Number(String(match[index + 1]).replaceAll(',', '')), percent: index === 1 }
  })
}

const roundings = [1, 10, 100]

// The narrator may round a trusted value to 0-2 decimals (44.44 -> 44.4) and may show a fraction such as
// IV 0.4734 as a percent (47.3%); anything else is unverified.
function matchesTrusted({ number, percent }, allowed) {
  const target = Math.abs(number)
  return [...allowed].some((raw) => {
    // Losses are stored negative but written as "亏 $320"; compare magnitudes.
    const value = Math.abs(raw)
    const forms = percent && value < 5 ? [value, value * 100] : [value]
    return forms.some((form) => Math.abs(form - target) < 0.0001
      || (form >= 1 && roundings.some((scale) => Math.round(form * scale) / scale === target)))
  })
}

export function unknownFinancialNumbers(payload, trustedContext) {
  const allowed = collectNumbers(trustedContext)
  ;[7, 14, 30, 45, 60, 100].forEach((number) => allowed.add(number))
  const prose = [
    payload?.answer,
    payload?.followUpQuestion,
    ...(Array.isArray(payload?.sections) ? payload.sections.flatMap((section) => [section?.title, section?.body]) : []),
  ].filter(Boolean).join(' ')
  return financialNumbers(prose).filter((item) => !matchesTrusted(item, allowed)).map((item) => item.number)
}
