# Deployment Handoff

Date: 2026-07-06  
Repository: `AlexLiu0130/options-assistant`  
Status: private prototype, not production-ready yet.

This document is for the teammate responsible for deploying Qveris AI Options Assistant to a server. It only lists deployment blockers and required production-readiness work. It does not cover product feature optimization.

## Current Project Shape

- Frontend: React + Vite + TypeScript.
- Backend: local Node HTTP server in `server/qverisServer.mjs`.
- Data: Qveris API proxy routes from the backend.
- AI explanation: DeepSeek API called from the backend.
- Paper trade: local file runtime in `server/paperTradeRuntime.mjs`.
- Local dev frontend: Vite dev server.
- Local dev API: `npm run api`, binding to `127.0.0.1:8787`.

## Required Environment Variables

The deployment environment must provide:

```bash
QVERIS_API_KEY=
DEEPSEEK_API_KEY=
```

Optional runtime variables currently supported:

```bash
QVERIS_BASE_URL=
DEEPSEEK_BASE_URL=
DEEPSEEK_MODEL=
QVERIS_SESSION_ID=
API_PORT=
QVERIS_REFRESH_MS=
QVERIS_CLOSED_CACHE_MS=
QVERIS_HEAVY_CONCURRENCY=
```

## Deployment Blockers

### Authentication

There is no login system yet.

Before a public server deployment, the project needs:

- Login page.
- User identity.
- Session or token handling.
- Protected routes for paper portfolio and user-specific data.
- Server-side user authorization checks.
- Logout flow.

### User Data Persistence

Paper trading currently stores data in a local file:

```text
.qveris-paper-trades.json
```

This is not suitable for multi-user server deployment.

Deployment needs a server-side persistent store for:

- Users.
- Paper trade accounts.
- Orders.
- Positions.
- Realized and unrealized P/L records.
- Reset history or audit trail.

### API Server Hardening

The backend is currently a local prototype server.

Before deployment, review:

- It binds to `127.0.0.1`.
- CORS is hard-coded to `http://localhost:5173`.
- There is no production request logging policy.
- There is no server-side rate limiting.
- There is no request size limit.
- There is no centralized error reporting.
- There is no deployment process manager configuration.
- There is no Dockerfile or server deployment manifest.
- `/api/health` exists, but no deeper dependency health check exists.

### Frontend Production Wiring

The Vite proxy is local-development only:

```ts
'/api': 'http://127.0.0.1:8787'
```

Server deployment needs the production frontend to know how `/api/*` reaches the backend through the deployed domain or reverse proxy.

Also review:

- Asset hosting path.
- HTTPS requirement.
- Browser cache behavior.
- Error states when API is unavailable.
- Login-required states.

### Secrets

Secrets must stay on the server.

Do not expose:

- `QVERIS_API_KEY`
- `DEEPSEEK_API_KEY`
- Any future auth/session signing secret.

`.env.local` is local-only and must not be deployed or committed.

### Qveris API Runtime Limits

The backend currently includes basic cache and concurrency settings for Qveris-heavy requests.

Before server deployment, review:

- Expected concurrent users.
- Qveris provider concurrency limit.
- Cold-start option-chain latency.
- Cache TTL during market hours vs after-hours.
- Cache storage location and eviction.
- Failure state when Qveris data is slow or unavailable.

### Assistant API Boundary

DeepSeek is used only for language generation. Market data and numeric calculations should come from the deterministic engines and Qveris-backed data.

Before deployment, review:

- User prompt logging policy.
- PII handling.
- Assistant response compliance wording.
- Abuse or off-topic request handling.
- Server-side enforcement of assistant boundaries.

### Compliance Copy

The app is for education, research, and simulation.

Before public access, legal/compliance should review:

- Homepage copy.
- Strategy recommendation wording.
- Assistant responses.
- Paper trade wording.
- Risk disclaimers.
- "Not investment advice" placement.

### Supported Universe

Supported symbols are restricted in:

- `src/core/supportedUnderlyings.ts`
- `server/supportedUnderlyings.mjs`

Before deployment, confirm the final supported US stocks and ETFs list.

### Build And Checks

Current local checks:

```bash
npm run lint
npm run build
npm run check:engines
npm run check:paper
```

Known non-blocking warning:

- `src/i18n/index.tsx` has an oxlint Fast Refresh warning because it exports shared values from a React module.

## Suggested Deployment Readiness Checklist

- [ ] Add login page.
- [ ] Add backend auth/session validation.
- [ ] Replace local paper-trade file storage.
- [ ] Configure production API URL/reverse proxy.
- [ ] Replace hard-coded CORS origin.
- [ ] Configure secret management.
- [ ] Add process manager or container setup.
- [ ] Add production logs and error monitoring.
- [ ] Add rate limiting.
- [ ] Add request body limits.
- [ ] Add deployment health checks.
- [ ] Confirm Qveris cache policy.
- [ ] Confirm supported symbol universe.
- [ ] Review compliance copy.
- [ ] Run all checks before release.

## Useful Files

- `README.md` - product overview and local setup.
- `CODE_MAP.md` - code structure map.
- `server/qverisServer.mjs` - local API proxy.
- `server/paperTradeRuntime.mjs` - local paper-trade runtime.
- `src/App.tsx` - app shell and main data loading.
- `src/components/HomePage.tsx` - current entry page.
- `src/components/PaperPortfolioPage.tsx` - current paper portfolio page.
- `src/core/strategyRecommendationEngine.ts` - strategy ranking logic.
- `src/core/payoffEngine.ts` - expiration payoff logic.
