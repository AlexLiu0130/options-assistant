# Recommendation Workflow

Model-agnostic end-to-end workflow for turning a user view into strategy candidates, target prices, expirations, and scenario P/L.

## Pipeline

1. Parse the user view.
2. Build target price scenarios.
3. Select expiration candidates.
4. Filter option chain by expiration, right, strike, liquidity, and DTE.
5. Generate strategy candidates from `strategy-dictionary.md`.
6. Compute debit/credit, max loss, max profit, breakevens, and scenario P/L.
7. Apply risk gates from `risk-guardrails.md`.
8. Rank candidates.
9. Render simple strategy cards and beginner explanations.

## Parsed View Defaults

If missing:

- `strength`: `moderate`
- `experience_level`: `beginner`
- `owns_shares`: `false`
- `willing_to_be_assigned`: `false`
- `event_context`: `unknown`
- `time_horizon`: normal directional trade, 30-60 DTE

Record assumptions in output.

## Target Price Engine

If user gives a target price:

```json
{
  "conservative": "target_price",
  "base": "target_price",
  "optimistic": "target_price"
}
```

If no target price is given, use current price:

| View | Conservative | Base | Optimistic |
|---|---:|---:|---:|
| bullish | current * 1.03 | current * 1.07 | current * 1.12 |
| bearish | current * 0.97 | current * 0.93 | current * 0.88 |
| neutral | current * 0.97 to 1.03 | current * 0.95 to 1.05 | current * 0.92 to 1.08 |
| volatile | expected-move lower/upper if available; otherwise current * 0.92 to 1.08 |

If QVeris expected move can be estimated from ATM straddle:

```text
expected_move = ATM call mid + ATM put mid
upper = current_price + expected_move
lower = current_price - expected_move
```

Use expected move as a scenario range, not as a prediction.

## Expiration Engine

Map horizon to DTE:

| User horizon | DTE band |
|---|---:|
| today / 0DTE | do not default; warn, especially for beginners |
| this week | 7-14, only if user explicitly asks |
| 2-4 weeks | 14-30 |
| 1 month | 30-45 |
| 1-2 months | 30-60 |
| 3 months | 60-120 |
| 6+ months | 180+ |

Choose up to three expirations:

- nearest valid expiration inside the DTE band
- a slightly farther expiration for time-decay comparison
- event-covering expiration when earnings/event context matters

Never default beginners to DTE <= 7.

## Candidate Count

Return 2-4 strategies:

- `best_fit`: strongest match to view, target, DTE, risk budget, and experience.
- `aggressive`: higher convexity or higher risk.
- `conservative`: lower risk, lower cost, or assignment-aware income.
- `conditional`: only if user has shares, accepts assignment, or is advanced.

For beginners, prefer 2-3 candidates rather than a long menu.

## Ranking

Score out of 100:

- direction fit: 25
- risk budget fit: 20
- target/breakeven fit: 15
- expiration fit: 15
- liquidity fit: 10
- event/IV fit: 10
- experience fit: 5

Hard fail:

- beginner naked short options
- max loss exceeds risk budget and cannot be capped
- missing price data for required legs
- unsupported exercise/multiplier/margin assumptions for advanced structures

## Output Shape

```json
{
  "assumptions": [],
  "target_prices": {
    "conservative": 0,
    "base": 0,
    "optimistic": 0,
    "method": "user_target|percentage_default|expected_move"
  },
  "expiration_candidates": [],
  "strategies": [
    {
      "label": "best_fit",
      "name": "Bull Call Spread",
      "why_it_fits": "",
      "legs": [],
      "max_loss": 0,
      "max_profit": 0,
      "breakevens": [],
      "target_price_pl": 0,
      "scenario_rows": [],
      "risk_checks": [],
      "beginner_note": "",
      "data_gaps": []
    }
  ]
}
```

## Degrade Gracefully

- If option chain is unavailable, explain what data is missing and do not invent contracts.
- If Greeks are unavailable, calculate expiration payoff only and explain Greeks qualitatively.
- If events are unavailable, show `QVERIS_DATA_GAP` for event risk.
- If only market price is available, provide education and target scenario framing, not contract-level strategies.

