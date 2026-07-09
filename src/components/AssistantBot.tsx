import { useState } from 'react'
import { Bot, Loader2, Send, X } from 'lucide-react'
import {
  buildAssistantContext,
  fallbackAssistantResponse,
  normalizeAssistantUpdates,
  type AssistantChatResponse,
  type AssistantStructuredUpdates,
} from '../core/assistantPolicy'
import { useT } from '../i18n'
import type { QverisMarketSnapshot, QverisOptionsResponse } from '../types/optionTypes'
import type { ParsedView, StrategyCandidate } from '../types/strategyTypes'

type Message = {
  role: 'user' | 'assistant'
  content: string
}

const chips = {
  en: [
    ['Find strategy', 'Find the best strategy for my current view.'],
    ['Explain selected', 'Explain the selected strategy.'],
    ['Compare', 'Compare the current strategy candidates.'],
    ['Risk check', 'Check whether the current strategy fits my risk budget.'],
    ['Beginner help', 'Explain this in beginner-friendly terms.'],
  ],
  zh: [
    ['找策略', '根据我当前观点找合适的策略。'],
    ['解释当前策略', '解释当前选中的策略。'],
    ['对比候选', '对比当前几个候选策略。'],
    ['检查风险', '检查当前策略是否符合我的风险预算。'],
    ['新手解释', '用新手能理解的方式解释。'],
  ],
} as const

function renderAssistantAnswer(answer: AssistantChatResponse, lang: 'en' | 'zh') {
  return [
    answer.title,
    answer.answer,
    ...(answer.sections ?? []).map((section) => `${section.title}\n${section.body}`),
    answer.followUpQuestion,
    ...(answer.warnings ?? []).slice(0, 2).map((warning) => `${lang === 'zh' ? '风险提示' : 'Warning'}\n${warning}`),
  ].filter(Boolean).join('\n\n')
}

export function AssistantBot({
  ticker,
  parsedView,
  market,
  options,
  selectedStrategy,
  strategies,
  onStructuredUpdates,
}: {
  ticker: string
  parsedView: ParsedView
  market?: QverisMarketSnapshot
  options?: QverisOptionsResponse
  selectedStrategy?: StrategyCandidate
  strategies: StrategyCandidate[]
  onStructuredUpdates?: (updates: AssistantStructuredUpdates) => void
}) {
  const { lang } = useT()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: lang === 'zh'
        ? '请告诉我您的市场观点、时间周期和最大可承受亏损。我将在 Qveris 策略和风险规则范围内为您提供建议。'
        : 'Tell me your market view, time horizon, and maximum loss. I will stay within Qveris strategy and risk limits.',
    },
  ])

  async function send(text = input) {
    const userMessage = text.trim()
    if (!userMessage || loading) return
    setInput('')
    setMessages((current) => [...current, { role: 'user', content: userMessage }])
    setLoading(true)
    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userMessage,
          history: messages.slice(-8),
          language: lang,
          mode: 'chat',
          marketContext: buildAssistantContext({
            ticker,
            parsedView,
            market,
            options,
            selectedStrategy,
            strategies,
          }),
        }),
      })
      const body = await response.json()
      const answer = (response.ok ? body : fallbackAssistantResponse(body.error || 'Qveris AI is unavailable.')) as AssistantChatResponse
      const updates = normalizeAssistantUpdates(answer.structuredUpdates)
      if (Object.keys(updates).length) onStructuredUpdates?.(updates)
      setMessages((current) => [
        ...current,
        { role: 'assistant', content: renderAssistantAnswer(answer, lang) },
      ])
    } catch (error) {
      const answer = fallbackAssistantResponse(error instanceof Error ? error.message : 'Qveris AI is unavailable.')
      setMessages((current) => [...current, { role: 'assistant', content: answer.answer }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button className="assistant-fab" type="button" onClick={() => setOpen(true)} aria-label="Open Qveris AI">
        <Bot size={22} />
        <span>Qveris AI</span>
      </button>
      {open ? (
        <section className="assistant-drawer" aria-label="Qveris AI assistant">
          <header>
            <div>
              <strong>Qveris AI</strong>
              <span>{ticker} · {parsedView.view} · {parsedView.time_horizon} · Risk {parsedView.risk_budget ? `$${parsedView.risk_budget}` : 'pending'}</span>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close Qveris AI"><X size={17} /></button>
          </header>
          <div className="assistant-chip-row">
            {chips[lang].map(([label, prompt]) => (
              <button key={label} type="button" onClick={() => void send(prompt)}>{label}</button>
            ))}
          </div>
          <div className="assistant-messages">
            {messages.map((message, index) => (
              <p className={message.role} key={`${message.role}-${index}`}>{message.content}</p>
            ))}
            {loading ? <p className="assistant"><Loader2 size={14} /> {lang === 'zh' ? '正在按 Qveris 边界分析…' : 'Thinking within Qveris limits...'}</p> : null}
          </div>
          <form
            className="assistant-input"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={lang === 'zh' ? '询问策略、风险、盈亏，或补充你的观点…' : 'Ask about strategy, risk, payoff, or your market view...'}
            />
            <button disabled={loading || !input.trim()} type="submit"><Send size={16} /></button>
          </form>
        </section>
      ) : null}
    </>
  )
}
