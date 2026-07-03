import type { OptionRight } from './optionTypes'

export type Direction = 'bullish' | 'bearish' | 'neutral' | 'volatile'
export type Strength = 'mild' | 'moderate' | 'strong'
export type ExperienceLevel = 'beginner' | 'intermediate' | 'advanced'

export interface UserInput {
  ticker: string
  current_price: number
  view: Direction
  strength?: Strength
  time_horizon?: string
  target_price?: number
  risk_budget?: number
  owns_shares?: boolean
  shares_count?: number
  willing_to_be_assigned?: boolean
  experience_level?: ExperienceLevel
  event_context?: 'earnings' | 'none' | 'macro' | 'unknown'
}

export interface ParsedView extends Required<Omit<UserInput, 'target_price' | 'risk_budget' | 'shares_count'>> {
  target_price?: number
  risk_budget?: number
  shares_count?: number
  assumptions: string[]
  missing_fields: string[]
}

export interface TargetPriceScenario {
  conservative: number | [number, number]
  base: number | [number, number]
  optimistic: number | [number, number]
  method: 'user_target' | 'percentage_default'
  explanation: string
}

export interface ExpirationCandidate {
  label: 'primary' | 'alternative' | 'longer_dated'
  dteMin: number
  dteMax: number
  reason: string
  warnings: string[]
}

export interface StrategyLeg {
  action: 'buy' | 'sell'
  right: OptionRight
  strike: number
  expiration: string
  quantity: number
  premium?: number
  impliedVolatility?: number
  symbol?: string
}

export interface ScenarioRow {
  label: string
  underlyingPrice: number
  estimatedPl?: number
  meaning: string
}

export type StrategyRankCategory = 'risk' | 'target' | 'dte' | 'probability' | 'liquidity' | 'iv' | 'greeks' | 'complexity' | 'assignment'

export interface StrategyRankDetail {
  category: StrategyRankCategory
  label: string
  impact: 'positive' | 'negative' | 'neutral'
  value?: string | number
}

export interface StrategyPlaybook {
  setup: string[]
  entryChecklist: string[]
  profitManagement: string[]
  riskManagement: string[]
  timeManagement: string[]
  adjustmentTriggers: string[]
}

export interface StrategyCandidate {
  id: string
  name: string
  label?: 'best_fit' | 'aggressive' | 'conservative' | 'conditional'
  fit: 'high' | 'medium' | 'low'
  status?: 'education_only' | 'needs_option_chain' | 'contract_ready'
  maxLoss?: number | 'unlimited' | 'variable'
  maxProfit?: number | 'unlimited' | 'variable'
  breakeven?: number
  breakevens?: number[]
  netDebitCredit?: number
  probabilityOfProfit?: number
  expectedMove?: {
    low: number
    high: number
    impliedVolatility: number
    dte: number
  }
  targetPricePl?: number
  scenarioRows?: ScenarioRow[]
  legs: StrategyLeg[]
  guardrails: string[]
  whyItFits?: string
  beginnerNote?: string
  rankScore?: number
  rankReasons?: string[]
  rankWarnings?: string[]
  rankDetails?: StrategyRankDetail[]
  playbook?: StrategyPlaybook
  dataGaps?: string[]
}
