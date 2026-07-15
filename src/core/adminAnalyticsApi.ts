export type AdminAnalytics = {
  asOf: string
  windowDays: number
  overview: {
    event_count: number
    active_users: number
    paper_users: number
    paper_orders: number
    data_failures: number
  }
  daily: Array<{ day: string; event_count: number; active_users: number }>
  events: Array<{ event_name: string; count: number }>
  tickers: Array<{ ticker: string; count: number }>
  strategies: Array<{ strategy: string; count: number }>
}

export async function getAdminAnalytics(days: number) {
  const response = await fetch(`/api/admin/analytics?days=${days}`, { credentials: 'same-origin' })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || '无法加载运营数据。')
  return body as AdminAnalytics
}
