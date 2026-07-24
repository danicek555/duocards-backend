# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-23

First stable release of the standalone DuoCards backend, shared by the
DuoCards web app and the native iOS app.

### Added

- Versioned `/api/v1` facade over the existing PostgreSQL tables with
  shared cookie-session authentication.
- Private text flashcard-set CRUD and read endpoints for decks and cards.
- Live game v2 endpoints (`/api/v1/live/sessions/...`) so the deployed backend
  matches what the web app calls in production.
- Welcome bonus on registration (100 coins recorded as a `WELCOME_BONUS`
  coin transaction).
- Secure email registration with verification delivered through the
  Resend HTTP API.
- Secure password recovery with single-use reset tokens and
  `PUBLIC_APP_URL`-based reset links.
- Remembered login sessions validated server-side; changing or resetting the
  password revokes every existing session (per-session revocation is a
  documented follow-up — see README).
- Liveness endpoint (`/health`) and a database-backed readiness endpoint
  (`/ready`, returns 503 when the database is unreachable).
- Rate limiting, strict CORS, and fail-closed secret handling — startup
  fails when the database URL or auth secret is missing.

### Security

- HTTP security headers via `@fastify/helmet`: strict CSP, `nosniff`,
  frame denial, `no-referrer`, HSTS in production, and `Cache-Control: no-store`
  on responses.
- `TRUST_PROXY` now accepts a proxy hop count or a trusted IP/CIDR list, so the
  real client IP is read correctly behind Cloud Run and per-IP rate limits can
  no longer be spoofed via `X-Forwarded-For`.
- Login runs a constant-time password verification even for unknown accounts,
  closing a timing side channel that revealed which emails are registered.
- Optional shared rate-limit store via `REDIS_URL`; production warns when it is
  absent, since the in-process store does not hold across instances.
- Upgraded dependencies to clear the `find-my-way`/`fast-uri` advisories in the
  runtime request path.

### Fixed

- Prisma client generation no longer requires build secrets.
