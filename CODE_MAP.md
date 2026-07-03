# Code Map

## App Shell

- `src/App.tsx`  
  Main route shell, ticker search, trade page state, data loading, strategy filtering, and assistant update wiring.

- `src/i18n/index.tsx`  
  Chinese and English UI copy.

## UI Components

- `src/components/HomePage.tsx`  
  Product entry page and ticker search.

- `src/components/UnderlyingPriceChart.tsx`  
  Candlestick chart, volume bars, current price, breakeven, target, expected move, and payoff zones.

- `src/components/OptionChainTable.tsx`  
  Calls/puts matrix for option chain display and selected strategy legs.

- `src/components/StrategyCard.tsx`  
  Strategy recommendation card, legs, simulator, explanation, and paper-trade action.

- `src/components/StrategyEducationPage.tsx`  
  Static strategy learning page with payoff and Greeks education content.

- `src/components/PaperPortfolioPage.tsx`  
  Paper-trade account, open positions, closed positions, and reset flow.

- `src/components/AssistantBot.tsx`  
  Floating assistant entry and structured conversation UI.

- `src/components/AssistantExplanationPanel.tsx`  
  Strategy explanation rendering and cleanup.

## Strategy Engines

- `src/core/payoffEngine.ts`  
  Standard option-leg expiration P/L.

- `src/core/scenarioEngine.ts`  
  Scenario generation from strategy legs and payoff engine.

- `src/core/simulatorPricingEngine.ts`  
  Theoretical strategy value as price/date changes.

- `src/core/strategyRecommendationEngine.ts`  
  Strategy candidate generation, filtering, and ranking.

- `src/core/strategyPlaybook.ts`  
  Strategy metadata, classification, examples, and education content.

- `src/core/riskChecklistEngine.ts`  
  Risk checklist generation.

## Data And Runtime

- `server/qverisServer.mjs`  
  Local API proxy for Qveris data, assistant calls, paper-trade endpoints, caching, and guardrails.

- `server/paperTradeRuntime.mjs`  
  Local paper-trading account, order, position, and P/L runtime.

- `server/assistantAgent.mjs`  
  Assistant policy, structured plan generation, and response guardrails.

- `server/supportedUnderlyings.mjs`  
  Backend supported stock and ETF universe.

- `src/core/supportedUnderlyings.ts`  
  Frontend supported stock and ETF universe.

## Types And Data Shapes

- `src/types/optionTypes.ts`  
  Market snapshot, candle, options chain, and Qveris response types.

- `src/types/strategyTypes.ts`  
  Strategy direction, legs, recommendations, scenarios, and risk types.

## Scripts

- `scripts/engineSelfCheck.ts`  
  Minimal engine correctness checks.

- `scripts/paperTradeRuntimeSmoke.mjs`  
  Paper-trade runtime smoke check.

- `scripts/liveSmoke.mjs`  
  Live API smoke helper.

- `scripts/calculateStrategies.mjs`  
  Strategy calculation helper.

- `scripts/fetchIbkrOptions.py`  
  Legacy IBKR test helper.
