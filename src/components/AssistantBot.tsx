import { useEffect, useRef, useState } from 'react'
import { Send, X } from 'lucide-react'
import {
  buildAssistantContext,
  fallbackAssistantResponse,
  normalizeAssistantUpdates,
  type AssistantAgentState,
  type AssistantChatResponse,
  type AssistantContractAdjustment,
  type AssistantStructuredUpdates,
} from '../core/assistantPolicy'
import { recordProductEvent } from '../core/productEventsApi'
import { useT } from '../i18n'
import { thinkingKindFor, type ThinkingKind } from '../core/assistantThinking'
import { AssistantAnswer, AssistantThinking } from './AssistantAnswer'
import type { QverisMarketSnapshot, QverisOptionsResponse } from '../types/optionTypes'
import type { ParsedView, StrategyCandidate } from '../types/strategyTypes'

type Message = {
  role: 'user' | 'assistant'
  /** Plain text kept for conversation history sent back to the server. */
  content: string
  response?: AssistantChatResponse
}

const chips = {
  en: [
    ['Find strategy', 'Recommend strategies for my current view.'],
    ['Explain selected', 'Explain the selected strategy.'],
    ['Compare', 'Compare the current strategy candidates.'],
    ['Risk check', 'Check whether the selected strategy fits my risk budget.'],
    ['What is theta?', 'What is theta and how does it affect my position?'],
  ],
  zh: [
    ['找策略', '根据我当前观点推荐合适的策略。'],
    ['解释当前策略', '解释当前选中的策略。'],
    ['对比候选', '对比一下当前几个候选策略。'],
    ['检查风险', '检查当前策略是否符合我的风险预算。'],
    ['什么是 Theta', '什么是 Theta，它对我的持仓有什么影响？'],
  ],
} as const

function intro(lang: 'en' | 'zh') {
  return lang === 'zh'
    ? '你好，我是 Qveris AI。告诉我你对标的的看法，比如「MU 一个月内小幅上涨，最多亏 1000 美元」，我会基于实时期权链筛选策略并解释盈亏和风险；也可以直接问期权概念。'
    : 'Hi, I am Qveris AI. Tell me your view, e.g. "MU up modestly within a month, max loss $1,000", and I will screen strategies on the live chain and explain payoff and risk. You can also ask about options concepts.'
}

function plainText(answer: AssistantChatResponse) {
  return [answer.answer, answer.followUpQuestion].filter(Boolean).join('\n')
}

export function AssistantBot({
  ticker,
  parsedView,
  market,
  options,
  selectedStrategy,
  strategies,
  onStructuredUpdates,
  onSelectStrategy,
  onContractAdjustment,
  profileApplied = false,
  open,
  onOpenChange,
}: {
  ticker: string
  parsedView: ParsedView
  market?: QverisMarketSnapshot
  options?: QverisOptionsResponse
  selectedStrategy?: StrategyCandidate
  strategies: StrategyCandidate[]
  onStructuredUpdates?: (updates: AssistantStructuredUpdates) => void
  onSelectStrategy?: (id: string) => void
  onContractAdjustment?: (adjustment: AssistantContractAdjustment) => void
  profileApplied?: boolean
  /** The entry button lives in the top bar, so the page owns the open state. */
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { lang } = useT()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [thinkingKind, setThinkingKind] = useState<ThinkingKind>('chat')
  // A reply that has arrived but waits for the progress animation to finish ticking.
  const [pending, setPending] = useState<Message>()
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: intro(lang),
    },
  ])

  const agentState = useRef<AssistantAgentState | undefined>(undefined)
  const messagesEnd = useRef<HTMLDivElement>(null)

  // Conversation memory belongs to one ticker; switching tickers on the page starts fresh.
  useEffect(() => {
    const remembered = agentState.current?.profile?.ticker
    if (remembered && remembered !== ticker) agentState.current = undefined
  }, [ticker])

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ block: 'end' })
  }, [messages, loading])

  useEffect(() => {
    setMessages((current) => current.length === 1 && current[0].role === 'assistant'
      ? [{ role: 'assistant', content: intro(lang) }]
      : current)
  }, [lang])

  async function send(text = input) {
    const userMessage = text.trim()
    if (!userMessage || loading) return
    setInput('')
    setMessages((current) => [...current, { role: 'user', content: userMessage }])
    setThinkingKind(thinkingKindFor(userMessage))
    setLoading(true)
    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userMessage,
          history: messages.slice(-8).map(({ role, content }) => ({ role, content })),
          agentState: agentState.current,
          language: lang,
          mode: 'chat',
          marketContext: buildAssistantContext({
            ticker,
            parsedView,
            market,
            options,
            selectedStrategy,
            strategies,
            profileApplied,
          }),
        }),
      })
      const body = await response.json()
      const answer = (response.ok ? body : fallbackAssistantResponse(body.error || 'Qveris AI is unavailable.')) as AssistantChatResponse
      if (response.ok && answer.agentState) agentState.current = answer.agentState
      const updates = normalizeAssistantUpdates(answer.structuredUpdates)
      if (Object.keys(updates).length) onStructuredUpdates?.(updates)
      if (response.ok && answer.contractAdjustment) onContractAdjustment?.(answer.contractAdjustment)
      if (response.ok) {
        recordProductEvent({
          eventName: 'assistant_used',
          ticker,
          properties: {
            strategyId: selectedStrategy?.id,
            strategyName: selectedStrategy?.name,
            source: 'assistant',
          },
        })
      }
      setPending({ role: 'assistant', content: plainText(answer), response: answer })
    } catch (error) {
      const answer = fallbackAssistantResponse(error instanceof Error ? error.message : 'Qveris AI is unavailable.')
      setPending({ role: 'assistant', content: answer.answer })
    }
  }

  function revealPending() {
    if (pending) setMessages((current) => [...current, pending])
    setPending(undefined)
    setLoading(false)
  }

  return (
    <>
      {open ? (
        <section className="assistant-drawer" aria-label="Qveris AI assistant">
          <header>
            <div>
              <strong>Qveris AI</strong>
              <span>{ticker} · {parsedView.view} · {parsedView.time_horizon} · {lang === 'zh' ? '风险' : 'Risk'} {parsedView.risk_budget ? `$${parsedView.risk_budget}` : (lang === 'zh' ? '待填写' : 'pending')}</span>
            </div>
            <button type="button" onClick={() => onOpenChange(false)} aria-label="Close Qveris AI"><X size={17} /></button>
          </header>
          <div className="assistant-chip-row">
            {chips[lang].map(([label, prompt]) => (
              <button key={label} type="button" onClick={() => void send(prompt)}>{label}</button>
            ))}
          </div>
          <div className="assistant-messages">
            {messages.map((message, index) => (
              message.response ? (
                <AssistantAnswer
                  answer={message.response}
                  key={`${message.role}-${index}`}
                  lang={lang}
                  onSelectStrategy={onSelectStrategy}
                  selectedStrategyId={selectedStrategy?.id}
                />
              ) : (
                <p className={message.role} key={`${message.role}-${index}`}>{message.content}</p>
              )
            ))}
            {loading ? <AssistantThinking lang={lang} kind={thinkingKind} done={Boolean(pending)} onFinished={revealPending} /> : null}
            <div ref={messagesEnd} />
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
