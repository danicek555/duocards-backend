# DuoCards Fastify backend

A standalone TypeScript backend shared by the
[DuoCards web app](https://github.com/danicek555/Duocards) and the
[native iOS app](https://github.com/danicek555/duocards-ios). The current
scope is a versioned `/api/v1` facade over the existing PostgreSQL tables with
shared authentication, read endpoints and private text flashcard-set CRUD.

## Requirements

- Node.js 20.19.x, 22.12+ or 24+
- PostgreSQL compatible with `prisma/schema.prisma`
- An explicit auth secret containing at least 32 random bytes
- A Resend API key and verified sender for account emails in production
- An explicit public web origin used in password-reset links

No secret has a source-code fallback. Startup fails when the database URL or
auth secret is missing. In production auth cookies are always `Secure`,
`HttpOnly`, `SameSite=Lax`, and scoped to `/`.

Account email delivery defaults to the Resend HTTP API. Configure
`RESEND_API_KEY` and `FROM_EMAIL`. Local development can explicitly set
`VERIFICATION_EMAIL_MODE=console`; this mode is rejected outside
`NODE_ENV=development`, and production startup fails when Resend has no key.
Set `PUBLIC_APP_URL` to the web origin that serves `/reset-password`; it must
be an origin without a path and must use HTTPS in production or Resend mode.

## Local setup

```sh
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:validate
npm run typecheck
npm test
npm run dev
```

Fill `.env` locally before running Prisma or the server. Do not commit it.
Outside production, `DIRECT_DATABASE_URL` is preferred when set; otherwise the
backend uses `DATABASE_URL` and then `PRISMA_DATABASE_URL`. Production prefers
`DATABASE_URL`/`PRISMA_DATABASE_URL` and only then the direct URL.

The default address is `http://localhost:4000`. Configure the iOS API base URL
as the origin only:

```text
http://localhost:4000
```

The iOS client appends `/api/v1` to endpoint paths itself. Do not include that
prefix in `DUOCARDS_API_BASE_URL`, otherwise requests would contain it twice.

For a physical iPhone, replace `localhost` with a reachable HTTPS development
host or the Mac's LAN address and configure the development transport policy.

## Web app connection

The Next.js web repository keeps `/shared-api` as a same-origin proxy. Point it
at this standalone service in the web app's `.env.local`:

```dotenv
SHARED_BACKEND_URL=http://127.0.0.1:4000
NEXT_PUBLIC_SHARED_API_BASE_URL=/shared-api
```

Use the deployed HTTPS backend origin for `SHARED_BACKEND_URL` in production.
The browser continues to call `/shared-api`, so its credentialed auth cookies
remain same-origin from the browser's perspective.

## Endpoints

| Method | Path | Authentication | Compatible success payload |
| --- | --- | --- | --- |
| GET | `/health` | No | health metadata |
| GET | `/api/v1/health` | No | health metadata |
| POST | `/api/v1/auth/login` | No | `{ message, user }` + `auth` cookie |
| POST | `/api/v1/auth/register` | No | `{ message, email, requiresVerification }` (201) + `registration` cookie |
| POST | `/api/v1/auth/verify` | Registration cookie | `{ message, user }` + `auth` cookie |
| POST | `/api/v1/auth/resend` | Registration cookie for delivery | enumeration-safe `{ message }` |
| POST | `/api/v1/auth/forgot-password` | No | generic `{ message }` without account disclosure |
| POST | `/api/v1/auth/reset-password` | Reset token | `{ message }` + cleared `auth` cookie |
| GET | `/api/v1/auth/me` | Cookie | `{ user }` |
| POST | `/api/v1/auth/logout` | No | `{ message }` + cleared cookie |
| GET | `/api/v1/flashcard-sets` | Cookie | `{ flashcardSets }` |
| POST | `/api/v1/flashcard-sets` | Cookie | `{ flashcardSet }` (201) |
| GET | `/api/v1/flashcard-sets/:id` | Cookie | `{ flashcardSet }` |
| PATCH | `/api/v1/flashcard-sets/:id` | Cookie + ownership | `{ flashcardSet }` |
| DELETE | `/api/v1/flashcard-sets/:id` | Cookie + ownership | `{ message }` |
| GET | `/api/v1/user/coins` | Cookie | `{ coins }` |
| GET | `/api/v1/word-images/:id` | Cookie + ownership | `{ image }` |
| GET | `/api/v1/word-audio/:id` | Cookie + ownership | `{ audio }` |

Registration request bodies remain stable:

```json
{ "email": "ada@example.com", "password": "Strong1!", "nickname": "Ada", "locale": "en" }
```

Verification uses `{ "email": "ada@example.com", "code": "123456" }`, and
resend uses `{ "email": "ada@example.com" }`. Register creates an independent
10-minute attempt and returns its 256-bit raw challenge only in the HttpOnly
`registration` cookie. That cookie is `SameSite=Lax`, `Path=/`, `Secure` in
production, and has a `Max-Age` no greater than the attempt's remaining
ten-minute TTL; only an HMAC is stored in PostgreSQL. The root path is
intentional: browsers call the Next.js `/shared-api` proxy while
native clients call `/api/v1` directly. Verify and resend must therefore use a
cookie-preserving client (`credentials: "include"` in browsers or the shared
`URLSession` cookie store on iOS). Never copy the challenge into JSON, a custom
header, JavaScript storage, or app preferences.

The six-digit code is also stored only as an email-bound HMAC. Verification
requires both the exact challenge and code, compares the stored `expiresAt`
directly, and creates a user with `user.create`. An email uniqueness race is a
deterministic `409 EMAIL_EXISTS` and never creates an auth cookie. Successful
verification deletes every attempt for the email, sets `auth`, and clears
`registration`. Resend returns the same 200 body for missing, mismatched,
expired, and successful attempts. For a valid attempt it delivers first, then
optimistically rotates the code and expiry, and refreshes the cookie to the
same ten-minute TTL; a provider failure leaves the previous code valid.

Rate limits are applied per client IP and additionally by normalized email or
unforgeable challenge as appropriate:

- login: 40 requests per IP per 15 minutes;
- register: 20 per IP and 5 per normalized email per 15 minutes;
- verify: 30 per IP and 10 per challenge per 15 minutes;
- resend: 20 per IP per 15 minutes, 5 per challenge per 10 minutes, and (only
  after a valid token-bound lookup) 5 per normalized email per 10 minutes.
- forgot password: 20 per IP per 15 minutes and 5 per caller-IP plus HMAC'd
  normalized email per 15 minutes; throttling keeps the same 200 response;
- reset password: 20 per IP and 5 per HMAC'd token per 15 minutes.

Rate-limit failures use the shared error envelope and include `Retry-After`.
The bundled store is process-local, which matches a single prototype instance;
use the plugin's shared Redis store before horizontally scaling production.
`TRUST_PROXY` defaults to `false`; enable it only behind a trusted reverse
proxy that replaces, rather than blindly forwards, client IP headers.
For production traffic arriving through the web `/shared-api` proxy, the
backend must be network-restricted to a trusted gateway hop that strips any
incoming `X-Forwarded-For` and sets it from the real connection, with
`TRUST_PROXY=true` on the backend. Leaving proxy trust disabled makes all web
users share the gateway's IP bucket; trusting unsanitized forwarding headers
lets callers choose their own bucket.

## Password reset contract

Forgot password accepts `{ "email": "ada@example.com" }`. For every
syntactically valid email it returns status 200 with exactly:

```json
{
  "message": "If an account with this email exists, we sent a password reset link. Please check your spam or junk folder too."
}
```

Unknown accounts, throttling, provider errors, and database errors share this
response; a silently throttled request also receives `Retry-After`. Invalid or
missing request fields still use the normal non-enumerating 400 validation
errors. The email limiter is scoped to caller IP plus an HMAC of the normalized
email, so one public caller cannot exhaust a victim's bucket for another IP.
The current synchronous sender is suitable for local development, but an
existing account performs token storage and an external provider call while an
unknown account does not. That measurable timing difference means this flow is
not yet safe to describe as fully enumeration-resistant in public production;
the durable outbox below is a release gate.

For an existing user, the backend creates a new independent 32-byte random
token with a 30-minute exact expiry and stores only a domain-separated HMAC.
Existing active links remain valid. It then delivers
`${PUBLIC_APP_URL}/reset-password#token=...`; the fragment keeps the one-time
capability out of HTTP request logs and referrer headers. If delivery fails, only that new
row is conditionally deleted, leaving earlier links untouched. During the
cutover, already-issued 64-character legacy tokens remain usable through their
SHA-256 lookup; all newly issued tokens use HMAC storage.

Reset password accepts `{ "token": "...", "password": "Strong1!" }` and
applies the same password policy as registration. Invalid, expired, replayed,
or concurrently consumed tokens return `400 INVALID_OR_EXPIRED_RESET_TOKEN`.
The transaction first locks the user's row to serialize concurrent resets,
then conditionally consumes the token against the PostgreSQL wall clock,
changes the Argon2id password, and deletes every reset token for that user.
Success returns `{ "message": "Password reset successful. You can now sign
in." }` and clears the auth cookie in the current client.

Every auth token carries a domain-separated HMAC credential version derived
from the user's current salted Argon2id password hash. Each protected request
loads the current email and password hash and compares that version in constant
time. A successful password reset creates a new salted hash, so all previously
issued credential-version sessions for that user are rejected on their next
request, including sessions on other devices. No password hash is exposed in
the cookie.

A durable server-side session store, refresh-token rotation, per-device session
management, and server-side logout/revocation remain public-release gates. The
current logout endpoint only clears the caller's cookie; it cannot selectively
revoke another still-current session without changing the password.

The prototype deliberately keeps the legacy token wire format:

```text
base64url(JSON payload).base64url(HMAC-SHA256 signature)
```

Its payload contains `userId`, `email`, `credentialVersion`, and `exp`, and the
cookie expires after seven days. Tokens issued before `credentialVersion` was
introduced are rejected and require a fresh login. This is a compatibility
bridge, not the final mobile session design; refresh-token rotation and a full
server-side session store should be added before a public mobile release.

## Error contract

Every v1 error uses one envelope:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Unauthorized"
  },
  "requestId": "request-id"
}
```

Validation details may be present in `error.details`. Unexpected exceptions are
logged server-side but are not returned to clients.

## CORS

Set `CORS_ORIGINS` to a comma-separated allowlist when a browser client calls
this service. Credentialed wildcard CORS is not supported, and `*` is rejected
in production. Native iOS requests normally have no `Origin` header and do not
depend on CORS.

## Prisma safety

`prisma/schema.prisma` maps the existing DuoCards tables and contains no URL or
secret. `prisma/migrations` is a byte-for-byte baseline copy of the migration
history currently used by the web application.

Before the first `migrate deploy`, compare this history and the target
database's `_prisma_migrations` records against a disposable snapshot. Once the
baseline is confirmed, treat `prisma/schema.prisma` and
`prisma/migrations` as the target source of truth for future backend
schema changes. Never run `prisma migrate reset` or an unreviewed `prisma db
push` against an existing DuoCards database.

After that one-time verification, deployment can run:

```sh
npm run prisma:migrate:deploy
```

The `registration_attempts` migration must be deployed before enabling the v1
registration routes. Abandoned attempts expire cryptographically but remain as
rows; add a scheduled `expiresAt <= now()` cleanup before public production.

## Identity production gates

Before a multi-instance or public rollout, add both a shared Redis rate-limit
store and a durable transactional email outbox. The current resend order is
deliberately mail-before-database, so provider failures preserve the old code,
and its optimistic update prevents an older concurrent resend from overwriting
a newer one. A successful provider call followed by a database failure can
still deliver a code that was not committed; only an outbox/worker protocol can
close that external-system transaction gap. Also schedule expired-attempt row
cleanup and monitor delivery failures without logging codes or raw challenges.
The durable outbox must cover password-reset delivery as well. The HTTP path
should enqueue the same small amount of database work for every valid email and
return before provider I/O; a worker should prepare the token, retry the exact
encrypted payload with a provider idempotency key, and wipe it after a terminal
state. This removes the large existing/unknown timing signal and closes the
provider-acceptance ambiguity around synchronous rollback without exposing
tokens in logs. The scheduled expiry cleanup must also delete abandoned
`password_reset_tokens` rows where `expiresAt <= now()`.
For a privacy-hardened public signup, replace the current explicit
`409 EMAIL_EXISTS` UX with an enumeration-safe account-recovery flow; do not
silently turn a registration challenge into passwordless access to an existing
account.

## Production build

After the first approved `npm install` has generated a lockfile, commit that
lockfile and use reproducible installs:

```sh
npm ci
npm run prisma:validate
npm test
npm run build
npm start
```
