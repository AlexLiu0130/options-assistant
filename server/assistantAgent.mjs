// Qveris AI agent core: turn parsing, conversation memory, engine-backed plans and deterministic answers.
// The LLM only narrates; every number shown to the user comes from the deterministic engines here.
import { strategyEducationContent } from '../src/core/strategyEducationContent.ts'
import { strategyExpirationPayoff } from '../src/core/payoffEngine.ts'

export const assistantIntents = ['clarify', 'recommend', 'explain', 'compare', 'educate', 'adjust', 'risk_check', 'refuse']
const engineIntents = new Set(['recommend', 'compare', 'adjust', 'explain', 'risk_check'])
const followUpOrder = ['riskBudget', 'targetPrice', 'experienceLevel']
const horizonSteps = ['1 week', '2 weeks', '1 month', '2 months', '3 months', '6 months', '1 year']

export function text(isZh, zh, en) {
  return isZh ? zh : en
}

// ---------- knowledge ----------

const educationById = new Map(strategyEducationContent.map((item) => [item.id, item]))

const strategyAliases = [
  ...strategyEducationContent.flatMap((item) => [
    [item.name.toLowerCase(), item.id],
    [item.zhName, item.id],
    [item.id.replaceAll('-', ' '), item.id],
  ]),
  ['csp', 'cash-secured-put'],
  ['现金担保', 'cash-secured-put'],
  ['卖看跌', 'cash-secured-put'],
  ['铁鹰', 'iron-condor'],
  ['铁蝶', 'iron-butterfly'],
  ['牛市价差', 'bull-call-spread'],
  ['熊市价差', 'bear-put-spread'],
  ['买看涨', 'long-call'],
  ['买看跌', 'long-put'],
].sort((a, b) => b[0].length - a[0].length)

const concepts = [
  {
    id: 'theta',
    match: /theta|时间价值|时间衰减/i,
    zh: 'Theta 衡量其他条件不变时，期权价格每过一天大约变化多少。买方通常 Theta 为负，时间流逝会侵蚀权利金；卖方通常 Theta 为正，越临近到期衰减越快。',
    en: 'Theta estimates how much an option price changes per day with everything else unchanged. Long options usually have negative theta (time decay hurts), short options positive theta; decay accelerates near expiration.',
  },
  {
    id: 'delta',
    match: /delta/i,
    zh: 'Delta 衡量标的每变动 1 美元，期权价格大约变化多少，也常被粗略当作到期时处于价内的概率参考。看涨期权 Delta 在 0 到 1 之间，看跌期权在 -1 到 0 之间。',
    en: 'Delta estimates how much an option price moves for a 1-dollar move in the stock, and is often used as a rough in-the-money probability reference. Calls range 0 to 1, puts -1 to 0.',
  },
  {
    id: 'gamma',
    match: /gamma/i,
    zh: 'Gamma 衡量 Delta 本身随标的价格变化的速度。平值、临近到期的期权 Gamma 最大，持仓盈亏会对价格变动非常敏感。',
    en: 'Gamma measures how fast delta changes as the stock moves. It is largest for at-the-money options near expiration, which makes P/L very sensitive to price moves.',
  },
  {
    id: 'vega',
    match: /vega/i,
    zh: 'Vega 衡量隐含波动率每变化 1 个百分点，期权价格大约变化多少。买方多为正 Vega，IV 回落（例如财报后）会伤害买方。',
    en: 'Vega estimates how much an option price changes per 1-point change in implied volatility. Long options are usually long vega, so an IV drop (e.g. after earnings) hurts buyers.',
  },
  {
    id: 'iv',
    match: /\biv\b|隐含波动率|implied vol/i,
    zh: '隐含波动率（IV）是从期权价格反推出的市场预期波动幅度。IV 高意味着期权更贵：对买方不利、对卖方收取权利金更有利，但也代表市场预期波动更大。',
    en: 'Implied volatility (IV) is the market-implied expected move backed out of option prices. High IV makes options expensive: harder for buyers, richer premium for sellers, but it also signals larger expected moves.',
  },
  {
    id: 'dte',
    match: /\bdte\b|到期天数|到期日/i,
    zh: 'DTE 指距离到期还有多少天。买方一般需要更多时间（常见 30-60 DTE），卖方常用 30-45 DTE 收取时间价值；7 天以内的期权对新手风险很高。',
    en: 'DTE is days to expiration. Buyers generally need more time (often 30-60 DTE); premium sellers often use 30-45 DTE; options under 7 DTE are high risk for beginners.',
  },
  {
    id: 'breakeven',
    match: /breakeven|盈亏平衡/i,
    zh: '盈亏平衡价是到期时策略刚好不赚不亏的标的价格。到期前的实际盈亏还会受时间价值和 IV 影响，不完全等同于到期曲线。',
    en: 'Breakeven is the stock price at expiration where the strategy neither makes nor loses money. Before expiration, P/L also depends on time value and IV.',
  },
  {
    id: 'pop',
    match: /\bpop\b|盈利概率|probability of profit/i,
    zh: '盈利概率（POP）是基于当前隐含波动率估算的、到期时盈利的概率。它是模型估计而不是预测，高 POP 策略往往盈利上限小、亏损上限大。',
    en: 'Probability of profit (POP) is a model estimate, based on current IV, of finishing profitable at expiration. It is not a forecast; high-POP trades often have small max profit and larger max loss.',
  },
  {
    id: 'assignment',
    match: /assign|指派|行权|接股/i,
    zh: '卖出期权的一方可能被指派：卖出看跌被指派需要按行权价买入股票，卖出看涨被指派需要交出股票。美式期权在到期前也可能被提前指派，尤其临近除息日。',
    en: 'Option sellers can be assigned: a short put may have to buy shares at the strike, a short call may have to deliver shares. American-style options can be assigned early, especially near ex-dividend dates.',
  },
  {
    id: 'spread',
    match: /价差|spread/i,
    zh: '价差策略同时买入和卖出同类期权，用卖出的那条腿降低成本或锁定风险。代价是收益也被封顶，但最大亏损在开仓时就确定。',
    en: 'A spread buys and sells options of the same type, using the short leg to cut cost or cap risk. The trade-off is capped profit, but max loss is known at entry.',
  },
]

export function conceptFor(message) {
  return concepts.find((concept) => concept.match.test(String(message)))
}

// ---------- slot parsing ----------

const cnDigits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

function countValue(token) {
  if (/^\d+(?:\.\d+)?$/.test(token)) return Number(token)
  if (token.length === 1) return cnDigits[token]
  if (token[0] === '十') return 10 + (cnDigits[token[1]] ?? 0)
  if (token[1] === '十') return (cnDigits[token[0]] ?? 0) * 10 + (cnDigits[token[2]] ?? 0)
  return undefined
}

// "两千" / "一千五" / "3万" / "五百" style amounts.
function cnAmount(token) {
  const value = String(token)
  if (!/^[零一二两三四五六七八九十百千万]+$/.test(value)) return undefined
  let total = 0
  let section = 0
  let digit = 0
  let lastUnit = 1
  let zero = false
  for (const char of value) {
    if (char === '零') {
      zero = true
      continue
    }
    if (char in cnDigits && char !== '十') {
      // "两三千" is a range; the lower bound is the conservative budget.
      if (!digit) digit = cnDigits[char]
      continue
    }
    const unit = { 十: 10, 百: 100, 千: 1000, 万: 10000 }[char]
    if (unit === 10000) {
      total += (section + digit) * 10000
      section = 0
      digit = 0
      lastUnit = 10000
      continue
    }
    section += (digit || (unit === 10 ? 1 : 0)) * unit
    digit = 0
    lastUnit = unit
  }
  // "一千五" means 1500: a trailing digit sits one unit below the last one.
  if (digit) section += zero || lastUnit < 100 ? digit : digit * (lastUnit / 10)
  const result = total + section
  return result > 0 ? result : undefined
}

const amountToken = '([0-9][0-9,]*(?:\\.\\d+)?|[零一二两三四五六七八九十百千万]{1,6})'
const amountTail = '\\s*(k|千|w|万)?\\s*(?:美元|美金|刀|块|元|dollars?|usd|bucks)?'
// A number followed by these is a percent, an ordinal, a count or a duration, never a dollar budget.
const notMoney = /^\s*(?:%|％|个|张|股|天|日|周|月|年|倍|st\b|nd\b|rd\b|th\b|days?|weeks?|months?|years?|contracts?|shares?)/i

function amount(raw, unit = '') {
  const cn = cnAmount(raw)
  if (cn !== undefined) return cn
  const number = Number(String(raw).replaceAll(',', ''))
  if (!Number.isFinite(number)) return undefined
  if (/^(k|千)$/i.test(unit)) return number * 1000
  if (/^(w|万)$/i.test(unit)) return number * 10000
  return number
}

function bareNegative(message) {
  const match = String(message).trim().match(new RegExp(`^[-−–负]\\s*\\$?\\s*${amountToken}${amountTail}\\s*[。.!！]?$`, 'i'))
  return match ? amount(match[1], match[2]) : undefined
}

function bareNumber(message) {
  const match = String(message).trim().match(new RegExp(`^(?:大概|大约|差不多|就|那就|最多)?\\s*\\$?\\s*${amountToken}${amountTail}\\s*(?:吧|左右|上下|以内|之内|就行|就好|差不多|即可)?\\s*[。.!！~～]?$`, 'i'))
  return match ? amount(match[1], match[2]) : undefined
}

const negativeSign = /[-−–负]\s*\$?\s*$/

// Budget as written, with invalid values (negative, zero) reported instead of silently fixed.
function riskBudgetDetail(message) {
  const value = String(message)
  const keyword = '(?:max(?:imum)?\\s*loss|risk\\s*budget|budget|risk(?:ing)?|lose|losing|最多(?:愿意|能|可以|只|只能)?(?:亏|赔|损失)(?:损)?|最大(?:可承受)?(?:亏损|损失)|风险预算|预算|承受|亏损上限|亏损|损失|止损|亏)'
  const pattern = new RegExp(`${keyword}([^0-9零一二两三四五六七八九十百千万$]{0,14}?\\$?\\s*)${amountToken}${amountTail}`, 'gi')
  for (const match of value.matchAll(pattern)) {
    if (notMoney.test(value.slice(match.index + match[0].length))) continue
    const number = amount(match[2], match[3])
    if (number === undefined) continue
    if (negativeSign.test(match[1])) return { invalid: 'negative', value: number }
    if (number <= 0) return { invalid: 'zero', value: number }
    return { value: number }
  }
  // "1000以内" without a loss keyword still reads as a budget in this assistant.
  const within = value.match(new RegExp(`\\$?\\s*${amountToken}${amountTail}\\s*(?:以内|之内)(?!的?(?:行权|价格|股价))`, 'i'))
  if (within) {
    const number = amount(within[1], within[2])
    if (number !== undefined && number > 0) return { value: number }
  }
  return {}
}

function riskBudget(message) {
  return riskBudgetDetail(message).value
}

function targetPriceDetail(message) {
  const match = String(message).match(/(?:target(?:\s*price)?|price\s*target|目标价?|涨到|跌到|到达|看到|升到|回到)\s*(?:is|of|at|为|是|:|：)?\s*([-−–负]?)\s*\$?\s*([0-9][0-9,]*(?:\.\d+)?)/i)
  if (!match) return {}
  const number = amount(match[2])
  if (number === undefined) return {}
  if (match[1]) return { invalid: 'negative', value: number }
  if (number <= 0) return { invalid: 'zero', value: number }
  return { value: number }
}

function targetPrice(message) {
  return targetPriceDetail(message).value
}

function horizonFromDays(days) {
  if (days <= 10) return '1 week'
  if (days <= 24) return '2 weeks'
  if (days <= 45) return '1 month'
  if (days <= 75) return '2 months'
  if (days <= 135) return '3 months'
  if (days <= 270) return '6 months'
  return '1 year'
}

export function canonicalHorizon(value) {
  return value === undefined ? undefined : horizon(value)
}

const monthNames = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

// "11月20日" / "12/18" / "2026-12-18" / "Dec 18" name a concrete expiration; convert to days from today.
function explicitDateDays(value, now = Date.now()) {
  const date = explicitDate(value, now)
  if (!date) return undefined
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - now) / 86_400_000)
  return days > 0 ? days : undefined
}

// Month-only expirations ("12月到期", "December expiry") resolve to the third Friday, the standard monthly.
function thirdFriday(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  return new Date(Date.UTC(year, month - 1, 1 + ((5 - first + 7) % 7) + 14)).toISOString().slice(0, 10)
}

export function explicitDate(value, now = Date.now()) {
  const date = explicitDateObject(String(value).toLowerCase(), now)
  if (date) return date.toISOString().slice(0, 10)
  const month = String(value).toLowerCase().match(/(?<!\d)(\d{1,2})\s*月(?:份)?(?!\s*\d{1,2}\s*[日号])|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b(?!\.?\s+\d)/)
  if (!month) return undefined
  const number = month[1] ? Number(month[1]) : monthNames[month[2]]
  if (!number || number > 12) return undefined
  const today = new Date(now)
  let year = today.getUTCFullYear()
  if (Date.parse(`${thirdFriday(year, number)}T21:00:00Z`) < now) year += 1
  return thirdFriday(year, number)
}

function explicitDateObject(value, now) {
  const iso = value.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/)
  const cn = value.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/)
  const slash = value.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/)
  const named = value.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/)
  const today = new Date(now)
  let date
  if (iso) date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
  else {
    const [month, day] = cn ? [cn[1], cn[2]] : slash ? [slash[1], slash[2]] : named ? [monthNames[named[1]], named[2]] : []
    if (!month || Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return undefined
    date = new Date(Date.UTC(today.getUTCFullYear(), Number(month) - 1, Number(day)))
    if (date.getTime() < now - 86_400_000) date = new Date(Date.UTC(today.getUTCFullYear() + 1, Number(month) - 1, Number(day)))
  }
  return date
}

function horizon(message) {
  const value = String(message).toLowerCase()
  const dated = explicitDateDays(value)
  if (dated) return horizonFromDays(dated)
  if (/长期|long[\s-]*term|leaps/.test(value)) return 'long term'
  if (/半个月|两三周|half\s*(?:a\s*)?month/.test(value)) return '2 weeks'
  if (/一个半月|month and a half/.test(value)) return '1 month'
  if (/半年|half\s*(?:a\s*)?year/.test(value)) return '6 months'
  if (/季度|quarter/.test(value)) return '3 months'
  const match = value.match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*(?:个)?\s*(天|日|周|星期|礼拜|月|年|days?|dte|weeks?|wks?|months?|mos?|years?|yrs?)/)
  if (match) {
    const count = countValue(match[1])
    if (count) {
      const unit = match[2]
      const days = /天|日|day|dte/.test(unit) ? count
        : /周|星期|礼拜|w/.test(unit) ? count * 7
          : /月|mo/.test(unit) ? count * 30
            : count * 365
      return horizonFromDays(days)
    }
  }
  if (/下周|next week|this week|本周/.test(value)) return '1 week'
  if (/下个月|next month|这个月|本月/.test(value)) return '1 month'
  return undefined
}

// "会涨吗" / "will it go up?" asks for a forecast; it is not the user's own view.
export function isForecastQuestion(message) {
  const value = String(message).toLowerCase()
  return /(?:会|能|要|还会|还能)(?:不会)?(?:涨|跌|上涨|下跌|反弹|回调)(?:吗|么|嘛)|会不会(?:涨|跌|上涨|下跌|反弹)|涨还是跌|能涨到.*吗|怎么走|走势如何|will\s+(?:it|\w{1,5})\s+(?:go\s+up|go\s+down|rise|fall|drop|rally)\b.*\?|is\s+(?:it|\w{1,5})\s+going\s+(?:to\s+(?:go\s+)?)?(?:up|down|rise|fall|drop|rally)\b|where is .* heading/.test(value)
}

function withoutStrategyNames(message) {
  let value = String(message).toLowerCase()
  for (const [name] of strategyAliases) value = value.replaceAll(name.toLowerCase(), ' ')
  return value
}

function direction(message) {
  if (isForecastQuestion(message)) return undefined
  // Strategy names ("牛市看跌价差") contain direction words that are not the user's view.
  const raw = withoutStrategyNames(message)
  if (/不涨不跌|不涨也不跌|横着走/.test(raw)) return 'neutral'
  if (/做空波动|卖波动|short\s*vol/.test(raw)) return 'neutral'
  if (/做多波动|买波动|long\s*vol/.test(raw)) return 'volatile'
  // Negated phrases ("不会跌", "not bearish") carry no reliable direction on their own.
  const value = raw
    .replace(/(?:不觉得|不认为|不相信|不太相信|不看好|don'?t think|doubt)[^，。,.!?！？]*/g, ' ')
    .replace(/(?:不会|不太会|不太|不再|不|没|别|很难)(?:再|大)?(?:看涨|看跌|看多|看空|上涨|下跌|涨|跌)/g, ' ')
    .replace(/not\s+(?:be\s+)?(?:bullish|bearish|go(?:ing)?\s+(?:up|down)|drop|fall|rally)|won'?t\s+(?:go\s+)?(?:up|down|drop|fall|rally)/g, ' ')
  if (/看涨|看多|bullish|做多/.test(value)) return 'bullish'
  if (/看跌|看空|bearish|做空/.test(value)) return 'bearish'
  if (/震荡|横盘|区间|中性|neutral|sideways|range[\s-]*bound/.test(value)) return 'neutral'
  if (/大幅波动|方向不确定|赌波动|做波动|大涨大跌|big move|long vol|volatility play|either direction/.test(value)) return 'volatile'
  if (/会涨|要涨|上涨|涨到|升到|大涨|暴涨|猛涨|涨一波|反弹|走高|upside|go(?:es|ing)? up|rally|rise/.test(value)) return 'bullish'
  if (/会跌|要跌|下跌|跌到|大跌|暴跌|回调|跌一波|走低|downside|go(?:es|ing)? down|drop|fall|decline/.test(value)) return 'bearish'
  return undefined
}

function strength(message) {
  const value = String(message).toLowerCase()
  if (/小幅|轻微|温和上|温和下|mild|slight/.test(value)) return 'mild'
  if (/大幅|强烈|暴涨|暴跌|大涨|大跌|猛涨|strong|sharp|aggressive/.test(value)) return 'strong'
  if (/中等|适中|moderate/.test(value)) return 'moderate'
  return undefined
}

function experienceLevel(message, pendingField) {
  const value = String(message).toLowerCase()
  const selfReference = pendingField === 'experienceLevel' || /我是|我算|我属于|作为|经验|i am|i'm|\bim\b|my experience/.test(value)
  if (!selfReference) return undefined
  if (/新手|小白|入门|刚接触|初学|没经验|没有经验|beginner|new to options|newbie|no experience/.test(value)) return 'beginner'
  if (/高级|老手|熟练|经验丰富|实盘|做过很多|advanced|experienced|expert|traded options/.test(value)) return 'advanced'
  if (/中级|进阶|有一些经验|有点经验|了解基础|基础概念|懂一些|intermediate|some experience|know the basics/.test(value)) return 'intermediate'
  return undefined
}

const tickerStopWords = new Set([
  'CALL', 'CALLS', 'PUT', 'PUTS', 'DTE', 'IV', 'ATM', 'OTM', 'ITM', 'POP', 'PNL', 'PL', 'ETF', 'USD', 'AI', 'OK', 'US', 'USA',
  'QVERIS', 'API', 'IPO', 'CEO', 'EPS', 'FOMC', 'CPI', 'LEAPS', 'VS', 'THE', 'AND', 'OR', 'TO', 'MAX', 'MIN', 'LOSS', 'RISK',
  'CSP', 'DELTA', 'GAMMA', 'THETA', 'VEGA', 'RHO', 'BUY', 'SELL', 'YES', 'NO', 'AM', 'PM', 'ET', 'EST', 'OI', 'BS', 'PDT', 'IRA',
])

function ticker(message) {
  const dollar = String(message).match(/\$([A-Za-z]{1,5})\b/)
  if (dollar) return dollar[1].toUpperCase()
  const tokens = String(message).match(/(?<![A-Za-z])[A-Z]{2,5}(?![A-Za-z])/g) ?? []
  return tokens.find((token) => !tickerStopWords.has(token))
}

function yesNo(message) {
  const value = String(message).toLowerCase().trim().replace(/[。.!！]$/, '')
  if (/^(yes|y|yeah|yep|ok|sure|可以|是|是的|对|愿意|有|有的|行|好)$/.test(value)) return true
  if (/^(no|n|nope|不|不是|没有|不愿意|不行|没|否)$/.test(value)) return false
  return undefined
}

// Confirmation replies may carry a short tail: "是的，按 2000 算" / "yes, use that".
function confirmation(message) {
  const value = String(message).toLowerCase().trim()
  if (/^(?:不是|不对|不|没有|错了|写错|no\b|nope|wrong|not\b)/.test(value)) return false
  if (/^(?:是|对|没错|确认|确定|就是|嗯|好|可以|行|按这个|yes|yep|yeah|correct|confirm|right|sure|ok)/.test(value)) return true
  return undefined
}

function skipped(message) {
  return /^(不知道|不清楚|没有|没想好|跳过|随便|不确定|都行|无所谓|skip|no idea|not sure|none|any|whatever|dunno)[。.!！]?$/i.test(String(message).trim())
}

const ordinalPattern = /第\s*([一二三四五12345])\s*(?:个|种|项|张|条)?|方案\s*([一二三123])|\b(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:one|strategy|option|candidate|card|pick|idea)\b|\bthe\s+(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b(?!\s+(?:time|day|week|month|year))|#\s*([1-5])\b|\b(?:number|no\.?)\s*([1-5])\b/gi

// Every ordinal mentioned, in order: "第一个和第三个" -> [1, 3].
function ordinals(message) {
  const words = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5 }
  return [...String(message).toLowerCase().matchAll(ordinalPattern)]
    .map((match) => {
      const token = match.slice(1).find(Boolean)
      return words[token] ?? countValue(token)
    })
    .filter(Boolean)
}

function ordinal(message) {
  return ordinals(message)[0]
}

// All strategies named in one message, longest alias first so "牛市看涨价差" does not also match "看涨".
export function strategyReferences(message, prior = {}) {
  let rest = String(message).toLowerCase()
  const ids = []
  for (const [name, id] of strategyAliases) {
    const needle = name.toLowerCase()
    if (!rest.includes(needle)) continue
    rest = rest.replaceAll(needle, ' ')
    if (!ids.includes(id)) ids.push(id)
  }
  for (const index of ordinals(message)) {
    const id = prior.lastReferencedIds?.[index - 1]
    if (id && !ids.includes(id)) ids.push(id)
  }
  const firstN = String(message).toLowerCase().match(/前\s*([两二三3 2])\s*(?:个|种)|first\s+(two|three|2|3)|top\s+(two|three|2|3)/)
  if (firstN) {
    const count = { 两: 2, 二: 2, 三: 3, 2: 2, 3: 3, two: 2, three: 3 }[firstN[1] ?? firstN[2] ?? firstN[3]] ?? 2
    for (const id of (prior.lastReferencedIds ?? []).slice(0, count)) if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

export function strategyReference(message, prior = {}) {
  const value = String(message).toLowerCase()
  const alias = strategyAliases.find(([name]) => value.includes(name.toLowerCase()))
  if (alias) return { kind: 'name', id: alias[1] }
  const index = ordinal(message)
  if (index && prior.lastReferencedIds?.[index - 1]) return { kind: 'ordinal', id: prior.lastReferencedIds[index - 1] }
  // Pronouns are weak references: "我觉得它会涨" states a view, it does not ask about the selected strategy.
  if (/这个|这一个|当前|选中|上面|刚才|它|this one|that one|selected|current strategy|\bit\b/.test(value.replace(/这个月|这个星期|这个礼拜|这个季度|这个价/g, ' '))) return { kind: 'focus' }
  return undefined
}

export function classifyAssistantIntent(message, reference) {
  const value = String(message).toLowerCase()
  if (/什么是|是什么|什么叫|啥是|啥叫|是啥|定义|含义|概念|科普|what is|what's|what are|how does .+ work|meaning of|define|teach me|learn/.test(value)) return 'educate'
  if (/对比|比较|区别|差别|差异|哪个好|哪个更|哪一个|compare|versus|\bvs\.?\b|difference|better than/.test(value)) return 'compare'
  if (/风险检查|风险预算|超预算|符合.*预算|预算.*(够|符合)|最多亏多少|会亏多少|亏多少|risk check|fit.*budget|within.*budget|how much can i lose|worst case/.test(value)) return 'risk_check'
  if (reference && /风险|亏|risk|lose|loss|安全|危险/.test(value)) return 'risk_check'
  if (/调整|换成|改成|改为|换到|换一个|换个|拉长|缩短|延长|更远|更近|再长|再短|再远|再近|长一点|短一点|长一些|短一些|行权价|到期日|adjust|switch to|change (?:the )?(?:strike|expiration|dte|budget|horizon)|(?:another|different|other) (?:strike|expiration)|move the (?:dte|strike|expiration)|longer|shorter|farther|further out|closer/.test(value)) return 'adjust'
  if (/解释|为什么|讲讲|讲一下|说说|说一下|分析一下|怎么理解|怎么赚钱|怎么亏|explain|why|walk me through|tell me about|break down/.test(value)) return 'explain'
  // A named or numbered strategy is the subject unless the user explicitly asks for new recommendations.
  if (reference && reference.kind !== 'focus' && !/推荐|建议|有什么|哪些|recommend|suggest|other ideas/.test(value)) return 'explain'
  if (/推荐|建议|适合|有什么策略|什么策略|哪些策略|哪个策略|方案|怎么做|怎么操作|怎么玩|recommend|suggest|best|which strateg|what strateg|strateg(?:y|ies) for|ideas?|what should|策略/.test(value)) return 'recommend'
  return 'clarify'
}

// ---------- contract-level edits ----------

const contractCue = /行权价|执行价|strikes?\b|合约|contract|宽一[点些档]|窄一[点些档]|加宽|拉宽|放宽|更宽|收窄|缩窄|更窄|wider|widen|narrower|更虚|虚一[点些档]|更价外|更实|实一[点些档]|更价内|\b(?:more|further)\s+(?:otm|itm)\b|(?<!第\s*)(?:\d+|[一二两三四五六七八九十]{1,3})\s*(?:张|手|contracts?|lots?)(?![一-龥]*(?:卡|图))|\d+(?:\.\d+)?\s*(?:的)?\s*(?:call|put)\b/i

// "把卖出的 1200 call 换成 1250" / "行权价换成 1100 和 1200" / "宽一点" / "2 张" / "到期日换成 12 月 19 日".
// Returns null when the message does not ask to change the contracts of a strategy.
export function parseContractAdjustment(message, reference) {
  const value = String(message).toLowerCase()
  if (/什么是|是什么|什么叫|啥是|是啥|什么意思|what is|what's|what are|meaning/.test(value)) return null
  const dateCue = /到期|expir/.test(value)
  const hasCue = contractCue.test(value)
  if (!hasCue && !dateCue) return null
  // Dates, budgets, targets, durations and percents are removed before strike numbers are read.
  let scrub = value
    .replace(/20\d{2}-\d{1,2}-\d{1,2}/g, ' ')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g, ' ')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/g, ' ')
    .replace(/(?:预算|最多(?:愿意|能|可以)?(?:亏|赔|损失)|亏损?|损失|止损|budget|risk|lose|max\s*loss)[^0-9，。,.]{0,6}\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|千|w|万)?/g, ' ')
    .replace(/(?:目标价?|涨到|跌到|升到|回到|target(?:\s*price)?)[^0-9，。,.]{0,4}\$?\s*\d[\d,]*(?:\.\d+)?/g, ' ')
  if (dateCue) scrub = scrub.replace(/(?<![\d/])\d{1,2}\/\d{1,2}(?![\d/])/g, ' ')
  const quantityPattern = /(?<!第\s*)(\d+|[一二两三四五六七八九十]{1,3})\s*(?:张|手|contracts?|lots?)/
  const quantityMatch = scrub.match(quantityPattern)
  const quantity = quantityMatch ? countValue(quantityMatch[1]) : undefined
  scrub = scrub.replace(new RegExp(quantityPattern.source, 'g'), ' ')
    .replace(/\d+(?:\.\d+)?\s*(?:%|％|个?交易日|天|日|周|个月|月|年|倍|days?|weeks?|months?|years?|dte|delta)/g, ' ')

  const selector = {}
  if (/买入的|买的那|买腿|买入腿|long\s+(?:leg|call|put)|buy\s+leg|bought/.test(value)) selector.action = 'buy'
  else if (/卖出的|卖的那|卖腿|卖出腿|short\s+(?:leg|call|put)|sell\s+leg|sold/.test(value)) selector.action = 'sell'
  const callCue = /\bcalls?\b|看涨期权/.test(value)
  const putCue = /\bputs?\b|看跌期权/.test(value)
  if (callCue !== putCue) selector.right = callCue ? 'call' : 'put'
  if (/低的|较低的|下面的|下腿|lower\s+(?:leg|strike)|低行权/.test(value)) selector.position = 'lower'
  else if (/高的|较高的|上面的|上腿|upper\s+(?:leg|strike)|higher\s+strike\s+leg|高行权/.test(value)) selector.position = 'upper'

  const replace = []
  const replacePattern = /\$?(\d+(?:\.\d+)?)\s*(?:的)?\s*(?:call|put|看涨|看跌)?\s*(?:换成|改成|改为|换到|移到|调到|调整到|挪到|->|→|\bto\b)\s*\$?(\d+(?:\.\d+)?)/g
  for (const match of scrub.matchAll(replacePattern)) replace.push({ from: Number(match[1]), to: Number(match[2]) })
  scrub = scrub.replace(replacePattern, ' ')

  const strikes = []
  const strikeAt = scrub.search(/行权价|执行价|strikes?\b|价差|spread/)
  if (strikeAt >= 0) for (const match of scrub.slice(strikeAt).matchAll(/\$?(\d+(?:\.\d+)?)/g)) strikes.push(Number(match[1]))
  else for (const match of scrub.matchAll(/\$?(\d+(?:\.\d+)?)\s*(?:的)?\s*(?:call|put)\b/g)) strikes.push(Number(match[1]))

  const stepCount = (pattern) => {
    const match = value.match(pattern)
    return match ? countValue(match[1] ?? '') || 1 : 0
  }
  const up = /(?:行权价|执行价|strikes?)[^，。,.!?]{0,6}(?:调高|提高|往上|上移|上调|高一|higher|up)|(?:调高|提高|上移|上调|raise|move up)[^，。,.!?]{0,6}(?:行权价|执行价|strikes?)/.test(value)
  const down = /(?:行权价|执行价|strikes?)[^，。,.!?]{0,6}(?:调低|降低|往下|下移|下调|低一|lower|down)|(?:调低|降低|下移|下调|move down)[^，。,.!?]{0,6}(?:行权价|执行价|strikes?)/.test(value)
  const steps = stepCount(/([一二两三四五12345])\s*(?:档|格|个行权价|steps?|strikes?\b)/) || 1
  const shift = up && !down ? steps : down && !up ? -steps : 0
  const otm = /更虚|虚一[点些档]|更价外|(?:more|further)\s+otm|further out of the money|更远的行权价|行权价更远/.test(value) ? 'otm'
    : /更实|实一[点些档]|更价内|(?:more|further)\s+itm|closer to the money|更近的行权价|行权价更近/.test(value) ? 'itm' : undefined
  const width = /宽一[点些档]|加宽|拉宽|放宽|更宽|wider|widen/.test(value) ? steps : /窄一[点些档]|收窄|缩窄|更窄|narrower|tighten/.test(value) ? -steps : 0

  const date = dateCue ? explicitDate(value) : undefined
  const otherEdit = strikes.length || replace.length || shift || otm || width || quantity
  // A bare "12 月到期" re-screens the horizon; it edits contracts only when a strategy is in view.
  const editsExpiration = /(?:到期日?|expiration|expiry)[^，。,.]{0,4}(?:换成|改成|改为|换到|调到|移到|change|move|switch|roll)/.test(value)
  const expiration = date && (reference || otherEdit || editsExpiration || /合约|这个|它|this|it\b/.test(value)) ? date : undefined
  if (!otherEdit && !expiration) return null
  return {
    strikes,
    replace,
    selector: Object.keys(selector).length ? selector : undefined,
    shift,
    otm,
    otmSteps: otm ? steps : undefined,
    width,
    quantity,
    expiration,
  }
}

function pricedContract(contract) {
  const twoSided = typeof contract.bid === 'number' && typeof contract.ask === 'number' && contract.bid >= 0 && contract.ask > 0 && contract.ask >= contract.bid
  return twoSided || (typeof contract.last === 'number' && contract.last > 0)
}

function selectLegs(legs, selector) {
  let indexes = legs.map((_, index) => index)
  if (!selector) return indexes
  if (selector.action) indexes = indexes.filter((index) => legs[index].action === selector.action)
  if (selector.right) indexes = indexes.filter((index) => legs[index].right === selector.right)
  if (selector.position && indexes.length > 1) {
    const strikes = indexes.map((index) => legs[index].strike)
    const pick = selector.position === 'lower' ? Math.min(...strikes) : Math.max(...strikes)
    indexes = indexes.filter((index) => legs[index].strike === pick)
  }
  return indexes
}

function nearest(list, target, count) {
  return [...list].sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b).slice(0, count).sort((a, b) => a - b)
}

// Turns a parsed edit into absolute values for every leg of the strategy, checked against the live chain.
// The structure (which leg sits above which) must survive, otherwise it would be a different strategy.
export function resolveContractAdjustment(strategy, request, contracts = []) {
  const legs = strategy?.legs ?? []
  const describe = legs.map((leg, legIndex) => ({ legIndex, action: leg.action, right: leg.right, strike: leg.strike, expiration: leg.expiration, quantity: leg.quantity }))
  const fail = (error, extra = {}) => ({ error, legs: describe, ...extra })
  if (!legs.length) return fail('no_legs')
  const rows = contracts.filter(pricedContract)
  if (!rows.length) return fail('no_chain')
  const next = legs.map((leg) => ({ strike: leg.strike, expiration: leg.expiration, quantity: leg.quantity ?? 1 }))
  const explicit = new Set()
  let requestedExpiration
  if (request.expiration) {
    if (new Set(legs.map((leg) => leg.expiration)).size > 1) return fail('mixed_expirations')
    const today = new Date().toISOString().slice(0, 10)
    const expirations = [...new Set(rows.map((row) => row.expiration))].filter((expiration) => expiration >= today)
    if (!expirations.length) return fail('no_chain')
    const target = Date.parse(`${request.expiration}T00:00:00Z`)
    const chosen = [...expirations].sort((a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - target) - Math.abs(Date.parse(`${b}T00:00:00Z`) - target) || a.localeCompare(b))[0]
    next.forEach((leg) => { leg.expiration = chosen })
    requestedExpiration = request.expiration
  }
  const ladder = (index) => [...new Set(rows.filter((row) => row.right === legs[index].right && row.expiration === next[index].expiration).map((row) => row.strike))].sort((a, b) => a - b)
  const step = (index, steps) => {
    const strikes = ladder(index)
    if (!strikes.length) return undefined
    let position = strikes.indexOf(next[index].strike)
    if (position < 0) position = strikes.indexOf(nearest(strikes, next[index].strike, 1)[0])
    return strikes[position + steps]
  }
  const selected = selectLegs(legs, request.selector)
  if (!selected.length) return fail('no_matching_leg')

  for (const { from, to } of request.replace ?? []) {
    const hits = selected.filter((index) => legs[index].strike === from)
    if (!hits.length) return fail('strike_not_in_strategy', { strike: from })
    hits.forEach((index) => { next[index].strike = to; explicit.add(index) })
  }
  if (request.strikes?.length) {
    const distinct = [...new Set(selected.map((index) => legs[index].strike))].sort((a, b) => a - b)
    const targets = [...new Set(request.strikes)].sort((a, b) => a - b)
    if (targets.length === 1 && distinct.length > 1) return fail('ambiguous_leg', { strike: targets[0] })
    if (targets.length > 1 && targets.length !== distinct.length) return fail('strike_count', { expected: distinct.length, strikes: targets })
    distinct.forEach((strike, position) => selected
      .filter((index) => legs[index].strike === strike)
      .forEach((index) => { next[index].strike = targets[position]; explicit.add(index) }))
  }
  if (request.shift || request.otm) {
    for (const index of selected) {
      const steps = request.otm
        ? (legs[index].right === 'call' ? 1 : -1) * (request.otm === 'otm' ? 1 : -1) * (request.otmSteps ?? 1)
        : request.shift
      const moved = step(index, steps)
      if (moved === undefined) return fail('strike_range')
      next[index].strike = moved
      explicit.add(index)
    }
  }
  if (request.width) {
    const strikes = legs.map((leg) => leg.strike)
    if (new Set(strikes).size < 2) return fail('no_width')
    const low = Math.min(...strikes)
    const high = Math.max(...strikes)
    let movers
    const short = legs.findIndex((leg) => leg.action === 'sell')
    if (legs.length === 2 && short >= 0 && legs.some((leg) => leg.action === 'buy')) {
      // A vertical keeps its long leg; the short leg moves away from (wider) or toward (narrower) it.
      movers = [[short, Math.sign(legs[short].strike - legs[1 - short].strike) * request.width]]
    } else {
      movers = legs.flatMap((leg, index) => leg.strike === low ? [[index, -request.width]] : leg.strike === high ? [[index, request.width]] : [])
    }
    for (const [index, steps] of movers) {
      const moved = step(index, steps)
      if (moved === undefined) return fail('strike_range')
      next[index].strike = moved
      explicit.add(index)
    }
  }
  if (request.quantity) {
    const base = Math.min(...legs.map((leg) => leg.quantity ?? 1))
    for (const [index, leg] of legs.entries()) {
      const quantity = Math.round(((leg.quantity ?? 1) / base) * request.quantity)
      if (quantity < 1 || quantity > 20) return fail('quantity_range', { quantity: request.quantity })
      next[index].quantity = quantity
    }
  }
  // A new expiration keeps each untouched leg at the closest listed strike.
  for (const index of legs.keys()) {
    const strikes = ladder(index)
    if (!explicit.has(index) && requestedExpiration && !strikes.includes(next[index].strike) && strikes.length) next[index].strike = nearest(strikes, next[index].strike, 1)[0]
    if (!strikes.includes(next[index].strike)) {
      return fail('strike_missing', { strike: next[index].strike, expiration: next[index].expiration, nearby: nearest(strikes, next[index].strike, 4), legIndex: index })
    }
  }
  for (let i = 0; i < legs.length; i += 1) {
    for (let j = i + 1; j < legs.length; j += 1) {
      if (Math.sign(legs[i].strike - legs[j].strike) !== Math.sign(next[i].strike - next[j].strike)) return fail('structure')
    }
  }
  const legChanges = legs.flatMap((leg, legIndex) => {
    const to = next[legIndex]
    if (to.strike === leg.strike && to.expiration === leg.expiration && to.quantity === (leg.quantity ?? 1)) return []
    return [{ legIndex, action: leg.action, right: leg.right, from: { strike: leg.strike, expiration: leg.expiration, quantity: leg.quantity ?? 1 }, to }]
  })
  if (!legChanges.length) return fail('no_change')
  return {
    adjustments: next.map((leg, legIndex) => ({ legIndex, ...leg })),
    legChanges,
    requestedExpiration: requestedExpiration && requestedExpiration !== next[0].expiration ? requestedExpiration : undefined,
  }
}

// ---------- sanity checks ----------

function round(value, digits = 1) {
  return Number(Number(value).toFixed(digits))
}

// A target that contradicts the stated view, or sits far outside what option prices imply, is confirmed before use.
export function targetSanity({ target, spot, impliedVolatility, days, direction }) {
  if (!(target > 0) || !(spot > 0)) return undefined
  const move = target / spot - 1
  const sigma = impliedVolatility > 0 && days > 0 ? impliedVolatility * Math.sqrt(days / 365) : undefined
  const facts = {
    target,
    spot,
    movePercent: round(move * 100),
    days,
    impliedVolatilityPercent: impliedVolatility > 0 ? round(impliedVolatility * 100) : undefined,
    oneSigmaPercent: sigma ? round(sigma * 100) : undefined,
    sigmas: sigma ? round(Math.abs(move) / sigma) : undefined,
  }
  if ((direction === 'bullish' && target < spot) || (direction === 'bearish' && target > spot)) {
    return { reason: 'direction', direction, ...facts, confirm: { targetPrice: target, direction: target < spot ? 'bearish' : 'bullish' } }
  }
  if (target > spot * 5 || target < spot * 0.2 || (sigma && Math.abs(move) > 3 * sigma)) {
    return { reason: 'extreme', direction, ...facts, confirm: { targetPrice: target } }
  }
  return undefined
}

// "如果跌到 1000 会亏多少" asks about a scenario; the price is not the user's target or view.
export function hypotheticalPrice(message) {
  const value = String(message).toLowerCase()
  if (!/如果|假如|假设|要是|万一|倘若|\bif\b|what if|suppose|assuming/.test(value)) return undefined
  const price = '\\s*\\$?\\s*(\\d[\\d,]*(?:\\.\\d+)?)(?![\\d,.])(?!\\s*(?:月|日|号|天|周|%|％|个|张|股|days?|weeks?|months?))'
  const match = value.match(new RegExp(`(?:涨到|跌到|升到|回到|跌破|涨破|reaches?|hits?|drops? to|falls? to|rises? to|goes? to)${price}`))
    ?? value.match(new RegExp(`(?:到|在|是|为|at|to)${price}`))
  const number = match ? Number(match[1].replaceAll(',', '')) : undefined
  return number > 0 ? number : undefined
}

// Position Greeks in plain units: delta in shares, theta and vega in dollars per day / per IV point.
export function netGreeks(strategy) {
  const legs = strategy?.legs ?? []
  if (!legs.length) return undefined
  const total = (key) => {
    const values = legs.map((leg) => (typeof leg[key] === 'number' ? leg[key] * (leg.action === 'buy' ? 1 : -1) * (leg.quantity ?? 1) * 100 : undefined))
    return values.some((item) => item === undefined) ? undefined : round(values.reduce((sum, item) => sum + item, 0), 2)
  }
  return { delta: total('delta'), gamma: total('gamma'), theta: total('theta'), vega: total('vega') }
}

export function scenarioPl(strategy, price) {
  if (!strategy?.legs?.length || !(price > 0)) return undefined
  return strategyExpirationPayoff(strategy.legs, price)
}

// Rule-based extraction for one user turn. Answers to a pending follow-up are resolved against that field.
export function parseAssistantTurn(message, prior = {}) {
  const pendingField = prior.pending?.field
  const reference = strategyReference(message, prior)
  const patch = {
    ticker: ticker(message),
    direction: direction(message),
    strength: strength(message),
    horizon: horizon(message),
    riskBudget: riskBudget(message),
    targetPrice: targetPrice(message),
    experienceLevel: experienceLevel(message, pendingField),
  }
  const owns = /没有(?:持有)?(?:正)?股|不持有|no shares|don'?t own/i.test(message) ? false
    : /(?:持有|有)\s*\d*\s*股|own\s+\d*\s*shares|hold\s+\d*\s*shares/i.test(message) ? true : undefined
  if (owns !== undefined) patch.ownsShares = owns
  const shares = String(message).match(/(\d[\d,]*)\s*(?:股|shares)/i)
  if (shares && owns !== false) patch.sharesCount = amount(shares[1])
  const assignment = /不(?:愿意|想|接受)(?:被)?(?:指派|接股|行权)|not willing to be assigned|no assignment|avoid assignment/i.test(message) ? false
    : /愿意(?:被)?(?:指派|接股)|不介意(?:被)?(?:指派|接股)|ok with assignment|willing to be assigned|fine with assignment/i.test(message) ? true : undefined
  if (assignment !== undefined) patch.acceptsAssignment = assignment

  // Negative or zero amounts are never silently "fixed"; the user is asked what they meant.
  const invalid = []
  for (const [field, detail] of [['riskBudget', riskBudgetDetail(message)], ['targetPrice', targetPriceDetail(message)]]) {
    if (detail.invalid) invalid.push({ field, reason: detail.invalid, value: detail.value })
  }
  if (['riskBudget', 'targetPrice'].includes(pendingField) && !invalid.some((item) => item.field === pendingField)) {
    const negative = bareNegative(message)
    if (negative !== undefined) invalid.push({ field: pendingField, reason: 'negative', value: negative })
    else if (bareNumber(message) === 0) invalid.push({ field: pendingField, reason: 'zero', value: 0 })
  }
  invalid.forEach((item) => delete patch[item.field])

  // A pending confirmation ("目标价 2000 确认吗？") is settled by yes/no before anything else.
  let confirmedFields = []
  let declinedField
  const confirm = prior.pending?.confirm
  if (confirm && Object.keys(confirm).length) {
    const answer = confirmation(message)
    // "不是，是 3000" / "对，3000" answers with a different number: that number wins and is checked again.
    const numbers = [...String(message).matchAll(/(?<![\d.-])(\d[\d,]*(?:\.\d+)?)/g)].map((match) => Number(match[1].replaceAll(',', ''))).filter((number) => number > 0)
    const replacement = ['riskBudget', 'targetPrice'].includes(pendingField) && numbers.length === 1 && numbers[0] !== confirm[pendingField] ? numbers[0] : undefined
    if (answer !== undefined && replacement !== undefined && !invalid.length) {
      if (patch[pendingField] === undefined) patch[pendingField] = replacement
    } else if (answer === true) {
      for (const [field, value] of Object.entries(confirm)) if (patch[field] === undefined) patch[field] = value
      confirmedFields = Object.keys(confirm)
    } else if (answer === false) {
      declinedField = pendingField
    }
  }

  let skippedField
  // Asking about a strategy's mechanics never changes the user's own market view.
  if (reference?.kind === 'name' && /什么是|是什么|什么叫|解释|讲讲|what is|explain/.test(String(message).toLowerCase())) delete patch.direction
  if (pendingField) {
    const number = bareNumber(message)
    const bool = yesNo(message)
    if (['riskBudget', 'targetPrice', 'sharesCount'].includes(pendingField) && number !== undefined && number > 0 && patch[pendingField] === undefined && !invalid.length) {
      patch[pendingField] = number
    }
    if (pendingField === 'ownsShares' && bool !== undefined) patch.ownsShares = bool
    if (pendingField === 'acceptsAssignment' && bool !== undefined) patch.acceptsAssignment = bool
    if (skipped(message)) skippedField = pendingField
  }
  // "不是，是 3000" declines the suggested value and answers with a new one in the same breath.
  if (declinedField && patch[declinedField] !== undefined) declinedField = undefined
  Object.keys(patch).forEach((key) => (patch[key] === undefined || Number.isNaN(patch[key])) && delete patch[key])
  const forecast = isForecastQuestion(message)
  // A forecast question carries no view, horizon or budget of the user's own; only a new ticker matters.
  if (forecast) Object.keys(patch).filter((key) => key !== 'ticker').forEach((key) => delete patch[key])
  let intent = forecast ? 'clarify' : confirmedFields.length || declinedField ? prior.pending?.intent ?? 'recommend' : classifyAssistantIntent(message, reference)
  // "换成熊市价差" switches the subject to that strategy rather than re-running the screen.
  if (intent === 'adjust' && reference?.kind === 'name') intent = 'explain'
  // A bare pronoun question ("它怎么样") is about the focus strategy; a stated view is not.
  if (intent === 'clarify' && !forecast && reference?.kind === 'focus' && !['direction', 'horizon', 'riskBudget', 'targetPrice', 'ticker'].some((field) => patch[field] !== undefined)) intent = 'explain'
  // "第三个" when the last list had two items must not silently fall back to another strategy.
  const missingOrdinals = ordinals(message).filter((index) => !prior.lastReferencedIds?.[index - 1])
  if (missingOrdinals.length && intent === 'clarify') intent = /风险|亏|risk|lose|loss/i.test(message) ? 'risk_check' : 'explain'
  const scenarioPrice = hypotheticalPrice(message)
  if (scenarioPrice !== undefined) {
    for (const field of ['targetPrice', 'direction', 'strength']) delete patch[field]
    if (intent === 'clarify' || intent === 'recommend') intent = /亏|损失|lose|loss|risk|风险/i.test(message) ? 'risk_check' : 'explain'
  }
  let contract = scenarioPrice === undefined && !confirmedFields.length ? parseContractAdjustment(message, reference) : null
  // With no strategy in view, a date-only edit is a new horizon for the screen, not a contract edit.
  const inView = reference || prior.focusStrategyId || prior.lastReferencedIds?.length || prior.clientSelectedId
  if (contract && !inView && contract.expiration && !contract.strikes.length && !contract.replace.length && !contract.shift && !contract.otm && !contract.width && !contract.quantity) contract = null
  if (contract && intent !== 'educate') {
    intent = 'adjust'
    // A strike or expiration written for a specific contract is not a new horizon or target for the screen.
    if (contract.expiration) delete patch.horizon
  }
  return { intent, patch, reference, references: strategyReferences(message, prior), skippedField, forecast, missingOrdinals, invalid, confirmedFields, declinedField, contract: contract ?? undefined, scenarioPrice }
}

// Short follow-up answers inherit the intent that asked the question; profile-only messages re-run recommendations.
export function resolveIntent(intent, { prior = {}, patch = {}, skippedField, message = '', forecast = false } = {}) {
  if (intent !== 'clarify' || forecast) return intent
  if (prior.pending?.intent && (Object.keys(patch).length || skippedField)) return prior.pending.intent
  if (['direction', 'horizon', 'riskBudget', 'targetPrice', 'ticker'].some((field) => patch[field] !== undefined)) {
    return ['explain', 'risk_check'].includes(prior.lastIntent) ? prior.lastIntent : 'recommend'
  }
  if (conceptFor(message)) return 'educate'
  return 'clarify'
}

export function shiftHorizon(current, message) {
  const value = String(message).toLowerCase()
  // "更远的行权价" moves the strike, not the expiration.
  if (/行权价|strike/.test(value) && !/到期|周期|期限|expir|dte|horizon/.test(value)) return undefined
  const step = /拉长|延长|更远|更长|再长|再远|长一点|长一些|longer|farther|further out|extend/.test(value) ? 1 : /缩短|更近|更短|再短|再近|短一点|短一些|shorter|closer|sooner/.test(value) ? -1 : 0
  if (!step) return undefined
  const index = Math.max(0, horizonSteps.indexOf(horizonFromDays(horizonDays(current))))
  return horizonSteps[Math.min(horizonSteps.length - 1, Math.max(0, index + step))]
}

export function horizonDays(value = '1 month') {
  const parsed = horizon(value)
  const text = String(parsed ?? value)
  const match = text.match(/(\d+)\s*(week|month|year)/)
  if (!match) return /long/.test(text) ? 365 : 30
  return Number(match[1]) * ({ week: 7, month: 30, year: 365 })[match[2]]
}

// ---------- conversation memory ----------

export function normalizeAgentState(value, normalizeProfile) {
  const raw = value && typeof value === 'object' ? value : {}
  const pendingConfirm = raw.pending?.confirm && typeof raw.pending.confirm === 'object' ? normalizeProfile(raw.pending.confirm) : undefined
  const pending = raw.pending && typeof raw.pending === 'object' && assistantIntents.includes(raw.pending.intent)
    ? {
        intent: raw.pending.intent,
        field: typeof raw.pending.field === 'string' ? raw.pending.field : undefined,
        ...(pendingConfirm && Object.keys(pendingConfirm).length ? { confirm: pendingConfirm } : {}),
      }
    : undefined
  const ids = (list) => (Array.isArray(list) ? list.map(String).filter((id) => /^[a-z0-9-]{2,60}$/.test(id)).slice(0, 6) : [])
  return {
    profile: normalizeProfile(raw.profile ?? {}),
    pending,
    asked: Array.isArray(raw.asked) ? raw.asked.map(String).filter((field) => followUpOrder.includes(field)) : [],
    lastIntent: assistantIntents.includes(raw.lastIntent) ? raw.lastIntent : undefined,
    lastReferencedIds: ids(raw.lastReferencedIds),
    focusStrategyId: ids([raw.focusStrategyId])[0],
    clientSelectedId: ids([raw.clientSelectedId])[0],
    contractOverrides: normalizeContractOverrides(raw.contractOverrides),
  }
}

// Chat-made contract edits, keyed by strategy id: absolute leg values the engine re-prices every turn.
export function normalizeContractOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [id, list] of Object.entries(value).slice(0, 6)) {
    if (!/^[a-z0-9-]{2,60}$/.test(id) || !Array.isArray(list)) continue
    const legs = list.slice(0, 6).map((item) => ({
      legIndex: Number(item?.legIndex),
      ...(Number.isFinite(Number(item?.strike)) && Number(item.strike) > 0 ? { strike: Number(item.strike) } : {}),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(String(item?.expiration ?? '')) ? { expiration: String(item.expiration) } : {}),
      ...(Number.isInteger(Number(item?.quantity)) && Number(item.quantity) >= 1 && Number(item.quantity) <= 20 ? { quantity: Number(item.quantity) } : {}),
    })).filter((item) => Number.isInteger(item.legIndex) && item.legIndex >= 0 && item.legIndex < 6)
    if (legs.length) result[id] = legs
  }
  return result
}

const tickerScopedFields = ['targetPrice', 'ownsShares', 'sharesCount', 'eventContext']

export function withoutTickerScoped(profile = {}) {
  return Object.fromEntries(Object.entries(profile).filter(([key]) => !tickerScopedFields.includes(key)))
}

// A new ticker keeps the user's general preferences (view, horizon, budget, experience) but drops
// everything tied to the old underlying: target price, share holdings, strategy references.
// previousTicker covers conversations whose ticker came from the page rather than from chat.
export function scopeStateToTicker(prior, patchTicker, previousTicker = prior.profile?.ticker) {
  const current = prior.profile?.ticker ?? previousTicker
  const changed = Boolean(patchTicker && current && patchTicker !== current)
  if (!changed) return { prior, tickerChanged: false }
  return {
    tickerChanged: true,
    prior: {
      ...prior,
      profile: withoutTickerScoped(prior.profile),
      pending: undefined,
      asked: prior.asked.filter((field) => field !== 'targetPrice'),
      lastReferencedIds: [],
      focusStrategyId: undefined,
      clientSelectedId: undefined,
      contractOverrides: {},
    },
  }
}

// The model only fills gaps with values the user actually wrote; it never invents a ticker or amount,
// and never turns a question about a strategy (or a forecast question) into the user's own view.
// Every amount the user actually typed, in any notation ("2k", "1.5万", "两千"), for checking model output.
function writtenAmounts(message) {
  const pattern = new RegExp(`${amountToken}${amountTail}`, 'gi')
  return [...String(message).matchAll(pattern)]
    .map((match) => amount(match[1], match[2]))
    .filter((number) => number !== undefined && number >= 10)
}

export function sanitizeModelPatch(modelPatch = {}, message = '', turn = {}) {
  const value = String(message)
  const patch = { ...modelPatch }
  if (patch.ticker && !value.toUpperCase().includes(String(patch.ticker).toUpperCase())) delete patch.ticker
  for (const field of ['riskBudget', 'targetPrice', 'sharesCount']) {
    if (patch[field] === undefined || turn.patch?.[field] !== undefined) continue
    const digits = String(patch[field]).replace(/\.0+$/, '')
    const written = writtenAmounts(value).some((number) => Math.abs(number - Number(patch[field])) < 0.0001)
      || value.replaceAll(',', '').includes(digits)
    if (!written && turn.pendingField !== field) delete patch[field]
  }
  for (const item of turn.invalid ?? []) delete patch[item.field]
  // A "what if it drops to 1000" price is a scenario, not the user's target or view.
  if (turn.scenarioPrice !== undefined) for (const field of ['targetPrice', 'direction', 'strength']) if (turn.patch?.[field] === undefined) delete patch[field]
  // Strikes typed for a contract edit are not a budget or target.
  if (turn.contract) for (const field of ['riskBudget', 'targetPrice']) if (turn.patch?.[field] === undefined) delete patch[field]
  if (turn.forecast || ['educate', 'explain', 'risk_check', 'compare'].includes(turn.intent)) {
    for (const field of ['direction', 'strength', 'horizon']) if (turn.patch?.[field] === undefined) delete patch[field]
  }
  return patch
}

// "该不该买 MU" / "推荐一只股票" asks for personal investment advice, which the assistant does not give.
export function isAdviceRequest(message) {
  const value = String(message).toLowerCase()
  if (/期权|call|put|价差|spread|策略|strateg|option|跨式|蝶式|铁鹰/.test(value)) return false
  return /(?:该不该|应不应该|应该|要不要|能不能|可不可以|可以|现在能|适不适合|值不值得)(?:现在)?(?:买|卖|入手|抄底|加仓|减仓|清仓|卖出|买入|上车|入场)|推荐.{0,6}(?:股票|个股)|哪(?:只|支|个)股票|买什么股|should\s+i\s+(?:buy|sell)|good time to (?:buy|sell)|which stocks?\s+(?:should|to)\s+buy|good stock to buy|worth buying/.test(value)
}

export function adviceBoundaryAnswer(ticker, isZh) {
  return text(
    isZh,
    `我不能告诉你该不该买卖某只股票，也不做个股推荐，这需要结合你的整体财务状况由持牌顾问判断。我能做的是按你自己的看法，在${ticker ? ` ${ticker} 的` : ''}实时期权链上做情景分析，比较不同策略的最大亏损、收益和盈亏平衡。告诉我你的方向、周期和最多愿意亏多少就行。`,
    `I cannot tell you whether to buy or sell a stock or pick stocks for you; that needs a licensed advisor who knows your full situation. What I can do is run scenario analysis on${ticker ? ` ${ticker}'s` : ' a'} live option chain for your own view, comparing max loss, profit and breakeven across strategies. Tell me your direction, horizon and max loss.`,
  )
}

const listModes = new Set(['recommend', 'compare', 'education_only'])

export function nextAgentState({ prior, plan, intent, memoryProfile, asked, changes = [], clientSelectedId, contractOverrides = prior.contractOverrides ?? {} }) {
  const ids = plan.referencedStrategyIds ?? []
  // Ordinals ("第二个") always point into the last list the user saw, not the last single card.
  const isList = listModes.has(plan.mode) && ids.length >= (plan.mode === 'compare' ? 2 : 1)
  // A concept question in the middle of a follow-up keeps the open question alive.
  const keepPending = !plan.followUpField && ['educate', 'chat', 'ordinal_missing'].includes(plan.mode) && !changes.length
  return {
    profile: memoryProfile,
    pending: plan.followUpField
      ? { intent: plan.pendingIntent ?? intent, field: plan.followUpField, ...(plan.confirm ? { confirm: plan.confirm } : {}) }
      : keepPending ? prior.pending : undefined,
    // Re-asking after a typo or a sanity check is not the one-time optional follow-up.
    asked: plan.followUpField && !['invalid_input', 'target_check'].includes(plan.mode) && !plan.declined ? [...new Set([...asked, plan.followUpField])] : asked,
    lastIntent: intent,
    lastReferencedIds: isList ? ids : prior.lastReferencedIds,
    focusStrategyId: plan.focusStrategyId ?? prior.focusStrategyId,
    clientSelectedId,
    contractOverrides,
  }
}

// ---------- risk helpers ----------

function finiteMaxLoss(strategy) {
  return typeof strategy?.maxLoss === 'number' && Number.isFinite(strategy.maxLoss) ? strategy.maxLoss : undefined
}

export function riskProblem(strategy, budget, isZh) {
  if (!strategy || budget === undefined) return undefined
  if (!Number.isFinite(Number(budget)) || Number(budget) <= 0) {
    return text(isZh, '风险预算必须是大于 0 的数字。', 'Risk budget must be a number greater than 0.')
  }
  const name = displayName(strategy, isZh)
  if (strategy.maxLoss === 'unlimited') return text(isZh, `${name} 最大亏损无上限，不符合固定风险预算。`, `${name} has uncapped maximum loss and does not fit a fixed risk budget.`)
  if (strategy.maxLoss === 'variable') return text(isZh, `${name} 最大亏损不固定，需要人工复核才能匹配固定风险预算。`, `${name} has variable maximum loss and needs manual review against a fixed risk budget.`)
  const loss = finiteMaxLoss(strategy)
  if (loss !== undefined && loss > budget) {
    return text(isZh, `${name} 最大亏损 ${usd(loss)}，超过你 ${usd(budget)} 的风险预算。`, `${name} max loss is ${usd(loss)}, above your ${usd(budget)} risk budget.`)
  }
  return undefined
}

function budgetFit(strategy, budget) {
  if (budget === undefined) return undefined
  const loss = finiteMaxLoss(strategy)
  return loss !== undefined && loss <= budget
}

// ---------- formatting ----------

export function usd(value) {
  return `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

function plain(value) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export function displayName(strategy, isZh) {
  const zh = educationById.get(strategy?.id)?.zhName
  return isZh && zh ? `${zh}（${strategy.name}）` : strategy?.name ?? ''
}

const labelText = {
  best_fit: ['最匹配', 'Best fit'],
  conservative: ['偏保守', 'Conservative'],
  aggressive: ['偏激进', 'Aggressive'],
  conditional: ['条件型', 'Conditional'],
}

const zhRankText = {
  'Matches selected market direction.': '与你的方向观点一致',
  'Max loss fits the stated risk budget.': '最大亏损在风险预算内',
  'Max loss is slightly above the stated risk budget.': '最大亏损略高于风险预算',
  'Max loss is above the stated risk budget.': '最大亏损超过风险预算',
  'Risk is uncapped or variable and needs manual review.': '风险无上限或不固定，需要人工复核',
  'Defined maximum loss.': '最大亏损在开仓时就确定',
  'Target-case P/L remains positive after estimated quote cost.': '扣除估算买卖价差后，目标价情景仍盈利',
  'Target-case reward is evaluated against defined maximum loss.': '目标价收益已与最大亏损对比评估',
  'Target-case P/L is not positive after estimated quote cost.': '扣除买卖价差后，目标价情景不盈利',
  'Conditional strategy benefits from a clearer target price.': '该策略需要更明确的目标价',
  'Expiration matches the stated horizon.': '到期日与你的周期匹配',
  'Expiration is close to the stated horizon.': '到期日接近你的周期',
  'Expiration is away from the stated horizon.': '到期日与你的周期有偏差',
  'Probability-of-profit estimate is supportive, not decisive.': '盈利概率估计较好，但不是决定因素',
  'Low probability-of-profit estimate.': '盈利概率估计偏低',
  'Tighter quoted bid/ask spread.': '买卖价差较窄，流动性较好',
  'Wide quoted bid/ask spread.': '买卖价差较宽，成交成本高',
  'Higher IV favors premium-selling structures.': '当前 IV 偏高，对卖权利金结构有利',
  'High IV makes long premium more expensive.': '当前 IV 偏高，买入期权更贵',
  'Positive vega can suffer if elevated IV contracts.': '正 Vega 持仓在 IV 回落时会受损',
  'Lower IV favors long-premium structures.': '当前 IV 偏低，对买入期权结构有利',
  'Low IV offers less premium for short-option structures.': '当前 IV 偏低，卖权利金收入较少',
  'Assignment-related strategy; user is not willing to be assigned.': '涉及被指派风险（你尚未确认是否接受被指派）',
  'Greeks do not show clear long-volatility exposure.': 'Greeks 未显示明确的做多波动率敞口',
  'Higher gamma can make P/L change quickly.': 'Gamma 较高，盈亏变化会很快',
  'Low volume/open interest may make execution harder.': '成交量或未平仓量偏低，成交可能困难',
  'Multi-leg structure may be harder for beginners.': '多腿结构对新手较复杂',
  'Negative theta needs a timely move.': '负 Theta，需要价格及时移动',
  'Net delta does not match the bearish view.': '净 Delta 与看跌观点方向不一致',
  'Net delta does not match the bullish view.': '净 Delta 与看涨观点方向不完全一致',
  'Net delta is directional for a neutral view.': '净 Delta 有方向性，与中性观点不符',
}

// Untranslated engine strings are dropped in Chinese mode rather than shown in English.
function rankTexts(values = [], isZh, limit = 2) {
  return values.map((value) => (isZh ? zhRankText[value] : value)).filter(Boolean).slice(0, limit)
}

function legText(leg, isZh) {
  const right = leg.right === 'call' ? 'Call' : 'Put'
  const price = Number.isFinite(leg.premium) ? text(isZh, `，参考价 ${plain(leg.premium)}`, ` @ ${plain(leg.premium)}`) : ''
  return isZh
    ? `${leg.action === 'buy' ? '买入' : '卖出'} ${leg.quantity} 张 ${leg.expiration} ${plain(leg.strike)} ${right}${price}`
    : `${leg.action === 'buy' ? 'Buy' : 'Sell'} ${leg.quantity} × ${leg.expiration} ${plain(leg.strike)} ${right}${price}`
}

function moneyOrWord(value, isZh) {
  if (value === 'unlimited') return text(isZh, '无上限', 'unlimited')
  if (value === 'variable') return text(isZh, '不固定', 'variable')
  return Number.isFinite(value) ? usd(value) : text(isZh, '待计算', 'n/a')
}

export // netDebitCredit is the whole position divided by the 100-share multiplier, so it is only
// "per share" for a single set. Split it into per-set-per-share and the position total.
function gcd(a, b) {
  return b ? gcd(b, a % b) : a
}

export function premiumFacts(strategy) {
  if (!Number.isFinite(strategy?.netDebitCredit) || !strategy.legs?.length) return undefined
  const quantities = strategy.legs.map((leg) => Math.abs(Math.round(leg.quantity ?? 1))).filter((qty) => qty > 0)
  const sets = quantities.length ? quantities.reduce(gcd) : 1
  return {
    sets,
    perSharePerSet: round(strategy.netDebitCredit / sets, 2),
    positionTotal: round(strategy.netDebitCredit * 100, 2),
  }
}

export function premiumPlanFields(strategy) {
  const premium = premiumFacts(strategy)
  if (!premium) return {}
  return {
    netDebitCreditPerSharePerSet: premium.perSharePerSet,
    sets: premium.sets,
    positionNetDebitCreditTotal: premium.positionTotal,
  }
}

// Reply in the language the user writes in; numbers/tickers-only turns follow the conversation, then the UI.
function messageLanguage(message) {
  const value = String(message ?? '')
  if (/[\u4e00-\u9fff]/.test(value)) return 'zh'
  const words = value.replace(/\b[A-Z]{1,5}\b/g, ' ').match(/[A-Za-z]{2,}/g) ?? []
  return words.length >= 2 ? 'en' : undefined
}

export function replyLanguage(userMessage, history = [], uiLanguage = 'en') {
  const own = messageLanguage(userMessage)
  if (own) return own
  for (const item of [...history].reverse()) {
    if (item?.role !== 'user') continue
    const previous = messageLanguage(item.content)
    if (previous) return previous
  }
  return uiLanguage === 'zh' ? 'zh' : 'en'
}

// Expiration payoff is piecewise linear between strikes, so its maximum sits on a strike or runs off an edge.
// Returns where max profit is reached: { from, to } with null meaning unbounded on that side.
export function maxProfitZone(strategy) {
  const strikes = [...new Set((strategy?.legs ?? []).map((leg) => leg.strike).filter(Number.isFinite))].sort((a, b) => a - b)
  if (!strikes.length) return undefined
  const high = strikes[strikes.length - 1] * 3
  const points = [0, ...strikes, high]
  const values = points.map((price) => strategyExpirationPayoff(strategy.legs, price))
  const best = Math.max(...values)
  const hits = points.filter((_, index) => values[index] >= best - 0.5)
  // Best only at an edge means profit keeps growing that way (long call/put): no flat max-profit zone.
  if (hits.length === 1 && (hits[0] === 0 || hits[0] === high)) return undefined
  const from = hits[0] === 0 ? null : hits[0]
  const to = hits[hits.length - 1] === high ? null : hits[hits.length - 1]
  if (from === null && to === null) return undefined
  return { from, to }
}

// Direction words the narrator may use for the trade-off; computed here so the model cannot invent them.
export function changeDirections(before, after) {
  const direction = (a, b) => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 'n/a'
    if (Math.abs(b - a) < 1e-6) return 'unchanged'
    return b > a ? 'higher' : 'lower'
  }
  const firstBreakeven = (strategy) => (strategy.breakevens ?? (strategy.breakeven ? [strategy.breakeven] : []))[0]
  const cost = (strategy) => (Number.isFinite(strategy.netDebitCredit) ? Math.abs(strategy.netDebitCredit) : undefined)
  const ratio = (strategy) => (Number.isFinite(strategy.maxProfit) && strategy.maxLoss > 0 ? strategy.maxProfit / strategy.maxLoss : undefined)
  return {
    positionCost: direction(cost(before), cost(after)),
    maxLoss: direction(before.maxLoss, after.maxLoss),
    maxProfit: direction(before.maxProfit, after.maxProfit),
    firstBreakeven: direction(firstBreakeven(before), firstBreakeven(after)),
    probabilityOfProfit: direction(before.probabilityOfProfit, after.probabilityOfProfit),
    rewardToRisk: direction(ratio(before), ratio(after)),
  }
}

function strategyCard(strategy, isZh, budget) {
  const edu = educationById.get(strategy.id)
  const label = labelText[strategy.label]?.[isZh ? 0 : 1]
  const lines = []
  if (strategy.legs?.length) lines.push(...strategy.legs.map((leg) => legText(leg, isZh)))
  const metrics = [
    `${text(isZh, '最大亏损', 'Max loss')} ${moneyOrWord(strategy.maxLoss, isZh)}`,
    `${text(isZh, '最大收益', 'Max profit')} ${moneyOrWord(strategy.maxProfit, isZh)}`,
  ]
  const breakevens = strategy.breakevens ?? (strategy.breakeven ? [strategy.breakeven] : [])
  if (breakevens.length) metrics.push(`${text(isZh, '盈亏平衡', 'Breakeven')} ${breakevens.map(plain).join(' / ')}`)
  if (Number.isFinite(strategy.probabilityOfProfit)) metrics.push(`${text(isZh, '盈利概率', 'POP')} ${plain(strategy.probabilityOfProfit)}%`)
  if (strategy.legs?.length) lines.push(metrics.join(' · '))
  const premium = premiumFacts(strategy)
  if (premium) {
    const debit = premium.perSharePerSet >= 0
    const amount = usd(Math.abs(premium.perSharePerSet))
    const total = usd(Math.abs(premium.positionTotal))
    lines.push(premium.sets > 1
      ? (debit
          ? text(isZh, `净支出 ${amount}/股 × ${premium.sets} 组（合计 ${total}）`, `Net debit ${amount}/share × ${premium.sets} sets (total ${total})`)
          : text(isZh, `净收入 ${amount}/股 × ${premium.sets} 组（合计 ${total}）`, `Net credit ${amount}/share × ${premium.sets} sets (total ${total})`))
      : (debit
          ? text(isZh, `净支出 ${amount}/股（每张合约 100 股）`, `Net debit ${amount}/share (100 shares per contract)`)
          : text(isZh, `净收入 ${amount}/股（每张合约 100 股）`, `Net credit ${amount}/share (100 shares per contract)`)))
  }
  const why = isZh ? edu?.summary ?? strategy.whyItFits : strategy.whyItFits ?? edu?.summary
  if (why) lines.push(`${text(isZh, '思路', 'Idea')}：${why}`)
  const reasons = rankTexts(strategy.rankReasons, isZh)
  if (reasons.length) lines.push(`${text(isZh, '匹配点', 'Fit')}：${reasons.join(isZh ? '；' : '; ')}`)
  const problem = riskProblem(strategy, budget, isZh)
  const warnings = [problem, ...rankTexts(strategy.rankWarnings, isZh)].filter(Boolean)
  if (warnings.length) lines.push(`${text(isZh, '注意', 'Watch')}：${warnings.join(isZh ? '；' : '; ')}`)
  if (!strategy.legs?.length) lines.push(text(isZh, '需要实时期权链才能给出具体合约。', 'Contract legs require a live option chain.'))
  return {
    title: [displayName(strategy, isZh), label].filter(Boolean).join(' · '),
    body: lines.join('\n'),
    strategyId: strategy.id,
  }
}

function strategyFacts(strategy, budget, spot) {
  const edu = educationById.get(strategy.id)
  const breakevens = strategy.breakevens ?? (strategy.breakeven ? [strategy.breakeven] : [])
  return {
    id: strategy.id,
    name: strategy.name,
    zhName: edu?.zhName,
    label: strategy.label,
    status: strategy.status,
    legs: (strategy.legs ?? []).map((leg) => ({
      action: leg.action,
      right: leg.right,
      strike: leg.strike,
      expiration: leg.expiration,
      quantity: leg.quantity,
      premium: leg.premium,
      delta: leg.delta,
      theta: leg.theta,
      vega: leg.vega,
      impliedVolatility: leg.impliedVolatility,
    })),
    ...premiumPlanFields(strategy),
    maxLoss: strategy.maxLoss,
    maxProfit: strategy.maxProfit,
    breakevens,
    breakevenDistancePercent: spot > 0 ? breakevens.map((value) => round((value / spot - 1) * 100)) : undefined,
    netGreeks: netGreeks(strategy),
    probabilityOfProfitPercent: strategy.probabilityOfProfit,
    expectedMove: strategy.expectedMove,
    targetPricePl: strategy.targetPricePl,
    scenarios: (strategy.scenarioRows ?? strategy.scenarios ?? []).slice(0, 5),
    fitsRiskBudget: budgetFit(strategy, budget),
    rankReasons: strategy.rankReasons,
    rankWarnings: strategy.rankWarnings,
    playbook: strategy.playbook
      ? {
          profitManagement: strategy.playbook.profitManagement?.slice(0, 2),
          riskManagement: strategy.playbook.riskManagement?.slice(0, 2),
          timeManagement: strategy.playbook.timeManagement?.slice(0, 2),
        }
      : undefined,
    education: edu
      ? { summary: edu.summary, bestFor: edu.bestFor, avoidWhen: edu.avoidWhen, keyRisks: edu.keyRisks, payoff: edu.payoff }
      : undefined,
  }
}

function humanGap(gap) {
  return String(gap).replace(/^QVERIS_[A-Z_]+:\s*/, '')
}

// ---------- plan ----------

const directionText = {
  bullish: ['看涨', 'bullish'],
  bearish: ['看跌', 'bearish'],
  neutral: ['震荡/中性', 'neutral'],
  volatile: ['大幅波动', 'volatile'],
}

export function profileQuestion(field, isZh) {
  const questions = {
    ticker: ['你想分析哪只美股？告诉我 ticker 就行，比如 MU、NVDA。', 'Which US ticker do you want to analyze (e.g. MU, NVDA)?'],
    direction: ['你对它接下来的看法偏看涨、看跌、震荡，还是赌大幅波动？', 'Is your view bullish, bearish, neutral, or a big move either way?'],
    riskBudget: ['这笔模拟交易最多愿意亏多少美元？告诉我后我会把超出预算的方案筛掉。', 'What is the most you are willing to lose on this paper trade? I will filter out anything above it.'],
    targetPrice: ['你心里有目标价吗？有的话我可以按目标价情景比较各方案。', 'Do you have a target price? I can compare candidates at that price.'],
    experienceLevel: ['你的期权经验大概是新手、进阶还是熟练？我会据此调整解释深度和可选策略。', 'How experienced are you with options: beginner, intermediate, or advanced?'],
  }
  return questions[field]?.[isZh ? 0 : 1]
}

export const horizonZh = { '1 week': '1 周', '2 weeks': '2 周', '1 month': '1 个月', '2 months': '2 个月', '3 months': '3 个月', '6 months': '6 个月', '1 year': '1 年', 'long term': '长期' }

function assumptionsFor(profile, confirmed, isZh) {
  const items = []
  if (!confirmed.has('direction') && profile.direction) {
    items.push(text(isZh, `方向按页面当前选择的「${directionText[profile.direction]?.[0] ?? profile.direction}」处理`, `using the page's current ${directionText[profile.direction]?.[1] ?? profile.direction} view`))
  }
  if (!confirmed.has('horizon')) items.push(text(isZh, `周期按 ${horizonZh[profile.horizon] ?? profile.horizon ?? '1 个月'} 处理`, `horizon assumed ${profile.horizon ?? '1 month'}`))
  if (!confirmed.has('experienceLevel') && (profile.experienceLevel ?? 'beginner') === 'beginner') items.push(text(isZh, '经验按新手处理', 'treated as a beginner'))
  if (profile.riskBudget === undefined) items.push(text(isZh, '还没有风险预算，暂未按预算过滤', 'no risk budget yet, so nothing is filtered by budget'))
  return items
}

function chooseFollowUp(intent, profile, confirmed, asked) {
  if (!['recommend', 'compare', 'adjust'].includes(intent)) return undefined
  return followUpOrder.find((field) => {
    if (asked.includes(field)) return false
    if (field === 'experienceLevel') return !confirmed.has('experienceLevel')
    return profile[field] === undefined
  })
}

function resolveFocus({ reference, context, prior, strategies }) {
  const byId = (id) => strategies.find((strategy) => strategy.id === id)
  if (reference?.id) {
    const found = byId(reference.id)
    if (found) return { strategy: found }
    const edu = educationById.get(reference.id)
    if (edu) return { education: edu }
  }
  return {
    strategy: context?.selectedStrategy ?? byId(prior.focusStrategyId) ?? byId(prior.lastReferencedIds?.[0]),
  }
}

function educationFacts(edu) {
  return edu
    ? { id: edu.id, name: edu.name, zhName: edu.zhName, summary: edu.summary, bestFor: edu.bestFor, avoidWhen: edu.avoidWhen, legs: edu.legs, payoff: edu.payoff, keyRisks: edu.keyRisks, teachingNotes: edu.teachingNotes }
    : undefined
}

function expectedMoveFacts(strategies) {
  const move = strategies.find((strategy) => strategy.expectedMove && strategy.legs?.length)
  if (!move) return undefined
  return {
    expiration: move.legs[0]?.expiration,
    low: move.expectedMove.low,
    high: move.expectedMove.high,
    impliedVolatilityPercent: Number((move.expectedMove.impliedVolatility * 100).toFixed(1)),
    dte: move.expectedMove.dte,
  }
}

export function buildAssistantPlan({ intent, message, profile, confirmed = new Set(), context, prior = {}, reference, references = [], changes, forecast = false, missingOrdinals = [], invalid = [], declinedField, targetIssue, contractResult, scenarioPrice, volatility, isZh = false }) {
  const strategies = Array.isArray(context?.strategies) ? context.strategies : []
  const budget = profile.riskBudget
  const dataGaps = [...new Set((context?.dataGaps ?? []).map(String))]
  const spot = Number(context?.market?.price) || undefined
  const market = context?.market?.price
    ? {
        ticker: profile.ticker,
        price: context.market.price,
        change: context.market.change,
        changePercent: context.market.changePercent,
        open: context.market.open ?? undefined,
        high: context.market.high ?? undefined,
        low: context.market.low ?? undefined,
        previousClose: context.market.previousClose ?? undefined,
        volume: context.market.volume ?? undefined,
        asOf: context.market.asOf,
        quoteType: context.market.marketDataType,
      }
    : undefined
  const base = {
    intent,
    profile,
    market,
    assumptions: [],
    strategies: [],
    cards: [],
    referencedStrategyIds: [],
    dataGaps,
    dataNotes: dataGaps.filter((gap) => !/timestamps|multiplier/i.test(gap)).slice(0, 3).map(humanGap),
    volatility,
  }

  // Typos and implausible numbers are settled before anything is screened with them.
  // A bare reply ("0") keeps the request that asked the question, so the corrected value resumes it.
  const resumeIntent = intent !== 'clarify' ? intent : prior.pending?.intent && prior.pending.intent !== 'clarify' ? prior.pending.intent : 'recommend'
  if (invalid.length) {
    const item = invalid[0]
    return {
      ...base,
      mode: 'invalid_input',
      invalid: item,
      followUpField: item.field,
      pendingIntent: resumeIntent,
      confirm: item.reason === 'negative' ? { [item.field]: item.value } : undefined,
    }
  }
  if (declinedField) return { ...base, mode: 'ask', declined: true, followUpField: declinedField, pendingIntent: resumeIntent }
  if (targetIssue) {
    return { ...base, mode: 'target_check', targetIssue, followUpField: 'targetPrice', pendingIntent: resumeIntent, confirm: targetIssue.confirm }
  }

  if (!profile.ticker && intent !== 'educate' && intent !== 'clarify') {
    return { ...base, mode: 'ask', followUpField: 'ticker', pendingIntent: intent }
  }

  if (missingOrdinals.length && ['explain', 'risk_check', 'compare', 'adjust'].includes(intent)) {
    const listIds = prior.lastReferencedIds ?? []
    return {
      ...base,
      mode: 'ordinal_missing',
      missingOrdinals,
      listed: listIds.map((id) => {
        const live = strategies.find((strategy) => strategy.id === id)
        return live ? displayName(live, isZh) : educationById.get(id) ? strategyLabel(educationById.get(id), isZh) : id
      }),
    }
  }

  if (intent === 'educate' || (intent === 'clarify' && !engineIntents.has(intent))) {
    const focus = resolveFocus({ reference, context, prior, strategies })
    const education = focus.education ?? (reference?.id ? educationById.get(reference.id) : undefined)
    // A named strategy beats a generic concept ("什么是牛市看涨价差" is about the strategy, not spreads in general).
    const concept = education ? undefined : conceptFor(message)
    return {
      ...base,
      mode: intent === 'educate' ? 'educate' : 'chat',
      // A greeting is not an invitation to recite the IV range; the narrator can still look it up with tools.
      volatility: forecast || /\biv\b|波动|vol|期限结构|expected move|预期波动/i.test(message) ? base.volatility : undefined,
      forecastQuestion: forecast || undefined,
      expectedMove: forecast ? expectedMoveFacts(strategies) : undefined,
      concept,
      education: educationFacts(education),
      focus: focus.strategy && !forecast ? strategyFacts(focus.strategy, budget, spot) : undefined,
      referencedStrategyIds: focus.strategy && !forecast ? [focus.strategy.id] : [],
    }
  }

  const contractReady = strategies.filter((strategy) => strategy.status === 'contract_ready' && strategy.legs?.length)
  const educationOnly = !contractReady.length

  if (intent === 'explain' || intent === 'risk_check') {
    const focus = resolveFocus({ reference, context, prior, strategies })
    if (!focus.strategy && focus.education) {
      const edu = focus.education
      const viewText = directionText[profile.direction]?.[isZh ? 0 : 1] ?? profile.direction ?? ''
      return {
        ...base,
        mode: intent === 'risk_check' ? 'risk_check' : 'explain',
        offCandidates: true,
        education: educationFacts(edu),
        verdict: intent === 'risk_check'
          ? text(isZh, `${edu.zhName}（${edu.name}）不在当前 ${profile.ticker} ${viewText}观点的候选里，我没有它的实时合约，算不出具体亏损金额。结构上，${edu.payoff?.maxLoss ?? '最大亏损取决于具体合约'}。`, `${edu.name} is not among the current ${viewText} candidates for ${profile.ticker}, so there is no live contract to size its loss. Structurally: ${edu.payoff?.maxLoss ?? 'max loss depends on the contracts'}.`)
          : undefined,
        pendingIntent: intent,
      }
    }
    const target = focus.strategy ?? contractReady[0] ?? strategies[0]
    if (!target) {
      return { ...base, mode: 'education_only', education: focus.education, assumptions: assumptionsFor(profile, confirmed, isZh) }
    }
    const problem = riskProblem(target, budget, isZh)
    const loss = finiteMaxLoss(target)
    const scenario = scenarioPrice !== undefined ? { price: scenarioPrice, plAtExpiration: scenarioPl(target, scenarioPrice) } : undefined
    const scenarioText = scenario?.plAtExpiration !== undefined
      ? text(isZh, `如果到期时股价在 ${usd(scenario.price)}，${displayName(target, isZh)} 的到期盈亏约为 ${scenario.plAtExpiration < 0 ? `亏 ${usd(-scenario.plAtExpiration)}` : `赚 ${usd(scenario.plAtExpiration)}`}（不含提前平仓）。`, `If the stock is at ${usd(scenario.price)} at expiration, ${target.name} would be about ${scenario.plAtExpiration < 0 ? `-${usd(-scenario.plAtExpiration)}` : usd(scenario.plAtExpiration)} (held to expiration).`)
      : undefined
    const verdict = scenarioText ?? (intent !== 'risk_check'
      ? undefined
      : budget === undefined
        ? text(isZh, `${displayName(target, isZh)} 的最大亏损是 ${moneyOrWord(target.maxLoss, isZh)}。你还没告诉我风险预算，所以无法判断是否超预算。`, `${target.name} max loss is ${moneyOrWord(target.maxLoss, isZh)}. No risk budget is set yet, so I cannot check it against one.`)
        : problem ?? text(isZh, `${displayName(target, isZh)} 最大亏损 ${usd(loss)}，在你 ${usd(budget)} 的风险预算以内。`, `${target.name} max loss ${usd(loss)} is within your ${usd(budget)} risk budget.`))
    return {
      ...base,
      mode: intent === 'risk_check' || scenario ? 'risk_check' : 'explain',
      focus: strategyFacts(target, budget, spot),
      scenario,
      verdict,
      cards: [strategyCard(target, isZh, budget)],
      referencedStrategyIds: [target.id],
      focusStrategyId: target.id,
      followUpField: intent === 'risk_check' && !scenario && budget === undefined && !prior.asked?.includes('riskBudget') ? 'riskBudget' : undefined,
      pendingIntent: intent,
    }
  }

  // compare named strategies even when one is outside the budget, so the user sees the actual trade-off
  if (intent === 'compare' && references.length >= 2) {
    const items = references
      .map((id) => ({ strategy: strategies.find((strategy) => strategy.id === id), education: educationById.get(id) }))
      .filter((item) => item.strategy || item.education)
      .slice(0, 3)
    if (items.length >= 2) {
      const live = items.filter((item) => item.strategy).map((item) => item.strategy)
      return {
        ...base,
        mode: 'compare',
        assumptions: assumptionsFor(profile, confirmed, isZh),
        strategies: live.map((strategy) => strategyFacts(strategy, budget, spot)),
        offCandidates: items.filter((item) => !item.strategy).map((item) => educationFacts(item.education)),
        cards: live.map((strategy) => strategyCard(strategy, isZh, budget)),
        referencedStrategyIds: live.map((strategy) => strategy.id),
        focusStrategyId: live[0]?.id,
        pendingIntent: 'compare',
      }
    }
  }

  if (intent === 'adjust' && contractResult) {
    if (contractResult.status !== 'ok') {
      return {
        ...base,
        mode: 'contract_clarify',
        contractError: contractResult,
        strategyName: contractResult.strategy ? displayName(contractResult.strategy, isZh) : undefined,
        cards: contractResult.strategy ? [strategyCard(contractResult.strategy, isZh, budget)] : [],
        referencedStrategyIds: contractResult.strategy ? [contractResult.strategy.id] : [],
        focusStrategyId: contractResult.strategy?.id,
      }
    }
    const { before, after, resolution } = contractResult
    const summary = (strategy) => ({
      maxLoss: strategy.maxLoss,
      maxProfit: strategy.maxProfit,
      breakevens: strategy.breakevens ?? (strategy.breakeven ? [strategy.breakeven] : []),
      probabilityOfProfitPercent: strategy.probabilityOfProfit,
      ...premiumPlanFields(strategy),
      netGreeks: netGreeks(strategy),
      maxProfitZone: maxProfitZone(strategy),
    })
    return {
      ...base,
      mode: 'contract_adjust',
      changeDirections: changeDirections(before, after),
      focus: strategyFacts(after, budget, spot),
      before: summary(before),
      after: summary(after),
      legChanges: resolution.legChanges,
      requestedExpiration: resolution.requestedExpiration,
      budgetProblem: riskProblem(after, budget, isZh),
      cards: [strategyCard(after, isZh, budget)],
      referencedStrategyIds: [after.id],
      focusStrategyId: after.id,
      contractAdjustment: { strategyId: after.id, adjustments: resolution.adjustments },
      pendingIntent: 'explain',
    }
  }

  // Adjustments that change nothing the engine understands are answered honestly instead of re-running the same screen.
  if (intent === 'adjust' && Array.isArray(changes) && !changes.length) {
    const value = String(message).toLowerCase()
    const shown = new Set(prior.lastReferencedIds ?? [])
    const alternatives = contractReady.filter((strategy) => !shown.has(strategy.id) && (budget === undefined || budgetFit(strategy, budget)))
    if (alternatives.length) {
      const top = alternatives.slice(0, 3)
      return {
        ...base,
        mode: 'recommend',
        alternativesOnly: true,
        assumptions: assumptionsFor(profile, confirmed, isZh),
        strategies: top.map((strategy) => strategyFacts(strategy, budget, spot)),
        cards: top.map((strategy) => strategyCard(strategy, isZh, budget)),
        referencedStrategyIds: top.map((strategy) => strategy.id),
        focusStrategyId: top[0].id,
        pendingIntent: 'recommend',
      }
    }
    return {
      ...base,
      mode: 'adjust_unsupported',
      reason: /拉长|延长|更长|longer|extend|缩短|更短|shorter/.test(value) ? 'horizon_limit' : 'no_more',
    }
  }

  // recommend / compare / adjust
  const pool = educationOnly ? strategies : contractReady
  const filterByBudget = budget !== undefined && !educationOnly
  const fits = filterByBudget ? pool.filter((strategy) => budgetFit(strategy, budget)) : pool
  const excluded = filterByBudget ? pool.filter((strategy) => !budgetFit(strategy, budget)) : []
  const assumptions = assumptionsFor(profile, confirmed, isZh)
  if (!fits.length) {
    const cheapest = [...pool].filter((strategy) => finiteMaxLoss(strategy) !== undefined).sort((a, b) => finiteMaxLoss(a) - finiteMaxLoss(b))[0]
    return {
      ...base,
      mode: 'no_fit',
      assumptions,
      excluded: excluded.slice(0, 5).map((strategy) => ({ id: strategy.id, name: strategy.name, zhName: educationById.get(strategy.id)?.zhName, maxLoss: strategy.maxLoss })),
      cheapest: cheapest ? strategyFacts(cheapest, budget, spot) : undefined,
      cards: cheapest ? [strategyCard(cheapest, isZh, budget)] : [],
      referencedStrategyIds: cheapest ? [cheapest.id] : [],
      followUpField: 'riskBudget',
      followUpText: text(isZh, '要换一个风险预算再筛一次吗？直接回复新的金额就行。', 'Want to rescreen with a different risk budget? Just reply with the new amount.'),
      pendingIntent: 'recommend',
    }
  }
  const labelOrder = { best_fit: 0, conservative: 1, conditional: 2, aggressive: 3 }
  const top = [...fits]
    .map((strategy, index) => ({ strategy, index }))
    .sort((a, b) => (labelOrder[a.strategy.label] ?? 4) - (labelOrder[b.strategy.label] ?? 4) || a.index - b.index)
    .slice(0, 3)
    .map(({ strategy }) => strategy)
  const previousTop = prior.lastReferencedIds?.[0]
  const followUpField = chooseFollowUp(intent, profile, confirmed, prior.asked ?? [])
  return {
    ...base,
    mode: educationOnly ? 'education_only' : intent === 'compare' ? 'compare' : 'recommend',
    assumptions,
    strategies: top.map((strategy) => strategyFacts(strategy, budget, spot)),
    excludedByBudget: excluded.slice(0, 5).map((strategy) => ({ id: strategy.id, name: strategy.name, zhName: educationById.get(strategy.id)?.zhName, maxLoss: strategy.maxLoss })),
    changedFromPrevious: intent === 'adjust' && previousTop ? previousTop !== top[0].id : undefined,
    cards: top.map((strategy) => strategyCard(strategy, isZh, budget)),
    referencedStrategyIds: top.map((strategy) => strategy.id),
    focusStrategyId: top[0].id,
    followUpField,
    pendingIntent: 'recommend',
  }
}

// ---------- deterministic answers ----------

function strategyLabel(item, isZh) {
  return isZh && item?.zhName ? item.zhName : item?.name ?? ''
}

export function deterministicAnswer(plan, isZh) {
  const profile = plan.profile ?? {}
  const viewText = directionText[profile.direction]?.[isZh ? 0 : 1] ?? profile.direction ?? ''
  const assumptionText = plan.assumptions?.length
    ? text(isZh, `（${plan.assumptions.join('，')}）`, ` (${plan.assumptions.join('; ')})`)
    : ''
  const disclaimer = text(isZh, '以下为情景分析，仅供模拟交易学习，不构成投资建议。', 'Scenario analysis for paper trading only, not investment advice.')
  const first = plan.strategies?.[0]
  switch (plan.mode) {
    case 'ask':
      return [plan.declined ? text(isZh, '好的，那就不按刚才的数字处理。', 'OK, I will not use that number.') : '', profileQuestion(plan.followUpField, isZh)].filter(Boolean).join(isZh ? '' : ' ')
    case 'invalid_input': {
      const { field, reason, value } = plan.invalid
      const budget = field === 'riskBudget'
      if (reason === 'zero') {
        return budget
          ? text(isZh, '风险预算为 0 意味着不能承担任何亏损，而任何期权策略都可能亏钱，所以没法按 0 筛选。请告诉我一个大于 0 的金额。', 'A risk budget of 0 means no loss at all, and every option strategy can lose money, so I cannot screen with 0. Please give an amount greater than 0.')
          : text(isZh, '目标价需要大于 0。请告诉我一个具体的目标价，或者说“没有目标价”。', 'A target price must be greater than 0. Please give a specific target, or say you have none.')
      }
      return budget
        ? text(isZh, `风险预算需要是大于 0 的金额，你写的是 -${plain(value)}。你是想说最多亏 ${usd(value)} 吗？回复“是”我就按 ${usd(value)} 筛选，或者直接告诉我新的金额。`, `A risk budget must be greater than 0, and you wrote -${plain(value)}. Did you mean a max loss of ${usd(value)}? Reply "yes" to use ${usd(value)}, or give a new amount.`)
        : text(isZh, `目标价不能是负数，你写的是 -${plain(value)}。你是想说目标价 ${usd(value)} 吗？回复“是”我就按 ${usd(value)} 计算，或者直接告诉我新的目标价。`, `A target price cannot be negative, and you wrote -${plain(value)}. Did you mean ${usd(value)}? Reply "yes" to use ${usd(value)}, or give a new target.`)
    }
    case 'target_check': {
      const issue = plan.targetIssue
      const ticker = profile.ticker ?? ''
      const moveText = `${issue.movePercent > 0 ? '+' : ''}${plain(issue.movePercent)}%`
      if (issue.reason === 'direction') {
        const flipped = directionText[issue.confirm.direction]?.[isZh ? 0 : 1]
        const own = directionText[issue.direction]?.[isZh ? 0 : 1]
        return text(isZh,
          `你的观点是${own}，但目标价 ${usd(issue.target)} ${issue.target < issue.spot ? '低于' : '高于'} ${ticker} 现价 ${usd(issue.spot)}（${moveText}），两者方向相反。你是想按${flipped}、目标 ${usd(issue.target)} 来分析吗？回复“是”我就按${flipped}重新筛选，或者告诉我新的目标价。`,
          `Your view is ${own}, but the ${usd(issue.target)} target is ${issue.target < issue.spot ? 'below' : 'above'} ${ticker}'s ${usd(issue.spot)} price (${moveText}), which points the other way. Do you want a ${flipped} analysis with a ${usd(issue.target)} target? Reply "yes" to rescreen as ${flipped}, or give a new target.`)
      }
      const sigmaText = issue.oneSigmaPercent
        ? text(isZh, `按当前隐含波动率约 ${plain(issue.impliedVolatilityPercent)}%，${issue.days} 天内一个标准差约 ±${plain(issue.oneSigmaPercent)}%，这个目标相当于约 ${plain(issue.sigmas)} 个标准差，期权价格几乎不认为会到达。`, `At about ${plain(issue.impliedVolatilityPercent)}% implied volatility, one standard deviation over ${issue.days} days is about ±${plain(issue.oneSigmaPercent)}%, so this target is roughly ${plain(issue.sigmas)} standard deviations away, which option prices treat as very unlikely.`)
        : ''
      return text(isZh,
        `目标价 ${usd(issue.target)} 相对 ${ticker} 现价 ${usd(issue.spot)} 变动 ${moveText}。${sigmaText}是不是多写或少写了一位？回复“是”我就按 ${usd(issue.target)} 计算，或者直接告诉我新的目标价。`,
        `A ${usd(issue.target)} target is ${moveText} from ${ticker}'s ${usd(issue.spot)} price. ${sigmaText} Could it be a typo? Reply "yes" to use ${usd(issue.target)}, or give a new target.`)
    }
    case 'contract_clarify': {
      const error = plan.contractError
      const legsText = (error.legs ?? []).map((leg) => `${leg.legIndex + 1}. ${legText(leg, isZh)}`).join(isZh ? '；' : '; ')
      const name = plan.strategyName ?? text(isZh, '当前策略', 'the current strategy')
      const messages = {
        no_focus: text(isZh, '要调整合约，先告诉我是哪个策略：说策略名称、“第几个”，或在页面上选中一个策略。', 'To edit contracts, tell me which strategy first: name it, say "the first one", or select it on the page.'),
        no_chain: text(isZh, '当前拿不到可用的期权链报价，暂时没法调整具体合约。', 'No usable option chain quotes are available, so contracts cannot be edited right now.'),
        no_legs: text(isZh, `${name} 现在没有具体合约腿，没法调整。`, `${name} has no contract legs to edit.`),
        mixed_expirations: text(isZh, `${name} 的几条腿到期日不同，聊天里暂不支持整体换到期日，请在策略面板里逐条调整。`, `${name} has legs with different expirations; change them leg by leg in the strategy panel.`),
        no_matching_leg: text(isZh, `${name} 里没有符合你描述的那条腿。当前各腿：${legsText}。`, `${name} has no leg matching that description. Current legs: ${legsText}.`),
        strike_not_in_strategy: text(isZh, `${name} 里没有行权价 ${plain(error.strike)} 的腿。当前各腿：${legsText}。`, `${name} has no leg at the ${plain(error.strike)} strike. Current legs: ${legsText}.`),
        ambiguous_leg: text(isZh, `${name} 有多条腿，你想把哪一条换到 ${plain(error.strike)}？当前各腿：${legsText}。可以说“买入的那条”“卖出的那条”或“低/高行权价那条”。`, `${name} has several legs; which one should move to ${plain(error.strike)}? Current legs: ${legsText}. Say the bought leg, the sold leg, or the lower/upper strike.`),
        strike_count: text(isZh, `${name} 有 ${error.expected} 个不同的行权价，你给了 ${(error.strikes ?? []).map(plain).join('、')}，对不上。当前各腿：${legsText}。`, `${name} has ${error.expected} distinct strikes but you gave ${(error.strikes ?? []).map(plain).join(', ')}. Current legs: ${legsText}.`),
        strike_range: text(isZh, '再往这个方向已经没有可用的行权价了。', 'There is no listed strike further in that direction.'),
        strike_missing: text(isZh, `${error.expiration ?? ''} 到期的期权链里没有可交易的 ${plain(error.strike)} 行权价${error.nearby?.length ? `，最接近的有：${error.nearby.map(plain).join('、')}` : ''}。`, `There is no tradable ${plain(error.strike)} strike for ${error.expiration ?? 'that expiration'}${error.nearby?.length ? `; the closest are ${error.nearby.map(plain).join(', ')}` : ''}.`),
        structure: text(isZh, `这样调整会改变 ${name} 的结构（腿之间的高低顺序变了），就不再是同一个策略了。当前各腿：${legsText}。`, `That edit would change the structure of ${name} (the strike order of the legs), making it a different strategy. Current legs: ${legsText}.`),
        quantity_range: text(isZh, '每条腿的数量需要在 1 到 20 张之间。', 'Each leg must be between 1 and 20 contracts.'),
        no_width: text(isZh, `${name} 只有一个行权价，没有“宽度”可调。可以直接指定新的行权价。`, `${name} has a single strike, so there is no width to change. Give a new strike instead.`),
        no_change: text(isZh, `${name} 已经是这个设置了，没有变化。`, `${name} already has that setting.`),
      }
      return messages[error.error] ?? messages.no_focus
    }
    case 'contract_adjust': {
      const focusName = strategyLabel(plan.focus, isZh)
      const changesText = plan.legChanges.map((change) => {
        const right = change.right === 'call' ? 'Call' : 'Put'
        const parts = []
        if (change.from.strike !== change.to.strike) parts.push(text(isZh, `行权价 ${plain(change.from.strike)} → ${plain(change.to.strike)}`, `strike ${plain(change.from.strike)} → ${plain(change.to.strike)}`))
        if (change.from.expiration !== change.to.expiration) parts.push(text(isZh, `到期 ${change.from.expiration} → ${change.to.expiration}`, `expiration ${change.from.expiration} → ${change.to.expiration}`))
        if (change.from.quantity !== change.to.quantity) parts.push(text(isZh, `数量 ${change.from.quantity} → ${change.to.quantity} 张`, `quantity ${change.from.quantity} → ${change.to.quantity}`))
        return `${text(isZh, change.action === 'buy' ? '买入' : '卖出', change.action === 'buy' ? 'Long' : 'Short')} ${right}：${parts.join('，')}`
      }).join(isZh ? '；' : '; ')
      const snapped = plan.requestedExpiration ? text(isZh, `期权链里没有 ${plan.requestedExpiration} 到期，已用最接近的到期日。`, `There is no ${plan.requestedExpiration} expiration, so the closest listed one is used.`) : ''
      const metrics = text(isZh,
        `调整后最大亏损 ${moneyOrWord(plan.after.maxLoss, isZh)}（原 ${moneyOrWord(plan.before.maxLoss, isZh)}），最大收益 ${moneyOrWord(plan.after.maxProfit, isZh)}（原 ${moneyOrWord(plan.before.maxProfit, isZh)}）${plan.after.breakevens?.length ? `，盈亏平衡 ${plan.after.breakevens.map(plain).join(' / ')}` : ''}。`,
        `Max loss is now ${moneyOrWord(plan.after.maxLoss, isZh)} (was ${moneyOrWord(plan.before.maxLoss, isZh)}), max profit ${moneyOrWord(plan.after.maxProfit, isZh)} (was ${moneyOrWord(plan.before.maxProfit, isZh)})${plan.after.breakevens?.length ? `, breakeven ${plan.after.breakevens.map(plain).join(' / ')}` : ''}.`)
      return [text(isZh, `已按你的要求调整${focusName}：${changesText}。`, `Adjusted ${focusName}: ${changesText}.`), snapped, metrics, plan.budgetProblem ?? '', disclaimer].filter(Boolean).join('\n')
    }
    case 'ordinal_missing': {
      const asked = plan.missingOrdinals.join(isZh ? '、' : ', ')
      if (!plan.listed.length) {
        return text(isZh,
          `我还没有给你列过策略清单，所以“第 ${asked} 个”没有对应的策略。可以先让我按你的看法推荐几个，或者直接说策略名称。`,
          `I have not shown you a strategy list yet, so #${asked} does not point to anything. Ask me for recommendations first, or name the strategy directly.`)
      }
      const listed = plan.listed.map((name, index) => `${index + 1}. ${name}`).join(isZh ? '；' : '; ')
      return text(isZh,
        `上一轮清单只有 ${plan.listed.length} 个策略（${listed}），没有第 ${asked} 个。你想看的是其中哪一个？`,
        `The last list had only ${plan.listed.length} strateg${plan.listed.length === 1 ? 'y' : 'ies'} (${listed}), so there is no #${asked}. Which one did you mean?`)
    }
    case 'adjust_unsupported':
      return {
        horizon_limit: text(isZh, '周期已经在可选范围的尽头了，候选不会再变化。可以换个预算、方向或目标价再看看。', 'The horizon is already at the end of the supported range, so the candidates would not change. Try a different budget, view or target price.'),
        no_more: text(isZh, '当前设置下的候选已经都给你看过了。可以调整方向、周期或预算，我再重新筛选。', 'You have already seen every candidate for the current settings. Change the view, horizon or budget and I will rescreen.'),
      }[plan.reason]
    case 'recommend':
    case 'compare': {
      const names = (plan.strategies ?? []).map((item) => strategyLabel(item, isZh))
      const offNames = (plan.offCandidates ?? []).map((item) => strategyLabel(item, isZh))
      if (!names.length) {
        return text(isZh, `${offNames.join('、')} 都不在当前 ${profile.ticker} ${viewText}观点的候选里，只能比较结构，不能给出具体合约。告诉我新的方向，我再在实时期权链上筛选。`, `${offNames.join(', ')} are not among the current ${viewText} candidates for ${profile.ticker}, so only their structure can be compared. Tell me a new view and I will rescreen the live chain.`)
      }
      const lead = plan.alternativesOnly
        ? text(isZh, `换一批候选：${names.join('、')}。`, `Other candidates: ${names.join(', ')}.`)
        : plan.mode === 'compare'
          ? text(isZh, `对比 ${names.join('、')}：卡片里列出了各自的最大亏损、最大收益、盈亏平衡和盈利概率，取舍在于成本、风险形态和需要的价格路径。`, `Comparing ${names.join(', ')}: the cards list each one's max loss, max profit, breakeven and POP; the trade-off is cost, risk shape and the price path each needs.`)
          : text(isZh, `按你对 ${profile.ticker} 的${viewText}观点${assumptionText}，引擎在实时期权链上筛出 ${names.length} 个候选：${names.join('、')}。排第一的是${names[0]}：${first?.education?.summary ?? ''}`, `For a ${viewText} view on ${profile.ticker}${assumptionText}, the engine screened ${names.length} candidates on the live chain: ${names.join(', ')}. Top ranked is ${names[0]}${first?.education?.summary ? `: ${first.education.summary}` : '.'}`)
      const offText = offNames.length
        ? text(isZh, `${offNames.join('、')} 不在当前观点的候选里，只能按结构说明，没有实时合约。`, `${offNames.join(', ')} ${offNames.length > 1 ? 'are' : 'is'} not among the current candidates, so only the structure applies.`)
        : ''
      const excludedText = plan.excludedByBudget?.length
        ? text(isZh, `另有 ${plan.excludedByBudget.length} 个方案因最大亏损超过预算被排除。`, `${plan.excludedByBudget.length} other candidates were excluded for exceeding your risk budget.`)
        : ''
      return [lead, offText, excludedText, disclaimer].filter(Boolean).join('\n')
    }
    case 'no_fit':
      return text(
        isZh,
        `当前候选里没有最大亏损在 ${usd(profile.riskBudget)} 以内的方案${plan.cheapest ? `，风险最小的是${strategyLabel(plan.cheapest, isZh)}，最大亏损 ${moneyOrWord(plan.cheapest.maxLoss, isZh)}` : ''}。可以考虑提高预算、换一个价格更低的标的，或调整方向和周期后再筛选。`,
        `No current candidate has max loss within ${usd(profile.riskBudget)}${plan.cheapest ? `; the lowest-risk one is ${plan.cheapest.name} at ${moneyOrWord(plan.cheapest.maxLoss, isZh)}` : ''}. Consider a larger budget, a lower-priced ticker, or a different view or horizon.`,
      )
    case 'explain': {
      if (plan.offCandidates) {
        const edu = plan.education
        return text(
          isZh,
          [`${edu.zhName}（${edu.name}）不在当前 ${profile.ticker} ${viewText}观点的候选里，下面只讲结构，不给具体合约。`, edu.summary, edu.payoff ? `最大亏损：${edu.payoff.maxLoss}；最大收益：${edu.payoff.maxProfit}；盈亏平衡：${edu.payoff.breakeven}。` : '', '如果你的观点变了，告诉我新的方向，我会在实时期权链上重新筛选。'].filter(Boolean).join('\n'),
          [`${edu.name} is not among the current ${viewText} candidates for ${profile.ticker}, so this covers structure only, with no live contracts.`, edu.summary, edu.payoff ? `Max loss: ${edu.payoff.maxLoss}. Max profit: ${edu.payoff.maxProfit}. Breakeven: ${edu.payoff.breakeven}.` : '', 'If your view has changed, tell me and I will rescreen the live chain.'].filter(Boolean).join('\n'),
        )
      }
      const focus = plan.focus
      const edu = focus.education
      return text(
        isZh,
        [`${focus.zhName ?? focus.name}：${edu?.summary ?? ''}`, edu?.payoff ? `最大亏损来自${edu.payoff.maxLoss}，最大收益为${edu.payoff.maxProfit}，盈亏平衡在${edu.payoff.breakeven}。` : '', edu?.keyRisks?.length ? `主要风险：${edu.keyRisks.slice(0, 2).join('；')}。` : ''].filter(Boolean).join('\n'),
        [`${focus.name}: ${edu?.summary ?? ''}`, edu?.payoff ? `Max loss: ${edu.payoff.maxLoss}. Max profit: ${edu.payoff.maxProfit}. Breakeven: ${edu.payoff.breakeven}.` : '', edu?.keyRisks?.length ? `Main risks: ${edu.keyRisks.slice(0, 2).join('; ')}.` : ''].filter(Boolean).join('\n'),
      )
    }
    case 'risk_check':
      return plan.verdict
    case 'educate':
    case 'chat': {
      if (plan.forecastQuestion) {
        const move = plan.expectedMove
        const moveText = move
          ? text(isZh, `期权价格可以作参考：按 ${move.expiration} 到期、隐含波动率约 ${move.impliedVolatilityPercent}% 估算，市场隐含的大致波动区间是 ${usd(move.low)} 到 ${usd(move.high)}。这只是定价隐含的范围，不是预测。`, `Option prices give a reference: for the ${move.expiration} expiration at about ${move.impliedVolatilityPercent}% implied volatility, the market-implied range is roughly ${usd(move.low)} to ${usd(move.high)}. That is a priced range, not a forecast.`)
          : ''
        return [
          text(isZh, `我没法预测 ${profile.ticker ?? '股价'} 会涨还是会跌，也不提供买卖建议。`, `I cannot predict whether ${profile.ticker ?? 'the stock'} will go up or down, and I do not give buy or sell advice.`),
          moveText,
          text(isZh, '如果你有自己的看法，告诉我方向、周期和最多愿意亏多少，我按这个观点做情景分析。', 'If you have a view, tell me the direction, horizon and max loss and I will run scenario analysis for it.'),
        ].filter(Boolean).join('\n')
      }
      if (plan.concept) return isZh ? plan.concept.zh : plan.concept.en
      if (plan.education) {
        const edu = plan.education
        return text(isZh, `${edu.zhName}（${edu.name}）：${edu.summary}\n适合：${edu.bestFor.join('；')}\n主要风险：${edu.keyRisks.join('；')}`, `${edu.name}: ${edu.summary}\nBest for: ${edu.bestFor.join('; ')}\nKey risks: ${edu.keyRisks.join('; ')}`)
      }
      if (plan.market) {
        return text(
          isZh,
          `${plan.market.ticker} 最新价 ${usd(plan.market.price)}${Number.isFinite(plan.market.changePercent) ? `，涨跌幅 ${plain(plan.market.changePercent)}%` : ''}。你可以告诉我你的看法（看涨/看跌/震荡）、周期和最多愿意亏多少，我来筛选策略。`,
          `${plan.market.ticker} last price ${usd(plan.market.price)}${Number.isFinite(plan.market.changePercent) ? ` (${plain(plan.market.changePercent)}%)` : ''}. Tell me your view, horizon, and max loss and I will screen strategies.`,
        )
      }
      return text(isZh, '我可以帮你根据观点筛选期权策略、解释某个策略的盈亏和风险，或讲解期权概念。你想从哪里开始？', 'I can screen option strategies for your view, explain a strategy\'s payoff and risk, or teach an options concept. Where would you like to start?')
    }
    case 'education_only': {
      if (plan.education && !plan.strategies?.length) {
        const edu = plan.education
        return text(isZh, `${edu.zhName}（${edu.name}）：${edu.summary}\n当前拿不到 ${profile.ticker} 的可用期权链，暂时无法给出具体合约。`, `${edu.name}: ${edu.summary}\nA usable option chain for ${profile.ticker} is not available, so no contracts can be shown yet.`)
      }
      const names = (plan.strategies ?? []).map((item) => strategyLabel(item, isZh))
      return text(
        isZh,
        `当前拿不到 ${profile.ticker} 的可用期权链，无法给出具体合约。按${viewText}观点，常见的策略类型有：${names.join('、') || '暂无'}。可以先了解它们的结构和风险，数据恢复后我再给出合约级方案。`,
        `A usable option chain for ${profile.ticker} is not available, so no contract-level legs can be shown. For a ${viewText} view, common strategy types are: ${names.join(', ') || 'none'}.`,
      )
    }
    default:
      return text(isZh, '我可以帮你筛选和解释期权策略。', 'I can help screen and explain option strategies.')
  }
}

// ---------- response guard ----------

const banned = /\b(guaranteed|risk-free|risk free|buy it now|sell it now|you should buy|you should sell|must buy|must sell)\b|稳赚|保本|无风险|必须买|必须卖|建议买入|建议卖出|应该买入|应该卖出|一定会涨|一定会跌/gi
const internalTerms = /agentPlan|topStrategies|referencedStrategyIds|dataGaps|structuredUpdates|JSON|QVERIS_[A-Z_]+|schema|system prompt/i

export function guardAssistantText(raw, { isZh = false, unknownNumbers = () => [] } = {}) {
  const warnings = []
  const sentences = String(raw ?? '').split(/(?<=[。！？!?\n]|\.\s)/)
  const kept = []
  const reasons = []
  let dropped = 0
  let firstDropped = false
  for (const sentence of sentences) {
    // camelCase identifiers (estimatedPl, maxLoss) are plan field names leaking into prose.
    const unknown = unknownNumbers(sentence)
    const reason = internalTerms.test(sentence) || /\b[a-z]{2,}[A-Z][A-Za-z]*\b/.test(sentence) ? 'internal term'
      : unknown.length ? `unverified ${unknown.join(',')}` : undefined
    if (reason) {
      if (!kept.length && !dropped) firstDropped = true
      dropped += 1
      reasons.push(reason)
      continue
    }
    if (sentence.trim()) kept.push(sentence)
  }
  let answer = kept.join('').trim()
  if (banned.test(answer)) {
    banned.lastIndex = 0
    answer = answer.replace(banned, text(isZh, '（仅供研究）', '(research only)'))
    warnings.push(text(isZh, '已移除不合规表述，以下内容仅用于期权研究和模拟交易学习。', 'Non-compliant wording was removed; this is for options research and paper trading only.'))
  }
  banned.lastIndex = 0
  return { answer, warnings, dropped, firstDropped, reasons, total: sentences.filter((item) => item.trim()).length }
}
