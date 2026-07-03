const intents = ['clarify', 'recommend', 'explain', 'compare', 'educate', 'adjust', 'risk_check', 'refuse']

function firstNumber(text) {
  const match = String(text).match(/([0-9][0-9,]*(?:\.\d+)?)/)
  return match ? Number(match[1].replaceAll(',', '')) : undefined
}

function money(text, history = []) {
  const value = String(text)
  const match = value.match(/(?:\$|risk|budget|亏损|风险|承受|预算|最多亏|maximum loss)\s*([0-9][0-9,]*(?:\.\d+)?)/i)
  if (match) return Number(match[1].replaceAll(',', ''))
  const previous = history.at(-1)?.content ?? ''
  if (/maximum acceptable loss|most you are willing to lose|最大可承受亏损|最多愿意亏损/.test(previous)) return firstNumber(value)
  return undefined
}

function yesNo(text) {
  const lower = String(text).toLowerCase().trim()
  if (/^(yes|y|ok|sure|可以|是|愿意|有)$/.test(lower)) return true
  if (/^(no|n|nope|不|不是|没有|不愿意)$/.test(lower)) return false
  return undefined
}

function targetPrice(text, history = []) {
  const value = String(text)
  const match = value.match(/(?:target|目标|涨到|跌到|到)\s*\$?\s*([0-9][0-9,]*(?:\.\d+)?)/i)
  if (match) return Number(match[1].replaceAll(',', ''))
  const previous = history.at(-1)?.content ?? ''
  if (/target price|目标价|到期附近/.test(previous)) return firstNumber(value)
  return undefined
}

function direction(text) {
  const lower = String(text).toLowerCase()
  if (/bull|看多|看涨|上涨|涨/.test(lower)) return 'bullish'
  if (/bear|看空|看跌|下跌|跌/.test(lower)) return 'bearish'
  if (/neutral|range|震荡|中性|横盘/.test(lower)) return 'neutral'
  if (/volatile|volatility|波动|大幅/.test(lower)) return 'volatile'
  return undefined
}

function strength(text) {
  const lower = String(text).toLowerCase()
  if (/mild|slight|小幅|轻微/.test(lower)) return 'mild'
  if (/strong|aggressive|大幅|强/.test(lower)) return 'strong'
  if (/moderate|中等|适中|温和/.test(lower)) return 'moderate'
  return undefined
}

function experienceLevel(text) {
  const lower = String(text).toLowerCase()
  if (/beginner|newbie|新手|入门/.test(lower)) return 'beginner'
  if (/advanced|professional|高级|熟练/.test(lower)) return 'advanced'
  if (/intermediate|进阶|中级/.test(lower)) return 'intermediate'
  return undefined
}

function booleanSlot(text, yesPattern, noPattern) {
  const lower = String(text).toLowerCase()
  if (noPattern.test(lower)) return false
  if (yesPattern.test(lower)) return true
  return undefined
}

function horizon(text) {
  const value = String(text)
  if (/半年|6\s*months?/i.test(value)) return '6 months'
  if (/三个月|3\s*months?/i.test(value)) return '3 months'
  if (/一个月|1\s*month|month/i.test(value)) return '1 month'
  if (/一周|1\s*week|week/i.test(value)) return '1 week'
  return undefined
}

function ticker(text) {
  const match = String(text).match(/\b[A-Z]{1,5}\b/)
  const token = match?.[0]
  return token && !['CALL', 'PUT', 'DTE', 'IV', 'POP'].includes(token) ? token : undefined
}

function classifyIntent(message) {
  const text = String(message).toLowerCase()
  if (/dte|strike|adjust|change|move|拉长|缩短|行权价|调整|换成/.test(text)) return 'adjust'
  if (/risk check|风险检查|风险预算|超预算/.test(text)) return 'risk_check'
  if (/compare|对比|区别/.test(text)) return 'compare'
  if (/explain|why|解释|为什么|怎么/.test(text)) return 'explain'
  if (/recommend|find|best|strategy|推荐|适合|策略/.test(text)) return 'recommend'
  if (/what is|learn|beginner|新手|什么是|学习/.test(text)) return 'educate'
  return 'clarify'
}

const toolByIntent = {
  clarify: 'collect_profile',
  recommend: 'recommend_strategies',
  explain: 'explain_strategy',
  compare: 'compare_strategies',
  educate: 'educate_concept',
  refuse: 'refuse_out_of_scope',
  adjust: 'adjust_strategy_params',
  risk_check: 'risk_check',
}

function finiteMaxLoss(strategy) {
  return typeof strategy?.maxLoss === 'number' && Number.isFinite(strategy.maxLoss) ? strategy.maxLoss : undefined
}

function invalidRiskBudget(riskBudget, isZh) {
  return riskBudget !== undefined && (!Number.isFinite(Number(riskBudget)) || Number(riskBudget) <= 0)
    ? text(isZh, '风险预算必须是大于 0 的数字。', 'Risk budget must be a number greater than 0.')
    : undefined
}

function riskProblem(strategy, riskBudget, isZh) {
  if (!strategy || riskBudget === undefined) return undefined
  const invalid = invalidRiskBudget(riskBudget, isZh)
  if (invalid) return invalid
  if (strategy.maxLoss === 'unlimited') {
    return text(isZh, `${strategy.name} 最大亏损无限，不满足固定风险预算。`, `${strategy.name} has uncapped maximum loss and does not fit a fixed risk budget.`)
  }
  if (strategy.maxLoss === 'variable') {
    return text(isZh, `${strategy.name} 最大亏损可变，需要人工复核后才能匹配固定风险预算。`, `${strategy.name} has variable maximum loss and needs manual review before it can fit a fixed risk budget.`)
  }
  const loss = finiteMaxLoss(strategy)
  if (loss !== undefined && loss > riskBudget) {
    return text(
      isZh,
      `${strategy.name} 不满足当前 $${riskBudget.toFixed(2)} 风险预算，最大亏损为 $${loss.toFixed(2)}。`,
      `${strategy.name} does not fit the current $${riskBudget.toFixed(2)} risk budget because max loss is $${loss.toFixed(2)}.`,
    )
  }
  return undefined
}

function response({ intent, title, answer, sections = [], followUpQuestion, structuredUpdates = {}, referencedStrategyIds = [], warnings = [], dataGaps = [] }) {
  return { intent, title, answer, sections, followUpQuestion, structuredUpdates, referencedStrategyIds, warnings, dataGaps }
}

function text(isZh, zh, en) {
  return isZh ? zh : en
}

function profileState(parsedView, structuredUpdates) {
  const profile = {
    ticker: structuredUpdates.ticker ?? parsedView.ticker,
    direction: structuredUpdates.direction ?? parsedView.view,
    strength: structuredUpdates.strength ?? parsedView.strength,
    horizon: structuredUpdates.horizon ?? parsedView.time_horizon,
    riskBudget: structuredUpdates.riskBudget ?? parsedView.risk_budget,
    targetPrice: structuredUpdates.targetPrice ?? parsedView.target_price,
    ownsShares: structuredUpdates.ownsShares ?? parsedView.owns_shares,
    sharesCount: structuredUpdates.sharesCount ?? parsedView.shares_count,
    willingToBeAssigned: structuredUpdates.willingToBeAssigned ?? parsedView.willing_to_be_assigned,
    experienceLevel: structuredUpdates.experienceLevel ?? parsedView.experience_level,
  }
  const missing = []
  if (!profile.ticker) missing.push('ticker')
  if (!profile.direction) missing.push('direction')
  if (!profile.horizon) missing.push('horizon')
  if (!profile.riskBudget) missing.push('riskBudget')
  if (!profile.targetPrice) missing.push('targetPrice')
  if (!profile.experienceLevel) missing.push('experienceLevel')
  return { profile, missing }
}

function slotQuestion(slot, isZh) {
  const questions = {
    ticker: text(isZh, '您想分析哪个美股 ticker？', 'Which US ticker do you want to analyze?'),
    direction: text(isZh, '您对标的接下来更偏看多、看空、中性还是波动？', 'Is your view bullish, bearish, neutral, or volatility-focused?'),
    horizon: text(isZh, '您想看的周期大概是多久？', 'What time horizon do you want to analyze?'),
    riskBudget: text(isZh, '这笔模拟交易最多愿意亏损多少美元？', 'What is the most you are willing to lose on this paper trade?'),
    targetPrice: text(isZh, '如果有目标价，您预期到期附近大概到哪里？', 'If you have one, what target price are you thinking near expiration?'),
    experienceLevel: text(isZh, '您的期权经验是新手、进阶还是高级？', 'What is your options experience level: beginner, intermediate, or advanced?'),
  }
  return questions[slot]
}

export function buildAssistantPlan({ userMessage, marketContext = {}, history = [], isZh = false }) {
  const parsedView = marketContext.parsedView ?? {}
  const strategies = Array.isArray(marketContext.strategies) ? marketContext.strategies : []
  const selected = marketContext.selectedStrategy
  const riskBudget = money(userMessage, history) ?? parsedView.risk_budget
  const structuredUpdates = {
    ticker: ticker(userMessage),
    direction: direction(userMessage),
    strength: strength(userMessage),
    horizon: horizon(userMessage),
    riskBudget: money(userMessage, history),
    targetPrice: targetPrice(userMessage, history),
    ownsShares: booleanSlot(userMessage, /own|hold|持有|有.*股/, /no shares|没有.*股|不持有/),
    willingToBeAssigned: booleanSlot(userMessage, /assigned|接股|愿意被指派/, /not.*assigned|不愿意.*指派|不接股/),
    experienceLevel: experienceLevel(userMessage),
  }
  const priorQuestion = history.at(-1)?.content ?? ''
  const replyBool = yesNo(userMessage)
  if (structuredUpdates.ownsShares === undefined && /own shares|持有.*股|是否持股/.test(priorQuestion) && replyBool !== undefined) {
    structuredUpdates.ownsShares = replyBool
  }
  if (structuredUpdates.willingToBeAssigned === undefined && /assigned|assignment|接股|指派/.test(priorQuestion) && replyBool !== undefined) {
    structuredUpdates.willingToBeAssigned = replyBool
  }
  Object.keys(structuredUpdates).forEach((key) => structuredUpdates[key] === undefined && delete structuredUpdates[key])

  const intent = classifyIntent(userMessage)
  const state = profileState(parsedView, structuredUpdates)
  const dataGaps = [
    ...(Array.isArray(marketContext.dataGaps) ? marketContext.dataGaps : []),
    ...(Array.isArray(marketContext.options?.dataGaps) ? marketContext.options.dataGaps : []),
  ].map(String)

  const invalidBudget = invalidRiskBudget(riskBudget, isZh)
  if (invalidBudget) {
    const cleanUpdates = { ...structuredUpdates }
    delete cleanUpdates.riskBudget
    return {
      intent: 'clarify',
      structuredUpdates: cleanUpdates,
      agentState: state,
      toolPlan: ['collect_profile'],
      dataGaps,
      directResponse: response({
        intent: 'clarify',
        answer: invalidBudget,
        followUpQuestion: slotQuestion('riskBudget', isZh),
        structuredUpdates: cleanUpdates,
        warnings: [invalidBudget],
        dataGaps,
      }),
    }
  }

  const needsProfile = ['recommend', 'compare', 'adjust', 'risk_check'].includes(intent)
  const nextMissing = state.missing.find((slot) => slot !== 'targetPrice') ?? state.missing[0]
  if (needsProfile && nextMissing === 'riskBudget') {
    return {
      intent: 'clarify',
      structuredUpdates,
      agentState: state,
      toolPlan: ['collect_profile'],
      dataGaps,
      directResponse: response({
        intent: 'clarify',
        answer: text(isZh, '我需要先知道您的最大可承受亏损，才能筛掉不适合的策略。', 'I need your maximum acceptable loss first so I can filter out unsuitable strategies.'),
        followUpQuestion: text(isZh, '这笔模拟交易最多愿意亏损多少美元？', 'What is the most you are willing to lose on this paper trade?'),
        structuredUpdates,
        dataGaps,
      }),
    }
  }

  const selectedRiskProblem = riskProblem(selected, riskBudget, isZh)
  if (selectedRiskProblem) {
    return {
      intent: 'refuse',
      structuredUpdates,
      agentState: state,
      toolPlan: ['risk_check'],
      dataGaps,
      directResponse: response({
        intent: 'refuse',
        answer: selectedRiskProblem,
        structuredUpdates,
        referencedStrategyIds: [selected.id].filter(Boolean),
        warnings: [selectedRiskProblem],
        dataGaps,
      }),
    }
  }

  const eligible = riskBudget
    ? strategies.filter((strategy) => {
        const loss = finiteMaxLoss(strategy)
        return loss !== undefined && loss <= riskBudget
      })
    : strategies
  const topStrategies = eligible.slice(0, 3)

  if ((intent === 'recommend' || intent === 'compare') && !topStrategies.length) {
    return {
      intent: 'clarify',
      structuredUpdates,
      agentState: state,
      toolPlan: ['recommend_strategies', 'risk_check'],
      dataGaps,
      directResponse: response({
        intent: 'clarify',
        answer: text(isZh, '当前候选策略里没有满足风险预算和数据边界的方案。', 'No current candidate fits the risk budget and data constraints.'),
        followUpQuestion: text(isZh, '是否要调整方向、周期或风险预算后重新筛选？', 'Would you like to adjust the view, horizon, or risk budget and screen again?'),
        structuredUpdates,
        dataGaps,
      }),
    }
  }

  return {
    intent,
    structuredUpdates,
    agentState: state,
    toolPlan: [toolByIntent[intent] ?? 'collect_profile'],
    followUpSlot: nextMissing,
    followUpQuestion: nextMissing ? slotQuestion(nextMissing, isZh) : undefined,
    dataGaps,
    topStrategies: topStrategies.map((strategy) => ({
      id: strategy.id,
      name: strategy.name,
      maxLoss: strategy.maxLoss,
      maxProfit: strategy.maxProfit,
      probabilityOfProfit: strategy.probabilityOfProfit,
      rankReasons: strategy.rankReasons,
      rankWarnings: strategy.rankWarnings,
      rankDetails: strategy.rankDetails,
      playbook: strategy.playbook,
      riskBudgetWarning: strategy.riskBudgetWarning,
      legs: strategy.legs,
      expectedMove: strategy.expectedMove,
      breakevens: strategy.breakevens ?? (strategy.breakeven ? [strategy.breakeven] : []),
    })),
    referencedStrategyIds: topStrategies.map((strategy) => strategy.id),
  }
}

export function agentFallbackResponse(plan, isZh = false) {
  if (plan?.directResponse) return plan.directResponse
  const first = plan?.topStrategies?.[0]
  const answer = first
    ? text(isZh, `当前更适合先看 ${first.name}，但我只能基于 Qveris 引擎结果做解释。`, `Start with ${first.name}; I can only explain Qveris engine results.`)
    : text(isZh, '我可以协助期权策略、风险、收益及市场观点问题，请在此范围内提问。', 'I can help with options strategy, risk, payoff, and market-view questions.')
  return response({
    intent: plan?.intent ?? 'clarify',
    title: text(isZh, 'Qveris AI 简报', 'Qveris AI Brief'),
    answer,
    sections: [{ title: text(isZh, '说明', 'Note'), body: answer }],
    followUpQuestion: plan?.followUpQuestion,
    structuredUpdates: plan?.structuredUpdates ?? {},
    referencedStrategyIds: plan?.referencedStrategyIds ?? [],
    warnings: ['Qveris AI fallback response; no model-generated JSON was accepted.'],
    dataGaps: plan?.dataGaps ?? [],
  })
}

export function enforceAgentResponse(payload, marketContext = {}, plan = {}, isZh = false) {
  const warnings = Array.isArray(payload?.warnings) ? payload.warnings.map(String) : []
  const guarded = guardAssistantText(payload?.answer || agentFallbackResponse(plan, isZh).answer, { marketContext, plan, isZh })
  warnings.unshift(...guarded.warnings)
  const sections = normalizeSections(payload?.sections, { marketContext, plan, isZh })
  const allowedIds = new Set(plan.referencedStrategyIds ?? [])
  const modelIds = Array.isArray(payload?.referencedStrategyIds) ? payload.referencedStrategyIds.map(String) : []
  const referencedStrategyIds = modelIds.filter((id) => allowedIds.has(id))
  return {
    intent: intents.includes(payload?.intent) ? payload.intent : plan.intent ?? 'clarify',
    title: typeof payload?.title === 'string' ? payload.title : undefined,
    answer: warnings.length ? `${warnings[0]}\n\n${guarded.answer}` : guarded.answer,
    sections,
    followUpQuestion: payload?.followUpQuestion ? String(payload.followUpQuestion) : plan.followUpQuestion,
    structuredUpdates: plan.structuredUpdates ?? {},
    referencedStrategyIds: referencedStrategyIds.length ? referencedStrategyIds : plan.referencedStrategyIds ?? [],
    warnings,
    dataGaps: [...new Set([...(plan.dataGaps ?? []), ...(guarded.dataGaps ?? []), ...(Array.isArray(payload?.dataGaps) ? payload.dataGaps.map(String) : [])])],
  }
}

function normalizeSections(value, guardContext) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 6).map((section) => {
    const title = String(section?.title ?? '').replace(/[*#:：]+/g, '').trim()
    const guarded = guardAssistantText(section?.body ?? section?.content ?? '', guardContext)
    return { title, body: guarded.answer }
  }).filter((section) => section.title && section.body)
}

export function guardAssistantText(rawAnswer, { marketContext = {}, plan = {}, isZh = false } = {}) {
  const warnings = []
  const selected = marketContext.selectedStrategy
  const riskBudget = plan.agentState?.profile?.riskBudget ?? marketContext.parsedView?.risk_budget
  const warning = riskProblem(selected, riskBudget, isZh)
  if (warning) warnings.unshift(warning)
  const banned = /\b(guaranteed|risk-free|safe|buy it|sell it|enter this trade|exit this trade|must buy|must sell|should buy|should sell)\b|稳赚|保本|无风险|必须买|必须卖|建议买入|建议卖出|应该买入|应该卖出/gi
  let answer = String(rawAnswer || agentFallbackResponse(plan, isZh).answer)
  if (answer.match(banned)) {
    warnings.unshift(text(isZh, '已移除不合规表述；以下内容仅用于期权研究和模拟交易教育。', 'Non-compliant wording was removed; this is for options research and paper-trade education only.'))
    answer = answer.replace(banned, text(isZh, '仅供研究', 'research-only'))
  }
  return { answer, warnings, dataGaps: plan.dataGaps ?? [] }
}
