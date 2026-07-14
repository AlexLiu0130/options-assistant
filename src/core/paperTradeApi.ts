import type { PaperOrder, PaperPosition, PaperPositionMark } from '../types/paperTradeTypes'
import type { StrategyCandidate } from '../types/strategyTypes'

export type PaperPositionRow = PaperPosition & { mark?: PaperPositionMark }
export type PaperStorage = 'local_file' | 'postgres'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Paper trade request failed.')
  return body
}

export async function submitPaperOrder({
  ticker,
  strategy,
  underlyingPrice,
}: {
  ticker: string
  strategy: StrategyCandidate
  underlyingPrice?: number
}) {
  return request<{ order: PaperOrder; position?: PaperPosition; warnings?: string[]; storage: PaperStorage }>('/api/paper/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticker, strategySnapshot: strategy, underlyingPrice }),
  })
}

export function listPaperPositions(currentPrice?: number) {
  const params = new URLSearchParams({ status: 'all' })
  if (typeof currentPrice === 'number') params.set('currentPrice', String(currentPrice))
  return request<{ positions: PaperPositionRow[]; storage: PaperStorage }>(`/api/paper/positions?${params}`)
}

export function closePaperPosition(positionId: string, currentPrice: number) {
  return request<{ position: PaperPosition; realizedPnL: number; warnings?: string[]; storage: PaperStorage }>(
    `/api/paper/positions/${encodeURIComponent(positionId)}/close`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentUnderlyingPrice: currentPrice }),
    },
  )
}

export type PaperAccountSummary = {
  asOf: string
  currency: 'USD'
  initialCash: number
  cashBalance: number
  openValue: number
  reservedRisk: number
  buyingPower: number
  equity: number
  netPnL: number
  unrealizedPnL: number
  realizedPnL: number
  openCount: number
  closedCount: number
  dataGaps: string[]
}

export type PaperAccountResponse = {
  account: { id: string; userId: string; currency: 'USD'; initialCash: number; cashBalance: number; updatedAt: string }
  summary: PaperAccountSummary
  positions: PaperPositionRow[]
  storage: PaperStorage
}

export function getPaperAccount(prices?: Record<string, number>) {
  if (prices && Object.keys(prices).length > 0) {
    return request<PaperAccountResponse>('/api/paper/account/mark', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prices }),
    })
  }
  return request<PaperAccountResponse>('/api/paper/account')
}

export async function getPaperAccountWithMarketPrices() {
  const account = await getPaperAccount()
  const tickers = [...new Set(account.positions.filter((pos) => pos.status === 'open').map((pos) => pos.ticker))]
  const prices = Object.fromEntries(
    (await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const market = await request<{ price: number | null }>(`/api/market/${encodeURIComponent(ticker)}?range=1d`)
          return typeof market.price === 'number' ? ([ticker, market.price] as [string, number]) : undefined
        } catch {
          return undefined
        }
      }),
    )).filter((row): row is [string, number] => Boolean(row)),
  )
  return Object.keys(prices).length ? getPaperAccount(prices) : account
}

export function resetPaperAccount(initialCash: number) {
  return request<PaperAccountResponse & { clearedOrders: number; clearedPositions: number }>(
    '/api/paper/account/reset',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initialCash }),
    },
  )
}
