# Scenario Explainer

Model-agnostic templates and calculation rules for payoff, scenario tables, and English explanations.

## Required Scenario Rows

For each strategy, create rows at:

- Current price.
- User target price when provided.
- Breakeven price or prices.
- Long strike and short strike prices.
- Downside stress: current price * 0.90 for bullish/neutral strategies.
- Upside stress: current price * 1.10 for bearish/neutral strategies.
- Expected-move boundaries if QVeris data supports them.

Deduplicate and sort rows ascending by underlying price.

## Payoff Calculation

Use expiration payoff from legs:

```text
call intrinsic = max(underlying_price - strike, 0)
put intrinsic = max(strike - underlying_price, 0)
buy option payoff = intrinsic * quantity * 100 - premium * quantity * 100
sell option payoff = premium * quantity * 100 - intrinsic * quantity * 100
strategy payoff = sum(leg payoffs)
```

For stock legs:

```text
long stock payoff = (underlying_price - stock_basis) * shares
short stock payoff = (stock_basis - underlying_price) * shares
```

If premium is unknown, return `QVERIS_DATA_GAP` and do not compute dollar P/L.

## Price Inputs

Preferred option entry estimate:

1. Mid price when bid and ask are both available.
2. Last price only as fallback, with warning.
3. Pending when no reliable price exists.

Liquidity warnings:

- Bid/ask spread percentage > 25%.
- Open interest < 50.
- Volume < 1.
- Missing bid or ask.

## Explanation Shape

For each candidate, generate concise English in this order:

1. View fit.
2. What must happen by expiration.
3. Maximum loss.
4. Maximum profit or cap.
5. Breakeven.
6. Time decay and IV sensitivity.
7. Liquidity/event/assignment warnings.
8. Education-not-advice close.

## Templates

### Bull Call Spread

```text
This defined-risk bullish spread may fit a moderate upside view because it lowers the entry cost versus a standalone call. It can profit if the stock rises above the breakeven by expiration, but gains are capped above the short call strike. The maximum loss is the net debit paid. Time decay and changes in implied volatility still matter before expiration, and both legs should be checked for liquidity.
```

### Long Call

```text
This long call expresses a stronger bullish view with convex upside. The full premium is at risk if the stock does not move above breakeven by expiration. It is sensitive to time decay and implied volatility, so a correct direction can still lose money if the move is too small, too slow, or followed by a volatility drop.
```

### Bear Put Spread

```text
This defined-risk bearish spread may fit a moderate downside view because it lowers the entry cost versus a standalone put. It can profit if the stock falls below breakeven by expiration, but gains are capped below the short put strike. The maximum loss is the net debit paid.
```

### Long Put

```text
This long put expresses a stronger bearish view or hedge-like concern. The full premium is at risk if the stock does not fall below breakeven by expiration. It is sensitive to time decay and implied volatility, so the downside move needs to be large enough and timely enough to offset premium decay.
```

### Covered Call

```text
This covered call may fit only if the user owns at least 100 shares and accepts capped upside. The call premium can offset some downside, but the stock position can still lose substantial value. Assignment can occur, especially near expiration or around dividends.
```

### Cash-Secured Put

```text
This cash-secured put may fit only if the user is willing and able to buy 100 shares at the strike. The maximum profit is the premium received, while downside can be substantial if the stock falls sharply. Assignment risk is central, not incidental.
```

## Risk Checklist Output

Return a machine-readable checklist:

```json
[
  {
    "id": "max_loss_vs_budget",
    "severity": "pass",
    "message": "Max loss is within the stated risk budget."
  },
  {
    "id": "event_risk",
    "severity": "warning",
    "message": "Earnings occurs before expiration; IV and gap risk may affect the position."
  }
]
```

Severity values:

- `pass`
- `info`
- `warning`
- `fail`

## Copy Guardrails

Use "may fit", "scenario", "candidate", "paper trade", and "research context".

Avoid "should buy", "should sell", "best trade", "safe income", "guaranteed", and "low-risk high-return".

