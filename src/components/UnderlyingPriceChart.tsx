import { BaselineSeries, CandlestickSeries, HistogramSeries, LineSeries, LineStyle, createChart } from 'lightweight-charts'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { Time, UTCTimestamp } from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'
import { marketCandles, money } from '../core/dashboardData'
import { buildSimulatorChartProjection, type SimulatorChartProjection } from '../core/simulatorChartEngine'
import type { QverisMarketSnapshot } from '../types/optionTypes'
import type { StrategyCandidate } from '../types/strategyTypes'

const CHART_HEIGHT = 390

function orderedCandles(market?: QverisMarketSnapshot) {
  const byTime = new Map<string | number, ReturnType<typeof marketCandles>[number]>()
  for (const candle of marketCandles(market)) {
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue
    byTime.set(candle.time, candle)
  }
  return [...byTime.values()].sort((a, b) => {
    if (typeof a.time === 'number' && typeof b.time === 'number') return a.time - b.time
    return String(a.time).localeCompare(String(b.time))
  })
}

function formatChartTime(time: string | number) {
  if (typeof time === 'number') {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/New_York',
    }).format(new Date(time * 1000))
  }
  const date = new Date(`${time}T00:00:00Z`)
  return Number.isNaN(date.getTime())
    ? time
    : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(date)
}

function shiftTime(time: UTCTimestamp | string, days: number): UTCTimestamp | string {
  if (typeof time === 'number') return (time + Math.round(days) * 86400) as UTCTimestamp
  const date = new Date(`${time}T00:00:00Z`)
  date.setDate(date.getDate() + Math.round(days))
  return date.toISOString().split('T')[0]
}

function expiryTime(anchorTime: UTCTimestamp | string, expiration?: string) {
  if (!expiration) return undefined
  return typeof anchorTime === 'number'
    ? (Math.floor(new Date(`${expiration}T20:00:00Z`).getTime() / 1000) as UTCTimestamp)
    : expiration
}

export function UnderlyingPriceChart({
  market,
  selectedStrategy,
  isLoadingCandles = false,
  simulatorProjection,
}: {
  market?: QverisMarketSnapshot
  selectedStrategy?: StrategyCandidate
  isLoadingCandles?: boolean
  simulatorProjection?: SimulatorChartProjection
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const [showEmLines, setShowEmLines] = useState(false)
  const [showLegLines, setShowLegLines] = useState(false)
  const [showPayoffZones, setShowPayoffZones] = useState(true)

  useEffect(() => {
    if (!ref.current) return
    const candlesData = orderedCandles(market).map((candle) => ({
      ...candle,
      time: typeof candle.time === 'number' ? (candle.time as UTCTimestamp) : candle.time,
    }))
    const chart = createChart(ref.current, {
      height: ref.current.clientHeight || CHART_HEIGHT,
      layout: { background: { color: 'transparent' }, textColor: '#6b7890' },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: '#e3ebf5' },
      localization: { timeFormatter: formatChartTime },
      timeScale: {
        borderColor: '#e3ebf5',
        tickMarkFormatter: (time: Time) => formatChartTime(time as string | number),
      },
      crosshair: {
        vertLine: { color: 'rgba(11,122,59,0.24)' },
        horzLine: { color: 'rgba(11,122,59,0.24)' },
      },
    })

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#12803c',
      downColor: '#d93535',
      borderVisible: false,
      wickUpColor: '#12803c',
      wickDownColor: '#d93535',
    })
    candles.setData(candlesData)
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: 0.24 } })

    const volume = chart.addSeries(HistogramSeries, {
      color: 'rgba(148, 163, 184, 0.35)',
      lastValueVisible: false,
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      priceScaleId: 'volume',
    })
    volume.setData(
      candlesData
        .filter((c) => typeof c.volume === 'number')
        .map((c) => ({
          time: c.time,
          value: c.volume ?? 0,
          color: c.close >= c.open ? 'rgba(18,128,60,0.16)' : 'rgba(217,53,53,0.16)',
        })),
    )
    chart.priceScale('volume').applyOptions({
      borderVisible: false,
      scaleMargins: { top: 0.78, bottom: 0 },
      visible: false,
    })

    // Price reference lines (breakevens, legs)
    const referenceLines = [
      ...(selectedStrategy?.breakevens?.length
        ? selectedStrategy.breakevens
        : [selectedStrategy?.breakeven]
      ).map((value, index) => ({
        title: (selectedStrategy?.breakevens?.length ?? 0) > 1 ? `盈亏平衡 ${index + 1}` : '盈亏平衡',
        value,
        color: '#0b7a3b',
        style: LineStyle.Dotted,
        label: true,
      })),
      ...(showLegLines
        ? (selectedStrategy?.legs ?? []).map((leg) => ({
            title: '',
            value: leg.strike,
            color: leg.action === 'buy' ? '#12803c' : '#d93535',
            style: LineStyle.Solid,
            label: false,
          }))
        : []),
    ].filter(
      (item): item is { title: string; value: number; color: string; style: LineStyle; label: boolean } =>
        typeof item.value === 'number',
    )

    for (const line of referenceLines) {
      candles.createPriceLine({
        axisLabelVisible: line.label,
        color: line.color,
        lineStyle: line.style,
        lineWidth: 2,
        price: line.value,
        title: line.title,
      })
    }

    // Expiration payoff zones only. The what-if DTE slider is intentionally separate.
    const em = selectedStrategy?.expectedMove
    const lastCandle = candlesData[candlesData.length - 1]
    let futureSteps = 0

    if (selectedStrategy && em && lastCandle && em.dte > 0) {
      const anchorPrice = lastCandle.close
      const expiry = expiryTime(lastCandle.time, selectedStrategy.legs[0]?.expiration) ?? shiftTime(lastCandle.time, em.dte)
      if (showEmLines) {
        for (const line of [
          { value: em.high, color: 'rgba(22, 163, 74, 0.26)' },
          { value: em.low, color: 'rgba(220, 38, 38, 0.26)' },
        ]) {
          const emLine = chart.addSeries(LineSeries, {
            color: line.color,
            lineStyle: LineStyle.Dashed,
            lineWidth: 1,
            title: '',
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          })
          emLine.setData([
            { time: lastCandle.time, value: anchorPrice },
            { time: expiry, value: line.value },
          ])
        }
      }

      const expiryProjection = buildSimulatorChartProjection({
        strategy: selectedStrategy,
        underlyingPrice: market?.price ?? (em.low + em.high) / 2,
        daysLeft: 0,
        minPrice: em.low,
        maxPrice: em.high,
        samples: 121,
      })
      const t0 = lastCandle.time as UTCTimestamp | string

      // 30 evenly-spaced future bars so the zone gets proportional chart width
      // (lightweight-charts allocates equal pixel-width per data point)
      const STEPS = 30
      futureSteps = STEPS

      const flatBars = (value: number) =>
        Array.from({ length: STEPS + 1 }, (_, i) => ({
          time: shiftTime(t0, Math.round((em.dte * i) / STEPS)) as UTCTimestamp,
          value,
        }))

      const none = 'rgba(0,0,0,0)'
      if (showPayoffZones) {
        for (const zone of expiryProjection.zones) {
          const low = Math.min(zone.fromPrice, zone.toPrice)
          const high = Math.max(zone.fromPrice, zone.toPrice)
          if (high <= low) continue
          const isProfit = zone.status === 'profit'
          const color1 = isProfit ? 'rgba(22, 163, 74, 0.12)' : 'rgba(220, 38, 38, 0.12)'
          const color2 = isProfit ? 'rgba(22, 163, 74, 0.06)' : 'rgba(220, 38, 38, 0.06)'
          const band = chart.addSeries(BaselineSeries, {
            baseValue: { type: 'price' as const, price: low },
            topFillColor1: color1,
            topFillColor2: color2,
            bottomFillColor1: none,
            bottomFillColor2: none,
            topLineColor: none,
            bottomLineColor: none,
            lineVisible: false,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          })
          band.setData(flatBars(high))
        }
      }
    }

    // Balance history vs future: show ~30 recent candles + full zone width
    if (futureSteps > 0) {
      const historyShow = Math.min(30, candlesData.length)
      chart.timeScale().setVisibleLogicalRange({
        from: candlesData.length - historyShow,
        to: candlesData.length + futureSteps + 2,
      })
    } else {
      chart.timeScale().fitContent()
    }
    chartRef.current = chart
    seriesRef.current = candles
    const resize = new ResizeObserver(([entry]) => {
      chart.applyOptions({
        height: entry.contentRect.height || CHART_HEIGHT,
        width: entry.contentRect.width,
      })
    })
    resize.observe(ref.current)

    return () => {
      resize.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [market, selectedStrategy, showEmLines, showLegLines, showPayoffZones])

  // Simulator: thin dashed line at simulated price (no axis label to avoid confusion)
  useEffect(() => {
    const series = seriesRef.current
    if (!series || !simulatorProjection) return
    const line = series.createPriceLine({
      price: simulatorProjection.point.underlyingPrice,
      color: '#3b82f6',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: '',
    })
    return () => { series.removePriceLine(line) }
  }, [simulatorProjection])

  const isLoading = !market || isLoadingCandles

  return (
    <div className="price-chart-wrap">
      {isLoading ? (
        <div className="chart-skeleton">
          {Array.from({ length: 20 }, (_, i) => (
            <div
              className="chart-skeleton-bar"
              key={i}
              style={{ '--h': `${30 + Math.sin(i * 0.7) * 25 + Math.cos(i * 1.3) * 15}%` } as React.CSSProperties}
            />
          ))}
        </div>
      ) : (
        <div className="chart-stage">
          <div className="chart-host" ref={ref} />
        </div>
      )}
      <div className="chart-legend">
        <span>现价 {money(market?.price)}</span>
        <span>
          盈亏平衡{' '}
          {selectedStrategy?.breakevens?.length
            ? selectedStrategy.breakevens.map(money).join(' / ')
            : money(selectedStrategy?.breakeven)}
        </span>
        {selectedStrategy?.expectedMove && <span>到期区域 绿=盈利 红=亏损</span>}
        {selectedStrategy && (
          <div className="chart-toggles">
            <button className={showPayoffZones ? 'active' : ''} type="button" onClick={() => setShowPayoffZones((v) => !v)}>盈亏区</button>
            <button className={showEmLines ? 'active' : ''} type="button" onClick={() => setShowEmLines((v) => !v)}>EM</button>
            <button className={showLegLines ? 'active' : ''} type="button" onClick={() => setShowLegLines((v) => !v)}>行权价</button>
          </div>
        )}
        {simulatorProjection && (
          <span className={simulatorProjection.point.estimatedPnL >= 0 ? 'profit' : 'loss'}>
            模拟 {money(simulatorProjection.point.underlyingPrice)}{' '}
            {simulatorProjection.point.estimatedPnL >= 0 ? '+' : ''}
            {money(simulatorProjection.point.estimatedPnL)}
          </span>
        )}
      </div>
    </div>
  )
}
