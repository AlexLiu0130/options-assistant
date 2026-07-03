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

const chips = [
  ['Find strategy', 'Find the best strategy for my current view.'],
  ['Explain selected', 'Explain the selected strategy.'],
  ['Compare candidates', 'Compare the current strategy candidates.'],
  ['Risk check', 'Check whether the current strategy fits my risk budget.'],
  ['Beginner help', 'Explain this in beginner-friendly terms.'],
] as const

function renderAssistantAnswer(answer: AssistantChatResponse) {
  return [
    answer.title,
    answer.answer,
    ...(answer.sections ?? []).map((section) => `${section.title}: ${section.body}`),
    answer.followUpQuestion,
    ...(answer.warnings ?? []).slice(0, 2).map((warning) => `Warning: ${warning}`),
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
        { role: 'assistant', content: renderAssistantAnswer(answer) },
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
            {chips.map(([label, prompt]) => (
              <button key={label} type="button" onClick={() => void send(prompt)}>{label}</button>
            ))}
          </div>
          <div className="assistant-messages">
            {messages.map((message, index) => (
              <p className={message.role} key={`${message.role}-${index}`}>{message.content}</p>
            ))}
            {loading ? <p className="assistant"><Loader2 size={14} /> Thinking within Qveris limits...</p> : null}
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
              placeholder="Ask about strategy, risk, payoff, or your market view..."
            />
            <button disabled={loading || !input.trim()} type="submit"><Send size={16} /></button>
          </form>
        </section>
      ) : null}
    </>
  )
}
