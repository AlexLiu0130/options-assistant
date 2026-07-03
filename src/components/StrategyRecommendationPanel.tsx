import type { Direction, StrategyCandidate } from '../types/strategyTypes'
import { PayoffComparisonChart } from './PayoffComparisonChart'
import { ScenarioTable } from './ScenarioTable'
import { StrategyCard } from './StrategyCard'

export function StrategyRecommendationPanel({
  strategies,
  spot,
  selectedStrategy,
  onSelectStrategy,
  expirations,
  selectedExpiration,
  onSelectExpiration,
  direction,
  onSelectDirection,
}: {
  strategies: StrategyCandidate[]
  spot: number
  selectedStrategy?: StrategyCandidate
  onSelectStrategy: (strategy: StrategyCandidate) => void
  expirations: string[]
  selectedExpiration?: string
  onSelectExpiration: (expiration: string) => void
  direction: Direction
  onSelectDirection: (direction: Direction) => void
}) {
  const directions: Direction[] = ['bullish', 'neutral', 'bearish', 'volatile']

  return (
    <section className="terminal-section">
      <div className="section-head">
        <div>
          <p className="eyebrow">Strategy Builder</p>
          <h2>Ranked Candidates</h2>
        </div>
        <span className="terminal-pill">{strategies.length} strategies</span>
      </div>
      <div className="builder-controls">
        <div className="tab-strip">
          {expirations.map((expiration) => (
            <button
              className={expiration === selectedExpiration ? 'active' : ''}
              key={expiration}
              onClick={() => onSelectExpiration(expiration)}
              type="button"
            >
              {expiration}
            </button>
          ))}
        </div>
        <div className="direction-strip">
          {directions.map((item) => (
            <button
              className={item === direction ? 'active' : ''}
              key={item}
              onClick={() => onSelectDirection(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="strategy-rail">
        {strategies.map((strategy) => (
          <StrategyCard
            key={strategy.id}
            onSelect={onSelectStrategy}
            selected={strategy.id === selectedStrategy?.id}
            strategy={strategy}
          />
        ))}
      </div>
      <PayoffComparisonChart selectedStrategy={selectedStrategy} strategies={strategies} spot={spot} />
      <ScenarioTable strategies={selectedStrategy ? [selectedStrategy] : strategies} />
    </section>
  )
}
