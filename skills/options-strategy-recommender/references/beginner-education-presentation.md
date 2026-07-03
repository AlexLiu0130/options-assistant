# Beginner Education And Presentation

Use this reference when generating UI cards, assistant explanations, onboarding text, or model output for non-expert users.

## Presentation Goal

Make the output understandable in under one minute:

1. What the strategy is expressing.
2. What must happen for it to work.
3. How much can be lost.
4. Where breakeven is.
5. What can go wrong.

## Card Layout

Each strategy card should show:

- Strategy name.
- Label: best fit, aggressive, conservative, or conditional.
- One-sentence view fit.
- Max loss.
- Max profit or "capped/variable/unlimited in theory".
- Breakeven.
- Expiration.
- Legs in plain English.
- Three scenario rows: downside, target/base, upside.
- Top 3 warnings.

Avoid showing more than four strategy cards by default.

## Plain-English Leg Format

Use:

- `Buy 1 call, strike $145, expires Jul 31`
- `Sell 1 call, strike $150, expires Jul 31`

Also show compact notation only as secondary:

- `+1 145C / -1 150C`

## Scenario Table

Minimum columns:

| Stock at expiration | Estimated P/L | What it means |
|---|---:|---|

Use labels:

- `Below plan`
- `Near breakeven`
- `Target case`
- `Strong move`

Do not show false precision. Round dollars to whole dollars in user-facing cards unless cents matter for premiums.

## Beginner Teaching Blocks

Attach one short teaching note per output, not one essay per card.

### Breakeven

```text
Breakeven is the stock price where the strategy starts to make money at expiration after accounting for the option premium.
```

### Max Loss

```text
Max loss is the most this defined-risk option setup can lose at expiration, before commissions and slippage.
```

### Time Decay

```text
Options lose time value as expiration approaches. A correct direction can still lose money if the move is too small or too slow.
```

### IV Crush

```text
After events like earnings, implied volatility can fall. Long options can lose value even when the stock moves in the expected direction.
```

### Assignment

```text
Short options can be assigned. That can create or remove a stock position, especially near expiration or around dividends.
```

## Visual Priority

Use this order in UI:

1. Recommendation cards.
2. Payoff/scenario comparison.
3. Risk checklist.
4. Beginner explanation.
5. Raw option-chain details.

## Copy Rules

Use:

- "This may fit your stated view because..."
- "Scenario, not prediction."
- "Defined-risk."
- "Premium at risk."
- "Upside capped."

Avoid:

- jargon before explanation
- dense paragraphs
- more than three warnings visible before expansion
- "guaranteed", "safe", "best trade", "you should buy/sell"

