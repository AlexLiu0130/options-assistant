# Strategy Selection Reference

Use this reference when mapping a parsed market view to candidate option strategies.

## MVP Strategy Set

Implement and recommend these first:

| View | Best-fit candidates | Notes |
|---|---|---|
| Bullish | Bull Call Spread, Long Call | Bull call spread is usually better for moderate bullish views and capped risk. Long call is more aggressive. |
| Bearish | Bear Put Spread, Long Put | Bear put spread is defined-risk and often more cost controlled. Long put is more aggressive. |
| Owns 100+ shares | Covered Call | Conditional on share ownership and willingness to cap upside. |
| Willing to buy shares | Cash-Secured Put | Conditional on assignment willingness and cash requirement. |

Defer advanced strategies until MVP works:

- Iron Condor.
- Long Straddle.
- Long Strangle.
- Calendar Spread.
- Diagonal.
- Butterfly.
- Collar.
- Protective Put.

## Recommendation Labels

- `best_fit`: strongest match to direction, target, time, risk budget, liquidity, and experience level.
- `aggressive`: higher upside or convexity, usually higher premium risk.
- `conservative`: lower risk or income-oriented, often capped upside.
- `conditional`: only fits if user has shares, accepts assignment, has higher experience, or accepts a specific risk.

## Candidate Logic

### Bullish

Return up to four:

1. Bull Call Spread as `best_fit` for mild/moderate bullish views.
2. Long Call as `aggressive`.
3. Cash-Secured Put as `conservative` only when assignment is acceptable.
4. Covered Call as `conditional` only when user owns at least 100 shares.

### Bearish

Return up to three:

1. Bear Put Spread as `best_fit` for mild/moderate bearish views.
2. Long Put as `aggressive`.
3. Protective Put as `conditional` only when user owns shares.

### Neutral

MVP should usually explain that neutral premium-selling strategies require more experience. If implemented later:

- Iron Condor for intermediate/advanced users only.
- Covered Call if shares are owned.
- Cash-Secured Put if assignment is acceptable.

### Volatile

MVP should mark this as advanced. If implemented later:

- Long Straddle at ATM.
- Long Strangle with OTM call and put.
- Must compare premium paid to expected move.

## Fit Score Inputs

Use these weights:

- direction fit: 25%
- time fit: 15%
- target fit: 15%
- risk fit: 20%
- volatility fit: 10%
- liquidity fit: 10%
- experience fit: 5%

Hard gates:

- Fail beginner naked short strategies.
- Fail max loss above risk budget unless clearly labeled.
- Warn when liquidity is weak.
- Warn when earnings occur before expiration.
