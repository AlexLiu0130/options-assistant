// Offline regression for the assistant's reasoning layer: what-if repricing, directional facts, the
// directional-claim guard, scenario parsing and reply language. No network, no LLM; runs in `npm run check`.
import assert from 'node:assert/strict'
import { strategySensitivity, whatIfStrategy } from '../src/core/whatIfEngine.ts'
import {
  buildAssistantPlan,
  deterministicAnswer,
  directionalClaimIssue,
  guardAssistantText,
  hypotheticalScenario,
  parseAssistantTurn,
  replyLanguage,
  sanitizeModelPatch,
  whatIfSentence,
} from '../server/assistantAgent.mjs'
import { buildExplanationPrompt, unknownFinancialNumbers } from '../server/assistantHarness.mjs'

// Fixture chain: expirations are relative to today so the check never ages out.
const now = Date.now()
const dateIn = (days) => new Date(now + days * 86_400_000).toISOString().slice(0, 10)
const expiration = dateIn(45)
const spot = 200
const leg = (action, right, strike, premium, iv = 0.4, quantity = 1) => ({ action, right, strike, premium, quantity, expiration, impliedVolatility: iv })
const longCall = { id: 'long-call', name: 'Long Call', status: 'contract_ready', legs: [leg('buy', 'call', 200, 10.2)], maxLoss: 1020, maxProfit: 'unlimited', breakevens: [210.2] }
const shortPut = { id: 'short-put', name: 'Short Put', status: 'contract_ready', legs: [leg('sell', 'put', 190, 5.1)], maxLoss: 18490, maxProfit: 510, breakevens: [184.9] }
const bullCallSpread = { id: 'bull-call-spread', name: 'Bull Call Spread', status: 'contract_ready', legs: [leg('buy', 'call', 200, 10.2), leg('sell', 'call', 220, 3.6, 0.36)], maxLoss: 660, maxProfit: 1340, breakevens: [206.6] }
const ironCondor = {
  id: 'iron-condor',
  name: 'Iron Condor',
  status: 'contract_ready',
  legs: [leg('buy', 'put', 170, 1.4), leg('sell', 'put', 180, 2.9), leg('sell', 'call', 220, 3.6, 0.36), leg('buy', 'call', 230, 1.9, 0.35)],
  maxLoss: 680,
  maxProfit: 320,
  breakevens: [176.8, 223.2],
}

// ---------- what-if math: signs a trader would expect ----------
const callIvDown = whatIfStrategy(longCall, { spot, ivShiftPoints: -5, now })
assert.ok(callIvDown.changeFromNow < 0, 'long call loses value when IV drops')
assert.ok(whatIfStrategy(longCall, { spot, ivShiftPoints: 5, now }).changeFromNow > 0, 'long call gains when IV rises')
assert.ok(whatIfStrategy(longCall, { spot, daysForward: 14, now }).changeFromNow < 0, 'long call decays with time')
assert.ok(whatIfStrategy(longCall, { spot, price: 220, now }).changeFromNow > 0, 'long call gains when the stock rises')
assert.ok(whatIfStrategy(shortPut, { spot, ivShiftPoints: -5, now }).changeFromNow > 0, 'short put gains when IV drops')
assert.ok(whatIfStrategy(shortPut, { spot, daysForward: 14, now }).changeFromNow > 0, 'short put earns time decay')
assert.ok(whatIfStrategy(ironCondor, { spot, daysForward: 21, now }).changeFromNow > 0, 'iron condor earns time decay near the middle')

// Days forward are capped at expiration, where the value is intrinsic.
const atExpiry = whatIfStrategy(longCall, { spot, price: 215, daysForward: 400, now })
assert.equal(atExpiry.daysForward, atExpiry.daysToExpiry)
assert.ok(Math.abs(atExpiry.valueThen - 1500) < 0.01, 'expiry value equals intrinsic')
assert.ok(Math.abs(atExpiry.plVsEntry - (1500 - 1020)) < 0.01)
// The leg breakdown adds up to the position.
const spreadMove = whatIfStrategy(bullCallSpread, { spot, price: 210, daysForward: 10, ivShiftPoints: -3, now })
assert.ok(Math.abs(spreadMove.legs.reduce((sum, row) => sum + row.change, 0) - spreadMove.changeFromNow) < 0.05)
assert.ok(spreadMove.legs[1].change < 0, 'short call leg loses position value as the stock rises')
// IV never goes below the floor.
assert.ok(Number.isFinite(whatIfStrategy(longCall, { spot, ivShiftPoints: -60, now }).valueThen))
assert.equal(whatIfStrategy({ legs: [] }, { spot }), undefined)

// ---------- directional facts ----------
const callSense = strategySensitivity(longCall, spot, now)
assert.deepEqual(callSense.effects, { ivUp: 'helps', ivDown: 'hurts', timePassing: 'hurts', priceUp: 'helps', priceDown: 'hurts' })
const putSense = strategySensitivity(shortPut, spot, now)
assert.deepEqual(putSense.effects, { ivUp: 'hurts', ivDown: 'helps', timePassing: 'helps', priceUp: 'helps', priceDown: 'hurts' })
const condorSense = strategySensitivity(ironCondor, spot, now)
assert.equal(condorSense.effects.ivDown, 'helps')
assert.equal(condorSense.effects.timePassing, 'helps')
assert.equal(callSense.ivDown5ByLeg.length, 1)

// ---------- directional-claim guard ----------
const shortVol = putSense.effects
const longVol = callSense.effects
assert.match(directionalClaimIssue('隐含波动率下降时，卖出腿缩水更多，所以对仓位轻微不利。', shortVol), /IV down/)
assert.match(directionalClaimIssue('IV 下降对这个仓位有利。', longVol), /IV down/)
assert.match(directionalClaimIssue('时间流逝对你不利。', shortVol), /time passing/)
assert.match(directionalClaimIssue('If implied volatility drops, this hurts you.', shortVol), /IV down/)
assert.match(directionalClaimIssue('Theta works for you each day.', longVol), /time passing/)
assert.match(directionalClaimIssue('股价上涨对你不利。', longVol), /price up/)
assert.equal(directionalClaimIssue('IV 下降对这个仓位有利。', shortVol), undefined)
assert.equal(directionalClaimIssue('时间衰减每天都在侵蚀价值。', longVol), undefined)
assert.equal(directionalClaimIssue('IV 上升或下降都会影响仓位。', longVol), undefined)
assert.equal(directionalClaimIssue('IV 下降有利也有不利的一面。', longVol), undefined)
assert.equal(directionalClaimIssue('IV 下降对你有利。', undefined), undefined)
const guarded = guardAssistantText('这个卖 Put 主要靠时间价值赚钱。隐含波动率下降时，对仓位不利。最大亏损较大。', {
  isZh: true,
  claimIssue: (sentence) => directionalClaimIssue(sentence, shortVol),
})
assert.equal(guarded.dropped, 1)
assert.equal(guarded.firstDropped, false)
assert.doesNotMatch(guarded.answer, /不利/)
assert.match(guarded.reasons[0], /contradicts IV down/)

// ---------- scenario parsing ----------
assert.deepEqual(hypotheticalScenario('如果隐含波动率下降对这个仓位影响大吗？'), { ivShiftPoints: -5, ivAssumed: true })
assert.deepEqual(hypotheticalScenario('如果两周后涨到 240 呢'), { price: 240, daysForward: 14 })
assert.deepEqual(hypotheticalScenario('IV 降 5 个点会怎样'), { ivShiftPoints: -5, ivAssumed: false })
assert.deepEqual(hypotheticalScenario('如果 IV 升高 10%，三周后呢'), { daysForward: 21, ivShiftPoints: 10, ivAssumed: false })
assert.deepEqual(hypotheticalScenario('what if vol drops 8 points in 2 weeks'), { daysForward: 14, ivShiftPoints: -8, ivAssumed: false })
assert.deepEqual(hypotheticalScenario('如果跌到1000会亏多少'), { price: 1000 })
assert.deepEqual(hypotheticalScenario('如果两周后涨到更高 10% 呢'), { priceMovePercent: 10, daysForward: 14 })
assert.deepEqual(hypotheticalScenario('what if the stock drops 8% tomorrow'), { priceMovePercent: -8 })
assert.deepEqual(hypotheticalScenario('如果 IV 升高 10%'), { ivShiftPoints: 10, ivAssumed: false })
assert.equal(hypotheticalScenario('两周后看涨 NVDA'), undefined)
assert.equal(hypotheticalScenario('NVDA 一个月涨 10%'), undefined)
assert.equal(hypotheticalScenario('trading volume is up'), undefined)
const ivTurn = parseAssistantTurn('如果隐含波动率下降对这个仓位影响大吗？', { focusStrategyId: 'short-put' })
assert.equal(ivTurn.intent, 'explain')
const timeTurn = parseAssistantTurn('如果两周后涨到 240 呢', { focusStrategyId: 'long-call' })
assert.equal(timeTurn.patch.horizon, undefined)
assert.equal(timeTurn.patch.targetPrice, undefined)
assert.equal(timeTurn.scenario.daysForward, 14)
assert.equal(parseAssistantTurn('什么是 IV crush').intent, 'educate')
// Stating a budget is setup for a screen, not a risk check.
assert.notEqual(parseAssistantTurn('NVDA 看涨一个月，风险预算 2000').intent, 'risk_check')
assert.equal(parseAssistantTurn('这个在风险预算内吗', { focusStrategyId: 'long-call' }).intent, 'risk_check')
// The model extractor may read "两周后" as a horizon; a what-if keeps the user's horizon.
assert.equal(sanitizeModelPatch({ horizon: '2 weeks', targetPrice: 240 }, '如果两周后涨到 240 呢', timeTurn).horizon, undefined)

// ---------- plans carry what-if and sensitivity facts ----------
const profile = { ticker: 'TEST', direction: 'bullish', horizon: '1 month', riskBudget: 2000 }
const context = { market: { price: spot }, strategies: [longCall, shortPut, bullCallSpread] }
const ivPlan = buildAssistantPlan({ intent: 'explain', message: '如果隐含波动率下降对这个仓位影响大吗？', profile, context, reference: { kind: 'name', id: 'short-put' }, scenario: ivTurn.scenario, isZh: true })
assert.equal(ivPlan.mode, 'risk_check')
assert.ok(ivPlan.whatIf.changeFromNow > 0)
assert.equal(ivPlan.whatIf.ivAssumed, true)
assert.equal(ivPlan.focus.sensitivity.effects.ivDown, 'helps')
const ivText = deterministicAnswer(ivPlan, true)
assert.match(ivText, /隐含波动率下降 5 个点（假设幅度）/)
assert.match(ivText, /增加/)
assert.deepEqual(unknownFinancialNumbers({ answer: ivText }, { plan: ivPlan }), [])
const timePlan = buildAssistantPlan({ intent: 'explain', message: '如果两周后涨到 240 呢', profile, context, reference: { kind: 'name', id: 'long-call' }, scenarioPrice: 240, scenario: timeTurn.scenario, isZh: true })
assert.equal(timePlan.scenario, undefined, 'a dated what-if is not an expiration scenario')
assert.equal(timePlan.whatIf.daysForward, 14)
assert.ok(timePlan.whatIf.plVsEntry > 0)
assert.match(deterministicAnswer(timePlan, true), /14 天后、股价在 \$240/)
const moveTurn = parseAssistantTurn('如果两周后涨 10% 呢', { focusStrategyId: 'long-call' })
const movePlan = buildAssistantPlan({ intent: moveTurn.intent, message: '如果两周后涨 10% 呢', profile, context, reference: { kind: 'name', id: 'long-call' }, scenario: moveTurn.scenario, isZh: true })
assert.equal(movePlan.whatIf.price, 220)
assert.equal(movePlan.whatIf.priceMovePercent, 10)
assert.match(deterministicAnswer(movePlan, true), /股价在 \$220（上涨 10%）/)
assert.equal(ivPlan.whatIf.ivAssumed, true)
assert.equal(buildAssistantPlan({ intent: 'explain', message: 'x', profile, context, reference: { kind: 'name', id: 'long-call' }, scenario: { ivShiftPoints: -8, ivAssumed: false }, isZh: false }).whatIf.ivAssumed, false)
const priceOnly = buildAssistantPlan({ intent: 'risk_check', message: '如果跌到180会亏多少', profile, context, reference: { kind: 'name', id: 'long-call' }, scenarioPrice: 180, scenario: { price: 180 }, isZh: false })
assert.equal(priceOnly.scenario.plAtExpiration, -1020)
assert.match(deterministicAnswer(priceOnly, false), /at expiration.*Black-Scholes/s)
assert.match(whatIfSentence(longCall, whatIfStrategy(longCall, { spot, daysForward: 400, now }), false), /at expiration/)
// The narrator is told to follow the sensitivity facts and lead with the what-if.
const prompt = buildExplanationPrompt({ userMessage: '如果隐含波动率下降对这个仓位影响大吗？', plan: ivPlan, language: 'zh', tools: true }).instruction.toString()
assert.match(prompt, /agentPlan\.whatIf/)
assert.match(prompt, /sensitivity/)
assert.match(prompt, /playbook/)

// ---------- reply language ----------
assert.equal(replyLanguage('如果隐含波动率下降对这个仓位影响大吗？', [], 'en'), 'zh')
assert.equal(replyLanguage('What if IV drops 5 points?', [], 'zh'), 'en')

console.log('Assistant regression checks passed.')
