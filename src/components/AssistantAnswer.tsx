import { useEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import type { AssistantChatResponse } from '../core/assistantPolicy'
import type { ThinkingKind } from '../core/assistantThinking'

type Lang = 'en' | 'zh'

function paragraphs(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
}

/** Breaks a long single-block answer into two-sentence paragraphs so it scans like prose, not a wall. */
function readableParagraphs(text: string) {
  return paragraphs(text).flatMap((block) => {
    if (block.length < 140) return [block]
    const sentences = block.match(/[^。！？!?]+[。！？!?]+|[^。！？!?]+$/g) ?? [block]
    const chunks: string[] = []
    for (let index = 0; index < sentences.length; index += 2) chunks.push(sentences.slice(index, index + 2).join('').trim())
    return chunks.filter(Boolean)
  })
}

export function AssistantAnswer({
  answer,
  lang,
  variant = 'chat',
  selectedStrategyId,
  onSelectStrategy,
}: {
  answer: AssistantChatResponse
  lang: Lang
  variant?: 'chat' | 'brief'
  selectedStrategyId?: string
  onSelectStrategy?: (id: string) => void
}) {
  return (
    <div className={`assistant assistant-answer assistant-answer-${variant}`}>
      {answer.title && variant === 'brief' ? <h4 className="assistant-answer-title">{answer.title}</h4> : null}
      {answer.answer ? readableParagraphs(answer.answer).map((line, index) => <p className="assistant-answer-text" key={index}>{line}</p>) : null}
      {(answer.sections ?? []).map((section) => (
        <div className="assistant-card" key={`${section.strategyId ?? ''}-${section.title}`}>
          <div className="assistant-card-head">
            <strong>{section.title}</strong>
            {section.strategyId && onSelectStrategy ? (
              <button
                type="button"
                className={section.strategyId === selectedStrategyId ? 'active' : ''}
                onClick={() => onSelectStrategy(section.strategyId!)}
              >
                {section.strategyId === selectedStrategyId
                  ? (lang === 'zh' ? '已选中' : 'Selected')
                  : (lang === 'zh' ? '在图表中查看' : 'View on chart')}
              </button>
            ) : null}
          </div>
          {paragraphs(section.body).length > 1 ? (
            <ul className="assistant-card-lines">
              {paragraphs(section.body).map((line, index) => <li key={index}>{line}</li>)}
            </ul>
          ) : <p>{section.body}</p>}
        </div>
      ))}
      {answer.followUpQuestion ? <p className="assistant-follow-up">{answer.followUpQuestion}</p> : null}
      {(answer.warnings ?? []).slice(0, 2).map((warning) => (
        <p className="assistant-warning" key={warning}>{warning}</p>
      ))}
    </div>
  )
}

type ThinkingTask = {
  title: { zh: string; en: string }
  steps: { zh: string[]; en: string[] }
}

const thinkingTasks = {
  recommend: {
    title: { zh: '正在筛选策略', en: 'Screening strategies' },
    steps: {
      zh: ['解析你的方向、期限和风险预算', '拉取实时报价与期权链', '按观点筛选候选策略', '计算最大盈亏、盈亏平衡与胜率', '按风险预算排序并说明理由'],
      en: ['Parsing your direction, horizon and risk budget', 'Pulling live quotes and the option chain', 'Screening candidates that fit your view', 'Computing max P/L, breakevens and odds', 'Ranking by risk budget and explaining why'],
    },
  },
  explain: {
    title: { zh: '正在解读策略', en: 'Explaining the strategy' },
    steps: {
      zh: ['读取当前策略的每条腿与报价', '计算最大盈亏与盈亏平衡点', '推演不同价格情景下的结果', '梳理关键风险与数据缺口', '撰写策略解释'],
      en: ['Reading each leg and its quotes', 'Computing max profit, max loss and breakevens', 'Walking through price scenarios', 'Reviewing key risks and data gaps', 'Writing the explanation'],
    },
  },
  adjust: {
    title: { zh: '正在调整合约', en: 'Adjusting contracts' },
    steps: {
      zh: ['识别要调整的腿和新参数', '在期权链里匹配新合约的报价', '重新计算盈亏、盈亏平衡与胜率', '对比调整前后的变化'],
      en: ['Identifying the leg and new terms', 'Matching the new contract on the chain', 'Re-computing P/L, breakevens and odds', 'Comparing before vs. after'],
    },
  },
  scenario: {
    title: { zh: '正在推演情景', en: 'Running scenarios' },
    steps: {
      zh: ['确定要推演的价格、时间或波动率变化', '读取当前持仓结构与 Greeks', '逐个情景估算盈亏', '汇总结果与关键拐点'],
      en: ['Pinning down the price, time or IV change', 'Reading the position and its Greeks', 'Estimating P/L for each scenario', 'Summarising results and key turning points'],
    },
  },
  compare: {
    title: { zh: '正在对比候选', en: 'Comparing candidates' },
    steps: {
      zh: ['读取各候选策略的合约与报价', '统一口径计算盈亏与胜率', '对比风险收益比与 Greeks', '归纳各自适合的情景'],
      en: ['Reading each candidate’s contracts and quotes', 'Computing P/L and odds on the same basis', 'Comparing reward-to-risk and Greeks', 'Summarising where each one fits'],
    },
  },
  risk: {
    title: { zh: '正在检查风险', en: 'Checking risk' },
    steps: {
      zh: ['读取当前策略结构与开仓成本', '核对最大亏损与你的风险预算', '检查 Theta、IV 与流动性风险', '列出需要注意的风险点'],
      en: ['Reading the structure and entry cost', 'Checking max loss against your budget', 'Checking theta, IV and liquidity risk', 'Listing what to watch'],
    },
  },
  concept: {
    title: { zh: '正在整理知识点', en: 'Looking up the concept' },
    steps: {
      zh: ['理解你问的概念', '结合当前持仓找到对应的数值', '组织通俗易懂的解释'],
      en: ['Understanding the concept you asked about', 'Finding the matching numbers in your position', 'Writing a plain-language explanation'],
    },
  },
  chat: {
    title: { zh: '正在分析', en: 'Analyzing' },
    steps: {
      zh: ['理解你的问题和当前观点', '读取实时报价与期权链', '计算相关的盈亏与风险数字', '核对数字与边界', '整理成易读的回答'],
      en: ['Understanding your question and view', 'Reading live quotes and the option chain', 'Computing the relevant P/L and risk numbers', 'Checking numbers and guardrails', 'Writing up a readable answer'],
    },
  },
} satisfies Record<ThinkingKind, ThinkingTask>

const STEP_MS = 2200
const FINISH_STEP_MS = 170
const FINISH_HOLD_MS = 320

/**
 * Animated progress for a model call. Steps advance on a timer and hold on the last one; once `done`
 * flips, the remaining steps are ticked off quickly and `onFinished` fires, so the answer never
 * appears while the checklist is still half-way.
 */
export function AssistantThinking({
  lang,
  kind = 'chat',
  done = false,
  onFinished,
}: {
  lang: Lang
  kind?: ThinkingKind
  done?: boolean
  onFinished?: () => void
}) {
  const task = thinkingTasks[kind]
  const steps = task.steps[lang]
  const [elapsed, setElapsed] = useState(0)
  const [active, setActive] = useState(0)
  const finished = useRef(onFinished)
  useEffect(() => { finished.current = onFinished }, [onFinished])

  useEffect(() => {
    if (done) return
    const started = Date.now()
    const timer = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 250)
    return () => window.clearInterval(timer)
  }, [done])

  useEffect(() => {
    if (!done) {
      const timer = window.setInterval(() => setActive((current) => Math.min(steps.length - 1, current + 1)), STEP_MS)
      return () => window.clearInterval(timer)
    }
    if (active < steps.length) {
      const timer = window.setTimeout(() => setActive((current) => current + 1), FINISH_STEP_MS)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setTimeout(() => finished.current?.(), FINISH_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [done, active, steps.length])

  const complete = active >= steps.length

  return (
    <div className={`assistant-thinking assistant-thinking-${kind}${complete ? ' complete' : ''}`} role="status" aria-live="polite">
      <div className="assistant-thinking-head">
        {complete ? <Check size={15} /> : <Loader2 size={15} className="spin" />}
        <strong>
          {complete
            ? (lang === 'zh' ? '分析完成' : 'Done')
            : `Qveris AI ${task.title[lang]}`}
        </strong>
        <span>{Math.floor(elapsed)}s</span>
      </div>
      <ol>
        {steps.map((step, index) => (
          <li key={step} className={index < active ? 'done' : index === active ? 'active' : ''}>
            <i>{index < active ? <Check size={11} /> : null}</i>
            {step}
            {index === active ? <em className="thinking-dots"><b>.</b><b>.</b><b>.</b></em> : null}
          </li>
        ))}
      </ol>
    </div>
  )
}
