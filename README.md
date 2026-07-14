# Qveris AI Options Assistant

Qveris AI Options Assistant is a private prototype for US equity options research, strategy comparison, education, and paper trading.

It helps users:

- Search supported US stock and ETF underlyings.
- View price candles, expected move, option chains, and strategy markers.
- Compare options strategies by max loss, max gain, breakeven, probability estimate, and payoff shape.
- Simulate strategy P/L as underlying price and date change.
- Learn common options strategies through a dedicated education page.
- Track paper-trade positions with local simulated cash and P/L.

This product is for research, education, and simulation only. It does not place broker orders and does not provide personalized investment advice.

## Core Features

- Strategy builder for bullish, neutral, bearish, volatility, and other strategies.
- Options chain table centered around the current underlying price.
- Payoff and Greeks education views.
- Qveris-backed market data API proxy.
- DeepSeek-backed assistant explanations with product guardrails.
- Local paper-trading runtime for prototype testing.

## Tech Stack

- React + Vite + TypeScript
- Lightweight Charts
- Lucide React
- Node local API server

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run api
npm run dev
```

Set the required keys in `.env.local`:

```bash
QVERIS_API_KEY=
DEEPSEEK_API_KEY=
QVERIS_AUTH_BASE_URL=http://localhost:3000
QVERIS_OAUTH_CLIENT_ID=options-assistant-local
QVERIS_OAUTH_CLIENT_SECRET=
QVERIS_OAUTH_SESSION_SECRET=
QVERIS_OAUTH_REDIRECT_URI=http://127.0.0.1:8787/auth/callback
QVERIS_OAUTH_RESOURCE=http://localhost:3000/account
QVERIS_OAUTH_SCOPES=openid profile email
```

The OAuth client and invited users must first be provisioned in qveris.ai. The application is a confidential server-side Web client: it discovers OAuth endpoints, uses Authorization Code + S256 PKCE, requests the Account Resource, validates the signed ID token and UserInfo response, and gives the browser only an HttpOnly application session cookie. The local session never outlives the OAuth access token. Paper-trading data is isolated by the QVeris user `sub` claim.

The frontend runs on Vite and proxies `/api/*` to the local API server at `http://127.0.0.1:8787`.

## Checks

```bash
npm run lint
npm run build
npm run check:engines
npm run check:paper
# or run all checks
npm run check
```

## Data Boundary

Real market and options data should flow through Qveris-facing backend routes. API keys stay on the server side and must never be exposed in frontend code.

## Risk Boundary

The assistant must explain assumptions, uncertainty, max loss, liquidity risk, expiration risk, and event risk. Outputs are decision support and education, not financial advice.

## Project References

- [Code map](CODE_MAP.md)
- [Reusable assets](docs/REUSABLE_ASSETS.md)
- [Completion audit](docs/PROJECT_AUDIT_2026-07-10.md)
- [User-system MVP](docs/USER_SYSTEM_MVP.md)
- [Deployment handoff](DEPLOYMENT_HANDOFF.md)
