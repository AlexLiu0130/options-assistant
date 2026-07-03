import { Line } from '@ant-design/charts'
import { payoffSeries } from '../core/dashboardData'
import type { StrategyCandidate } from '../types/strategyTypes'

export function PayoffComparisonChart({
  strategies,
  spot,
  selectedStrategy,
}: {
  strategies: StrategyCandidate[]
  spot: number
  selectedStrategy?: StrategyCandidate
}) {
  const data = payoffSeries(strategies, spot)
  return (
    <div className="chart-host payoff-host">
      <Line
        data={data}
        xField="underlyingPrice"
        yField="pl"
        colorField="strategy"
        height={300}
        axis={{
          x: { title: 'Underlying price' },
          y: { title: 'Estimated P/L' },
        }}
        scale={{ color: { range: ['#7dd8be', '#9bd4ff', '#da6b1f', '#ff6f91'] } }}
        style={{
          lineWidth: ({ strategy }: { strategy: string }) => (strategy === selectedStrategy?.name ? 4 : 2),
          opacity: ({ strategy }: { strategy: string }) => (!selectedStrategy || strategy === selectedStrategy.name ? 1 : 0.42),
        }}
        interaction={{ tooltip: { marker: true } }}
      />
    </div>
  )
}
