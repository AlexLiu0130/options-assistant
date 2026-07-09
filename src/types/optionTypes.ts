export type OptionRight = 'call' | 'put'
export type DataStatus = 'available' | 'partial' | 'unavailable' | 'stale'

export interface QverisOptionContract {
  symbol: string
  underlying: string
  quoteDate?: string
  expiration: string
  strike: number | null
  right: OptionRight
  bid: number | null
  ask: number | null
  last?: number | null
  bidSize?: number | null
  askSize?: number | null
  openInterest?: number | null
  volume?: number | null
  impliedVolatility?: number | null
  delta?: number | null
  gamma?: number | null
  vega?: number | null
  theta?: number | null
}

export interface QverisCandle {
  time: string | number
  open: number
  high: number
  low: number
  close: number
  volume?: number | null
}

export interface QverisMarketSnapshot {
  ticker: string
  price: number | null
  open: number | null
  high: number | null
  low: number | null
  previousClose: number | null
  change: number | null
  changePercent: number | null
  volume: number | null
  timestamp: number
  source: 'QVeris'
  asOf: string
  candles?: QverisCandle[]
  marketDataType?: string
}

export interface QverisOptionsResponse {
  ticker: string
  status: DataStatus
  mode?: 'live'
  dataSource?: string
  contracts: QverisOptionContract[]
  market?: QverisMarketSnapshot
  dataGaps: string[]
  message?: string
  asOf?: string
}
