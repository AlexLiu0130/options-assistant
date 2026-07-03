import type { QverisMarketSnapshot, QverisOptionsResponse } from '../types/optionTypes'
import type { ParsedView, StrategyCandidate } from '../types/strategyTypes'
import { buildRiskChecklist } from './riskChecklistEngine'

export type AssistantIntent = 'clarify' | 'recommend' | 'explain' | 'compare' | 'educate' | 'adjust' | 'risk_check' | 'refuse'

export type AssistantStructuredUpdates = Partial<{
  ticker: string
  direction: string
  strength: string
  horizon: string
  riskBudget: number
  targetPrice: number
  ownsShares: boolean
  sharesCount: number
  willingToBeAssigned: boolean
  experienceLevel: string
}>

export type AssistantChatResponse = {
  intent: AssistantIntent
  title?: string
  answer: string
  sections?: Array<{ title: string; body: string }>
  followUpQuestion?: string
  structuredUpdates?: AssistantStructuredUpdates
  referencedStrategyIds: string[]
  warnings: string[]
  dataGaps: string[]
}

function stringUpdate(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberUpdate(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function booleanUpdate(value: unknown) {
  return typeof value === 'boolean' ? value : undefined
}

export function normalizeAssistantUpdates(value: unknown): AssistantStructuredUpdates {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const updates: AssistantStructuredUpdates = {
    ticker: stringUpdate(raw.ticker)?.toUpperCase(),
    direction: stringUpdate(raw.direction),
    strength: stringUpdate(raw.strength),
    horizon: stringUpdate(raw.horizon),
    riskBudget: numberUpdate(raw.riskBudget),
    targetPrice: numberUpdate(raw.targetPrice),
    ownsShares: booleanUpdate(raw.ownsShares),
    sharesCount: numberUpdate(raw.sharesCount),
    willingToBeAssigned: booleanUpdate(raw.willingToBeAssigned),
    experienceLevel: stringUpdate(raw.experienceLevel),
  }
  return Object.fromEntries(Object.entries(updates).filter(([, item]) => item !== undefined))
}

export function riskBudgetWarning(strategy?: StrategyCandidate, parsedView?: ParsedView) {
  if (!strategy?.maxLoss || !parsedView?.risk_budget) return undefined
  if (strategy.maxLoss === 'unlimited') return `${strategy.name} has uncapped maximum loss and does not fit a fixed risk budget.`
  if (strategy.maxLoss === 'variable') return `${strategy.name} has variable maximum loss and needs manual risk review before it can fit a fixed risk budget.`
  if (strategy.maxLoss <= parsedView.risk_budget) return undefined
  return `${strategy.name} does not fit the current $${parsedView.risk_budget.toFixed(2)} risk budget because max loss is $${strategy.maxLoss.toFixed(2)}.`
}

export function buildAssistantContext({
  ticker,
  parsedView,
  market,
  options,
  selectedStrategy,
  strategies,
}: {
  ticker: string
  parsedView: ParsedView
  market?: QverisMarketSnapshot
  options?: QverisOptionsResponse
  selectedStrategy?: StrategyCandidate
  strategies: StrategyCandidate[]
}) {
  return {
    ticker,
    parsedView,
    market: market
      ? {
          price: market.price,
          change: market.change,
          changePercent: market.changePercent,
          asOf: market.asOf,
          source: market.source,
        }
      : undefined,
    optionChainStatus: options?.status ?? 'pending',
    dataGaps: options?.dataGaps ?? [],
    selectedStrategy,
    strategies: strategies.map((strategy) => ({
      id: strategy.id,
      name: strategy.name,
      fit: strategy.fit,
      maxLoss: strategy.maxLoss,
      maxProfit: strategy.maxProfit,
      breakevens: strategy.breakevens ?? (strategy.breakeven ? [strategy.breakeven] : []),
      probabilityOfProfit: strategy.probabilityOfProfit,
      expectedMove: strategy.expectedMove,
      netDebitCredit: strategy.netDebitCredit,
      targetPricePl: strategy.targetPricePl,
      legs: strategy.legs,
      scenarios: strategy.scenarioRows,
      riskChecklist: buildRiskChecklist(strategy),
      guardrails: strategy.guardrails,
      whyItFits: strategy.whyItFits,
      beginnerNote: strategy.beginnerNote,
      rankReasons: strategy.rankReasons,
      rankWarnings: strategy.rankWarnings,
      rankDetails: strategy.rankDetails,
      playbook: strategy.playbook,
      riskBudgetWarning: riskBudgetWarning(strategy, parsedView),
    })),
  }
}

export function fallbackAssistantResponse(message: string, dataGaps: string[] = []): AssistantChatResponse {
  return {
    intent: 'refuse',
    answer: message,
    referencedStrategyIds: [],
    warnings: ['Qveris AI could not produce a governed JSON answer.'],
    dataGaps,
  }
}

export function assistantBriefText(body: AssistantChatResponse) {
  return [
    body.title,
    body.answer,
    ...(body.sections ?? []).map((section) => `${section.title}: ${section.body}`),
    body.followUpQuestion,
  ].filter(Boolean).join('\n')
}
