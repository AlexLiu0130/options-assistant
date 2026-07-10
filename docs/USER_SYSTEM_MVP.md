# User System MVP

## Objective

Build the smallest closed loop for an invite-only test with about 20 users:

```text
Admin invite -> User login -> 7-day trial -> Product usage -> Trial expiry -> Extension or replacement
```

The MVP should answer three questions:

1. Will users repeatedly use strategy recommendations, the simulator, and paper trading?
2. Will users request continued access after the trial?
3. Which users show enough engagement or willingness to pay for the next test cohort?

## Scope

The first version includes:

- Invite-only accounts.
- Email link or email verification-code login.
- A seven-calendar-day trial starting at the first successful login.
- Server-side access checks for protected APIs.
- Remaining-trial-time display.
- Per-user paper accounts, orders, and positions.
- Read-only expired state.
- One-click continuation request.
- A small admin user list with invite, extend, disable, and status controls.
- Minimal product-usage events.

The first version does not include:

- Public self-registration.
- Payments, subscriptions, invoices, coupons, or pricing plans.
- Social login.
- Complex role-based access control.
- Team or organization accounts.
- Automated marketing email.
- A full analytics platform.

## Roles

### Tester

- Can use protected product features while access is active.
- Can view previous paper positions after expiry.
- Can request continued access.

### Admin

- Can invite a tester.
- Can see trial status and last activity.
- Can extend access by 7, 14, or 30 days.
- Can disable access.
- Can review continuation requests and notes.

## Access States

| State | Meaning | Product access |
| --- | --- | --- |
| `invited` | Invitation created, first login not completed | Login only |
| `trial_active` | Initial seven-day trial is active | Full test access |
| `extended` | Admin granted additional time | Full test access |
| `expired` | Access end time has passed | Read-only history and education |
| `disabled` | Admin revoked access | Login and support message only |
| `internal` | Team account | Full access without trial expiry |

Payment can later add a `paid` grant without changing this state model.

## Trial Rules

- The trial starts at the first successful login, not when the invitation is sent.
- The default duration is seven calendar days.
- Expiry is determined by the backend using UTC timestamps.
- Expired accounts keep their user and paper-trade data.
- An extension creates a new access record; it does not overwrite access history.
- The 20-person limit applies to active testers, not expired users.
- An expired or disabled tester frees a test slot.
- Accounts are never recycled between different people.

## User Flow

### Invitation And Activation

1. Admin enters an email address.
2. The system creates an invited user and sends a single-use login link.
3. The user completes the first login.
4. The backend creates a seven-day access grant.
5. The user completes a short onboarding form and enters the trading page.

The onboarding form should only ask for information already used by the recommendation engine:

- Options experience level.
- Typical maximum loss budget.
- Whether assignment is acceptable.

### Active Trial

The navigation shows the remaining trial time without interrupting normal use. The tester can:

- Search supported tickers.
- Load market data and option chains.
- Generate and adjust strategy recommendations.
- Use Qveris AI explanations.
- Use the price/date simulator.
- Create and manage paper positions.
- Open the strategy education page.

### Expiry

When access expires:

- Market, option-chain, assistant, and paper-order write APIs return an access-expired response.
- Historical paper positions remain readable.
- The education page remains available.
- The UI shows the expiry date and a `Request continued access` action.
- Existing data is not deleted or reset.

### Continuation

1. The tester submits a continuation request with an optional short note.
2. The admin sees the request in the user list.
3. The admin extends access, leaves the user expired, or disables the account.
4. An approved extension takes effect immediately without a new account.

## Minimal Data Model

### `users`

| Field | Purpose |
| --- | --- |
| `id` | Internal stable user ID |
| `auth_subject` | ID from the authentication service |
| `email` | Unique login email |
| `display_name` | Optional display name |
| `role` | `tester` or `admin` |
| `status` | Current access state |
| `first_login_at` | Trial activation timestamp |
| `last_active_at` | Last authenticated product activity |
| `continuation_requested_at` | Latest continuation request |
| `admin_note` | Internal cohort and feedback note |
| `created_at` | User creation timestamp |

### `access_grants`

| Field | Purpose |
| --- | --- |
| `id` | Grant ID |
| `user_id` | Owner |
| `kind` | `trial`, `extension`, `internal`, or future `paid` |
| `starts_at` | Access start |
| `ends_at` | Access end; nullable for internal users |
| `created_by` | Admin or system actor |
| `reason` | Invite, extension, or future payment reference |
| `created_at` | Audit timestamp |

### `product_events`

Only record events needed to evaluate the test:

- `first_ticker_search`
- `strategy_opened`
- `simulator_used`
- `paper_order_created`
- `assistant_used`
- `continuation_requested`

Each event stores `user_id`, `event_name`, `created_at`, and small non-sensitive metadata. Do not store full assistant conversations in this table.

### Paper Trading

The existing paper account, order, and position records must include `user_id`. The backend must always derive this ID from the authenticated session and must ignore any user ID supplied by the browser.

## Backend Access Boundary

Authentication and access checks must be enforced in the backend. Hiding a frontend button is not authorization.

| Route group | Anonymous | Active tester | Expired tester | Admin |
| --- | --- | --- | --- | --- |
| Homepage, login, health | Yes | Yes | Yes | Yes |
| Strategy education | Yes | Yes | Yes | Yes |
| User profile and paper history read | No | Yes | Yes | Yes |
| Market and option-chain data | No | Yes | No | Yes |
| Assistant requests | No | Yes | No | Yes |
| Paper order create/close/reset | No | Yes | No | Yes |
| Continuation request | No | Yes | Yes | Yes |
| User administration | No | No | No | Yes |

The access middleware should return stable error codes:

- `AUTH_REQUIRED`
- `ACCESS_EXPIRED`
- `ACCESS_DISABLED`
- `ACTIVE_TESTER_LIMIT_REACHED`
- `ADMIN_REQUIRED`

## Minimal API Surface

- `GET /api/auth/me`: session, profile, access state, and remaining time.
- `POST /api/access/request-extension`: submit continuation request.
- `GET /api/admin/users`: list testers and access status.
- `POST /api/admin/invites`: invite one email.
- `POST /api/admin/users/:id/extend`: add 7, 14, or 30 days.
- `POST /api/admin/users/:id/disable`: revoke access.

Existing protected APIs should use shared authentication and access middleware rather than adding checks independently in every route.

## Frontend Requirements

### Login

- Qveris branding.
- Email input and login-link confirmation state.
- Clear education/simulation disclaimer.
- No pricing or subscription UI.

### Active Trial

- Small `Trial: 6 days left` indicator in the account menu.
- Account menu with email, expiry date, paper portfolio, and logout.
- No blocking countdown modal.

### Expired Trial

- Clear expired state instead of generic API errors.
- Read-only paper portfolio.
- Education remains accessible.
- One primary action: `Request continued access`.

### Admin

A single table is sufficient:

- Email.
- Status.
- Trial start and end.
- Remaining time.
- Last active time.
- Continuation request.
- Extend and disable actions.

## Operational Limits For The Test

- Maximum 20 active testers.
- Continue sharing server-side quote and option-chain caches across users.
- Keep current bounded Qveris/Theta concurrency controls.
- Add a conservative per-user assistant request limit to prevent one tester from consuming the cohort budget.
- Log access denials and upstream data failures without logging API keys or full private prompts.

## Success Signals

The MVP should report per user:

- First login completed.
- First supported ticker searched.
- Number of active days during the trial.
- Strategy card opened.
- Simulator used.
- Paper order created.
- Assistant used.
- Continuation requested.
- Admin note on willingness to keep using or pay.

No composite engagement score is needed for the first cohort. A small user table and CSV export are enough.

## Acceptance Criteria

- An invited user can log in and receives exactly seven days of access from first login.
- A non-invited user cannot create an account.
- The backend rejects protected requests from anonymous, expired, or disabled users.
- Two testers cannot read or modify each other's paper data.
- Expiry does not delete paper positions or account history.
- An expired tester can request continued access.
- An admin can extend access and the tester can immediately resume using protected features.
- The system prevents more than 20 simultaneously active tester grants.
- All timestamps and access decisions come from the backend.
- Existing engine, paper-trade, build, and lint checks continue to pass.

## Implementation Order

1. Add managed email authentication and server-side session validation.
2. Add `users` and `access_grants` persistence plus shared access middleware.
3. Bind paper-trade storage to the authenticated user.
4. Add login, account status, and expired-state UI.
5. Add the minimal admin user table.
6. Add the six product events and continuation request.
7. Run an internal test with two accounts before inviting the first cohort.

## Deferred Until Evidence Exists

- Payment provider integration.
- Pricing tiers and feature packaging.
- Automated renewals.
- Referral or public registration.
- Complex analytics dashboards.
- Multiple organizations or team permissions.

The entitlement model already leaves room for these additions without changing the initial user identity or paper-trade ownership model.
