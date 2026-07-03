import type { ExpirationCandidate, ParsedView } from '../types/strategyTypes'

function horizonBand(horizon: string): [number, number, string] {
  const text = horizon.toLowerCase()
  if (text.includes('today') || text.includes('0dte')) return [0, 0, 'Very short-dated request.']
  if (text.includes('week') && (text.includes('2') || text.includes('3') || text.includes('4'))) {
    return [21, 45, 'Two-to-four-week horizon.']
  }
  if (text.includes('week')) return [14, 30, 'Weekly horizon.']
  if (text.includes('3 month') || text.includes('quarter')) return [60, 120, 'Medium-term horizon.']
  if (text.includes('6') || text.includes('year') || text.includes('long')) return [180, 365, 'Longer-term horizon.']
  if (text.includes('1 month') || text.includes('month')) return [30, 60, 'One-month horizon.']
  return [30, 60, 'Normal directional trade horizon.']
}

function daysToExpiry(expiry: string, now = Date.now()) {
  const end = new Date(`${expiry}T21:00:00Z`).getTime()
  return Math.max(1, Math.round((end - now) / 86_400_000))
}

export function selectDefaultExpiration(expirations: string[], view: ParsedView, now = Date.now()) {
  const available = [...new Set(expirations.filter(Boolean))].sort()
  if (!available.length) return undefined
  for (const candidate of selectExpirationCandidates(view)) {
    const midpoint = (candidate.dteMin + candidate.dteMax) / 2
    const inBand = available.filter((expiry) => {
      const dte = daysToExpiry(expiry, now)
      return dte >= candidate.dteMin && dte <= candidate.dteMax
    })
    if (inBand.length) {
      return inBand.sort((a, b) => Math.abs(daysToExpiry(a, now) - midpoint) - Math.abs(daysToExpiry(b, now) - midpoint))[0]
    }
  }
  const primary = selectExpirationCandidates(view)[0]
  const midpoint = (primary.dteMin + primary.dteMax) / 2
  return available.sort((a, b) => Math.abs(daysToExpiry(a, now) - midpoint) - Math.abs(daysToExpiry(b, now) - midpoint))[0]
}

export function selectExpirationCandidates(view: ParsedView): ExpirationCandidate[] {
  const [dteMin, dteMax, reason] = horizonBand(view.time_horizon)
  const warnings: string[] = []

  if (view.experience_level === 'beginner' && dteMax <= 7) {
    warnings.push('Beginner flow does not default to 0DTE or very short-dated options.')
  }
  if (view.event_context === 'earnings') {
    warnings.push('Earnings before expiration can create gap risk and IV crush.')
  }

  const primaryMin = Math.max(dteMin, view.experience_level === 'beginner' ? 14 : dteMin)
  const primaryMax = Math.max(dteMax, primaryMin)

  return [
    {
      label: 'primary',
      dteMin: primaryMin,
      dteMax: primaryMax,
      reason,
      warnings,
    },
    {
      label: 'alternative',
      dteMin: primaryMax,
      dteMax: primaryMax + 30,
      reason: 'Slightly farther expiration for time-decay comparison.',
      warnings: view.event_context === 'earnings' ? ['Compare event risk across expirations.'] : [],
    },
    {
      label: 'longer_dated',
      dteMin: Math.max(60, primaryMax + 30),
      dteMax: Math.max(120, primaryMax + 75),
      reason: 'Longer-dated comparison with less near-term theta pressure.',
      warnings: [],
    },
  ]
}
