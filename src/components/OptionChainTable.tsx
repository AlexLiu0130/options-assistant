import { number, optionChainRows, percent, price, strike } from '../core/dashboardData'
import { useT } from '../i18n'
import type { QverisOptionContract } from '../types/optionTypes'
import type { StrategyCandidate } from '../types/strategyTypes'

function compact(value: number | null | undefined) {
  return value === null || value === undefined ? '-' : number(value)
}

function compactPercent(value: number | null | undefined) {
  return value === null || value === undefined ? '-' : percent(value)
}

function quoteClass(action?: string) {
  return `quote ${action === 'buy' ? 'buy' : action === 'sell' ? 'sell' : ''}`
}

export function OptionChainTable({
  contracts,
  expiration,
  selectedStrategy,
}: {
  contracts: QverisOptionContract[]
  expiration?: string
  selectedStrategy?: StrategyCandidate
}) {
  const { t, lang } = useT()
  const rows = optionChainRows(contracts, expiration, selectedStrategy)

  return (
    <div className="chain-matrix">
      {!rows.length && (
        <div className="chain-empty">
          {lang === 'zh' ? '期权链不可用。请检查 Qveris 数据状态。' : 'Option chain unavailable. Check Qveris data status.'}
        </div>
      )}
      <table>
        <thead>
          <tr className="chain-groups">
            <th colSpan={6}>{t.chainSection.calls}</th>
            <th />
            <th colSpan={6}>{t.chainSection.puts}</th>
          </tr>
          <tr>
            <th>{t.chain.oi}</th>
            <th>{t.chain.volume}</th>
            <th>{t.chain.iv}</th>
            <th>{t.chain.delta}</th>
            <th>{t.chain.bid}</th>
            <th>{t.chain.ask}</th>
            <th className="strike-head">{t.chain.strike}</th>
            <th>{t.chain.bid}</th>
            <th>{t.chain.ask}</th>
            <th>{t.chain.delta}</th>
            <th>{t.chain.iv}</th>
            <th>{t.chain.volume}</th>
            <th>{t.chain.oi}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className={row.selectedStrike ? 'selected' : ''} key={row.strike ?? 'strike'}>
              <td>{compact(row.callOi)}</td>
              <td>{compact(row.callVolume)}</td>
              <td>{compactPercent(row.callIv)}</td>
              <td>{compact(row.callDelta)}</td>
              <td><span className={quoteClass(row.callBidAction)}>{price(row.callBid)}</span></td>
              <td><span className={quoteClass(row.callAskAction)}>{price(row.callAsk)}</span></td>
              <td className="strike-col">{strike(row.strike)}</td>
              <td><span className={quoteClass(row.putBidAction)}>{price(row.putBid)}</span></td>
              <td><span className={quoteClass(row.putAskAction)}>{price(row.putAsk)}</span></td>
              <td>{compact(row.putDelta)}</td>
              <td>{compactPercent(row.putIv)}</td>
              <td>{compact(row.putVolume)}</td>
              <td>{compact(row.putOi)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
