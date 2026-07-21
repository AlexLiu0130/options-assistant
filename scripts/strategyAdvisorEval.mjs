import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { classifyAssistantIntent, buildAssistantPlan, enforceAgentResponse } from '../server/assistantAgent.mjs'
import {
  isPromptInjection,
  nextRequiredProfileField,
  normalizeAgentProfile,
  normalizeExtraction,
  profileUpdatesForClient,
  resolveAssistantFactTokens,
  unknownFinancialNumbers,
} from '../server/assistantHarness.mjs'

const cases = JSON.parse(await fs.readFile(new URL('../evals/strategyAdvisorCases.json', import.meta.url), 'utf8'))

const baseView = {
  ticker: 'NVDA',
  view: 'bullish',
  time_horizon: '1 month',
  risk_budget: 500,
  experience_level: 'beginner',
}
const strategy = (id, maxLoss) => ({ id, name: id, maxLoss, maxProfit: 700, probabilityOfProfit: 45, legs: [] })
const contexts = {
  missingBudget: { parsedView: { ...baseView, risk_budget: undefined } },
  negativeBudget: { parsedView: { ...baseView, risk_budget: -10 } },
  selectedOverBudget: { parsedView: baseView, selectedStrategy: strategy('over-budget', 900), strategies: [strategy('over-budget', 900)] },
  selectedUnlimited: { parsedView: baseView, selectedStrategy: strategy('short-straddle', 'unlimited'), strategies: [strategy('short-straddle', 'unlimited')] },
  rankedCandidates: { parsedView: baseView, strategies: [strategy('defined-300', 300), strategy('over-budget', 800), strategy('defined-450', 450)] },
  noCandidateFits: { parsedView: baseView, strategies: [strategy('over-budget', 800), strategy('unlimited', 'unlimited')] },
}
const histories = {
  riskReply: [{ role: 'assistant', content: '这笔模拟交易最多愿意亏损多少美元？' }],
  ownsSharesReply: [{ role: 'assistant', content: '您是否持有该标的股票？' }],
  assignmentReply: [{ role: 'assistant', content: '您愿意被指派接股吗？' }],
}

function responseFixture(name) {
  const plan = {
    intent: 'recommend',
    referencedStrategyIds: ['defined-300'],
    structuredUpdates: {},
    dataGaps: [],
  }
  if (name === 'strategyIds') {
    return enforceAgentResponse({ answer: '仅解释已计算的候选。', referencedStrategyIds: ['invented', 'defined-300'] }, {}, plan, true)
  }
  if (name === 'bannedLanguage') {
    return enforceAgentResponse({ answer: '这个策略稳赚。' }, {}, plan, true)
  }
  if (name === 'dataGaps') {
    return enforceAgentResponse(
      { answer: '当前只能做条件说明。', dataGaps: ['MODEL_GAP: invented.'] },
      {},
      { ...plan, dataGaps: ['QVERIS_DATA_GAP: Greeks unavailable.'] },
      true,
    )
  }
  return enforceAgentResponse({ answer: '注意风险。', sections: [{ title: '**#关键风险：', body: '可能亏损。' }] }, {}, plan, true)
}

function factTokenFixture(name) {
  const plan = {
    topStrategies: [
      { id: 'strategy-a', maxLoss: 100, legs: [{ strike: 100 }] },
      { id: 'strategy-b', maxLoss: 200, legs: [{ strike: 200 }] },
    ],
  }
  if (name === 'unresolved') {
    return resolveAssistantFactTokens({ answer: '说明。', referencedStrategyIds: ['strategy-b'], sections: [{ strategyId: 'strategy-b', title: '风险', body: '{{strategy:strategy-b.notAllowed}}' }] }, plan) === null
  }
  if (name === 'crossStrategy') {
    return resolveAssistantFactTokens({ answer: '说明。', referencedStrategyIds: ['strategy-a', 'strategy-b'], sections: [{ strategyId: 'strategy-b', title: '结构', body: '策略 B {{strategy:strategy-a.leg0.strike}}' }] }, plan) === null
  }
  if (name === 'malformed') {
    return resolveAssistantFactTokens({ answer: '说明。', referencedStrategyIds: ['strategy-b'], sections: [{ strategyId: 'strategy-b', title: '结构', body: '{{ strategy:strategy-b.maxLoss }}' }] }, plan) === null
  }
  if (name === 'legacyContent') {
    return resolveAssistantFactTokens({ answer: '说明。', referencedStrategyIds: ['strategy-b'], sections: [{ strategyId: 'strategy-b', title: '结构', content: '行权价 999' }] }, plan) === null
  }
  if (name === 'forgedIdentity') {
    return resolveAssistantFactTokens({ answer: '说明。', referencedStrategyIds: ['strategy-b'], sections: [{ strategyId: 'strategy-b', title: '策略 A', body: '策略 A 的行权价是 {{strategy:strategy-b.leg0.strike}}。' }] }, plan) === null
  }
  if (name === 'relativeIdentity') {
    return resolveAssistantFactTokens({ answer: '说明。', referencedStrategyIds: ['strategy-b'], sections: [{ strategyId: 'strategy-b', title: '结构', body: '另一个策略的行权价是 {{strategy:strategy-b.leg0.strike}}。' }] }, plan) === null
  }
  if (name === 'planIdentity') {
    return resolveAssistantFactTokens({ answer: '说明。', referencedStrategyIds: ['strategy-b'], sections: [{ strategyId: 'strategy-b', title: '结构', body: '方案 A 的行权价是 {{strategy:strategy-b.leg0.strike}}。' }] }, plan) === null
  }
  return resolveAssistantFactTokens({ answer: '具体数字见下方。', referencedStrategyIds: ['strategy-b'], sections: [{ strategyId: 'strategy-b', title: '模型标题会被忽略', body: '该腿的行权价是 {{strategy:strategy-b.leg0.strike}}。' }] }, plan)
}

function evaluate(test) {
  if (test.category === 'intent') return classifyAssistantIntent(test.input)
  if (test.category === 'injection') return isPromptInjection(test.input)
  if (test.category === 'normalizeProfile') return normalizeAgentProfile(test.input)
  if (test.category === 'clientProfile') return profileUpdatesForClient(test.input)
  if (test.category === 'normalizeExtraction') return normalizeExtraction(test.input, test.fallback)
  if (test.category === 'requiredField') return nextRequiredProfileField(test.intent, test.profile) ?? null
  if (test.category === 'numberGuard') return unknownFinancialNumbers({ answer: test.input }, test.trusted)
  if (test.category === 'numberGuardPayload') return unknownFinancialNumbers(test.input)
  if (test.category === 'responseGuard') return responseFixture(test.fixture)
  if (test.category === 'factToken') return factTokenFixture(test.fixture)
  if (test.category === 'plan') return buildAssistantPlan({ userMessage: test.input, marketContext: contexts[test.fixture], isZh: true })
  if (test.category === 'historyPlan') return buildAssistantPlan({ userMessage: test.input, marketContext: { parsedView: baseView }, history: histories[test.fixture], isZh: true })
  throw new Error(`Unknown category: ${test.category}`)
}

function assertExpected(actual, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    assert.deepEqual(actual, expected)
    return
  }
  if ('intent' in expected) assert.equal(actual.intent, expected.intent)
  if ('followUpIncludes' in expected) assert.match(String(actual.directResponse?.followUpQuestion ?? actual.followUpQuestion), new RegExp(expected.followUpIncludes))
  if ('answerIncludes' in expected) assert.match(String(actual.directResponse?.answer ?? actual.answer), new RegExp(expected.answerIncludes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  if ('strategyIds' in expected) assert.deepEqual(actual.referencedStrategyIds, expected.strategyIds)
  if ('referencedStrategyIds' in expected) assert.deepEqual(actual.referencedStrategyIds, expected.referencedStrategyIds)
  if ('answerExcludes' in expected) assert.doesNotMatch(actual.answer, new RegExp(expected.answerExcludes))
  if ('warningIncludes' in expected) assert.ok(actual.warnings.some((warning) => warning.includes(expected.warningIncludes)))
  if ('sectionTitle' in expected) assert.equal(actual.sections[0]?.title, expected.sectionTitle)
  if ('sectionBodyIncludes' in expected) assert.match(actual.sections[0]?.body ?? '', new RegExp(expected.sectionBodyIncludes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  if ('structuredUpdate' in expected) assert.deepEqual(actual.structuredUpdates[expected.structuredUpdate[0]], expected.structuredUpdate[1])
  if ('dataGap' in expected) assert.ok(actual.dataGaps.includes(expected.dataGap))
  const exactKeys = ['intent', 'followUpIncludes', 'answerIncludes', 'strategyIds', 'referencedStrategyIds', 'answerExcludes', 'warningIncludes', 'sectionTitle', 'sectionBodyIncludes', 'structuredUpdate', 'dataGap']
  if (!Object.keys(expected).some((key) => exactKeys.includes(key))) assert.deepEqual(actual, expected)
}

const results = []
for (const test of cases) {
  try {
    const actual = evaluate(test)
    assertExpected(actual, test.expected)
    results.push({ id: test.id, category: test.category, passed: true })
  } catch (error) {
    results.push({ id: test.id, category: test.category, passed: false, error: error.message })
  }
}

const passed = results.filter((result) => result.passed).length
const summary = {
  total: results.length,
  passed,
  failed: results.length - passed,
  passRate: Number((passed / results.length * 100).toFixed(1)),
  byCategory: Object.fromEntries([...new Set(results.map((result) => result.category))].map((category) => {
    const rows = results.filter((result) => result.category === category)
    return [category, { total: rows.length, passed: rows.filter((row) => row.passed).length }]
  })),
  results,
}

console.log(`Strategy advisor eval: ${passed}/${results.length} passed (${summary.passRate}%).`)
for (const failure of results.filter((result) => !result.passed)) console.error(`- ${failure.id}: ${failure.error}`)
if (summary.failed && process.argv.includes('--strict')) process.exitCode = 1
