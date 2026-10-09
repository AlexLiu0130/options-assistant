import { useState } from 'react'
import { Bot, Loader2 } from 'lucide-react'
import { buildRiskChecklist } from '../core/riskChecklistEngine'
import { fallbackAssistantResponse, type AssistantChatResponse } from '../core/assistantPolicy'
import { AssistantAnswer, AssistantThinking } from './AssistantAnswer'
import { useT } from '../i18n'
import type { ParsedView, StrategyCandidate } from '../types/strategyTypes'

export function AssistantExplanationPanel({
  strategy,
  ticker,
  parsedView,
  underlyingPrice,
  dataGaps = [],
}: {
  strategy?: StrategyCandidate
  ticker: string
  parsedView: ParsedView
  underlyingPrice?: number
  dataGaps?: string[]
}) {
  const { t, lang } = useT()
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [answer, setAnswer] = useState<AssistantChatResponse>()
  // The reply waits here until the progress animation has ticked through every step.
  const [pending, setPending] = useState<{ answer: AssistantChatResponse; error: boolean }>()

  async function explain() {
    if (!strategy) return
    setState('loading')
    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userMessage: lang === 'zh'
            ? `解释当前选中的 ${ticker.toUpperCase()} ${strategy.name} 策略。`
            : `Explain the selected ${strategy.name} strategy for ${ticker.toUpperCase()}.`,
          language: lang,
          mode: 'strategy_explanation',
          marketContext: {
            ticker,
            selectedStrategy: strategy,
            strategies: [strategy],
            underlyingPrice,
            parsedView,
            dataGaps,
            options: { dataGaps },
            selectedStrategyDetail: {
              id: strategy.id,
              name: strategy.name,
              legs: strategy.legs,
              maxLoss: strategy.maxLoss,
              maxProfit: strategy.maxProfit,
              breakevens: strategy.breakevens ?? (strategy.breakeven ? [strategy.breakeven] : []),
              probabilityOfProfit: strategy.probabilityOfProfit,
              expectedMove: strategy.expectedMove,
              targetPricePl: strategy.targetPricePl,
              scenarios: strategy.scenarioRows,
              riskChecklist: buildRiskChecklist(strategy),
              guardrails: strategy.guardrails,
              dataGaps: [...(strategy.dataGaps ?? []), ...dataGaps],
            },
          },
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Qveris AI is unavailable.')
      setPending({ answer: body as AssistantChatResponse, error: false })
    } catch (error) {
      setPending({ answer: fallbackAssistantResponse(error instanceof Error ? error.message : 'Qveris AI is unavailable.'), error: true })
    }
  }

  return (
    <section className="assistant-panel">
      <div>
        <span><Bot size={14} /> {t.brief.title}</span>
        <button disabled={!strategy || state === 'loading'} type="button" onClick={explain}>
          {state === 'loading' ? <Loader2 size={13} className="spin" /> : null}
          {t.brief.explain}
        </button>
      </div>
      <p>
        {strategy ? t.brief.subtext(strategy.name) : t.brief.placeholder}
      </p>
      {state === 'loading' ? (
        <AssistantThinking
          lang={lang}
          kind="explain"
          done={Boolean(pending)}
          onFinished={() => {
            if (pending) setAnswer(pending.answer)
            setState(pending?.error ? 'error' : 'idle')
            setPending(undefined)
          }}
        />
      ) : null}
      {state !== 'loading' && answer ? (
        <div className={`brief-answer${state === 'error' ? ' brief-error' : ''}`}>
          <AssistantAnswer answer={answer} lang={lang} variant="brief" />
        </div>
      ) : null}
    </section>
  )
}
