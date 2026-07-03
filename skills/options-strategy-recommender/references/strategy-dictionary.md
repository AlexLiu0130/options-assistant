# Strategy Dictionary

Model-agnostic reference for Qveris AI Options Assistant. Use this as product logic, RAG context, or prompt context. It is distilled from the books in `book/` plus public education sources, paraphrased into implementation rules.

## Rules

- Use QVeris normalized data only for live market fields.
- Treat multiplier as `100` for standard US equity options and show the assumption when reference master data is unavailable.
- Output education and simulation language, not trade instructions.
- Prefer defined-risk strategies for beginner default recommendations.
- Fail or hide naked short call/put candidates for beginners.
- Use `QVERIS_DATA_GAP` when a formula needs unavailable fields.

## Shared Fields

Every strategy payload should include:

```json
{
  "id": "bull_call_spread",
  "label": "best_fit",
  "name": "Bull Call Spread",
  "outlook": "moderate_bullish",
  "legs": [],
  "net_debit_credit": 0,
  "max_loss": 0,
  "max_profit": 0,
  "breakevens": [],
  "target_price_pl": null,
  "fit_score": 0,
  "risk_level": "medium",
  "beginner_friendly": "high",
  "reasons": [],
  "warnings": [],
  "data_gaps": []
}
```

## MVP Strategies

### Long Call

- Outlook: bullish, especially strong bullish.
- Use when: user wants upside convexity and accepts full premium loss.
- Avoid when: target move is small relative to premium and breakeven.
- Leg: buy 1 call.
- Net: debit.
- Max loss: premium paid * 100.
- Max profit: unlimited in theory.
- Breakeven: strike + premium.
- Target P/L: `max(target_price - strike, 0) * 100 - premium * 100`.
- Key warnings: time decay, IV crush, entire premium can be lost, breakeven may be far above current price.
- Beginner fit: medium when DTE is not short and premium is within risk budget.

### Long Put

- Outlook: bearish, especially strong bearish or hedge-like view.
- Use when: user wants downside convexity and accepts full premium loss.
- Avoid when: put premium is high and target move is small.
- Leg: buy 1 put.
- Net: debit.
- Max loss: premium paid * 100.
- Max profit: `(strike - premium) * 100`, bounded because stock cannot go below zero.
- Breakeven: strike - premium.
- Target P/L: `max(strike - target_price, 0) * 100 - premium * 100`.
- Key warnings: time decay, IV crush, entire premium can be lost.
- Beginner fit: medium when risk budget covers premium.

### Bull Call Spread

- Outlook: mild to moderate bullish.
- Use when: user has a target price and wants defined risk with lower cost than a long call.
- Avoid when: user needs unlimited upside or target is far above short strike.
- Legs: buy lower-strike call, sell higher-strike call with same expiration.
- Net: debit.
- Max loss: net debit * 100.
- Max profit: `(short_strike - long_strike - net_debit) * 100`.
- Breakeven: long strike + net debit.
- Target P/L: `min(max(target_price - long_strike, 0), short_strike - long_strike) * 100 - net_debit * 100`.
- Key warnings: upside capped, short call assignment risk near expiration, liquidity on both legs matters.
- Beginner fit: high if max loss is within budget and DTE is not very short.

### Bear Put Spread

- Outlook: mild to moderate bearish.
- Use when: user has a downside target and wants defined risk with lower cost than a long put.
- Avoid when: user needs maximum crash exposure.
- Legs: buy higher-strike put, sell lower-strike put with same expiration.
- Net: debit.
- Max loss: net debit * 100.
- Max profit: `(long_strike - short_strike - net_debit) * 100`.
- Breakeven: long strike - net debit.
- Target P/L: `min(max(long_strike - target_price, 0), long_strike - short_strike) * 100 - net_debit * 100`.
- Key warnings: downside profit capped, short put assignment risk near expiration, liquidity on both legs matters.
- Beginner fit: high if max loss is within budget and DTE is not very short.

### Covered Call

- Outlook: neutral to mildly bullish on owned shares.
- Use when: user owns at least 100 shares and accepts capped upside.
- Hard requirement: `owns_shares = true` and `shares_count >= 100`.
- Legs: long 100 shares, sell 1 call.
- Net: credit from call premium, while retaining stock exposure.
- Max loss: stock downside less premium; large but not unlimited.
- Max profit: `(call_strike - stock_cost_basis + call_credit) * 100` when cost basis is known; otherwise variable.
- Breakeven: stock cost basis - call credit; if basis unknown, use current price as visible estimate.
- Key warnings: upside capped, assignment can occur, ex-dividend early assignment risk, stock downside remains.
- Beginner fit: medium/high only for users who already own shares.

### Cash-Secured Put

- Outlook: neutral to mildly bullish; willing to buy shares lower.
- Use when: user is willing and able to buy 100 shares if assigned.
- Hard requirement: `willing_to_be_assigned = true`.
- Leg: sell 1 put with cash reserved.
- Net: credit.
- Max profit: put credit * 100.
- Max loss: `(put_strike - put_credit) * 100`, if stock goes to zero.
- Breakeven: put strike - put credit.
- Cash required: put strike * 100.
- Key warnings: assignment risk, large stock downside, cash requirement, short premium tail risk.
- Beginner fit: medium only when assignment willingness and cash requirement are explicit.

## Comprehensive Strategy Catalog

Implementation tiers:

- `tier_1`: safe enough for MVP candidate generation with hard risk gates.
- `tier_2`: explain and simulate after payoff engine and richer checks exist.
- `tier_3`: advanced education only until margin, exercise, dividend, and portfolio risk controls exist.
- `blocked`: do not recommend; mention only as risk education.

### Single-Leg Options

| Strategy | Tier | Outlook | Legs | Risk/Reward | Main gates |
|---|---|---|---|---|---|
| Long Call | tier_1 | bullish | buy call | loss limited to premium; upside unlimited in theory | premium within budget; avoid very short DTE for beginners |
| Long Put | tier_1 | bearish/protection | buy put | loss limited to premium; profit capped by stock going to zero | premium within budget; explain time decay |
| Short Call, Naked | blocked | bearish/neutral income | sell call without shares | premium capped; loss unlimited in theory | block for beginners and normal recommendations |
| Short Put, Naked | blocked | bullish/neutral income | sell put without cash plan | premium capped; large downside | block unless explicitly cash-secured and assignment-ready |

### Stock Plus Option

| Strategy | Tier | Outlook | Legs | Risk/Reward | Main gates |
|---|---|---|---|---|---|
| Covered Call | tier_1 | neutral/mild bullish | long stock + sell call | premium income; upside capped; stock downside remains | require 100 shares per short call |
| Buy-Write | tier_1 | neutral/mild bullish | buy stock + sell call together | same as covered call with new stock basis | require explicit stock purchase simulation, no live trading |
| Protective Put | tier_2 | bullish stock with downside hedge | long stock + buy put | hedge floor after premium; upside remains | require owned shares or simulated stock leg |
| Married Put | tier_2 | bullish with new protection | buy stock + buy put | defined downside after premium; upside remains | explain hedge cost |
| Collar | tier_2 | cautious bullish/defensive | long stock + buy put + sell call | downside buffered; upside capped | require owned shares and both option legs liquid |
| Zero-Cost Collar | tier_2 | defensive | collar with put cost partly/fully offset by call credit | protection funded by capped upside | do not promise truly zero cost after spreads/slippage |
| Covered Strangle | tier_3 | income, assignment-aware | long stock + sell call + sell put | premium income; added downside assignment risk | require advanced user and assignment/cash checks |

### Vertical Spreads

| Strategy | Tier | Outlook | Legs | Risk/Reward | Main gates |
|---|---|---|---|---|---|
| Bull Call Spread | tier_1 | mild/moderate bullish | buy lower call + sell higher call | defined loss; capped profit | max loss within budget; short call assignment warning |
| Bear Put Spread | tier_1 | mild/moderate bearish | buy higher put + sell lower put | defined loss; capped profit | max loss within budget; short put assignment warning |
| Bull Put Credit Spread | tier_2 | bullish/neutral income | sell higher put + buy lower put | defined loss; capped credit | beginner only after credit-spread guardrails |
| Bear Call Credit Spread | tier_2 | bearish/neutral income | sell lower call + buy higher call | defined loss; capped credit | short call assignment and gap risk |
| Call Ratio Spread | tier_3 | directional with skew/vol view | buy call(s), sell more higher calls | can become uncovered above upper strike | block uncovered versions for beginners |
| Put Ratio Spread | tier_3 | directional with skew/vol view | buy put(s), sell more lower puts | can create large downside exposure | require advanced risk explanation |
| Call Backspread | tier_3 | strong bullish/volatile | sell lower call, buy more higher calls | benefits from large upside; loss zone in middle | requires ratio and margin checks |
| Put Backspread | tier_3 | strong bearish/volatile | sell higher put, buy more lower puts | benefits from large downside; loss zone in middle | requires ratio and margin checks |

### Volatility And Combination Strategies

| Strategy | Tier | Outlook | Legs | Risk/Reward | Main gates |
|---|---|---|---|---|---|
| Long Straddle | tier_2 | volatile, direction uncertain | buy ATM call + buy ATM put | loss limited to total premium; needs large move | compare premium with expected move; warn IV crush |
| Short Straddle | tier_3 | neutral short volatility | sell ATM call + sell ATM put | premium capped; large/unlimited tail risk | advanced only; never beginner default |
| Long Strangle | tier_2 | volatile, direction uncertain | buy OTM call + buy OTM put | lower cost than straddle; needs larger move | compare breakevens with expected move |
| Short Strangle | tier_3 | neutral short volatility | sell OTM call + sell OTM put | premium capped; large/unlimited tail risk | advanced only; assignment and margin checks |
| Strip | tier_3 | volatile with bearish tilt | buy 1 call + buy 2 puts | downside-weighted long volatility | education only until multi-leg sizing exists |
| Strap | tier_3 | volatile with bullish tilt | buy 2 calls + buy 1 put | upside-weighted long volatility | education only until multi-leg sizing exists |

### Wing Spreads

| Strategy | Tier | Outlook | Legs | Risk/Reward | Main gates |
|---|---|---|---|---|---|
| Long Call Butterfly | tier_2 | neutral around target | buy low call + sell 2 middle calls + buy high call | defined loss; max profit near middle strike | require equal wings unless marked broken-wing |
| Long Put Butterfly | tier_2 | neutral around target | buy high put + sell 2 middle puts + buy low put | defined loss; max profit near middle strike | require equal wings unless marked broken-wing |
| Iron Butterfly | tier_2 | neutral short volatility | sell ATM call/put + buy OTM wings | defined risk; credit strategy | event/gap risk warning |
| Broken-Wing Butterfly | tier_3 | directional/credit variant | butterfly with unequal wing widths | asymmetric risk/reward | advanced; show worst-case side clearly |
| Long Condor | tier_2 | range-bound | buy low, sell lower-mid, sell upper-mid, buy high same option type | defined risk; profits in range | require ordered strikes |
| Iron Condor | tier_2 | neutral/range-bound short volatility | short OTM put spread + short OTM call spread | defined loss; capped credit | avoid earnings for beginners; assignment warning |
| Jade Lizard | tier_3 | neutral/bullish short volatility | sell put + sell call spread | no upside risk if credit >= call width; downside stock risk remains | advanced; do not hide put-side risk |

### Calendar And Diagonal Spreads

| Strategy | Tier | Outlook | Legs | Risk/Reward | Main gates |
|---|---|---|---|---|---|
| Long Call Calendar | tier_2 | neutral to mildly bullish, term-structure view | sell near call + buy later call same strike | benefits from near-term decay and later IV | require term structure and event check |
| Long Put Calendar | tier_2 | neutral to mildly bearish, term-structure view | sell near put + buy later put same strike | benefits from near-term decay and later IV | require term structure and event check |
| Double Calendar | tier_3 | range-bound term-structure view | call calendar + put calendar | range exposure with term-structure sensitivity | advanced; many legs |
| Diagonal Call Spread | tier_2 | directional plus time spread | buy later call, sell nearer different-strike call | combines covered-call-like decay and direction | require expiration and strike ordering |
| Diagonal Put Spread | tier_2 | bearish/defensive time spread | buy later put, sell nearer different-strike put | combines hedge and time spread | require expiration and strike ordering |
| Poor Man's Covered Call | tier_2 | bullish income simulation | buy long-dated ITM call + sell near-term call | synthetic covered call; long call can still lose | explain not equivalent to owning shares |

### Synthetics And Arbitrage-Like Structures

Use for education, parity checks, or advanced simulation. Do not present as guaranteed arbitrage.

| Strategy | Tier | Outlook | Legs | Risk/Reward | Main gates |
|---|---|---|---|---|---|
| Synthetic Long Stock | tier_2 | bullish | buy call + sell put same strike/expiry | stock-like upside/downside | short put assignment and cash/margin checks |
| Synthetic Short Stock | tier_3 | bearish | buy put + sell call same strike/expiry | short-stock-like exposure | short call unlimited risk |
| Synthetic Long Call | tier_2 | bullish | long stock + long put | equivalent payoff to call plus financing assumptions | require stock leg |
| Synthetic Long Put | tier_2 | bearish/protection | short stock + long call | equivalent payoff to put plus financing assumptions | short stock usually out of MVP |
| Conversion | tier_3 | arbitrage/parity | long stock + long put + short call | financing/parity trade | requires borrow, rates, dividends, assignment controls |
| Reversal | tier_3 | arbitrage/parity | short stock + short put + long call | financing/parity trade | requires borrow, rates, dividends, assignment controls |
| Box Spread | tier_3 | financing/parity | bull call spread + bear put spread same strikes | fixed payoff at expiration | do not label risk-free; execution/rates matter |

### Index, ETF, And Futures-Option Variants

- Index options: cash settlement and European exercise may change assignment/exercise risk.
- ETF options: usually American exercise and may have dividends.
- Futures options: contract multiplier, settlement, and margin differ; mark unsupported until QVeris reference data covers them.
- LEAPS: long-dated options with higher vega/rho exposure; useful for stock-replacement education but not default for short-horizon users.

## Coverage Policy

- Candidate generation may use `tier_1` first.
- Explanations and education may mention `tier_2` and `tier_3`.
- Strategy engine code should implement payoff formulas before recommendation ranking for any strategy.
- Any strategy with uncovered short options, ratio risk, margin complexity, early exercise sensitivity, or more than four legs requires explicit advanced-user gating.
- If QVeris lacks margin, dividend, exercise style, or reference multiplier data, return education-only output with `QVERIS_DATA_GAP`.

## Selection Heuristic

1. Parse view: direction, strength, horizon, target, budget, shares, assignment willingness, event context, experience.
2. Filter hard constraints: no beginner naked shorts, no default <=7 DTE, no max loss above budget unless marked fail.
3. Select candidates:
   - Bullish: bull call spread, long call, cash-secured put if assignment willing, covered call if shares owned.
   - Bearish: bear put spread, long put, protective put if shares owned.
   - Neutral: education-first; covered call or cash-secured put only with conditions.
   - Volatile: education-first; straddle/strangle only with premium vs expected move warnings.
4. Rank by fit: direction, target, risk budget, DTE, liquidity, IV/event risk, experience.
5. Return reasons and warnings before any explanation prose.
