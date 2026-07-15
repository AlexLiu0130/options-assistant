import assert from 'node:assert/strict'
import { strategyExpirationPayoff } from '../src/core/payoffEngine.ts'
import { buildPaperTradeCostBreakdown, closePaperPosition, estimateIbkrUsOptionsFees, fillPaperOrder, markPaperPosition } from '../src/core/paperTradeEngine.ts'
import { selectDefaultExpiration } from '../src/core/expirationEngine.ts'
import { buildRiskChecklist } from '../src/core/riskChecklistEngine.ts'
import { buildScenarioRows } from '../src/core/scenarioEngine.ts'
import { buildSimulatorChartProjection } from '../src/core/simulatorChartEngine.ts'
import { simulateStrategy, strategyTheoreticalValue } from '../src/core/simulatorEngine.ts'
import { buildGreeksQuadChart } from '../src/core/greeksChartEngine.ts'
import { adjustStrategyLegs } from '../src/core/strategyAdjustmentEngine.ts'
import { probabilityOfProfit, recommendStrategyTypes } from '../src/core/strategyRecommendationEngine.ts'
import { optionExpirations } from '../src/core/dashboardData.ts'
import { buildAssistantPlan, enforceAgentResponse } from '../server/assistantAgent.mjs'
import type { QverisOptionContract, QverisOptionsResponse } from '../src/types/optionTypes.ts'
import type { ParsedView, StrategyCandidate, StrategyLeg } from '../src/types/strategyTypes.ts'

const call: StrategyLeg = { action: 'buy', right: 'call', strike: 100, expiration: '2026-07-17', quantity: 1, premium: 5, impliedVolatility: 0.3 }
assert.equal(strategyExpirationPayoff([call], 120), 1500)
assert.equal(strategyExpirationPayoff([call], 100), -500)

const spread: StrategyLeg[] = [
  call,
  { action: 'sell', right: 'call', strike: 110, expiration: '2026-07-17', quantity: 1, premium: 2, impliedVolatility: 0.25 },
]
assert.equal(strategyExpirationPayoff(spread, 120), 700)

const quotedSpread: StrategyLeg[] = [
  { action: 'buy', right: 'call', strike: 100, expiration: '2026-07-17', quantity: 1, premium: 1.1, bid: 1, ask: 1.2 },
  { action: 'sell', right: 'call', strike: 110, expiration: '2026-07-17', quantity: 1, premium: 0.08, bid: 0.07, ask: 0.09 },
]
const quotedCost = buildPaperTradeCostBreakdown(quotedSpread)
assert.equal(quotedCost.grossDebit, 120)
assert.equal(quotedCost.grossCredit, 7)
assert.equal(quotedCost.netPremium, 113)
assert.equal(quotedCost.fees.commission, 1.15)
assert.equal(quotedCost.fees.contractCount, 2)
assert.equal(quotedCost.openingCashImpact, 114.25)
assert.equal(quotedCost.usedMidpointFallback, false)
const pennyFee = estimateIbkrUsOptionsFees([{ ...quotedSpread[0], premium: 0.03, bid: 0.02, ask: 0.03 }])
assert.equal(pennyFee.commissionBeforeMinimum, 0.25)
assert.equal(pennyFee.commission, 1)
assert.equal(pennyFee.commissionMinimumApplied, true)
assert.ok((probabilityOfProfit([
  { action: 'buy', right: 'call', strike: 200, expiration: '2027-07-17', quantity: 1, premium: 1 },
], 100, 1, 365) ?? 0) > 0)
assert.ok((probabilityOfProfit([
  { action: 'buy', right: 'put', strike: 40, expiration: '2027-07-17', quantity: 1, premium: 1 },
], 100, 1, 365) ?? 0) > 0)

const condor: StrategyLeg[] = [
  { action: 'buy', right: 'put', strike: 90, expiration: '2026-07-17', quantity: 1, premium: 0.5 },
  { action: 'sell', right: 'put', strike: 95, expiration: '2026-07-17', quantity: 1, premium: 1.5 },
  { action: 'sell', right: 'call', strike: 105, expiration: '2026-07-17', quantity: 1, premium: 1.5 },
  { action: 'buy', right: 'call', strike: 110, expiration: '2026-07-17', quantity: 1, premium: 0.5 },
]
assert.equal(strategyExpirationPayoff(condor, 100), 200)
assert.equal(strategyExpirationPayoff(condor, 112), -300)

const view: ParsedView = {
  ticker: 'TST',
  current_price: 100,
  view: 'bullish',
  strength: 'moderate',
  time_horizon: '1 month',
  owns_shares: false,
  willing_to_be_assigned: false,
  experience_level: 'beginner',
  event_context: 'unknown',
  assumptions: [],
  missing_fields: [],
}
assert.equal(buildScenarioRows(view, spread, 103).at(1)?.estimatedPl, 0)
assert.equal(
  selectDefaultExpiration(['2026-07-10', '2026-08-07', '2026-10-16', '2027-01-16'], view, Date.UTC(2026, 6, 1)),
  '2026-08-07',
)

const strategy: StrategyCandidate = {
  id: 'check-call',
  name: 'Check Call',
  fit: 'high',
  maxLoss: 500,
  legs: [call],
  guardrails: [],
}
assert.equal(simulateStrategy(strategy, 120, 0).pl, 1500)
assert.ok(strategyTheoreticalValue([call], 110, 30) > strategyTheoreticalValue([call], 105, 30))
assert.ok(buildRiskChecklist(strategy).some((row) => row.check === 'Max loss' && row.severity === 'info'))
const greeksChart = buildGreeksQuadChart({ strategy, underlyingPrice: 110, daysLeft: 30 })
assert.deepEqual(greeksChart.panels.map((panel) => panel.metric), ['delta', 'gamma', 'theta', 'vega'])
assert.ok(greeksChart.panels.every((panel) => panel.points.length === 61))
assert.ok(greeksChart.panels.find((panel) => panel.metric === 'delta')?.currentValue)
const mixedSourceGreeks = buildGreeksQuadChart({
  strategy: { ...strategy, legs: [{ ...call, delta: 0.5 }] },
  underlyingPrice: 110,
  daysLeft: 30,
})
assert.equal(mixedSourceGreeks.marketMetrics.includes('delta'), true)
assert.notEqual(mixedSourceGreeks.panels.find((panel) => panel.metric === 'delta')?.currentValue, 50)
const syntheticLongGreeks = buildGreeksQuadChart({
  strategy: {
    ...strategy,
    id: 'check-synthetic-long',
    legs: [
      { action: 'buy', right: 'call', strike: 100, expiration: '2026-07-17', quantity: 1, premium: 5, impliedVolatility: 0.3 },
      { action: 'sell', right: 'put', strike: 100, expiration: '2026-07-17', quantity: 1, premium: 5, impliedVolatility: 0.3 },
    ],
  },
  underlyingPrice: 100,
  daysLeft: 30,
})
assert.ok(Math.abs((syntheticLongGreeks.panels.find((panel) => panel.metric === 'delta')?.currentValue ?? 0) - 100) < 0.1)
assert.ok(Math.abs(syntheticLongGreeks.panels.find((panel) => panel.metric === 'gamma')?.currentValue ?? 1) < 0.0001)
assert.ok(Math.abs(syntheticLongGreeks.panels.find((panel) => panel.metric === 'theta')?.currentValue ?? 1) < 0.0001)
assert.ok(Math.abs(syntheticLongGreeks.panels.find((panel) => panel.metric === 'vega')?.currentValue ?? 1) < 0.0001)

const dateAfter = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const chainExpiration = dateAfter(45)
const eventExpiration = dateAfter(30)
const backExpiration = dateAfter(110)
function contract(
  right: 'call' | 'put',
  strike: number,
  premium: number,
  delta: number,
  expiration = chainExpiration,
  impliedVolatility = 0.3,
): QverisOptionContract {
  return {
    symbol: `TST${expiration.replaceAll('-', '').slice(2)}${right === 'call' ? 'C' : 'P'}${strike}`,
    underlying: 'TST',
    expiration,
    strike,
    right,
    bid: premium - 0.05,
    ask: premium + 0.05,
    impliedVolatility,
    delta,
    gamma: 0.02,
    vega: 0.08,
    theta: -0.03,
    volume: 200,
    openInterest: 800,
  }
}
const optionsFixture: QverisOptionsResponse = {
  ticker: 'TST',
  status: 'available',
  contracts: [
    contract('put', 90, 1, -0.18),
    contract('put', 95, 2, -0.25),
    contract('put', 100, 3, -0.48),
    contract('put', 105, 6, -0.72),
    contract('call', 95, 6, 0.72),
    contract('call', 100, 3, 0.52),
    contract('call', 105, 2, 0.28),
    contract('call', 110, 1, 0.2),
    contract('put', 95, 4, -0.32, backExpiration),
    contract('put', 100, 5, -0.5, backExpiration),
    contract('put', 105, 7, -0.68, backExpiration),
    contract('call', 95, 7, 0.68, backExpiration),
    contract('call', 100, 5, 0.5, backExpiration),
    contract('call', 105, 4, 0.32, backExpiration),
  ],
  dataGaps: [],
}
const viewFor = (direction: ParsedView['view']): ParsedView => ({ ...view, view: direction })
const dteFixture: QverisOptionsResponse = {
  ...optionsFixture,
  contracts: [
    ...optionsFixture.contracts,
    contract('put', 100, 2.5, -0.5, eventExpiration),
    contract('call', 100, 2.5, 0.5, eventExpiration),
    contract('put', 95, 1, -0.25, eventExpiration),
    contract('call', 105, 1, 0.25, eventExpiration),
    contract('put', 90, 0.5, -0.15, eventExpiration),
    contract('put', 105, 5, -0.7, eventExpiration),
    contract('call', 95, 5, 0.7, eventExpiration),
    contract('call', 110, 0.5, 0.15, eventExpiration),
  ],
}
assert.equal(
  recommendStrategyTypes(viewFor('bullish'), dteFixture, undefined, { rank: false })
    .find((item) => item.id === 'long-call')?.legs[0]?.expiration,
  chainExpiration,
)
assert.equal(
  recommendStrategyTypes(viewFor('volatile'), dteFixture, undefined, { rank: false })
    .find((item) => item.id === 'long-straddle')?.legs[0]?.expiration,
  eventExpiration,
)
assert.deepEqual(
  recommendStrategyTypes(viewFor('bullish'), optionsFixture, chainExpiration).map((item) => item.id),
  ['bull-call-spread', 'long-call', 'cash-secured-put', 'bull-put-spread', 'long-call-butterfly'],
)
assert.deepEqual(
  recommendStrategyTypes(viewFor('bullish'), optionsFixture, chainExpiration, { rank: false }).map((item) => item.id),
  ['long-call', 'bull-call-spread', 'cash-secured-put', 'bull-put-spread', 'long-call-butterfly'],
)
const otmLongTrapFixture = {
  ...optionsFixture,
  contracts: optionsFixture.contracts.map((item) => {
    if (item.right === 'call' && item.expiration === chainExpiration && item.strike === 100) return { ...item, delta: 0.52 }
    if (item.right === 'call' && item.expiration === chainExpiration && item.strike === 105) return { ...item, delta: 0.45 }
    if (item.right === 'put' && item.expiration === chainExpiration && item.strike === 95) return { ...item, delta: -0.45 }
    if (item.right === 'put' && item.expiration === chainExpiration && item.strike === 100) return { ...item, delta: -0.52 }
    return item
  }),
}
const strongBullLongCall = recommendStrategyTypes({ ...viewFor('bullish'), strength: 'strong' }, otmLongTrapFixture, chainExpiration, { rank: false }).find(
  (item) => item.id === 'long-call',
)
const strongBearLongPut = recommendStrategyTypes({ ...viewFor('bearish'), strength: 'strong' }, otmLongTrapFixture, chainExpiration, { rank: false }).find(
  (item) => item.id === 'long-put',
)
assert.ok((strongBullLongCall?.legs[0]?.strike ?? Infinity) <= view.current_price)
assert.ok((strongBearLongPut?.legs[0]?.strike ?? 0) >= view.current_price)
const noOtmPutFixture = {
  ...optionsFixture,
  contracts: optionsFixture.contracts.map((item) =>
    item.right === 'put' ? { ...item, strike: (item.strike ?? 0) + 50, symbol: `${item.symbol}ITM` } : item,
  ),
}
assert.ok(!recommendStrategyTypes(viewFor('bullish'), noOtmPutFixture, chainExpiration, { rank: false }).some((item) => item.id === 'cash-secured-put'))
assert.ok(!recommendStrategyTypes(viewFor('bullish'), noOtmPutFixture, chainExpiration, { rank: false }).some((item) => item.id === 'bull-put-spread'))
const invalidQuoteFixture: QverisOptionsResponse = {
  ...optionsFixture,
  contracts: optionsFixture.contracts.map((item) => ({ ...item, bid: null, ask: null, last: item.last ?? 9 })),
}
assert.ok(
  recommendStrategyTypes(viewFor('bullish'), invalidQuoteFixture, chainExpiration).every(
    (item) => item.status !== 'contract_ready',
  ),
)
const farStrikeFixture = {
  ...optionsFixture,
  contracts: optionsFixture.contracts.map((item) => ({ ...item, strike: (item.strike ?? 0) + 1000, symbol: `${item.symbol}FAR` })),
}
assert.ok(recommendStrategyTypes(viewFor('bullish'), farStrikeFixture, chainExpiration, { rank: false }).every((item) => item.status !== 'contract_ready'))
const rankedBearish = recommendStrategyTypes(viewFor('bearish'), optionsFixture, chainExpiration)
assert.equal(rankedBearish[0]?.id, 'bear-put-spread')
assert.deepEqual(
  rankedBearish.map((item) => item.id).sort(),
  ['bear-put-spread', 'bear-call-spread', 'long-put', 'long-put-butterfly'].sort(),
)
assert.deepEqual(
  recommendStrategyTypes(viewFor('bearish'), optionsFixture, chainExpiration, { rank: false }).map((item) => item.id),
  ['long-put', 'bear-put-spread', 'bear-call-spread', 'long-put-butterfly'],
)
assert.ok(!recommendStrategyTypes(viewFor('bearish'), optionsFixture, chainExpiration).some((item) => item.id === 'short-call'))
assert.deepEqual(
  recommendStrategyTypes(viewFor('neutral'), optionsFixture, chainExpiration).map((item) => item.id).sort(),
  ['iron-condor', 'iron-butterfly', 'long-call-butterfly', 'long-put-butterfly', 'short-strangle', 'short-straddle'].sort(),
)
assert.deepEqual(
  recommendStrategyTypes(viewFor('neutral'), optionsFixture, chainExpiration, { rank: false }).map((item) => item.id),
  ['iron-condor', 'iron-butterfly', 'long-call-butterfly', 'long-put-butterfly', 'short-strangle', 'short-straddle'],
)
assert.deepEqual(
  recommendStrategyTypes(viewFor('volatile'), optionsFixture, chainExpiration).map((item) => item.id).sort(),
  [
    'long-straddle',
    'long-strangle',
    'call-calendar-spread',
    'put-calendar-spread',
    'call-diagonal-spread',
    'put-diagonal-spread',
  ].sort(),
)
const volatileStrangle = recommendStrategyTypes(viewFor('volatile'), optionsFixture, chainExpiration, { rank: false }).find((item) => item.id === 'long-strangle')
assert.ok(volatileStrangle?.legs.some((item) => item.right === 'call' && item.strike > view.current_price))
assert.ok(volatileStrangle?.legs.some((item) => item.right === 'put' && item.strike < view.current_price))

const budgetRanked = recommendStrategyTypes({ ...viewFor('bullish'), risk_budget: 250 }, optionsFixture, chainExpiration)
assert.equal(budgetRanked[0].id, 'bull-call-spread')
assert.ok((budgetRanked[0].rankScore ?? 0) > (budgetRanked.at(-1)?.rankScore ?? 0))
assert.ok(budgetRanked.some((item) => item.rankWarnings?.some((warning) => warning.includes('risk budget'))))
assert.ok(budgetRanked[0].rankDetails?.some((detail) => detail.category === 'risk'))
assert.ok(budgetRanked[0].playbook?.riskManagement.length)
assert.ok(budgetRanked[0].playbook?.profitManagement.some((item) => item.includes('50-75%')))
assert.ok(budgetRanked.find((item) => item.id === 'bull-put-spread')?.playbook?.profitManagement.some((item) => item.includes('40-60%')))
const adjustedSpread = adjustStrategyLegs({
  baseStrategy: budgetRanked[0],
  optionChain: optionsFixture,
  view: { ...viewFor('bullish'), risk_budget: 1000 },
  adjustments: [{ legIndex: 1, strike: 110 }],
})
assert.deepEqual(adjustedSpread.errors, [])
assert.equal(adjustedSpread.strategy?.legs[1]?.strike, 110)
assert.notEqual(adjustedSpread.strategy?.probabilityOfProfit, budgetRanked[0].probabilityOfProfit)
assert.ok(adjustedSpread.riskChecklist?.length)
assert.equal(adjustedSpread.greeksQuadChart?.panels.length, 4)
const originalLongCall = recommendStrategyTypes(viewFor('bullish'), optionsFixture, chainExpiration, { rank: false }).find((item) => item.id === 'long-call')!
const adjustedExpiry = adjustStrategyLegs({
  baseStrategy: originalLongCall,
  optionChain: optionsFixture,
  view,
  adjustments: [{ legIndex: 0, expiration: backExpiration, strike: 105 }],
})
assert.deepEqual(adjustedExpiry.errors, [])
assert.equal(adjustedExpiry.strategy?.expectedMove?.dte, Math.max(1, Math.round((new Date(`${backExpiration}T21:00:00Z`).getTime() - Date.now()) / 86_400_000)))
assert.notEqual(adjustedExpiry.strategy?.probabilityOfProfit, originalLongCall.probabilityOfProfit)
assert.ok(
  adjustStrategyLegs({
    baseStrategy: budgetRanked[0],
    optionChain: optionsFixture,
    view,
    adjustments: [{ legIndex: 0, quantity: 0 }],
  }).errors.includes('INVALID_QUANTITY:0'),
)

const highIvFixture: QverisOptionsResponse = {
  ...optionsFixture,
  contracts: optionsFixture.contracts.map((item) => ({ ...item, impliedVolatility: 0.6 })),
}
const lowIvFixture: QverisOptionsResponse = {
  ...optionsFixture,
  contracts: optionsFixture.contracts.map((item) => ({ ...item, impliedVolatility: 0.18 })),
}
const highIvBullish = recommendStrategyTypes(viewFor('bullish'), highIvFixture, chainExpiration)
const lowIvBullish = recommendStrategyTypes(viewFor('bullish'), lowIvFixture, chainExpiration)
assert.ok(
  (lowIvBullish.find((item) => item.id === 'long-call')?.rankScore ?? 0) >
    (lowIvBullish.find((item) => item.id === 'bull-put-spread')?.rankScore ?? 0),
)
assert.ok(
  (highIvBullish.find((item) => item.id === 'long-call')?.rankScore ?? 0) <
    (lowIvBullish.find((item) => item.id === 'long-call')?.rankScore ?? 0),
)
assert.ok(highIvBullish.find((item) => item.id === 'long-call')?.rankWarnings?.some((warning) => warning.includes('High IV')))

const agentClarify = buildAssistantPlan({
  userMessage: 'Find the best strategy.',
  marketContext: { parsedView: view, strategies: budgetRanked, dataGaps: [] },
})
assert.equal(agentClarify.directResponse?.intent, 'clarify')
assert.ok(agentClarify.directResponse?.followUpQuestion)

const agentRecommend = buildAssistantPlan({
  userMessage: 'Find the best strategy with $1000 risk.',
  marketContext: { parsedView: { ...view, risk_budget: 1000 }, strategies: budgetRanked, dataGaps: [] },
})
assert.equal(agentRecommend.directResponse, undefined)
assert.ok(agentRecommend.topStrategies?.length)
assert.ok(agentRecommend.topStrategies?.[0]?.rankDetails?.length)
assert.ok(agentRecommend.topStrategies?.[0]?.playbook?.entryChecklist.length)

const agentBudgetBlock = buildAssistantPlan({
  userMessage: 'Explain selected with $100 risk.',
  marketContext: {
    parsedView: { ...view, risk_budget: 100 },
    selectedStrategy: { ...budgetRanked[0], maxLoss: 500 },
    strategies: budgetRanked,
    dataGaps: [],
  },
})
assert.equal(agentBudgetBlock.directResponse?.intent, 'refuse')
assert.equal(
  buildAssistantPlan({
    userMessage: 'Explain selected with $1000 risk.',
    marketContext: {
      parsedView: { ...view, risk_budget: 1000 },
      selectedStrategy: { ...budgetRanked[0], maxLoss: 'unlimited' },
      strategies: budgetRanked,
      dataGaps: [],
    },
  }).directResponse?.intent,
  'refuse',
)
assert.equal(
  buildAssistantPlan({
    userMessage: '500',
    history: [{ role: 'assistant', content: 'What is the most you are willing to lose on this paper trade?' }],
    marketContext: { parsedView: view, strategies: budgetRanked, dataGaps: [] },
  }).structuredUpdates.riskBudget,
  500,
)
assert.equal(
  buildAssistantPlan({
    userMessage: '120',
    history: [{ role: 'assistant', content: 'What target price are you thinking near expiration?' }],
    marketContext: { parsedView: view, strategies: budgetRanked, dataGaps: [] },
  }).structuredUpdates.targetPrice,
  120,
)
assert.equal(
  buildAssistantPlan({
    userMessage: 'yes',
    history: [{ role: 'assistant', content: 'Are you willing to be assigned?' }],
    marketContext: { parsedView: view, strategies: budgetRanked, dataGaps: [] },
  }).structuredUpdates.willingToBeAssigned,
  true,
)
const invalidBudgetPlan = buildAssistantPlan({
  userMessage: 'risk $0',
  marketContext: { parsedView: view, strategies: budgetRanked, dataGaps: [] },
})
assert.equal(invalidBudgetPlan.directResponse?.intent, 'clarify')
assert.ok(!Object.hasOwn(invalidBudgetPlan.directResponse?.structuredUpdates ?? {}, 'riskBudget'))
assert.equal(
  buildAssistantPlan({
    userMessage: 'Can we move the DTE farther and choose another strike?',
    marketContext: { parsedView: { ...view, risk_budget: 1000 }, strategies: budgetRanked, dataGaps: [] },
  }).toolPlan?.[0],
  'adjust_strategy_params',
)
const guardedAgent = enforceAgentResponse(
  { intent: 'recommend', answer: 'This is guaranteed and risk-free. You should buy it.', referencedStrategyIds: [], warnings: [], dataGaps: [] },
  { parsedView: { ...view, risk_budget: 1000 } },
  {},
)
assert.ok(guardedAgent.warnings.length)
assert.ok(!/guaranteed|risk-free|should buy/i.test(guardedAgent.answer))
assert.ok(!/should buy/i.test(enforceAgentResponse(
  { intent: 'explain', answer: 'ok', sections: [{ title: 'Risk', body: 'You should buy it.' }], referencedStrategyIds: [], warnings: [], dataGaps: [] },
  {},
  {},
).sections[0].body))
assert.deepEqual(
  enforceAgentResponse(
    { intent: 'recommend', answer: 'ok', structuredUpdates: { riskBudget: 999999, direction: 'volatile' }, referencedStrategyIds: [], warnings: [], dataGaps: [] },
    {},
    { structuredUpdates: { riskBudget: 500 }, referencedStrategyIds: [] },
  ).structuredUpdates,
  { riskBudget: 500 },
)
assert.deepEqual(
  enforceAgentResponse(
    { intent: 'recommend', answer: 'ok', referencedStrategyIds: ['bad-id', 'bull-call-spread'], warnings: [], dataGaps: [] },
    {},
    { referencedStrategyIds: ['bull-call-spread'] },
  ).referencedStrategyIds,
  ['bull-call-spread'],
)

const highSpotFixture: QverisOptionsResponse = {
  ticker: 'TST',
  status: 'available',
  contracts: [
    contract('call', 95, 20, 0.8),
    contract('call', 100, 15, 0.7),
    contract('call', 105, 11, 0.62),
    contract('call', 110, 8, 0.55),
  ],
  dataGaps: [],
}
const highSpotStrategies = recommendStrategyTypes({ ...viewFor('bullish'), current_price: 112 }, highSpotFixture, chainExpiration)
assert.ok(highSpotStrategies.some((item) => item.id === 'bull-call-spread'))
assert.ok(highSpotStrategies.some((item) => item.id === 'long-call-butterfly'))

assert.deepEqual(
  optionExpirations([
    { ...contract('call', 100, 0, 0.5, '2026-07-15'), bid: null, ask: null },
    contract('call', 100, 3, 0.5, '2026-07-31'),
  ]),
  ['2026-07-31'],
)

const badQuoteFixture: QverisOptionsResponse = {
  ticker: 'TST',
  status: 'available',
  contracts: [{ ...contract('call', 100, 0, 0.52), bid: 0, ask: 0, last: null }],
  dataGaps: [],
}
assert.ok(recommendStrategyTypes(viewFor('bullish'), badQuoteFixture, chainExpiration).every((item) => item.status === 'needs_option_chain'))

const badDebitFixture: QverisOptionsResponse = {
  ticker: 'TST',
  status: 'available',
  contracts: [
    contract('call', 100, 1, 0.52),
    contract('call', 105, 2, 0.28),
  ],
  dataGaps: [],
}
assert.ok(!recommendStrategyTypes(viewFor('bullish'), badDebitFixture, chainExpiration).some((item) => item.id === 'bull-call-spread'))

const brokenWingFixture: QverisOptionsResponse = {
  ticker: 'TST',
  status: 'available',
  contracts: [
    contract('call', 90, 12, 0.72),
    contract('call', 100, 6, 0.52),
    contract('call', 115, 1, 0.18),
  ],
  dataGaps: [],
}
assert.ok(!recommendStrategyTypes(viewFor('bullish'), brokenWingFixture, chainExpiration).some((item) => item.id === 'long-call-butterfly'))

const callProjection = buildSimulatorChartProjection({
  strategy,
  underlyingPrice: 120,
  daysLeft: 0,
  minPrice: 90,
  maxPrice: 120,
  samples: 7,
})
assert.equal(callProjection.point.estimatedPnL, 1500)
assert.ok(callProjection.zones.some((zone) => zone.status === 'loss'))
assert.ok(callProjection.zones.some((zone) => zone.status === 'profit'))

const condorProjection = buildSimulatorChartProjection({
  strategy: { id: 'check-condor', name: 'Check Condor', fit: 'high', legs: condor, guardrails: [] },
  underlyingPrice: 100,
  daysLeft: 0,
  minPrice: 88,
  maxPrice: 112,
  samples: 13,
})
assert.equal(condorProjection.point.estimatedPnL, 200)
assert.ok(condorProjection.zones.at(0)?.status === 'loss')
assert.ok(condorProjection.zones.some((zone) => zone.status === 'profit'))

const openTime = Date.UTC(2026, 6, 1, 14)
const paper = fillPaperOrder({
  userId: 'dev-user',
  accountId: 'paper-account',
  ticker: 'TST',
  strategy,
  underlyingPrice: 100,
  now: openTime,
})
assert.equal(paper.order.status, 'filled')
assert.ok(paper.position)
assert.equal(paper.position.entrySnapshot.strategyValue, 500)
assert.equal(paper.position.entrySnapshot.valueMethod, 'quoted_mid')
assert.ok(paper.position.entrySnapshot.fees?.total)

const marked = markPaperPosition(paper.position, 120, Date.UTC(2026, 6, 2, 14))
assert.ok(marked.unrealizedPnL > 0)

const closed = closePaperPosition(paper.position, 120, Date.UTC(2026, 6, 2, 14))
assert.equal(closed.position.status, 'closed')
assert.equal(closed.realizedPnL, Number((marked.unrealizedPnL - (closed.closeSnapshot.fees?.total ?? 0)).toFixed(2)))
assert.ok((closed.closeSnapshot.fees?.thirdParty ?? 0) > (paper.position.entrySnapshot.fees?.thirdParty ?? 0))

console.log('engine self-check passed')
