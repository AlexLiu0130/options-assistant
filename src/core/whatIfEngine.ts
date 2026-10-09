// What-if repricing for the assistant: Black-Scholes values a strategy under a different stock price,
// a later date and/or a shifted implied volatility, so "IV 降 5 个点" or "两周后到 240" gets a number
// and a direction instead of a guess. Results are model estimates, not quotes.
import { OPTION_MULTIPLIER, strategyEntryValue } from './payoffEngine.ts'
import { optionTheoreticalPrice } from './simulatorEngine.ts'
import type { StrategyLeg } from '../types/strategyTypes'

type StrategyLike = { id?: string; name?: string; legs?: StrategyLeg[] }

export type WhatIfInput = {
  spot: number
  price?: number
  daysForward?: number
  ivShiftPoints?: number
  now?: number
}

export type WhatIfLeg = {
  leg: string
  ivPercent?: number
  valueNow: number
  valueThen: number
  change: number
}

export type WhatIfResult = {
  price: number
  daysForward: number
  ivShiftPoints: number
  daysToExpiry: number
  valueNow: number
  valueThen: number
  entryValue: number
  changeFromNow: number
  plVsEntry: number
  legs: WhatIfLeg[]
}

const MIN_IV = 0.01

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits))
}

function expiryMs(leg: StrategyLeg) {
  return Date.parse(`${leg.expiration}T21:00:00Z`)
}

export function daysToFirstExpiry(legs: StrategyLeg[], now = Date.now()) {
  const first = legs.map(expiryMs).filter(Number.isFinite).sort((a, b) => a - b)[0]
  return first === undefined ? 0 : Math.max(0, (first - now) / 86_400_000)
}

function legLabel(leg: StrategyLeg) {
  return `${leg.action} ${leg.quantity} ${leg.strike} ${leg.right} ${leg.expiration}`
}

// Signed dollar value of one leg (long +, short -) at a price, days from now and IV shift.
function legValue(leg: StrategyLeg, price: number, daysFromNow: number, ivShift: number, now: number) {
  const years = Math.max(0, (expiryMs(leg) - now) / 86_400_000 - daysFromNow) / 365
  const iv = Math.max(MIN_IV, (leg.impliedVolatility ?? 0.35) + ivShift)
  const value = optionTheoreticalPrice({ ...leg, impliedVolatility: iv }, price, years) * leg.quantity * OPTION_MULTIPLIER
  return leg.action === 'buy' ? value : -value
}

export function whatIfStrategy(strategy: StrategyLike, input: WhatIfInput): WhatIfResult | undefined {
  const legs = strategy?.legs ?? []
  if (!legs.length || !(input.spot > 0)) return undefined
  const now = input.now ?? Date.now()
  const daysToExpiry = daysToFirstExpiry(legs, now)
  const price = input.price && input.price > 0 ? input.price : input.spot
  const daysForward = Math.min(Math.max(0, input.daysForward ?? 0), daysToExpiry)
  const ivShiftPoints = input.ivShiftPoints ?? 0
  const rows = legs.map((leg) => {
    const valueNow = legValue(leg, input.spot, 0, 0, now)
    const valueThen = legValue(leg, price, daysForward, ivShiftPoints / 100, now)
    return {
      leg: legLabel(leg),
      ivPercent: typeof leg.impliedVolatility === 'number' ? round(leg.impliedVolatility * 100, 1) : undefined,
      valueNow: round(valueNow),
      valueThen: round(valueThen),
      change: round(valueThen - valueNow),
    }
  })
  const valueNow = rows.reduce((sum, row) => sum + row.valueNow, 0)
  const valueThen = rows.reduce((sum, row) => sum + row.valueThen, 0)
  const entryValue = strategyEntryValue(legs)
  return {
    price: round(price),
    daysForward: round(daysForward, 1),
    ivShiftPoints,
    daysToExpiry: round(daysToExpiry, 1),
    valueNow: round(valueNow),
    valueThen: round(valueThen),
    entryValue,
    changeFromNow: round(valueThen - valueNow),
    plVsEntry: round(valueThen - entryValue),
    legs: rows,
  }
}

export type Effect = 'helps' | 'hurts' | 'flat'

export type StrategySensitivity = {
  ivDown5: number
  ivUp5: number
  sevenDaysPass?: number
  priceDown5Percent: number
  priceUp5Percent: number
  ivDown5ByLeg: { leg: string; change: number }[]
  effects: {
    ivUp: Effect
    ivDown: Effect
    timePassing: Effect
    priceUp: Effect
    priceDown: Effect
  }
}

function effect(change: number, scale: number): Effect {
  // Changes under 1% of the position's scale (or $1) are noise, not a direction.
  const threshold = Math.max(1, scale * 0.01)
  return change > threshold ? 'helps' : change < -threshold ? 'hurts' : 'flat'
}

/** Model P/L change from today for standard shocks: IV ±5 points, 7 calendar days, stock ±5%. */
export function strategySensitivity(strategy: StrategyLike, spot: number, now = Date.now()): StrategySensitivity | undefined {
  const legs = strategy?.legs ?? []
  if (!legs.length || !(spot > 0)) return undefined
  const ivDown = whatIfStrategy(strategy, { spot, ivShiftPoints: -5, now })
  const ivUp = whatIfStrategy(strategy, { spot, ivShiftPoints: 5, now })
  const days = daysToFirstExpiry(legs, now)
  const week = days > 7 ? whatIfStrategy(strategy, { spot, daysForward: 7, now }) : undefined
  const down = whatIfStrategy(strategy, { spot, price: spot * 0.95, now })
  const up = whatIfStrategy(strategy, { spot, price: spot * 1.05, now })
  if (!ivDown || !ivUp || !down || !up) return undefined
  const scale = Math.max(Math.abs(ivDown.entryValue), ...legs.map((leg) => (leg.premium ?? 0) * leg.quantity * OPTION_MULTIPLIER))
  return {
    ivDown5: ivDown.changeFromNow,
    ivUp5: ivUp.changeFromNow,
    sevenDaysPass: week?.changeFromNow,
    priceDown5Percent: down.changeFromNow,
    priceUp5Percent: up.changeFromNow,
    ivDown5ByLeg: ivDown.legs.map((row) => ({ leg: row.leg, change: row.change })),
    effects: {
      ivUp: effect(ivUp.changeFromNow, scale),
      ivDown: effect(ivDown.changeFromNow, scale),
      timePassing: week ? effect(week.changeFromNow, scale) : 'flat',
      priceUp: effect(up.changeFromNow, scale),
      priceDown: effect(down.changeFromNow, scale),
    },
  }
}
