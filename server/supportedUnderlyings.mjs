export const SUPPORTED_STOCK_SYMBOLS = [
  'TSLA', 'NVDA', 'AAPL', 'INTC', 'NFLX', 'MU', 'AMZN', 'MSFT', 'SOFI', 'META',
  'CRWV', 'NOK', 'MRVL', 'GOOGL', 'PLTR', 'MSTR', 'AMD', 'HOOD', 'SMCI', 'AVGO',
  'IREN', 'SNAP', 'ASTS', 'HIMS', 'AMC', 'BABA', 'ORCL', 'RKLB', 'GOOG', 'NU',
  'OPEN', 'SNDK', 'LRCX', 'GME', 'AAL', 'WULF', 'BAC', 'ONDS', 'QCOM', 'MARA',
  'NIO', 'COIN', 'BE', 'JPM', 'CRM', 'NOW', 'TSM', 'VFC', 'SATS', 'APLD',
  'PFE', 'DOMO', 'CMCSA', 'WMT', 'F', 'PYPL', 'RIVN', 'AAOI', 'RBLX', 'MRNA',
  'WDC', 'ARM', 'SPCE', 'ADBE', 'FRMI', 'BMNR', 'WBD', 'PURR', 'EOSE', 'HPE',
  'RXT', 'CSX', 'RKT', 'KHC', 'CIFR', 'NKE', 'RGTI', 'UBER', 'FCX', 'TTD',
  'OXY', 'C', 'SMR', 'KO', 'XPEV', 'RDW', 'IONQ', 'XOM', 'ET', 'QUBT',
  'QBTS', 'MMM', 'DELL', 'CPNG', 'PDD', 'FISV', 'CRCL', 'AMAT', 'RIOT', 'BTDR',
]

export const SUPPORTED_ETF_SYMBOLS = [
  'SPY', 'QQQ', 'IWM', 'TQQQ', 'SQQQ', 'TLT', 'SLV', 'GLD', 'UVXY', 'EEM',
  'XLF', 'HYG', 'KRE', 'SOXL', 'DIA', 'XLE', 'XBI', 'XLU', 'XLI', 'ARKK',
]

const supportedStocks = new Set(SUPPORTED_STOCK_SYMBOLS)
const supportedEtfs = new Set(SUPPORTED_ETF_SYMBOLS)

export function normalizeSupportedSymbol(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '')
}

export function supportedUnderlyingKind(value) {
  const symbol = normalizeSupportedSymbol(value)
  if (supportedStocks.has(symbol)) return 'stock'
  if (supportedEtfs.has(symbol)) return 'etf'
  return undefined
}

export function isSupportedUnderlying(value) {
  return supportedUnderlyingKind(value) !== undefined
}

export function supportedUniversePayload() {
  return {
    stocks: SUPPORTED_STOCK_SYMBOLS,
    etfs: SUPPORTED_ETF_SYMBOLS,
    limits: {
      stocks: SUPPORTED_STOCK_SYMBOLS.length,
      etfs: SUPPORTED_ETF_SYMBOLS.length,
    },
  }
}
