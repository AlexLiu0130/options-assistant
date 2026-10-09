export type ThinkingKind = 'recommend' | 'explain' | 'adjust' | 'scenario' | 'compare' | 'risk' | 'concept' | 'chat'

/** Best guess of the task from the user's wording, only used to pick the progress animation. */
export function thinkingKindFor(message: string): ThinkingKind {
  const text = message.toLowerCase()
  if (/换成|改成|改为|换到|移到|调整|调到|roll|switch to|change the|move the|instead of the/.test(text)) return 'adjust'
  if (/什么是|是什么|什么意思|啥是|怎么理解|what is|what are|what does|meaning of/.test(text)) return 'concept'
  if (/对比|比较|相比|区别|compare|\bvs\b|versus|difference/.test(text)) return 'compare'
  if (/如果|假如|涨到|跌到|到期时|情景|影响|what if|scenario|if .*(goes|drops|rises|falls)/.test(text)) return 'scenario'
  // A market view ("MU up modestly, max loss $1,000") is a request to find strategies, even if it mentions loss.
  if (/上涨|下跌|小涨|小跌|看涨|看跌|看多|看空|bullish|bearish|\bup\b.*(month|week)|\bdown\b.*(month|week)/.test(text)) return 'recommend'
  if (/风险|亏损|最多亏|止损|risk|loss|budget/.test(text)) return 'risk'
  if (/解释|讲讲|说说|explain|walk me through/.test(text)) return 'explain'
  if (/推荐|找|策略|适合|看涨|看跌|看多|看空|recommend|suggest|find|bullish|bearish|strategy/.test(text)) return 'recommend'
  return 'chat'
}
