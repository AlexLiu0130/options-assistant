import type { QverisOptionContract, QverisOptionsResponse } from '../types/optionTypes'
import type { ParsedView, StrategyCandidate, StrategyLeg, StrategyRankDetail } from '../types/strategyTypes'
import { selectExpirationCandidates } from './expirationEngine.ts'
import { strategyExpirationPayoff as strategyPayoff } from './payoffEngine.ts'
import { buildScenarioRows as scenarioRows, scenarioTargetPrice as numericTarget } from './scenarioEngine.ts'

const optionGap =
  'QVERIS_DATA_GAP: Contract-level recommendation is pending because the option chain is unavailable or too sparse for the selected expiry.'
const multiplier = 100
const buyDte: [number, number] = [30, 60]
const sellDte: [number, number] = [30, 45]
const eventDte: [number, number] = [14, 45]
const leapsDte: [number, number] = [180, 365]

function mid(contract: QverisOptionContract) {
  if (
    typeof contract.bid === 'number' &&
    typeof contract.ask === 'number' &&
    contract.bid >= 0 &&
    contract.ask > 0 &&
    contract.ask >= contract.bid
  ) {
    return Number(((contract.bid + contract.ask) / 2).toFixed(2))
  }
  return typeof contract.last === 'number' && contract.last > 0 ? contract.last : undefined
}

function daysToExpiry(expiry: string) {
  const end = new Date(`${expiry}T21:00:00Z`).getTime()
  const now = Date.now()
  return Math.max(1, Math.round((end - now) / 86_400_000))
}

function atmIv(options: QverisOptionsResponse, expiry: string, spot: number) {
  const contracts = options.contracts
    .filter(
      (contract) =>
        contract.expiration === expiry &&
        typeof contract.strike === 'number' &&
        typeof contract.impliedVolatility === 'number',
    )
    .sort((a, b) => Math.abs((a.strike ?? 0) - spot) - Math.abs((b.strike ?? 0) - spot))
  const ivs = contracts.slice(0, 4).map((contract) => contract.impliedVolatility ?? 0).filter(Boolean)
  return ivs.length ? ivs.reduce((sum, iv) => sum + iv, 0) / ivs.length : 0.35
}

function expectedMove(options: QverisOptionsResponse, expiry: string, spot: number) {
  const dte = daysToExpiry(expiry)
  const impliedVolatility = atmIv(options, expiry, spot)
  const move = spot * impliedVolatility * Math.sqrt(dte / 365)
  return {
    low: Number((spot - move).toFixed(2)),
    high: Number((spot + move).toFixed(2)),
    impliedVolatility: Number(impliedVolatility.toFixed(4)),
    dte,
  }
}

function normCdf(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989423 * Math.exp((-x * x) / 2)
  const p =
    d *
    t *
    (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return x > 0 ? 1 - p : p
}

function lognormalCdf(price: number, spot: number, iv: number, dte: number) {
  const years = Math.max(dte / 365, 1 / 365)
  const sigma = iv * Math.sqrt(years)
  if (price <= 0 || sigma <= 0) return price >= spot ? 1 : 0
  return normCdf((Math.log(price / spot) + 0.5 * sigma * sigma) / sigma)
}

function probabilityBetween(low: number, high: number, spot: number, iv: number, dte: number) {
  return Math.max(0, Math.min(1, lognormalCdf(high, spot, iv, dte) - lognormalCdf(low, spot, iv, dte)))
}

export function probabilityOfProfit(legs: StrategyLeg[], spot: number, iv: number, dte: number) {
  if (!legs.length) return undefined
  const low = spot * 0.45
  const high = spot * 1.75
  const steps = 220
  let probability = 0
  let previous = low
  for (let index = 1; index <= steps; index += 1) {
    const price = low + ((high - low) * index) / steps
    const midpoint = (previous + price) / 2
    if (strategyPayoff(legs, midpoint) > 0) {
      probability += probabilityBetween(previous, price, spot, iv, dte)
    }
    previous = price
  }
  return Number((probability * 100).toFixed(1))
}

function expiration(options: QverisOptionsResponse, preferredExpiration?: string, dteBand?: [number, number]) {
  const allExpirations = [...new Set(options.contracts.map((contract) => contract.expiration))]
    .filter(Boolean)
    .sort()
  if (preferredExpiration && allExpirations.includes(preferredExpiration)) return preferredExpiration
  const expirations = allExpirations.filter((expiry) => {
    const calls = contractsFor(options, 'call', expiry).length
    const puts = contractsFor(options, 'put', expiry).length
    return calls >= 4 && puts >= 4
  })
  const candidates = expirations.length ? expirations : allExpirations
  if (!dteBand) return candidates[0]
  const midpoint = (dteBand[0] + dteBand[1]) / 2
  const inBand = candidates
    .filter((expiry) => {
      const dte = daysToExpiry(expiry)
      return dte >= dteBand[0] && dte <= dteBand[1]
    })
  return (inBand.length ? inBand : candidates)
    .sort((a, b) => Math.abs(daysToExpiry(a) - midpoint) - Math.abs(daysToExpiry(b) - midpoint))[0]
}

function laterExpiration(options: QverisOptionsResponse, frontExpiry: string, minGapDays = 21) {
  const frontTime = new Date(`${frontExpiry}T21:00:00Z`).getTime()
  return [...new Set(options.contracts.map((contract) => contract.expiration))]
    .filter((expiry) => expiry > frontExpiry && new Date(`${expiry}T21:00:00Z`).getTime() - frontTime >= minGapDays * 86_400_000)
    .sort()[0]
}

function contractsFor(options: QverisOptionsResponse, right: 'call' | 'put', expiry: string) {
  return options.contracts
    .filter(
      (contract) =>
        contract.right === right &&
        contract.expiration === expiry &&
        typeof contract.strike === 'number' &&
        mid(contract) !== undefined,
    )
    .sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0))
}

function nearest(contracts: QverisOptionContract[], target: number) {
  return contracts.reduce<QverisOptionContract | undefined>((best, contract) => {
    if (!best) return contract
    return Math.abs((contract.strike ?? 0) - target) < Math.abs((best.strike ?? 0) - target)
      ? contract
      : best
  }, undefined)
}

function byAbsDelta(
  contracts: QverisOptionContract[],
  min: number,
  max: number,
  fallbackTarget: number,
) {
  const matches = contracts.filter((contract) => {
    const absDelta = Math.abs(contract.delta ?? 0)
    return absDelta >= min && absDelta <= max
  })
  return nearest(matches.length ? matches : contracts, fallbackTarget)
}

function deltaDistance(contract: QverisOptionContract, target: number) {
  return Math.abs(Math.abs(contract.delta ?? target) - target)
}

function lossBudgetPenalty(view: ParsedView, maxLoss: number) {
  if (!view.risk_budget) return 0
  return maxLoss <= view.risk_budget ? -25 : ((maxLoss - view.risk_budget) / view.risk_budget) * 100
}

function bestLongOption(
  contracts: QverisOptionContract[],
  view: ParsedView,
  fallbackTarget: number,
) {
  const [min, max, target] = view.strength === 'strong' ? [0.4, 0.55, 0.45] : [0.5, 0.65, 0.55]
  const matches = contracts.filter((contract) => {
    const absDelta = Math.abs(contract.delta ?? 0)
    return absDelta >= min && absDelta <= max
  })
  return [...(matches.length ? matches : contracts)].sort(
    (a, b) =>
      deltaDistance(a, target) - deltaDistance(b, target) ||
      Math.abs((a.strike ?? 0) - fallbackTarget) - Math.abs((b.strike ?? 0) - fallbackTarget),
  )[0]
}

function callDebitPair(calls: QverisOptionContract[], target: number) {
  const pairs = calls
    .map((buy, index) => {
      const sell = calls[index + 1]
      if (!sell?.strike || !buy.strike) return undefined
      const netDebit = Number(((mid(buy) ?? 0) - (mid(sell) ?? 0)).toFixed(2))
      const width = sell.strike - buy.strike
      return netDebit > 0 && netDebit < width ? { buy, sell } : undefined
    })
    .filter((pair): pair is { buy: QverisOptionContract; sell: QverisOptionContract } => Boolean(pair))
  return pairs.sort((a, b) => Math.abs((a.sell.strike ?? 0) - target) - Math.abs((b.sell.strike ?? 0) - target))[0]
}

function bestCallDebitSpread(calls: QverisOptionContract[], view: ParsedView) {
  const buyCandidates = calls.filter((contract) => {
    const absDelta = Math.abs(contract.delta ?? 0)
    return absDelta >= 0.45 && absDelta <= 0.65
  })
  const target = numericTarget(view)
  const pairs = (buyCandidates.length ? buyCandidates : calls).flatMap((buy) =>
    calls
      .filter((sell) => (sell.strike ?? 0) > (buy.strike ?? 0))
      .map((sell) => {
        const netDebit = Number(((mid(buy) ?? 0) - (mid(sell) ?? 0)).toFixed(2))
        const width = (sell.strike ?? 0) - (buy.strike ?? 0)
        if (netDebit <= 0 || netDebit >= width) return undefined
        const maxLoss = netDebit * multiplier
        return {
          buy,
          sell,
          score:
            Math.abs((sell.strike ?? 0) - target) +
            deltaDistance(buy, 0.55) * view.current_price +
            lossBudgetPenalty(view, maxLoss),
        }
      }),
  )
  return pairs
    .filter((pair): pair is { buy: QverisOptionContract; sell: QverisOptionContract; score: number } => Boolean(pair))
    .sort((a, b) => a.score - b.score)[0]
}

function bestPutDebitSpread(puts: QverisOptionContract[], view: ParsedView) {
  const buyCandidates = puts.filter((contract) => {
    const absDelta = Math.abs(contract.delta ?? 0)
    return absDelta >= 0.45 && absDelta <= 0.65
  })
  const target = numericTarget(view)
  const pairs = (buyCandidates.length ? buyCandidates : puts).flatMap((buy) =>
    puts
      .filter((sell) => (sell.strike ?? 0) < (buy.strike ?? 0))
      .map((sell) => {
        const netDebit = Number(((mid(buy) ?? 0) - (mid(sell) ?? 0)).toFixed(2))
        const width = (buy.strike ?? 0) - (sell.strike ?? 0)
        if (netDebit <= 0 || netDebit >= width) return undefined
        const maxLoss = netDebit * multiplier
        return {
          buy,
          sell,
          score:
            Math.abs((sell.strike ?? 0) - target) +
            deltaDistance(buy, 0.55) * view.current_price +
            lossBudgetPenalty(view, maxLoss),
        }
      }),
  )
  return pairs
    .filter((pair): pair is { buy: QverisOptionContract; sell: QverisOptionContract; score: number } => Boolean(pair))
    .sort((a, b) => a.score - b.score)[0]
}

function bestCreditSpread(
  contracts: QverisOptionContract[],
  view: ParsedView,
  side: 'call' | 'put',
) {
  const shortCandidates = contracts.filter((contract) => {
    const absDelta = Math.abs(contract.delta ?? 0)
    return absDelta >= 0.16 && absDelta <= 0.25
  })
  const buildPairs = (shorts: QverisOptionContract[]) =>
    shorts.flatMap((shortLeg) =>
      contracts
        .filter((longLeg) =>
          side === 'call'
            ? (longLeg.strike ?? 0) > (shortLeg.strike ?? 0)
            : (longLeg.strike ?? 0) < (shortLeg.strike ?? 0),
        )
        .map((longLeg) => {
          const credit = Number(((mid(shortLeg) ?? 0) - (mid(longLeg) ?? 0)).toFixed(2))
          const width = Math.abs((longLeg.strike ?? 0) - (shortLeg.strike ?? 0))
          if (credit <= 0 || credit >= width) return undefined
          const maxLoss = (width - credit) * multiplier
          return {
            shortLeg,
            longLeg,
            score:
              deltaDistance(shortLeg, 0.2) * view.current_price +
              deltaDistance(longLeg, 0.05) * view.current_price +
              lossBudgetPenalty(view, maxLoss),
          }
        }),
    )
  const pairs = buildPairs(shortCandidates)
  return (pairs.length ? pairs : buildPairs(contracts))
    .filter((pair): pair is { shortLeg: QverisOptionContract; longLeg: QverisOptionContract; score: number } => Boolean(pair))
    .sort((a, b) => a.score - b.score)[0]
}

function longButterflyParts(contracts: QverisOptionContract[], target: number) {
  const triples = contracts.slice(1, -1).map((middle, index) => ({
    lower: contracts[index],
    middle,
    upper: contracts[index + 2],
  }))
  for (const triple of triples.sort(
    (a, b) => Math.abs((a.middle.strike ?? 0) - target) - Math.abs((b.middle.strike ?? 0) - target),
  )) {
    const debit = Number(
      ((mid(triple.lower) ?? 0) - 2 * (mid(triple.middle) ?? 0) + (mid(triple.upper) ?? 0)).toFixed(2),
    )
    const lowerWing = (triple.middle.strike ?? 0) - (triple.lower.strike ?? 0)
    const upperWing = (triple.upper.strike ?? 0) - (triple.middle.strike ?? 0)
    if (Math.abs(lowerWing - upperWing) <= 0.01 && debit > 0 && lowerWing > debit) {
      return { ...triple, debit, wing: lowerWing }
    }
  }
  return undefined
}

function leg(action: 'buy' | 'sell', contract: QverisOptionContract): StrategyLeg {
  return {
    action,
    right: contract.right,
    strike: contract.strike ?? 0,
    expiration: contract.expiration,
    quantity: 1,
    premium: mid(contract),
    impliedVolatility: contract.impliedVolatility ?? undefined,
    symbol: contract.symbol,
  }
}

function contractCandidate(
  base: Omit<StrategyCandidate, 'fit' | 'status' | 'dataGaps'> & {
    fit?: StrategyCandidate['fit']
  },
): StrategyCandidate {
  return {
    fit: base.fit ?? 'medium',
    status: 'contract_ready',
    dataGaps: [],
    ...base,
  }
}

function educationCandidate(
  candidate: Omit<StrategyCandidate, 'fit' | 'legs' | 'status' | 'dataGaps'> & {
    fit?: StrategyCandidate['fit']
  },
): StrategyCandidate {
  return {
    fit: candidate.fit ?? 'medium',
    legs: [],
    status: 'needs_option_chain',
    dataGaps: [optionGap],
    ...candidate,
  }
}

function legContracts(strategy: StrategyCandidate, options?: QverisOptionsResponse) {
  if (!options) return []
  return strategy.legs
    .map((leg) =>
      options.contracts.find(
        (contract) =>
          contract.symbol === leg.symbol ||
          (contract.expiration === leg.expiration &&
            contract.right === leg.right &&
            contract.strike === leg.strike),
      ),
    )
    .filter((contract): contract is QverisOptionContract => Boolean(contract))
}

function averageSpreadPct(strategy: StrategyCandidate, options?: QverisOptionsResponse) {
  const contracts = legContracts(strategy, options)
  const spreads = contracts
    .map((contract) => {
      const quote = mid(contract)
      if (!quote || typeof contract.bid !== 'number' || typeof contract.ask !== 'number') return undefined
      return (contract.ask - contract.bid) / quote
    })
    .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
  return spreads.length ? spreads.reduce((sum, item) => sum + item, 0) / spreads.length : undefined
}

function numericMaxLoss(strategy: StrategyCandidate) {
  return typeof strategy.maxLoss === 'number' ? strategy.maxLoss : undefined
}

function greekExposure(strategy: StrategyCandidate, options?: QverisOptionsResponse) {
  const contracts = legContracts(strategy, options)
  const signed = (leg: StrategyLeg) => (leg.action === 'buy' ? 1 : -1) * leg.quantity
  return strategy.legs.reduce(
    (sum, leg) => {
      const contract = contracts.find(
        (item) => item.expiration === leg.expiration && item.right === leg.right && item.strike === leg.strike,
      )
      const sign = signed(leg)
      return {
        delta: sum.delta + sign * (contract?.delta ?? 0),
        gamma: sum.gamma + sign * (contract?.gamma ?? 0),
        theta: sum.theta + sign * (contract?.theta ?? 0),
        vega: sum.vega + sign * (contract?.vega ?? 0),
      }
    },
    { delta: 0, gamma: 0, theta: 0, vega: 0 },
  )
}

function chainIv(options?: QverisOptionsResponse) {
  const ivs = options?.contracts
    .map((contract) => contract.impliedVolatility)
    .filter((iv): iv is number => typeof iv === 'number' && Number.isFinite(iv) && iv > 0)
  return ivs?.length ? ivs.reduce((sum, iv) => sum + iv, 0) / ivs.length : undefined
}

function liquidityStats(strategy: StrategyCandidate, options?: QverisOptionsResponse) {
  const contracts = legContracts(strategy, options)
  if (!contracts.length) return undefined
  const minVolume = Math.min(...contracts.map((contract) => contract.volume ?? 0))
  const minOpenInterest = Math.min(...contracts.map((contract) => contract.openInterest ?? 0))
  const minSize = Math.min(...contracts.map((contract) => Math.min(contract.bidSize ?? 0, contract.askSize ?? 0)))
  return {
    minVolume,
    minOpenInterest,
    minSize,
    score: minVolume + minOpenInterest + minSize * 10,
  }
}

function premiumPosture(strategy: StrategyCandidate) {
  if (strategy.netDebitCredit === undefined) return 'mixed'
  return strategy.netDebitCredit > 0 ? 'long' : strategy.netDebitCredit < 0 ? 'short' : 'mixed'
}

function complexityPenalty(strategy: StrategyCandidate, view: ParsedView) {
  if (view.experience_level !== 'beginner') return 0
  if (strategy.legs.length >= 4) return -12
  if (strategy.legs.length === 3) return -7
  return 4
}

function strategyFamily(strategy: StrategyCandidate) {
  if (['long-call', 'long-put'].includes(strategy.id)) return 'long-option'
  if (['bull-call-spread', 'bear-put-spread'].includes(strategy.id)) return 'debit-spread'
  if (['bull-put-spread', 'bear-call-spread'].includes(strategy.id)) return 'credit-spread'
  if (strategy.id === 'cash-secured-put') return 'cash-secured-put'
  if (strategy.id === 'iron-condor') return 'iron-condor'
  if (strategy.id === 'iron-butterfly') return 'iron-butterfly'
  if (strategy.id.includes('butterfly')) return 'butterfly'
  if (['long-straddle', 'long-strangle'].includes(strategy.id)) return 'long-volatility'
  if (['short-straddle', 'short-strangle'].includes(strategy.id)) return 'short-volatility'
  if (strategy.id.includes('calendar') || strategy.id.includes('diagonal')) return 'time-spread'
  return 'generic'
}

function playbookFor(strategy: StrategyCandidate, view: ParsedView): StrategyCandidate['playbook'] {
  if (!strategy.legs.length) {
    return {
      setup: [`${strategy.name} is education-only until contract-level option-chain data is available.`],
      entryChecklist: ['Wait for live contracts before judging spread, liquidity, premium, Greeks, breakeven, or risk budget fit.'],
      profitManagement: ['Use the contract-ready version before estimating profit targets.'],
      riskManagement: ['Do not treat education-only max loss or max profit as tradable numbers.'],
      timeManagement: ['Choose DTE only after the chain confirms available expirations.'],
      adjustmentTriggers: ['Rebuild the candidate when live option-chain data arrives.'],
    }
  }
  const isCredit = (strategy.netDebitCredit ?? 0) < 0
  const hasShort = strategy.legs.some((leg) => leg.action === 'sell')
  const shortStrikes = strategy.legs.filter((leg) => leg.action === 'sell').map((leg) => leg.strike)
  const strikes = shortStrikes.length ? shortStrikes.join(' / ') : strategy.legs.map((leg) => leg.strike).join(' / ')
  const breakevens = strategy.breakevens?.length ? strategy.breakevens.join(' / ') : strategy.breakeven
  const definedRisk = typeof strategy.maxLoss === 'number'
  const family = strategyFamily(strategy)
  const setup = [
    `${strategy.name} uses ${strategy.legs.length} option leg${strategy.legs.length === 1 ? '' : 's'} around strike ${strikes}.`,
    definedRisk ? `Maximum loss is capped at $${strategy.maxLoss}.` : 'Maximum loss is uncapped or variable and needs manual review.',
  ]
  const entryChecklist = [
    'Confirm bid/ask spread, volume, open interest, and event calendar before using real capital.',
    breakevens ? `Check that the thesis reaches the breakeven area: ${breakevens}.` : 'Check breakeven and scenario table before using the setup.',
  ]
  const profitManagement = isCredit
    ? ['For short-premium structures, consider taking partial or full profit after roughly 40-60% of the credit is captured.']
    : ['For debit structures, compare the current value with target-case P/L and avoid relying only on expiration payoff.']
  const riskManagement = [
    definedRisk ? 'Do not size above the stated max-loss amount.' : 'Avoid fixed-budget use until margin and tail risk are reviewed.',
    hasShort ? 'Short legs add assignment and early exercise risk, especially near ex-dividend dates or when deep ITM.' : 'Long premium can expire worthless if the move is too small or too slow.',
  ]
  const timeManagement = isCredit
    ? ['Short-premium positions normally need active management before the final 7-10 DTE window.']
    : ['Long-premium positions need enough time for the thesis to work; monitor theta decay as expiration approaches.']
  const adjustmentTriggers = [
    'Re-check if price approaches a short strike or breakeven.',
    'Re-check if IV changes sharply, liquidity worsens, or an event date enters the holding period.',
  ]

  if (family === 'long-option') {
    setup.push('Typical selection favors 30-60 DTE and roughly 0.45-0.65 delta for directional exposure.')
    profitManagement[0] = 'Use target-case value and remaining DTE to decide whether the move is still worth holding.'
    riskManagement.push('If the stock moves sideways, theta decay can turn a correct direction into a losing trade.')
  } else if (family === 'debit-spread') {
    setup.push('Typical selection buys a 0.45-0.65 delta option and sells a strike near the target area.')
    profitManagement[0] = 'Debit spreads are often reviewed after roughly 50-75% of max profit is available.'
    adjustmentTriggers.push('Re-check if price stalls below the short strike while DTE is shrinking.')
  } else if (family === 'credit-spread') {
    setup.push('Typical selection sells a 0.16-0.25 delta option and buys a farther OTM hedge to define risk.')
    profitManagement[0] = 'Credit spreads are often reviewed after roughly 40-60% of the credit is captured.'
    adjustmentTriggers.push('Re-check if the short strike delta moves toward 0.30-0.35 or price tests the short strike.')
  } else if (family === 'cash-secured-put') {
    setup.push('Typical selection sells an OTM put only when assignment at that strike is acceptable.')
    entryChecklist.push('Confirm cash is reserved for 100 shares per contract.')
    profitManagement[0] = 'Cash-secured puts are often reviewed after a large share of the credit is captured.'
    riskManagement.push('Below breakeven, risk behaves like owning shares minus the premium received.')
  } else if (family === 'iron-condor') {
    setup.push('Typical selection sells 0.16-0.25 delta call and put spreads outside the expected range.')
    profitManagement[0] = 'Iron condors are often reviewed after roughly 40-60% of the credit is captured.'
    adjustmentTriggers.push('Re-check if either short strike is tested or one side carries most of the remaining risk.')
  } else if (family === 'iron-butterfly' || family === 'butterfly') {
    setup.push('Typical selection centers the body near the target price; this is a narrow-zone strategy.')
    profitManagement[0] = 'Butterflies are judged by whether price is converging toward the body strike before expiration.'
    riskManagement.push('Small price misses can matter because the profit zone is narrow.')
  } else if (family === 'long-volatility') {
    setup.push('Typical selection uses 14-45 DTE around an event or expected move; straddles use ATM, strangles use OTM wings.')
    profitManagement[0] = 'Long-volatility trades are reviewed when realized move or IV expansion reprices the option value.'
    riskManagement.push('IV crush after an event can offset a favorable price move.')
  } else if (family === 'short-volatility') {
    setup.push('Typical selection requires high IV, margin review, and advanced risk tolerance.')
    profitManagement[0] = 'Short-volatility trades are often reviewed after roughly 40-60% of credit is captured.'
    riskManagement.push('Tail risk is uncapped; this is not suitable for fixed-budget beginner use.')
  } else if (family === 'time-spread') {
    setup.push('Typical selection sells a nearer expiry and buys a later expiry, with at least several weeks between legs.')
    profitManagement[0] = 'Max profit is variable; judge the plan by front-expiry value, IV term structure, and remaining back-leg value.'
    timeManagement[0] = 'The front expiration controls the main management date; reassess before the short leg expires.'
  }
  if (view.experience_level === 'beginner' && strategy.legs.length > 2) {
    entryChecklist.push('Beginner mode should treat this as a learning candidate unless the full risk path is understood.')
  }
  return { setup, entryChecklist, profitManagement, riskManagement, timeManagement, adjustmentTriggers }
}

function scoreStrategy(strategy: StrategyCandidate, view: ParsedView, options?: QverisOptionsResponse): StrategyCandidate {
  let score = 30
  const reasons: string[] = ['Matches selected market direction.']
  const warnings: string[] = []
  const details: StrategyRankDetail[] = [
    { category: 'target', label: 'Matches selected market direction.', impact: 'positive', value: view.view },
  ]
  const detail = (category: StrategyRankDetail['category'], label: string, impact: StrategyRankDetail['impact'], value?: string | number) =>
    details.push({ category, label, impact, value })

  const maxLoss = numericMaxLoss(strategy)
  if (view.risk_budget && maxLoss !== undefined) {
    if (maxLoss <= view.risk_budget) {
      score += 25
      reasons.push('Max loss fits the stated risk budget.')
      detail('risk', 'Max loss fits the stated risk budget.', 'positive', maxLoss)
    } else if (maxLoss <= view.risk_budget * 1.5) {
      score += 6
      warnings.push('Max loss is slightly above the stated risk budget.')
      detail('risk', 'Max loss is slightly above the stated risk budget.', 'negative', maxLoss)
    } else {
      score -= 35
      warnings.push('Max loss is above the stated risk budget.')
      detail('risk', 'Max loss is above the stated risk budget.', 'negative', maxLoss)
    }
  } else if (strategy.maxLoss === 'unlimited' || strategy.maxLoss === 'variable') {
    const penalty = view.experience_level === 'beginner' ? 45 : view.experience_level === 'intermediate' ? 24 : 10
    score -= penalty
    warnings.push('Risk is uncapped or variable and needs manual review.')
    detail('risk', 'Risk is uncapped or variable and needs manual review.', 'negative', strategy.maxLoss)
  } else if (maxLoss !== undefined) {
    score += 8
    reasons.push('Defined maximum loss.')
    detail('risk', 'Defined maximum loss.', 'positive', maxLoss)
  }

  const targetPl = typeof strategy.targetPricePl === 'number' ? strategy.targetPricePl : undefined
  if (view.target_price && targetPl !== undefined) {
    if (targetPl > 0) {
      score += 15
      reasons.push('Positive estimated P/L at the target price.')
      detail('target', 'Positive estimated P/L at the target price.', 'positive', targetPl)
    } else {
      score -= 20
      warnings.push('Estimated P/L is negative at the target price.')
      detail('target', 'Estimated P/L is negative at the target price.', 'negative', targetPl)
    }
  } else if (strategy.label === 'conditional') {
    score -= 7
    warnings.push('Conditional strategy benefits from a clearer target price.')
    detail('target', 'Conditional strategy benefits from a clearer target price.', 'neutral')
  }

  const primaryExpiry = selectExpirationCandidates(view)[0]
  const dte = strategy.expectedMove?.dte
  if (dte) {
    if (dte >= primaryExpiry.dteMin && dte <= primaryExpiry.dteMax) {
      score += 15
      reasons.push('Expiration matches the stated horizon.')
      detail('dte', 'Expiration matches the stated horizon.', 'positive', dte)
    } else if (dte >= primaryExpiry.dteMin / 2 && dte <= primaryExpiry.dteMax + 45) {
      score += 7
      detail('dte', 'Expiration is close to the stated horizon.', 'neutral', dte)
    } else {
      score -= 8
      warnings.push('Expiration is away from the stated horizon.')
      detail('dte', 'Expiration is away from the stated horizon.', 'negative', dte)
    }
  }

  if (typeof strategy.probabilityOfProfit === 'number') {
    if (strategy.probabilityOfProfit >= 65) {
      score += 10
      reasons.push('Higher probability-of-profit estimate.')
      detail('probability', 'Higher probability-of-profit estimate.', 'positive', strategy.probabilityOfProfit)
    } else if (strategy.probabilityOfProfit >= 45) {
      score += 5
      detail('probability', 'Moderate probability-of-profit estimate.', 'neutral', strategy.probabilityOfProfit)
    } else if (strategy.probabilityOfProfit < 30) {
      score -= 10
      warnings.push('Low probability-of-profit estimate.')
      detail('probability', 'Low probability-of-profit estimate.', 'negative', strategy.probabilityOfProfit)
    }
  }

  const spreadPct = averageSpreadPct(strategy, options)
  if (spreadPct !== undefined) {
    if (spreadPct <= 0.06) {
      score += 8
      reasons.push('Tighter quoted bid/ask spread.')
      detail('liquidity', 'Tighter quoted bid/ask spread.', 'positive', `${(spreadPct * 100).toFixed(1)}%`)
    } else if (spreadPct > 0.18) {
      score -= 12
      warnings.push('Wide quoted bid/ask spread.')
      detail('liquidity', 'Wide quoted bid/ask spread.', 'negative', `${(spreadPct * 100).toFixed(1)}%`)
    }
  }

  const iv = chainIv(options)
  const posture = premiumPosture(strategy)
  if (iv !== undefined) {
    if (iv >= 0.45 && posture === 'short') {
      score += 8
      reasons.push('Higher IV favors premium-selling structures.')
      detail('iv', 'Higher IV favors premium-selling structures.', 'positive', `${(iv * 100).toFixed(1)}%`)
    } else if (iv >= 0.45 && posture === 'long') {
      score -= 8
      warnings.push('High IV makes long premium more expensive.')
      detail('iv', 'High IV makes long premium more expensive.', 'negative', `${(iv * 100).toFixed(1)}%`)
    } else if (iv <= 0.25 && posture === 'long') {
      score += 6
      reasons.push('Lower IV favors long-premium structures.')
      detail('iv', 'Lower IV favors long-premium structures.', 'positive', `${(iv * 100).toFixed(1)}%`)
    } else if (iv <= 0.25 && posture === 'short') {
      score -= 6
      warnings.push('Low IV offers less premium for short-option structures.')
      detail('iv', 'Low IV offers less premium for short-option structures.', 'negative', `${(iv * 100).toFixed(1)}%`)
    }
  }

  const greeks = greekExposure(strategy, options)
  if (greeks.vega > 0.05 && iv !== undefined && iv >= 0.45) {
    score -= 6
    warnings.push('Positive vega can suffer if elevated IV contracts.')
    detail('greeks', 'Positive vega can suffer if elevated IV contracts.', 'negative', Number(greeks.vega.toFixed(3)))
  }
  if (greeks.theta < -0.05 && view.strength !== 'strong') {
    score -= 5
    warnings.push('Negative theta needs a timely move.')
    detail('greeks', 'Negative theta needs a timely move.', 'negative', Number(greeks.theta.toFixed(3)))
  }
  if (Math.abs(greeks.gamma) > 0.08 && view.experience_level === 'beginner') {
    score -= 5
    warnings.push('Higher gamma can make P/L change quickly.')
    detail('greeks', 'Higher gamma can make P/L change quickly.', 'negative', Number(greeks.gamma.toFixed(3)))
  }

  const liquidity = liquidityStats(strategy, options)
  if (liquidity !== undefined && liquidity.score < 50) {
    score -= 10
    warnings.push('Low volume/open interest may make execution harder.')
    detail('liquidity', 'Low volume/open interest may make execution harder.', 'negative', liquidity.score)
  } else if (liquidity !== undefined && liquidity.score >= 500) {
    score += 4
    detail('liquidity', 'Contract liquidity looks usable across selected legs.', 'positive', liquidity.score)
  }

  const complexity = complexityPenalty(strategy, view)
  score += complexity
  if (complexity) detail('complexity', complexity > 0 ? 'Simple structure for beginner profile.' : 'Complex structure for beginner profile.', complexity > 0 ? 'positive' : 'negative', strategy.legs.length)
  if (view.experience_level === 'beginner' && strategy.legs.length > 2) {
    warnings.push('Multi-leg structure may be harder for beginners.')
  }

  if (!view.willing_to_be_assigned && ['cash-secured-put', 'bull-put-spread'].includes(strategy.id)) {
    score -= 18
    warnings.push('Assignment-related strategy; user is not willing to be assigned.')
    detail('assignment', 'Assignment-related strategy; user is not willing to be assigned.', 'negative')
  }
  const fit: StrategyCandidate['fit'] = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low'
  return {
    ...strategy,
    fit,
    rankScore: Math.max(0, Math.min(100, Math.round(score))),
    rankReasons: reasons.slice(0, 3),
    rankWarnings: warnings.slice(0, 3),
    rankDetails: details.slice(0, 10),
    playbook: strategy.playbook ?? playbookFor(strategy, view),
  }
}

function rankStrategies(candidates: StrategyCandidate[], view: ParsedView, options?: QverisOptionsResponse) {
  return candidates
    .map((candidate) => scoreStrategy(candidate, view, options))
    .sort((a, b) =>
      (b.rankScore ?? 0) - (a.rankScore ?? 0) ||
      (b.probabilityOfProfit ?? 0) - (a.probabilityOfProfit ?? 0) ||
      (b.targetPricePl ?? Number.NEGATIVE_INFINITY) - (a.targetPricePl ?? Number.NEGATIVE_INFINITY),
    )
}

function bullCallSpread(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, buyDte)
  if (!expiry) return undefined
  const calls = contractsFor(options, 'call', expiry)
  const pair = bestCallDebitSpread(calls, view) ?? callDebitPair(calls, numericTarget(view))
  const buy = pair?.buy
  const sell = pair?.sell
  if (!buy || !sell || !buy.strike || !sell.strike) return undefined
  const legs = [leg('buy', buy), leg('sell', sell)]
  const netDebit = Number(((legs[0].premium ?? 0) - (legs[1].premium ?? 0)).toFixed(2))
  const width = sell.strike - buy.strike
  if (netDebit <= 0 || netDebit >= width) return undefined
  const maxLoss = Number((netDebit * multiplier).toFixed(0))
  const maxProfit = Number(((width - netDebit) * multiplier).toFixed(0))
  const breakeven = Number((buy.strike + netDebit).toFixed(2))
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'bull-call-spread',
    name: 'Bull Call Spread',
    label: 'best_fit',
    fit: 'high',
    legs,
    netDebitCredit: netDebit,
    maxLoss,
    maxProfit,
    breakeven,
    breakevens: [breakeven],
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, breakeven),
    whyItFits: 'Defined-risk bullish structure selected from the option chain.',
    beginnerNote: 'Max loss is capped at the net debit; upside is capped above the short call strike.',
    guardrails: ['Scenario, not prediction.', 'Check liquidity and event risk before using real capital.'],
  })
}

function longCall(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, view.time_horizon.toLowerCase().includes('long') ? leapsDte : buyDte)
  if (!expiry) return undefined
  const buy = bestLongOption(contractsFor(options, 'call', expiry), view, view.current_price)
  if (!buy || !buy.strike) return undefined
  const legs = [leg('buy', buy)]
  const premium = legs[0].premium ?? 0
  const breakeven = Number((buy.strike + premium).toFixed(2))
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'long-call',
    name: 'Long Call',
    label: 'aggressive',
    legs,
    netDebitCredit: premium,
    maxLoss: Number((premium * multiplier).toFixed(0)),
    maxProfit: 'unlimited',
    breakeven,
    breakevens: [breakeven],
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, breakeven),
    whyItFits: 'Direct bullish exposure selected near the target delta range.',
    beginnerNote: 'The full premium is at risk if the stock does not move beyond breakeven by expiration.',
    guardrails: ['Premium at risk.', 'Time decay and IV changes can hurt long calls.'],
  })
}

function bearPutSpread(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, buyDte)
  if (!expiry) return undefined
  const puts = contractsFor(options, 'put', expiry)
  const pair = bestPutDebitSpread(puts, view)
  const buy = pair?.buy
  const sell = pair?.sell
  if (!buy || !sell || !buy.strike || !sell.strike) return undefined
  const legs = [leg('buy', buy), leg('sell', sell)]
  const netDebit = Number(((legs[0].premium ?? 0) - (legs[1].premium ?? 0)).toFixed(2))
  const width = buy.strike - sell.strike
  if (netDebit <= 0 || netDebit >= width) return undefined
  const breakeven = Number((buy.strike - netDebit).toFixed(2))
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'bear-put-spread',
    name: 'Bear Put Spread',
    label: 'best_fit',
    fit: 'high',
    legs,
    netDebitCredit: netDebit,
    maxLoss: Number((netDebit * multiplier).toFixed(0)),
    maxProfit: Number(((width - netDebit) * multiplier).toFixed(0)),
    breakeven,
    breakevens: [breakeven],
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, breakeven),
    whyItFits: 'Defined-risk bearish structure selected from the option chain.',
    beginnerNote: 'Max loss is capped at the net debit; downside profit is capped below the short put strike.',
    guardrails: ['Scenario, not prediction.', 'Check liquidity and event risk before using real capital.'],
  })
}

function longPut(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, view.time_horizon.toLowerCase().includes('long') ? leapsDte : buyDte)
  if (!expiry) return undefined
  const buy = bestLongOption(contractsFor(options, 'put', expiry), view, view.current_price)
  if (!buy || !buy.strike) return undefined
  const legs = [leg('buy', buy)]
  const premium = legs[0].premium ?? 0
  const breakeven = Number((buy.strike - premium).toFixed(2))
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'long-put',
    name: 'Long Put',
    label: 'aggressive',
    legs,
    netDebitCredit: premium,
    maxLoss: Number((premium * multiplier).toFixed(0)),
    maxProfit: Number(((buy.strike - premium) * multiplier).toFixed(0)),
    breakeven,
    breakevens: [breakeven],
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, breakeven),
    whyItFits: 'Direct bearish exposure selected near the target delta range.',
    beginnerNote: 'The full premium is at risk if the stock does not move below breakeven by expiration.',
    guardrails: ['Premium at risk.', 'Time decay and IV changes can hurt long puts.'],
  })
}

function ironCondor(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, sellDte)
  if (!expiry) return undefined
  const calls = contractsFor(options, 'call', expiry)
  const puts = contractsFor(options, 'put', expiry)
  const callSpread = bestCreditSpread(calls, view, 'call')
  const putSpread = bestCreditSpread(puts, view, 'put')
  const shortCall = callSpread?.shortLeg
  const longCall = callSpread?.longLeg
  const shortPut = putSpread?.shortLeg
  const longPut = putSpread?.longLeg
  if (!shortCall?.strike || !shortPut?.strike || !longCall?.strike || !longPut?.strike) return undefined
  const legs = [leg('sell', shortPut), leg('buy', longPut), leg('sell', shortCall), leg('buy', longCall)]
  const credit = Number(
    (
      (legs[0].premium ?? 0) -
      (legs[1].premium ?? 0) +
      (legs[2].premium ?? 0) -
      (legs[3].premium ?? 0)
    ).toFixed(2),
  )
  const putWidth = shortPut.strike - longPut.strike
  const callWidth = longCall.strike - shortCall.strike
  if (credit <= 0 || credit >= Math.max(putWidth, callWidth)) return undefined
  const maxLoss = Number(((Math.max(putWidth, callWidth) - credit) * multiplier).toFixed(0))
  const maxProfit = Number((credit * multiplier).toFixed(0))
  const breakevens = [
    Number((shortPut.strike - credit).toFixed(2)),
    Number((shortCall.strike + credit).toFixed(2)),
  ]
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'iron-condor',
    name: 'Iron Condor',
    label: 'best_fit',
    fit: 'high',
    legs,
    netDebitCredit: -credit,
    maxLoss,
    maxProfit,
    breakeven: breakevens[0],
    breakevens,
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, view.current_price),
    whyItFits: 'Defined-risk neutral income structure selected around expected move.',
    beginnerNote: 'Profit is capped inside the short strikes; max loss is capped by the wings.',
    guardrails: ['Defined-risk only.', 'Short premium strategies can lose quickly when price exits the range.'],
  })
}

function ironButterfly(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, sellDte)
  if (!expiry) return undefined
  const calls = contractsFor(options, 'call', expiry)
  const puts = contractsFor(options, 'put', expiry)
  const shortCall = nearest(calls, view.current_price)
  const shortPut = nearest(puts, view.current_price)
  const longCall =
    byAbsDelta(calls.filter((contract) => (contract.strike ?? 0) > (shortCall?.strike ?? 0)), 0.03, 0.08, view.current_price * 1.05)
  const longPut =
    byAbsDelta(puts.filter((contract) => (contract.strike ?? 0) < (shortPut?.strike ?? 0)), 0.03, 0.08, view.current_price * 0.95)
  if (!shortCall?.strike || !shortPut?.strike || !longCall?.strike || !longPut?.strike) return undefined
  const legs = [leg('sell', shortPut), leg('buy', longPut), leg('sell', shortCall), leg('buy', longCall)]
  const credit = Number(
    (
      (legs[0].premium ?? 0) -
      (legs[1].premium ?? 0) +
      (legs[2].premium ?? 0) -
      (legs[3].premium ?? 0)
    ).toFixed(2),
  )
  const wingWidth = Math.max(shortPut.strike - longPut.strike, longCall.strike - shortCall.strike)
  if (credit <= 0 || credit >= wingWidth) return undefined
  const breakevens = [
    Number((shortPut.strike - credit).toFixed(2)),
    Number((shortCall.strike + credit).toFixed(2)),
  ]
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'iron-butterfly',
    name: 'Iron Butterfly',
    label: 'conservative',
    legs,
    netDebitCredit: -credit,
    maxLoss: Number(((wingWidth - credit) * multiplier).toFixed(0)),
    maxProfit: Number((credit * multiplier).toFixed(0)),
    breakeven: breakevens[0],
    breakevens,
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, view.current_price),
    whyItFits: 'Tighter neutral structure when the view expects price to pin near current levels.',
    beginnerNote: 'Reward is highest near the short strike; losses grow outside the wings.',
    guardrails: ['Defined-risk only.', 'Requires tighter monitoring than a wider condor.'],
  })
}

function longStraddle(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, eventDte)
  if (!expiry) return undefined
  const call = nearest(contractsFor(options, 'call', expiry), view.current_price)
  const put = nearest(contractsFor(options, 'put', expiry), view.current_price)
  if (!call?.strike || !put?.strike) return undefined
  const legs = [leg('buy', call), leg('buy', put)]
  const debit = Number(((legs[0].premium ?? 0) + (legs[1].premium ?? 0)).toFixed(2))
  const center = (call.strike + put.strike) / 2
  const breakevens = [Number((center - debit).toFixed(2)), Number((center + debit).toFixed(2))]
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'long-straddle',
    name: 'Long Straddle',
    label: 'best_fit',
    fit: 'high',
    legs,
    netDebitCredit: debit,
    maxLoss: Number((debit * multiplier).toFixed(0)),
    maxProfit: 'unlimited',
    breakeven: breakevens[0],
    breakevens,
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, view.current_price),
    whyItFits: 'Premium-risk volatility structure that benefits from a large move either way.',
    beginnerNote: 'The full debit is at risk if price does not move beyond either breakeven.',
    guardrails: ['Premium at risk.', 'Needs a move larger than the priced premium.'],
  })
}

function longStrangle(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, eventDte)
  if (!expiry) return undefined
  const call = byAbsDelta(contractsFor(options, 'call', expiry), 0.2, 0.35, view.current_price * 1.05)
  const put = byAbsDelta(contractsFor(options, 'put', expiry), 0.2, 0.35, view.current_price * 0.95)
  if (!call?.strike || !put?.strike) return undefined
  const legs = [leg('buy', call), leg('buy', put)]
  const debit = Number(((legs[0].premium ?? 0) + (legs[1].premium ?? 0)).toFixed(2))
  const breakevens = [Number((put.strike - debit).toFixed(2)), Number((call.strike + debit).toFixed(2))]
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'long-strangle',
    name: 'Long Strangle',
    label: 'aggressive',
    legs,
    netDebitCredit: debit,
    maxLoss: Number((debit * multiplier).toFixed(0)),
    maxProfit: 'unlimited',
    breakeven: breakevens[0],
    breakevens,
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, view.current_price),
    whyItFits: 'Lower-debit volatility structure that needs a larger move than a straddle.',
    beginnerNote: 'Cheaper than a straddle, but breakevens are farther away.',
    guardrails: ['Premium at risk.', 'Liquidity can be thinner away from the money.'],
  })
}

function bullPutSpread(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, sellDte)
  if (!expiry) return undefined
  const puts = contractsFor(options, 'put', expiry)
  const pair = bestCreditSpread(puts, view, 'put')
  const sell = pair?.shortLeg
  const buy = pair?.longLeg
  if (!buy?.strike || !sell?.strike) return undefined
  const legs = [leg('sell', sell), leg('buy', buy)]
  const credit = Number(((legs[0].premium ?? 0) - (legs[1].premium ?? 0)).toFixed(2))
  const width = sell.strike - buy.strike
  if (credit <= 0 || credit >= width) return undefined
  const breakeven = Number((sell.strike - credit).toFixed(2))
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'bull-put-spread',
    name: 'Bull Put Spread',
    label: 'conservative',
    legs,
    netDebitCredit: -credit,
    maxLoss: Number(((width - credit) * multiplier).toFixed(0)),
    maxProfit: Number((credit * multiplier).toFixed(0)),
    breakeven,
    breakevens: [breakeven],
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, breakeven),
    whyItFits: 'Defined-risk bullish credit spread that can profit if price stays above the short put.',
    beginnerNote: 'You receive a credit upfront, but max loss is the spread width minus that credit.',
    guardrails: ['Defined-risk only.', 'Assignment risk exists before expiration on short puts.'],
  })
}

function bearCallSpread(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, sellDte)
  if (!expiry) return undefined
  const calls = contractsFor(options, 'call', expiry)
  const pair = bestCreditSpread(calls, view, 'call')
  const sell = pair?.shortLeg
  const buy = pair?.longLeg
  if (!buy?.strike || !sell?.strike) return undefined
  const legs = [leg('sell', sell), leg('buy', buy)]
  const credit = Number(((legs[0].premium ?? 0) - (legs[1].premium ?? 0)).toFixed(2))
  const width = buy.strike - sell.strike
  if (credit <= 0 || credit >= width) return undefined
  const breakeven = Number((sell.strike + credit).toFixed(2))
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'bear-call-spread',
    name: 'Bear Call Spread',
    label: 'conservative',
    legs,
    netDebitCredit: -credit,
    maxLoss: Number(((width - credit) * multiplier).toFixed(0)),
    maxProfit: Number((credit * multiplier).toFixed(0)),
    breakeven,
    breakevens: [breakeven],
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, breakeven),
    whyItFits: 'Defined-risk bearish credit spread that can profit if price stays below the short call.',
    beginnerNote: 'You receive a credit upfront, but max loss is the spread width minus that credit.',
    guardrails: ['Defined-risk only.', 'Assignment risk exists before expiration on short calls.'],
  })
}

function cashSecuredPut(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, sellDte)
  if (!expiry) return undefined
  const sell = byAbsDelta(contractsFor(options, 'put', expiry), 0.2, 0.35, view.current_price * 0.97)
  if (!sell?.strike) return undefined
  const legs = [leg('sell', sell)]
  const premium = legs[0].premium ?? 0
  const breakeven = Number((sell.strike - premium).toFixed(2))
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'cash-secured-put',
    name: 'Cash-Secured Put',
    label: 'conservative',
    legs,
    netDebitCredit: -premium,
    maxLoss: Number(((sell.strike - premium) * multiplier).toFixed(0)),
    maxProfit: Number((premium * multiplier).toFixed(0)),
    breakeven,
    breakevens: [breakeven],
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, breakeven),
    whyItFits: 'Bullish income structure for investors willing to buy shares if assigned.',
    beginnerNote: 'Cash must be reserved because assignment can require buying 100 shares per contract.',
    guardrails: ['Requires cash for assignment.', 'Loss behaves like owning shares below breakeven.'],
  })
}

function shortStraddle(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, sellDte)
  if (!expiry) return undefined
  const call = nearest(contractsFor(options, 'call', expiry), view.current_price)
  const put = nearest(contractsFor(options, 'put', expiry), view.current_price)
  if (!call?.strike || !put?.strike) return undefined
  const legs = [leg('sell', call), leg('sell', put)]
  const credit = Number(((legs[0].premium ?? 0) + (legs[1].premium ?? 0)).toFixed(2))
  const center = (call.strike + put.strike) / 2
  const breakevens = [Number((center - credit).toFixed(2)), Number((center + credit).toFixed(2))]
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'short-straddle',
    name: 'Short Straddle',
    label: 'aggressive',
    fit: 'low',
    legs,
    netDebitCredit: -credit,
    maxLoss: 'unlimited',
    maxProfit: Number((credit * multiplier).toFixed(0)),
    breakeven: breakevens[0],
    breakevens,
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, view.current_price),
    whyItFits: 'Neutral short-volatility strategy that benefits from price staying near the strike.',
    beginnerNote: 'Loss can become very large if the stock moves sharply in either direction.',
    guardrails: ['Uncapped risk.', 'Short volatility can lose quickly around events.'],
  })
}

function shortStrangle(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, sellDte)
  if (!expiry) return undefined
  const call = byAbsDelta(contractsFor(options, 'call', expiry), 0.2, 0.35, view.current_price * 1.05)
  const put = byAbsDelta(contractsFor(options, 'put', expiry), 0.2, 0.35, view.current_price * 0.95)
  if (!call?.strike || !put?.strike) return undefined
  const legs = [leg('sell', call), leg('sell', put)]
  const credit = Number(((legs[0].premium ?? 0) + (legs[1].premium ?? 0)).toFixed(2))
  const breakevens = [Number((put.strike - credit).toFixed(2)), Number((call.strike + credit).toFixed(2))]
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'short-strangle',
    name: 'Short Strangle',
    label: 'aggressive',
    fit: 'low',
    legs,
    netDebitCredit: -credit,
    maxLoss: 'unlimited',
    maxProfit: Number((credit * multiplier).toFixed(0)),
    breakeven: breakevens[0],
    breakevens,
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, view.current_price),
    whyItFits: 'Neutral short-volatility strategy with wider breakevens than a short straddle.',
    beginnerNote: 'The wider range comes with uncapped tail risk on both sides.',
    guardrails: ['Uncapped risk.', 'Margin and event risk must be checked before real trading.'],
  })
}

function longCallButterfly(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, sellDte)
  if (!expiry) return undefined
  const calls = contractsFor(options, 'call', expiry)
  const parts = longButterflyParts(calls, view.view === 'bullish' ? numericTarget(view) : view.current_price)
  if (!parts) return undefined
  const middle = parts.middle
  const lower = parts.lower
  const upper = parts.upper
  if (!lower?.strike || !middle?.strike || !upper?.strike) return undefined
  const shortMiddle = leg('sell', middle)
  shortMiddle.quantity = 2
  const legs = [leg('buy', lower), shortMiddle, leg('buy', upper)]
  const debit = parts.debit
  const wing = parts.wing
  const breakevens = [Number((lower.strike + debit).toFixed(2)), Number((upper.strike - debit).toFixed(2))]
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'long-call-butterfly',
    name: 'Long Call Butterfly',
    label: 'conditional',
    legs,
    netDebitCredit: debit,
    maxLoss: Number((debit * multiplier).toFixed(0)),
    maxProfit: Number(((wing - debit) * multiplier).toFixed(0)),
    breakeven: breakevens[0],
    breakevens,
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, middle.strike),
    whyItFits: 'Low-debit bullish-to-neutral structure that works best near the middle call strike.',
    beginnerNote: 'Max profit requires price to finish near the center strike at expiration.',
    guardrails: ['Narrow profit zone.', 'Use liquid strikes because this is a three-leg structure.'],
  })
}

function longPutButterfly(
  view: ParsedView,
  options: QverisOptionsResponse,
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const expiry = expiration(options, preferredExpiration, sellDte)
  if (!expiry) return undefined
  const puts = contractsFor(options, 'put', expiry)
  const parts = longButterflyParts(puts, view.view === 'bearish' ? numericTarget(view) : view.current_price)
  if (!parts) return undefined
  const middle = parts.middle
  const lower = parts.lower
  const upper = parts.upper
  if (!lower?.strike || !middle?.strike || !upper?.strike) return undefined
  const shortMiddle = leg('sell', middle)
  shortMiddle.quantity = 2
  const legs = [leg('buy', lower), shortMiddle, leg('buy', upper)]
  const debit = parts.debit
  const wing = parts.wing
  const breakevens = [Number((lower.strike + debit).toFixed(2)), Number((upper.strike - debit).toFixed(2))]
  const move = expectedMove(options, expiry, view.current_price)
  return contractCandidate({
    id: 'long-put-butterfly',
    name: 'Long Put Butterfly',
    label: 'conditional',
    legs,
    netDebitCredit: debit,
    maxLoss: Number((debit * multiplier).toFixed(0)),
    maxProfit: Number(((wing - debit) * multiplier).toFixed(0)),
    breakeven: breakevens[0],
    breakevens,
    expectedMove: move,
    probabilityOfProfit: probabilityOfProfit(legs, view.current_price, move.impliedVolatility, move.dte),
    targetPricePl: strategyPayoff(legs, numericTarget(view)),
    scenarioRows: scenarioRows(view, legs, middle.strike),
    whyItFits: 'Low-debit bearish-to-neutral structure that works best near the middle put strike.',
    beginnerNote: 'Max profit requires price to finish near the center strike at expiration.',
    guardrails: ['Narrow profit zone.', 'Use liquid strikes because this is a three-leg structure.'],
  })
}

function calendarSpread(
  view: ParsedView,
  options: QverisOptionsResponse,
  right: 'call' | 'put',
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const front = expiration(options, preferredExpiration, eventDte)
  const back = front ? laterExpiration(options, front) : undefined
  if (!front || !back) return undefined
  const frontLeg = nearest(contractsFor(options, right, front), view.current_price)
  const backLeg = nearest(contractsFor(options, right, back), frontLeg?.strike ?? view.current_price)
  if (!frontLeg?.strike || !backLeg?.strike) return undefined
  const legs = [leg('sell', frontLeg), leg('buy', backLeg)]
  const debit = Number(((legs[1].premium ?? 0) - (legs[0].premium ?? 0)).toFixed(2))
  if (debit <= 0) return undefined
  const move = expectedMove(options, front, view.current_price)
  const label = right === 'call' ? 'Call Calendar Spread' : 'Put Calendar Spread'
  return contractCandidate({
    id: right === 'call' ? 'call-calendar-spread' : 'put-calendar-spread',
    name: label,
    label: 'conditional',
    legs,
    netDebitCredit: debit,
    maxLoss: Number((debit * multiplier).toFixed(0)),
    maxProfit: 'variable',
    breakeven: frontLeg.strike,
    breakevens: [frontLeg.strike],
    expectedMove: move,
    whyItFits: 'Time-spread structure that sells nearer-term premium and owns later-term optionality.',
    beginnerNote: 'Maximum profit is variable because the back-month option still has time value when the front leg expires.',
    guardrails: ['Variable max profit.', 'Calendar spreads are sensitive to IV term structure.'],
  })
}

function diagonalSpread(
  view: ParsedView,
  options: QverisOptionsResponse,
  right: 'call' | 'put',
  preferredExpiration?: string,
): StrategyCandidate | undefined {
  const front = expiration(options, preferredExpiration, eventDte)
  const back = front ? laterExpiration(options, front) : undefined
  if (!front || !back) return undefined
  const frontContracts = contractsFor(options, right, front)
  const backContracts = contractsFor(options, right, back)
  const shortFront = right === 'call'
    ? byAbsDelta(frontContracts, 0.2, 0.35, view.current_price * 1.04)
    : byAbsDelta(frontContracts, 0.2, 0.35, view.current_price * 0.96)
  const longBack = nearest(backContracts, view.current_price)
  if (!shortFront?.strike || !longBack?.strike) return undefined
  const legs = [leg('sell', shortFront), leg('buy', longBack)]
  const debit = Number(((legs[1].premium ?? 0) - (legs[0].premium ?? 0)).toFixed(2))
  if (debit <= 0) return undefined
  const move = expectedMove(options, front, view.current_price)
  const label = right === 'call' ? 'Call Diagonal Spread' : 'Put Diagonal Spread'
  return contractCandidate({
    id: right === 'call' ? 'call-diagonal-spread' : 'put-diagonal-spread',
    name: label,
    label: 'conditional',
    legs,
    netDebitCredit: debit,
    maxLoss: Number((debit * multiplier).toFixed(0)),
    maxProfit: 'variable',
    breakeven: shortFront.strike,
    breakevens: [shortFront.strike],
    expectedMove: move,
    whyItFits: 'Diagonal time spread that combines a directional lean with term-structure exposure.',
    beginnerNote: 'Profit is variable because strikes and expirations are both different.',
    guardrails: ['Variable max profit.', 'Sensitive to IV changes and strike selection.'],
  })
}

export function recommendStrategyTypes(
  view: ParsedView,
  options?: QverisOptionsResponse,
  preferredExpiration?: string,
  settings: { rank?: boolean } = {},
): StrategyCandidate[] {
  const rank = settings.rank ?? true
  const finish = (candidates: StrategyCandidate[]) => (rank ? rankStrategies(candidates, view, options) : candidates)
  const hasChain = options?.status === 'available' && options.contracts.length > 0
  if (hasChain && options) {
    const contractCandidates =
      view.view === 'bearish'
        ? [
            longPut(view, options, preferredExpiration),
            bearPutSpread(view, options, preferredExpiration),
            bearCallSpread(view, options, preferredExpiration),
            longPutButterfly(view, options, preferredExpiration),
          ]
        : view.view === 'neutral'
          ? [
              ironCondor(view, options, preferredExpiration),
              ironButterfly(view, options, preferredExpiration),
              longCallButterfly(view, options, preferredExpiration),
              longPutButterfly(view, options, preferredExpiration),
              shortStrangle(view, options, preferredExpiration),
              shortStraddle(view, options, preferredExpiration),
            ]
          : view.view === 'volatile'
            ? [
                longStraddle(view, options, preferredExpiration),
                longStrangle(view, options, preferredExpiration),
                calendarSpread(view, options, 'call', preferredExpiration),
                calendarSpread(view, options, 'put', preferredExpiration),
                diagonalSpread(view, options, 'call', preferredExpiration),
                diagonalSpread(view, options, 'put', preferredExpiration),
              ]
            : [
                longCall(view, options, preferredExpiration),
                bullCallSpread(view, options, preferredExpiration),
                cashSecuredPut(view, options, preferredExpiration),
                bullPutSpread(view, options, preferredExpiration),
                longCallButterfly(view, options, preferredExpiration),
              ]
    const ready = finish(contractCandidates.filter((item): item is StrategyCandidate => Boolean(item)))
    if (ready.length) return ready
  }

  const commonGuardrails = [
    'Scenario, not prediction.',
    'Contract-level legs require a live option chain.',
  ]

  if (view.view === 'bearish') {
    return finish([
      educationCandidate({
        id: 'long-put',
        name: 'Long Put',
        label: 'aggressive',
        whyItFits: 'Direct bearish convex exposure with premium at risk.',
        beginnerNote: 'The full premium can be lost if the stock does not move below breakeven by expiration.',
        guardrails: [...commonGuardrails, 'Time decay and IV changes can hurt long puts.'],
      }),
      educationCandidate({
        id: 'bear-put-spread',
        name: 'Bear Put Spread',
        label: 'best_fit',
        fit: 'high',
        whyItFits: 'Defined-risk bearish structure for a moderate downside view.',
        beginnerNote: 'A spread caps both loss and profit, which can be easier to understand than naked short options.',
        guardrails: [...commonGuardrails, 'Downside profit is capped below the short put strike.'],
      }),
      educationCandidate({
        id: 'bear-call-spread',
        name: 'Bear Call Spread',
        label: 'conservative',
        whyItFits: 'Collects a credit by selling a call spread above the current price on a bearish view.',
        beginnerNote: 'You keep the full credit if the stock stays below the short call strike.',
        guardrails: [...commonGuardrails, 'Maximum loss is capped at the spread width minus the credit received.'],
      }),
      educationCandidate({
        id: 'long-put-butterfly',
        name: 'Long Put Butterfly',
        label: 'conditional',
        whyItFits: 'Low-cost bearish structure that profits most if price lands near the short put strike.',
        beginnerNote: 'Best used when you have a precise downside price target for expiration.',
        guardrails: [...commonGuardrails, 'Very narrow profit zone; requires accurate target.'],
      }),
    ])
  }

  if (view.view === 'neutral') {
    return finish([
      educationCandidate({
        id: 'iron-condor',
        name: 'Iron Condor',
        label: 'best_fit',
        fit: 'high',
        whyItFits: 'Defined-risk neutral structure for a range-bound view.',
        beginnerNote: 'Profit is capped inside the short strikes; losses are capped by the wings.',
        guardrails: [...commonGuardrails, 'Short premium can lose quickly outside the expected range.'],
      }),
      educationCandidate({
        id: 'iron-butterfly',
        name: 'Iron Butterfly',
        label: 'conservative',
        whyItFits: 'Tighter neutral structure when price is expected to stay near the current level.',
        beginnerNote: 'Higher pin risk and narrower profit zone than a wider condor.',
        guardrails: [...commonGuardrails, 'Requires tighter monitoring than wide range structures.'],
      }),
      educationCandidate({
        id: 'long-call-butterfly',
        name: 'Long Call Butterfly',
        label: 'conditional',
        whyItFits: 'Low-cost neutral structure that profits most if price stays near the short strikes.',
        beginnerNote: 'Low cost and defined risk, but requires a precise price target.',
        guardrails: [...commonGuardrails, 'Very sensitive to pin risk; profits only in a narrow range.'],
      }),
      educationCandidate({
        id: 'long-put-butterfly-neutral',
        name: 'Long Put Butterfly',
        label: 'conditional',
        whyItFits: 'Put-side equivalent of the call butterfly; same risk/reward structure.',
        beginnerNote: 'Constructed with puts instead of calls but behaves similarly to a call butterfly.',
        guardrails: [...commonGuardrails, 'Narrow profit zone; best with a precise expiration price target.'],
      }),
      educationCandidate({
        id: 'short-strangle',
        name: 'Short Strangle',
        label: 'aggressive',
        whyItFits: 'Wider OTM version of a short straddle; lower premium but bigger buffer.',
        beginnerNote: 'Wider breakevens than a straddle, but still carries unlimited directional risk.',
        guardrails: [...commonGuardrails, 'Assignment risk increases if either short strike is breached.'],
      }),
      educationCandidate({
        id: 'short-straddle',
        name: 'Short Straddle',
        label: 'aggressive',
        whyItFits: 'Sells an ATM call and put to collect maximum premium in a flat market.',
        beginnerNote: 'Profits if the stock barely moves; large moves in either direction cause losses.',
        guardrails: [...commonGuardrails, 'Unlimited risk; requires active management.'],
      }),
    ])
  }

  if (view.view === 'volatile') {
    return finish([
      educationCandidate({
        id: 'long-straddle',
        name: 'Long Straddle',
        label: 'best_fit',
        fit: 'high',
        whyItFits: 'Premium-risk structure for a large move in either direction.',
        beginnerNote: 'The full debit is at risk if the move is too small or too slow.',
        guardrails: [...commonGuardrails, 'Needs realized move to exceed priced premium.'],
      }),
      educationCandidate({
        id: 'long-strangle',
        name: 'Long Strangle',
        label: 'aggressive',
        whyItFits: 'Lower-debit volatility structure with wider breakevens.',
        beginnerNote: 'Cheaper entry, but needs a bigger move than a straddle.',
        guardrails: [...commonGuardrails, 'Away-from-money liquidity may be weaker.'],
      }),
      educationCandidate({
        id: 'call-calendar-spread',
        name: 'Call Calendar Spread',
        label: 'conservative',
        whyItFits: 'Sells near-term volatility and buys later-dated exposure at the same strike.',
        beginnerNote: 'Profits from time decay differential between the two expirations.',
        guardrails: [...commonGuardrails, 'Requires two expirations; front-month expiry changes risk profile.'],
      }),
      educationCandidate({
        id: 'put-calendar-spread',
        name: 'Put Calendar Spread',
        label: 'conservative',
        whyItFits: 'Put-side calendar; similar time-decay play with a slight downside tilt.',
        beginnerNote: 'Same mechanics as a call calendar but uses puts.',
        guardrails: [...commonGuardrails, 'Assignment risk on the short front-month put if deep ITM.'],
      }),
      educationCandidate({
        id: 'call-diagonal-spread',
        name: 'Call Diagonal Spread',
        label: 'conditional',
        whyItFits: 'Like a calendar but with different strikes; adds directional bias to the time play.',
        beginnerNote: 'More flexible than a calendar but requires understanding both strike and expiry.',
        guardrails: [...commonGuardrails, 'Two-dimensional risk: both strike selection and expiry timing matter.'],
      }),
      educationCandidate({
        id: 'put-diagonal-spread',
        name: 'Put Diagonal Spread',
        label: 'conditional',
        whyItFits: 'Put-side diagonal; time decay play with a bearish directional tilt.',
        beginnerNote: 'Combines calendar and spread mechanics; complex for beginners.',
        guardrails: [...commonGuardrails, 'Put assignment risk on the short leg if deeply in the money.'],
      }),
    ])
  }

  return finish([
    educationCandidate({
      id: 'long-call',
      name: 'Long Call',
      label: 'aggressive',
      whyItFits: 'Direct bullish convex exposure with premium at risk.',
      beginnerNote: 'A correct direction can still lose if the move is too small or too slow.',
      guardrails: [...commonGuardrails, 'Time decay and IV changes can hurt long calls.'],
    }),
    educationCandidate({
      id: 'bull-call-spread',
      name: 'Bull Call Spread',
      label: 'best_fit',
      fit: 'high',
      whyItFits: 'Defined-risk bullish structure for a mild-to-moderate upside view.',
      beginnerNote: 'Max loss is capped at the net debit once real contracts are selected.',
      guardrails: [...commonGuardrails, 'Upside is capped above the short call strike.'],
    }),
    educationCandidate({
      id: 'cash-secured-put',
      name: 'Cash-Secured Put',
      label: 'conservative',
      whyItFits: 'Collects premium for agreeing to buy the stock at a lower price.',
      beginnerNote: 'You must have cash reserved to buy 100 shares if assigned.',
      guardrails: [...commonGuardrails, 'Assignment risk increases when stock falls below the short put strike.'],
    }),
    educationCandidate({
      id: 'bull-put-spread',
      name: 'Bull Put Spread',
      label: 'conservative',
      whyItFits: 'Sells a put spread below current price to collect premium on a bullish view.',
      beginnerNote: 'You keep the credit if the stock stays above the short put strike.',
      guardrails: [...commonGuardrails, 'Maximum loss occurs if price falls below the long put strike.'],
    }),
    educationCandidate({
      id: 'long-call-butterfly',
      name: 'Long Call Butterfly',
      label: 'conditional',
      whyItFits: 'Low-cost bullish structure that profits most if price lands near the short strike.',
      beginnerNote: 'Best used when you have a precise price target for expiration.',
      guardrails: [...commonGuardrails, 'Very sensitive to pin risk; wide breakevens reduce probability.'],
    }),
  ])
}
