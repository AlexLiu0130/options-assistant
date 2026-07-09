import { number, optionChainRows, percent, price, strike } from '../core/dashboardData'
import { useT } from '../i18n'
import type { QverisOptionContract } from '../types/optionTypes'
import type { StrategyCandidate } from '../types/strategyTypes'
import type { DataStatus } from '../types/optionTypes'

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
  isLoading,
  error,
  status,
  selectedStrategy,
}: {
  contracts: QverisOptionContract[]
  expiration?: string
  isLoading?: boolean
  error?: string
  status?: DataStatus
  selectedStrategy?: StrategyCandidate
}) {
  const { t, lang } = useT()
  const rows = optionChainRows(contracts, expiration, selectedStrategy)
  const emptyText = isLoading
    ? (lang === 'zh' ? '正在加载期权链…' : 'Loading option chain…')
    : error
      ? (lang === 'zh' ? `期权链拉取失败：${error}` : `Option chain failed: ${error}`)
      : status === 'stale'
        ? (lang === 'zh' ? '期权链为缓存数据，暂未拿到最新报价。' : 'Showing stale chain cache; latest quotes are unavailable.')
        : (lang === 'zh' ? '期权链暂无可用合约。' : 'No option contracts available.')

  return (
    <div className="chain-matrix">
      {!rows.length && (
        <div className="chain-empty">{emptyText}</div>
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
