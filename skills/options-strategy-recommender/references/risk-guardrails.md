# Risk Guardrails Reference

Use this reference for risk checks, safety language, and education-not-advice constraints.

## Required Risk Checks

Every strategy must include:

- Max loss vs risk budget.
- Bid/ask spread width.
- Volume and open interest.
- DTE / short-dated risk.
- Earnings before expiration.
- IV / IV crush risk when IV is available.
- Assignment risk for short options.
- Beginner suitability.
- QVeris data gaps.

## Severity Rules

Use:

- `pass`: acceptable.
- `info`: relevant but not bad.
- `warning`: user should review carefully.
- `fail`: do not recommend as a normal candidate.

Fail conditions:

- Beginner naked short option.
- Strategy max loss exceeds stated risk budget and cannot be capped.
- 0DTE or DTE <= 7 for beginner default recommendation.

Warnings:

- spread percentage > 25%.
- open interest < 50.
- volume < 1.
- earnings date before expiration.
- long premium strategy when IV is high.
- short premium strategy with assignment risk.
- reference master or full Greeks unavailable.

## Safe English Wording

Use:

- "This strategy may fit your stated view because..."
- "The maximum loss is defined at..."
- "This is a scenario, not a prediction."
- "If the stock does not move beyond breakeven, the strategy can still lose money."
- "Consider paper trading this setup before using real capital."

Avoid:

- "You should buy..."
- "You should sell..."
- "This is the best trade."
- "Guaranteed profit."
- "Low-risk high-return."
- "This will make money."

## Explanation Template

For each strategy:

1. What view it expresses.
2. What needs to happen for it to profit.
3. What can go wrong.
4. Max loss.
5. Max profit where calculable.
6. Breakeven.
7. Time decay impact.
8. IV impact.
9. Assignment risk if any.
10. Why it is or is not beginner friendly.

## Data Gap Language

Use direct gap labels:

- `QVERIS_DATA_GAP: Full Greeks unavailable, so gamma/theta/vega/rho risk is described qualitatively.`
- `QVERIS_DATA_GAP: Option reference master unavailable, using standard 100-share US equity option multiplier assumption.`
- `QVERIS_DATA_GAP: IV Rank/Percentile unavailable, using contract IV and qualitative IV warnings only.`
