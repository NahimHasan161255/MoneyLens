# MoneyLens

MoneyLens is a native iPhone personal-finance app with a TypeScript API. The
backend owns Gmail access, parsing, deduplication, and PostgreSQL persistence;
the iOS app presents account, dashboard, transaction, chart, and settings
features.

## Project layout

- `ios/MoneyLens/` — SwiftUI app and iOS tests.
- `backend/src/` — API, configuration, database adapter, and SQL migrations.
- `backend/test/` — API tests.

## Development environment

- Node.js 20 or newer and npm.
- Docker Desktop with Docker Compose.
- macOS with Xcode 16 or newer and XcodeGen to generate/build the iOS project.

The current development environment is Windows and does not have Swift/Xcode;
the iOS sources and XcodeGen project are included, but building or running the
iPhone app requires macOS with Xcode.

## Start the local backend and database

From the repository root in PowerShell:

1. Copy the local environment templates:

   ```powershell
   Copy-Item .env.example .env
   Copy-Item backend/.env.example backend/.env
   ```

2. Optionally change the local PostgreSQL credentials in `.env` and set the
   matching connection string in `backend/.env`. These example credentials are
   for local development only.
3. Start PostgreSQL:

   ```powershell
   docker compose up -d postgres
   docker compose ps
   ```

   The database is bound to `127.0.0.1` and persists in a named Docker volume.
4. Install backend dependencies and apply both database migrations in order:

   ```powershell
   Set-Location backend
   npm install
   Set-Location ..
   docker compose cp backend/src/db/migrations/001_initial_schema.sql postgres:/tmp/001_initial_schema.sql
   docker compose exec postgres psql -U moneylens -d moneylens -v ON_ERROR_STOP=1 -f /tmp/001_initial_schema.sql
   docker compose cp backend/src/db/migrations/002_app_sessions.sql postgres:/tmp/002_app_sessions.sql
   docker compose exec postgres psql -U moneylens -d moneylens -v ON_ERROR_STOP=1 -f /tmp/002_app_sessions.sql
   ```

   If you changed `POSTGRES_USER` or `POSTGRES_DB`, use those values in the
   migration command as well.
5. Run backend checks and start the API:

   ```powershell
   Set-Location backend
   npm run check
   npm run dev
   ```

`GET /health` is a liveness probe and `GET /ready` checks database connectivity.
Production configuration requires PostgreSQL TLS; set `DATABASE_SSL=true` when
connecting to a TLS-enabled database.

The development API listens on port `3000` by default. In development only,
`POST /v1/dev/session` with a JSON `{}` body issues a short-lived local test
session; send its bearer token to the authenticated `/v1/categories`,
`/v1/dashboard`, and `/v1/transactions` endpoints. This development-session
endpoint is disabled in production and is not a substitute for the planned
Google OAuth flow.

Stop the database with `docker compose stop postgres`. To remove the database
and its persisted local data, run `docker compose down -v`.

## iOS setup

From `ios/`, generate the Xcode project with `xcodegen generate --spec project.yml`,
then open `MoneyLens.xcodeproj` in Xcode and run the MoneyLens scheme on an iPhone
simulator. Replace the example bundle identifier and configure signing for a
real device or distribution.

The iOS app now fetches dashboard summaries and transaction history from the
authenticated API. Its Debug configuration targets `http://127.0.0.1:3001` and
uses the development-only session endpoint; the bearer token is stored in
Keychain. Release builds have no API URL and cannot request a development
session. The current default address is intended for the iOS simulator on the
same Mac as the API; a physical device needs a reachable HTTPS development
endpoint and a separately configured Debug API URL.

The backend also provides session-protected categories, transaction listing,
details, and category updates. Gmail OAuth/sync, transaction category editing
in the iOS UI, filters, and charts are added in later development phases.

## Data and privacy foundations

The initial PostgreSQL migration creates user, category, OAuth connection,
processed-email, transaction, and sync tables. It retains extracted transaction
fields and message IDs, not email bodies. Gmail OAuth is not enabled in Phase 1.
Before Gmail integration is released, configure Google OAuth consent and
verification for the restricted `gmail.readonly` scope, token encryption with
managed keys, HTTPS callback/Universal Link domains, and privacy disclosures.
