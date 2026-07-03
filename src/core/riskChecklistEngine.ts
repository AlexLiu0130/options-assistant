import type { StrategyCandidate } from '../types/strategyTypes'

export type RiskChecklistRow = {
  strategy: string
  check: string
  severity: 'pass' | 'info' | 'warning'
  detail: string
}

function money(value?: number | string | null) {
  if (value === 'unlimited') return 'Unlimited'
  if (value === 'variable') return 'Variable'
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Pending'
  return `$${value.toFixed(2)}`
}

export function buildRiskChecklist(strategy: StrategyCandidate): RiskChecklistRow[] {
  return [
    {
      strategy: strategy.name,
      check: 'Max loss',
      severity: strategy.maxLoss ? 'info' : 'warning',
      detail: strategy.maxLoss ? `${money(strategy.maxLoss)} defined by selected legs.` : 'Pending contract data.',
    },
    {
      strategy: strategy.name,
      check: 'Beginner fit',
      severity: strategy.fit === 'low' ? 'warning' : 'pass',
      detail: strategy.beginnerNote ?? 'Review suitability before paper trading.',
    },
    ...(strategy.dataGaps ?? []).map((gap) => ({
      strategy: strategy.name,
      check: 'Data gap',
      severity: 'warning' as const,
      detail: gap,
    })),
  ]
}

export function riskRows(strategies: StrategyCandidate[]) {
  return strategies.flatMap(buildRiskChecklist)
}
