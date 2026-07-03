import { Activity, BarChart3, Clock, Database } from 'lucide-react'
import { money, number } from '../core/dashboardData'
import type { QverisMarketSnapshot } from '../types/optionTypes'

export function MarketContextCards({ market }: { market?: QverisMarketSnapshot }) {
  const cards = [
    { label: 'Last', value: money(market?.price), icon: Activity },
    { label: 'Open', value: money(market?.open), icon: Clock },
    { label: 'High / Low', value: `${money(market?.high)} / ${money(market?.low)}`, icon: BarChart3 },
    { label: 'Volume', value: number(market?.volume), icon: Database },
  ]

  return (
    <div className="metric-strip">
      {cards.map(({ icon: Icon, label, value }) => (
        <div className="terminal-metric" key={label}>
          <Icon size={16} />
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  )
}
