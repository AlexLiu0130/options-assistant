import { useState } from 'react'
import { Bot, Loader2 } from 'lucide-react'
import { buildRiskChecklist } from '../core/riskChecklistEngine'
import { assistantBriefText } from '../core/assistantPolicy'
import { useT } from '../i18n'
import type { ParsedView, StrategyCandidate } from '../types/strategyTypes'

type SectionType = 'setup' | 'why' | 'risk' | 'data' | 'other'

const sectionMeta: Record<SectionType, { color: string; bg: string; en: string; zh: string }> = {
  setup: { color: '#2563eb', bg: 'rgba(37,99,235,0.10)',  en: 'Setup',        zh: '策略结构' },
  why:   { color: '#15803d', bg: 'rgba(22,163,74,0.10)',  en: 'Why it fits',  zh: '适合原因' },
  risk:  { color: '#b45309', bg: 'rgba(217,119,6,0.12)',  en: 'Key risk',     zh: '关键风险' },
  data:  { color: '#64748b', bg: 'rgba(100,116,139,0.09)',en: 'Data gaps',    zh: '数据缺口' },
  other: { color: '#64748b', bg: 'rgba(100,116,139,0.06)',en: '',             zh: '' },
}

function detectType(label: string): SectionType {
  const l = label.toLowerCase()
  if (l.includes('setup') || l.includes('structure') || label.includes('结构') || label.includes('设置')) return 'setup'
  if (l.includes('why') || l.includes('fit') || l.includes('view') || label.includes('适合') || label.includes('原因')) return 'why'
  if (l.includes('risk') || l.includes('key') || label.includes('风险')) return 'risk'
  if (l.includes('miss') || l.includes('data') || l.includes('gap') || label.includes('数据') || label.includes('缺口')) return 'data'
  return 'other'
}

// Normalise AI ALL-CAPS output to sentence case, preserving short tokens (tickers, abbreviations)
function normalizeCaps(text: string): string {
  const words = text.split(/\s+/)
  const upperWords = words.filter(w => /[A-Z]{2,}/.test(w) && !/^\$/.test(w))
  if (upperWords.length / Math.max(words.length, 1) < 0.4) return text
  return text
    .toLowerCase()
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase())
    // restore short caps tokens (≤5 chars like NVDA, IV, OTM, ATM)
    .replace(/\b([a-z]{1,5})\b/g, (m) => {
      const orig = words.find(w => w.toLowerCase() === m)
      return orig && orig === orig.toUpperCase() && /[A-Z]/.test(orig) ? orig : m
    })
}

function cleanMarkdown(text: string) {
  return text
    .replace(/^#+\s*(.+)$/gm, '$1')
    .replace(/`/g, '')
}

function cleanBriefPart(text: string) {
  return text
    .replace(/^[\s:：\-•]+/, '')
    .replace(/\*/g, '')
    .trim()
}

function forceTickerCase(text: string, ticker?: string) {
  if (!ticker) return text
  const symbol = ticker.toUpperCase()
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(^|[^A-Za-z0-9.-])(${escaped})(?=$|[^A-Za-z0-9.-])`, 'gi'), `$1${symbol}`)
}

export function BriefContent({ text, isError, lang, ticker }: { text: string; isError: boolean; lang: 'en' | 'zh'; ticker?: string }) {
  const lines = cleanMarkdown(forceTickerCase(text, ticker))
    .split('\n')
    .map((line) => line.trim().replace(/^-+\s*/, ''))
    .filter(Boolean)
    .filter((line, index) => index !== 0 || !/(简报|brief)$/i.test(cleanBriefPart(line)))
  const sections = lines.map(line => {
    const m = line.match(/^-?\s*\*\*([^*]+)\*\*:?\s*(.+)$/)
      ?? line.match(/^-?\s*([^:：]{2,24})[:：]\s*(.+)$/)
      ?? line.match(/^([一-龥]{2,8})\s+(.{4,})$/)  // "策略设置 内容" style
    if (m) {
      const type = detectType(m[1])
      return {
        type,
        label: cleanBriefPart(m[1]),
        content: normalizeCaps(cleanBriefPart(m[2])),
      }
    }
    return { type: 'other' as SectionType, label: '', content: normalizeCaps(cleanBriefPart(line)) }
  })

  return (
    <div className={`brief-body${isError ? ' brief-error' : ''}`}>
      {sections.map((s, i) => {
        const meta = sectionMeta[s.type]
        const displayLabel = s.type !== 'other' ? (lang === 'zh' ? meta.zh : meta.en) : s.label
        return (
          <div className="brief-section" key={i} style={{ '--section-color': meta.color, '--section-bg': meta.bg } as React.CSSProperties}>
            {displayLabel && <span className="brief-tag">{displayLabel}</span>}
            <p className="brief-text">{s.content}</p>
          </div>
        )
      })}
    </div>
  )
}

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
  const [text, setText] = useState('')

  async function explain() {
    if (!strategy) return
    setState('loading')
    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userMessage: `Explain the selected ${strategy.name} strategy for ${ticker.toUpperCase()}.`,
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
      setText(assistantBriefText(body))
      setState('idle')
    } catch (error) {
      setText(error instanceof Error ? error.message : 'Qveris AI is unavailable.')
      setState('error')
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
      {text ? <BriefContent text={text} isError={state === 'error'} lang={lang} ticker={ticker} /> : null}
    </section>
  )
}
