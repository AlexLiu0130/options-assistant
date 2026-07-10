# Reusable Assets

This project contains reusable option-domain modules that are intentionally separated from provider calls and UI state.

## Deterministic Option Engines

| Asset | Files | Reuse value | Boundary |
| --- | --- | --- | --- |
| Expiration payoff | `src/core/payoffEngine.ts` | Leg and multi-leg expiration P/L, entry value, payoff series | Standard US equity option multiplier defaults to 100 |
| Price/date simulator | `src/core/simulatorEngine.ts` | Black-Scholes option value and strategy P/L as spot and DTE change | European-style model; dividend yield defaults to zero |
| Scenario generation | `src/core/scenarioEngine.ts` | Converts a user view into stress, breakeven, and target scenarios | Scenario, not prediction |
| Strategy recommendation | `src/core/strategyRecommendationEngine.ts` | Selects expiries and strikes, builds strategies, estimates PoP, ranks suitability | Requires normalized contracts; score is internal ordering, not advice |
| Strategy adjustment | `src/core/strategyAdjustmentEngine.ts` | Rebuilds legs, metrics, payoff, and simulator state after user edits | Rejects incomplete or incompatible legs |
| Risk checklist | `src/core/riskChecklistEngine.ts` | Produces explicit risk and data-gap rows | Does not replace suitability/compliance review |
| Greeks curves | `src/core/greeksChartEngine.ts` | Creates consistent Delta/Gamma/Theta/Vega chart data | Model curves can combine live point Greeks with theoretical surrounding curves |
| Expiry selection | `src/core/expirationEngine.ts` | Maps horizon to DTE bands and chain expirations | Uses calendar days |

The portable domain contracts are in `src/types/optionTypes.ts` and `src/types/strategyTypes.ts`. A new project should normalize its provider response into these types before calling an engine.

## Data Gateway Pattern

`server/qverisServer.mjs` is reusable as a reference for:

- keeping provider keys server-side;
- normalizing multiple tools into one market/options response;
- separating fast quote refresh from expensive chain refresh;
- bounded concurrency for provider-heavy calls;
- in-flight request deduplication, TTL cache, closed-market cache, and prewarming;
- explicit partial/unavailable data states instead of fabricated values.

The provider tool IDs are project-specific. Reuse the cache and normalization pattern, not the IDs themselves.

## Paper Trading Pattern

`src/core/paperTradeEngine.ts` contains deterministic validation, fee estimates, fills, theoretical marks, and close P/L. `server/paperTradeRuntime.mjs` adds persistence and account bookkeeping.

Reuse the engine in prototypes. Replace the local JSON runtime with authenticated database storage before multi-user deployment. Fee constants are estimates and must be reviewed periodically.

## Bounded Assistant

The reusable assistant package consists of:

- `src/core/assistantPolicy.ts` for frontend context and structured updates;
- `server/assistantAgent.mjs` for intent, clarification, refusal, and response enforcement;
- `skills/options-strategy-recommender/` for model-independent strategy rules, source notes, presentation rules, and risk guardrails.

The key pattern is that the model explains deterministic outputs; it does not recalculate prices, payoff, max loss, PoP, or Greeks.

## Financial UI Components

The most portable components are:

- `UnderlyingPriceChart.tsx`: candles, volume, current price, expected move, payoff zones, and simulator marker;
- `OptionChainTable.tsx`: aligned call/strike/put matrix and selected-leg states;
- `StrategyCard.tsx`: recommendation summary, leg adjustment, simulator, Greeks, explanation, and paper action;
- `GreeksQuadChart.tsx` and `StrategyPayoffChart.tsx`: reusable strategy visualizations;
- `AssistantExplanationPanel.tsx`: safe rendering of structured model explanations.

These components depend on the project types and CSS tokens. Extract the corresponding type and engine first, then the component.

## Verification Assets

- `scripts/engineSelfCheck.ts`: payoff, PoP tails, simulator, Greeks, adjustment, ranking, assistant, and paper-engine checks.
- `scripts/paperTradeRuntimeSmoke.mjs`: account/order/position runtime smoke test.
- `scripts/liveSmoke.mjs`: live API boundary smoke test.
- `npm run check`: lint, production build, deterministic engine checks, and paper runtime checks.

Keep these checks with any extracted engine. Financial logic without a runnable regression check is not a reusable asset.
