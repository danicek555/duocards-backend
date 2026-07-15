# DuoCards Fastify backend

An isolated TypeScript backend for the native DuoCards client. It does not
modify or import the root Next.js application. The current scope is a
versioned `/api/v1` facade over the existing PostgreSQL tables with shared
authentication, read endpoints and private text flashcard-set CRUD.

## Requirements

- Node.js 20.19.x, 22.12+ or 24+
- PostgreSQL compatible with `prisma/schema.prisma`
- An explicit auth secret containing at least 32 random bytes
- A Resend API key and verified sender for verification emails in production

No secret has a source-code fallback. Startup fails when the database URL or
auth secret is missing. In production auth cookies are always `Secure`,
`HttpOnly`, `SameSite=Lax`, and scoped to `/`.

Verification delivery defaults to the Resend HTTP API. Configure
`RESEND_API_KEY` and `FROM_EMAIL`. Local development can explicitly set
`VERIFICATION_EMAIL_MODE=console`; this mode is rejected outside
`NODE_ENV=development`, and production startup fails when Resend has no key.

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

## Endpoints

| Method | Path | Authentication | Compatible success payload |
| --- | --- | --- | --- |
| GET | `/health` | No | health metadata |
| GET | `/api/v1/health` | No | health metadata |
| POST | `/api/v1/auth/login` | No | `{ message, user }` + `auth` cookie |
| POST | `/api/v1/auth/register` | No | `{ message, email, requiresVerification }` (201) + `registration` cookie |
| POST | `/api/v1/auth/verify` | Registration cookie | `{ message, user }` + `auth` cookie |
| POST | `/api/v1/auth/resend` | Registration cookie for delivery | enumeration-safe `{ message }` |
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

The prototype deliberately keeps the legacy token wire format:

```text
base64url(JSON payload).base64url(HMAC-SHA256 signature)
```

Its payload contains `userId`, `email`, and `exp`, and the cookie expires after
seven days. This is a compatibility bridge, not the final mobile session
design; refresh-token rotation and server-side session revocation should be
added before a public mobile release.

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
baseline is confirmed, treat `backend/prisma/schema.prisma` and
`backend/prisma/migrations` as the target source of truth for future backend
schema changes. Never run `prisma migrate reset` or an unreviewed `prisma db
push` against an existing DuoCards database.

After that one-time verification, deployment can run:

```sh
npm run prisma:migrate:deploy
```

The `registration_attempts` migration must be deployed before enabling the v1
registration routes. Abandoned attempts expire cryptographically but remain as
rows; add a scheduled `expiresAt <= now()` cleanup before public production.

## Registration production gates

Before a multi-instance or public rollout, add both a shared Redis rate-limit
store and a durable transactional email outbox. The current resend order is
deliberately mail-before-database, so provider failures preserve the old code,
and its optimistic update prevents an older concurrent resend from overwriting
a newer one. A successful provider call followed by a database failure can
still deliver a code that was not committed; only an outbox/worker protocol can
close that external-system transaction gap. Also schedule expired-attempt row
cleanup and monitor delivery failures without logging codes or raw challenges.
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
