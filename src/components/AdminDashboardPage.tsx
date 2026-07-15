import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Activity, BarChart3, Briefcase, Moon, RefreshCw, Sun, TriangleAlert, Users } from 'lucide-react'
import { getAdminAnalytics, type AdminAnalytics } from '../core/adminAnalyticsApi'

function navigate(path: string) { window.location.hash = path }

const eventLabels: Record<string, string> = {
  ticker_searched: '标的搜索',
  strategy_opened: '策略展开',
  simulator_used: '模拟器使用',
  assistant_used: 'AI 助手使用',
  paper_order_created: '模拟订单创建',
  paper_position_closed: '模拟持仓平仓',
  paper_account_reset: '模拟账户重置',
  education_viewed: '策略教学浏览',
  data_request_failed: '数据请求失败',
}

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function Metric({ icon, label, value, tone = '' }: { icon: ReactNode; label: string; value: number; tone?: string }) {
  return <article className={`admin-metric ${tone}`}><span>{icon}</span><small>{label}</small><strong>{value.toLocaleString()}</strong></article>
}

function RankedList({ title, items }: { title: string; items: Array<{ label: string; count: number }> }) {
  const max = Math.max(...items.map((item) => item.count), 1)
  return <section className="admin-panel admin-ranked"><h2>{title}</h2>{items.length ? <ol>{items.map((item) => <li key={item.label}><span>{item.label}</span><i><b style={{ width: `${(item.count / max) * 100}%` }} /></i><em>{item.count}</em></li>)}</ol> : <p className="admin-empty">暂无数据</p>}</section>
}

export function AdminDashboardPage({ theme, onToggleTheme }: { theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const [days, setDays] = useState(7)
  const [data, setData] = useState<AdminAnalytics>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try { setData(await getAdminAnalytics(days)) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法加载运营数据。') } finally { setLoading(false) }
  }, [days])

  useEffect(() => { void load() }, [load])
  const maxDaily = Math.max(...(data?.daily.map((row) => row.event_count) ?? [1]), 1)

  return <main className="admin-shell">
    <header className="admin-topbar">
      <button className="oa-brand oa-brand-button" type="button" onClick={() => navigate('#/')} aria-label="Qveris home"><strong>Qveris</strong><span>AI</span></button>
      <span className="admin-title">运营看板</span>
      <div className="oa-top-spacer" />
      <button className="theme-toggle" type="button" onClick={onToggleTheme} aria-label="Toggle dark mode">{theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}</button>
      <button className="admin-refresh" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? 'admin-spin' : ''} />刷新</button>
    </header>
    <section className="admin-content">
      <div className="admin-heading"><div><p>PRIVATE BETA</p><h1>产品使用情况</h1><span>{data ? `最近 ${data.windowDays} 天 · 更新于 ${formatTime(data.asOf)}` : '正在读取聚合数据'}</span></div><div className="admin-range">{[1, 7, 30].map((value) => <button key={value} className={days === value ? 'active' : ''} type="button" onClick={() => setDays(value)}>{value} 天</button>)}</div></div>
      {error ? <div className="admin-error"><TriangleAlert size={18} />{error}</div> : null}
      {data ? <>
        <section className="admin-metrics">
          <Metric icon={<Users size={17} />} label="活跃用户" value={data.overview.active_users} />
          <Metric icon={<Activity size={17} />} label="产品事件" value={data.overview.event_count} />
          <Metric icon={<Briefcase size={17} />} label="模拟交易用户" value={data.overview.paper_users} tone="success" />
          <Metric icon={<BarChart3 size={17} />} label="模拟订单" value={data.overview.paper_orders} tone="success" />
          <Metric icon={<TriangleAlert size={17} />} label="数据失败" value={data.overview.data_failures} tone={data.overview.data_failures ? 'danger' : ''} />
        </section>
        <section className="admin-panel admin-activity"><div><h2>每日活跃趋势</h2><span>按事件发生日期汇总</span></div><div className="admin-bars">{data.daily.map((row) => <div key={row.day}><i style={{ height: `${Math.max((row.event_count / maxDaily) * 100, row.event_count ? 5 : 0)}%` }} title={`${row.day}: ${row.event_count} events`} /><span>{row.day}</span><em>{row.event_count}</em></div>)}</div></section>
        <section className="admin-grid">
          <RankedList title="热门标的" items={data.tickers.map((item) => ({ label: item.ticker, count: item.count }))} />
          <RankedList title="策略关注度" items={data.strategies.map((item) => ({ label: item.strategy, count: item.count }))} />
          <RankedList title="功能使用" items={data.events.map((item) => ({ label: eventLabels[item.event_name] || item.event_name, count: item.count }))} />
        </section>
      </> : loading ? <div className="admin-loading">正在加载运营数据...</div> : null}
    </section>
  </main>
}
