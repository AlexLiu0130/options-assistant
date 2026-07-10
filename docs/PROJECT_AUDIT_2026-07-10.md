# Project Audit - 2026-07-10

## Result

The repository is suitable as a completed internal prototype and a deployment candidate behind controlled access. It is not yet a public multi-user trading product.

## Verified

- TypeScript production build passes.
- Lint passes without warnings.
- Deterministic engine self-check passes.
- Paper-trade runtime smoke test passes.
- Qveris market smoke test returns normalized market data.
- Production dependencies report no known npm audit vulnerabilities.
- API keys remain server-side and local environment files are ignored.

## Corrections Made

- Replaced truncated-grid PoP estimation with exact integration over the strategy's piecewise-linear expiration payoff, including both distribution tails.
- Tightened strike coverage validation so every selected leg must be within the supported spot range.
- Removed the retired IBKR fetcher, Python dependency, and obsolete IBKR-style calculator/example.
- Removed unused Ant Design Charts and AG Grid packages and registration code.
- Lazy-loaded the education and paper-portfolio routes to keep them out of the initial application bundle.
- Renamed the i18n barrel to a plain TypeScript file, eliminating the Fast Refresh lint warning.
- Added one aggregate `npm run check` command and automatic GitHub CI.
- Corrected stale code-map and deployment documentation.
- Added all live cache and prewarm settings to the Docker environment contract.
- Ignored local marketing output so the working tree stays clean.

## Remaining Boundaries

| Area | Current state | Required before public multi-user use |
| --- | --- | --- |
| Authentication | None | Login, sessions, authorization, logout |
| Paper persistence | Local JSON file | Transactional per-user database and audit trail |
| Market model | Black-Scholes estimate | Document model limits; add dividend/early-exercise handling if required |
| Paper marks | Underlying-driven theoretical option values | Live tradable option marks if execution realism is required |
| Fees | IBKR-like estimate | Periodic rate review and broker/venue-specific schedule |
| Recommendation | Deterministic suitability ranking | Compliance review, monitoring, and outcome validation |
| API protection | Cache and concurrency controls | Per-user rate limits, request limits, observability, abuse controls |
| Legal | Education/simulation wording | Formal legal and compliance approval |

## Maintenance Priorities

1. Keep provider normalization separate from deterministic engines.
2. Treat missing data as a state; never backfill financial values with fabricated numbers.
3. Run `npm run check` before every merge.
4. Review fee constants, supported tickers, provider tool IDs, and model assumptions on a scheduled basis.
5. Split the API server only when operational ownership or test isolation requires it; its current single-service shape is acceptable for the prototype.
