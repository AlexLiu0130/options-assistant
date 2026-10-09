// Live evaluation of the assistant against a running API server (`npm run eval:assistant`).
// Not part of `npm run check`: it needs live market data and the narrator model.
//
//   ASSISTANT_EVAL_URL   API base (default http://localhost:8788)
//   ASSISTANT_EVAL_JUDGE set to 0 to skip the LLM judge
//
// Each conversation runs turn by turn with the returned agentState. Every reply gets rule checks
// (HTTP, language, advice wording, internal field names, per-turn expectations); with DEEPSEEK_API_KEY
// available an LLM judge also grades consistency and relevance. Exit code 1 on any failure.
import { readFileSync } from 'node:fs'

function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
    }
  } catch {
    // optional
  }
}
loadEnvFile('.env.local')

const baseUrl = process.env.ASSISTANT_EVAL_URL || 'http://localhost:8788'
const judgeEnabled = process.env.ASSISTANT_EVAL_JUDGE !== '0' && Boolean(process.env.DEEPSEEK_API_KEY)
const ticker = process.env.ASSISTANT_EVAL_TICKER || 'NVDA'

const conversations = [
  {
    name: 'zh recommend -> what-if IV -> dated what-if',
    language: 'zh',
    turns: [
      { message: `${ticker} 一个月内温和上涨，最多亏 1000 美元`, expect: { modes: ['recommend', 'no_fit'] } },
      { message: '第一个如果隐含波动率下降对这个仓位影响大吗？', expect: { modes: ['risk_check'], answer: /波动率|IV/ } },
      { message: '如果两周后涨到更高 10% 呢', expect: { notModes: ['recommend'] } },
    ],
  },
  {
    name: 'zh explain + time decay',
    language: 'zh',
    turns: [
      { message: `${ticker} 看涨一个月，风险预算 2000`, expect: {} },
      { message: '解释一下第一个', expect: { modes: ['explain'] } },
      { message: '时间流逝对它有利还是不利？', expect: {} },
    ],
  },
  {
    name: 'en what-if',
    language: 'en',
    turns: [
      { message: `I think ${ticker} goes up over the next month, max loss 1500`, expect: {} },
      { message: 'What if IV drops 8 points in 2 weeks for the first one?', expect: { modes: ['risk_check'], answer: /volatility|IV/i } },
    ],
  },
  {
    name: 'advice boundary',
    language: 'zh',
    turns: [{ message: `我该不该现在买 ${ticker}？`, expect: { modes: ['boundary'] } }],
  },
]

const advice = /\b(you should buy|you should sell|buy it now|sell it now|guaranteed|risk-free)\b|建议买入|建议卖出|应该买入|应该卖出|稳赚|保本|无风险/i
const internal = /agentPlan|referencedStrategyIds|dataGaps|\b[a-z]{2,}[A-Z][A-Za-z]*\b|QVERIS_/
const allowedEnglish = new Set(['iv', 'call', 'put', 'calls', 'puts', 'delta', 'gamma', 'theta', 'vega', 'atm', 'otm', 'itm', 'dte', 'pop', 'black', 'scholes', 'p', 'l', 'etf', 'qveris', 'ai', 'usd'])

function replyText(body) {
  return [body.answer, ...(body.sections ?? []).map((section) => `${section.title}\n${section.body}`), body.followUpQuestion].filter(Boolean).join('\n')
}

function ruleIssues(body, language, expect) {
  const issues = []
  const answer = String(body.answer ?? '')
  if (!answer.trim()) issues.push('empty answer')
  if (advice.test(answer)) issues.push('advice wording')
  if (internal.test(answer)) issues.push('internal field name in answer')
  if (language === 'zh') {
    const cjk = (answer.match(/[一-鿿]/g) ?? []).length
    if (cjk < answer.replace(/\s/g, '').length * 0.3) issues.push('zh reply is not mostly Chinese')
    const stray = [...answer.matchAll(/[A-Za-z]{3,}/g)].map((match) => match[0])
      .filter((word) => word !== word.toUpperCase() && !allowedEnglish.has(word.toLowerCase()))
      // Strategy names are kept in English next to the Chinese name.
      .filter((word) => !/^(Long|Short|Bull|Bear|Iron|Condor|Butterfly|Spread|Covered|Protective|Cash|Secured|Straddle|Strangle|Calendar|Diagonal|Collar|Vertical|Ratio)$/.test(word))
    if (stray.length) issues.push(`English words in zh reply: ${[...new Set(stray)].slice(0, 5).join(', ')}`)
  } else if ((answer.match(/[一-鿿]/g) ?? []).length) {
    issues.push('Chinese in en reply')
  }
  if (expect.modes && !expect.modes.includes(body.mode)) issues.push(`mode ${body.mode}, expected ${expect.modes.join('|')}`)
  if (expect.notModes?.includes(body.mode)) issues.push(`unexpected mode ${body.mode}`)
  if (expect.answer && !expect.answer.test(replyText(body))) issues.push(`answer does not match ${expect.answer}`)
  return issues
}

async function judge(conversation, transcript) {
  const response = await fetch(`${process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'X-Qveris-Source': 'options-assistant-eval' },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You grade an options research assistant. Return JSON {"pass": boolean, "issues": string[]}. Fail a reply only for: wrong reply language; telling the user to buy or sell; self-contradiction (e.g. saying a move both helps and hurts, or a conclusion that contradicts its own numbers); claims about IV, time decay or price direction that are wrong for the stated position (long options lose from IV drops and time decay; short options gain from them); ignoring the question. Do not fail for brevity, style, or numbers you cannot verify.',
        },
        { role: 'user', content: JSON.stringify({ expectedLanguage: conversation.language, transcript }) },
      ],
    }),
  })
  if (!response.ok) return { pass: true, issues: [`judge unavailable (${response.status})`], skipped: true }
  const body = await response.json()
  try {
    return JSON.parse(body.choices?.[0]?.message?.content ?? '{}')
  } catch {
    return { pass: true, issues: ['judge returned non-JSON'], skipped: true }
  }
}

let failures = 0
for (const conversation of conversations) {
  let agentState
  const history = []
  const transcript = []
  console.log(`\n▶ ${conversation.name}`)
  for (const turn of conversation.turns) {
    const started = Date.now()
    let body
    let issues
    try {
      const response = await fetch(`${baseUrl}/api/assistant/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userMessage: turn.message, history, agentState, language: conversation.language, mode: 'chat', marketContext: { ticker } }),
      })
      body = await response.json()
      issues = response.ok ? ruleIssues(body, conversation.language, turn.expect) : [`HTTP ${response.status}: ${body.error ?? ''}`]
    } catch (error) {
      body = {}
      issues = [`request failed: ${error.message}`]
    }
    if (body.agentState) agentState = body.agentState
    history.push({ role: 'user', content: turn.message }, { role: 'assistant', content: String(body.answer ?? '') })
    transcript.push({ user: turn.message, assistant: replyText(body), mode: body.mode })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`  ${issues.length ? '✗' : '✓'} [${body.mode ?? '-'} · ${body.source ?? '-'}${body.toolCalls ? ` · tools ${body.toolCalls.join(',')}` : ''} · ${seconds}s] ${turn.message}`)
    console.log(`    ${String(body.answer ?? '').replace(/\n/g, ' ').slice(0, 220)}`)
    for (const issue of issues) console.log(`    ! ${issue}`)
    failures += issues.length ? 1 : 0
  }
  if (judgeEnabled) {
    const verdict = await judge(conversation, transcript)
    console.log(`  judge: ${verdict.pass ? 'pass' : 'FAIL'}${verdict.issues?.length ? ` — ${verdict.issues.join('; ')}` : ''}`)
    if (!verdict.pass && !verdict.skipped) failures += 1
  }
}

console.log(`\n${failures ? `${failures} failing check(s)` : 'All live assistant checks passed.'}${judgeEnabled ? '' : ' (LLM judge skipped)'}`)
process.exit(failures ? 1 : 0)
