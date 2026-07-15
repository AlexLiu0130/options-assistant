import type { StrategyCandidate, StrategyLeg } from './strategyTypes'

export type PaperOrderStatus = 'pending' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected'
export type PaperPositionStatus = 'open' | 'closed'

export type PaperTradeFillSnapshot = {
  asOf: string
  underlyingPrice: number
  daysLeft: number
  strategyValue: number
  fees?: PaperTradeFees
  maxLoss?: number | 'unlimited' | 'variable'
  maxProfit?: number | 'unlimited' | 'variable'
  breakevens: number[]
  dataGaps: string[]
  valueMethod: 'quoted_mid' | 'theoretical_mid'
}

export type PaperOrder = {
  id: string
  userId: string
  accountId: string
  status: PaperOrderStatus
  side: 'open' | 'close'
  ticker: string
  strategyId: string
  strategyName: string
  quantity: number
  orderType: 'simulated_market'
  submittedAt: string
  filledAt?: string
  rejectReason?: string
  strategySnapshot: StrategyCandidate
  fillSnapshot?: PaperTradeFillSnapshot
}

export type PaperPosition = {
  id: string
  userId: string
  accountId: string
  status: PaperPositionStatus
  ticker: string
  strategyId: string
  strategyName: string
  quantity: number
  openedAt: string
  closedAt?: string
  entrySnapshot: PaperTradeFillSnapshot
  closeSnapshot?: PaperTradeFillSnapshot
  realizedPnL?: number
  strategySnapshot: StrategyCandidate
  legsSnapshot: StrategyLeg[]
  userNotes?: string
}

export type PaperPositionMark = {
  positionId: string
  asOf: string
  currentUnderlyingPrice: number
  currentDaysLeft: number
  currentStrategyValue: number
  unrealizedPnL: number
  unrealizedPnLPct: number
  dataGaps: string[]
}

export type PaperTradeFees = {
  commission: number
  thirdParty: number
  total: number
  contractCount: number
  commissionBeforeMinimum: number
  commissionMinimumApplied: boolean
  optionsRegulatoryFee: number
  occClearingFee: number
  catFee: number
  secTransactionFee: number
  finraTradingActivityFee: number
  model: 'ibkr_us_options_estimate'
  disclosure: string
}
