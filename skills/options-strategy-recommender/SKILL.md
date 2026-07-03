---
name: options-strategy-recommender
description: Use when designing, implementing, reviewing, or explaining Qveris AI Options Assistant strategy recommendations and model-agnostic options knowledge. Covers mapping user market views to option strategies, choosing expirations/strikes, computing payoff/scenario/risk outputs, explaining Greeks/volatility, preparing RAG or prompt context for other models, and enforcing QVeris-only data plus education-not-advice guardrails.
---

# Options Strategy Recommender

Use this project-local skill for Qveris AI Options Assistant strategy logic and model-agnostic knowledge retrieval. It supports internal product/engineering work, not investment advice.

## Hard Rules

- Use QVeris data only. Do not add direct external data providers or SDKs.
- User-facing copy must be English; internal planning and logs must be Chinese.
- Never phrase outputs as orders or advice: avoid "buy", "sell", "best trade", "guaranteed", "sure profit".
- Beginner users must not receive default 0DTE, naked short call, or naked short put recommendations.
- If required QVeris data is unavailable, mark `QVERIS_DATA_GAP` and degrade the feature.

## Workflow

1. Read the current PRD, engineering spec, latest work log, and QVeris field audit before changing logic.
2. Parse the user's view into ticker, direction, strength, horizon, target price, risk budget, holdings, assignment willingness, experience level, and event context.
3. Fetch or require normalized QVeris data: quote/OHLCV, option chain, earnings/events, filings, and volatility surface where needed.
4. Select strategies by view using `references/strategy-dictionary.md`:
   - recommend from `tier_1` first for MVP and beginner flows.
   - use `tier_2` for simulation/explanation after payoff and risk checks exist.
   - keep `tier_3` as advanced education unless margin, exercise, dividend, and portfolio controls exist.
   - block naked short calls/puts for beginners and normal recommendations.
5. Choose expiration and strikes using QVeris option-chain fields, then compute metrics, payoff, scenario rows, fit score, and risk checklist.
6. Generate English explanations from deterministic data only.
7. Log every plan, implementation, validation, and known data gap in Chinese.

## References

Read only what the task needs:

- `references/strategy-selection.md`: mapping views to strategies, MVP vs later strategies.
- `references/strike-expiration.md`: expiration and strike-selection heuristics.
- `references/risk-guardrails.md`: risk checklist, prohibited language, compliance-safe wording.
- `references/strategy-dictionary.md`: model-agnostic strategy facts, formulas, fit rules, and implementation payload fields.
- `references/recommendation-workflow.md`: end-to-end flow from user view to target prices, expirations, candidates, and ranked outputs.
- `references/greeks-volatility.md`: Greeks, IV, skew, term structure, event volatility, and qualitative fallback rules.
- `references/scenario-explainer.md`: scenario table, payoff, and plain-English explanation templates.
- `references/beginner-education-presentation.md`: simple UI/copy rules for beginner education and readable strategy cards.
- `references/model-integration.md`: how to feed this knowledge pack to DeepSeek/OpenAI/Claude or a local model without depending on Codex.
- `references/source-map.md`: distilled source map from public books and education resources.

## Output Standard

Every recommended strategy must include:

- strategy label: best_fit / aggressive / conservative / conditional
- legs
- debit or credit
- max loss
- max profit where calculable
- breakeven
- target price P/L if target exists
- fit score
- reasons
- warnings
- data gaps
