# Greeks And Volatility

Model-agnostic reference for explaining option risk. Distilled from Hull, Natenberg, Passarelli, McMillan, and beginner education material into implementation-safe rules.

## Core Principle

An option strategy is not just a directional bet. Its outcome depends on stock movement, time remaining, implied volatility, skew, rates/dividends in some cases, liquidity, and exercise/assignment mechanics.

## Greeks

### Delta

- Meaning: approximate option price change for a $1 move in the underlying.
- Calls usually have positive delta; puts usually have negative delta.
- Use for: strike selection, directional exposure, rough probability language.
- Do not present delta as a guaranteed probability.
- Product wording: "Delta suggests this option should be more/less sensitive to a small stock move, assuming other inputs stay unchanged."

### Gamma

- Meaning: how quickly delta changes as the stock moves.
- Highest risk area: near-the-money, short-dated options.
- Long options are usually long gamma; short options are usually short gamma.
- Use for: warning on short-dated options, earnings moves, gap risk, and spread behavior near expiration.
- If gamma unavailable: add `QVERIS_DATA_GAP: Gamma unavailable, so convexity risk is described qualitatively.`

### Theta

- Meaning: approximate option value lost or gained from time passing, all else equal.
- Long premium positions usually have negative theta.
- Short premium positions usually have positive theta but carry assignment/gap risk.
- Theta accelerates near expiration for at-the-money options.
- If theta unavailable: explain time decay qualitatively and add data gap.

### Vega

- Meaning: approximate option price change for a 1 percentage point change in implied volatility.
- Long options usually benefit from rising IV; short options usually benefit from falling IV.
- Event risk: IV can fall after earnings even when direction is correct.
- If vega unavailable: use contract IV, expiration, and event context for qualitative warning.

### Rho

- Meaning: sensitivity to interest rates.
- Usually secondary for short-dated equity options, more relevant for long-dated options.
- MVP can mention only when DTE is long or rate sensitivity is explicitly requested.

## Volatility Concepts

### Historical Volatility

- Measures realized past fluctuation.
- Use as background, not as a forecast.
- If unavailable from QVeris, do not fetch another data source.

### Implied Volatility

- Market-implied input embedded in option prices.
- High IV means options are expensive relative to lower-IV states, not automatically bad.
- Low IV means options are cheaper relative to higher-IV states, not automatically good.
- Explain long premium vs short premium impact separately.

### IV Crush

- Common around earnings and scheduled events.
- Long calls, puts, straddles, and strangles can lose value after the event if IV drops more than directional payoff gains.
- Required warning when an earnings date occurs before expiration or event context is `earnings`.

### Skew

- Different strikes can carry different IV.
- Put skew often makes downside puts relatively expensive.
- Call skew can appear in high-momentum names.
- Use skew to explain why equal-distance calls and puts may not cost the same.
- If skew surface unavailable: add `QVERIS_DATA_GAP: Full volatility skew unavailable; using contract IV only.`

### Term Structure

- Different expirations can carry different IV.
- Calendar/diagonal spreads need term-structure awareness.
- MVP should not recommend calendar/diagonal as default unless term structure is available and the user is not beginner.

## Strategy Exposures

| Strategy | Delta | Gamma | Theta | Vega | Main message |
|---|---|---|---|---|---|
| Long Call | positive | positive | negative | positive | Needs upside move before time/IV drag dominates. |
| Long Put | negative | positive | negative | positive | Needs downside move before time/IV drag dominates. |
| Bull Call Spread | positive, capped | mixed | less negative than long call | lower than long call | Cheaper defined-risk bullish exposure with capped upside. |
| Bear Put Spread | negative, capped | mixed | less negative than long put | lower than long put | Cheaper defined-risk bearish exposure with capped downside profit. |
| Covered Call | stock positive, short call offsets | short call gamma risk | credit helps | short call vega | Income-like overlay that caps upside and keeps stock downside. |
| Cash-Secured Put | positive assignment exposure | short gamma | positive | negative | Paid to accept potential stock purchase and downside risk. |
| Long Straddle | near delta-neutral at entry | long gamma | strongly negative | positive | Needs large realized move or IV increase. |
| Iron Condor | near delta-neutral at entry | short gamma | positive | negative | Benefits from range-bound movement but loses on large moves. |

## Qualitative Fallbacks

When QVeris lacks full Greeks:

- Still compute payoff at expiration from legs and prices.
- Explain Greeks qualitatively using strategy structure.
- Avoid precision language like "theta is -0.08" unless the field exists.
- Add data gaps for gamma/theta/vega/rho.

## Risk Language

Use:

- "All else equal..."
- "This can help explain why..."
- "The model sensitivity is approximate..."
- "At expiration, payoff is determined by intrinsic value; before expiration, IV and time value also matter."

Avoid:

- "Delta is the probability."
- "IV crush will happen."
- "Theta income is safe."
- "The model says this is fair, so it is underpriced."

