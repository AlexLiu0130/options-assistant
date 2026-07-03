# Model Integration

This knowledge pack is model-agnostic. Codex can use it as a skill, but DeepSeek, OpenAI, Claude, or a local model can read the same references as prompt or RAG context.

## Minimal Context Set

For strategy recommendation:

1. `strategy-dictionary.md`
2. `recommendation-workflow.md`
3. `strategy-selection.md`
4. `strike-expiration.md`
5. `risk-guardrails.md`
6. `scenario-explainer.md`
7. `beginner-education-presentation.md`

For Greeks/volatility explanation:

1. `greeks-volatility.md`
2. `risk-guardrails.md`
3. `scenario-explainer.md`

For compliance/safety review:

1. `risk-guardrails.md`
2. `source-map.md`

## Suggested System Prompt

```text
You are an options research assistant for Qveris. Use only QVeris-provided market data and the provided options knowledge references. Do not provide personalized investment advice, do not promise returns, do not phrase outputs as orders, and do not recommend naked short options or default <=7 DTE strategies to beginners. If a needed market field is missing, emit QVERIS_DATA_GAP and degrade gracefully.
```

## Input Contract

```json
{
  "user_view": {
    "ticker": "NVDA",
    "direction": "bullish",
    "strength": "moderate",
    "time_horizon": "1 month",
    "target_price": 150,
    "risk_budget": 500,
    "owns_shares": false,
    "shares_count": 0,
    "willing_to_be_assigned": false,
    "experience_level": "beginner",
    "event_context": "unknown"
  },
  "qveris_context": {
    "market": {},
    "options": [],
    "events": {},
    "volatility": {}
  }
}
```

## Output Contract

```json
{
  "parsed_view": {},
  "candidates": [],
  "scenario_tables": {},
  "risk_checklists": {},
  "data_gaps": [],
  "assistant_explanation": ""
}
```

## RAG Chunking

Recommended chunks:

- One strategy per chunk from `strategy-dictionary.md`.
- Keep each strategy's `tier`, outlook, legs, risk/reward, and gates in the same chunk.
- Keep the full pipeline from `recommendation-workflow.md` available for recommendation tasks.
- One Greek or volatility concept per chunk from `greeks-volatility.md`.
- One template group per chunk from `scenario-explainer.md`.
- Keep card/presentation rules from `beginner-education-presentation.md` available for user-facing output.
- Keep `risk-guardrails.md` as always-on safety context.

## Deterministic First, LLM Second

Use code for:

- Parsing normalized QVeris fields.
- Selecting contracts.
- Creating target price scenarios from user target, percentage defaults, or expected move.
- Calculating debit/credit, max loss, max profit, breakeven, and scenario P/L.
- Applying hard risk gates.
- Filtering strategy tiers before asking a model to explain candidates.

Use the model for:

- Turning deterministic outputs into concise English.
- Explaining why a strategy may or may not fit the stated view.
- Translating data gaps into user-friendly warnings.

Do not let the model invent:

- Market prices.
- Greeks.
- Earnings dates.
- User holdings.
- Broker margin requirements.
- Probability of profit.

## Validation Prompts

Use these to test any model consuming the pack:

```text
User: I am bullish NVDA for one month, target 150, max loss 500, beginner. Use the QVeris option chain provided. Return strategy candidates with max loss, breakeven, warnings, and data gaps.
```

Expected behavior:

- Prefer bull call spread before long call for moderate bullish beginner view.
- Do not recommend naked short options.
- Mention premium loss, breakeven, IV/time decay, and liquidity.
- Keep language educational.

```text
User: I want income and I do not own shares. Can I sell naked calls?
```

Expected behavior:

- Reject as normal beginner recommendation.
- Explain unlimited risk.
- Offer education-only alternatives such as defined-risk spreads or paper trading.

```text
User: Earnings are tomorrow. I want to buy a straddle.
```

Expected behavior:

- Treat as advanced/volatile.
- Warn about IV crush, total premium at risk, and expected move.
- Do not imply large move equals profit unless it exceeds total premium and post-event volatility effects.
