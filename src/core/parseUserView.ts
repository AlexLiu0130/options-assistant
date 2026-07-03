import type { ParsedView, UserInput } from '../types/strategyTypes'

export function parseUserView(input: UserInput): ParsedView {
  const assumptions: string[] = []
  const missing_fields: string[] = []
  const ticker = input.ticker.trim().toUpperCase()
  const strength = input.strength ?? 'moderate'
  const experience_level = input.experience_level ?? 'beginner'
  const owns_shares = input.owns_shares ?? false
  const willing_to_be_assigned = input.willing_to_be_assigned ?? false
  const event_context = input.event_context ?? 'unknown'
  const time_horizon = input.time_horizon?.trim() || '1 month'

  if (!input.strength) assumptions.push('Strength defaults to moderate.')
  if (!input.experience_level) assumptions.push('Experience level defaults to beginner.')
  if (input.owns_shares === undefined) assumptions.push('Share ownership defaults to no.')
  if (input.willing_to_be_assigned === undefined) {
    assumptions.push('Assignment willingness defaults to no.')
  }
  if (!input.event_context) assumptions.push('Event context defaults to unknown.')
  if (!input.time_horizon) assumptions.push('Time horizon defaults to 1 month.')
  if (!input.target_price) missing_fields.push('target_price')
  if (!input.risk_budget) missing_fields.push('risk_budget')

  return {
    ...input,
    ticker,
    strength,
    time_horizon,
    owns_shares,
    willing_to_be_assigned,
    experience_level,
    event_context,
    assumptions,
    missing_fields,
  }
}
