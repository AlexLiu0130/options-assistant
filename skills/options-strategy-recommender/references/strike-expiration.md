# Strike And Expiration Reference

Use this reference when selecting expirations and strikes from QVeris option-chain data. For target price scenarios before strike selection, use `recommendation-workflow.md`.

## Available QVeris Fields

Confirmed option-chain fields:

- `date`
- `strike`
- `expiry`
- `option_type`
- `price`
- `name`
- `bid`
- `ask`
- `bid_size`
- `ask_size`
- `volume`
- `open_interest`
- `iv`
- `delta`
- `symbol`

Known gaps:

- `QVERIS_DATA_GAP`: gamma, theta, vega, rho are unstable.
- `QVERIS_DATA_GAP`: multiplier/reference master is unstable.
- Use standard US equity option multiplier 100 with a visible assumption.

## Expiration Selection

First map the user's natural-language horizon to a DTE band using `recommendation-workflow.md`; then choose actual expirations from the QVeris option chain.

Default DTE bands:

| Scenario | DTE |
|---|---:|
| Short-term direction | 14-30 |
| Normal directional trade | 30-60 |
| Covered Call | 30-45 |
| Cash-Secured Put | 30-45 |
| Earnings event | nearest expiration covering earnings plus a farther comparison |
| Medium-term view | 60-120 |
| Stock replacement | 180+ |

Guardrails:

- Beginner: do not select 0DTE or DTE <= 7 by default.
- If user explicitly asks for very short DTE, show high-risk warning instead of hiding it.
- If earnings date is before expiration, add event and IV-crush warning.

## Strike Selection

Use the base target price from `recommendation-workflow.md` when the strategy needs a target strike. If the user supplied a target, prefer that target unless it is far outside available liquid strikes.

Always filter or warn on liquidity:

- spread percentage = `(ask - bid) / mid`
- warn if spread percentage > 25%
- warn if open interest < 50
- warn if volume < 1

### Long Call

- Moderate bullish: call with delta 0.45-0.60.
- Strong bullish: call with delta 0.30-0.40.
- Fallback: nearest ATM call.

### Long Put

- Moderate bearish: put with delta -0.45 to -0.60.
- Strong bearish: put with delta -0.30 to -0.40.
- Fallback: nearest ATM put.

### Bull Call Spread

- Buy call: delta 0.45-0.60 or nearest ATM.
- Sell call: target price strike, or delta 0.20-0.35.
- Ensure sell strike > buy strike.
- Max loss = net debit * 100.
- Max profit = width minus net debit, multiplied by 100.
- Breakeven = buy strike + net debit.

### Bear Put Spread

- Buy put: delta -0.45 to -0.60 or nearest ATM.
- Sell put: downside target strike, or delta -0.20 to -0.35.
- Ensure sell strike < buy strike.
- Max loss = net debit * 100.
- Max profit = width minus net debit, multiplied by 100.
- Breakeven = buy strike - net debit.

### Covered Call

- Require user owns at least 100 shares.
- Sell call near target sell price or delta 0.20-0.35.
- Always warn: upside is capped and assignment can occur.

### Cash-Secured Put

- Require willingness to be assigned.
- Sell put near desired buy price or delta -0.20 to -0.35.
- Max profit = credit * 100.
- Breakeven = strike - credit.
- Cash required = strike * 100.
- Always warn: assignment and stock downside risk.

## Expected Move

If no direct expected move field exists, estimate from ATM straddle:

- Find nearest ATM call and put for selected expiration.
- expected move approx = call ask/mid + put ask/mid.
- Use as scenario range, not prediction.
