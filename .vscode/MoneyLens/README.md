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
4. Install backend dependencies and apply the four database migrations in order:

   ```powershell
   Set-Location backend
   npm install
   Set-Location ..
   docker compose cp backend/src/db/migrations/001_initial_schema.sql postgres:/tmp/001_initial_schema.sql
   docker compose exec postgres psql -U moneylens -d moneylens -v ON_ERROR_STOP=1 -f /tmp/001_initial_schema.sql
   docker compose cp backend/src/db/migrations/002_app_sessions.sql postgres:/tmp/002_app_sessions.sql
   docker compose exec postgres psql -U moneylens -d moneylens -v ON_ERROR_STOP=1 -f /tmp/002_app_sessions.sql
   docker compose cp backend/src/db/migrations/003_google_oauth_flows.sql postgres:/tmp/003_google_oauth_flows.sql
   docker compose exec postgres psql -U moneylens -d moneylens -v ON_ERROR_STOP=1 -f /tmp/003_google_oauth_flows.sql
   docker compose cp backend/src/db/migrations/004_sync_run_lock.sql postgres:/tmp/004_sync_run_lock.sql
   docker compose exec postgres psql -U moneylens -d moneylens -v ON_ERROR_STOP=1 -f /tmp/004_sync_run_lock.sql
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

The development API listens on port `3001` by default. In development only,
`POST /v1/dev/session` with a JSON `{}` body issues a short-lived local test
session; send its bearer token to the authenticated `/v1/categories`,
`/v1/dashboard`, and `/v1/transactions` endpoints. This development-session
endpoint is disabled in production and is only for local API development; Gmail
OAuth separately links the user's Google account.

Stop the database with `docker compose stop postgres`. To remove the database
and its persisted local data, run `docker compose down -v`.

## iOS setup

From `ios/`, generate the Xcode project with `xcodegen generate --spec project.yml`,
then open `MoneyLens.xcodeproj` in Xcode and run the MoneyLens scheme on an iPhone
simulator. Replace the example bundle identifier and configure signing for a
real device or distribution.

## Continuous integration

The GitHub Actions workflow at the repository root runs backend checks on Ubuntu
and generates, builds, and tests the iOS app on a GitHub-hosted macOS runner.
Push a branch or open a pull request to see the workflow result in the GitHub
Actions tab. The iOS job selects an available iPhone simulator and uploads the
Xcode result bundle for inspection.

The iOS app now fetches dashboard summaries and transaction history from the
authenticated API. Its Debug configuration targets `http://127.0.0.1:3001` and
uses the development-only session endpoint; the bearer token is stored in
Keychain. Release builds have no API URL and cannot request a development
session. The current default address is intended for the iOS simulator on the
same Mac as the API; a physical device needs a reachable HTTPS development
endpoint and a separately configured Debug API URL.

The backend also provides session-protected categories, transaction listing,
details, category updates, and Gmail sync endpoints. Transaction category
editing in the iOS UI, filters, and charts are added in later development
phases.

## Japanese transaction parser

The backend parser registry currently includes a provider-neutral Japanese
card-notification parser. It recognizes common date, merchant, amount, and card
labels; normalizes full-width Japanese text and digits; and extracts optional
times and currencies. Unsupported messages return a safe reason code without
including message text. Provider-specific parsers can be registered ahead of
the generic parser. The Gmail adapter supplies normalized message text to the parser in memory;
email bodies are not stored.

## Gmail OAuth configuration

Gmail connection is disabled until the backend has all five
`GOOGLE_OAUTH_*` settings. To enable it locally:

1. In Google Cloud, enable the Gmail API and create an OAuth **Web application**
   client. Add the exact local callback URI
   `http://localhost:3001/v1/oauth/google/callback` to its authorized redirect
   URIs and add your account as a test user on the consent screen.
2. Copy the client ID and secret into the ignored `backend/.env` file. Set
   `GOOGLE_OAUTH_REDIRECT_URI` to the callback registered in Google Cloud.
3. Generate a local 32-byte encryption key:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

   Set the output as `GOOGLE_OAUTH_ENCRYPTION_KEY` and choose a version label
   such as `local-v1` for `GOOGLE_OAUTH_ENCRYPTION_KEY_VERSION`. Never commit
   the generated key, Google client secret, or populated `.env`.
4. Apply `backend/src/db/migrations/003_google_oauth_flows.sql` and
   `backend/src/db/migrations/004_sync_run_lock.sql` after migrations 001 and
   002, then restart the API.
5. With a development bearer session, call `POST /v1/gmail/connect` and open
   its returned `authorizationUrl`. Google returns to the callback; inspect
   connection state through `GET /v1/gmail/connection`.
6. Start a synchronization with `POST /v1/sync`. Configure
   `GMAIL_SEARCH_QUERY` and `GMAIL_MAX_MESSAGES_PER_SYNC` to tune the initial
   historical scan. Later syncs use Gmail history IDs and reconcile with the
   search query if a stored Gmail history cursor expires.

Only the `gmail.readonly` scope is requested. Google tokens remain on the
backend, refresh tokens are AES-256-GCM encrypted at rest, and email contents
are parsed in memory and are not stored. Message IDs are uniquely recorded per
user; each message and its extracted transactions are persisted atomically, so
repeat syncs do not create duplicates. In production, inject the encryption
key from an access-controlled secret manager, enforce HTTPS, register the
public HTTPS callback, rotate versioned encryption keys safely, and finish
Google OAuth restricted-scope verification before connecting user accounts.

## Data and privacy foundations

The initial PostgreSQL migrations create user, category, OAuth connection,
processed-email, transaction, sync, app-session, and OAuth-flow tables. They
retain extracted transaction fields and message IDs, not email bodies. Before
production Gmail integration is released, configure Google OAuth consent and
verification for the restricted `gmail.readonly` scope, token encryption with
managed keys, HTTPS callback/Universal Link domains, and privacy disclosures.
